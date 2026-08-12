/**
 * profile.js — the character + bracelet state, and the control deck that edits it.
 *
 * This is the spine every tab drives, in the same shape as favorites.js: one
 * versioned localStorage key, one in-memory copy, subscribers notified after every
 * change. It was carved out of app.js on 2026-08-11 so the Tier List could mount the
 * SAME control deck the Calculator uses and watch its table move as a slider drags.
 *
 * Public API (window.Profile):
 *   get()              -> the live state object (grade, slots, rows, gear, kit, fight,
 *                         traits, skills, econ, adv, …). LIVE, not a copy: the object
 *                         identity never changes, not even across reset(), so a module
 *                         may hold the reference forever. Read it freely; write through
 *                         set(), or mutate and call save() (nothing is notified then).
 *   profile()          -> the model's view of that state: Bracelet.normalizeProfile(...).
 *                         The ONE profile every tab scores on — there is no second.
 *   set(patch)         -> merge (one level deep for the nested blocks), persist, notify
 *   mount(hostEl)      -> put the control deck inside hostEl and render it
 *   onChange(cb)       -> unsubscribe fn; cb(detail) after every change the deck makes
 *   reset()            -> back to defaults, wiping the stored state
 *   resetCharacter()   -> the gear / accessory / fight / skill / economy half only
 *   resetBracelet()    -> the granted rows, fixed lines, locks, rolls and traits only
 *   importCharacterStats()
 *                      -> "Import Character Stats": fill the WHOLE left column from
 *                         the loaded character's lostark.bible page. Pressed, never
 *                         automatic — loading someone fills the bracelet and the
 *                         banner, and leaves the settings at our defaults.
 *
 * ONE DECK, RE-PARENTED — the multi-mount decision.
 * Every control in the deck carries a stable id derived from its state path
 * (bc-fld-gear-head, its chip, its label's `for`), and focus restoration, the
 * mid-drag chip repaint and the derived read-outs all find their element by that id.
 * Two live instances would mean two elements per id, so `$()` would repaint the wrong
 * one — the fix would be prefixing every id and re-rendering both decks on every
 * keystroke, a large change to code that has to behave EXACTLY as it did before.
 * So there is exactly one deck element, and `mount()` MOVES it into the host you
 * name (appendChild on a node already in the document re-parents it, keeping its
 * listeners and its state). Only one tab is ever visible, so a tab claims the deck by
 * calling mount() when it is activated. That is the whole protocol.
 *
 * PROVENANCE. Values that came from a character page are marked: their label turns
 * accent-coloured and says "auto-set from <Name>", and a strip above the deck counts
 * them. Editing a field clears its marker for good and the count drops — after that
 * the label reads "<Name> suggests +21" instead, the honest downgrade astrogem's
 * gold-per-damage note makes. Nothing is imported silently.
 * Each mark can also carry a NOTE — what the page actually said, in words — because
 * three of these controls cannot hold the page's reading exactly: the necklace and
 * earring pills are four-way, and one gem slider stands in for eleven gems. So the
 * tooltip says "read 2.60% from the neck" or "gems are 10,10,9,… — set to 10", and
 * the user can disagree with a number they can see.
 *
 * COLLAPSED FIRST. The deck's body starts shut, on every tab that mounts it: the
 * score and the table under it are what a visitor came for. The open/shut choice is
 * part of the saved state, so it sticks after the first click.
 *
 * TWO RESETS, NEITHER OF WHICH ASKS. "Reset character" clears gear, accessories,
 * gems, the two nodes, fight, skills and economy; "Reset bracelet" (adopted into
 * app.js's Grader panel header) clears the rows, locks, rolls and traits. Each
 * leaves the other alone, and neither opens a confirm box for an action that is one
 * click from being undone.
 *
 * THE MATH IS NOT HERE either: profile() is a normalizeProfile call over the state,
 * and every derived number (item level, the two percentage buckets, the trait
 * contribution) is arithmetic over the official tables in data/.
 */
(function () {
  "use strict";

  var B = window.Bracelet, DATA = window.BraceletData;
  if (!B || !DATA) return;                       // model failed to load; leave the shell alone

  var LS_KEY = "loa-bracelet-calc.v1";           // the key app.js used; a v2 blob still loads

  // ------------------------------------------------------------------
  // small helpers (duplicated in app.js — three lines each, no module system)
  // ------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fx(v, n) { return (Math.round(v * Math.pow(10, n)) / Math.pow(10, n)).toFixed(n); }
  function gold(g) {
    var a = Math.abs(g);
    if (a >= 1e6) return (g / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return Math.round(g / 1e3) + "k";
    return String(Math.round(g));
  }
  function getPath(o, p) { var a = p.split("."), t = o, i; for (i = 0; i < a.length; i++) t = t[a[i]]; return t; }
  function setPath(o, p, v) { var a = p.split("."), t = o, i; for (i = 0; i < a.length - 1; i++) t = t[a[i]]; t[a[a.length - 1]] = v; }

  // ------------------------------------------------------------------
  // state
  // ------------------------------------------------------------------

  function blankRow() { return { fam: "none", tier: "mid", value: null }; }

  function defaults() {
    return {
      v: 2,
      grade: "ancient",
      slots: 3,
      rollsLeft: 7,
      rollsTotal: 7,                 // what a FRESH bracelet gets — drives the "unrolled" price
      useOverride: false,
      // One honing level per piece — six sliders, the weapon alone driving WP.
      gear: { weapon: 25, head: 21, shoulder: 21, chest: 21, pants: 21, gloves: 23 },
      ov: { mainStatRaw: 703826, weaponPowerRaw: 241367 },
      // Accessories, gems and the two on/off nodes. wpPct and baseApPct are
      // DERIVED from these (see wpPctOf / baseApPctOf), not stored.
      kit: { neck: 2.6, ear1: 3, ear2: 3, gems: 9, stone: true, master: false },
      // Where the damage lands, how the cooldown line is judged, and what the
      // class pays for a Spec / Swiftness trait line (points per 100 points).
      fight: { back: 100, front: 100, nonDir: 100, cdWeight: 70, demon: false, supportEffects: true, wSpec: 2.5, wSwift: 2.5 },
      // The bracelet's two FIXED combat traits. A real bracelet carries exactly
      // two, but the panel no longer polices it: a third can be switched on and
      // the score keeps counting it, with a warning that the state is illegal
      // in game (Shizu, 2026-08-11 — the silent auto-off was worse).
      traits: { crit: { on: true, v: 120 }, spec: { on: true, v: 120 }, swift: { on: false, v: 120 } },
      adv: {
        msPct: 9, karmaWp: 2.5, baseApOverride: false, baseApPct: 12.5, flatAP: 2700,
        accessoryMainStat: 71429, rosterBonus: 2085,
        addWeapon: 30, addPet: 1, addAstrogem: 4.84,
        staggerShare: 10, demonBase: 7.3, shieldUptime: 60, enemyDR: 50,
        allyCount: 2, atkSpeedPer10: 1
      },
      skills: [{ name: "", share: 100, cr: 90, cd: 280 }],
      // gpd and baseline both get SEEDED from an imported character (see seedEcon):
      // the gold rate off combat power, the baseline off the bracelet they wear.
      // The two *AutoKey fields hold the character key each was seeded for, so a
      // seed happens once per character and never lands on top of a hand-picked
      // number.
      econ: { gpd: 1500000, baseline: 0, gpdAutoKey: null, baseAutoKey: null },
      rows: [blankRow(), blankRow(), blankRow()],
      fixedRows: [],
      advOpen: false,
      locks: null,                   // per-slot booleans in the cut flow; null = follow the model
      rolled: null,                  // per-slot rows entered in the cut flow
      history: [],
      deckOpen: false,               // the deck starts COLLAPSED; the results come first
      // ---- import provenance (see the header) ----
      char: null,                    // { name, region, class, itemLevel, source, pulledAt, cached }
      prov: {},                      // state path -> the character name it came from, while untouched
      provWas: {},                   // state path -> the value that character suggested, kept after
      provNote: {}                   // state path -> what the page ACTUALLY said, in words
    };
  }

  // The nested blocks are merged key by key, so a stored blob written before a
  // field existed still gets that field's default.
  var NESTED = { adv: 1, gear: 1, ov: 1, econ: 1, kit: 1, fight: 1, traits: 1 };

  // Per-gem base attack power by gem level; eleven of them plus a 9/7 stone.
  var GEM_AP = { 6: 0.4, 7: 0.6, 8: 0.8, 9: 1.0, 10: 1.2 };
  var STONE_AP = 1.5;
  // Slider order, Shizu's: armour first, the weapon last because it is the one
  // piece that moves weapon power.
  var PIECES = [["head", "Head"], ["shoulder", "Shoulder"], ["chest", "Chest"],
    ["pants", "Pants"], ["gloves", "Gloves"], ["weapon", "Weapon"]];

  var TRAIT_KEYS = ["crit", "spec", "swift"];
  var TRAIT_LABELS = { crit: "Crit", spec: "Spec", swift: "Swiftness" };

  // The astrogem calculator's rank palette, so a letter reads the same across the
  // two tools. D and F share the grey, as they do there.
  var GRADE_COLOR = { S: "#cc5c81", A: "#7e5cc0", B: "#3b7fd0", C: "#4f9d5d", D: "#6f747a", F: "#6f747a" };
  var JUNK = "junk";                             // the granted picker's one zero-damage option

  // The single state object. Its identity NEVER changes — load() and reset() copy
  // into it — so every module can hold the reference `Profile.get()` returned.
  var S = defaults();

  function assignInto(target, src) {
    var k;
    for (k in target) if (Object.prototype.hasOwnProperty.call(target, k)) delete target[k];
    for (k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    return target;
  }

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* private mode */ }
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { return; }
    if (!raw) return;
    var got;
    try { got = JSON.parse(raw); } catch (e) { return; }
    // v2 reshaped the panel (per-piece honing, accessory/gem controls, fight
    // and trait blocks), so a v1 blob has nothing worth migrating: start clean.
    if (!got || got.v !== 2) return;
    var d = defaults(), k;
    for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) {
      if (got[k] === undefined || got[k] === null) continue;
      if (NESTED[k]) {
        for (var a in d[k]) if (got[k][a] !== undefined && got[k][a] !== null) d[k][a] = got[k][a];
      } else {
        d[k] = got[k];
      }
    }
    assignInto(S, d);
  }

  // Slot count and grade drive how many rows exist and which are legal.
  function slotChoices() { return S.grade === "relic" ? [1, 2] : [2, 3]; }

  function fitRows() {
    var ch = slotChoices();
    if (ch.indexOf(S.slots) === -1) S.slots = ch[ch.length - 1];
    while (S.rows.length < S.slots) S.rows.push(blankRow());
    S.rows.length = S.slots;
    if (S.fixedRows.length > 2) S.fixedRows.length = 2;
    S.rollsLeft = clamp(Math.round(S.rollsLeft), 0, 20);
    S.rollsTotal = clamp(Math.round(S.rollsTotal), 0, 20);
    if (!S.skills.length) S.skills = [{ name: "", share: 100, cr: 90, cd: 280 }];
    if (!S.prov) S.prov = {};
    if (!S.provWas) S.provWas = {};
    if (!S.provNote) S.provNote = {};
    normalizeShares();
    fitTraits();
    migrateJunkRows();
  }

  /**
   * Every trait value inside the grade's band, so a Relic bracelet can never
   * show an Ancient-only 120. Called on load and whenever the grade moves.
   *
   * It no longer forces exactly two active. Three combat traits is illegal in
   * game, but the panel says so rather than switching one off behind the
   * user's back, and the score counts whatever is on.
   */
  function fitTraits() {
    var band = traitBand(), i, k;
    for (i = 0; i < TRAIT_KEYS.length; i++) {
      k = TRAIT_KEYS[i];
      if (!S.traits[k]) S.traits[k] = { on: false, v: band[1] };
      S.traits[k].v = clamp(Math.round(num(S.traits[k].v, band[1])), band[0], band[1]);
    }
    delete S.traitOrder;                                 // the old eviction queue, no longer used
  }

  // ---- family letters, and the "Junk Line" collapse they drive ----
  //
  // The letters come from the canonical default profile (Bracelet.familyGrades), so
  // they label the family rather than the current build and never shuffle mid-edit.
  // They live here because fitRows has to rewrite rows saved before the collapse
  // existed, and because the Tier List reads the same letters the picker shows.
  var famGradeCache = {};
  function famGrades(grade) {
    if (!famGradeCache[grade]) famGradeCache[grade] = B.familyGrades(grade);
    return famGradeCache[grade];
  }

  /** The letter the picker shows for a stored family value. */
  function letterOf(val, grade) {
    if (!val || val === "none") return null;
    if (val === JUNK) return "F";
    var fg = famGrades(grade);
    if (val.indexOf("basic:") === 0) return (fg.basic[val.slice(6)] || {}).letter || "F";
    if (val.indexOf("trait:") === 0) return (fg.trait[val.slice(6)] || {}).letter || "F";
    if (val.indexOf("sp:") === 0) return (fg.special[Number(val.slice(3))] || {}).letter || "F";
    return null;
  }

  /** True for a stored family value the granted picker now folds into JUNK. */
  function isJunkFam(val, grade) {
    if (!val || val === "none" || val === JUNK) return false;
    return letterOf(val, grade) === "F";
  }

  /** Rewrite granted / rolled rows saved before the collapse existed. */
  function migrateJunkRows() {
    var sets = [S.rows, S.rolled], s, i, rows;
    for (s = 0; s < sets.length; s++) {
      rows = sets[s];
      if (!rows) continue;
      for (i = 0; i < rows.length; i++) {
        if (rows[i] && isJunkFam(rows[i].fam, S.grade)) { rows[i].fam = JUNK; rows[i].value = null; }
      }
    }
  }

  // ------------------------------------------------------------------
  // derived numbers
  // ------------------------------------------------------------------

  /** Weapon-power % bucket = the two earring lines + karma. */
  function wpPctOf() { return num(S.kit.ear1, 0) + num(S.kit.ear2, 0) + num(S.adv.karmaWp, 0); }
  /** Attack-power % bucket = eleven gems at their level + the ability stone. */
  function baseApPctOf() {
    if (S.adv.baseApOverride) return num(S.adv.baseApPct, 0);
    var per = GEM_AP[Math.round(num(S.kit.gems, 9))] || 0;
    return 11 * per + (S.kit.stone ? STONE_AP : 0);
  }
  /** The official starting-value band, which moves with the grade. */
  function traitBand() { return S.grade === "relic" ? [41, 100] : [61, 120]; }
  /** What the model scores: an inactive trait contributes nothing. */
  function traitValues() {
    var out = {}, i, k;
    for (i = 0; i < TRAIT_KEYS.length; i++) {
      k = TRAIT_KEYS[i];
      out[k] = S.traits[k].on ? num(S.traits[k].v, 0) : 0;
    }
    return out;
  }
  /** Weights are typed as % damage per 100 trait points; the model wants points. */
  function traitWeights() {
    return { spec: num(S.fight.wSpec, 0) / 100, swift: num(S.fight.wSwift, 0) / 100 };
  }
  /** How many combat traits are switched on right now. Two is the legal count. */
  function traitOnCount() {
    var n = 0, i;
    for (i = 0; i < TRAIT_KEYS.length; i++) if (S.traits[TRAIT_KEYS[i]].on) n++;
    return n;
  }

  /** The live item level: the mean of the six piece item levels, unrounded. */
  function ilvlExact() {
    var G = window.BraceletGearData, s = 0, i;
    if (!G) return 0;
    for (i = 0; i < PIECES.length; i++) s += G.ILVL0 + G.ILVL_STEP * num(S.gear[PIECES[i][0]], 0);
    return s / 6;
  }

  function pieceLevels() {
    var g = S.gear, o = {}, i;
    for (i = 0; i < PIECES.length; i++) o[PIECES[i][0]] = clamp(Math.round(num(g[PIECES[i][0]], 0)), 0, 25);
    return o;
  }

  function baseStats() {
    if (S.useOverride) {
      return { mainStatRaw: num(S.ov.mainStatRaw, 703826), weaponPowerRaw: num(S.ov.weaponPowerRaw, 241367), ilvl: null };
    }
    var a = S.adv;
    return B.deriveBaseline({
      pieceLevels: pieceLevels(),
      msPct: a.msPct / 100, wpPct: wpPctOf() / 100, baseApPct: baseApPctOf() / 100, flatAP: a.flatAP,
      accessoryMainStat: a.accessoryMainStat, rosterBonus: a.rosterBonus
    });
  }

  function buildProfile() {
    var a = S.adv, base = baseStats(), sk = [], i;
    for (i = 0; i < S.skills.length; i++) {
      var s = S.skills[i];
      sk.push({ share: num(s.share, 0) / 100, critRate: num(s.cr, 0) / 100, critDamage: num(s.cd, 0) / 100 });
    }
    // Through normalizeProfile, never as a bare object: the model reads fields
    // this panel does not expose (wpStacks20, wpUptime21, wpStacks22, the ally
    // crit numbers), and a missing one turns a whole family's score into NaN or,
    // worse, silently into zero.
    return B.normalizeProfile({
      role: "dps",
      ilvl: base.ilvl || 0,
      mainStatRaw: base.mainStatRaw,
      weaponPowerRaw: base.weaponPowerRaw,
      msPct: a.msPct / 100, wpPct: wpPctOf() / 100, baseApPct: baseApPctOf() / 100, flatAP: a.flatAP,
      skills: sk,
      master: !!S.kit.master,
      traitWeights: traitWeights(),
      addDamage: {
        weaponQuality: a.addWeapon / 100, pet: a.addPet / 100,
        astrogemLv60: a.addAstrogem / 100, neck: num(S.kit.neck, 0) / 100
      },
      backAttackShare: S.fight.back / 100,
      frontAttackShare: S.fight.front / 100,
      nonDirectionalShare: S.fight.nonDir / 100,
      staggeredShare: a.staggerShare / 100,
      demonShare: S.fight.demon ? 1 : 0,
      // The deck's switch and the model's flag are OPPOSITES, and saying so here
      // is cheaper than a bug: `fight.supportEffects` means "count the four party
      // lines", while the model's `supportHasEffects` means "the party's support
      // already brings them, so a copy on your bracelet is worth nothing".
      supportHasEffects: !S.fight.supportEffects,
      demonBase: a.demonBase / 100,
      shieldUptime: a.shieldUptime / 100,
      allyDpsCount: a.allyCount,
      allyCritRate: 0.90, allyCritDamage: 2.8,
      enemyBaseDR: a.enemyDR / 100,
      cooldownPenaltyWeight: S.fight.cdWeight / 100,
      // Families 20/21/22 are hard assumptions now (max stacks, full uptime);
      // leaving them out lets the model's own defaults stand.
      //
      // Attack speed pays off through extra casts and is scored: Shizu's rule is
      // 10% speed = 1% damage. This used to hard-code 0, which silently zeroed
      // families 1 and 20's speed component for the LIVE profile while the ghost
      // markers (canonical default) still counted it — the rows looked wrong and
      // the tick moved. The deck's own slider is per TEN percent, so divide by 10.
      atkMoveSpeedDamagePerPct: (a.atkSpeedPer10 == null ? 1 : a.atkSpeedPer10) / 10
    });
  }

  // ------------------------------------------------------------------
  // the character's two buttons
  //
  // There is ONE profile: whatever the deck holds. The Calculator, the Advisor
  // and the Tier List all score on it, and Profile.profile() is the single
  // answer. The scoring toggle that used to live here — default settings vs
  // character settings, with its own key in localStorage — is gone (Shizu,
  // 2026-08-12). Two ways to read the same screen is one way too many: every
  // number on it had to be captioned with which profile it was on, and every
  // tab had to remember to ask.
  //
  // What replaces it is a deck that ALWAYS STARTS AT OUR DEFAULTS, plus two
  // buttons the user presses when they mean it:
  //
  //   Import Character Stats   overwrite the left column with what the
  //                            character page actually says — honing per piece,
  //                            the neck, both earrings, the gem level, the 9/7
  //                            stone and Master. Every value lands marked and
  //                            editable, exactly as an import always did.
  //   Reset to Default         the left column back to the calculator's own
  //                            defaults. The character stays loaded and the
  //                            bracelet is not touched.
  //
  // So loading a character fills the BRACELET and the banner and nothing else.
  // The board ranks everyone on the canonical defaults, so a freshly loaded
  // character shows the number the board shows it until the user asks for their
  // own gear — and asking is one click.
  // ------------------------------------------------------------------

  function hasCharacter() { return !!(S.char && S.char.name); }

  /** Is there anything on this record to import? */
  function canImportStats() {
    var c = S.char;
    return !!(c && c.name && (c.profile || c.itemLevel != null));
  }

  /**
   * ROW 3 of the character header: the two buttons.
   *
   * Rendered by EVERY tab from here so the wording cannot drift apart, and the
   * clicks are caught by one delegated listener on the document, so there are no
   * ids to collide when two panes each hold a copy.
   *
   * Returns "" with no character loaded: the banner is hidden then, and the
   * deck's own "Reset to defaults" button covers that state.
   *
   * The dead half of the pair is aria-disabled rather than disabled, because a
   * disabled button fires no mouse events and would swallow the tooltip that
   * says WHY it is dead.
   */
  function charControlsHtml() {
    if (!hasCharacter()) return "";
    var who = esc(S.char.name), can = canImportStats();
    var h = '<div class="bc-ctlrow">';
    h += '<button type="button" class="mbtn"' + (can ? "" : ' aria-disabled="true"') +
      ' data-bcimport="1" data-gloss="' + (can
        ? "Overwrite the left column with what " + who + "'s character page says: the six honing levels, the " +
          "necklace's additional damage, both earrings' weapon power, the gem level, the 9/7 stone and Master. " +
          "Each value lands marked and editable, and editing one drops its mark. The bracelet is not touched."
        : "Nothing to import: this record carries no gear from " + who +
          "'s character page. Re-pull them and the button comes back.") +
      '">Import Character Stats</button>';
    h += '<button type="button" class="mbtn" data-bcreset="defaults"' +
      ' data-gloss="Puts the settings back to the calculator\'s defaults — gear, accessories, gems and the two' +
      ' nodes on the left, the fight, trait, skill and economy settings on the right. ' + who +
      ' stays loaded, and the bracelet — its lines, its traits, its grade, its slots and its padlocks — is left' +
      ' exactly as it is.">Reset to Default</button>';
    return h + "</div>";
  }

  /** How many values a character page ever suggested — the provenance strip needs it. */
  function provWasCount() {
    var n = 0, k;
    for (k in S.provWas) if (Object.prototype.hasOwnProperty.call(S.provWas, k)) n++;
    return n;
  }

  // One listener for every copy of the row, on the document, because the
  // Calculator's banner, the Advisor's header and the Tier List's control row
  // are three different panes and any of them may be rebuilt at any moment.
  document.addEventListener("click", function (e) {
    var t = e.target, btn;
    if (!t || !t.closest) return;
    if ((btn = t.closest("[data-bcimport]"))) {
      e.stopPropagation();                     // the banner behind it reloads the character on click
      if (btn.getAttribute("aria-disabled") !== "true") importCharacterStats();
      return;
    }
    if ((btn = t.closest("[data-bcreset]"))) {
      e.stopPropagation();
      resetCharacter();
    }
  });

  // ---- skill shares: always exactly 100 ----

  /**
   * Split `total` across `weights` as integers, largest remainder first. All
   * weights zero means share it equally.
   */
  function distribute(weights, total) {
    var n = weights.length, i, sum = 0, w = [];
    for (i = 0; i < n; i++) { w.push(Math.max(0, num(weights[i], 0))); sum += w[i]; }
    if (!n) return [];
    if (sum <= 0) { for (i = 0; i < n; i++) w[i] = 1; sum = n; }
    var floors = [], order = [], acc = 0;
    for (i = 0; i < n; i++) {
      var x = w[i] / sum * total, f = Math.floor(x);
      floors.push(f); acc += f; order.push({ i: i, frac: x - f });
    }
    order.sort(function (a, b) { return (b.frac - a.frac) || (a.i - b.i); });
    var rem = Math.round(total - acc);
    for (i = 0; i < rem; i++) floors[order[i % n].i] += 1;
    return floors;
  }

  /** Force the stored shares to integers summing to exactly 100. */
  function normalizeShares() {
    var w = [], i;
    for (i = 0; i < S.skills.length; i++) w.push(num(S.skills[i].share, 0));
    var got = distribute(w, 100);
    for (i = 0; i < S.skills.length; i++) S.skills[i].share = got[i];
  }

  /** Move one share and rebalance the rest proportionally, total still 100. */
  function setShare(idx, v) {
    var n = S.skills.length, i, w = [], others = [];
    if (n < 2) { S.skills[0].share = 100; return; }
    v = clamp(Math.round(num(v, 0)), 0, 100);
    for (i = 0; i < n; i++) if (i !== idx) { others.push(i); w.push(num(S.skills[i].share, 0)); }
    var got = distribute(w, 100 - v);
    S.skills[idx].share = v;
    for (i = 0; i < others.length; i++) S.skills[others[i]].share = got[i];
  }

  /**
   * Push the rebalanced shares back onto the other fields without a rebuild —
   * `skip` is the box being typed in, which must keep its cursor.
   */
  function syncShares(skip) {
    for (var i = 0; i < S.skills.length; i++) {
      if (i === skip) continue;
      var el = $("bc-sk-share-" + i);
      if (el && String(el.value) !== String(S.skills[i].share)) el.value = S.skills[i].share;
    }
  }

  // ------------------------------------------------------------------
  // provenance
  // ------------------------------------------------------------------

  /** Every path that still carries its imported value, untouched. */
  function provCount() {
    var n = 0, k;
    for (k in S.prov) if (Object.prototype.hasOwnProperty.call(S.prov, k)) n++;
    return n;
  }

  /**
   * A user edit on `path` retires its marker — for good. The suggested value stays
   * in provWas so the label can go on saying what the character page had, and so
   * "Reset to imported" still works.
   */
  function clearProv(path) {
    if (!path || !S.prov[path]) return false;
    delete S.prov[path];
    return true;
  }

  /** The character name the marks belong to, or "" when nothing is imported. */
  function provWho() { return (S.char && S.char.name) || ""; }

  /**
   * Apply values read off a character page. `values` is a map of state path ->
   * value; every one is marked as imported until the user edits it.
   *
   * A value may also be given as `{ value: v, note: "…" }`. The note is what the
   * page ACTUALLY said, in words, and it goes on the field's tooltip — because
   * several of these controls cannot hold the page's reading exactly. The gem
   * slider is one number for eleven gems; the necklace and earring controls are
   * four-way segmented pills. "Auto-set from Kyulo" is true but thin; "read
   * 2.60% from the neck" is what the user needs in order to disagree with us.
   */
  function applyImported(values, character) {
    if (character) S.char = character;
    var k, v, note;
    for (k in values) if (Object.prototype.hasOwnProperty.call(values, k)) {
      v = values[k]; note = null;
      if (v && typeof v === "object" && !(v instanceof Array) && "value" in v) { note = v.note || null; v = v.value; }
      try { setPath(S, k, v); } catch (e) { continue; }
      S.prov[k] = provWho() || "the character page";
      S.provWas[k] = v;
      if (note) S.provNote[k] = note; else delete S.provNote[k];
    }
    fitRows();
    save();
    renderAll();
    notify({ shape: true, immediate: true, imported: true });
  }

  // ------------------------------------------------------------------
  // the character page -> the left column
  // ------------------------------------------------------------------

  /**
   * Turn the Worker's `profile` block (ARCHITECTURE §1.1, produced by
   * parseCharacterProfile in worker/bracelet.js) into the deck's own paths.
   *
   * ONE RULE, and it is the whole design: a field the page did not carry is a
   * field this function does not put in the map. The item-level guess below it
   * has already filled every honing slider, and leaving that guess standing
   * beats overwriting it with a zero. So every branch is `if we actually read
   * it`, and the caller merges this over the guess.
   */
  function profileValues(pr) {
    var vals = {}, i, k, raw = (pr && pr.raw) || {};
    if (!pr) return vals;

    // ---- the six honing sliders, exact rather than derived ----
    if (pr.honing) {
      for (i = 0; i < PIECES.length; i++) {
        k = PIECES[i][0];
        if (pr.honing[k] == null) continue;                 // a piece we could not read keeps app.js's guess
        vals["gear." + k] = {
          value: clamp(Math.round(num(pr.honing[k], 0)), 0, 25),
          note: "the page has the " + PIECES[i][1].toLowerCase() + " at +" + pr.honing[k] +
            (pr.advancedHoning && pr.advancedHoning[k] != null
              ? " (advanced honing " + pr.advancedHoning[k] + ", which this model does not use)" : "")
        };
      }
    }

    // ---- the necklace and the two earrings ----
    if (pr.neckAddDmg != null) {
      vals["kit.neck"] = { value: pr.neckAddDmg, note: accNote(raw.neckAddDmg, pr.neckAddDmg, "the neck") };
    }
    if (pr.earring1Wp != null) {
      vals["kit.ear1"] = { value: pr.earring1Wp, note: accNote(raw.earring1Wp, pr.earring1Wp, "earring 1") };
    }
    if (pr.earring2Wp != null) {
      vals["kit.ear2"] = { value: pr.earring2Wp, note: accNote(raw.earring2Wp, pr.earring2Wp, "earring 2") };
    }

    // ---- the one gem slider, out of eleven gems ----
    if (pr.gemLevel != null) {
      var lv = clamp(Math.round(num(pr.gemLevel, 9)), 6, 10);
      var spread = raw.gemSpread || (pr.gemLevels || []).join(",");
      vals["kit.gems"] = {
        value: lv,
        note: raw.gemMixed
          ? "gems are " + spread + " — the deck holds one level, so it is set to " + lv
          : "all " + (pr.gemLevels ? pr.gemLevels.length : 11) + " gems are level " + lv
      };
    }

    // ---- the two on/off nodes ----
    if (pr.stone97 != null) {
      var nodes = raw.stoneNodes || [];
      vals["kit.stone"] = {
        value: !!pr.stone97,
        note: nodes.length
          ? "the ability stone's engraving nodes are " + nodes.join("/") +
            (pr.stone97 ? " — 9/7 or better" : " — short of 9/7")
          : (pr.stone97 ? "the ability stone is 9/7 or better" : "the ability stone is short of 9/7")
      };
    }
    if (pr.master != null) {
      vals["kit.master"] = {
        value: !!pr.master,
        note: pr.master
          ? "the Master node is on the character's Evolution ark passive"
          : "the character's Evolution ark passive does not have Master"
      };
    }

    return vals;
  }

  /** "read 2.60% from the neck", plus the snap when the page is off the pills. */
  function accNote(rawPct, snapped, where) {
    if (rawPct == null) return "read nothing on " + where;
    var txt = "read " + fx(rawPct, 2) + "% from " + where;
    if (Math.abs(rawPct - snapped) > 1e-9) txt += " — snapped to the nearest option, " + snapped + "%";
    return txt;
  }

  // ------------------------------------------------------------------
  // "Import Character Stats"
  //
  // The one path from a character page into the left column, and it runs when
  // the user presses the button — never on load. Loading someone fills the
  // bracelet and the banner; the settings stay ours until asked, so the number
  // on screen is the number the board shows them.
  // ------------------------------------------------------------------

  /**
   * What a record says about the character's gear, before the §1.1 profile
   * block is merged over it.
   *
   * ITEM LEVEL is always there: the roster and the page both carry an average,
   * and the six honing sliders are what the model reads. An average maps to a
   * uniform honing level (Serca 0 is 1675, every level is +5), which is a
   * derivation and not a measurement — so profileValues' exact per-piece
   * numbers overwrite it wherever the page carried them.
   *
   * THE REST arrives only when the Worker read the character page directly:
   *
   *   weaponPower + mainStat  -> the raw override pair, and the override switch
   *                              with them, because a raw main stat that the
   *                              honing sliders then overwrite would be worse
   *                              than none
   *   gemLevels               -> the one gem-level control
   *   critRate / critDamage   -> the first skill row's crit numbers
   *
   * Everything else the deck holds — fight shares, weights, the economy knobs —
   * is judgment, not data, and is never imported. Nothing about the bracelet
   * itself comes through here; that is the patch app.js applies on load.
   */
  function recordValues(c) {
    var vals = {}, i, G = window.BraceletGearData;
    if (!c) return vals;

    if (G && c.itemLevel != null) {
      var lvl = clamp(Math.round((num(c.itemLevel, NaN) - G.ILVL0) / G.ILVL_STEP), 0, 25);
      if (isFinite(lvl)) for (i = 0; i < PIECES.length; i++) vals["gear." + PIECES[i][0]] = lvl;
    }

    var pr = c.profile;
    if (pr) {
      var wp = num(pr.weaponPower, NaN), ms = num(pr.mainStat, NaN);
      // Both or neither: the override pair is one setting, and half of it is
      // worse than none — the model would then read one raw number and one
      // derived one.
      if (isFinite(wp) && wp > 0 && isFinite(ms) && ms > 0) {
        vals["ov.weaponPowerRaw"] = Math.round(wp);
        vals["ov.mainStatRaw"] = Math.round(ms);
        vals.useOverride = true;
      }
      var gl = num(pr.gemLevels, NaN);
      if (isFinite(gl) && gl >= 6 && gl <= 10) vals["kit.gems"] = Math.round(gl);
      var cr = num(pr.critRate, NaN);
      if (isFinite(cr) && cr > 0 && cr <= 100) vals["skills.0.cr"] = cr;
      var cd = num(pr.critDamage, NaN);
      if (isFinite(cd) && cd > 0) vals["skills.0.cd"] = cd;
    }
    return vals;
  }

  /**
   * The whole left column, from the character the banner is showing. Returns how
   * many paths it wrote, 0 if there was nothing to write.
   *
   * The profile block wins over the item-level guess wherever it read a piece,
   * so the two maps merge in that order and land as ONE applyImported — one
   * render, one notification, one mark per field.
   */
  function importCharacterStats() {
    var c = S.char;
    if (!c || !c.name) return 0;
    var vals = recordValues(c), got = profileValues(c.profile), k, n = 0;
    for (k in got) if (Object.prototype.hasOwnProperty.call(got, k)) vals[k] = got[k];
    for (k in vals) if (Object.prototype.hasOwnProperty.call(vals, k)) n++;
    if (!n) return 0;
    applyImported(vals, c);
    return n;
  }

  /**
   * Paint the markers after a render: an imported field's label turns accent and
   * says where the number came from; an edited one keeps the "suggests" wording.
   */
  function markProvenance() {
    var seen = {}, k;
    for (k in S.provWas) if (Object.prototype.hasOwnProperty.call(S.provWas, k)) seen[k] = 1;
    for (k in S.prov) if (Object.prototype.hasOwnProperty.call(S.prov, k)) seen[k] = 1;
    var who = provWho() || "the character page";
    for (k in seen) if (Object.prototype.hasOwnProperty.call(seen, k)) {
      // Sliders and typed fields carry the path as an id; segmented controls and
      // toggles are buttons that carry it as data-seg / data-tgl instead.
      var sel = '[data-seg="' + k + '"],[data-tgl="' + k + '"]';
      var el = $(fldId(k)) ||
        (deckEl && deckEl.querySelector(sel)) ||
        (topEl && topEl.querySelector(sel));
      if (!el) continue;
      // A TOGGLE has no row and no label: the button is the whole control, and
      // it carries the gloss itself. The 9/7 stone and Master are both toggles,
      // and both are imported now, so this is not a corner case.
      var isTgl = !!(el.getAttribute && el.getAttribute("data-tgl"));
      var row = isTgl ? el : el.parentNode;
      if (!isTgl) {
        while (row && row !== document.body && !(row.className && /\b(bc-sl|bc-segrow|fld)\b/.test(String(row.className)))) row = row.parentNode;
        if (!row || row === document.body) continue;
      }
      var live = !!S.prov[k], was = S.provWas[k];
      row.className = String(row.className).replace(/\s*\bbc-imp\b/g, "") + (live ? " bc-imp" : "");
      var lab = isTgl ? row : (row.getElementsByTagName("label")[0] ||
        (row.getElementsByClassName("lb")[0] || null));
      if (!lab) continue;
      var base = lab.getAttribute("data-provbase");
      if (base === null) {
        base = lab.getAttribute("data-gloss") || "";
        lab.setAttribute("data-provbase", base);
      }
      var note = S.provNote[k] ? " — " + S.provNote[k] : "";
      var shown = (typeof was === "boolean") ? (was ? "on" : "off") : was;
      var tail = live
        ? " Auto-set from " + who + note + "."
        : (was === undefined ? "" : " " + who + " suggests " + shown + note + ".");
      lab.setAttribute("data-gloss", (base + tail).replace(/^\s+/, ""));
    }
  }

  /** The strip above the deck: who was loaded, and how much of them is still here. */
  function renderProvStrip() {
    var box = $("bc-prov");
    if (!box) return;
    if (!S.char || !provWasCount()) { box.innerHTML = ""; box.style.display = "none"; return; }
    box.style.display = "";
    var n = provCount(), who = esc(provWho() || "the character page");
    var txt = n
      ? "Loaded from <b>" + who + "</b> — " + n + " value" + (n === 1 ? "" : "s") + " came from the character page."
      : "Loaded from <b>" + who + "</b> — nothing on screen still holds what the page said.";
    // The two resets are NOT here any more: they moved up to the character
    // header's control row, which is on screen whether or not the deck is open.
    box.innerHTML = '<span class="bc-provtxt" data-gloss="Marked fields hold a number read off the character page rather than one you chose. Editing a field drops its mark for good; the label then says what the page had, as a suggestion.">' +
      txt + " Only the left column ever comes from a character page.</span>";
  }

  // ------------------------------------------------------------------
  // the two resets
  //
  // Neither asks. A confirm box on a reset button is a second click for a
  // reversible action — every number it clears is either a default anybody can
  // read off the panel or an import one click away again — so both act at once.
  //
  // They are also SCOPED, which the single old reset was not. The character and
  // the bracelet are two different things: retuning your gear must not throw
  // away the bracelet you spent ten minutes typing in, and clearing a bracelet
  // must not forget who you are.
  // ------------------------------------------------------------------

  /** Everything that describes the PLAYER. Nothing about the bracelet. */
  var CHARACTER_BLOCKS = ["gear", "ov", "kit", "fight", "adv", "econ"];

  function resetCharacter() {
    var d = defaults(), i, k;
    for (i = 0; i < CHARACTER_BLOCKS.length; i++) {
      k = CHARACTER_BLOCKS[i];
      S[k] = d[k];
    }
    S.useOverride = d.useOverride;
    S.skills = d.skills;
    // THE BRACELET IS NOT A SETTING EITHER. Grade, granted slots and rolls left
    // used to come back to their defaults here, taking the padlocks and the cut
    // in progress with them — so "Reset to Default" reshaped the bracelet the
    // user had just imported (Shizu, 2026-08-12: "it keeps their profile pulled
    // up and their bracelet unchanged"). "Reset bracelet" is the button for
    // those. This one touches the left column and the right, and nothing else.
    //
    // WHO IS LOADED IS NOT A SETTING. This used to null S.char and wipe every
    // provenance map with it, so the reset quietly forgot the character: the
    // banner painted itself empty, and the name, the chips, the three stats and
    // the field rank all went (Shizu, 2026-08-11). The character, and everything
    // a page ever suggested for it, survive a reset of the settings.
    //
    // The live MARKS do come off, because the fields now hold the calculator's
    // defaults rather than the page's numbers — so each label goes back to
    // reading "<Name> suggests +21", which is exactly what is true.
    S.prov = {};
    fitRows();
    save();
    renderAll();
    notify({ shape: true, immediate: true, reset: "character" });
  }

  /** Everything that describes the BRACELET. The character is untouched. */
  function resetBracelet() {
    var d = defaults();
    S.rows = d.rows;
    S.fixedRows = d.fixedRows;
    S.traits = d.traits;
    S.locks = null;
    S.rolled = null;
    S.history = [];
    S.rollsLeft = d.rollsLeft;
    S.rollsTotal = d.rollsTotal;
    fitRows();
    save();
    renderAll();
    notify({ shape: true, immediate: true, reset: "bracelet" });
  }

  // ------------------------------------------------------------------
  // change notification
  // ------------------------------------------------------------------

  var listeners = [];
  /**
   * detail.immediate  a press, not a drag: the subscriber should act now
   * detail.shape      grade / slots / override moved — rebuild anything keyed on them
   * detail.reset      the state was wiped back to defaults
   */
  function notify(detail) {
    detail = detail || {};
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](detail); } catch (e) { /* a bad subscriber must not break others */ }
    }
  }

  // ------------------------------------------------------------------
  // the deck's stylesheet
  //
  // Scoped by the bc- class namespace rather than by a tab id: the deck moves
  // between panes, so a `#tab-calculator …` prefix would strip its own styling the
  // moment the Tier List mounted it.
  // ------------------------------------------------------------------

  function styleText() {
    return "" +
      // The control deck rides in normal document flow. It used to stick and
      // scroll inside itself, which meant you had to collapse the panel before
      // you could read the results under it — Shizu's complaint, 2026-08-11.
      "#bc-inputs{position:static;max-height:none;overflow:visible}" +
      "#bc-inputs .ihdr{cursor:pointer}" +
      ".bc-busy{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--border);margin-left:8px;vertical-align:middle;transition:background .15s}" +
      ".bc-busy.on{background:var(--accent);animation:bc-pulse 1s ease-in-out infinite}" +
      "@keyframes bc-pulse{0%,100%{opacity:.25}50%{opacity:1}}" +
      ".bc-sub{font-size:11px;color:var(--dim);margin:-4px 0 10px}" +
      // ---- the provenance strip ----
      ".bc-prov{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px;padding:8px 11px;" +
        "border:1px solid var(--accent);border-radius:8px;background:rgba(102,199,255,.08);font-size:12.5px}" +
      ".bc-prov .mbtn{padding:4px 10px;font-size:11.5px}" +
      ".bc-prov b{color:var(--accent)}" +
      ".bc-imp .lb,.bc-imp>label{color:var(--accent)}" +
      ".bc-imp .lb::after,.bc-imp>label::after{content:'\\2022';color:var(--accent);margin-left:5px}" +
      // A toggle is its own label, so the mark has to land on the button. It must
      // NOT be the accent text and border the PRESSED state uses: "Master · off"
      // with an accent outline read as Master being on, when the outline only
      // meant "this came from the character page" (Shizu's screenshot,
      // 2026-08-11). So provenance is an accent RULE down the left edge plus the
      // dot every other imported control carries, and on/off keeps the whole
      // button to itself.
      "button.bc-tgl.bc-imp{border-left:3px solid var(--accent);padding-left:12px}" +
      "button.bc-tgl.bc-imp::after{content:'\\2022';color:var(--accent);margin-left:5px}" +
      // ---- the two-column control deck -------------------------------
      ".bc-deck{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px 22px}" +
      "@media(max-width:900px){.bc-deck{grid-template-columns:1fr;gap:0}}" +
      ".bc-col{min-width:0}" +
      ".bc-gearhdr{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:12px 0 8px}" +
      ".bc-gearhdr .subh{margin:0}" +
      ".bc-ilvl{text-align:right;line-height:1}" +
      ".bc-ilvl .k{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:700}" +
      ".bc-ilvl .v{font-size:28px;font-weight:800;letter-spacing:-.02em;color:var(--accent);font-variant-numeric:tabular-nums;margin-top:3px}" +
      // ---- slider rows ------------------------------------------------
      ".bc-sl{display:grid;grid-template-columns:96px minmax(0,1fr) 52px;gap:10px;align-items:center;margin-bottom:6px}" +
      ".bc-sl .lb{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);line-height:1.25}" +
      ".bc-sl .chip{font-size:12.5px;font-weight:700;color:var(--accent);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".bc-sl .chip.ed{cursor:text;text-decoration:underline dotted;text-underline-offset:3px}" +
      ".bc-sl .chip input{width:100%;background:var(--panel2);color:var(--text);border:1px solid var(--accent);border-radius:5px;padding:2px 4px;font:inherit;font-size:12px;text-align:right}" +
      ".bc-sl .tk{min-width:0}" +
      // Tick labels sit UNDER their own notch, which equal columns cannot do: a
      // range thumb travels between thumb/2 and width − thumb/2, so a label
      // centred in column i drifts off its stop, worst at the two ends ("6" right
      // of the first notch, "10" left of the last — Shizu, 2026-08-11). Each
      // label is placed at the thumb's own centre instead: thumb/2 + i/(n−1) of
      // the travel. --bc-thumb is the thumb width from the rules below, in one
      // place, so the two cannot drift apart.
      ".bc-sl{--bc-thumb:15px}" +
      ".bc-ticks{position:relative;height:12px;font-size:9.5px;color:var(--dim);margin-top:-2px;letter-spacing:.03em}" +
      ".bc-ticks span{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap}" +
      // Native range, styled to the house theme — no custom drag code.
      ".bc-sl input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:18px;background:transparent;margin:0;padding:0;cursor:pointer;display:block}" +
      ".bc-sl input[type=range]::-webkit-slider-runnable-track{height:5px;border-radius:3px;background:var(--panel2);border:1px solid var(--border)}" +
      ".bc-sl input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:var(--accent);border:none;margin-top:-6px}" +
      ".bc-sl input[type=range]::-moz-range-track{height:5px;border-radius:3px;background:var(--panel2);border:1px solid var(--border)}" +
      ".bc-sl input[type=range]::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:var(--accent);border:none}" +
      ".bc-sl input[type=range]:focus{outline:none}" +
      ".bc-sl input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px rgba(102,199,255,.35)}" +
      ".bc-sl input[type=range]:focus-visible::-moz-range-thumb{box-shadow:0 0 0 3px rgba(102,199,255,.35)}" +
      ".bc-sl input[type=range]:disabled{opacity:.45;cursor:not-allowed}" +
      // The weapon is the only piece that moves weapon power: mark its track.
      ".bc-sl.wep input[type=range]::-webkit-slider-runnable-track{background:rgba(102,199,255,.30);border-color:var(--accent)}" +
      ".bc-sl.wep input[type=range]::-moz-range-track{background:rgba(102,199,255,.30);border-color:var(--accent)}" +
      // ---- segmented controls and toggles -----------------------------
      ".bc-segrow{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:center;margin-bottom:6px}" +
      // ---- the bracelet's own header: grade, slots and rolls on ONE row ----
      //
      // These five rules used to start with a stray unary `+` on the first of
      // them ("…6px}" + + '.bc-toprow{…'), which coerced the string to NaN. The
      // grid rule vanished and the next selector became "NaN.bc-toprow …", which
      // the parser threw away too — so the rolls slider, still sized for a grid
      // cell it no longer had, sat on top of its neighbours. That is the overlap
      // Shizu photographed (2026-08-11).
      // Borrowed by a tab with no Grader (the Tier List, the Advisor) they read
      // as a short stacked list in the control cluster, one label above its
      // control. In the Grader they lie along ONE line instead — see #bc-tophost
      // below — because there is a full panel width to spend there.
      ".bc-brachdr{min-width:150px}" +
      ".bc-toprow{display:flex;flex-direction:column;gap:9px}" +
      ".bc-toprow .bc-segrow,.bc-toprow .bc-sl{display:block;margin:0;min-width:0}" +
      ".bc-toprow .lb{display:block;margin-bottom:4px}" +
      ".bc-toprow .bc-sl .tk{display:inline-block;width:calc(100% - 56px);vertical-align:middle}" +
      ".bc-toprow .bc-sl .chip{display:inline-block;width:52px;text-align:right;vertical-align:middle}" +
      // ---- the three in their real home: one line inside the Grader ----
      // They wrap onto their own lines on a phone; the rolls track takes whatever
      // width is left over, so it never squeezes the two pill groups.
      "#bc-tophost{margin:2px 0 12px}" +
      "#bc-tophost .bc-brachdr{min-width:0}" +
      "#bc-tophost .bc-toprow{flex-direction:row;flex-wrap:wrap;align-items:flex-end;gap:10px 22px}" +
      "#bc-tophost .bc-toprow>*{flex:0 0 auto}" +
      "#bc-tophost .bc-toprow .bc-segrow{min-width:132px}" +
      "#bc-tophost .bc-toprow .bc-sl{flex:1 1 200px;min-width:180px}" +
      ".bc-seg{display:flex;gap:4px}" +
      ".bc-seg button{flex:1 1 0;min-width:0;background:var(--panel2);border:1px solid var(--border);color:var(--dim);" +
        "border-radius:6px;padding:5px 2px;font-size:11.5px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap}" +
      ".bc-seg button:hover{color:var(--text);border-color:var(--accent)}" +
      ".bc-seg button[aria-pressed=true]{color:#06121f;background:var(--accent);border-color:var(--accent)}" +
      ".bc-tgl[aria-pressed=true]{color:var(--accent);border-color:var(--accent);background:rgba(102,199,255,.16)}" +
      ".bc-tgl[aria-pressed=true]:hover{color:var(--accent)}" +
      // ---- skills: typed, not slid (Shizu's call for this block only) ----
      ".bc-skill{display:grid;grid-template-columns:110px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 26px;gap:7px;align-items:end;margin-bottom:7px}" +
      "@media(max-width:640px){.bc-skill{grid-template-columns:1fr 1fr}" +
      ".bc-skill .bc-x{justify-self:start;width:44px}" +
      ".bc-sl,.bc-segrow{grid-template-columns:82px minmax(0,1fr) 46px;gap:7px}" +
      ".bc-segrow{grid-template-columns:82px minmax(0,1fr)}}" +
      ".bc-x{background:var(--panel2);border:1px solid var(--border);color:var(--dim);border-radius:6px;height:29px;width:100%;padding:0;cursor:pointer;font-family:inherit;font-size:14px;line-height:1}" +
      ".bc-x:hover{color:var(--bad);border-color:var(--bad)}" +
      // A checkbox has no field above it to line up with, and its label is a
      // sentence rather than a caption — give it the whole row.
      ".bc-chk{grid-column:1/-1}" +
      ".bc-chk label{display:flex;align-items:center;gap:7px;text-transform:none;font-size:12.5px;color:var(--text);letter-spacing:0;padding:4px 0}" +
      // .fld input is width:100% for text boxes; a checkbox must not inherit that.
      ".bc-chk input{width:auto;flex:0 0 auto;margin:0;accent-color:var(--accent)}" +
      // ---- bracelet line rows (the Advanced fold's fixed-line editor lives in
      //      this deck; the Bracelet panel's granted rows use the same shape) ----
      ".bc-fam{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      // The family box carries the longest text on the row, so it gets the
      // room: 430px fits nearly every label outright (the shrink last round
      // went too far — Shizu, 2026-08-11).
      ".bc-slot{display:grid;grid-template-columns:44px 168px minmax(0,430px) 120px;gap:8px;align-items:end;margin-bottom:8px;justify-content:start}" +
      ".bc-slot .sn{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;padding-bottom:7px}" +
      // KEEP / ROLL beside the slot number (app.js's slotAdvice). It rides IN
      // the label cell rather than taking a column of its own, so the grid is
      // the same four columns it was — including the phone breakpoint below,
      // where the whole row becomes one column and the label loses its padding.
      // inline-block, so a narrow cell wraps the badge under the number instead
      // of stretching the row.
      ".bc-slot .sn .bc-adv{display:inline-block;margin-left:5px;padding:1px 6px;border-radius:99px;" +
        "font-size:9px;font-weight:800;letter-spacing:.06em;line-height:1.6;vertical-align:baseline;" +
        "border:1px solid transparent}" +
      ".bc-slot .sn .bc-adv.keep{color:var(--good);border-color:var(--good);background:rgba(110,231,168,.13)}" +
      ".bc-slot .sn .bc-adv.roll{color:var(--dim);border-color:var(--border);background:var(--panel2)}" +
      // ---- the character header's right-hand CONTROL CLUSTER ----
      //
      // Everything you press, in one place, to the right of everything you read
      // (Shizu's mock-up, 2026-08-11). Two columns: the character's two buttons,
      // and grade over granted slots over rolls left.
      ".bc-hdrctl{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;" +
        "padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--panel2)}" +
      ".bc-ctlstack{display:flex;flex-direction:column;gap:9px}" +
      ".bc-ctlrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      // Each button sizes to its own words rather than splitting the row evenly:
      // "Import Character Stats" and "Reset to Default" are not the same length,
      // and a squashed button wraps mid-word.
      ".bc-ctlrow button{flex:0 0 auto;white-space:nowrap}" +
      // A button that has nothing to do still answers a hover, because the
      // tooltip is where the reason lives.
      ".bc-ctlrow button[aria-disabled=true]{opacity:.5;cursor:not-allowed}" +
      // Phones: the cluster's two columns become one, full width.
      "@media(max-width:560px){.bc-hdrctl{gap:12px}" +
      ".bc-hdrctl .bc-ctlstack,.bc-hdrctl .bc-brachdr{flex:1 1 100%;min-width:0}}" +
      "@media(max-width:640px){.bc-slot{grid-template-columns:1fr;gap:5px}.bc-slot .sn{padding-bottom:0}}" +
      "@media(max-width:900px) and (min-width:641px){.bc-slot{grid-template-columns:44px 150px minmax(0,1fr) 110px}}";
  }

  function injectStyle() {
    if ($("bc-deck-css")) return;
    var st = document.createElement("style");
    st.id = "bc-deck-css";
    st.appendChild(document.createTextNode(styleText()));
    (document.head || document.documentElement).appendChild(st);
  }

  // ------------------------------------------------------------------
  // markup helpers
  // ------------------------------------------------------------------

  function opts(list, sel) {
    var h = "", i;
    for (i = 0; i < list.length; i++) {
      var o = list[i], v = (o && o.v !== undefined) ? o.v : o, t = (o && o.t !== undefined) ? o.t : o;
      h += '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? " selected" : "") + ">" + esc(t) + "</option>";
    }
    return h;
  }
  // Every field carries a stable id derived from its state path, so a re-render
  // can put the cursor back where it was.
  function fldId(path) { return "bc-fld-" + path.replace(/\./g, "-"); }
  function fldNum(path, label, step, gloss) {
    return '<div class="fld"><label' + (gloss ? ' data-gloss="' + esc(gloss) + '"' : "") + ">" + esc(label) + "</label>" +
      '<input id="' + fldId(path) + '" type="number" step="' + (step || "any") + '" data-k="' + path + '" data-t="num" value="' + esc(getPath(S, path)) + '"></div>';
  }
  function fldSel(path, label, list, gloss) {
    return '<div class="fld"><label' + (gloss ? ' data-gloss="' + esc(gloss) + '"' : "") + ">" + esc(label) + "</label>" +
      '<select id="' + fldId(path) + '" data-k="' + path + '" data-t="sel">' + opts(list, getPath(S, path)) + "</select></div>";
  }
  function fldChk(path, label, gloss) {
    return '<div class="fld bc-chk"><label' + (gloss ? ' data-gloss="' + esc(gloss) + '"' : "") + ">" +
      '<input id="' + fldId(path) + '" type="checkbox" data-k="' + path + '" data-t="chk"' + (getPath(S, path) ? " checked" : "") + "> " + esc(label) + "</label></div>";
  }

  // ------------------------------------------------------------------
  // mouse-first controls
  //
  // Sliders, segmented buttons and toggles all read and write S through the
  // same data-k path the number fields use, so persistence comes for free.
  // Sliders are native <input type=range>; there is no custom drag code.
  // ------------------------------------------------------------------

  function chipId(path) { return fldId(path) + "-chip"; }
  // Chip formats live in a map keyed by name so a drag can re-render the chip
  // from the DOM alone, without hunting for the function that drew it.
  var FMT = {
    plus: function (v) { return "+" + v; },
    pct: function (v) { return v + "%"; },
    pct1: function (v) { return fx(v, 1) + "%"; },
    lv: function (v) { return "Lv " + v; },
    slots: function (v) { return v + (v === 1 ? " slot" : " slots"); },
    // 4 base rolls + up to 3 reconversion tickets. The split only tells you
    // anything while some ticket rolls are still on the bracelet, so below 4 the
    // chip just says the number.
    rolls: function (v) { return v > 3 ? v + " · " + (v - 3) + "+3" : String(v); },
    raw: function (v) { return String(v); }
  };

  /**
   * o.cls    extra class on the row ("wep" paints the weapon track accent)
   * o.gloss  tooltip on the label
   * o.ticks  labels drawn under the track, one per step
   * o.edit   the value chip becomes a number input when clicked
   */
  function slider(path, label, min, max, step, fmtKey, o) {
    o = o || {};
    var fmt = FMT[fmtKey] || FMT.raw;
    var v = num(getPath(S, path), min), t = "";
    if (o.ticks) {
      // One label per stop, each parked at the centre the thumb reaches there.
      // See .bc-ticks in the stylesheet for why this is not a grid.
      var n = o.ticks.length;
      t = '<div class="bc-ticks">';
      for (var i = 0; i < n; i++) {
        var f = n > 1 ? i / (n - 1) : 0.5;
        t += '<span style="left:calc(var(--bc-thumb)/2 + ' + f.toFixed(6) +
          ' * (100% - var(--bc-thumb)))">' + esc(o.ticks[i]) + "</span>";
      }
      t += "</div>";
    }
    return '<div class="bc-sl' + (o.cls ? " " + o.cls : "") + '">' +
      '<label class="lb" for="' + fldId(path) + '"' + (o.gloss ? ' data-gloss="' + esc(o.gloss) + '"' : "") + ">" + esc(label) + "</label>" +
      '<div class="tk"><input id="' + fldId(path) + '" type="range" data-k="' + path + '" data-t="rng" data-fmt="' + esc(fmtKey) + '"' +
        ' min="' + min + '" max="' + max + '" step="' + step + '" value="' + esc(v) + '"' +
        (o.disabled ? " disabled" : "") + ">" + t + "</div>" +
      '<span class="chip' + (o.edit ? " ed" : "") + '" id="' + chipId(path) + '"' +
        (o.edit ? ' data-editk="' + path + '" data-min="' + min + '" data-max="' + max + '" data-step="' + step + '" title="Click to type an exact value"' : "") +
        ">" + esc(fmt(v)) + "</span>" +
      "</div>";
  }

  function segmented(path, label, options, fmt, gloss) {
    var cur = String(getPath(S, path)), h = "", i, v;   // String(): slot counts arrive as numbers
    for (i = 0; i < options.length; i++) {
      v = options[i];
      h += '<button type="button" data-seg="' + path + '" data-v="' + esc(v) + '" aria-pressed="' +
        (String(v) === cur ? "true" : "false") + '">' + esc(fmt(v)) + "</button>";
    }
    return '<div class="bc-segrow"><span class="lb"' + (gloss ? ' data-gloss="' + esc(gloss) + '"' : "") + ">" + esc(label) + "</span>" +
      '<div class="bc-seg" role="group" aria-label="' + esc(label) + '">' + h + "</div></div>";
  }

  function toggle(path, label, gloss) {
    var on = !!getPath(S, path);
    return '<button type="button" class="mbtn bc-tgl" data-tgl="' + path + '" aria-pressed="' + (on ? "true" : "false") + '"' +
      (gloss ? ' data-gloss="' + esc(gloss) + '"' : "") + ">" + esc(label) + " · " + (on ? "on" : "off") + "</button>";
  }

  // ------------------------------------------------------------------
  // the deck itself
  // ------------------------------------------------------------------

  function deckMarkup() {
    return '' +
      '<div class="inputs" id="bc-inputs">' +
      '  <div class="ihdr"><span>Character<span class="bc-busy" id="bc-busy"></span></span>' +
      '    <span class="tgl" id="bc-toggle"><span id="bc-caret">&#9656;</span></span></div>' +
      '  <div id="bc-inputs-body" style="display:none">' +
      '    <div class="bc-prov" id="bc-prov" style="display:none"></div>' +
      // #bc-top (grade / granted slots / rolls left) is NOT here: those three
      // describe the BRACELET, not the character, so they live in the Grader
      // panel (see buildTop / adoptBraceletPanel). Sitting in the deck they
      // collided with the provenance strip above them and said the same thing as
      // the banner's chips.
      '    <div class="bc-deck">' +
      '      <div class="bc-col">' +
      '        <div class="bc-gearhdr"><div class="subh">Gear</div>' +
      '          <div class="bc-ilvl"><div class="k" data-gloss="The mean of your six pieces\' item levels, live. Serca level 0 is item level 1675 and every honing level is +5, so +25 across the board is 1800. Item level itself does not enter the damage math — the honing levels behind it do.">Item level</div>' +
      '            <div class="v" id="bc-ilvl">—</div></div></div>' +
      '        <div id="bc-gear"></div>' +
      '        <div id="bc-kit"></div>' +
      '        <div class="barrow">' +
      '          <button class="mbtn" id="bc-advtoggle" type="button">Advanced ▾</button>' +
      '          <button class="mbtn" id="bc-reset" type="button" data-gloss="Puts the settings back to the calculator\'s defaults — gear, accessories, gems and the two nodes on the left, the fight, trait, skill and economy settings on the right, and the bracelet\'s grade, granted slots and rolls left in the Grader. The character stays loaded, and the lines you typed are left alone.">Reset to defaults</button>' +
      '        </div>' +
      '      </div>' +
      '      <div class="bc-col">' +
      '        <div class="subh">Fight</div>' +
      '        <div id="bc-fight"></div>' +
      '        <div class="subh">Traits</div>' +
      '        <div id="bc-traitw"></div>' +
      '        <div class="subh">Skills — share, crit rate, crit damage</div>' +
      '        <div id="bc-skills"></div>' +
      '        <div class="barrow"><button class="mbtn" id="bc-addskill" type="button">+ Add skill</button></div>' +
      '        <div class="subh">Economy</div>' +
      '        <div id="bc-econ"></div>' +
      '      </div>' +
      '    </div>' +
      '    <div id="bc-adv" style="display:none"></div>' +
      '  </div>' +
      '</div>';
  }

  // ------------------------------------------------------------------
  // input rendering
  // ------------------------------------------------------------------

  /**
   * Grade, granted slots and rolls left.
   *
   * They render into #bc-top, one element this file builds and parents into the
   * GRADER panel's own #bc-tophost (app.js's markup, adoptBraceletPanel does the
   * placing). They sat in the character header's control cluster until
   * 2026-08-11, which was wrong twice over: that banner is rebuilt by
   * renderCharHeader, so a rolls-left drag destroyed the slider under the hand,
   * and with no character loaded the banner is not drawn at all, so all three
   * controls disappeared from the page. They describe the bracelet, the Grader
   * grades the bracelet, and nothing rewrites that panel (Shizu: "move that to
   * the grader so it only interacts with the grader").
   *
   * Grade and slot count are two-option choices, so they read as left/right
   * pills like the loadout switch. Rolls left keeps a tight track because it
   * genuinely has eight positions.
   */
  function renderTop() {
    var ch = slotChoices();
    var h = '<div class="bc-toprow">';
    h += segmented("grade", "Grade", ["ancient", "relic"],
      function (v) { return v === "ancient" ? "Ancient" : "Relic"; },
      "Ancient bracelets roll 2 or 3 granted slots and higher line values; Relic rolls 1 or 2.");
    h += segmented("slots", "Granted slots", ch, function (v) { return String(v); },
      "The rerollable lines. Ancient: 3 slots on 25% of drops, 2 on 75%. Slot count moves the value of an unrolled bracelet a lot.");
    h += slider("rollsLeft", "Rolls left", 0, 7, 1, "rolls",
      { cls: "bc-sl-tight",
        ticks: ["0", "1", "2", "3", "4", "5", "6", "7"],
        gloss: "A fresh bracelet has 4 rolls plus up to 3 reconversion-ticket rolls = 7. The chip splits the two while the ticket rolls are still there. The cut flow counts this down." });
    h += "</div>";
    buildTop().innerHTML = h;
  }


  // ---- left column: GEAR ----

  function renderGear() {
    var h = "", i, k;
    // The raw-override switch describes the CHARACTER, so it stays with the gear
    // it replaces rather than travelling with the bracelet's three settings.
    h += fldChk("useOverride", "Enter WP / main stat directly",
      "Skip the honing sliders and type the two raw numbers straight off your character sheet (before the % buckets).");
    if (S.useOverride) {
      h += '<div class="ig">';
      h += fldNum("ov.mainStatRaw", "Main stat (raw)", "1", "Before the main-stat % bucket: the five armour pieces + accessories + base + roster.");
      h += fldNum("ov.weaponPowerRaw", "Weapon power (raw)", "1", "Before the weapon-power % bucket: the weapon's table value.");
      h += "</div>";
      h += '<div class="note">The percentage buckets still apply on top: main stat ' + fx(S.adv.msPct, 1) +
        "%, weapon power " + fx(wpPctOf(), 1) + "%, attack power " + fx(baseApPctOf(), 1) +
        "%. Change them under Advanced.</div>";
    } else {
      for (i = 0; i < PIECES.length; i++) {
        k = PIECES[i][0];
        h += slider("gear." + k, PIECES[i][1], 0, 25, 1, "plus", {
          cls: k === "weapon" ? "wep" : "",
          gloss: k === "weapon"
            ? "Serca honing level of the weapon. It alone sets weapon power; +25 is item level 1800."
            : "Serca honing level of the " + PIECES[i][1].toLowerCase() + ". The five armour pieces feed main stat."
        });
      }
    }
    $("bc-gear").innerHTML = h;
    updateIlvl();
  }

  /** The big number the eye checks after every slider move. */
  function updateIlvl() {
    var el = $("bc-ilvl");
    if (!el) return;
    el.textContent = S.useOverride ? "—" : fx(ilvlExact(), 2);
  }

  function renderKit() {
    var box = $("bc-kit");
    if (!box) return;
    if (S.useOverride) { box.innerHTML = ""; return; }
    var pc = function (v) { return v + "%"; };
    var h = "";
    h += segmented("kit.neck", "Neck dmg", [0, 0.7, 1.6, 2.6], pc,
      "Your necklace's additional-damage line. It joins one additive pool with the weapon, pet and astrogem grid, and a bracelet line worth +3% is diluted against that whole pool. 0.7% is the low tier, 2.6% a high roll, 0% no line at all.");
    h += segmented("kit.ear1", "Earring 1 WP", [0, 0.8, 1.8, 3], pc,
      "The first earring's weapon-power line. Both earrings plus karma make the weapon-power percentage bucket, which multiplies your raw weapon power and every flat weapon-power line the bracelet gives you.");
    h += segmented("kit.ear2", "Earring 2 WP", [0, 0.8, 1.8, 3], pc,
      "The second earring's weapon-power line. Same bucket as the first.");
    h += slider("kit.gems", "Damage gems", 6, 10, 1, "lv",
      { ticks: ["6", "7", "8", "9", "10"],
        gloss: "All eleven damage gems at this level. Per gem: lv6 0.4% · lv7 0.6% · lv8 0.8% · lv9 1.0% · lv10 1.2% attack power. It cancels out of most line ratios, but it shifts the balance between the square-root term and flat attack power." });
    h += '<div class="barrow">' +
      toggle("kit.stone", "9/7 stone",
        "A 9/7 ability stone is +1.5% attack power on top of the eleven gems. Turn it off for a 9/6 or worse.") +
      toggle("kit.master",
        "Master", "The Master ark-grid node. Shizu's ruling: it counts as +7% additional damage and nothing else, which overrides the sheet reading that also credits crit rate.") +
      "</div>";
    h += '<div class="note" data-gloss="The two percentage buckets these controls add up to. Weapon power = earring 1 + earring 2 + karma. Attack power = eleven gems + the ability stone. Both are overridable under Advanced.">' +
      "Weapon power bucket " + fx(wpPctOf(), 1) + "% · attack power bucket " + fx(baseApPctOf(), 1) + "%.</div>";
    box.innerHTML = h;
  }

  /** The one derived line under the gem slider that a drag has to keep honest. */
  function updateKitNote() {
    var box = $("bc-kit");
    if (!box) return;
    var n = box.getElementsByClassName("note");
    if (n.length) n[0].textContent = "Weapon power bucket " + fx(wpPctOf(), 1) +
      "% · attack power bucket " + fx(baseApPctOf(), 1) + "%.";
  }

  // ---- right column: FIGHT / TRAITS / SKILLS / ECONOMY ----

  function renderFight() {
    var h = "";
    h += slider("fight.back", "Back", 0, 100, 1, "pct",
      { gloss: "How much of your damage lands from behind. A back-attack line is multiplied by this before it scores, so drop it to 0 if you never hit the back." });
    h += slider("fight.front", "Front", 0, 100, 1, "pct",
      { gloss: "How much of your damage lands on the head or front. Scales the front-attack lines the same way." });
    h += slider("fight.nonDir", "Hitmaster", 0, 100, 1, "pct",
      { gloss: "How much of your damage comes from skills with no positional requirement — what the Hitmaster lines pay for. Awakening does not count." });
    h += slider("fight.cdWeight", "CD penalty wt", 0, 100, 1, "pct",
      { gloss: "Family 15 buys damage with +2% cooldown. At 100% you are judged on burst, where the extra cooldown never bites; at 0% on sustained, where the damage is divided by 1.02. 70% is the shipped assumption." });
    h += '<div class="barrow">' +
      toggle("fight.supportEffects", "Support effects",
        "On: you are the one bringing the party debuffs, so the four party lines (defense shred, crit-resist shred, crit-damage-resist shred, shielded-target damage) score in full. Off: your support already applies them — they apply once per party, so a copy on your bracelet is worth nothing.") +
      toggle("fight.demon", "Demon boss",
        "On: the fight is a Demon or Archdemon boss, so demon-damage lines score in full — still diluted by the demon damage you already carry from cards and pets. Off: they score nothing.") +
      "</div>";
    $("bc-fight").innerHTML = h;
  }

  function renderTraitWeights() {
    var h = "";
    h += slider("fight.wSpec", "Spec weight", 0, 4, 0.1, "pct1",
      { gloss: "What 100 points of Specialization is worth to your class, in % damage. There is no class table behind this — it is your call. A 120-point Spec line then scores value × weight ÷ 100." });
    h += slider("fight.wSwift", "Swift weight", 0, 4, 0.1, "pct1",
      { gloss: "What 100 points of Swiftness is worth to your class, in % damage. Crit needs no weight: it converts exactly, at 25 points of crit rate per 699 trait points, and is worth whatever that is to your skills." });
    $("bc-traitw").innerHTML = h;
  }

  /**
   * Skills stay TYPED (Shizu reversed the slider call for this block only):
   * a narrow name box and three compact number fields per skill. The share
   * field is still policed — the numbers always add to exactly 100.
   */
  function renderSkills() {
    var h = "", i, one = S.skills.length < 2;
    for (i = 0; i < S.skills.length; i++) {
      var s = S.skills[i];
      h += '<div class="bc-skill">' +
        '<div class="fld"><label>Name</label>' +
        '<input type="text" data-sk="' + i + '" data-f="name" value="' + esc(s.name || "") + '" placeholder="name" aria-label="Skill name"></div>' +
        '<div class="fld"><label data-gloss="How much of your damage this skill deals. The shares always add to exactly 100 — type one and the others move to make room. With a single skill it is locked at 100.">Share %</label>' +
        '<input id="bc-sk-share-' + i + '" type="number" step="1" min="0" max="100" data-sk="' + i + '" data-f="share" value="' + esc(s.share) + '"' +
        (one ? " disabled" : "") + "></div>" +
        '<div class="fld"><label data-gloss="This skill\'s crit rate before any bracelet line. A crit-rate line is capped at 100%, which is why it quietly dies on a high-crit build.">Crit rate %</label>' +
        '<input id="bc-sk-cr-' + i + '" type="number" step="0.1" data-sk="' + i + '" data-f="cr" value="' + esc(s.cr) + '"></div>' +
        '<div class="fld"><label data-gloss="What a crit deals, as a multiple. 280% means a crit hits for 2.8 times, not 3.8.">Crit dmg %</label>' +
        '<input id="bc-sk-cd-' + i + '" type="number" step="1" data-sk="' + i + '" data-f="cd" value="' + esc(s.cd) + '"></div>' +
        '<button class="bc-x" type="button" data-delsk="' + i + '"' + (one ? " disabled" : "") +
        ' title="Remove this skill">&times;</button>' +
        "</div>";
    }
    $("bc-skills").innerHTML = h;
  }

  // ---- economy: a linear baseline and a LOG gold slider ----
  // Gold per 1% spans two orders of magnitude, so the track is log10: position
  // 0-200 maps to 100k-10M, each step about +2.3%.
  var GPD_MIN = 100000, GPD_MAX = 10000000, GPD_STEPS = 200;
  function sig3(v) {
    if (!(v > 0)) return 0;
    var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10) - 2);
    return Math.round(v / e) * e;
  }
  function gpdPos(v) {
    v = clamp(num(v, GPD_MIN), GPD_MIN, GPD_MAX);
    return Math.round(GPD_STEPS * (Math.log(v) / Math.LN10 - 5) / 2);
  }
  function gpdFromPos(pos) {
    return sig3(Math.pow(10, 5 + (clamp(pos, 0, GPD_STEPS) / GPD_STEPS) * 2));
  }

  // ---- the two economy defaults, seeded from the character ----
  //
  // Ported from the astrogem calculator (loadout-econ.js cpToGpd, grader.js
  // gpdNoteHtml) so a bracelet and a gem are priced off the same ladder. 7.5M and
  // 10M are deliberately manual-only: nothing in a character page justifies them.
  function cpToGpd(cp) {
    if (cp == null || !isFinite(cp) || cp <= 0) return null;
    if (cp < 3500) return 500000;
    if (cp < 4500) return 1000000;
    if (cp < 5500) return 1500000;
    if (cp < 6500) return 2500000;
    if (cp < 7500) return 3500000;
    return 5000000;
  }
  /** astrogem's own short form: 2.5M, 500k. */
  function gpdLabel(g) {
    if (g >= 1000000) return (g / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    return (g / 1000).toFixed(0) + "k";
  }
  /** One character record, one key. A re-pull is a new key and re-seeds. */
  function charKey(c) {
    c = c || S.char;
    if (!c || !c.name) return null;
    return (c.region || "") + ":" + c.name + ":" + (c.pulledAt || 0);
  }
  function charCombatPower() {
    var c = S.char, cp = c && c.profile ? c.profile.combatPower : null;
    return (cp != null && isFinite(cp) && cp > 0) ? Number(cp) : null;
  }

  /**
   * The honesty pattern astrogem uses, word for word: while the live rate IS the
   * one combat power picked, the note says it was auto-set; the moment the user
   * drags the slider anywhere else it downgrades to a suggestion. Nothing is ever
   * claimed that the number on screen does not back up.
   */
  function gpdNoteHtml() {
    if (!hasCharacter()) return "";
    var cp = charCombatPower(), g = cpToGpd(cp);
    if (!g) {
      return '<div class="note bc-gpdnote">no combat power in this record — the gold rate is left where you had it</div>';
    }
    var n = cp.toLocaleString("en-US");
    return '<div class="note bc-gpdnote">' +
      (num(S.econ.gpd, 0) === g
        ? "auto-set " + gpdLabel(g) + " from combat power " + n
        : "combat power " + n + " suggests " + gpdLabel(g)) +
      "</div>";
  }

  function baselineNoteHtml() {
    if (!hasCharacter() || !S.econ.baseAutoKey) return "";
    var same = S.econ.baseAutoKey === charKey();
    return '<div class="note bc-basenote">' +
      (same
        ? "the bracelet " + esc(S.char.name) + " is wearing scores " + fx(num(S.econ.baseline, 0), 2) +
          "% — worth is what an upgrade over it would be worth"
        : "carried over from an earlier character; edit it to price against this one") +
      "</div>";
  }

  /**
   * Seed the two economy numbers from a freshly imported character. Each is
   * seeded ONCE per character key: a hand-picked rate or baseline is never
   * overwritten, and a re-render can never re-seed.
   *
   *   key         region:name:pulledAt
   *   combatPower drives the gold rate, through the ladder above
   *   currentPct  the character's CURRENT bracelet, in % damage, under the
   *               profile the numbers are being scored on
   */
  function seedEcon(o) {
    o = o || {};
    var key = o.key || charKey(), moved = false;
    if (!key) return false;
    if (S.econ.gpdAutoKey !== key) {
      var g = cpToGpd(o.combatPower);
      if (g) S.econ.gpd = g;                 // no combat power: leave the rate alone, and say so
      S.econ.gpdAutoKey = key;
      moved = true;
    }
    if (S.econ.baseAutoKey !== key && o.currentPct != null && isFinite(o.currentPct)) {
      // The bracelet they already wear IS the thing a new one has to beat, so it
      // is the honest baseline: worth then answers "what is upgrading worth",
      // not "what is this worth against no bracelet at all".
      //
      // Taken EXACTLY, not rounded down. The rounding was a workaround: worth was
      // (expected final − baseline) × gold back then, so a baseline a hair above
      // the score it came from turned a bracelet with no rolls left into a small
      // NEGATIVE worth. Worth is now the truncated expectation the model defines
      // — you are paid only by the outcomes that beat the baseline — so the same
      // bracelet reports zero, which is the true answer, and the workaround can go.
      S.econ.baseline = Math.max(0, num(o.currentPct, 0));
      S.econ.baseAutoKey = key;
      moved = true;
    }
    if (!moved) return false;
    save();
    if (deckEl) { renderEcon(); markProvenance(); }
    notify({ path: "econ", immediate: false, seeded: true });
    return true;
  }

  function renderEcon() {
    var h = '<div class="bc-sl">' +
      '<label class="lb" for="bc-gpd" data-gloss="What one percent of damage is worth to you in gold. It is a rate you choose, not a market read — the same convention the accessory and astrogem tools use, so a bracelet, an accessory and a gem can be priced against each other. Higher for a whale roster, lower for a fresh one. The track is logarithmic: 100k at the left, 10M at the right.">Gold per 1%</label>' +
      '<div class="tk"><input id="bc-gpd" type="range" data-gpd="1" min="0" max="' + GPD_STEPS + '" step="1" value="' + gpdPos(S.econ.gpd) + '"></div>' +
      '<span class="chip" id="bc-gpd-chip">' + esc(gold(num(S.econ.gpd, 0))) + "</span></div>";
    h += gpdNoteHtml();
    h += slider("econ.baseline", "Baseline %", 0, 25, 0.5, "pct1", {
      edit: true,
      gloss: "The bracelet you would wear instead. Worth counts only the rolls that BEAT it — how often they land, times how far they clear it, times gold per 1% — so leaving it at 0 prices this bracelet against no bracelet at all, and a bracelet that cannot clear the baseline is worth nothing rather than a negative number. Importing a character sets it to the bracelet that character is already wearing, which is the comparison that answers \"is upgrading worth it\". Click the number to type an exact one."
    });
    h += baselineNoteHtml();
    $("bc-econ").innerHTML = h;
  }

  function renderAdvanced() {
    var box = $("bc-adv");
    if (!box) return;
    box.style.display = S.advOpen ? "block" : "none";
    var b = $("bc-advtoggle");
    if (b) b.textContent = S.advOpen ? "Advanced ▴" : "Advanced ▾";
    if (!S.advOpen) { box.innerHTML = ""; return; }

    var h = '<div class="subh">Stat buckets</div><div class="ig">';
    h += fldNum("adv.msPct", "Main stat %", "0.1", "Everything multiplying raw main stat: 8% skins + 1% stronghold ranch by default.");
    h += fldNum("adv.karmaWp", "Karma weapon power %", "0.1", "Karma's share of the weapon-power bucket. The two earring lines are set in the Gear column.");
    h += fldChk("adv.baseApOverride", "Override attack power % (ignore the gem slider)",
      "By default the attack-power bucket is eleven gems at their level plus the ability stone. Tick this to type it instead.");
    h += fldNum("adv.baseApPct", "Attack power %", "0.1", "It cancels out of most ratios but shifts the balance between the square-root term and flat attack power.");
    h += fldNum("adv.flatAP", "Flat attack power", "1", "Ark-grid cores. Flat attack power is what stops a weapon-power line from being a pure square-root ratio.");
    h += fldNum("adv.accessoryMainStat", "Accessory main stat", "1", "Neck 17,857 + two earrings 13,889 + two rings 12,897, all at the top of their range with no flat-stat rolls.");
    h += fldNum("adv.rosterBonus", "Roster bonus", "1", "Main stat from roster level.");
    h += "</div>";

    h += '<div class="subh">Additional damage pool</div><div class="ig">';
    h += fldNum("adv.addWeapon", "Weapon quality %", "0.1", "A 100-quality weapon gives 30%.");
    h += fldNum("adv.addPet", "Pet %", "0.1", "Pet additional damage.");
    h += fldNum("adv.addAstrogem", "Astrogem grid %", "0.01", "60 grid levels × 0.080667% per level.");
    h += "</div>";
    h += '<div class="note">The necklace line and the Master node are in the Gear column.</div>';

    h += '<div class="subh">Fight assumptions</div><div class="ig">';
    h += fldNum("adv.staggerShare", "Stagger windows %", "1", "Share of your damage dealt while the boss is staggered.");
    h += fldNum("adv.demonBase", "Demon damage held %", "0.1", "Demon damage you already carry from cards and pets — it dilutes a demon line.");
    h += fldNum("adv.shieldUptime", "Shield uptime %", "1", "How much of the fight your party sits under a shield, for the shielded-target line.");
    h += fldNum("adv.enemyDR", "Enemy damage reduction %", "1", "The boss's damage reduction before any shred. It sets how much a defense shred is worth: gain = (D+K)/(D(1−A)+K).");
    h += fldNum("adv.allyCount", "Ally DPS in party", "1", "How many other damage dealers share your party debuffs. Each is assumed to deal what you deal before the line.");
    h += slider("adv.atkSpeedPer10", "Attack speed value", 0, 3, 0.1, "pct1", {
      edit: true,
      gloss: "What 10% attack speed is worth in damage, through the extra casts it buys. Default 1%. It drives the Attack & Move Speed line and the speed half of the stacking weapon-power line."
    });
    h += "</div>";
    h += '<div class="note">The conditional weapon-power families (20, 21 and 22) are no longer knobs: they are scored at max stacks and full uptime.</div>';

    h += '<div class="subh">Fixed lines (come with the drop, never rerolled)</div>';
    h += '<div class="bc-sub">Optional, and separate from the two combat traits above. They score their own damage and they lock their family and category slot out of every future roll, so they change what an empty bracelet is worth.</div>';
    h += '<div id="bc-fixedrows"></div>';
    h += '<div class="barrow"><button class="mbtn" id="bc-addfixed" type="button"' + (S.fixedRows.length >= 2 ? " disabled" : "") + '>+ Add fixed line</button></div>';

    box.innerHTML = h;
    var apField = $(fldId("adv.baseApPct"));
    if (apField && !S.adv.baseApOverride) { apField.value = fx(baseApPctOf(), 2); apField.disabled = true; }
    fireAdvanced();
  }

  /**
   * The fixed-line editor's ROWS are drawn by whoever owns the bracelet-line
   * pickers (app.js): the fold is a deck control, but a bracelet row is not.
   * Every hook is called after the fold renders, with #bc-fixedrows already in
   * the document. Unregistered, the container simply stays empty.
   */
  var advHooks = [];
  function fireAdvanced() {
    for (var i = 0; i < advHooks.length; i++) {
      try { advHooks[i]($("bc-fixedrows")); } catch (e) {}
    }
  }

  /** Every input control, rebuilt. Used by mount, by Reset and by a shape change. */
  function renderAll() {
    if (!deckEl) return;
    renderProvStrip();
    renderTop(); renderGear(); renderKit(); renderFight(); renderTraitWeights();
    renderSkills(); renderEcon(); renderAdvanced();
    markProvenance();
    applyFold();
    // With a character loaded the header's control row carries this pair, so the
    // deck's own copy would be the third button doing the same thing.
    var rb = $("bc-reset");
    if (rb) rb.style.display = hasCharacter() ? "none" : "";
    ctlRepaint();
  }

  /**
   * Every cluster that has drawn a copy of the control row, so an import or a
   * reset repaints all of them without each tab wiring its own subscription.
   * Entries whose element has left the document are dropped on the next pass —
   * every tab rebuilds its host markup wholesale, so stale ones are normal.
   */
  var ctlHosts = [];
  function pruneCtlHosts() {
    for (var i = ctlHosts.length - 1; i >= 0; i--) {
      var e = ctlHosts[i];
      if (!e.host || !e.host.parentNode) ctlHosts.splice(i, 1);
    }
  }
  function paintCtlHost(e) {
    var row = e.host.getElementsByClassName("bc-ctlstack")[0];
    if (!row) {
      // Only this row is ever rewritten. #bc-top is a LIVE element that moves
      // between clusters, so it must not be inside anything we innerHTML.
      row = document.createElement("div");
      row.className = "bc-ctlstack";
      e.host.insertBefore(row, e.host.firstChild);
    }
    row.innerHTML = charControlsHtml();
  }
  function ctlRepaint() {
    pruneCtlHosts();
    for (var i = 0; i < ctlHosts.length; i++) paintCtlHost(ctlHosts[i]);
  }

  /**
   * A tab hands over its right-hand control cluster: the character's two
   * buttons, and — unless it says otherwise — the bracelet's three settings.
   *
   * `opts.withTop === false` leaves those three where they are. The Calculator
   * passes it, because they live in its Grader panel now (see
   * adoptBraceletPanel) and a cluster repaint must never drag them back into the
   * banner. Every other tab has no Grader to put them in, so they still ride
   * along with the cluster and the tab that asked last keeps them.
   */
  function mountCharControls(hostEl, opts) {
    if (!hostEl) return null;
    pruneCtlHosts();
    var i, e = null;
    for (i = 0; i < ctlHosts.length; i++) if (ctlHosts[i].host === hostEl) { e = ctlHosts[i]; break; }
    if (!e) { e = { host: hostEl }; ctlHosts.push(e); }
    paintCtlHost(e);
    if ((!opts || opts.withTop !== false) && onScreen(hostEl)) {
      var top = buildTop();
      if (top.parentNode !== hostEl) { hostEl.appendChild(top); renderTop(); }
    }
    return hostEl;
  }

  /**
   * Is this element in the tab the user is looking at?
   *
   * The one movable control may only ever be taken by the VISIBLE tab. The Tier
   * List redraws its control cluster on every profile change, tab or no tab, and
   * that redraw used to pull the bracelet's three settings into a hidden pane —
   * so grade, granted slots and rolls left simply disappeared off the Calculator
   * while the user was working in it, with no tab switch involved (2026-08-11).
   * Anything outside a tab pane altogether is treated as on screen.
   */
  function onScreen(el) {
    var pane = el && el.closest ? el.closest(".tabpane") : null;
    return !pane || pane.className.indexOf("active") >= 0;
  }

  // ------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------

  /** Rebuild markup, then put the cursor back on the element it was on. */
  function keepFocus(fn) {
    var a = document.activeElement, id = (a && a.id) ? a.id : null;
    fn();
    if (id) { var el = $(id); if (el && el.focus) el.focus(); }
  }

  var SHAPE_FIELDS = { grade: 1, slots: 1, useOverride: 1 };

  /**
   * `settled` is false while a range is still under the mouse. It matters for
   * the two shape fields that are now sliders: rebuilding the whole deck on
   * every step of a drag tears the slider out from under the cursor, so the
   * rebuild waits for the change event the browser fires on release.
   */
  /**
   * The tail EVERY control shares once its state path has moved.
   *
   * It was extracted because the segmented pills had grown their own shorter
   * copy of it, and that copy quietly dropped everything a SHAPE change needs:
   * pick Relic and the slot pills went on offering 3, the row count never
   * followed, and a cut in progress survived a bracelet it no longer described
   * (Shizu, 2026-08-11 — "i dont think the grade and granted slot buttons really
   * work at all"). One tail, so a control cannot half-apply a change again.
   *
   *   o.immediate  a press, not a drag — the subscriber should solve now
   *   o.rebuild    false while a range is still under the mouse
   *   o.also       extra renderers, run only when the path is NOT a shape field
   *                (a shape field rebuilds every control anyway)
   */
  function afterPathChange(path, o) {
    o = o || {};
    if (path === "grade" || path === "slots") { S.locks = null; S.rolled = null; }
    var unmarked = clearProv(path);
    save();
    if (SHAPE_FIELDS[path]) {
      if (path === "grade") fitTraits();
      fitRows();
      if (o.rebuild !== false) keepFocus(renderAll);
    } else if (o.also) {
      keepFocus(o.also);
    }
    if (unmarked) { renderProvStrip(); markProvenance(); }
    notify({ path: path, shape: !!SHAPE_FIELDS[path], immediate: !!o.immediate });
  }

  function onFieldChange(el, settled) {
    var path = el.getAttribute && el.getAttribute("data-k"), t = el.getAttribute("data-t");
    if (!path) return false;
    if (t === "chk") setPath(S, path, !!el.checked);
    else if (t === "rng") setPath(S, path, Number(el.value));
    else if (t === "num") setPath(S, path, num(el.value, getPath(S, path)));
    else setPath(S, path, isNaN(Number(el.value)) ? el.value : Number(el.value));
    if (path === "rollsLeft") S.rollsTotal = Math.max(S.rollsTotal, num(el.value, 7));
    if (t === "rng") {
      // Mid-drag: repaint the chip and the derived read-outs only. Rebuilding
      // the control would tear the slider out from under the mouse.
      var chip = $(chipId(path)), f = FMT[el.getAttribute("data-fmt")] || FMT.raw;
      if (chip) chip.textContent = f(Number(el.value));
      if (path.indexOf("gear.") === 0) updateIlvl();
      if (path === "kit.gems") updateKitNote();
    }
    var also = null;
    if (path === "adv.baseApOverride") {
      also = function () { renderKit(); renderAdvanced(); markProvenance(); };
    } else if (path.indexOf("adv.") === 0) {
      // Karma and the attack-power override feed the two derived buckets the
      // Gear column prints; refresh that line without rebuilding the field.
      updateKitNote();
    }
    afterPathChange(path, { rebuild: (t !== "rng" || settled !== false), also: also });
    return true;
  }

  /** Turn a value chip into a small number input, and back on blur or Enter. */
  function editChip(chip, get, set) {
    if (chip.getElementsByTagName("input").length) return;
    var lo = Number(chip.getAttribute("data-min")), hi = Number(chip.getAttribute("data-max"));
    var step = num(chip.getAttribute("data-step"), 1);
    var inp = document.createElement("input");
    inp.type = "number"; inp.min = lo; inp.max = hi; inp.step = step < 1 ? "0.01" : "1"; inp.value = get();
    chip.textContent = "";
    chip.appendChild(inp);
    inp.focus();
    inp.select();
    // Blur and change both mean "done"; whichever lands first closes the box.
    var closed = false;
    function finish(keep) {
      if (closed) return;
      closed = true;
      if (keep !== false) {
        var v = clamp(num(inp.value, get()), lo, hi);
        set(step < 1 ? Math.round(v * 100) / 100 : Math.round(v));
        save();
      }
      renderAll();
      notify({ immediate: true });
    }
    inp.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") finish();
      else if (ev.key === "Escape") finish(false);
      ev.stopPropagation();
    });
    inp.addEventListener("blur", function () { finish(); });
    inp.addEventListener("change", function (ev) { ev.stopPropagation(); finish(); });
    inp.addEventListener("input", function (ev) { ev.stopPropagation(); });
  }

  function bindDeck(panel) {
    function fieldEvent(e) {
      var el = e.target;
      if (el.id === "bc-gpd") {
        S.econ.gpd = gpdFromPos(Number(el.value));
        var gc = $("bc-gpd-chip");
        if (gc) gc.textContent = gold(S.econ.gpd);
        save();
        notify({ path: "econ.gpd", immediate: false });   // gold is not in the solve key: a cache hit
        return;
      }
      if (el.getAttribute && el.getAttribute("data-sk") !== null && el.getAttribute("data-f")) {
        var i = Number(el.getAttribute("data-sk")), f = el.getAttribute("data-f");
        if (!S.skills[i]) return;
        if (f === "name") S.skills[i].name = el.value;
        else if (f === "share") {
          // An empty or half-typed box must not rebalance to nonsense; wait for
          // a number, then move the others to keep the total at exactly 100.
          if (el.value === "" || isNaN(Number(el.value))) return;
          setShare(i, el.value);
          syncShares(i);
        } else S.skills[i][f] = num(el.value, S.skills[i][f]);
        if (clearProv("skills." + i + "." + f)) { renderProvStrip(); markProvenance(); }
        save();
        notify({ path: "skills", immediate: false });
        return;
      }
      onFieldChange(el, e.type !== "input");
    }
    // Selects fire input then change; both paths are idempotent.
    panel.addEventListener("input", fieldEvent);
    panel.addEventListener("change", fieldEvent);

    // Leaving a share box snaps it to the number actually stored, so a typed
    // 150 or an emptied box cannot sit there contradicting the total.
    panel.addEventListener("focusout", function (e) {
      var el = e.target;
      if (!el.getAttribute || el.getAttribute("data-f") !== "share") return;
      var i = Number(el.getAttribute("data-sk"));
      if (!S.skills[i]) return;
      if (el.value === "" || isNaN(Number(el.value))) { setShare(i, S.skills[i].share); save(); }
      renderSkills(); markProvenance();
      notify({ path: "skills", immediate: false });
    });

    panel.addEventListener("click", function (e) {
      var t = e.target, d, seg, tgl, chip;
      // A click can land on the chip's own text node in some browsers.
      if (t && t.className && String(t.className).indexOf("chip") >= 0) chip = t;

      if ((seg = t.getAttribute && t.getAttribute("data-seg"))) {
        // Slot counts are numbers and grade is a string, so the coercion has to
        // look at the value rather than assume either.
        var raw = t.getAttribute("data-v");
        setPath(S, seg, (raw !== "" && !isNaN(Number(raw))) ? Number(raw) : raw);
        // Through the SHARED tail, not a shortened copy of it: grade and slots
        // are shape fields, and a shape change has to void the cut, re-fit the
        // traits and the rows, and rebuild the pills so the slot counts on
        // offer are the ones the new grade allows.
        afterPathChange(seg, {
          immediate: true,
          also: function () { renderProvStrip(); renderKit(); renderAdvanced(); markProvenance(); }
        });
        return;
      }
      if ((tgl = t.getAttribute && t.getAttribute("data-tgl"))) {
        setPath(S, tgl, !getPath(S, tgl));
        afterPathChange(tgl, {
          immediate: true,
          also: function () { renderProvStrip(); renderKit(); renderFight(); renderAdvanced(); markProvenance(); }
        });
        return;
      }
      if (chip && chip.getAttribute("data-editk")) {
        var ep = chip.getAttribute("data-editk");
        clearProv(ep);
        editChip(chip, function () { return getPath(S, ep); }, function (v) { setPath(S, ep, v); });
        return;
      }

      if (t.id === "bc-addskill") {
        S.skills.push({ name: "", share: 0, cr: 90, cd: 280 });
        normalizeShares();                       // a new skill enters at an equal share
        var eq = distribute((function () { var w = [], j; for (j = 0; j < S.skills.length; j++) w.push(1); return w; })(), 100), j2;
        for (j2 = 0; j2 < S.skills.length; j2++) S.skills[j2].share = eq[j2];
        save(); renderSkills(); markProvenance();
        notify({ path: "skills", immediate: true });
      } else if (t.getAttribute && (d = t.getAttribute("data-delsk")) !== null && d !== "") {
        if (S.skills.length > 1) {
          S.skills.splice(Number(d), 1);
          normalizeShares();
          save(); renderSkills(); markProvenance();
          notify({ path: "skills", immediate: true });
        }
      } else if (t.id === "bc-advtoggle") { S.advOpen = !S.advOpen; save(); renderAdvanced(); markProvenance(); }
      else if (t.id === "bc-addfixed") {
        if (S.fixedRows.length < 2) { S.fixedRows.push(blankRow()); save(); renderAdvanced(); notify({ path: "fixedRows", immediate: false }); }
      } else if (t.id === "bc-reset") { resetCharacter(); }
    });

    // The whole header row collapses the panel, not just the little arrow.
    var hdr = panel.getElementsByClassName("ihdr")[0];
    if (hdr) hdr.addEventListener("click", function () {
      S.deckOpen = !S.deckOpen;
      save();
      applyFold();
    });
  }

  /**
   * Open or shut the deck body to match S.deckOpen.
   *
   * The deck starts SHUT — on every tab that mounts it. The thing a visitor came
   * for is the score and the table under it, not thirty controls; the controls
   * are one click away and the choice sticks from then on.
   */
  function applyFold() {
    var body = $("bc-inputs-body"), c = $("bc-caret");
    if (!body) return;
    body.style.display = S.deckOpen ? "" : "none";
    if (c) c.innerHTML = S.deckOpen ? "&#9662;" : "&#9656;";
  }

  /**
   * The Bracelet panel is app.js's markup, but two of its parts belong to the
   * deck's own vocabulary: the panel is the GRADER (astrogem's word for the
   * "score a finished item" panel), and it needs the bracelet-scoped reset that
   * pairs with the character-scoped one down in the deck. Both are added here,
   * once, by adoption rather than by editing another module's markup — and both
   * checks are exact, so if app.js ever grows them itself this quietly does
   * nothing.
   */
  function adoptBraceletPanel() {
    var panel = document.getElementById("bc-braceletpanel");
    if (!panel) return;
    // The bracelet's own three settings live HERE, in the panel that grades the
    // bracelet — not in the character banner, which is rebuilt on every repaint
    // and is not drawn at all until a character is loaded. Another tab may have
    // borrowed the element (see mountCharControls); this claims it back, so it
    // runs before the early return below rather than after it.
    var host = document.getElementById("bc-tophost");
    if (host && onScreen(host)) {
      var top = buildTop();
      if (top.parentNode !== host) host.appendChild(top);
      renderTop();
    }
    var hdr = panel.getElementsByClassName("bc-hdrow")[0];
    if (!hdr) return;
    var h2 = hdr.getElementsByTagName("h2")[0];
    if (h2 && h2.firstChild && h2.textContent === "Bracelet") h2.textContent = "Grader — score a bracelet";
    if (document.getElementById("bc-resetbracelet")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "mbtn";
    b.id = "bc-resetbracelet";
    b.textContent = "Reset bracelet";
    b.setAttribute("data-gloss", "Clears the granted rows, the fixed lines, any locks and this session's rolls, and puts the two combat traits back to their default values. Your character settings are left alone.");
    b.addEventListener("click", function () { resetBracelet(); });
    hdr.appendChild(b);
  }

  // ------------------------------------------------------------------
  // the one deck element
  // ------------------------------------------------------------------

  /**
   * The bracelet's three settings, as one element that lives outside the deck.
   *
   * Built detached and parented into the Grader panel's #bc-tophost on the first
   * mount, so renderTop() always has something to write into — even on the Tier
   * List, which has no Grader and borrows the element into its control cluster
   * instead. The Calculator claims it back on activation.
   */
  var topEl = null;
  function buildTop() {
    if (topEl) return topEl;
    injectStyle();
    topEl = document.createElement("div");
    topEl.id = "bc-top";
    topEl.className = "bc-brachdr";
    // The pills and the slider are bound by the deck's own delegated listeners,
    // which are on the deck element — this one needs its own copy.
    bindDeck(topEl);
    return topEl;
  }

  var deckEl = null;
  function buildDeck() {
    if (deckEl) return deckEl;
    injectStyle();
    var tmp = document.createElement("div");
    tmp.innerHTML = deckMarkup();
    deckEl = tmp.firstChild;
    while (deckEl && deckEl.nodeType !== 1) deckEl = deckEl.nextSibling;
    bindDeck(deckEl);
    return deckEl;
  }

  // ------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------

  load();
  fitRows();

  var Profile = {
    get: function () { return S; },
    /**
     * The model's view of the deck — the ONE profile every tab scores on. There
     * is no second answer any more: the default/character toggle is gone, and
     * the deck simply starts at the canonical defaults.
     */
    profile: function () { return buildProfile(); },

    /** Put the character's two buttons in hostEl. Every tab draws the same row. */
    mountCharControls: mountCharControls,

    /** Merge a patch (one level deep for the nested blocks), persist, notify. */
    set: function (patch) {
      if (!patch) return S;
      var k;
      for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) {
        if (NESTED[k] && patch[k] && S[k]) {
          for (var a in patch[k]) if (Object.prototype.hasOwnProperty.call(patch[k], a)) S[k][a] = patch[k][a];
        } else {
          S[k] = patch[k];
        }
      }
      fitRows();
      save();
      renderAll();
      notify({ shape: true, immediate: true, set: true });
      return S;
    },

    /**
     * Put the control deck inside hostEl. There is ONE deck (see the header): this
     * MOVES it, so the tab that called mount() last owns it.
     */
    mount: function (hostEl) {
      if (!hostEl) return null;
      var el = buildDeck();
      if (el.parentNode !== hostEl) hostEl.appendChild(el);
      renderAll();
      adoptBraceletPanel();
      return el;
    },
    /** Where the deck is right now, or null before the first mount. */
    host: function () { return deckEl ? deckEl.parentNode : null; },

    onChange: function (cb) {
      if (typeof cb !== "function") return function () {};
      listeners.push(cb);
      return function () {
        var i = listeners.indexOf(cb);
        if (i !== -1) listeners.splice(i, 1);
      };
    },

    /** Everything, character and bracelet, back to defaults. No UI reaches this. */
    reset: function () {
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
      assignInto(S, defaults());
      fitRows();
      renderAll();
      notify({ reset: true, shape: true, immediate: true });
    },
    /**
     * The two scoped resets the panel's buttons call. Neither asks first, and
     * neither crosses the line between the character and the bracelet.
     */
    resetCharacter: resetCharacter,
    resetBracelet: resetBracelet,

    // ---- state maintenance the other modules need ----
    save: save,                 // after a direct mutation (the cut flow rewrites rows)
    fit: fitRows,               // re-fit rows / traits / shares after a direct mutation
    render: renderAll,          // redraw every control (after a direct mutation)
    blankRow: blankRow,
    notify: notify,

    // ---- derived numbers, shared with every tab ----
    ilvl: ilvlExact,
    baseStats: baseStats,
    wpPct: wpPctOf,
    baseApPct: baseApPctOf,
    traitBand: traitBand,
    traitValues: traitValues,
    traitWeights: traitWeights,
    traitOnCount: traitOnCount,
    TRAIT_KEYS: TRAIT_KEYS,
    TRAIT_LABELS: TRAIT_LABELS,

    // ---- family letters (the picker's, and the Tier List's, single source) ----
    famGrades: famGrades,
    letterOf: letterOf,
    GRADE_COLOR: GRADE_COLOR,
    JUNK: JUNK,

    // ---- provenance ----
    applyImported: applyImported,
    /**
     * "Import Character Stats": the loaded character's own gear into the whole
     * left column, marked and editable. Returns how many paths it wrote. Nobody
     * calls this on load — that is the point of the button.
     */
    importCharacterStats: importCharacterStats,
    /** Is there anything on the loaded record to import? */
    canImportStats: canImportStats,

    // ---- the two economy defaults ----
    /** Seed gold-per-1% and the baseline from a character. Once per character. */
    seedEcon: seedEcon,
    /** The astrogem calculator's combat-power ladder, for anyone else who needs it. */
    cpToGpd: cpToGpd,
    /** region:name:pulledAt — the key a seed is remembered against. */
    charKey: charKey,
    provCount: provCount,
    character: function () { return S.char; },
    setCharacter: function (c) { S.char = c || null; save(); renderProvStrip(); },

    /** Register a renderer for the Advanced fold's fixed-line rows. */
    onAdvancedRender: function (cb) {
      if (typeof cb !== "function") return function () {};
      advHooks.push(cb);
      return function () {
        var i = advHooks.indexOf(cb);
        if (i !== -1) advHooks.splice(i, 1);
      };
    }
  };

  window.Profile = Profile;
})();
