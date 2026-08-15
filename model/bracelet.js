/**
 * bracelet.js — PURE deterministic core for the Lost Ark T4 bracelet model.
 *
 * No DOM, no I/O, no dependencies. Works as a browser <script> (attaches
 * window.Bracelet) and as a Node require() (CommonJS module.exports).
 *
 * ======================= WHAT THIS FILE CONTAINS =======================
 *
 *  1. SCORING      a line -> % damage gain for a character profile, in log
 *                  space (D = 100·ln(multiplier)), so line scores add up.
 *  2. POOL         the renormalised granted-roll distribution for a bracelet
 *                  that already carries a given set of lines.
 *  3. SOLVER       exact expectimax/DP over the reroll decision. No Monte
 *                  Carlo: every roll outcome is enumerated.
 *  4. DECODER      lostark.bible character-payload bracelet stats -> lines.
 *
 * ============================ SCORING MODEL ============================
 *
 * Damage in Lost Ark is multiplicative, so each line is scored
 *     D = 100 · ln(multiplier)          (≈ % damage gain, additive in log space)
 * and the exact combined figure is damagePercent(D) = (e^(D/100) − 1)·100. This
 * is the same convention as the accessory and astrogem calculators.
 *
 * A bracelet's score is NOT simply the sum of its lines. Four buckets are shared
 * by the whole item — crit (capped at 100%), the additional-damage pool, flat
 * weapon power and flat main stat — so the lines that feed one of them pool first
 * and the bucket is applied once. See "Contribution records"; setDamage() and the
 * solver both work that way, and lineDamage() still prices ONE line from the bare
 * profile, which is what the pickers and the family letters want.
 *
 * Character inputs (see DEFAULT_PROFILE) drive every number; no tier's damage
 * value is hardcoded.
 *
 *   Attack power   AP = sqrt(mainStatTotal × weaponPowerTotal / 6) · (1+baseApPct)
 *                  + flatAP, damage linear in AP. Bracelet flat stats are added
 *                  to the RAW stat and then amplified by the percentage buckets
 *                  (msPct / wpPct), so the gain is a full AP ratio; with
 *                  flatAP = 0 it collapses to the plain sqrt ratio.
 *                  deriveBaseline() turns a gear setup into those raw numbers.
 *                  flatWP — flat WEAPON power, from a weapon ark-grid core or an
 *                  accessory's "Weapon Power +480" roll — is weapon power, not
 *                  attack power: it joins weaponPowerRaw INSIDE the square root
 *                  and takes the wpPct bucket with it. Sitting beside flatAP
 *                  instead would be wrong by construction, and the 59 saved
 *                  character pages agree: of the 69 loadouts carrying a flat
 *                  weapon-power roll, (raw + flat)·(1+wpPct) reproduces the
 *                  page's own weapon-power total on 34 and never misses by more
 *                  than the sources we cannot read, while raw·(1+wpPct) + flat
 *                  reproduces it on exactly none.
 *   Crit           a list of skills, each { share, critRate, critDamage }.
 *                  critDamage 2.8 means a crit deals 2.8× (not 3.8×). Per-skill
 *                  expected factor = 1 + cr·(cd−1); the character factor is the
 *                  share-weighted sum. Crit rate is capped at 1.0 when a line
 *                  pushes it over. The "+1.5% on crit" rider on families 11/12
 *                  is crit-HIT damage: 1 + cr·(cd·(1+chd) − 1).
 *   Additional dmg one additive pool (weapon quality + pet + astrogem + neck,
 *                  optional Master), multiplying total damage as (1 + pool).
 *   Buckets        outgoing damage (undiluted), staggered, demon (diluted by the
 *                  demon damage you already carry), back/front, non-directional
 *                  are separate multiplicative buckets scaled by a share/uptime.
 *   Party lines    families 16/17/18/19 help the whole party. Scored as
 *                  1 + selfGain + allyCount × allyGain, with allies fixed at
 *                  90% crit / 280% crit damage and each assumed to deal the same
 *                  damage as the wearer before the line.
 *   Vitality, combat traits and the defensive/utility families score 0 damage;
 *                  their in-game value is still reported (traitValue / value).
 *
 * Support role: personal-damage components score 0. What pays instead is the
 * ally attack-power and ally damage riders, through the house support model
 * (ap / brand / identity — see supportContribution and
 * docs/research/support-model.md), plus the party DEBUFF halves of families
 * 16-19, which go through the same crit and defence functions the DPS side uses
 * because they land on every dealer whoever carries them.
 *
 * A support is scored on ONE damage dealer. Party size belongs on the gold axis.
 *
 * ============================ THE SOLVER ==============================
 *
 * Mechanics being modelled (docs/research/mechanics-bible-leaderboard.md):
 *   - Each attempt rerolls ALL unlocked granted slots as one set; locked lines
 *     persist. Afterwards you keep the old set or take the new one — whole set,
 *     no cherry-picking. So the outcome node is max(V(old), V(new)).
 *   - Draws inside one attempt are sequential without replacement: no duplicate
 *     family, capped categories dropped, everything renormalised by the
 *     surviving mass.
 *   - N normal rolls + M reconversion-ticket rolls (4 + 3 by default).
 *
 * Rerolls are treated as free: the cost is the bracelet, not the attempt. So
 * rolling weakly dominates stopping, V(s,n) is the EXPECTED FINAL SCORE under
 * optimal play, and the only real decisions are which lines to lock and, after
 * a roll, whether to keep or replace. Keep-or-replace compares CONTINUATION
 * values V(·, n−1), never immediate scores: a weaker set can be worth more when
 * the families it holds have been cleared out of the pool.
 *
 *     V(s, 0) = score(s)
 *     V(s, n) = max over lock masks m of  E_T[ max( V(s, n−1), V(T, n−1) ) ]
 *
 * A state's gold value is (V(s, n) − baseline) × goldPer1Pct; for an empty
 * granted set that is what an unrolled bracelet is worth to a buyer.
 *
 * Exactness and how it stays tractable:
 *   - Every family that scores 0 for the profile collapses into one "junk"
 *     label per category IN THE STATE, but stays a separate family DURING a
 *     draw, so the no-duplicate rule is still applied family by family.
 *   - Locking is offered only on scoring lines (locking a 0-damage line freezes
 *     a slot for nothing; see options.allowLockJunk to lift it). That is what
 *     lets junk collapse: the exclusion set only ever contains fixed and locked
 *     lines, which are always identified individually.
 *   - V(S,r) = max( stop, max over lock masks L of  −cost + F(L, r−1)(V(S,r−1)) )
 *     where F(L,r)(v) = Σ_T P(T|L)·max(v, V(T,r)). F depends on the state only
 *     through the locked lines, so it is built once per lock mask per layer as a
 *     sorted array with prefix sums and queried in O(log n). Without that, a
 *     three-slot solve would be a 40k × 40k transition matrix.
 *
 * ===================================================================
 */
(function (root) {
  "use strict";

  var isNode = (typeof module !== "undefined" && module.exports);
  var DATA = isNode ? require("../data/bracelet-data.js") : root.BraceletData;
  var GEAR = isNode ? require("../data/gear-data.js") : root.BraceletGearData;

  // MODEL_SIG names the model; VERSION names the build of it. The Worker stores
  // MODEL_SIG + "@" + VERSION on every record and re-scores any record whose stamp
  // no longer matches, so BUMP VERSION whenever a change here can move a stored
  // number — otherwise every record already in KV keeps its old score forever.
  // 0.2.0: inferGrade() now reads the line count and the trait/basic bands, and no
  // longer defaults to relic when the payload carries no special-value evidence.
  // That moved two of the fifty-nine seeded characters by about 1.2pp.
  // 0.3.0: three changes, all of which move a stored score.
  //   - Spec and Swiftness are priced at 0.024245 a point, crit's own worth at
  //     110 on the default profile, so the three combat traits agree on shipped
  //     settings. They were a flat 0.025.
  //   - flatAP is 3,600, not 2,700: an ark-grid core's point thresholds ADD, so
  //     the Ancient attack core pays 900 at 10 points and another 2,700 at 17.
  //   - The support role is real. It was a stub with two flat per-percent
  //     constants; it is now the house ap / brand / identity model.
  // Every one of the fifty-nine seeded characters moved, by up to 0.22pp.
  // 0.4.0: four changes. The big one is that a SET is now scored jointly.
  //   - Crit, additional damage, weapon power and main stat POOL across the whole
  //     bracelet instead of each line being priced from the bare profile. Crit is
  //     capped at 100% once, over the pooled total, so a bracelet can no longer be
  //     paid for crit it cannot use: family 11 high + family 31 high + Crit 120 +
  //     Spec 120 scored 14.032 and is worth 11.043. Pooling the weapon-power
  //     components also retires the double square root inside families 21 and 22,
  //     which were 0.76% and 1.19% over at the top tier.
  //   - support.baseAdd and support.dpsWP are our own default dealer's numbers
  //     (0.3844 and 261,883.195), not the accessory calculator's inherited pair.
  //   - The DP prices a combat-trait DRAW instead of calling it junk, and counts
  //     the traits named in traitValues against the trait cap, so a bracelet with
  //     both places filled can no longer draw a dead third one.
  //   - The Python mirror's line_damage() normalises a partial profile, as the JS
  //     has always done; it used to raise KeyError: 'role'.
  // 0.4.1: the BOARD adopted the joint pool. worker score() and subrank's
  // braceletScore/anchors now price the whole bracelet through jointScore
  // instead of traitDamage + setDamage summed, which paid crit twice across the
  // two halves. 42 of 59 seeded characters move, most under 0.1pp; the two
  // crit-saturated ones land where the 0.4.0 audit predicted (Kyulo -8.4%,
  // Heero -5.7% against their pre-pooling scores).
  // 0.4.2: crit is UNCAPPED (Shizu). Overflow crit rate past 100% pays its
  // substitution value — a real player rebalances crit out of the rest of the
  // build, so the marginal pp keeps the (cd−1) slope it has below the cap. The
  // pool from 0.4.x stays: cross-terms still price jointly, so a crit-heavy set
  // sits below the old per-line double count and above the hard-cap floor.
  // Kyulo and Heero regain most of what 0.4.1 took (13.35 -> 14.41, 14.21 -> 15.08).
  var VERSION = "0.4.2";
  var MODEL_SIG = "bracelet-v1";

  // ------------------------------------------------------------------
  // Profile
  // ------------------------------------------------------------------

  // Additional-damage from a 60-level astrogem grid: 60 × 0.080667%/level, the
  // loseii astrogem coefficient (bebkok 0.08086, Arsonistic 0.08077 — same thing).
  var ADD_DMG_ASTROGEM_LV60 = 0.0484;
  // T4 combat-trait conversion for Crit: 25 percentage points of crit rate per
  // 699 trait points (Shizu, 2026-08-11), so 100 points is 3.577pp. Matches
  // Arsonistic's sheet. Earlier drafts used 35/699 in error.
  var TRAIT_CRIT_PP_PER_POINT = 25 / 699;
  // The three combat traits that pay. Fixed order, so JS and Python sum the same
  // floats in the same sequence.
  //
  // DOMINATION, ENDURANCE AND EXPERTISE ARE WORTH ZERO (Shizu, 2026-08-14) — a
  // ruling, not an omission. All six roll on the same 35% category and the same
  // weighted band, so the other three appear on the Tier List at 0 rather than
  // being hidden; that is what tells a reader the line they rolled is dead. Do
  // not add them here.
  var TRAIT_KEYS = ["crit", "spec", "swift"];
  // Master node. Arsonistic's sheet reads it as +7% crit rate AND +8.5%
  // additional damage; Shizu's ruling (2026-08-11) is +7% additional damage
  // only, and that is what ships. Do not "fix" without asking him.
  var MASTER_ADD_DAMAGE = 0.07;

  // Rounding convention: the model never floors or rounds. Stats, totals and
  // attack power stay real-valued end to end so JS and Python agree bit for
  // bit; only the UI rounds for display.

  var DEFAULT_PROFILE = {
    role: "dps",                    // "dps" | "support"

    // ---- attack power baseline (see deriveBaseline) ----
    // Raw = before the percentage buckets; the bracelet's flat lines are added
    // to the RAW value and then amplified by the same bucket.
    ilvl: 1785,
    mainStatRaw: 703826,            // 5 armor pieces + accessories + base + roster
    weaponPowerRaw: 241367,         // weapon table value
    msPct: 0.09,                    // 8% skins + 1% stronghold ranch
    wpPct: 0.085,                   // 6% earring WP lines + 2.5% karma
    baseApPct: 0.125,               // 11 × lv9 damage gems (1.0% ea) + 9/7 stone (1.5%)
    // Ark-grid ATTACK core, Ancient, at 17+ points. The core's thresholds ADD:
    // 900 at 10 points plus 2,700 at 17. A Relic one totals 2,700 and a weapon
    // core pays flatWP instead — see data/gear-data.js.
    flatAP: 3600,
    // Flat WEAPON power: an ark-grid WEAPON core instead of an attack one, plus
    // any "Weapon Power +195/480/960" accessory roll. Default 0 — the reference
    // build runs attack cores and no flat rolls — so it changes no score until
    // someone sets it.
    flatWP: 0,

    // Damage share and crit numbers per skill. critDamage 2.8 = a crit deals 2.8×.
    skills: [{ share: 1, critRate: 0.90, critDamage: 2.8 }],

    // Master node: +7% additional damage (Shizu's ruling).
    master: false,

    // How much the class values the Spec and Swiftness combat traits, in SCORE
    // POINTS per 100 trait points: 0.025 = a 100-point line is worth 2.5 points
    // of damage. Key "swift" is the Swiftness trait (DATA calls it "swiftness").
    //
    // The DEFAULT is crit's own worth, so on the shipped settings all three
    // combat traits are priced alike (Shizu, 2026-08-14). Crit converts exactly —
    // 100 points is 25/6.99 = 3.577pp of crit rate through the profile's own crit
    // numbers — and on this profile a 110-point crit line is 2.6670 points of
    // damage, i.e. 0.024245 a point. That number is what ships.
    //
    // It is a CONSTANT, not a formula. Crit is faintly non-linear (0.024389 a
    // point at 61, 0.024216 at 120), so no single weight tracks it everywhere;
    // this one is anchored at 110, the grade's own yardstick in subrank.js. The
    // slider stays, because a class that genuinely values Spec above a crit point
    // has to be able to say so.
    traitWeights: { spec: 0.024245, swift: 0.024245 },

    // Additional-damage pool: additive inside itself, multiplies as (1 + pool).
    addDamage: {
      weaponQuality: 0.30,          // 100-quality weapon
      pet: 0.01,
      astrogemLv60: ADD_DMG_ASTROGEM_LV60,
      neck: 0.026                   // high additional-damage necklace
    },

    // Bucket shares / uptimes (fraction of your damage the bucket touches).
    // Positional base facts, for setting the shares: front attack is ×1.20 and
    // back attack ×1.05 (+10% crit rate) before any bracelet line.
    // Shizu, 2026-08-11: these read as "does this bucket apply to me", not as a
    // partition of your damage, and all three ship at 100%. The panel and the
    // model agree, which matters because the leaderboard scores everyone on
    // these canonical defaults and the family letter grades are read off them.
    backAttackShare: 1.00,
    frontAttackShare: 1.00,
    nonDirectionalShare: 1.00,
    staggeredShare: 0.10,           // share of damage landing in stagger windows
    // A boolean gate, not a share: the Demon boss toggle drives exactly 0 or 1.
    // Flip this one value to ship the tool with it on.
    demonShare: 0.00,
    demonBase: 0.073,               // existing demon-damage sources dilute the line
    shieldUptime: 0.60,             // family 18

    // Party model for the shred lines (16/17/19) and family 18.
    allyDpsCount: 2,
    // Does the party's support already bring these debuffs? Default false — score
    // the lines — with a toggle, because a support who runs them makes every one
    // of these four lines worthless (they apply once per party).
    supportHasEffects: false,
    allyCritRate: 0.90,
    allyCritDamage: 2.8,
    enemyBaseDR: 0.50,              // enemy damage reduction before any shred

    // Conditional weapon-power families — HARD ASSUMPTIONS as of 2026-08-11:
    // max stacks and full uptime. They are no longer inputs; the panel does not
    // expose them and the Method tab states them.
    wpStacks20: 6,                  // one stack per hit per second, 10s each, cap 6 — held
    wpUptime21: 1.00,               // HP≥50% and hitting, refreshed every 5s — full uptime
    wpStacks22: 30,                 // max stacks, per the same full-uptime ruling as 20/21

    // Family 15 trades +2% cooldown for damage: a weighted mean of the burst
    // case (no penalty) and the sustained case (damage ÷ 1.02). 0.7 = mostly
    // burst, which is how the line actually gets used.
    cooldownPenaltyWeight: 0.7,
    // Attack/move speed pays off through more casts. Shizu's rule (2026-08-11):
    // 10% attack speed = 1% damage, i.e. 0.1% damage per 1% speed. The UI slider
    // is expressed per TEN percent (default 1, max 3) because that is how it was
    // specified; this constant stays per one percent.
    atkMoveSpeedDamagePerPct: 0.1,

    // ---- SUPPORT ROLE ----------------------------------------------------
    // A support is scored by what its buffs add to ONE damage dealer, above a
    // support wearing nothing. Three channels, each scaled by its own uptime:
    //
    //   ap        the ally attack-power buff. The support hands over
    //             0.22 × (1 + allyAtkEnh) of its own base attack power, so this
    //             is the only channel its own gear reaches.
    //   brand     10% damage, scaled by brand power.
    //   identity  Serenade, Major Chord and the T-skill all raise the dealer's
    //             ADDITIONAL damage, so they share one bracket and are then
    //             diluted by the dealer's own base additional.
    //
    //   Q = 100 · ln(ap · brand · identity)
    //
    // This is the house model, taken from the accessory calculator by way of
    // loa-gpd/model/support.js — see docs/research/support-model.md. It replaces
    // the flat per-percent constants this profile used to carry, which the
    // loa-gpd write-up showed were roughly double the truth.
    //
    // The party DEBUFF halves of families 16-19 are NOT in here. They land on
    // every dealer whoever carries them, so they go through the same crit and
    // defence functions the DPS side uses and multiply into the same product.
    // The dealer being buffed is OUR OWN default dealer, not the accessory
    // calculator's. The four figures below were inherited whole from
    // loa-gpd/model/support.js, and two of them described a slightly different
    // character than the one this file's own defaults describe — so a support and
    // a damage dealer scored against two different reference builds. Both are now
    // read off the profile above (Shizu, 2026-08-14). dpsMS keeps loa-gpd's
    // rounded integer, which is our own 703,826 × 1.09 = 767,170.34 to the point,
    // and dpsFlatAtk 3600 already matched.
    support: {
      // The damage dealer being buffed.
      dpsWP: 261883.195,      // OUR weaponPowerRaw 241,367 × (1 + wpPct 8.5%)
      dpsMS: 767170,          // OUR mainStatRaw 703,826 × (1 + msPct 9%)
      dpsAtkPct: 0.2948,      // accessories, attack core, node 60, gems, stone, Adrenaline
      dpsFlatAtk: 3600,       // OUR flatAP: the ancient attack core
      baseAdd: 0.3844,        // OUR addDamage pool, the divisor that dilutes identity

      // The support's own buff bases, in percent, at level-9 gems.
      brandPower: 45.00,
      allyAtkEnh: 68.55,
      allyDmg: 38.26,         // identity bracket: ark grid + gems
      allyDmgT: 9.26,         // the T-skill's own bracket
      spec: 1016,             // spec BEFORE the bracelet's own combat-trait line
      classCoeff: 0.0005005722461,   // Bard: spec -> identity-buff efficiency

      // Uptimes, in percent.
      upBrand: 100,
      upAp: 95,
      upSeren: 70,
      upChord: 70,
      upTskill: 40,

      // Share of its own base attack power a support hands to each ally.
      apBuffShare: 0.22
    },
    partyShieldHealValuePerPct: 0.10
  };

  function deepCopy(o) {
    if (o === null || typeof o !== "object") return o;
    if (Object.prototype.toString.call(o) === "[object Array]") {
      var a = [];
      for (var i = 0; i < o.length; i++) a.push(deepCopy(o[i]));
      return a;
    }
    var r = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = deepCopy(o[k]);
    return r;
  }

  /** Fill in every missing field of a partial profile from DEFAULT_PROFILE. */
  function normalizeProfile(p) {
    var out = deepCopy(DEFAULT_PROFILE);
    if (!p) return out;
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      // NESTED BLOCKS MERGE, they do not replace. A caller that sets one field of
      // one of these means "this field, everything else as it was" — and for
      // `support` the difference is fatal rather than cosmetic: replacing the
      // whole block with {spec: 1200} leaves supportContribution reading
      // undefined for allyDmg and every support score comes out NaN.
      if ((k === "addDamage" || k === "traitWeights" || k === "support") && p[k]) {
        for (var a in p[k]) if (Object.prototype.hasOwnProperty.call(p[k], a)) out[k][a] = p[k][a];
      } else if (p[k] !== undefined && p[k] !== null) {
        out[k] = deepCopy(p[k]);
      }
    }
    if (!out.skills || !out.skills.length) out.skills = deepCopy(DEFAULT_PROFILE.skills);
    return out;
  }

  /**
   * deriveBaseline(o) — gear setup -> the raw weapon power and main stat the
   * scoring layer needs. Everything has a default, so deriveBaseline() alone
   * returns Shizu's reference 1785 build. A profile may also carry
   * mainStatRaw / weaponPowerRaw directly and skip this.
   *
   * o = { pieceLevels:{head,shoulder,chest,pants,gloves,weapon},
   *       msPct, wpPct, baseApPct, flatAP, flatWP, rosterBonus,
   *       accessoryMainStat, baseMainStat }
   */
  function deriveBaseline(o) {
    o = o || {};
    var D = GEAR.DEFAULTS;
    var lv = {}, k;
    for (k in D.pieceLevels) if (Object.prototype.hasOwnProperty.call(D.pieceLevels, k)) lv[k] = D.pieceLevels[k];
    if (o.pieceLevels) for (k in o.pieceLevels) if (Object.prototype.hasOwnProperty.call(o.pieceLevels, k)) lv[k] = o.pieceLevels[k];

    var armor = 0, ilvlSum = 0, i;
    var armorPieces = ["head", "shoulder", "chest", "pants", "gloves"];
    for (i = 0; i < armorPieces.length; i++) {
      var idx = GEAR.PIECES.indexOf(armorPieces[i]);
      armor += GEAR.SERCA[lv[armorPieces[i]]][idx];
      ilvlSum += GEAR.ILVL0 + GEAR.ILVL_STEP * lv[armorPieces[i]];
    }
    var weaponPowerRaw = GEAR.SERCA[lv.weapon][5];
    ilvlSum += GEAR.ILVL0 + GEAR.ILVL_STEP * lv.weapon;

    var accMs = o.accessoryMainStat !== undefined ? o.accessoryMainStat : D.accessoryMainStat;
    var baseMs = o.baseMainStat !== undefined ? o.baseMainStat : D.baseMainStat;
    var roster = o.rosterBonus !== undefined ? o.rosterBonus : D.rosterBonus;
    var msPct = o.msPct !== undefined ? o.msPct : D.msPct;
    var wpPct = o.wpPct !== undefined ? o.wpPct : D.wpPct;

    var mainStatRaw = armor + accMs + baseMs + roster;
    // Flat weapon power is WEAPON POWER: it joins the weapon's own raw figure
    // before the bucket, so weaponPowerTotal carries it. It is kept as its own
    // field rather than folded into weaponPowerRaw, because weaponPowerRaw means
    // "the weapon table value" everywhere else — including the deck's raw
    // override pair, which must stay the weapon alone.
    var flatWP = o.flatWP !== undefined ? o.flatWP : D.flatWP;
    return {
      ilvl: Math.round(ilvlSum / 6),
      armorMainStat: armor,
      mainStatRaw: mainStatRaw,
      weaponPowerRaw: weaponPowerRaw,
      mainStatTotal: mainStatRaw * (1 + msPct),
      weaponPowerTotal: (weaponPowerRaw + flatWP) * (1 + wpPct),
      msPct: msPct, wpPct: wpPct,
      baseApPct: o.baseApPct !== undefined ? o.baseApPct : D.baseApPct,
      flatAP: o.flatAP !== undefined ? o.flatAP : D.flatAP,
      flatWP: flatWP
    };
  }

  /**
   * Attack power. AP = sqrt(MStot · WPtot / 6) · (1 + baseApPct) + flatAP.
   * dMsRaw / dWpRaw are bracelet-line additions to the RAW stat, so they are
   * amplified by the percentage buckets exactly as gear stats are.
   *
   * flatWP sits with dWpRaw and NOT with flatAP. Flat weapon power is weapon
   * power: the game adds it to the weapon's figure and then applies the
   * weapon-power percentage bucket, so it belongs inside the square root. Put
   * beside flatAP it would escape both the root and the bucket and would score
   * a weapon core as though it were an attack core.
   */
  function attackPower(profile, dMsRaw, dWpRaw) {
    var ms = (profile.mainStatRaw + (dMsRaw || 0)) * (1 + profile.msPct);
    var wp = (profile.weaponPowerRaw + (profile.flatWP || 0) + (dWpRaw || 0)) * (1 + profile.wpPct);
    return Math.sqrt(ms * wp / 6) * (1 + profile.baseApPct) + profile.flatAP;
  }

  function addDamagePool(profile) {
    var d = profile.addDamage, s = 0;
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) s += (d[k] || 0);
    if (profile.master) s += MASTER_ADD_DAMAGE;
    return s;
  }

  function critFactorOf(skills, dCritRate, dCritDamage) {
    var tot = 0, wsum = 0;
    for (var i = 0; i < skills.length; i++) {
      var sk = skills[i];
      var cr = (sk.critRate || 0) + (dCritRate || 0);
      // Floored, NOT capped — the substitution ruling (see critFactorFull).
      if (cr < 0) cr = 0;
      var cd = (sk.critDamage || 0) + (dCritDamage || 0);
      // Expected factor = 1 + cr·(cd − 1); a crit deals cd× (2.8 = 2.8×, not 3.8×).
      tot += (sk.share || 0) * (1 + cr * (cd - 1));
      wsum += (sk.share || 0);
    }
    return wsum > 0 ? tot / wsum : 0;
  }

  /** Share-weighted expected crit factor, optionally shifted by a line. */
  function critFactor(profile, dCritRate, dCritDamage) {
    return critFactorOf(profile.skills, dCritRate, dCritDamage);
  }

  // An ally DPS: fixed 90% / 280% regardless of the wearer's own skill setup.
  function allyCritFactor(profile, dCritRate, dCritDamage) {
    return critFactorOf([{ share: 1, critRate: profile.allyCritRate, critDamage: profile.allyCritDamage }],
      dCritRate, dCritDamage);
  }

  // Enemy defense shred -> damage multiplier. Damage taken = K/(D+K), so a base
  // damage reduction of DR fixes D/K = DR/(1−DR) and shredding a fraction A of
  // the defense multiplies damage by (D+K)/(D(1−A)+K).
  function defShredGain(profile, aPct) {
    var dr = profile.enemyBaseDR;
    if (dr <= 0) return 1;
    if (dr >= 1) dr = 0.999999;
    var ratio = dr / (1 - dr);          // D/K
    var a = aPct / 100;
    return (ratio + 1) / (ratio * (1 - a) + 1);
  }

  // A party line's multiplier on YOUR damage: your own gain plus each ally's
  // gain, counted in units of your baseline damage.
  function partyMult(profile, selfGain, allyGain) {
    // "This effect can only be applied once per party." If the party's SUPPORT
    // already carries the same debuff, a second copy on your bracelet does
    // nothing at all — not a smaller effect, nothing. supportHasEffects=true
    // says the support already brings them, so the line is worth zero.
    if (profile.supportHasEffects) return 1;
    // A SUPPORT is scored on ONE dealer, because that is the unit its own buff
    // channels are in: supportGain() measures what a single dealer gains. This
    // used to multiply by allyDpsCount, so families 16-19 had their party-debuff
    // half counted across two dealers while the ally attack-power rider on the
    // SAME LINE was counted across one — the line was priced on two different
    // party sizes at once, and it inflated those four families by about 1.65×
    // against the clean buff lines. Party size belongs on the gold axis, where
    // a support's 1% lands on every dealer; it does not belong here.
    if (profile.role === "support") return 1 + allyGain;
    return 1 + selfGain + profile.allyDpsCount * allyGain;
  }

  // ------------------------------------------------------------------
  // The support channel
  // ------------------------------------------------------------------

  /**
   * A support's own base attack power — the thing its ally attack-power buff is
   * a share of. Note what is NOT here: flat attack power. The house model puts
   * the support's percentage bucket on the square-root term and stops, because
   * the buff reads the base figure rather than the total. Flat WEAPON power IS
   * counted, because it sits inside the square root and so moves the base.
   */
  function supportBaseAtk(profile, dMsRaw, dWpRaw) {
    var ms = (profile.mainStatRaw + (dMsRaw || 0)) * (1 + profile.msPct);
    var wp = (profile.weaponPowerRaw + (profile.flatWP || 0) + (dWpRaw || 0)) * (1 + profile.wpPct);
    return Math.sqrt(ms * wp / 6) * (1 + profile.baseApPct);
  }

  /**
   * What a support's buffs multiply ONE damage dealer's damage by, above a
   * dealer standing alone. `lines` carries the extra buff percentages a bracelet
   * adds, as FRACTIONS: allyAtkEnh, allyDmg, brand. `dMsRaw` / `dWpRaw` are flat
   * main stat / weapon power the bracelet adds to the support itself.
   */
  function supportContribution(profile, lines, dMsRaw, dWpRaw) {
    var P = profile.support;
    lines = lines || {};
    var allyDmg = P.allyDmg / 100 + (lines.allyDmg || 0);
    var allyDmgT = P.allyDmgT / 100 + (lines.allyDmg || 0);
    var atkEnh = P.allyAtkEnh / 100 + (lines.allyAtkEnh || 0);
    var brandPower = P.brandPower / 100 + (lines.brand || 0);
    // The bracelet's own Specialization line lands here, as extra spec.
    var specEff = (P.spec + (lines.spec || 0)) * P.classCoeff;

    var supAtk = supportBaseAtk(profile, dMsRaw, dWpRaw);
    var dpsAtk = Math.sqrt(P.dpsWP * P.dpsMS / 6);
    var mults = 1 + P.dpsAtkPct;
    var apMult =
      ((dpsAtk + supAtk * P.apBuffShare * (1 + atkEnh)) * mults + P.dpsFlatAtk) /
      (dpsAtk * mults + P.dpsFlatAtk);

    var ap = 1 + (P.upAp / 100) * (apMult - 1);
    var brand = 1 + (P.upBrand / 100) * (0.1 * (1 + brandPower));
    var seren = 0.15 * (1 + allyDmg) * (1 + specEff);
    var chord = 0.02 * (1 + allyDmg) * (1 + specEff);
    var tsk = 0.10 * (1 + allyDmgT);
    var identity = 1 +
      ((P.upSeren / 100) * seren + (P.upChord / 100) * chord + (P.upTskill / 100) * tsk) /
      (1 + P.baseAdd);

    return ap * brand * identity;
  }

  /** One support line's multiplier: the contribution with it, over without. */
  function supportGain(profile, lines, dMsRaw, dWpRaw) {
    return supportContribution(profile, lines, dMsRaw, dWpRaw) /
           supportContribution(profile, null, 0, 0);
  }

  // ------------------------------------------------------------------
  // Component -> multiplier
  // ------------------------------------------------------------------

  /**
   * One effect component's damage multiplier. `x` is the component's value in
   * whatever unit the game shows (percentage points, flat weapon power, ...).
   */
  function componentMultiplier(kind, x, profile, comp) {
    var dps = profile.role !== "support";
    var pool;
    switch (kind) {
      case "none": return 1;

      // Flat weapon power / main stat enter the RAW pool, so the percentage
      // buckets amplify them. With flatAP = 0 this is exactly the sqrt ratio.
      case "weaponPower":
        // On a support this is not dead weight: weapon power raises the support's
        // own base attack, and the ally attack-power buff is a share of that. It
        // is a small channel — a legendary Ancient weapon-power line scores 0.518
        // against a blue ally-damage line's 0.795 — but it is not zero.
        if (!dps) return supportGain(profile, null, 0, x);
        return attackPower(profile, 0, x) / attackPower(profile, 0, 0);

      case "mainStat":
        if (!dps) return supportGain(profile, null, x, 0);
        return attackPower(profile, x, 0) / attackPower(profile, 0, 0);

      case "critRate":
        if (!dps) return 1;
        return critFactor(profile, x / 100, 0) / critFactor(profile, 0, 0);

      case "critDamage":
        if (!dps) return 1;
        return critFactor(profile, 0, x / 100) / critFactor(profile, 0, 0);

      case "onCritDamage": {
        // "On crit, damage +x%" is CRIT-HIT damage, not additional damage: the
        // crit branch becomes 1 + cr·(cd·(1+chd) − 1).
        if (!dps) return 1;
        var skills = profile.skills, tot = 0, wsum = 0;
        for (var i = 0; i < skills.length; i++) {
          var sk = skills[i], cr = Math.max(0, (sk.critRate || 0)), cd = sk.critDamage;   // uncapped — see critFactorFull
          var b = 1 + cr * (cd - 1);
          var n = 1 + cr * (cd * (1 + x / 100) - 1);
          tot += (sk.share || 0) * (n / b);
          wsum += (sk.share || 0);
        }
        return wsum > 0 ? tot / wsum : 1;
      }

      case "addDamage":
        if (!dps) return 1;
        pool = addDamagePool(profile);
        return (1 + pool + x / 100) / (1 + pool);

      // Outgoing damage is its own bucket and is not diluted.
      case "outgoing":        return dps ? 1 + x / 100 : 1;
      case "staggered":       return dps ? 1 + profile.staggeredShare * x / 100 : 1;
      // Demon damage dilutes against the ~7.3% you already carry from cards/pets.
      case "demon":           return dps ? 1 + profile.demonShare * (x / 100) / (1 + profile.demonBase) : 1;
      case "backAttack":      return dps ? 1 + profile.backAttackShare * x / 100 : 1;
      case "frontAttack":     return dps ? 1 + profile.frontAttackShare * x / 100 : 1;
      case "nonDirectional":  return dps ? 1 + profile.nonDirectionalShare * x / 100 : 1;

      // Family 15: +x% damage at the price of +cdPct% cooldown. Burst play eats
      // no penalty, sustained play divides by the cooldown factor; the score is
      // the weighted mean of the two.
      case "outgoingCdPenalty": {
        if (!dps) return 1;
        var cdPct = (comp && comp.cdPct) || 0;
        var burst = 1 + x / 100;
        var sustained = burst / (1 + cdPct / 100);
        var w = profile.cooldownPenaltyWeight;
        return w * burst + (1 - w) * sustained;
      }

      case "atkMoveSpeed":    return dps ? 1 + x * profile.atkMoveSpeedDamagePerPct / 100 : 1;

      // ---- party lines: self gain + allyDpsCount × ally gain ----
      case "defShred": {
        var g = defShredGain(profile, x) - 1;      // flat, identical for everyone
        return partyMult(profile, g, g);
      }
      case "critResistShred": {
        // Enemy crit resist −x pp reads as +x pp crit rate for the whole party.
        var selfG = dps ? critFactor(profile, x / 100, 0) / critFactor(profile, 0, 0) - 1 : 0;
        var allyG = allyCritFactor(profile, x / 100, 0) / allyCritFactor(profile, 0, 0) - 1;
        return partyMult(profile, selfG, allyG);
      }
      case "critDmgResistShred": {
        var selfG2 = dps ? critFactor(profile, 0, x / 100) / critFactor(profile, 0, 0) - 1 : 0;
        var allyG2 = allyCritFactor(profile, 0, x / 100) / allyCritFactor(profile, 0, 0) - 1;
        return partyMult(profile, selfG2, allyG2);
      }
      case "shieldedDamage": {
        var g3 = profile.shieldUptime * x / 100;   // flat damage while shielded
        return partyMult(profile, g3, g3);
      }

      // ---- support-only riders ----
      // "Ally Atk. Power Enhancement +B%" scales the buff a support hands out and
      // does NOTHING on a damage dealer — which is the whole argument for the
      // support carrying families 16-19 rather than a dealer.
      case "allyApBuff":
        return dps ? 1 : supportGain(profile, { allyAtkEnh: x / 100 }, 0, 0);
      case "allyDamageBuff":
        return dps ? 1 : supportGain(profile, { allyDmg: x / 100 }, 0, 0);
      case "partyShieldHeal":
        return dps ? 1 : 1 + x * profile.partyShieldHealValuePerPct / 100;
    }
    return 1;
  }

  function toD(mult) { return 100 * Math.log(mult); }

  /** damagePercent(D) — the exact combined multiplier as a percentage. */
  function damagePercent(D) { return (Math.exp(D / 100) - 1) * 100; }

  // ------------------------------------------------------------------
  // Line scoring
  // ------------------------------------------------------------------

  function bandMid(range) { return (range[0] + range[1]) / 2; }

  function basicBandExpected(famKey, grade) {
    var bands = DATA.BASIC.bands, s = 0, w = 0;
    for (var i = 0; i < bands.length; i++) {
      s += bands[i].prob * bandMid(bands[i][grade][famKey]);
      w += bands[i].prob;
    }
    return s / w;
  }

  function traitBandExpected(grade) {
    var bands = DATA.TRAITS.bands, s = 0, w = 0;
    for (var i = 0; i < bands.length; i++) { s += bands[i].prob * bandMid(bands[i][grade]); w += bands[i].prob; }
    return s / w;
  }

  // Crit factor with all three crit shifts applied at once:
  // per skill  1 + cr'·(cd'·(1+chd) − 1),  cr' floored at 0 and NOT capped at 1.
  //
  // UNCAPPED ON PURPOSE (Shizu, 2026-08-14). Pooled crit past 100% is not
  // wasted in practice: a player whose bracelet pushes them over the cap
  // rebalances — less crit on the accessories or the traits, more of something
  // else — so overflow crit rate is worth its substitution value, which at the
  // margin is the same (cd−1) slope it carries below the cap. The linear form
  // IS that substitution credit: factor(cr) is linear in cr, so extending it
  // past 1 pays overflow at exactly the at-cap marginal rate.
  //
  // The one distortion this accepts: a crit-DAMAGE delta on an over-cap build
  // scales by the pooled cr (say 1.05) where the rebalanced reality is 1.00 —
  // a second-order overcount of a few percent ON THE DELTA, not the line.
  // Clamping interactions while crediting overflow separately would fix it at
  // the cost of a piecewise formula nobody can read; not worth it.
  function critFactorFull(profile, dcr, dcd, chd) {
    var skills = profile.skills, tot = 0, wsum = 0;
    for (var i = 0; i < skills.length; i++) {
      var sk = skills[i];
      var cr = Math.max(0, (sk.critRate || 0) + dcr);
      var cd = (sk.critDamage || 0) + dcd;
      tot += (sk.share || 0) * (1 + cr * (cd * (1 + chd) - 1));
      wsum += (sk.share || 0);
    }
    return wsum > 0 ? tot / wsum : 0;
  }

  // ------------------------------------------------------------------
  // Contribution records — what a line brings to the whole bracelet
  // ------------------------------------------------------------------

  /**
   * A CONTRIBUTION RECORD is what one scoring atom — a line, a tier, the two
   * combat traits — adds to a bracelet, kept in the units the game adds them in
   * rather than already converted to damage:
   *
   *   dcr  crit rate, as a fraction (0.05 = +5 percentage points)
   *   dcd  crit damage, as a fraction (0.10 = +10pp, i.e. 2.8× -> 2.9×)
   *   chd  the "on crit, damage +x%" rider, as a fraction
   *   dAdd additional damage, in PERCENTAGE POINTS (the unit the tables print)
   *   dWp  flat weapon power, added to the raw pool
   *   dMs  flat main stat, added to the raw pool
   *   mult everything orthogonal, already a multiplier: outgoing, staggered,
   *        demon, positional, the party lines, attack/move speed, the support
   *        riders. Those genuinely do multiply line by line, so they are simply
   *        collected here.
   *
   * WHY THIS EXISTS. Damage is multiplicative BETWEEN buckets and additive
   * INSIDE one, and four of these buckets are shared by the whole bracelet:
   *
   *   - crit rate is capped at 100% per skill. Score three crit lines separately
   *     from the same base and you sell crit the character cannot use — a
   *     bracelet holding family 11 high, family 31 high, Crit 120 and Spec 120
   *     scored 14.032 when the joint truth is 11.043, 27% over.
   *   - additional damage is one additive pool; two lines feeding it dilute each
   *     other, and priced apart they do not.
   *   - flat weapon power and flat main stat both move ONE attack-power figure
   *     through a square root, so two of them are not two independent ratios.
   *     Families 21 and 22 carry two weapon-power components each and were
   *     multiplying two separate square-root ratios: 0.76% and 1.19% over at the
   *     top tier, fixed here for free by the pooling.
   *
   * So a SET is scored by summing the records, applying each shared bucket ONCE,
   * and multiplying the residual. A single line from the bare profile is that
   * same arithmetic over one record, which is why lineDamage() still means
   * exactly what it always meant.
   *
   * A flat log-space term (the Spec / Swiftness trait weights, a hand-written
   * test-pool atom) rides in `mult` as exp(D/100). The round trip costs about
   * 1e-16 and both mirrors take it in the same order, so they still agree.
   */
  function emptyContribution() {
    return { dcr: 0, dcd: 0, chd: 0, dAdd: 0, dWp: 0, dMs: 0, mult: 1 };
  }

  function copyContribution(r) {
    return { dcr: r.dcr, dcd: r.dcd, chd: r.chd, dAdd: r.dAdd, dWp: r.dWp, dMs: r.dMs, mult: r.mult };
  }

  /** a += b, in place. Returns a. */
  function addContribution(a, b) {
    a.dcr += b.dcr; a.dcd += b.dcd; a.chd += b.chd;
    a.dAdd += b.dAdd; a.dWp += b.dWp; a.dMs += b.dMs;
    a.mult *= b.mult;
    return a;
  }

  /**
   * A pooled record -> the damage multiplier of everything in it.
   *
   * Order matters only to the last bit, and it is chosen so that a record
   * carrying ONE pooled component reproduces the old per-line arithmetic exactly:
   * the residual first, in the order the family lists its components, then the
   * three shared buckets.
   */
  function contributionMultiplier(rec, profile) {
    var dps = profile.role !== "support";
    var m = rec.mult;
    if (dps && (rec.dcr !== 0 || rec.dcd !== 0 || rec.chd !== 0)) {
      m *= critFactorFull(profile, rec.dcr, rec.dcd, rec.chd) / critFactorFull(profile, 0, 0, 0);
    }
    if (dps && rec.dAdd !== 0) {
      var pool = addDamagePool(profile);
      m *= (1 + pool + rec.dAdd / 100) / (1 + pool);
    }
    if (rec.dWp !== 0 || rec.dMs !== 0) {
      // On a support these two are not dead weight: they raise the base attack
      // power its ally buff is a share of. Same pooling, different channel.
      m *= dps ? attackPower(profile, rec.dMs, rec.dWp) / attackPower(profile, 0, 0)
        : supportGain(profile, null, rec.dMs, rec.dWp);
    }
    return m;
  }

  function contributionDamage(rec, profile) { return toD(contributionMultiplier(rec, profile)); }

  /** The record one special family contributes at one tier. */
  function specialContribution(family, tier, grade, profile) {
    var vals = family.values[grade][tier], r = emptyContribution();
    var dps = profile.role !== "support";
    for (var i = 0; i < family.comp.length; i++) {
      var c = family.comp[i];
      var x = (c.v !== undefined) ? c.v : vals[c.from];
      if (c.scaleKey) x = x * profile[c.scaleKey];
      if (dps && (c.k === "critRate" || c.k === "critDamage" || c.k === "onCritDamage")) {
        if (c.k === "critRate") r.dcr += x / 100;
        else if (c.k === "critDamage") r.dcd += x / 100;
        else r.chd += x / 100;
      } else if (dps && c.k === "addDamage") {
        r.dAdd += x;
      } else if (c.k === "weaponPower") {
        r.dWp += x;
      } else if (c.k === "mainStat") {
        r.dMs += x;
      } else {
        r.mult *= componentMultiplier(c.k, x, profile, c);
      }
    }
    return r;
  }

  /**
   * lineContribution(line, grade, profile) — one line's record.
   *
   * A combat-trait line contributes NOTHING here, exactly as lineDamage() scores
   * it zero: its points ride in traitDamage / traitContribution instead. That
   * split is what keeps `linesPct` meaning "the effect lines alone". See the rule
   * in traitDamage()'s header.
   */
  function lineContribution(line, grade, profile) {
    var r = emptyContribution();
    if (line.cat === "trait") return r;
    if (line.cat === "basic") {
      if (line.family !== "mainStat") return r;                 // vitality is dead weight
      r.dMs = (line.value !== undefined && line.value !== null) ? line.value : basicBandExpected("mainStat", grade);
      return r;
    }
    var fam = resolveSpecial(line.family);
    if (!fam) return r;
    // A tier the family's table for THIS grade does not carry — see lineDamage().
    if (!fam.values[grade] || !fam.values[grade][line.tier]) return r;
    return specialContribution(fam, line.tier, grade, profile);
  }

  /**
   * Multiplier of one special family at one tier.
   *
   * The crit components of a line (crit rate, crit damage, the "+1.5% on crit"
   * rider) are resolved together in one crit factor, because they genuinely
   * interact inside a single hit — and since 0.4.0 so are the crit, additional
   * damage and weapon-power components of everything else on the bracelet, which
   * is what specialContribution is for.
   */
  function specialMultiplier(family, tier, grade, profile) {
    return contributionMultiplier(specialContribution(family, tier, grade, profile), profile);
  }

  /**
   * lineDamage(line, grade, profile) -> D (% damage, log space).
   *
   * line = { cat: "basic"|"trait"|"special", family, tier?, value? }
   *   basic   family "mainStat"|"vitality"; value = the rolled number, or omit
   *           for the band-weighted expected value.
   *   trait   family "crit"|"spec"|…; always 0 damage.
   *   special family = id 1-33 or its key; tier = "low"|"mid"|"high".
   */
  function lineDamage(line, grade, profile) {
    profile = profile.role ? profile : normalizeProfile(profile);
    // ONE line from the bare profile — correct by definition, and unchanged in
    // meaning by the 0.4.0 pooling: a single record over the shared buckets is
    // the same arithmetic it always was. A tier the family's table for this grade
    // does not carry scores zero rather than throwing (reachable from a decode
    // that landed on the wrong grade); the caller's `unmatchedValue` flag does the
    // complaining, because an exception here takes a whole import down over one
    // line.
    return toD(contributionMultiplier(lineContribution(line, grade, profile), profile));
  }

  function resolveSpecial(f) {
    if (f === null || f === undefined) return null;
    if (typeof f === "object") return f;
    return DATA.SPECIAL_BY_ID[f] || DATA.SPECIAL_BY_KEY[f] || null;
  }

  /** Per-line detail: damage plus the in-game value of non-damage lines. */
  function lineInfo(line, grade, profile) {
    profile = normalizeProfile(profile);
    var out = { cat: line.cat, family: line.family, tier: line.tier || null, damage: 0, value: null, label: "" };
    if (line.cat === "trait") {
      out.value = (line.value !== undefined && line.value !== null) ? line.value : traitBandExpected(grade);
      out.label = "Combat trait";
      out.traitValue = out.value;
      return out;
    }
    if (line.cat === "basic") {
      out.value = (line.value !== undefined && line.value !== null) ? line.value : basicBandExpected(line.family, grade);
      out.label = line.family === "mainStat" ? "Str / Dex / Int" : "Vitality";
      out.damage = lineDamage(line, grade, profile);
      return out;
    }
    var fam = resolveSpecial(line.family);
    if (fam) {
      out.family = fam.id;
      out.label = fam.label;
      out.value = fam.values[grade][line.tier];
      out.damage = lineDamage(line, grade, profile);
    }
    return out;
  }

  // The decoder names the trait with the official family key ("swiftness"); the
  // profile deck writes the short one ("swift"). They must mean the same thing or
  // a Swiftness bracelet silently scores zero for that line — which is exactly
  // what happened until 2026-08-11. Accept either spelling on both sides.
  function traitAlias(o, key) {
    if (o[key] !== undefined && o[key] !== null) return o[key];
    if (key === "swift" && o.swiftness !== undefined) return o.swiftness;
    if (key === "swiftness" && o.swift !== undefined) return o.swift;
    return 0;
  }

  /**
   * traitDamage(traits, profile) -> D, the score of EVERY combat-trait line the
   * bracelet carries.
   *
   * traits = { crit, spec, swift } in trait points; an inactive trait is 0.
   *
   * THE RULE, and the one every scorer has to follow (2026-08-11):
   *
   *   Combat-trait lines score HERE. Effect lines score in setDamage(). A trait
   *   that rolled into a GRANTED slot is still a combat-trait line — Crit +104 is
   *   104 points of crit on the character whether the drop handed it over or a
   *   reroll did — so it belongs in this call, not in setDamage's.
   *
   * That split is not a detail. It is what keeps `linesPct` meaning "the effect
   * lines alone", the figure the board compares to lostark.bible's "Bracelet
   * Effects +X%" (which scores traits at zero) and the figure the loadout pick
   * ranks on. Push a granted trait through setDamage instead and the total comes
   * out right while linesPct silently gains two and a half points, moving
   * benchmark bands and, on at least one seeded character, the loadout the board
   * shows.
   *
   * The four scorers built on this model (worker/bracelet.js, leaderboard.js,
   * bible-import.js and the seed pipeline) all split the decoded lines themselves.
   * Three of them keyed the split on `line.fixed`, which is bible's LOCK icon and
   * not the drop's fixed/granted split — a player can lock a granted line — so a
   * granted trait fell through to setDamage and scored nothing. Read `cat`, never
   * `fixed`: `cat === "trait"` goes here, everything else goes to setDamage.
   *
   * WHAT THE DP DOES WITH IT. A granted trait keeps `fixed: false`, still counts
   * against the granted-slot total and is still rerollable — nothing here makes it
   * permanent. solve() carries this whole term as part of the base contribution
   * record, so the crit half of it meets the granted lines' crit inside one cap.
   *
   * The DP used to price a trait DRAW at zero as well, so it would roll a trait
   * away and never towards one — a gap in the advisor that cost any bracelet with
   * a trait place still open about 1.17 points of expected final score. Since
   * 0.4.0 buildAtoms() prices the draw at the band-weighted value it would land
   * on, and solve() counts the traits named in traitValues against the trait cap
   * so a bracelet with both places filled cannot draw a third. lineDamage() still
   * answers ZERO for a trait line, which is what the calculator's copy, the family
   * picker and `linesPct` are built on. Written up in docs/research/scoring-gap.md §7.
   *
   *   Crit   converts exactly: 25 pp of crit rate per 699 trait points, fed
   *          through the per-skill crit model additively with every other
   *          crit-rate source and capped at 100% — the same path granted
   *          family 31 takes. So it is worth less to a class already near cap.
   *   Spec   scored by the class's own weight, in points per 100 trait points.
   *   Swift  likewise.
   *
   * The trait term is added once, into solve()'s fixedDamage, and never enters the
   * DP alphabet.
   *
   * SINCE 0.4.0 the crit trait POOLS with everything else on the bracelet when the
   * bracelet is scored as a set — see traitContribution() below, which is what
   * jointScore() and the DP use. This function keeps its old meaning: every trait
   * line priced from the bare profile, one term added to the next. That is what
   * the display, the Tier List and the trait slider want, and it is what the four
   * set scorers still sum against setDamage(). It reads HIGH next to the joint
   * answer whenever the bracelet's other lines already push crit near the cap.
   */
  function traitDamage(traits, profile) {
    profile = profile && profile.role ? profile : normalizeProfile(profile);
    traits = traits || {};
    // The decoder names the trait with the official family key ("swiftness"); the
    // profile deck writes the short one ("swift"). They must mean the same thing or
    // a Swiftness bracelet silently scores zero for that line — which is exactly
    // what happened until 2026-08-11. Accept either spelling on both sides.
    var w = profile.traitWeights || {}, s = 0, i, k, v;
    var alias = traitAlias;
    var support = profile.role === "support";
    for (i = 0; i < TRAIT_KEYS.length; i++) {
      k = TRAIT_KEYS[i];
      v = alias(traits, k) || 0;
      if (!v) continue;
      if (support) {
        // A support's traits are not a matter of taste, so the weights above do
        // not apply. SPECIALIZATION pays through the identity bracket: it raises
        // Serenade and Major Chord by spec × classCoeff, which is where the whole
        // of its party value lives. SWIFTNESS is priced THE SAME (Shizu) — it
        // buys nothing this model can see directly, but in game it shortens the
        // buff cycle, which lifts the uptimes the model takes as fixed inputs.
        //
        // Crit, Domination, Endurance and Expertise are zero: they move the
        // support's own damage, which nobody counts.
        if (k === "spec" || k === "swift") s += toD(supportGain(profile, { spec: v }, 0, 0));
        continue;
      }
      if (k === "crit") {
        // Crit is the one trait that converts exactly rather than by taste.
        var dcr = v * TRAIT_CRIT_PP_PER_POINT / 100;
        s += toD(critFactor(profile, dcr, 0) / critFactor(profile, 0, 0));
      } else {
        s += v * (alias(w, k) || 0);
      }
    }
    return s;
  }

  /**
   * traitContribution(traits, profile) — the same combat traits as a record, so
   * they pool with the rest of the bracelet.
   *
   * Crit lands in dcr, where it meets every other crit-rate source and one cap.
   * Spec and Swiftness are a flat log-space weight, so they ride in `mult` as
   * exp(D/100); a support's pair go through supportGain, which is a multiplier
   * already.
   */
  function traitContribution(traits, profile) {
    traits = traits || {};
    var w = profile.traitWeights || {}, r = emptyContribution(), i, k, v;
    var support = profile.role === "support";
    for (i = 0; i < TRAIT_KEYS.length; i++) {
      k = TRAIT_KEYS[i];
      v = traitAlias(traits, k) || 0;
      if (!v) continue;
      if (support) {
        if (k === "spec" || k === "swift") r.mult *= supportGain(profile, { spec: v }, 0, 0);
        continue;
      }
      if (k === "crit") r.dcr += v * TRAIT_CRIT_PP_PER_POINT / 100;
      else r.mult *= Math.exp(v * (traitAlias(w, k) || 0) / 100);
    }
    return r;
  }

  // ------------------------------------------------------------------
  // Family letter grades
  // ------------------------------------------------------------------

  // Within one family the three tiers land 6 : 3 : 1, so an "average roll" of a
  // family is 0.6 low + 0.3 mid + 0.1 high.
  var TIER_ODDS = { low: 0.6, mid: 0.3, high: 0.1 };
  // Share of the best family's average roll -> letter. Monotone, round numbers;
  // the best family is always S and anything scoring nothing is always F.
  var FAMILY_GRADE_BANDS = [[0.90, "S"], [0.70, "A"], [0.50, "B"], [0.30, "C"], [0.10, "D"], [-1, "F"]];

  function bandLetter(share) {
    for (var i = 0; i < FAMILY_GRADE_BANDS.length; i++) {
      if (share >= FAMILY_GRADE_BANDS[i][0]) return FAMILY_GRADE_BANDS[i][1];
    }
    return "F";
  }

  /**
   * familyGrades(grade) — an F-to-S letter for every family a granted slot can
   * hold, rating the family's AVERAGE roll against the best family's.
   *
   * Deliberately computed from the CANONICAL DEFAULT profile, never the
   * caller's: the letter labels a family, not a build, so they must not shuffle
   * every time someone moves a slider. (The leaderboard will score on the same
   * defaults for the same reason.)
   *
   * -> { grade, bestAvg, basic:{fam:{avg,share,letter}}, trait:{…}, special:{id:{…}} }
   */
  function familyGrades(grade, role) {
    grade = grade || "ancient";
    // The letters are read off the CANONICAL DEFAULT profile so they label the
    // family rather than the current build and never shuffle mid-edit — but the
    // ROLE is not a build setting, it decides which lines score at all. A support
    // reading "S · Crit Rate" off a line worth exactly 0.000 to them is not a
    // stable label, it is a wrong one.
    var P = normalizeProfile(role === "support" ? { role: "support" } : {});
    var out = { grade: grade, bestAvg: 0, basic: {}, trait: {}, special: {} };
    var i, t, avg, tiers = ["low", "mid", "high"];

    var basics = ["mainStat", "vitality"];
    for (i = 0; i < basics.length; i++) {
      avg = lineDamage({ cat: "basic", family: basics[i] }, grade, P);   // band-weighted value
      out.basic[basics[i]] = { avg: avg };
      if (avg > out.bestAvg) out.bestAvg = avg;
    }
    for (i = 0; i < DATA.TRAITS.families.length; i++) {
      // A trait rolled into a GRANTED slot scores nothing; only the two fixed
      // trait lines carry value, and those are not draws.
      out.trait[DATA.TRAITS.families[i].key] = { avg: 0 };
    }
    for (i = 0; i < DATA.SPECIALS.length; i++) {
      var fam = DATA.SPECIALS[i];
      avg = 0;
      for (t = 0; t < tiers.length; t++) {
        avg += TIER_ODDS[tiers[t]] * lineDamage({ cat: "special", family: fam.id, tier: tiers[t] }, grade, P);
      }
      out.special[fam.id] = { avg: avg };
      if (avg > out.bestAvg) out.bestAvg = avg;
    }

    var cats = ["basic", "trait", "special"], k, e;
    for (i = 0; i < cats.length; i++) {
      for (k in out[cats[i]]) if (Object.prototype.hasOwnProperty.call(out[cats[i]], k)) {
        e = out[cats[i]][k];
        e.share = out.bestAvg > 0 ? e.avg / out.bestAvg : 0;
        e.letter = e.avg > 0 ? bandLetter(e.share) : "F";
      }
    }
    return out;
  }

  /**
   * setDamage(lines, grade, profile) -> D for a whole set of EFFECT lines.
   *
   * Not a sum of lineDamage() any more. The lines pool first — one crit factor
   * over the set's whole crit contribution and the profile's own base crit rate,
   * capped once; one additional-damage pool; one attack-power ratio — and only
   * the orthogonal buckets multiply line by line. Two crit lines on a character
   * already at 90% crit are worth less together than apart, and that is the whole
   * point: the second one is selling crit rate the cap eats.
   *
   * A combat-trait line still scores ZERO here (lineContribution gives it an
   * empty record), so `linesPct` keeps meaning what lostark.bible's "Bracelet
   * Effects +X%" means. To pool the traits in as well — which is the truth for a
   * whole bracelet — call jointScore().
   */
  function setDamage(lines, grade, profile) {
    profile = normalizeProfile(profile);
    var rec = emptyContribution();
    for (var i = 0; i < lines.length; i++) addContribution(rec, lineContribution(lines[i], grade, profile));
    return contributionDamage(rec, profile);
  }

  /**
   * jointScore(lines, traits, grade, profile) -> D for the WHOLE bracelet.
   *
   * setDamage(lines) + traitDamage(traits) is what the four set scorers still
   * add up, and it over-pays whenever the effect lines and the crit trait are
   * competing for the same 100% cap: family 11 high + family 31 high + Crit 120 +
   * Spec 120 sums to 14.032 and is jointly worth 11.043. This is that same
   * bracelet scored in one pool.
   *
   * It is deliberately a SEPARATE entry point rather than a change of meaning for
   * the two functions the scorers already call. traitDamage() is the trait
   * slider's constant and the Tier List's per-trait figure; setDamage() is the
   * effect-lines-only number the leaderboard ranks on. Both keep their jobs; a
   * caller that wants the honest total for a whole bracelet asks for it here.
   */
  function jointScore(lines, traits, grade, profile) {
    profile = normalizeProfile(profile);
    var rec = emptyContribution(), i;
    for (i = 0; i < (lines || []).length; i++) addContribution(rec, lineContribution(lines[i], grade, profile));
    addContribution(rec, traitContribution(traits, profile));
    return contributionDamage(rec, profile);
  }

  // ------------------------------------------------------------------
  // Draw atoms and the pool
  // ------------------------------------------------------------------

  var CAT_ORDER = ["basic", "trait", "special"];

  /**
   * Every outcome one granted slot can produce, on the shared 100-point weight
   * scale. Families whose every tier scores 0 collapse to a single atom (they
   * are interchangeable), which is what keeps the solver's alphabet small.
   *
   * Every atom carries a CONTRIBUTION RECORD as well as its standalone `damage`.
   * The record is what the DP pools; `damage` is the display figure, the family
   * letters' input, and the junk test — which is why junk stays a property of the
   * line on its own rather than of the set it lands in.
   *
   * options.basicMode: "bands" (default, one atom per value band) | "expected".
   */
  function buildAtoms(grade, profile, options) {
    options = options || {};
    var basicMode = options.basicMode || "bands";
    var atoms = [];
    var catW = DATA.CATEGORY_WEIGHTS;

    function push(a) {
      a.idx = atoms.length;
      a.damage = toD(contributionMultiplier(a.rec, profile));
      atoms.push(a);
    }
    function msRec(v) { var r = emptyContribution(); r.dMs = v; return r; }

    // --- basic ---
    var basicFamW = catW.basic * 0.5;    // 17.5 each, mainStat / vitality
    if (basicMode === "expected") {
      var ev = basicBandExpected("mainStat", grade);
      push({ key: "basic:mainStat", cat: "basic", family: "basic:mainStat", tier: null, band: null,
        weight: basicFamW, value: ev, label: "Str / Dex / Int", rec: msRec(ev) });
    } else {
      for (var b = 0; b < DATA.BASIC.bands.length; b++) {
        var bd = DATA.BASIC.bands[b], mv = bandMid(bd[grade].mainStat);
        push({ key: "basic:mainStat:b" + b, cat: "basic", family: "basic:mainStat", tier: null, band: b,
          weight: basicFamW * bd.prob / 100, value: mv,
          label: "Str / Dex / Int " + bd[grade].mainStat[0] + "–" + bd[grade].mainStat[1],
          rec: msRec(mv) });
      }
    }
    push({ key: "basic:vitality", cat: "basic", family: "basic:vitality", tier: null, band: null,
      weight: basicFamW, value: basicBandExpected("vitality", grade), label: "Vitality",
      rec: emptyContribution() });

    // --- combat traits: six families ---
    //
    // A DRAWN combat trait is priced, since 0.4.0, at the band-weighted value it
    // would land on. It used to be flat zero, which said a reroll into Crit +87
    // was worth exactly as much as a reroll into Vitality — so the solver would
    // roll a trait away and never towards one, and any bracelet with a trait
    // place still open had its expected final score reported about 1.17 points
    // low. Crit goes through the pool and the cap like every other crit source;
    // Spec and Swiftness take the class's own weight (a support's pair go through
    // the identity bracket instead); Domination, Endurance and Expertise are the
    // three that pay nothing, so they stay junk and collapse.
    //
    // lineDamage() still answers ZERO for a trait line, and must: the board's
    // `linesPct` is the effect lines alone, and a bracelet's real trait points
    // ride in traitValues, not in the band average. This is the DRAW's price, not
    // a line's score.
    var traitEv = traitBandExpected(grade);
    for (var t = 0; t < DATA.TRAITS.families.length; t++) {
      var tf = DATA.TRAITS.families[t], tOne = {};
      tOne[tf.key] = traitEv;                       // traitAlias reads "swiftness" as "swift"
      push({ key: "trait:" + tf.key, cat: "trait", family: "trait:" + tf.key, tier: null, band: null,
        weight: catW.trait / DATA.TRAITS.families.length, value: traitEv, label: tf.label,
        rec: traitContribution(tOne, profile) });
    }

    // --- specials: 30% split by the listed table, renormalised by its own sum ---
    var sum = DATA.GRANTED_LISTED_SUM;
    for (var f = 0; f < DATA.SPECIALS.length; f++) {
      var fam = DATA.SPECIALS[f];
      var recs = [], famW = 0, any = false;
      for (var ti = 0; ti < DATA.TIERS.length; ti++) {
        var tier = DATA.TIERS[ti];
        var rec = specialContribution(fam, tier, grade, profile);
        if (Math.abs(toD(contributionMultiplier(rec, profile))) > 1e-12) any = true;
        recs.push(rec);
        famW += catW.special * fam.granted[tier] / sum;
      }
      if (!any) {
        // Dead family for this profile: one atom, the family's whole weight.
        push({ key: "special:" + fam.id, cat: "special", family: "special:" + fam.id, tier: null, band: null,
          weight: famW, value: null, label: fam.label, rec: emptyContribution() });
      } else {
        for (var ti2 = 0; ti2 < DATA.TIERS.length; ti2++) {
          var tr = DATA.TIERS[ti2];
          push({ key: "special:" + fam.id + ":" + tr, cat: "special", family: "special:" + fam.id, tier: tr, band: null,
            weight: catW.special * fam.granted[tr] / sum, value: fam.values[grade][tr],
            label: fam.label + " (" + tr + ")", rec: recs[ti2] });
        }
      }
    }

    // State label: everything with no damage is interchangeable inside its category.
    for (var i = 0; i < atoms.length; i++) {
      atoms[i].junk = Math.abs(atoms[i].damage) <= 1e-12;
      atoms[i].stateKey = atoms[i].junk ? ("junk:" + atoms[i].cat) : atoms[i].key;
    }
    return atoms;
  }

  function lineFamilyId(line) {
    if (line.cat === "basic") return "basic:" + line.family;
    if (line.cat === "trait") return "trait:" + line.family;
    var fam = resolveSpecial(line.family);
    return "special:" + (fam ? fam.id : line.family);
  }

  /**
   * The official trait-family key a traitValues key names, or null.
   *
   * traitValues is written in the profile deck's spelling ("swift"); the draw
   * table and every trait LINE use the official one ("swiftness"). Both have to
   * land on the same family or the same trait counts as two places.
   */
  function traitFamilyKey(key) {
    if (key === "swift") key = "swiftness";
    for (var i = 0; i < DATA.TRAITS.families.length; i++) {
      if (DATA.TRAITS.families[i].key === key) return key;
    }
    return null;
  }

  function countCats(lines) {
    var c = { basic: 0, trait: 0, special: 0 };
    for (var i = 0; i < lines.length; i++) if (c[lines[i].cat] !== undefined) c[lines[i].cat]++;
    return c;
  }

  /**
   * buildPool({ grade, profile, lines, options })
   *
   * The renormalised distribution of ONE granted draw for a bracelet already
   * carrying `lines` (fixed + granted alike). Capped categories and present
   * families drop out and the survivors renormalise by dividing through the
   * surviving mass — the page's own rule.
   */
  function buildPool(opts) {
    var profile = normalizeProfile(opts.profile);
    var grade = opts.grade || "ancient";
    var lines = opts.lines || [];
    var atoms = opts.atoms || buildAtoms(grade, profile, opts.options);

    var present = {}, i;
    for (i = 0; i < lines.length; i++) present[lineFamilyId(lines[i])] = true;
    var counts = countCats(lines);

    var survivors = [], mass = 0, excluded = 0;
    for (i = 0; i < atoms.length; i++) {
      var a = atoms[i];
      var dropped = present[a.family] || counts[a.cat] >= DATA.CAPS[a.cat];
      if (dropped) { excluded += a.weight; continue; }
      survivors.push(a); mass += a.weight;
    }
    var entries = [];
    for (i = 0; i < survivors.length; i++) {
      entries.push({
        key: survivors[i].key, cat: survivors[i].cat, family: survivors[i].family,
        tier: survivors[i].tier, band: survivors[i].band, label: survivors[i].label,
        damage: survivors[i].damage, listed: survivors[i].weight,
        p: mass > 0 ? survivors[i].weight / mass : 0
      });
    }
    var byCategory = { basic: 0, trait: 0, special: 0 };
    for (i = 0; i < entries.length; i++) byCategory[entries[i].cat] += entries[i].p;
    return { entries: entries, survivingMass: mass, excludedMass: excluded, byCategory: byCategory, atoms: atoms };
  }

  // ------------------------------------------------------------------
  // Solver
  // ------------------------------------------------------------------

  function makeStateAtoms(atoms) {
    var map = {}, list = [];
    for (var i = 0; i < atoms.length; i++) {
      var k = atoms[i].stateKey;
      if (map[k] === undefined) {
        map[k] = list.length;
        list.push({ key: k, cat: atoms[i].cat, damage: atoms[i].damage, rec: atoms[i].rec, junk: atoms[i].junk,
          label: atoms[i].junk ? ("(no-damage " + atoms[i].cat + " line)") : atoms[i].label,
          family: atoms[i].junk ? null : atoms[i].family, tier: atoms[i].tier, band: atoms[i].band });
      }
      atoms[i].stateIdx = map[k];
    }
    return { map: map, list: list };
  }

  // A state is a sorted tuple of state-atom indices packed into one integer.
  function makeCodec(nStateAtoms, slots) {
    var base = nStateAtoms + 1;
    return {
      base: base,
      encode: function (sorted) {
        var v = 0;
        for (var i = 0; i < slots; i++) v = v * base + (i < sorted.length ? sorted[i] + 1 : 0);
        return v;
      },
      decode: function (code) {
        var out = [];
        for (var i = 0; i < slots; i++) { out.unshift(code % base); code = Math.floor(code / base); }
        var r = [];
        for (var j = 0; j < out.length; j++) if (out[j] > 0) r.push(out[j] - 1);
        return r;
      }
    };
  }

  function sortedCopy(a) { var c = a.slice(); c.sort(function (x, y) { return x - y; }); return c; }

  /**
   * All ways `k` further slots can come out, given the families/categories
   * already committed. Draws are sequential without replacement and every step
   * renormalises over the survivors, so orderings must be walked in full.
   * Returns { codes:[], probs:[] } over canonical state codes.
   */
  function enumerateCompletions(atoms, presentFamilies, counts, k, basePieces, codec, caps) {
    var acc = {};
    var pieces = basePieces.slice();

    function rec(depth, prob, present, cnt) {
      if (depth === k) {
        var code = codec.encode(sortedCopy(pieces));
        acc[code] = (acc[code] || 0) + prob;
        return;
      }
      var mass = 0, i, a;
      for (i = 0; i < atoms.length; i++) {
        a = atoms[i];
        if (present[a.family] || cnt[a.cat] >= caps[a.cat]) continue;
        mass += a.weight;
      }
      if (mass <= 0) return;
      for (i = 0; i < atoms.length; i++) {
        a = atoms[i];
        if (present[a.family] || cnt[a.cat] >= caps[a.cat]) continue;
        present[a.family] = true; cnt[a.cat]++;
        pieces.push(a.stateIdx);
        rec(depth + 1, prob * a.weight / mass, present, cnt);
        pieces.pop();
        present[a.family] = false; cnt[a.cat]--;
      }
    }

    var pf = {}, c = { basic: counts.basic, trait: counts.trait, special: counts.special };
    for (var f in presentFamilies) if (presentFamilies[f]) pf[f] = true;
    rec(0, 1, pf, c);

    var codes = [], probs = [];
    for (var code in acc) { codes.push(Number(code)); probs.push(acc[code]); }
    return { codes: codes, probs: probs };
  }

  // F(L,r)(v) = Σ_T P(T|L)·max(v, V(T,r)), as a sorted array with prefix sums.
  function buildF(completion, V) {
    var n = completion.codes.length, i;
    var order = [];
    for (i = 0; i < n; i++) order.push(i);
    order.sort(function (x, y) { return V[completion.codes[x]] - V[completion.codes[y]]; });
    var vals = new Array(n), probs = new Array(n), ids = new Array(n);
    for (i = 0; i < n; i++) {
      var j = order[i];
      ids[i] = completion.codes[j];
      vals[i] = V[completion.codes[j]];
      probs[i] = completion.probs[j];
    }
    var cumP = new Array(n + 1), cumPV = new Array(n + 1);
    cumP[0] = 0; cumPV[0] = 0;
    for (i = 0; i < n; i++) { cumP[i + 1] = cumP[i] + probs[i]; cumPV[i + 1] = cumPV[i] + probs[i] * vals[i]; }
    return { vals: vals, probs: probs, ids: ids, cumP: cumP, cumPV: cumPV, totalPV: cumPV[n], n: n };
  }

  // number of entries with vals[i] <= v
  function upperBound(vals, v) {
    var lo = 0, hi = vals.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (vals[mid] <= v) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function queryF(F, v) {
    var i = upperBound(F.vals, v);
    return v * F.cumP[i] + (F.totalPV - F.cumPV[i]);
  }

  /**
   * solve(opts) — exact reroll DP. See the file header for the mechanics.
   *
   * opts = {
   *   grade: "relic"|"ancient",
   *   profile: <partial profile>,
   *   fixedLines: [ {cat, family, tier?, value?} ],   // never rerolled
   *   grantedLines: [ {cat, family, tier?} ],         // current granted set; [] = unrolled
   *   slots: <int>,                                   // granted slot count (2 or 3)
   *   rollsLeft: 7,                                   // or rolls:{normal,ticket}
   *   goldPer1Pct: <gold per 1% damage>,
   *   baselinePct: <the bracelet you'd otherwise use, default 0>,
   *   traitValues: {crit,spec,swift},                 // the two fixed traits' numbers
   *   options: { basicMode, allowLockJunk, testPool, maxStates }
   * }
   *
   * EVERY KEY IS OPTIONAL AND NOTHING WARNS YOU, which has bitten once and will
   * bite again. A misspelt key falls through to a default, and two of those
   * defaults are load-bearing:
   *
   *   - `slots` defaults to grantedLines.length, then to TWO. Call this with a
   *     three-slot bracelet under any other key name and you silently solve a
   *     different bracelet.
   *   - `fixedLines` is what CAPS THE CATEGORIES for the basic and special
   *     families. Name every line the bracelet already carries there or the pool
   *     will offer them again. Since 0.4.0 the two COMBAT TRAITS no longer have to
   *     be named there as well: `traitValues` counts against the trait cap by
   *     itself, which is what stops a granted slot drawing a third trait. Both
   *     spellings still work and naming a trait twice counts once.
   *
   * The tell, if you suspect it: the DP's expectedFinal will come out BELOW a
   * crude threshold heuristic. It cannot — the DP is optimal. tools/roll-sim.mjs
   * is an independent simulator kept for exactly that comparison.
   *
   * -> {
   *   currentScore, expectedFinal, gain, valueGold,
   *   bestLockMask: { lockedSlots, lockedKeys, ev },
   *   maskEV: [ { lockedSlots, lockedKeys, ev } ],
   *   evByRollsLeft: [V(s,0) … V(s,R)],               // must be non-decreasing
   *   pImprove, finalScore: { mean, quantiles, cdf },
   *   ctx, stats
   * }
   *
   * `ctx` carries the solved layers so advise() can answer keep-or-replace and
   * value any other state without re-solving.
   */
  function solve(opts) {
    var t0 = Date.now();
    var profile = normalizeProfile(opts.profile);
    var grade = opts.grade || "ancient";
    var options = opts.options || {};
    var caps = DATA.CAPS;

    var atoms = options.testPool ? normalizeTestPool(options.testPool) : buildAtoms(grade, profile, options);

    var fixedLines = opts.fixedLines || [];
    var grantedLines = opts.grantedLines || [];
    var slots = opts.slots || grantedLines.length || 2;

    var fixedPresent = {}, i, j;
    for (i = 0; i < fixedLines.length; i++) fixedPresent[lineFamilyId(fixedLines[i])] = true;
    var fixedCounts = countCats(fixedLines);

    // THE TWO COMBAT TRAITS OCCUPY TRAIT PLACES, however the caller names them.
    // Their points arrive in traitValues rather than as lines, and until 0.4.0
    // nothing counted them: any caller that did not ALSO list them in fixedLines
    // — which is every caller that reads a bracelet off a character page — left
    // the trait category wide open, so about 35% of every draw came back a combat
    // trait the DP then priced at zero. Counting them here is what shuts that
    // door. A family named both ways is one place, not two.
    if (opts.traitValues) {
      for (var tk in opts.traitValues) {
        if (!Object.prototype.hasOwnProperty.call(opts.traitValues, tk)) continue;
        if (!opts.traitValues[tk]) continue;
        var tFam = traitFamilyKey(tk);
        if (!tFam || fixedPresent["trait:" + tFam]) continue;
        fixedPresent["trait:" + tFam] = true;
        fixedCounts.trait++;
      }
      // A trait the bracelet ALREADY carries is not a draw it can still make, and
      // its exact points are in traitValues already. Zero that family's atom so a
      // caller holding the line in grantedLines — which is where an imported
      // bracelet's unlocked trait lands — is never paid for it twice.
      for (i = 0; i < atoms.length; i++) {
        if (atoms[i].cat !== "trait" || !fixedPresent[atoms[i].family]) continue;
        atoms[i].rec = emptyContribution();
        atoms[i].damage = 0;
        atoms[i].junk = true;
        atoms[i].stateKey = "junk:trait";
      }
    }

    var sa = makeStateAtoms(atoms);
    var stateAtoms = sa.list;
    var codec = makeCodec(stateAtoms.length, slots);

    // The bracelet's fixed lines and its two combat traits are a constant on every
    // reachable state — but a CONSTANT MULTIPLIER, not a constant number of points.
    // They pool with whatever the granted slots hold (a crit trait and a granted
    // crit line share one cap), so what rides along is the record, and the score of
    // a state is the pool applied once.
    var baseRec = emptyContribution();
    for (i = 0; i < fixedLines.length; i++) addContribution(baseRec, lineContribution(fixedLines[i], grade, profile));
    addContribution(baseRec, traitContribution(opts.traitValues, profile));
    // Reported for the readout and for callers repricing the trait pair. It is the
    // traits priced on their own, which is what traitDamage() has always meant; the
    // score below does not simply add it.
    var traitBonus = traitDamage(opts.traitValues, profile);
    var fixedDamage = contributionDamage(baseRec, profile);

    // The current granted set, mapped onto draw atoms.
    var startPieces = [];
    for (i = 0; i < grantedLines.length; i++) {
      var a = matchAtom(atoms, grantedLines[i], grade);
      if (a) startPieces.push(a.stateIdx);
    }
    var startCode = codec.encode(sortedCopy(startPieces));

    // Every reachable granted set (rolling from scratch reaches all of them).
    var allT = enumerateCompletions(atoms, fixedPresent, fixedCounts, slots, [], codec, caps);
    var codes = allT.codes.slice();
    var seen = {};
    for (i = 0; i < codes.length; i++) seen[codes[i]] = true;
    if (!seen[startCode]) { codes.push(startCode); seen[startCode] = true; }

    var maxStates = options.maxStates || 400000;
    if (codes.length > maxStates) {
      throw new Error("bracelet.solve: " + codes.length + " states exceeds maxStates " + maxStates);
    }

    // Per-state: pieces, score, and the lock masks worth considering.
    var pieces = {}, score = {}, masksOf = {};
    var allowLockJunk = !!options.allowLockJunk;
    var completions = {};      // lockKey -> { codes, probs }
    var lockKeyOf = function (idxList) { return idxList.join(","); };

    for (i = 0; i < codes.length; i++) {
      var code = codes[i];
      var pc = codec.decode(code);
      pieces[code] = pc;
      // The whole bracelet in one pool: the fixed lines, the combat traits and
      // whatever this state's granted slots hold, with one crit cap, one
      // additional-damage pool and one attack-power ratio over the lot. The DP
      // only ever needs score[code], never a per-slot split, so pooling costs the
      // state space nothing.
      var rec = copyContribution(baseRec);
      for (j = 0; j < pc.length; j++) addContribution(rec, stateAtoms[pc[j]].rec);
      score[code] = contributionDamage(rec, profile);

      // Lockable slots — junk lines are excluded unless asked for (see header).
      var lockable = [];
      for (j = 0; j < pc.length; j++) if (allowLockJunk || !stateAtoms[pc[j]].junk) lockable.push(j);
      var masks = [];
      var nsub = 1 << lockable.length;
      for (var m = 0; m < nsub; m++) {
        var sel = [];
        for (var b2 = 0; b2 < lockable.length; b2++) if (m & (1 << b2)) sel.push(lockable[b2]);
        if (sel.length >= pc.length && pc.length === slots) continue;   // nothing left to roll
        var idxs = [];
        for (var s2 = 0; s2 < sel.length; s2++) idxs.push(pc[sel[s2]]);
        idxs = sortedCopy(idxs);
        var lk = lockKeyOf(idxs);
        masks.push({ slots: sel, atomIdx: idxs, key: lk });
        if (!completions[lk]) {
          var pres = {}, cnt = { basic: fixedCounts.basic, trait: fixedCounts.trait, special: fixedCounts.special };
          for (var f in fixedPresent) if (fixedPresent[f]) pres[f] = true;
          var basePieces = [];
          for (var q = 0; q < idxs.length; q++) {
            var st = stateAtoms[idxs[q]];
            if (st.family) pres[st.family] = true;
            cnt[st.cat]++;
            basePieces.push(idxs[q]);
          }
          completions[lk] = enumerateCompletions(atoms, pres, cnt, slots - idxs.length, basePieces, codec, caps);
        }
      }
      masksOf[code] = masks;
    }

    var R = opts.rollsLeft !== undefined ? opts.rollsLeft
      : ((opts.rolls && opts.rolls.normal !== undefined ? opts.rolls.normal : 4) +
         (opts.rolls && opts.rolls.ticket !== undefined ? opts.rolls.ticket : 3));
    var goldPer1Pct = opts.goldPer1Pct !== undefined ? opts.goldPer1Pct : 0;
    var baselinePct = opts.baselinePct !== undefined ? opts.baselinePct : 0;

    // ---- backward pass. V is the expected FINAL score; rolls are free, so
    // rolling weakly dominates stopping and there is no stop branch. ----
    var layers = [], policies = [];
    var V0 = {};
    for (i = 0; i < codes.length; i++) V0[codes[i]] = score[codes[i]];
    layers.push(V0); policies.push(null);

    for (var r = 1; r <= R; r++) {
      var prev = layers[r - 1];
      var Fs = {};
      for (var lk2 in completions) if (Object.prototype.hasOwnProperty.call(completions, lk2)) {
        Fs[lk2] = buildF(completions[lk2], prev);
      }
      var Vr = {}, Pr = {};
      for (i = 0; i < codes.length; i++) {
        var c2 = codes[i], best = -Infinity, bestKey = null, vs = prev[c2];
        var ms = masksOf[c2];
        for (j = 0; j < ms.length; j++) {
          var ev = queryF(Fs[ms[j].key], vs);
          if (ev > best + 1e-12) { best = ev; bestKey = ms[j].key; }
        }
        if (bestKey === null) { best = vs; }        // no rollable slot: hold
        Vr[c2] = best; Pr[c2] = bestKey;
      }
      layers.push(Vr); policies.push(Pr);
    }

    // ---- root readout ----
    // An empty granted set means an UNROLLED bracelet: the drop's own lines have
    // not been seen yet, so there is nothing to keep or lock and the value is the
    // average over that first set, each still holding all R rerolls.
    var unrolled = startPieces.length < slots;
    var maskEV = [], expectedFinal, evByRollsLeft = [], seedMu = null, cur;

    if (unrolled) {
      var all0 = completions[""] || allT;
      seedMu = {};
      for (i = 0; i < all0.codes.length; i++) seedMu[all0.codes[i]] = all0.probs[i];
      for (r = 0; r <= R; r++) {
        var acc = 0;
        for (i = 0; i < all0.codes.length; i++) acc += all0.probs[i] * layers[r][all0.codes[i]];
        evByRollsLeft.push(acc);
      }
      expectedFinal = evByRollsLeft[R];
      cur = fixedDamage;
    } else if (R === 0) {
      // No attempts left. Nothing to lock, nothing to roll: the bracelet is what
      // it is. (Without this branch the mask readout below would reach for
      // layers[−1].)
      expectedFinal = layers[0][startCode];
      evByRollsLeft.push(expectedFinal);
      cur = score[startCode];
    } else {
      var rootMasks = masksOf[startCode];
      var rootPrev = layers[R - 1];
      var rootFs = {};
      for (j = 0; j < rootMasks.length; j++) {
        var mk = rootMasks[j];
        if (!rootFs[mk.key]) rootFs[mk.key] = buildF(completions[mk.key], rootPrev);
        var lockedKeys = [];
        for (var z = 0; z < mk.atomIdx.length; z++) lockedKeys.push(stateAtoms[mk.atomIdx[z]].key);
        maskEV.push({
          lockedSlots: mk.slots.slice(), lockedKeys: lockedKeys,
          ev: queryF(rootFs[mk.key], rootPrev[startCode])
        });
      }
      maskEV.sort(function (x, y) { return y.ev - x.ev; });
      expectedFinal = layers[R][startCode];
      for (r = 0; r <= R; r++) evByRollsLeft.push(layers[r][startCode]);
      cur = score[startCode];
    }

    // ---- forward pass: the distribution of the final score under optimal play ----
    var finalDist = forwardDistribution(startCode, R, layers, policies, completions, score, seedMu);
    var pImprove = 0, mean = 0, keys = [];
    for (var sk in finalDist) if (Object.prototype.hasOwnProperty.call(finalDist, sk)) {
      var sv = Number(sk);
      keys.push(sv);
      mean += sv * finalDist[sk];
      if (sv > cur + 1e-9) pImprove += finalDist[sk];
    }
    keys.sort(function (x, y) { return x - y; });
    var cdf = [], acc2 = 0;
    for (i = 0; i < keys.length; i++) { acc2 += finalDist[keys[i]]; cdf.push({ score: keys[i], p: finalDist[keys[i]], cum: acc2 }); }
    function quant(q) {
      for (var i2 = 0; i2 < cdf.length; i2++) if (cdf[i2].cum >= q - 1e-12) return cdf[i2].score;
      return cdf.length ? cdf[cdf.length - 1].score : cur;
    }

    // ---- worth: E[ max(0, final% - baseline%) ] x gold-per-1% ----
    var valueGold = 0, pBeat = 0;
    for (i = 0; i < cdf.length; i++) {
      var over = damagePercent(cdf[i].score) - baselinePct;
      if (over > 0) { valueGold += cdf[i].p * over; pBeat += cdf[i].p; }
    }
    valueGold *= goldPer1Pct;

    var ctx = {
      grade: grade, profile: profile, slots: slots, rolls: R,
      atoms: atoms, stateAtoms: stateAtoms, codec: codec,
      layers: layers, policies: policies, score: score,
      goldPer1Pct: goldPer1Pct, baselinePct: baselinePct
    };

    return {
      grade: grade, slots: slots,
      unrolled: unrolled,
      currentScore: cur,
      fixedDamage: fixedDamage,
      traitDamage: traitBonus,
      expectedFinal: expectedFinal,
      gain: expectedFinal - cur,
      // What the bracelet is WORTH, in gold.
      //
      // Two things this is not. It is not (mean - baseline): a bracelet you would
      // not use is worth nothing, never a negative number, so the payoff is
      // truncated at zero and the expectation is taken over the whole final
      // distribution — you are paid only in the outcomes that beat the baseline,
      // weighted by how often they happen and by how far they clear it.
      //
      // And it is not measured in log points. `expectedFinal` is a log-space
      // score; the baseline the user types is a damage percentage. Comparing
      // them directly (as this did) mixes units and understates the value by a
      // few percent. Convert each outcome to damage % first.
      valueGold: valueGold,
      pBeatBaseline: pBeat,
      bestLockMask: maskEV.length ? maskEV[0] : null,
      maskEV: maskEV,
      evByRollsLeft: evByRollsLeft,
      pImprove: pImprove,
      finalScore: {
        mean: mean,
        quantiles: { p10: quant(0.10), p25: quant(0.25), p50: quant(0.50), p75: quant(0.75), p90: quant(0.90) },
        cdf: cdf
      },
      ctx: ctx,
      stats: { states: codes.length, atoms: atoms.length, stateAtoms: stateAtoms.length,
        lockMasks: Object.keys(completions).length, rolls: R, ms: Date.now() - t0 }
    };
  }

  /**
   * advise(ctx, o) — the keep-or-replace verdict after a roll has landed.
   *
   * o = { current: [lines], rolled: [lines], rollsLeft: <attempts left AFTER
   *       this roll>, locksUsed: [slot indexes] (informational) }
   *
   * Both sides are valued as continuation values V(·, rollsLeft), which is the
   * only correct comparison: the set that scores less right now can still be
   * worth more because of what it clears out of the pool.
   */
  function advise(ctx, o) {
    var rl = o.rollsLeft !== undefined ? o.rollsLeft : (ctx.rolls - 1);
    if (rl < 0) rl = 0;
    if (rl >= ctx.layers.length) rl = ctx.layers.length - 1;
    var layer = ctx.layers[rl];
    function codeOf(lines) {
      var p = [];
      for (var i = 0; i < lines.length; i++) {
        var a = matchAtom(ctx.atoms, lines[i], ctx.grade);
        if (a) p.push(a.stateIdx);
      }
      return ctx.codec.encode(sortedCopy(p));
    }
    var cKeep = codeOf(o.current || []), cNew = codeOf(o.rolled || []);
    var vKeep = layer[cKeep], vNew = layer[cNew];
    if (vKeep === undefined || vNew === undefined) return { verdict: "unknown", vKeep: vKeep, vNew: vNew };
    var verdict = vNew > vKeep + 1e-12 ? "replace" : "keep";
    return {
      verdict: verdict,
      vKeep: vKeep, vNew: vNew, delta: vNew - vKeep,
      scoreKeep: ctx.score[cKeep], scoreNew: ctx.score[cNew],
      goldDelta: (vNew - vKeep) * ctx.goldPer1Pct,
      locksUsed: o.locksUsed || [],
      rollsLeft: rl
    };
  }

  /** P(final score ≥ x) from a solve() result's finalScore.cdf. */
  function pAtLeast(cdf, x) {
    for (var i = 0; i < cdf.length; i++) if (cdf[i].score >= x - 1e-12) return 1 - (i > 0 ? cdf[i - 1].cum : 0);
    return 0;
  }

  /**
   * Push the probability mass forward through the optimal policy.
   *
   * The transition out of a state depends only on its lock mask, so states are
   * grouped by mask and swept: for a given mask the outcomes T are already
   * sorted by continuation value, and a state keeps its own set exactly when
   * V(T) ≤ V(S). One sweep replaces a dense |states|² transition matrix.
   */
  function forwardDistribution(startCode, R, layers, policies, completions, score, seedMu) {
    var finalDist = {}, mu = {};
    if (seedMu) { for (var s0 in seedMu) if (Object.prototype.hasOwnProperty.call(seedMu, s0)) mu[s0] = seedMu[s0]; }
    else mu[startCode] = 1;

    function addFinal(code, m) {
      var k = score[code];
      finalDist[k] = (finalDist[k] || 0) + m;
    }

    for (var r = R; r >= 1; r--) {
      var prev = layers[r - 1], pol = policies[r];
      var groups = {}, code, m;
      for (code in mu) if (Object.prototype.hasOwnProperty.call(mu, code)) {
        m = mu[code];
        if (m <= 0) continue;
        var lk = pol[code];
        // The empty lock mask has key "" — falsy, so test for null explicitly.
        if (lk === null || lk === undefined) { addFinal(Number(code), m); continue; }
        if (!groups[lk]) groups[lk] = [];
        groups[lk].push({ code: Number(code), mass: m, v: prev[code] });
      }
      var next = {};
      for (var key in groups) if (Object.prototype.hasOwnProperty.call(groups, key)) {
        var members = groups[key];
        members.sort(function (a, b) { return a.v - b.v; });
        var F = buildF(completions[key], prev);
        // mass that keeps its current set
        for (var i = 0; i < members.length; i++) {
          var idx = upperBound(F.vals, members[i].v);
          var stay = members[i].mass * F.cumP[idx];
          if (stay > 0) next[members[i].code] = (next[members[i].code] || 0) + stay;
        }
        // mass that takes the new set: sweep outcomes in increasing value
        var ptr = 0, below = 0;
        for (var t = 0; t < F.n; t++) {
          while (ptr < members.length && members[ptr].v < F.vals[t]) { below += members[ptr].mass; ptr++; }
          if (below > 0 && F.probs[t] > 0) {
            var id = F.ids[t];
            next[id] = (next[id] || 0) + below * F.probs[t];
          }
        }
      }
      mu = next;
    }
    for (var c2 in mu) if (Object.prototype.hasOwnProperty.call(mu, c2)) addFinal(Number(c2), mu[c2]);
    return finalDist;
  }

  function matchAtom(atoms, line, grade) {
    var i;
    // A line may name an atom outright (the test pools do); otherwise it is
    // matched by family, then by tier or value band.
    if (line.key) {
      for (i = 0; i < atoms.length; i++) if (atoms[i].key === line.key) return atoms[i];
    }
    var famId = lineFamilyId(line);
    var best = null;
    for (i = 0; i < atoms.length; i++) {
      var a = atoms[i];
      if (a.family !== famId) continue;
      if (line.cat === "special") {
        if (a.tier === null || a.tier === line.tier) { best = a; if (a.tier === line.tier) return a; }
      } else if (line.cat === "basic" && a.band !== null && line.value !== undefined && line.value !== null) {
        var bd = DATA.BASIC.bands[a.band][grade][line.family];
        if (line.value >= bd[0] && line.value <= bd[1]) return a;
        if (!best) best = a;
      } else {
        if (!best) best = a;
      }
    }
    return best;
  }

  /**
   * Turn a hand-written test pool into the atom shape the solver expects.
   *
   * A test atom names its damage outright, with no components behind it, so its
   * record is that number as a plain multiplier — orthogonal to everything, which
   * is what a synthetic atom means.
   */
  function normalizeTestPool(pool) {
    var atoms = [];
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      var rec = emptyContribution();
      rec.mult = Math.exp((p.damage || 0) / 100);
      atoms.push({
        idx: i, key: p.key, cat: p.cat || "special", family: p.family || ("test:" + p.key),
        tier: p.tier || null, band: null, weight: p.weight, value: p.value || null,
        label: p.label || p.key, damage: p.damage || 0, rec: rec
      });
    }
    for (var j = 0; j < atoms.length; j++) {
      atoms[j].junk = Math.abs(atoms[j].damage) <= 1e-12;
      atoms[j].stateKey = atoms[j].junk ? ("junk:" + atoms[j].cat) : atoms[j].key;
    }
    return atoms;
  }

  /**
   * bruteSolve — the same problem by naked recursion, no memoisation and no
   * F-function trick. Exponential; only for tiny cases in the verify battery,
   * where it is the independent oracle for solve().
   */
  function bruteSolve(opts) {
    var profile = normalizeProfile(opts.profile);
    var grade = opts.grade || "ancient";
    var options = opts.options || {};
    var caps = options.caps || DATA.CAPS;
    var atoms = options.testPool ? normalizeTestPool(options.testPool) : buildAtoms(grade, profile, options);
    var sa = makeStateAtoms(atoms);
    var stateAtoms = sa.list;
    var slots = opts.slots || 2;
    var codec = makeCodec(stateAtoms.length, slots);

    var fixedLines = opts.fixedLines || [];
    var fixedPresent = {}, i;
    for (i = 0; i < fixedLines.length; i++) fixedPresent[lineFamilyId(fixedLines[i])] = true;
    var fixedCounts = countCats(fixedLines);
    // Same pooled scoring as solve(), or the oracle would be checking a different
    // model. The trait-place counting is solve()'s alone: this one is only ever
    // called on the hand-written test pools, which carry no trait atoms.
    var baseRec = emptyContribution();
    for (i = 0; i < fixedLines.length; i++) addContribution(baseRec, lineContribution(fixedLines[i], grade, profile));
    addContribution(baseRec, traitContribution(opts.traitValues, profile));
    var fixedDamage = contributionDamage(baseRec, profile);

    var startPieces = [];
    var grantedLines = opts.grantedLines || [];
    for (i = 0; i < grantedLines.length; i++) {
      var a = matchAtom(atoms, grantedLines[i], grade);
      if (a) startPieces.push(a.stateIdx);
    }
    var R = opts.rollsLeft !== undefined ? opts.rollsLeft
      : ((opts.rolls && opts.rolls.normal !== undefined ? opts.rolls.normal : 0) +
         (opts.rolls && opts.rolls.ticket !== undefined ? opts.rolls.ticket : 0));

    function scoreOf(pc) {
      var rec = copyContribution(baseRec);
      for (var k = 0; k < pc.length; k++) addContribution(rec, stateAtoms[pc[k]].rec);
      return contributionDamage(rec, profile);
    }
    var allowLockJunk = !!options.allowLockJunk;

    function V(pc, r) {
      var best = scoreOf(pc);
      if (r === 0) return best;
      best = -Infinity;
      var lockable = [];
      for (var j = 0; j < pc.length; j++) if (allowLockJunk || !stateAtoms[pc[j]].junk) lockable.push(j);
      var nsub = 1 << lockable.length;
      var vSelf = V(pc, r - 1);
      for (var m = 0; m < nsub; m++) {
        var sel = [];
        for (var b = 0; b < lockable.length; b++) if (m & (1 << b)) sel.push(lockable[b]);
        if (sel.length >= pc.length && pc.length === slots) continue;
        var idxs = [];
        for (var s2 = 0; s2 < sel.length; s2++) idxs.push(pc[sel[s2]]);
        idxs = sortedCopy(idxs);
        var pres = {}, cnt = { basic: fixedCounts.basic, trait: fixedCounts.trait, special: fixedCounts.special };
        for (var f in fixedPresent) if (fixedPresent[f]) pres[f] = true;
        for (var q = 0; q < idxs.length; q++) {
          var st = stateAtoms[idxs[q]];
          if (st.family) pres[st.family] = true;
          cnt[st.cat]++;
        }
        var comp = enumerateCompletions(atoms, pres, cnt, slots - idxs.length, idxs, codec, caps);
        var ev = 0;
        for (var t = 0; t < comp.codes.length; t++) {
          var vT = V(codec.decode(comp.codes[t]), r - 1);
          ev += comp.probs[t] * (vSelf > vT ? vSelf : vT);
        }
        if (ev > best) best = ev;
      }
      if (best === -Infinity) best = vSelf;
      return best;
    }

    // Same unrolled convention as solve(): with no granted lines yet, the drop's
    // own set comes free and each possible set still holds all R rerolls.
    if (startPieces.length < slots) {
      var all = enumerateCompletions(atoms, fixedPresent, fixedCounts, slots, [], codec, DATA.CAPS);
      var ev0 = 0;
      for (var t0 = 0; t0 < all.codes.length; t0++) ev0 += all.probs[t0] * V(codec.decode(all.codes[t0]), R);
      return { expectedFinal: ev0, currentScore: fixedDamage };
    }
    return { expectedFinal: V(sortedCopy(startPieces), R), currentScore: scoreOf(startPieces) };
  }

  // ------------------------------------------------------------------
  // lostark.bible payload decoder
  // ------------------------------------------------------------------

  // Verified on live character pages; the rest of the plain-stat indices are
  // still unmapped and come back as unknown passthrough.
  // lostark.bible's plain-stat lines. Every entry below is confirmed against the
  // seeded corpus: the decoded value lands exactly on an official tier.
  //   74  -> 500/500/340 = 5.00/5.00/3.40, family 31's high/high/low
  //   151 -> 7200, family 33's low
  //   4   -> 12352, inside the Ancient main-stat band 12161-12800. Which main stat it
  //          names is unknown and does not matter: all three score identically.
  // lostark.bible plain-stat lines. Verified against 30 rendered character pages
  // (the page server-renders the bracelet, so stat names and lock icons are ground
  // truth). 3/4/5 are the legacy per-stat schema; 11 is the current class-resolved
  // main-stat line — the SAME physical bracelet reports index 4 in an older loadout
  // snapshot and index 11 in a newer one, so they are one concept.
  var TYPE2_INDEX = {
    3:  { cat: "basic", family: "mainStat", stat: "str" },
    4:  { cat: "basic", family: "mainStat", stat: "dex" },
    5:  { cat: "basic", family: "mainStat", stat: "int" },
    6:  { cat: "basic", family: "vitality" },
    11: { cat: "basic", family: "mainStat" },
    15: { cat: "trait", family: "crit" },
    16: { cat: "trait", family: "spec" },
    17: { cat: "trait", family: "domination" },
    18: { cat: "trait", family: "swiftness" },
    19: { cat: "trait", family: "endurance" },
    20: { cat: "trait", family: "expertise" },
    27: { cat: "special", family: 6 },                 // Max HP
    50: { cat: "special", family: 24, centi: true },   // Additional Damage
    74: { cat: "special", family: 31, centi: true },   // Crit Rate
    76: { cat: "special", family: 32, centi: true },   // Crit Damage
    149:{ cat: "special", family: 8,  centi: true },   // Combat resource recovery
    151:{ cat: "special", family: 33 }                 // Weapon Power
  };
  var GRADE_DIGIT = { 1: "high", 2: "mid", 3: "low" };

  function tierFromValue(familyId, value, grade) {
    var fam = DATA.SPECIAL_BY_ID[familyId];
    if (!fam) return null;
    for (var i = 0; i < DATA.TIERS.length; i++) {
      var t = DATA.TIERS[i];
      if (Math.abs(fam.values[grade][t][0] - value) < 1e-9) return t;
    }
    return null;
  }

  /**
   * decodeBibleBracelet(stats, opts) — lostark.bible's `data.stats` array into
   * model lines.
   *
   *   type 2  plain stat; percentages arrive in hundredths of a % (840 = 8.40%)
   *   type 3  special effect as a stat:    index = 11000    + 10·(family−10) + grade
   *   type 4  special effect as an ability: index = 605100000 + 10·(family−10) + grade
   *   grade digit 1 = high (Legendary), 2 = mid (Epic), 3 = low (Heroic)
   *
   * opts.grade picks the value table; without it inferGrade() decides.
   *
   * A requested grade the payload RULES OUT is not honoured — the decode falls
   * back to the grade that is left and says so in `gradeOverridden`. Callers ask
   * for a grade to TEST it (worker/bracelet.js and bible-import.js both decode
   * against the other grade to see whether it holds the lines better), and the
   * honest answer to "could this be Relic?" for a five-line bracelet is no, not a
   * five-line Relic decode. Without this the test always came back clean, because
   * a type:3 or type:4 line takes its tier from the index and its value from
   * whichever table it is handed — it can never fail to place.
   */
  function decodeBibleBracelet(stats, opts) {
    opts = opts || {};
    var grade = opts.grade, overridden = false;
    if (!grade) grade = inferGrade(stats);
    else if (gradeRuledOut(stats, grade)) {
      var other = grade === "relic" ? "ancient" : "relic";
      // Both ruled out means the payload is a fragment (a one-line test case, a
      // truncated page): there is nothing better to fall back to, so obey.
      if (!gradeRuledOut(stats, other)) { grade = other; overridden = true; }
    }
    var lines = [], unknown = [];
    for (var i = 0; i < stats.length; i++) {
      var st = stats[i], line = null;
      if (st.type === 3 || st.type === 4) {
        var basePt = st.type === 3 ? 11000 : 605100000;
        var off = st.index - basePt;
        var gd = off % 10, n = (off - gd) / 10, fam;
        // Two blocks. n = 1..23 are the damage families 11-33 (family = n + 10);
        // n = 26..35 are the ten utility families 1-10 (family = n - 25). Confirmed
        // against rendered tooltips: 11261 -> n 26 -> family 1 "Atk./Move Speed +6%",
        // 11342 -> n 34 -> family 9 "Movement Skill cooldown -10%".
        if (n >= 26 && n <= 35) fam = n - 25;
        else fam = n + 10;
        var tier = GRADE_DIGIT[gd];
        if (tier && DATA.SPECIAL_BY_ID[fam]) {
          line = { cat: "special", family: fam, tier: tier, value: DATA.SPECIAL_BY_ID[fam].values[grade][tier],
            fixed: !!st.fixed, raw: st.value };
        }
      } else if (st.type === 2) {
        var map = TYPE2_INDEX[st.index];
        if (map) {
          var v = map.centi ? st.value / 100 : st.value;
          if (map.cat === "special") {
            var t2 = tierFromValue(map.family, v, grade);
            line = { cat: "special", family: map.family, tier: t2, value: [v], fixed: !!st.fixed, raw: st.value };
            if (!t2) line.unmatchedValue = true;
          } else {
            line = { cat: map.cat, family: map.family, tier: null, value: v, fixed: !!st.fixed, raw: st.value };
            if (map.stat) line.stat = map.stat;
          }
        }
      }
      if (line) { line.source = { type: st.type, index: st.index }; lines.push(line); }
      else unknown.push({ type: st.type, index: st.index, value: st.value, fixed: !!st.fixed });
    }
    var out = { grade: grade, lines: lines, unknown: unknown };
    if (overridden) out.gradeOverridden = opts.grade;
    return out;
  }

  /** The widest value a grade's own bands allow for a basic family or a trait. */
  function bandSpan(kind, famKey, grade) {
    var bands = kind === "trait" ? DATA.TRAITS.bands : DATA.BASIC.bands;
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < bands.length; i++) {
      var r = kind === "trait" ? bands[i][grade] : bands[i][grade][famKey];
      if (!r) continue;
      if (r[0] < lo) lo = r[0];
      if (r[1] > hi) hi = r[1];
    }
    return [lo, hi];
  }

  /**
   * gradeRuledOut(stats, grade) — is this grade IMPOSSIBLE for this payload?
   *
   * Three hard witnesses, all read straight off the official tables. Each is a
   * fact about the item, not a preference:
   *
   *   LINE COUNT   a bracelet carries 1-2 fixed lines plus its granted slots, and
   *                LINE_COUNTS says Relic grants 1-2 while Ancient grants 2-3. So
   *                Relic tops out at FOUR lines and Ancient at five. A five-line
   *                payload cannot be Relic, whatever else it says. Unlike the
   *                granted-slot count the callers use, this witness survives the
   *                lock icon: a player can lock a granted line and make the
   *                fixed/granted split unreadable, but locking never changes how
   *                many lines the item has.
   *   TRAIT BAND   Relic combat traits run 41-100, Ancient 61-120. Either end
   *                rules a grade out; the callers only ever checked the top.
   *   BASIC BAND   the same for Str/Dex/Int and Vitality, whose bands do not
   *                overlap at the bottom either (Relic main stat starts at 6400,
   *                Ancient at 9600).
   *
   * The special-effect VALUE tables are deliberately not used here: Relic and
   * Ancient are one tier apart on every family (Relic mid = Ancient low), so a
   * value that fits one usually fits the other too. That evidence is a preference,
   * counted in inferGrade, never a ruling.
   */
  function gradeRuledOut(stats, grade) {
    var n = 0, i;
    for (i = 0; i < stats.length; i++) {
      var t = stats[i].type;
      if (t === 2 || t === 3 || t === 4) n++;
    }
    var maxLines = grade === "relic" ? 4 : 5;      // 2 fixed + 2 granted / 2 fixed + 3 granted
    var minLines = grade === "relic" ? 2 : 3;      // 1 fixed + 1 granted / 1 fixed + 2 granted
    if (n > maxLines || n < minLines) return true;

    for (i = 0; i < stats.length; i++) {
      var st = stats[i];
      if (st.type !== 2) continue;
      var map = TYPE2_INDEX[st.index];
      if (!map) continue;
      var v = map.centi ? st.value / 100 : st.value, span = null;
      if (map.cat === "trait") span = bandSpan("trait", null, grade);
      else if (map.cat === "basic") span = bandSpan("basic", map.family, grade);
      if (span && (v < span[0] || v > span[1])) return true;
    }
    return false;
  }

  /**
   * inferGrade(stats) — Relic or Ancient, from the payload alone.
   *
   * A grade the payload RULES OUT loses outright. Among the survivors the
   * special-effect values decide, and when they cannot — because every value sits
   * in the overlap between the two tables, or because the bracelet carries no
   * type:2 special at all — the answer is ANCIENT.
   *
   * That default is the whole point. Reading an Ancient bracelet as Relic scores
   * every special line one tier low (Relic low 4.0 where Ancient low is 4.5), and
   * this function used to do exactly that on any bracelet with no type:2 special
   * line: `bestHits` started at -1, so the first grade in DATA.GRADES — Relic —
   * won with zero evidence, and the `best = "ancient"` initialiser was dead code.
   * Twenty-nine of the fifty-nine seeded characters have no type:2 special; most
   * were rescued downstream by the granted-slot check, but the two that had locked
   * four of five lines were not, and scored 1.2pp low on the board.
   */
  function inferGrade(stats) {
    var grades = DATA.GRADES, live = [], g;
    for (g = 0; g < grades.length; g++) if (!gradeRuledOut(stats, grades[g])) live.push(grades[g]);
    // Every grade ruled out means the payload is malformed or truncated, not that
    // there is no answer: fall back to judging them all rather than returning none.
    if (!live.length) live = grades.slice();
    if (live.length === 1) return live[0];

    var best = "ancient", bestHits = -1;
    for (g = 0; g < live.length; g++) {
      var hits = 0;
      for (var i = 0; i < stats.length; i++) {
        var st = stats[i];
        if (st.type !== 2) continue;
        var map = TYPE2_INDEX[st.index];
        if (!map || map.cat !== "special") continue;
        if (tierFromValue(map.family, map.centi ? st.value / 100 : st.value, live[g])) hits++;
      }
      // Strictly more evidence wins; a tie — and zero-against-zero is a tie —
      // leaves the "ancient" default standing.
      if (hits > bestHits) { bestHits = hits; best = live[g]; }
      else if (hits === bestHits && live[g] === "ancient") best = "ancient";
    }
    return best;
  }

  // ------------------------------------------------------------------

  var API = {
    VERSION: VERSION,
    MODEL_SIG: MODEL_SIG,
    DATA: DATA,
    GEAR: GEAR,
    DEFAULT_PROFILE: DEFAULT_PROFILE,
    ADD_DMG_ASTROGEM_LV60: ADD_DMG_ASTROGEM_LV60,
    MASTER_ADD_DAMAGE: MASTER_ADD_DAMAGE,
    normalizeProfile: normalizeProfile,
    deriveBaseline: deriveBaseline,
    attackPower: attackPower,
    addDamagePool: addDamagePool,
    critFactor: critFactor,
    allyCritFactor: allyCritFactor,
    defShredGain: defShredGain,
    componentMultiplier: componentMultiplier,
    specialMultiplier: specialMultiplier,
    basicBandExpected: basicBandExpected,
    traitBandExpected: traitBandExpected,
    supportBaseAtk: supportBaseAtk,
    supportContribution: supportContribution,
    supportGain: supportGain,
    traitDamage: traitDamage,
    // The pooling layer. jointScore is the honest total for a whole bracelet;
    // the rest are exported so a caller can pool a set of its own.
    jointScore: jointScore,
    emptyContribution: emptyContribution,
    addContribution: addContribution,
    lineContribution: lineContribution,
    specialContribution: specialContribution,
    traitContribution: traitContribution,
    contributionMultiplier: contributionMultiplier,
    contributionDamage: contributionDamage,
    familyGrades: familyGrades,
    FAMILY_GRADE_BANDS: FAMILY_GRADE_BANDS,
    TRAIT_CRIT_PP_PER_POINT: TRAIT_CRIT_PP_PER_POINT,
    lineDamage: lineDamage,
    lineInfo: lineInfo,
    setDamage: setDamage,
    traitFamilyKey: traitFamilyKey,
    damagePercent: damagePercent,
    buildAtoms: buildAtoms,
    buildPool: buildPool,
    solve: solve,
    advise: advise,
    pAtLeast: pAtLeast,
    bruteSolve: bruteSolve,
    decodeBibleBracelet: decodeBibleBracelet,
    TYPE2_INDEX: TYPE2_INDEX
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Bracelet = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
