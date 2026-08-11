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
 * and a bracelet's score is the sum of its line scores. The exact combined
 * figure is damagePercent(D) = (e^(D/100) − 1)·100. This is the same
 * convention as the accessory and astrogem calculators.
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
 * Support role: personal-damage components score 0; the party lines and the
 * ally-buff riders score instead, through simple per-point conversions
 * (allyApBuffDamagePerPct etc.) — a deliberately crude first pass, flagged for
 * calibration.
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

  var VERSION = "0.1.0";
  var MODEL_SIG = "bracelet-v1";

  // ------------------------------------------------------------------
  // Profile
  // ------------------------------------------------------------------

  // Additional-damage from a 60-level astrogem grid: 60 × 0.080667%/level, the
  // loseii astrogem coefficient (bebkok 0.08086, Arsonistic 0.08077 — same thing).
  var ADD_DMG_ASTROGEM_LV60 = 0.0484;
  // T4 combat-trait conversion for Crit: 35 percentage points of crit rate per
  // 699 trait points (Shizu, 2026-08-11). Matches Arsonistic's sheet (0.25/699). Earlier drafts used 35/699 in error; corrected
  // 0.25/699; this is the number that ships.
  var TRAIT_CRIT_PP_PER_POINT = 25 / 699;
  // Fixed order, so JS and Python sum the same floats in the same sequence.
  var TRAIT_KEYS = ["crit", "spec", "swift"];
  // Master node. Arsonistic's sheet reads it as +7% crit rate AND +8.5%
  // additional damage; Shizu's ruling (2026-08-11) is +7% additional damage
  // only, and that is what ships. Do not "fix" without asking him.
  var MASTER_ADD_DAMAGE = 0.07;

  // Rounding convention: the model never floors or rounds. Stats, totals and
  // attack power stay real-valued end to end so JS and Python agree bit for
  // bit; only the UI rounds for display.

  var DEFAULT_PROFILE = {
    role: "dps",                    // "dps" | "support" (support is a stub, DPS-only tool)

    // ---- attack power baseline (see deriveBaseline) ----
    // Raw = before the percentage buckets; the bracelet's flat lines are added
    // to the RAW value and then amplified by the same bucket.
    ilvl: 1785,
    mainStatRaw: 703826,            // 5 armor pieces + accessories + base + roster
    weaponPowerRaw: 241367,         // weapon table value
    msPct: 0.09,                    // 8% skins + 1% stronghold ranch
    wpPct: 0.085,                   // 6% earring WP lines + 2.5% karma
    baseApPct: 0.125,               // 11 × lv9 damage gems (1.0% ea) + 9/7 stone (1.5%)
    flatAP: 2700,                   // ark-grid cores

    // Damage share and crit numbers per skill. critDamage 2.8 = a crit deals 2.8×.
    skills: [{ share: 1, critRate: 0.90, critDamage: 2.8 }],

    // Master node: +7% additional damage (Shizu's ruling).
    master: false,

    // How much the class values the Spec and Swiftness combat traits, in SCORE
    // POINTS per 100 trait points: 0.025 = a 100-point line is worth 2.5 points
    // of damage. Crit has NO weight — it converts exactly (see traitDamage).
    // Key "swift" is the Swiftness trait (DATA calls it "swiftness").
    traitWeights: { spec: 0.025, swift: 0.025 },

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

    // Support-role conversions — STUB, not calibrated. The tool ships DPS-only.
    allyApBuffDamagePerPct: 0.45,
    allyDamageBuffDamagePerPct: 0.30,
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
      if ((k === "addDamage" || k === "traitWeights") && p[k]) {
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
   *       msPct, wpPct, baseApPct, flatAP, rosterBonus, accessoryMainStat,
   *       baseMainStat }
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
    return {
      ilvl: Math.round(ilvlSum / 6),
      armorMainStat: armor,
      mainStatRaw: mainStatRaw,
      weaponPowerRaw: weaponPowerRaw,
      mainStatTotal: mainStatRaw * (1 + msPct),
      weaponPowerTotal: weaponPowerRaw * (1 + wpPct),
      msPct: msPct, wpPct: wpPct,
      baseApPct: o.baseApPct !== undefined ? o.baseApPct : D.baseApPct,
      flatAP: o.flatAP !== undefined ? o.flatAP : D.flatAP
    };
  }

  /**
   * Attack power. AP = sqrt(MStot · WPtot / 6) · (1 + baseApPct) + flatAP.
   * dMsRaw / dWpRaw are bracelet-line additions to the RAW stat, so they are
   * amplified by the percentage buckets exactly as gear stats are.
   */
  function attackPower(profile, dMsRaw, dWpRaw) {
    var ms = (profile.mainStatRaw + (dMsRaw || 0)) * (1 + profile.msPct);
    var wp = (profile.weaponPowerRaw + (dWpRaw || 0)) * (1 + profile.wpPct);
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
      if (cr > 1) cr = 1;
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
    var n = profile.allyDpsCount;
    if (profile.role === "support") return 1 + n * allyGain;   // a support's own damage is ignored
    return 1 + selfGain + n * allyGain;
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
        if (!dps) return 1;
        return attackPower(profile, 0, x) / attackPower(profile, 0, 0);

      case "mainStat":
        if (!dps) return 1;
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
          var sk = skills[i], cr = Math.min(1, (sk.critRate || 0)), cd = sk.critDamage;
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
      case "allyApBuff":
        return dps ? 1 : 1 + x * profile.allyApBuffDamagePerPct / 100;
      case "allyDamageBuff":
        return dps ? 1 : 1 + x * profile.allyDamageBuffDamagePerPct / 100;
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
  // per skill  1 + cr'·(cd'·(1+chd) − 1),  cr' capped at 1.
  function critFactorFull(profile, dcr, dcd, chd) {
    var skills = profile.skills, tot = 0, wsum = 0;
    for (var i = 0; i < skills.length; i++) {
      var sk = skills[i];
      var cr = Math.min(1, Math.max(0, (sk.critRate || 0) + dcr));
      var cd = (sk.critDamage || 0) + dcd;
      tot += (sk.share || 0) * (1 + cr * (cd * (1 + chd) - 1));
      wsum += (sk.share || 0);
    }
    return wsum > 0 ? tot / wsum : 0;
  }

  /**
   * Multiplier of one special family at one tier.
   *
   * The crit components of a line (crit rate, crit damage, the "+1.5% on crit"
   * rider) are resolved together in one crit factor, because they genuinely
   * interact inside a single hit. Different LINES still combine additively in
   * log space — the house convention.
   */
  function specialMultiplier(family, tier, grade, profile) {
    var vals = family.values[grade][tier], m = 1;
    var dcr = 0, dcd = 0, chd = 0, anyCrit = false;
    for (var i = 0; i < family.comp.length; i++) {
      var c = family.comp[i];
      var x = (c.v !== undefined) ? c.v : vals[c.from];
      if (c.scaleKey) x = x * profile[c.scaleKey];
      if (profile.role !== "support" && (c.k === "critRate" || c.k === "critDamage" || c.k === "onCritDamage")) {
        anyCrit = true;
        if (c.k === "critRate") dcr += x / 100;
        else if (c.k === "critDamage") dcd += x / 100;
        else chd += x / 100;
        continue;
      }
      m *= componentMultiplier(c.k, x, profile, c);
    }
    if (anyCrit) m *= critFactorFull(profile, dcr, dcd, chd) / critFactorFull(profile, 0, 0, 0);
    return m;
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
    if (line.cat === "trait") return 0;
    if (line.cat === "basic") {
      if (line.family !== "mainStat") return 0;                 // vitality is dead weight
      var v = (line.value !== undefined && line.value !== null) ? line.value : basicBandExpected("mainStat", grade);
      return toD(componentMultiplier("mainStat", v, profile));
    }
    var fam = resolveSpecial(line.family);
    if (!fam) return 0;
    // A tier the family's table for THIS grade does not carry. Reachable from a
    // decode that landed on the wrong grade — Crit Damage +10% exists on Ancient
    // and not on Relic, so the Relic table has no tier for it. Score it zero and
    // let the caller's `unmatchedValue` flag do the complaining; a thrown error
    // here takes a whole import down over one line.
    if (!fam.values[grade] || !fam.values[grade][line.tier]) return 0;
    return toD(specialMultiplier(fam, line.tier, grade, profile));
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

  /**
   * traitDamage(traits, profile) -> D, the score of the bracelet's two FIXED
   * combat-trait lines.
   *
   * traits = { crit, spec, swift } in trait points; an inactive trait is 0.
   *
   *   Crit   converts exactly: 25 pp of crit rate per 699 trait points, fed
   *          through the per-skill crit model additively with every other
   *          crit-rate source and capped at 100% — the same path granted
   *          family 31 takes. So it is worth less to a class already near cap.
   *   Spec   scored by the class's own weight, in points per 100 trait points.
   *   Swift  likewise.
   *
   * Fixed lines never reroll, so this is a CONSTANT offset on every state the
   * solver can reach. It is added once, into solve()'s fixedDamage, and never
   * enters the DP alphabet — a trait rolled into a GRANTED slot still scores 0.
   */
  function traitDamage(traits, profile) {
    profile = profile && profile.role ? profile : normalizeProfile(profile);
    traits = traits || {};
    // The decoder names the trait with the official family key ("swiftness"); the
    // profile deck writes the short one ("swift"). They must mean the same thing or
    // a Swiftness bracelet silently scores zero for that line — which is exactly
    // what happened until 2026-08-11. Accept either spelling on both sides.
    var w = profile.traitWeights || {}, s = 0, i, k, v;
    function alias(o, key) {
      if (o[key] !== undefined && o[key] !== null) return o[key];
      if (key === "swift" && o.swiftness !== undefined) return o.swiftness;
      if (key === "swiftness" && o.swift !== undefined) return o.swift;
      return 0;
    }
    for (i = 0; i < TRAIT_KEYS.length; i++) {
      k = TRAIT_KEYS[i];
      v = alias(traits, k) || 0;
      if (!v) continue;
      if (k === "crit") {
        if (profile.role === "support") continue;      // crit is a DPS number
        var dcr = v * TRAIT_CRIT_PP_PER_POINT / 100;
        s += toD(critFactor(profile, dcr, 0) / critFactor(profile, 0, 0));
      } else {
        s += v * (alias(w, k) || 0);
      }
    }
    return s;
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
  function familyGrades(grade) {
    grade = grade || "ancient";
    var P = normalizeProfile({});
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

  /** Sum of line damages (additive in log space). */
  function setDamage(lines, grade, profile) {
    profile = normalizeProfile(profile);
    var s = 0;
    for (var i = 0; i < lines.length; i++) s += lineDamage(lines[i], grade, profile);
    return s;
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
   * options.basicMode: "bands" (default, one atom per value band) | "expected".
   */
  function buildAtoms(grade, profile, options) {
    options = options || {};
    var basicMode = options.basicMode || "bands";
    var atoms = [];
    var catW = DATA.CATEGORY_WEIGHTS;

    function push(a) { a.idx = atoms.length; atoms.push(a); }

    // --- basic ---
    var basicFamW = catW.basic * 0.5;    // 17.5 each, mainStat / vitality
    if (basicMode === "expected") {
      var ev = basicBandExpected("mainStat", grade);
      push({ key: "basic:mainStat", cat: "basic", family: "basic:mainStat", tier: null, band: null,
        weight: basicFamW, value: ev, label: "Str / Dex / Int",
        damage: toD(componentMultiplier("mainStat", ev, profile)) });
    } else {
      for (var b = 0; b < DATA.BASIC.bands.length; b++) {
        var bd = DATA.BASIC.bands[b], mv = bandMid(bd[grade].mainStat);
        push({ key: "basic:mainStat:b" + b, cat: "basic", family: "basic:mainStat", tier: null, band: b,
          weight: basicFamW * bd.prob / 100, value: mv,
          label: "Str / Dex / Int " + bd[grade].mainStat[0] + "–" + bd[grade].mainStat[1],
          damage: toD(componentMultiplier("mainStat", mv, profile)) });
      }
    }
    push({ key: "basic:vitality", cat: "basic", family: "basic:vitality", tier: null, band: null,
      weight: basicFamW, value: basicBandExpected("vitality", grade), label: "Vitality", damage: 0 });

    // --- combat traits: six families, all 0 damage ---
    var traitEv = traitBandExpected(grade);
    for (var t = 0; t < DATA.TRAITS.families.length; t++) {
      var tf = DATA.TRAITS.families[t];
      push({ key: "trait:" + tf.key, cat: "trait", family: "trait:" + tf.key, tier: null, band: null,
        weight: catW.trait / DATA.TRAITS.families.length, value: traitEv, label: tf.label, damage: 0 });
    }

    // --- specials: 30% split by the listed table, renormalised by its own sum ---
    var sum = DATA.GRANTED_LISTED_SUM;
    for (var f = 0; f < DATA.SPECIALS.length; f++) {
      var fam = DATA.SPECIALS[f];
      var dmg = [], famW = 0, any = false;
      for (var ti = 0; ti < DATA.TIERS.length; ti++) {
        var tier = DATA.TIERS[ti];
        var d = toD(specialMultiplier(fam, tier, grade, profile));
        if (Math.abs(d) > 1e-12) any = true;
        dmg.push(d);
        famW += catW.special * fam.granted[tier] / sum;
      }
      if (!any) {
        // Dead family for this profile: one atom, the family's whole weight.
        push({ key: "special:" + fam.id, cat: "special", family: "special:" + fam.id, tier: null, band: null,
          weight: famW, value: null, label: fam.label, damage: 0 });
      } else {
        for (var ti2 = 0; ti2 < DATA.TIERS.length; ti2++) {
          var tr = DATA.TIERS[ti2];
          push({ key: "special:" + fam.id + ":" + tr, cat: "special", family: "special:" + fam.id, tier: tr, band: null,
            weight: catW.special * fam.granted[tr] / sum, value: fam.values[grade][tr],
            label: fam.label + " (" + tr + ")", damage: dmg[ti2] });
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
        list.push({ key: k, cat: atoms[i].cat, damage: atoms[i].damage, junk: atoms[i].junk,
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
   *   options: { basicMode, allowLockJunk, testPool, maxStates }
   * }
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
    var sa = makeStateAtoms(atoms);
    var stateAtoms = sa.list;

    var fixedLines = opts.fixedLines || [];
    var grantedLines = opts.grantedLines || [];
    var slots = opts.slots || grantedLines.length || 2;
    var codec = makeCodec(stateAtoms.length, slots);

    var fixedPresent = {}, i, j;
    for (i = 0; i < fixedLines.length; i++) fixedPresent[lineFamilyId(fixedLines[i])] = true;
    var fixedCounts = countCats(fixedLines);
    // The bracelet's two fixed combat traits are a constant on every reachable
    // state, so they ride along inside fixedDamage and never reach the DP.
    var traitBonus = traitDamage(opts.traitValues, profile);
    var fixedDamage = setDamage(fixedLines, grade, profile) + traitBonus;

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
      var sc = fixedDamage;
      for (j = 0; j < pc.length; j++) sc += stateAtoms[pc[j]].damage;
      score[code] = sc;

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
      valueGold: (expectedFinal - baselinePct) * goldPer1Pct,
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

  /** Turn a hand-written test pool into the atom shape the solver expects. */
  function normalizeTestPool(pool) {
    var atoms = [];
    for (var i = 0; i < pool.length; i++) {
      var p = pool[i];
      atoms.push({
        idx: i, key: p.key, cat: p.cat || "special", family: p.family || ("test:" + p.key),
        tier: p.tier || null, band: null, weight: p.weight, value: p.value || null,
        label: p.label || p.key, damage: p.damage || 0
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
    var fixedDamage = setDamage(fixedLines, grade, profile) + traitDamage(opts.traitValues, profile);

    var startPieces = [];
    var grantedLines = opts.grantedLines || [];
    for (i = 0; i < grantedLines.length; i++) {
      var a = matchAtom(atoms, grantedLines[i], grade);
      if (a) startPieces.push(a.stateIdx);
    }
    var R = opts.rollsLeft !== undefined ? opts.rollsLeft
      : ((opts.rolls && opts.rolls.normal !== undefined ? opts.rolls.normal : 0) +
         (opts.rolls && opts.rolls.ticket !== undefined ? opts.rolls.ticket : 0));

    function scoreOf(pc) { var s = fixedDamage; for (var k = 0; k < pc.length; k++) s += stateAtoms[pc[k]].damage; return s; }
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
   * opts.grade picks the value table; without it both grades are tried and the
   * one matching more values wins.
   */
  function decodeBibleBracelet(stats, opts) {
    opts = opts || {};
    var grade = opts.grade;
    if (!grade) grade = inferGrade(stats);
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
    return { grade: grade, lines: lines, unknown: unknown };
  }

  function inferGrade(stats) {
    var best = "ancient", bestHits = -1;
    var grades = DATA.GRADES;
    for (var g = 0; g < grades.length; g++) {
      var hits = 0;
      for (var i = 0; i < stats.length; i++) {
        var st = stats[i];
        if (st.type !== 2) continue;
        var map = TYPE2_INDEX[st.index];
        if (!map || map.cat !== "special") continue;
        if (tierFromValue(map.family, map.centi ? st.value / 100 : st.value, grades[g])) hits++;
      }
      if (hits > bestHits) { bestHits = hits; best = grades[g]; }
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
    traitDamage: traitDamage,
    familyGrades: familyGrades,
    FAMILY_GRADE_BANDS: FAMILY_GRADE_BANDS,
    TRAIT_CRIT_PP_PER_POINT: TRAIT_CRIT_PP_PER_POINT,
    lineDamage: lineDamage,
    lineInfo: lineInfo,
    setDamage: setDamage,
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
