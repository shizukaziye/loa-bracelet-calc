/**
 * app.js — the Calculator tab: the whole tool for now.
 *
 * Layout (astrogem-grader house style: sticky inputs panel, then results):
 *   CHARACTER  grade / slots / rolls, honing levels or a raw WP+main-stat
 *              override, an "Advanced" fold for the long tail, a skills editor
 *              and the gold-per-1%-damage economy pair.
 *   BRACELET   one row per granted slot — family picker (grouped and priced),
 *              tier, and a value box for the basic-stat families. All rows empty
 *              means an unrolled bracelet, which is the default.
 *   RESULTS    headline cards, the roll advisor (best locks, P(improve), the
 *              spread of final scores), the cut flow, and a per-line breakdown.
 *
 * THE MATH IS NOT HERE. Every number comes from window.Bracelet (model/bracelet.js),
 * which this file only ever reads:
 *   Bracelet.solve({grade, profile, fixedLines, grantedLines, slots, rollsLeft, …})
 *   Bracelet.advise(ctx, {current, rolled, rollsLeft})   — keep or replace
 *   Bracelet.lineDamage / lineInfo / damagePercent / deriveBaseline / attackPower
 *
 * WHY A WORKER. A three-slot, seven-roll solve is ~48,000 states and ~3 s. Run
 * on the main thread it freezes the page on every keystroke, so solve() lives in
 * solver-worker.js: one request in flight, later requests queued and collapsed,
 * stale answers dropped by id, results cached by a canonical state key. Input
 * changes are debounced ~300 ms. Gold never enters the key — value is
 * (expectedFinal − baseline) × gpd, recomputed here for free.
 *
 * State (inputs + bracelet + cut history) persists under one versioned
 * localStorage key; "Reset" wipes it.
 */
(function () {
  "use strict";

  var B = window.Bracelet, DATA = window.BraceletData;
  if (!B || !DATA) return;                       // model failed to load; leave the shell alone

  var LS_KEY = "loa-bracelet-calc.v1";
  var TIERS = DATA.TIERS;                        // ["low","mid","high"]
  var PARTY_IDS = { 16: 1, 17: 1, 18: 1, 19: 1 };
  var DEBOUNCE_MS = 300;

  // ------------------------------------------------------------------
  // small helpers
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
  function signPct(d) { return (d >= 0 ? "+" : "") + fx(d, 2) + "%"; }
  // D (log-space score) -> the exact combined damage percentage.
  function pct(D) { return B.damagePercent(D); }

  // Gold always converts the EXACT damage percentage, never the log-space score,
  // so the arithmetic on screen matches the percentages printed beside it.
  function gpd() { return num(S.econ.gpd, 0); }
  function valueGold(D) { return (pct(D) - num(S.econ.baseline, 0)) * gpd(); }
  function deltaGold(Da, Db) { return (pct(Da) - pct(Db)) * gpd(); }

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
      fight: { back: 100, front: 100, nonDir: 100, cdWeight: 70, demon: false, wSpec: 2.5, wSwift: 2.5 },
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
        allyCount: 2
      },
      skills: [{ name: "", share: 100, cr: 90, cd: 280 }],
      econ: { gpd: 1500000, baseline: 0 },
      rows: [blankRow(), blankRow(), blankRow()],
      fixedRows: [],
      advOpen: false,
      locks: null,                   // per-slot booleans in the cut flow; null = follow the model
      rolled: null,                  // per-slot rows entered in the cut flow
      history: []
    };
  }

  // Per-gem base attack power by gem level; eleven of them plus a 9/7 stone.
  var GEM_AP = { 6: 0.4, 7: 0.6, 8: 0.8, 9: 1.0, 10: 1.2 };
  var STONE_AP = 1.5;
  // Slider order, Shizu's: armour first, the weapon last because it is the one
  // piece that moves weapon power.
  var PIECES = [["head", "Head"], ["shoulder", "Shoulder"], ["chest", "Chest"],
    ["pants", "Pants"], ["gloves", "Gloves"], ["weapon", "Weapon"]];

  /** Weapon-power % bucket = the two earring lines + karma. */
  function wpPctOf() { return num(S.kit.ear1, 0) + num(S.kit.ear2, 0) + num(S.adv.karmaWp, 0); }
  /** Attack-power % bucket = eleven gems at their level + the ability stone. */
  function baseApPctOf() {
    if (S.adv.baseApOverride) return num(S.adv.baseApPct, 0);
    var per = GEM_AP[Math.round(num(S.kit.gems, 9))] || 0;
    return 11 * per + (S.kit.stone ? STONE_AP : 0);
  }
  // ---- combat traits ----
  var TRAIT_KEYS = ["crit", "spec", "swift"];
  var TRAIT_LABELS = { crit: "Crit", spec: "Spec", swift: "Swiftness" };
  var TRAIT_GLOSS = {
    crit: "The Crit trait line your bracelet came with, in trait points. It converts exactly — 25 percentage points of crit rate per 699 trait points — and then runs through your skills' own crit numbers, so it is worth nothing to a build already at 100% crit.",
    spec: "The Specialization trait line your bracelet came with, in trait points. It scores at the Spec weight you set in the Traits block: value × weight ÷ 100.",
    swift: "The Swiftness trait line your bracelet came with, in trait points. It scores at the Swiftness weight you set in the Traits block: value × weight ÷ 100."
  };
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

  /** The live item level: the mean of the six piece item levels, unrounded. */
  function ilvlExact() {
    var G = window.BraceletGearData, s = 0, i;
    if (!G) return 0;
    for (i = 0; i < PIECES.length; i++) s += G.ILVL0 + G.ILVL_STEP * num(S.gear[PIECES[i][0]], 0);
    return s / 6;
  }

  var S = defaults();

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
      if (k === "adv" || k === "gear" || k === "ov" || k === "econ" || k === "kit" || k === "fight" || k === "traits") {
        for (var a in d[k]) if (got[k][a] !== undefined && got[k][a] !== null) d[k][a] = got[k][a];
      } else {
        d[k] = got[k];
      }
    }
    S = d;
    fitRows();
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

  /** How many combat traits are switched on right now. Two is the legal count. */
  function traitOnCount() {
    var n = 0, i;
    for (i = 0; i < TRAIT_KEYS.length; i++) if (S.traits[TRAIT_KEYS[i]].on) n++;
    return n;
  }

  // ------------------------------------------------------------------
  // state -> model profile
  // ------------------------------------------------------------------

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
      demonBase: a.demonBase / 100,
      shieldUptime: a.shieldUptime / 100,
      allyDpsCount: a.allyCount,
      allyCritRate: 0.90, allyCritDamage: 2.8,
      enemyBaseDR: a.enemyDR / 100,
      cooldownPenaltyWeight: S.fight.cdWeight / 100,
      // Families 20/21/22 are hard assumptions now (max stacks, full uptime);
      // leaving them out lets the model's own defaults stand.
      atkMoveSpeedDamagePerPct: 0
    });
  }

  // ------------------------------------------------------------------
  // rows <-> model lines
  // ------------------------------------------------------------------

  function msBands() { return DATA.BASIC.bands; }
  function msRange(grade, fam) {
    var b = msBands();
    return [b[0][grade][fam][0], b[b.length - 1][grade][fam][1]];
  }
  function defaultBasicValue(grade, fam) {
    return Math.round(B.basicBandExpected(fam, grade));
  }

  function rowToLine(r, grade, junkFam) {
    if (!r || !r.fam || r.fam === "none") return null;
    if (r.fam === JUNK) {
      // "Junk Line" is one option standing in for every zero-damage family (see
      // junkFamPool). It still needs A family to be a legal line, so the caller
      // hands us a stand-in — a different one per slot, so two junk slots never
      // read as a duplicate roll.
      var jf = junkFam || junkFamPool(grade)[0];
      return { cat: "special", family: jf, tier: "low", junk: true };
    }
    if (r.fam.indexOf("basic:") === 0) {
      var fam = r.fam.slice(6);
      var v = (r.value === null || r.value === undefined || r.value === "") ? defaultBasicValue(grade, fam) : num(r.value, defaultBasicValue(grade, fam));
      var rg = msRange(grade, fam);
      return { cat: "basic", family: fam, value: clamp(v, rg[0], rg[1]) };
    }
    if (r.fam.indexOf("trait:") === 0) return { cat: "trait", family: r.fam.slice(6) };
    return { cat: "special", family: Number(r.fam.slice(3)), tier: r.tier || "mid" };
  }

  function linesOf(rows, grade, reps) {
    var out = [], i, l;
    reps = reps || [];
    for (i = 0; i < rows.length; i++) { l = rowToLine(rows[i], grade, reps[i]); if (l) out.push(l); }
    return out;
  }

  function familyIdOf(line) {
    if (line.cat === "basic") return "basic:" + line.family;
    if (line.cat === "trait") return "trait:" + line.family;
    return "special:" + line.family;
  }

  /**
   * The solver's own label for a line — the "state atom key". Lines that score
   * nothing all collapse into one interchangeable atom per category, which is
   * exactly how the solver keeps its alphabet small; the roll advisor reports
   * locks by these keys, so this is how a lock maps back to a slot on screen.
   */
  function stateKeyOf(line, grade, profile) {
    var d = B.lineDamage(line, grade, profile);
    if (Math.abs(d) <= 1e-12) return "junk:" + line.cat;
    if (line.cat === "basic") {
      var bands = msBands();
      for (var b = 0; b < bands.length; b++) {
        var rg = bands[b][grade][line.family];
        if (line.value >= rg[0] && line.value <= rg[1]) return "basic:" + line.family + ":b" + b;
      }
      return "basic:" + line.family + ":b0";
    }
    if (line.cat === "trait") return "trait:" + line.family;
    return "special:" + line.family + ":" + line.tier;
  }

  /** Duplicate families and the per-category caps are both illegal in game. */
  function validateSet(lines) {
    var seen = {}, cnt = { basic: 0, trait: 0, special: 0 }, i;
    for (i = 0; i < lines.length; i++) {
      var f = familyIdOf(lines[i]);
      if (seen[f]) return "two lines share the same effect — a bracelet cannot roll a duplicate.";
      seen[f] = 1;
      cnt[lines[i].cat]++;
    }
    if (cnt.basic > DATA.CAPS.basic) return "more than " + DATA.CAPS.basic + " basic-stat lines.";
    if (cnt.trait > DATA.CAPS.trait) return "more than " + DATA.CAPS.trait + " combat-trait lines.";
    if (cnt.special > DATA.CAPS.special) return "more than " + DATA.CAPS.special + " special effects.";
    return null;
  }

  // Fixed rows keep the full family list, so they never carry a junk sentinel.
  function fixedLines() { return linesOf(S.fixedRows, S.grade); }
  function grantedLines() { return linesOf(S.rows, S.grade, junkReps()); }
  function isUnrolled() { return grantedLines().length < S.slots; }
  function isPartial() { var n = grantedLines().length; return n > 0 && n < S.slots; }

  // ------------------------------------------------------------------
  // family picker: grouped, priced, coloured
  // ------------------------------------------------------------------

  function famGroupOf(fam) {
    if (PARTY_IDS[fam.id]) return "Party";
    var wp = false, only = true, i;
    for (i = 0; i < fam.comp.length; i++) {
      var k = fam.comp[i].k;
      if (k === "weaponPower") wp = true;
      else if (k !== "atkMoveSpeed") only = false;
    }
    return (wp && only) ? "Weapon Power" : null;      // null = decide by the family grade
  }

  // ---- the granted-slot picker ----
  //
  // The FAMILY box names the family and nothing else, prefixed by a letter
  // grade. Roll values belong to the TIER box: they are a property of the tier,
  // not of the family, and showing them twice confused the picker. The letters
  // come from the canonical default profile (Bracelet.familyGrades), so they
  // label the family rather than the current build and never shuffle mid-edit.

  // The astrogem calculator's rank palette, so a letter reads the same across
  // the two tools. D and F share the grey, as they do there.
  var GRADE_COLOR = { S: "#cc5c81", A: "#7e5cc0", B: "#3b7fd0", C: "#4f9d5d", D: "#6f747a", F: "#6f747a" };
  // Our low / mid / high are the game's Rare / Epic / Legendary rarities.
  var TIER_META = {
    low: { label: "Rare", color: "#5aa9e6" },
    mid: { label: "Epic", color: "#c78cff" },
    high: { label: "Legendary", color: "#ffb86b" }
  };

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

  // ---- "Junk Line": every F family under one option ----
  //
  // Fifteen of the families a granted slot can roll score exactly nothing —
  // Vitality, all six combat traits and thirteen of the specials — and the
  // model already treats them as one interchangeable atom. Listing them
  // separately was fifteen rows of noise, so the granted picker shows a single
  // "Junk Line" entry (Shizu, 2026-08-11). The FIXED-line editor keeps the full
  // list: see the note on junkFamPool.
  var JUNK = "junk";

  /**
   * The stand-in families a "Junk Line" pick resolves to, lightest listed
   * weight first. They are all specials, deliberately:
   *
   *   - Which one we pick cannot change a granted slot's answer. A junk line is
   *     never locked (the solver's allowLockJunk is off), so it is always
   *     rerolled away and never enters buildPool's present-family set or its
   *     per-category count. Solving the same bracelet with a junk trait, with
   *     Vitality and with a junk special returns bit-identical numbers.
   *   - The category still has to be plausible for the CAP check in
   *     validateSet, which a granted set does run. Specials cap at five, so
   *     three junk slots plus two fixed lines always fit; traits cap at TWO, so
   *     resolving junk to a trait would make three junk slots illegal.
   *   - All thirteen score zero for every profile, not just the default one, so
   *     "Junk Line" really is worth nothing to whoever is looking at it.
   *
   * This is exactly why the collapse stops at the granted slots. A FIXED line
   * never rerolls, so it DOES sit in the pool's present set and its category
   * count for good, and there the category matters a great deal: two fixed
   * combat traits close the whole 35% trait share of the pool, which a fixed
   * junk special does not (expected final 5.94% against 4.49%). The Advanced
   * fixed-line editor therefore still lists every family by name.
   */
  var junkPoolCache = {};
  function junkFamPool(grade) {
    if (junkPoolCache[grade]) return junkPoolCache[grade];
    var fg = famGrades(grade), sum = DATA.GRANTED_LISTED_SUM, list = [], k, id, fam, w, t;
    for (k in fg.special) if (Object.prototype.hasOwnProperty.call(fg.special, k)) {
      if (fg.special[k].letter !== "F") continue;
      id = Number(k); fam = DATA.SPECIAL_BY_ID[id];
      if (!fam) continue;
      w = 0;
      for (t = 0; t < DATA.TIERS.length; t++) w += fam.granted[DATA.TIERS[t]] / sum;
      list.push({ id: id, w: w });
    }
    list.sort(function (a, b) { return a.w - b.w || a.id - b.id; });
    var out = [];
    for (k = 0; k < list.length; k++) out.push(list[k].id);
    junkPoolCache[grade] = out;
    return out;
  }

  /**
   * One stand-in per granted slot, index-aligned, skipping anything a fixed
   * line already holds — two lines of the same family would otherwise trip the
   * duplicate check in validateSet.
   */
  function junkReps() {
    var pool = junkFamPool(S.grade), used = {}, i, r, out = [];
    for (i = 0; i < S.fixedRows.length; i++) {
      r = S.fixedRows[i];
      if (r && r.fam && r.fam.indexOf("sp:") === 0) used[Number(r.fam.slice(3))] = 1;
    }
    for (i = 0; i < pool.length && out.length < S.slots; i++) if (!used[pool[i]]) out.push(pool[i]);
    while (out.length < S.slots) out.push(pool[out.length] || pool[0]);
    return out;
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

  /**
   * The official labels carry placeholders (+A%, +X, +B%) that say nothing
   * until the tier is known, and an ally-buff rider a damage dealer can ignore.
   * Strip both and you are left with the family's name.
   */
  function cleanFamLabel(fam) {
    var s = fam.label
      .replace(/;\s*ally[^;]*$/i, "")
      .replace(/\(1\/party\)/g, "")
      .replace(/[+−-]\s*[AXB]%?/g, "")
      .replace(/\s+([;,])/g, "$1")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[;,]$/, "");
    return s;
  }

  /** The tier's actual roll, formatted: percentages as %, stats as a count. */
  function tierValueText(fam, grade, tier) {
    var vals = fam.values[grade][tier], parts = [], i, j, c;
    for (i = 0; i < vals.length; i++) {
      c = null;
      for (j = 0; j < fam.comp.length; j++) if (fam.comp[j].from === i) { c = fam.comp[j]; break; }
      var flat = c && (c.k === "weaponPower" || c.k === "mainStat");
      parts.push("+" + (flat ? nf(vals[i]) : vals[i] + "%"));
    }
    return parts.join(" / ");
  }

  /**
   * Every family a slot can hold, grouped, letter-graded and sorted.
   *
   * collapseJunk (granted slots only) drops every F-graded family, whichever
   * group it landed in, and puts one "Junk Line" in their place.
   */
  function familyOptions(grade, collapseJunk) {
    var fg = famGrades(grade);
    var G = { Damage: [], Party: [], "Weapon Power": [], Stats: [], Junk: [] };
    var i, g;

    G.Stats.push({ val: "basic:mainStat", text: "Str / Dex / Int", letter: fg.basic.mainStat.letter, avg: fg.basic.mainStat.avg });
    G.Stats.push({ val: "basic:vitality", text: "Vitality", letter: fg.basic.vitality.letter, avg: 0 });
    for (i = 0; i < DATA.TRAITS.families.length; i++) {
      var tk = DATA.TRAITS.families[i].key;
      G.Stats.push({ val: "trait:" + tk, text: DATA.TRAITS.families[i].label + " (combat trait)", letter: fg.trait[tk].letter, avg: 0 });
    }
    for (i = 0; i < DATA.SPECIALS.length; i++) {
      var fam = DATA.SPECIALS[i], e = fg.special[fam.id];
      g = famGroupOf(fam);
      if (!g) g = e.avg > 1e-9 ? "Damage" : "Junk";
      G[g].push({ val: "sp:" + fam.id, text: cleanFamLabel(fam), letter: e.letter, avg: e.avg });
    }

    var order = ["Damage", "Party", "Weapon Power", "Stats", "Junk"], j;
    if (collapseJunk) {
      for (i = 0; i < order.length; i++) {
        var keep = [];
        for (j = 0; j < G[order[i]].length; j++) if (G[order[i]][j].letter !== "F") keep.push(G[order[i]][j]);
        G[order[i]] = keep;
      }
      G.Junk = [{ val: JUNK, text: "Junk Line — no damage at all", letter: "F", avg: 0 }];
    }

    var groups = [];
    for (i = 0; i < order.length; i++) {
      G[order[i]].sort(function (a, b) { return b.avg - a.avg; });
      groups.push({ label: order[i], items: G[order[i]] });
    }
    return groups;
  }

  function pickerHtml(id, groups, selected, grade) {
    // Most labels fit now; only the longest are clipped, and the full name of
    // the family currently in the slot leads the tooltip — nothing is lost.
    var full = "", i, j;
    for (i = 0; i < groups.length; i++) {
      for (j = 0; j < groups[i].items.length; j++) if (groups[i].items[j].val === selected) full = groups[i].items[j].text;
    }
    var gloss = (full ? full + " — " : "") +
      "the effect family this slot holds. The letter is the family's own grade, F to S: how good its AVERAGE roll is next to the best family in the game, always measured on the default character so the letters mean the same thing to everyone. What a particular roll is worth is the rarity box beside it.";
    // A native select cannot colour its closed text per option, so paint the
    // control itself from the selected family's grade — same trick the rarity
    // box beside it already uses. handleRowEvent repaints it on every change.
    var letter = letterOf(selected, grade || S.grade);
    var shut = letter ? GRADE_COLOR[letter] : "var(--text)";
    var h = '<select id="' + id + '" class="bc-fam" style="color:' + shut + ';font-weight:700" title="' +
      esc(full) + '" data-gloss="' + esc(gloss) + '">';
    h += '<option value="none" style="color:var(--dim);font-weight:400"' + (selected === "none" ? " selected" : "") + ">&mdash; empty &mdash;</option>";
    for (i = 0; i < groups.length; i++) {
      if (!groups[i].items.length) continue;
      h += '<optgroup label="' + esc(groups[i].label) + '">';
      for (j = 0; j < groups[i].items.length; j++) {
        var it = groups[i].items[j];
        h += '<option value="' + esc(it.val) + '" style="color:' + GRADE_COLOR[it.letter] + '" title="' + esc(it.text) + '"' +
          (selected === it.val ? " selected" : "") + ">" +
          esc(it.letter + " · " + it.text) + "</option>";
      }
      h += "</optgroup>";
    }
    return h + "</select>";
  }

  /** The tier box: the three rarities, each showing what it actually rolls. */
  function tierHtml(id, fam, grade, selected) {
    var order = ["high", "mid", "low"], h = "", i, t;
    for (i = 0; i < order.length; i++) {
      t = order[i];
      h += '<option value="' + t + '" style="color:' + TIER_META[t].color + '"' +
        (selected === t ? " selected" : "") + ">" +
        esc(TIER_META[t].label + " · " + tierValueText(fam, grade, t)) + "</option>";
    }
    var cur = TIER_META[selected] ? TIER_META[selected].color : "var(--text)";
    return '<select id="' + id + '" style="color:' + cur + ';font-weight:700" data-gloss="' +
      "The rarity this line rolled at, and what it is worth. Legendary is the family's best roll, Epic the middle one, Rare the weakest; the numbers are the actual values for the family on the left." +
      '">' + h + "</select>";
  }

  // ------------------------------------------------------------------
  // per-line explanations (the data-gloss text on the breakdown table)
  // ------------------------------------------------------------------

  function nf(v) { return Math.round(v).toLocaleString("en-US"); }

  function explainLine(line, grade, profile) {
    if (!line) return "";
    if (line.junk) {
      return "A line that does nothing for damage — Vitality, a combat trait, a defensive or party-only effect. " +
        "Fifteen families land here and they are all worth the same to a damage score: nothing. The solver never " +
        "locks one, so a junk slot is always a slot you reroll.";
    }
    if (line.cat === "trait") {
      return "Combat traits (Crit, Specialization, …) feed class mechanics this model does not read, so they score 0% damage. Their in-game value is real; it just is not comparable in % damage.";
    }
    if (line.cat === "basic" && line.family === "vitality") {
      return "Vitality is pure survivability: 0% damage for a DPS score.";
    }
    if (line.cat === "basic") {
      var ap0 = B.attackPower(profile, 0, 0), ap1 = B.attackPower(profile, line.value, 0);
      return "Main stat +" + nf(line.value) + " joins the RAW pool, so the ×" + fx(1 + profile.msPct, 3) +
        " main-stat bucket amplifies it just like gear does. Attack power = √(mainStat·weaponPower/6)·" +
        fx(1 + profile.baseApPct, 3) + " + " + nf(profile.flatAP) + " goes " + nf(ap0) + " → " + nf(ap1) +
        ", a ×" + fx(ap1 / ap0, 5) + " on damage.";
    }
    var fam = DATA.SPECIAL_BY_ID[line.family];
    if (!fam) return "";
    var vals = fam.values[grade][line.tier], parts = [], i;
    for (i = 0; i < fam.comp.length; i++) {
      var c = fam.comp[i];
      var x = (c.v !== undefined) ? c.v : vals[c.from];
      var scaled = c.scaleKey ? x * profile[c.scaleKey] : x;
      parts.push(explainComponent(c, x, scaled, profile, fam));
    }
    var txt = fam.label + " at " + line.tier + " tier: " + parts.join("  ");
    if (PARTY_IDS[fam.id]) {
      txt += "  Party lines are counted as your own gain plus " + profile.allyDpsCount +
        " × an ally's gain, each ally assumed to deal the same damage as you before the line, at 90% crit / 280% crit damage.";
    }
    return txt;
  }

  function explainComponent(c, x, scaled, profile, fam) {
    var pool, cf0, cf1;
    switch (c.k) {
      case "none":
        return "no damage component — 0%.";
      case "weaponPower":
        var ap0 = B.attackPower(profile, 0, 0), ap1 = B.attackPower(profile, 0, scaled);
        return "+" + nf(x) + " weapon power" + (c.scaleKey ? " × " + profile[c.scaleKey] + " (" + c.scaleKey + ") = +" + nf(scaled) : "") +
          " → attack power " + nf(ap0) + " → " + nf(ap1) + " (×" + fx(ap1 / ap0, 5) + ").";
      case "mainStat":
        return "+" + nf(scaled) + " main stat, amplified by the ×" + fx(1 + profile.msPct, 3) + " bucket.";
      case "critRate":
        cf0 = B.critFactor(profile, 0, 0); cf1 = B.critFactor(profile, x / 100, 0);
        return "crit rate +" + x + " pp (capped at 100%): expected crit factor " + fx(cf0, 4) + " → " + fx(cf1, 4) + ".";
      case "critDamage":
        cf0 = B.critFactor(profile, 0, 0); cf1 = B.critFactor(profile, 0, x / 100);
        return "crit damage +" + x + " pp: crit factor " + fx(cf0, 4) + " → " + fx(cf1, 4) + ".";
      case "onCritDamage":
        return "on a crit, damage +" + x + "% — this is crit-HIT damage, so the crit branch becomes 1 + cr·(cd·" + fx(1 + x / 100, 3) + " − 1), not additional damage.";
      case "addDamage":
        pool = B.addDamagePool(profile);
        return "additional damage pool " + fx(pool * 100, 2) + "% → " + fx((pool + x / 100) * 100, 2) +
          "%, a ×" + fx((1 + pool + x / 100) / (1 + pool), 5) + " (the pool is additive with itself, then multiplies once).";
      case "outgoing":
        return "outgoing damage +" + x + "% is its own multiplicative bucket, undiluted: ×" + fx(1 + x / 100, 4) + ".";
      case "outgoingCdPenalty":
        return "damage +" + x + "% but cooldowns +" + (c.cdPct || 0) + "%. Burst play pays no penalty (×" + fx(1 + x / 100, 4) +
          "), sustained play divides by " + fx(1 + (c.cdPct || 0) / 100, 3) + "; the score is the " +
          fx(profile.cooldownPenaltyWeight, 2) + " / " + fx(1 - profile.cooldownPenaltyWeight, 2) + " mean of the two.";
      case "staggered":
        return "+" + x + "% while the boss is staggered × your " + fx(profile.staggeredShare * 100, 1) + "% stagger share = ×" +
          fx(1 + profile.staggeredShare * x / 100, 5) + ".";
      case "demon":
        return "+" + x + "% demon damage, diluted by the " + fx(profile.demonBase * 100, 1) +
          "% you already carry and scaled by your " + fx(profile.demonShare * 100, 0) + "% demon-boss share.";
      case "backAttack":
        return "+" + x + "% back attack × your " + fx(profile.backAttackShare * 100, 0) + "% back-attack share.";
      case "frontAttack":
        return "+" + x + "% front attack × your " + fx(profile.frontAttackShare * 100, 0) + "% front-attack share.";
      case "nonDirectional":
        return "+" + x + "% non-directional × your " + fx(profile.nonDirectionalShare * 100, 0) + "% non-directional share.";
      case "atkMoveSpeed":
        return "attack & move speed +" + scaled + "% — not converted to damage in v1, so 0%.";
      case "defShred":
        var g = B.defShredGain(profile, x);
        return "enemy defense −" + x + "%: with " + fx(profile.enemyBaseDR * 100, 0) +
          "% base damage reduction that is ×" + fx(g, 5) + " for everyone hitting the boss.";
      case "critResistShred":
        cf0 = B.allyCritFactor(profile, 0, 0); cf1 = B.allyCritFactor(profile, x / 100, 0);
        return "enemy crit resist −" + x + " pp reads as +" + x + " pp crit rate for the whole party; an ally's crit factor " +
          fx(cf0, 4) + " → " + fx(cf1, 4) + ".";
      case "critDmgResistShred":
        cf0 = B.allyCritFactor(profile, 0, 0); cf1 = B.allyCritFactor(profile, 0, x / 100);
        return "enemy crit-damage resist −" + x + " pp reads as +" + x + " pp crit damage party-wide; an ally's crit factor " +
          fx(cf0, 4) + " → " + fx(cf1, 4) + ".";
      case "shieldedDamage":
        return "+" + x + "% while the target is shielded × " + fx(profile.shieldUptime * 100, 0) + "% shield uptime = +" +
          fx(profile.shieldUptime * x, 2) + "% each, for you and every ally.";
      case "allyApBuff":
        return "ally attack-power buff +" + x + "% scales a buff only supports give, so it scores 0 for a DPS.";
      case "allyDamageBuff":
        return "ally damage buff +" + x + "% is support-only: 0 for a DPS.";
      case "partyShieldHeal":
        return "party shield / heal +" + x + "% is support-only: 0 for a DPS.";
    }
    return "";
  }

  // ------------------------------------------------------------------
  // worker plumbing
  // ------------------------------------------------------------------

  var worker = null, reqSeq = 0, inflight = null, queued = null;
  var cache = {}, cacheOrder = [], CACHE_MAX = 40;
  var lastSolve = null, lastSolveKey = null;     // the current bracelet
  var freshSolve = null, freshSolveKey = null;   // the same bracelet unrolled — "what an empty one is worth"
  // Which state the WORKER's stored context belongs to. A cache hit answers the
  // display without touching the worker, so this can lag behind lastSolveKey —
  // and advise() needs the real thing.
  var workerCtxKey = null;
  var busy = 0;

  function profileSig(profile) {
    return JSON.stringify([
      profile.mainStatRaw, profile.weaponPowerRaw, profile.msPct, profile.wpPct, profile.baseApPct, profile.flatAP,
      profile.skills, profile.master, profile.addDamage, profile.backAttackShare, profile.frontAttackShare,
      profile.nonDirectionalShare, profile.staggeredShare, profile.demonShare, profile.demonBase,
      profile.shieldUptime, profile.allyDpsCount, profile.enemyBaseDR, profile.cooldownPenaltyWeight,
      profile.traitWeights
    ]);
  }

  // Gold is deliberately NOT in the key: value = (expectedFinal − baseline) × gpd
  // is arithmetic we redo here, so moving the gold slider never re-solves.
  function keyOf(profile, granted, rolls) {
    return JSON.stringify([S.grade, S.slots, rolls, fixedLines(), granted, traitValues()]) + "|" + profileSig(profile);
  }

  function ensureWorker() {
    if (worker) return worker;
    try {
      worker = new Worker("solver-worker.js?v=3");
    } catch (e) {
      worker = null;
      return null;
    }
    worker.onmessage = function (e) {
      var m = e.data || {};
      var job = inflight;
      inflight = null;
      if (job && job.id === m.id) {
        if (m.ok) job.resolve(m.res);
        else job.reject(new Error(m.error || "solver failed"));
      }
      pump();
    };
    worker.onerror = function (e) {
      var job = inflight; inflight = null;
      if (job) job.reject(new Error("worker error: " + (e.message || "unknown")));
      pump();
    };
    return worker;
  }

  // One request in flight. A newer request replaces whatever is waiting, so a
  // burst of keystrokes costs one solve, not ten.
  function send(cmd, payload) {
    var w = ensureWorker();
    if (!w) return Promise.reject(new Error("Web Workers are unavailable in this browser."));
    return new Promise(function (resolve, reject) {
      var job = { id: ++reqSeq, cmd: cmd, payload: payload, resolve: resolve, reject: reject };
      // Only one request ever waits: a newer one replaces it, so a burst of
      // keystrokes costs one solve. The replaced job MUST be rejected or its
      // caller would hang and the busy indicator would never clear.
      if (queued) queued.reject(new Error("superseded"));
      queued = job;
      pump();
    });
  }
  function pump() {
    if (inflight || !queued) return;
    inflight = queued; queued = null;
    worker.postMessage({ id: inflight.id, cmd: inflight.cmd, payload: inflight.payload });
  }

  function cacheGet(k) { return cache[k]; }
  function cachePut(k, v) {
    if (!cache[k]) {
      cacheOrder.push(k);
      while (cacheOrder.length > CACHE_MAX) delete cache[cacheOrder.shift()];
    }
    cache[k] = v;
  }

  function setBusy(on) {
    busy += on ? 1 : -1;
    if (busy < 0) busy = 0;
    var el = $("bc-busy");
    if (el) el.className = busy ? "bc-busy on" : "bc-busy";
  }

  /**
   * o.keepCtx  false for the side solve that prices an unrolled bracelet, so it
   *            cannot evict the context advise() reads.
   * o.force    skip the cache — used when the display is cached but the worker
   *            is holding some other bracelet's context.
   */
  function solveState(profile, granted, rolls, o) {
    o = o || {};
    var k = keyOf(profile, granted, rolls);
    var hit = cacheGet(k);
    if (hit && !o.force) return Promise.resolve({ key: k, res: hit, cached: true });
    setBusy(true);
    return send("solve", {
      grade: S.grade, profile: profile, fixedLines: fixedLines(), grantedLines: granted,
      traitValues: traitValues(),
      slots: S.slots, rollsLeft: rolls, goldPer1Pct: 0, baselinePct: 0,
      ctxKey: k, keepCtx: o.keepCtx !== false
    }).then(function (res) {
      setBusy(false);
      cachePut(k, res);
      if (o.keepCtx !== false) workerCtxKey = k;
      return { key: k, res: res, cached: false };
    }, function (err) {
      setBusy(false);
      throw err;
    });
  }

  // ------------------------------------------------------------------
  // recompute
  // ------------------------------------------------------------------

  var debounceTimer = null, computeSeq = 0;

  function schedule() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recompute, DEBOUNCE_MS);
  }

  function recompute() {
    debounceTimer = null;
    var mine = ++computeSeq;
    var profile = buildProfile();
    var granted = grantedLines();
    var err = validateSet(fixedLines().concat(granted));

    if (isPartial() || err) {
      lastSolve = null; lastSolveKey = null;
      renderResults(profile, err);
      return;
    }

    var rolls = S.rollsLeft;
    solveState(profile, granted, rolls).then(function (out) {
      if (mine !== computeSeq) return;                       // a newer edit already landed
      lastSolve = out.res; lastSolveKey = out.key;
      renderResults(profile, null);
      // "What an empty one is worth" — same character, same slots, no lines, full rolls.
      return solveState(profile, [], S.rollsTotal, { keepCtx: false }).then(function (f) {
        if (mine !== computeSeq) return;
        freshSolve = f.res; freshSolveKey = f.key;
        renderResults(profile, null);
      });
    }).catch(function (e) {
      if (mine !== computeSeq) return;
      if (e && e.message === "superseded") return;
      lastSolve = null;
      renderResults(profile, e && e.message ? e.message : "solve failed");
    });
  }

  // ------------------------------------------------------------------
  // markup
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
      t = '<div class="bc-ticks" style="grid-template-columns:repeat(' + o.ticks.length + ',1fr)">';
      for (var i = 0; i < o.ticks.length; i++) t += "<span>" + esc(o.ticks[i]) + "</span>";
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
    var cur = String(getPath(S, path)), h = "", i, v;
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

  function styleBlock() {
    return "<style>" +
      // The control deck rides in normal document flow. It used to stick and
      // scroll inside itself, which meant you had to collapse the panel before
      // you could read the results under it — Shizu's complaint, 2026-08-11.
      "#tab-calculator #bc-inputs{position:static;max-height:none;overflow:visible}" +
      "#tab-calculator .ihdr{cursor:pointer}" +
      "#tab-calculator .bc-busy{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--border);margin-left:8px;vertical-align:middle;transition:background .15s}" +
      "#tab-calculator .bc-busy.on{background:var(--accent);animation:bc-pulse 1s ease-in-out infinite}" +
      "@keyframes bc-pulse{0%,100%{opacity:.25}50%{opacity:1}}" +
      "#tab-calculator .bc-sub{font-size:11px;color:var(--dim);margin:-4px 0 10px}" +
      "#tab-calculator .bc-hdrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}" +
      "#tab-calculator .bc-fam{width:100%}" +
      // The family box carries the longest text on the row, so it gets the
      // room: 430px fits nearly every label outright (the shrink last round
      // went too far — Shizu, 2026-08-11).
      "#tab-calculator .bc-slot{display:grid;grid-template-columns:44px 168px minmax(0,430px) 120px;gap:8px;align-items:end;margin-bottom:8px;justify-content:start}" +
      // Only the few labels still too long are clipped: the full name rides in
      // the tooltip and the title attribute.
      "#tab-calculator .bc-fam{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#tab-calculator .bc-slot .sn{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;padding-bottom:7px}" +
      "@media(max-width:640px){#tab-calculator .bc-slot{grid-template-columns:1fr;gap:5px}#tab-calculator .bc-slot .sn{padding-bottom:0}}" +
      "@media(max-width:900px) and (min-width:641px){#tab-calculator .bc-slot{grid-template-columns:44px 150px minmax(0,1fr) 110px}}" +
      // An illegal-but-scored state (three combat traits, or fewer than two):
      // the house note, flagged with the bad colour. A warning, not a block.
      "#tab-calculator .note.bc-illegal{color:var(--bad);border-left:2px solid var(--bad);padding-left:9px;margin-top:8px}" +
      // headline cards
      "#tab-calculator .bc-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px}" +
      "#tab-calculator .bc-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}" +
      "#tab-calculator .bc-card .k{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:700}" +
      "#tab-calculator .bc-card .v{font-size:25px;font-weight:800;letter-spacing:-.02em;margin-top:5px;line-height:1.1}" +
      "#tab-calculator .bc-card .s{font-size:11px;color:var(--dim);margin-top:5px;line-height:1.45}" +
      "#tab-calculator .bc-card.hero{border-color:var(--accent)}" +
      "#tab-calculator .bc-card .v.gold{color:var(--high)}" +
      "#tab-calculator .bc-card .v.acc{color:var(--accent)}" +
      // quantile strip
      "#tab-calculator .bc-strip{position:relative;height:34px;margin:12px 0 4px}" +
      "#tab-calculator .bc-strip .track{position:absolute;left:0;right:0;top:13px;height:8px;border-radius:4px;background:var(--panel2);border:1px solid var(--border)}" +
      "#tab-calculator .bc-strip .whisk{position:absolute;top:16px;height:2px;background:var(--border)}" +
      "#tab-calculator .bc-strip .box{position:absolute;top:9px;height:16px;border-radius:4px;background:rgba(102,199,255,.22);border:1px solid var(--accent)}" +
      "#tab-calculator .bc-strip .med{position:absolute;top:5px;width:2px;height:24px;background:var(--accent)}" +
      "#tab-calculator .bc-strip .cur{position:absolute;top:2px;width:2px;height:30px;background:var(--high)}" +
      "#tab-calculator .bc-qlab{display:flex;justify-content:space-between;font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}" +
      // advisor
      "#tab-calculator .bc-lockline{font-size:14px;line-height:1.6;margin:2px 0 8px}" +
      "#tab-calculator .bc-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:700;background:var(--panel2);border:1px solid var(--border);margin:0 4px 4px 0}" +
      "#tab-calculator .bc-pill.lock{border-color:var(--accent);color:var(--accent)}" +
      "#tab-calculator .bc-pill.roll{color:var(--dim)}" +
      "#tab-calculator .bc-tabwrap{overflow-x:auto}" +
      // cut flow
      "#tab-calculator .bc-cutgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}" +
      "@media(max-width:760px){#tab-calculator .bc-cutgrid{grid-template-columns:1fr}}" +
      "#tab-calculator .bc-lockrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--border);border-radius:7px;margin-bottom:6px;background:var(--panel2);font-size:12.5px}" +
      "#tab-calculator .bc-lockrow input{accent-color:var(--accent)}" +
      "#tab-calculator .bc-lockrow .ln{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#tab-calculator .bc-verdict{border-radius:10px;padding:13px 15px;margin-top:12px;border:1px solid var(--border);background:var(--panel2)}" +
      "#tab-calculator .bc-verdict.keep{border-color:var(--good)}" +
      "#tab-calculator .bc-verdict.replace{border-color:var(--high)}" +
      "#tab-calculator .bc-verdict .hd{font-size:19px;font-weight:800;letter-spacing:-.01em}" +
      "#tab-calculator .bc-verdict.keep .hd{color:var(--good)}" +
      "#tab-calculator .bc-verdict.replace .hd{color:var(--high)}" +
      "#tab-calculator .bc-verdict .bd{font-size:12.5px;color:var(--dim);margin-top:6px;line-height:1.55}" +
      "#tab-calculator .bc-hist{list-style:none;margin:8px 0 0;padding:0;font-size:12.5px}" +
      "#tab-calculator .bc-hist li{padding:6px 0;border-bottom:1px solid var(--border);line-height:1.5}" +
      "#tab-calculator .bc-hist li:last-child{border-bottom:none}" +
      "#tab-calculator .bc-warn{color:var(--bad);font-size:12.5px;margin:8px 0}" +
      // ---- the two-column control deck -------------------------------
      "#tab-calculator .bc-deck{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px 22px}" +
      "@media(max-width:900px){#tab-calculator .bc-deck{grid-template-columns:1fr;gap:0}}" +
      "#tab-calculator .bc-col{min-width:0}" +
      "#tab-calculator .bc-gearhdr{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:12px 0 8px}" +
      "#tab-calculator .bc-gearhdr .subh{margin:0}" +
      "#tab-calculator .bc-ilvl{text-align:right;line-height:1}" +
      "#tab-calculator .bc-ilvl .k{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:700}" +
      "#tab-calculator .bc-ilvl .v{font-size:28px;font-weight:800;letter-spacing:-.02em;color:var(--accent);font-variant-numeric:tabular-nums;margin-top:3px}" +
      // ---- slider rows ------------------------------------------------
      "#tab-calculator .bc-sl{display:grid;grid-template-columns:96px minmax(0,1fr) 52px;gap:10px;align-items:center;margin-bottom:6px}" +
      "#tab-calculator .bc-sl .lb{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);line-height:1.25}" +
      "#tab-calculator .bc-sl .chip{font-size:12.5px;font-weight:700;color:var(--accent);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}" +
      "#tab-calculator .bc-sl .chip.ed{cursor:text;text-decoration:underline dotted;text-underline-offset:3px}" +
      "#tab-calculator .bc-sl .chip input{width:100%;background:var(--panel2);color:var(--text);border:1px solid var(--accent);border-radius:5px;padding:2px 4px;font:inherit;font-size:12px;text-align:right}" +
      "#tab-calculator .bc-sl .tk{min-width:0}" +
      "#tab-calculator .bc-ticks{display:grid;font-size:9.5px;color:var(--dim);text-align:center;margin-top:-2px;letter-spacing:.03em}" +
      // Native range, styled to the house theme — no custom drag code.
      "#tab-calculator input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:18px;background:transparent;margin:0;padding:0;cursor:pointer;display:block}" +
      "#tab-calculator input[type=range]::-webkit-slider-runnable-track{height:5px;border-radius:3px;background:var(--panel2);border:1px solid var(--border)}" +
      "#tab-calculator input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:var(--accent);border:none;margin-top:-6px}" +
      "#tab-calculator input[type=range]::-moz-range-track{height:5px;border-radius:3px;background:var(--panel2);border:1px solid var(--border)}" +
      "#tab-calculator input[type=range]::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:var(--accent);border:none}" +
      "#tab-calculator input[type=range]:focus{outline:none}" +
      "#tab-calculator input[type=range]:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px rgba(102,199,255,.35)}" +
      "#tab-calculator input[type=range]:focus-visible::-moz-range-thumb{box-shadow:0 0 0 3px rgba(102,199,255,.35)}" +
      "#tab-calculator input[type=range]:disabled{opacity:.45;cursor:not-allowed}" +
      // The weapon is the only piece that moves weapon power: mark its track.
      "#tab-calculator .bc-sl.wep input[type=range]::-webkit-slider-runnable-track{background:rgba(102,199,255,.30);border-color:var(--accent)}" +
      "#tab-calculator .bc-sl.wep input[type=range]::-moz-range-track{background:rgba(102,199,255,.30);border-color:var(--accent)}" +
      // ---- segmented controls and toggles -----------------------------
      "#tab-calculator .bc-segrow{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:center;margin-bottom:6px}" +
      "#tab-calculator .bc-seg{display:flex;gap:4px}" +
      "#tab-calculator .bc-seg button{flex:1 1 0;min-width:0;background:var(--panel2);border:1px solid var(--border);color:var(--dim);" +
        "border-radius:6px;padding:5px 2px;font-size:11.5px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap}" +
      "#tab-calculator .bc-seg button:hover{color:var(--text);border-color:var(--accent)}" +
      "#tab-calculator .bc-seg button[aria-pressed=true]{color:#06121f;background:var(--accent);border-color:var(--accent)}" +
      "#tab-calculator .bc-tgl[aria-pressed=true]{color:var(--accent);border-color:var(--accent);background:rgba(102,199,255,.16)}" +
      "#tab-calculator .bc-tgl[aria-pressed=true]:hover{color:var(--accent)}" +
      // ---- the bracelet's two fixed combat traits ---------------------
      "#tab-calculator .bc-sl.bc-trrow{grid-template-columns:74px 96px 72px;justify-content:start}" +
      "#tab-calculator .bc-trrow input[type=number]{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 7px;font:inherit;font-size:13px;width:100%}" +
      "#tab-calculator .bc-trrow input[type=number]:focus{outline:1px solid var(--accent)}" +
      "#tab-calculator .bc-trrow input:disabled{opacity:.45;cursor:not-allowed}" +
      "#tab-calculator .bc-tract{padding:4px 8px;font-size:11px;width:100%}" +
      "@media(max-width:640px){#tab-calculator .bc-sl.bc-trrow{grid-template-columns:62px 84px 66px;gap:6px}}" +
      // ---- skills: typed, not slid (Shizu's call for this block only) ----
      "#tab-calculator .bc-skill{display:grid;grid-template-columns:110px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 26px;gap:7px;align-items:end;margin-bottom:7px}" +
      "@media(max-width:640px){#tab-calculator .bc-skill{grid-template-columns:1fr 1fr}" +
      "#tab-calculator .bc-skill .bc-x{justify-self:start;width:44px}" +
      "#tab-calculator .bc-sl,#tab-calculator .bc-segrow{grid-template-columns:82px minmax(0,1fr) 46px;gap:7px}" +
      "#tab-calculator .bc-segrow{grid-template-columns:82px minmax(0,1fr)}}" +
      "#tab-calculator .bc-x{background:var(--panel2);border:1px solid var(--border);color:var(--dim);border-radius:6px;height:29px;width:100%;padding:0;cursor:pointer;font-family:inherit;font-size:14px;line-height:1}" +
      "#tab-calculator .bc-x:hover{color:var(--bad);border-color:var(--bad)}" +
      // A checkbox has no field above it to line up with, and its label is a
      // sentence rather than a caption — give it the whole row.
      "#tab-calculator .bc-chk{grid-column:1/-1}" +
      "#tab-calculator .bc-chk label{display:flex;align-items:center;gap:7px;text-transform:none;font-size:12.5px;color:var(--text);letter-spacing:0;padding:4px 0}" +
      // .fld input is width:100% for text boxes; a checkbox must not inherit that.
      "#tab-calculator .bc-chk input{width:auto;flex:0 0 auto;margin:0;accent-color:var(--accent)}" +
      "</style>";
  }

  function inputsMarkup() {
    return '' +
      '<div class="inputs" id="bc-inputs">' +
      '  <div class="ihdr"><span>Character &amp; bracelet<span class="bc-busy" id="bc-busy"></span></span>' +
      '    <span class="tgl" id="bc-toggle"><span id="bc-caret">&#9662;</span></span></div>' +
      '  <div id="bc-inputs-body">' +
      '    <div id="bc-top"></div>' +
      '    <div class="bc-deck">' +
      '      <div class="bc-col">' +
      '        <div class="bc-gearhdr"><div class="subh">Gear</div>' +
      '          <div class="bc-ilvl"><div class="k" data-gloss="The mean of your six pieces\' item levels, live. Serca level 0 is item level 1675 and every honing level is +5, so +25 across the board is 1800. Item level itself does not enter the damage math — the honing levels behind it do.">Item level</div>' +
      '            <div class="v" id="bc-ilvl">—</div></div></div>' +
      '        <div id="bc-gear"></div>' +
      '        <div id="bc-kit"></div>' +
      '        <div class="barrow">' +
      '          <button class="mbtn" id="bc-advtoggle" type="button">Advanced ▾</button>' +
      '          <button class="mbtn" id="bc-reset" type="button">Reset</button>' +
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

  function braceletMarkup() {
    return '' +
      '<div class="panel" id="bc-braceletpanel">' +
      '  <div class="bc-hdrow"><h2 style="margin:0">Bracelet</h2>' +
      '    <button class="mbtn" id="bc-clear" type="button">Mark as unrolled</button></div>' +
      '  <div class="bc-sub" id="bc-slotnote"></div>' +
      '  <div class="subh">Combat traits — the two fixed lines</div>' +
      '  <div id="bc-traits"></div>' +
      '  <div class="subh">Granted slots</div>' +
      '  <div id="bc-slots"></div>' +
      '  <div id="bc-fixed"></div>' +
      '</div>';
  }

  function tabMarkup() {
    return styleBlock() + inputsMarkup() + braceletMarkup() +
      '<section id="bc-results"></section>';
  }

  // ------------------------------------------------------------------
  // input rendering
  // ------------------------------------------------------------------

  function renderTop() {
    var h = '<div class="ig">';
    h += fldSel("grade", "Grade", [{ v: "ancient", t: "Ancient" }, { v: "relic", t: "Relic" }],
      "Ancient bracelets roll 2 or 3 granted slots and higher line values; Relic rolls 1 or 2.");
    h += fldSel("slots", "Granted slots", (function () {
      var ch = slotChoices(), o = [], j;
      for (j = 0; j < ch.length; j++) o.push({ v: ch[j], t: ch[j] + " slots" });
      return o;
    })(), "The rerollable lines. Ancient: 3 slots on 25% of drops, 2 on 75%. Slot count moves the value of an unrolled bracelet a lot.");
    h += fldNum("rollsLeft", "Rolls left", "1",
      "A fresh bracelet has 4 rolls plus up to 3 reconversion-ticket rolls = 7. The cut flow counts this down.");
    h += "</div>";
    h += fldChk("useOverride", "Enter WP / main stat directly",
      "Skip the honing sliders and type the two raw numbers straight off your character sheet (before the % buckets).");
    $("bc-top").innerHTML = h;
  }

  // ---- left column: GEAR ----

  function renderGear() {
    var h = "", i, k;
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
        '<input type="number" step="0.1" data-sk="' + i + '" data-f="cr" value="' + esc(s.cr) + '"></div>' +
        '<div class="fld"><label data-gloss="What a crit deals, as a multiple. 280% means a crit hits for 2.8 times, not 3.8.">Crit dmg %</label>' +
        '<input type="number" step="1" data-sk="' + i + '" data-f="cd" value="' + esc(s.cd) + '"></div>' +
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

  function renderEcon() {
    var h = '<div class="bc-sl">' +
      '<label class="lb" for="bc-gpd" data-gloss="What one percent of damage is worth to you in gold. It is a rate you choose, not a market read — the same convention the accessory and astrogem tools use, so a bracelet, an accessory and a gem can be priced against each other. Higher for a whale roster, lower for a fresh one. The track is logarithmic: 100k at the left, 10M at the right.">Gold per 1%</label>' +
      '<div class="tk"><input id="bc-gpd" type="range" data-gpd="1" min="0" max="' + GPD_STEPS + '" step="1" value="' + gpdPos(S.econ.gpd) + '"></div>' +
      '<span class="chip" id="bc-gpd-chip">' + esc(gold(num(S.econ.gpd, 0))) + "</span></div>";
    h += slider("econ.baseline", "Baseline %", 0, 25, 0.5, "pct1", {
      edit: true,
      gloss: "The bracelet you would wear instead. Worth is (expected final − baseline) × gold per 1%, so leaving it at 0 prices this bracelet against no bracelet at all. Click the number to type an exact one."
    });
    $("bc-econ").innerHTML = h;
  }

  // The live read-out under the bracelet header. Split out so a slider drag can
  // refresh it without rebuilding the fields under the cursor.
  function updateBasicsNote() {
    var note = $("bc-slotnote");
    if (!note) return;
    var base = baseStats(), p = buildProfile();
    var msg = S.useOverride
      ? "Main stat " + nf(base.mainStatRaw) + " raw · weapon power " + nf(base.weaponPowerRaw) + " raw"
      : "Item level " + fx(ilvlExact(), 2) + " · main stat " + nf(base.mainStatRaw) + " raw · weapon power " + nf(base.weaponPowerRaw) + " raw";
    msg += " · attack power " + nf(B.attackPower(p, 0, 0)) + " · additional damage pool " + fx(B.addDamagePool(p) * 100, 2) + "%";
    msg += " · fixed traits " + signPct(pct(B.traitDamage(traitValues(), p)));
    note.textContent = msg + ". Leave every granted slot empty for an unrolled bracelet.";
  }

  // ---- the bracelet's two fixed combat traits ----

  function renderTraits() {
    var box = $("bc-traits");
    if (!box) return;
    var band = traitBand(), h = "", i, k, t;
    for (i = 0; i < TRAIT_KEYS.length; i++) {
      k = TRAIT_KEYS[i];
      t = S.traits[k];
      // Typed, not slid: these are numbers read straight off the bracelet.
      h += '<div class="bc-sl bc-trrow">' +
        '<span class="lb" data-gloss="' + esc(TRAIT_GLOSS[k]) + '">' + esc(TRAIT_LABELS[k]) + "</span>" +
        '<input id="bc-tr-' + k + '" type="number" data-tr="' + k + '"' +
          ' min="' + band[0] + '" max="' + band[1] + '" step="1" value="' + esc(t.v) + '"' +
          (t.on ? "" : " disabled") + ">" +
        '<button type="button" class="mbtn bc-tgl bc-tract" data-tron="' + k + '" aria-pressed="' + (t.on ? "true" : "false") + '"' +
          ' data-gloss="' + (t.on
            ? "One of the trait lines your bracelet carries. Switch it off if the bracelet does not have it."
            : "Switch this trait on if your bracelet carries it. Nothing else turns off — a bracelet only ever has two, and the panel warns you if you go over.") + '">' +
          (t.on ? "active" : "off") + "</button>" +
        "</div>";
    }
    h += '<div class="note">Every bracelet comes with two combat traits, ' + band[0] + "&ndash;" + band[1] +
      " points on " + (S.grade === "relic" ? "Relic" : "Ancient") +
      ". They never reroll, so they are a constant added to every score below.</div>";
    // Nothing is switched off behind the user's back; the panel just says when
    // the set on screen could not exist in game. The score counts it either way.
    var n = traitOnCount();
    if (n > 2) {
      h += '<div class="note bc-illegal">Three combat traits are active. A real bracelet only ever carries two, ' +
        "so this bracelet cannot exist in game &mdash; every score below still counts all three exactly as entered.</div>";
    } else if (n < 2) {
      h += '<div class="note bc-illegal">' + (n === 1 ? "Only one combat trait is active" : "No combat trait is active") +
        ". Every bracelet carries two, so this one is short a line &mdash; the score counts only what is on.</div>";
    }
    box.innerHTML = h;
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
    h += "</div>";
    h += '<div class="note">The conditional weapon-power families (20, 21 and 22) are no longer knobs: they are scored at max stacks and full uptime.</div>';

    h += '<div class="subh">Fixed lines (come with the drop, never rerolled)</div>';
    h += '<div class="bc-sub">Optional, and separate from the two combat traits above. They score their own damage and they lock their family and category slot out of every future roll, so they change what an empty bracelet is worth.</div>';
    h += '<div id="bc-fixedrows"></div>';
    h += '<div class="barrow"><button class="mbtn" id="bc-addfixed" type="button"' + (S.fixedRows.length >= 2 ? " disabled" : "") + '>+ Add fixed line</button></div>';

    box.innerHTML = h;
    var apField = $(fldId("adv.baseApPct"));
    if (apField && !S.adv.baseApOverride) { apField.value = fx(baseApPctOf(), 2); apField.disabled = true; }
    renderFixedRows();
  }

  /** Every input control, rebuilt. Used by init, by Reset and by a shape change. */
  function renderInputs() {
    renderTop(); renderGear(); renderKit(); renderFight(); renderTraitWeights();
    renderSkills(); renderEcon(); renderAdvanced(); renderTraits();
    updateBasicsNote();
  }


  function rowMarkup(idx, row, prefix, label) {
    var grade = S.grade;
    var isBasic = row.fam.indexOf("basic:") === 0;
    var isSpecial = row.fam.indexOf("sp:") === 0;
    var famKey = isBasic ? row.fam.slice(6) : "mainStat";
    var msValue = (row.value === null || row.value === undefined || row.value === "") ? defaultBasicValue(grade, famKey) : num(row.value, defaultBasicValue(grade, famKey));
    // Granted and rolled rows fold the F families into one "Junk Line"; the
    // Advanced fixed-line editor ("bc-f") keeps every family by name, because a
    // fixed line's category is load-bearing for the pool (see junkFamPool).
    var groups = familyOptions(grade, prefix !== "bc-f");
    var rg = msRange(grade, famKey);

    // Rarity first, family second: the rarity is the short, high-signal box and
    // the family name is long, so the eye reads left to right without hopping.
    var h = '<div class="bc-slot">' +
      '<div class="sn">' + esc(label) + "</div>";
    if (isSpecial) {
      var fam = DATA.SPECIAL_BY_ID[Number(row.fam.slice(3))];
      h += '<div class="fld">' + (fam ? tierHtml(prefix + "-tier-" + idx, fam, grade, row.tier || "mid") : "") + "</div>";
    } else {
      h += "<div></div>";
    }
    h += '<div class="fld">' + pickerHtml(prefix + "-fam-" + idx, groups, row.fam, grade) + "</div>";
    if (isBasic) {
      h += '<div class="fld"><input type="number" id="' + prefix + "-val-" + idx + '" step="1" min="' + rg[0] + '" max="' + rg[1] +
        '" value="' + msValue + '" data-gloss="The number this stat line actually rolled. The official bands run ' +
        rg[0] + "–" + rg[1] + ' on ' + (grade === "relic" ? "Relic" : "Ancient") + '."></div>';
    } else {
      h += "<div></div>";
    }
    return h + "</div>";
  }

  function renderSlots() {
    var h = "", i;
    for (i = 0; i < S.slots; i++) h += rowMarkup(i, S.rows[i], "bc-r", "Slot " + (i + 1));
    $("bc-slots").innerHTML = h;
  }

  function renderFixedRows() {
    var box = $("bc-fixedrows");
    if (!box) return;
    var h = "", i;
    for (i = 0; i < S.fixedRows.length; i++) h += rowMarkup(i, S.fixedRows[i], "bc-f", "Fixed " + (i + 1));
    if (!S.fixedRows.length) h = '<div class="note">No fixed lines set.</div>';
    box.innerHTML = h;
  }

  // ------------------------------------------------------------------
  // results
  // ------------------------------------------------------------------

  function lineLabel(line, grade) {
    if (!line) return "—";
    if (line.junk) return "Junk Line";                  // the stand-in family is an implementation detail
    if (line.cat === "basic") return (line.family === "mainStat" ? "Str / Dex / Int +" : "Vitality +") + nf(line.value);
    if (line.cat === "trait") {
      var t = null, i;
      for (i = 0; i < DATA.TRAITS.families.length; i++) if (DATA.TRAITS.families[i].key === line.family) t = DATA.TRAITS.families[i];
      return (t ? t.label : line.family) + " (combat trait)";
    }
    var fam = DATA.SPECIAL_BY_ID[line.family];
    if (!fam) return "unknown";
    var vals = fam.values[grade][line.tier];
    return fam.label + " · " + line.tier + " (" + vals.join(" / ") + ")";
  }

  /**
   * A pill-sized name. The official labels carry placeholders (+A%, +X, +B%)
   * that say nothing once the tier is known, so strip those and the value list,
   * then keep the tier.
   */
  function shortLabel(line, grade) {
    if (!line) return "—";
    if (line.junk) return "Junk Line";
    if (line.cat === "basic") return (line.family === "mainStat" ? "Str / Dex / Int +" : "Vitality +") + nf(line.value);
    if (line.cat === "trait") return lineLabel(line, grade);
    var fam = DATA.SPECIAL_BY_ID[line.family];
    if (!fam) return "unknown";
    var s = fam.label
      .replace(/;\s*ally[^;]*$/i, "")            // the ally-buff rider scores 0 for a DPS
      .replace(/\(1\/party\)/g, "")
      .replace(/[+−-]\s*[AXB]%?/g, "")
      .replace(/\s+([;,])/g, "$1")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[;,]$/, "");
    if (s.length > 40) s = s.slice(0, 38).replace(/[\s,;]+$/, "") + "…";
    return s + " · " + line.tier;
  }

  /**
   * The advisor reports locks as solver atom keys. Walk them back onto the slots
   * on screen: greedy match, because two slots CAN hold the same key only when
   * they are both junk, and junk is never locked.
   */
  function locksFromKeys(keys, lines, grade, profile) {
    var out = [], used = {}, i, j;
    for (i = 0; i < lines.length; i++) out.push(false);
    for (i = 0; i < keys.length; i++) {
      for (j = 0; j < lines.length; j++) {
        if (used[j]) continue;
        if (stateKeyOf(lines[j], grade, profile) === keys[i]) { used[j] = 1; out[j] = true; break; }
      }
    }
    return out;
  }

  function quantileStrip(q, cur) {
    var lo = Math.min(pct(q.p10), pct(cur)), hi = Math.max(pct(q.p90), pct(cur));
    var pad = Math.max(0.3, (hi - lo) * 0.12);
    lo -= pad; hi += pad;
    var span = hi - lo || 1;
    function x(v) { return ((pct(v) - lo) / span * 100).toFixed(2) + "%"; }
    function w(a, b) { return ((pct(b) - pct(a)) / span * 100).toFixed(2) + "%"; }
    return '<div class="bc-strip">' +
      '<div class="track"></div>' +
      '<div class="whisk" style="left:' + x(q.p10) + ";width:" + w(q.p10, q.p90) + '"></div>' +
      '<div class="box" style="left:' + x(q.p25) + ";width:" + w(q.p25, q.p75) + '"></div>' +
      '<div class="med" style="left:' + x(q.p50) + '"></div>' +
      '<div class="cur" style="left:' + x(cur) + '" data-gloss="Where the bracelet sits right now."></div>' +
      "</div>" +
      '<div class="bc-qlab" data-gloss="The spread of where this bracelet finishes, over every way the remaining rolls can land under the best play. p10 means one bracelet in ten ends below this; p90, one in ten ends above. The blue box is the middle half, the blue line the median, the orange line where you are today.">' +
      "<span>p10 " + fx(pct(q.p10), 2) + "%</span><span>p25 " + fx(pct(q.p25), 2) +
      "%</span><span>median " + fx(pct(q.p50), 2) + "%</span><span>p75 " + fx(pct(q.p75), 2) +
      "%</span><span>p90 " + fx(pct(q.p90), 2) + "%</span></div>";
  }

  function cardsHtml(res, profile) {
    var baseD = num(S.econ.baseline, 0);
    var curPct = pct(res.currentScore), finPct = pct(res.expectedFinal);
    var val = valueGold(res.expectedFinal);
    var h = '<div class="bc-cards">';
    h += '<div class="bc-card"><div class="k">Current score</div><div class="v">' + fx(curPct, 2) +
      '%</div><div class="s">' + (res.unrolled ? "Unrolled — no granted lines yet." : "Damage over no bracelet, all lines combined.") + "</div></div>";
    h += '<div class="bc-card hero"><div class="k">Expected final</div><div class="v acc">' + fx(finPct, 2) +
      '%</div><div class="s">Where it lands after ' + S.rollsLeft + " roll" + (S.rollsLeft === 1 ? "" : "s") +
      ' played perfectly<span data-gloss="Rolls are free, so rolling always beats stopping. This is the average final score under the best lock-and-keep policy — not a promise, an expectation.">*</span>.</div></div>';
    h += '<div class="bc-card"><div class="k">Worth</div><div class="v gold">' + (val >= 0 ? "" : "−") + gold(Math.abs(val)) +
      '</div><div class="s">(' + fx(finPct, 2) + "% − " + fx(baseD, 2) + "% baseline) × " + gold(gpd()) + " gold.</div></div>";
    if (freshSolve) {
      var fval = valueGold(freshSolve.expectedFinal);
      h += '<div class="bc-card"><div class="k" data-gloss="What a sealed bracelet of this grade and slot count is worth before anyone opens it: the average final score over every set it could roll, with all its rolls still to spend. This is the number a buyer is actually paying for. Slot count moves it a long way.">Unrolled, ' + S.slots + ' slots</div><div class="v">' + gold(fval) +
        '</div><div class="s">What an empty ' + S.grade + " bracelet with " + S.slots + " granted slots and " +
        S.rollsTotal + " rolls is worth: " + fx(pct(freshSolve.expectedFinal), 2) + "%.</div></div>";
    }
    return h + "</div>";
  }

  function advisorHtml(res, profile, lines) {
    if (res.unrolled) {
      return '<div class="panel"><h2 style="margin-top:0">Roll advisor</h2>' +
        "<p>The bracelet has not been opened yet. When it drops, type its granted lines into the Bracelet panel above and the advisor will name the best lines to lock.</p>" +
        "<p class=\"note\">An unrolled bracelet is worth " + fx(pct(res.expectedFinal), 2) +
        "% expected, and the spread below is what the " + S.rollsLeft + " rolls can make of it.</p>" +
        quantileStrip(res.finalScore.quantiles, res.currentScore) + "</div>";
    }
    if (!res.maskEV.length) {
      return '<div class="panel"><h2 style="margin-top:0">Roll advisor</h2>' +
        "<p>No rolls left — this bracelet is final at " + fx(pct(res.currentScore), 2) + "%.</p></div>";
    }

    var best = res.maskEV[0];
    var lockFlags = locksFromKeys(best.lockedKeys, lines, S.grade, profile);
    var h = '<div class="panel"><h2 style="margin-top:0">Roll advisor</h2>';

    h += '<div class="bc-lockline">';
    if (!best.lockedKeys.length) {
      h += "<b>Lock nothing.</b> Reroll all " + S.slots + " slots.";
    } else {
      h += "<b>Lock</b> ";
      var i;
      for (i = 0; i < lockFlags.length; i++) if (lockFlags[i]) h += '<span class="bc-pill lock">Slot ' + (i + 1) + " · " + esc(shortLabel(lines[i], S.grade)) + "</span>";
      h += "<b>reroll</b> ";
      for (i = 0; i < lockFlags.length; i++) if (!lockFlags[i]) h += '<span class="bc-pill roll">Slot ' + (i + 1) + " · " + esc(shortLabel(lines[i], S.grade)) + "</span>";
    }
    h += "</div>";

    var second = res.maskEV.length > 1 ? res.maskEV[1] : null;
    h += '<p class="note">Expected final ' + fx(pct(best.ev), 3) + "%" +
      (second ? ", worth " + gold(deltaGold(best.ev, second.ev)) + " gold more than the next best mask" : "") +
      ". A lock is only worth it when the line it holds is scarcer than what a fresh draw would give you — the solver weighs both, over every remaining roll.</p>";

    h += '<div class="bc-tabwrap"><table><thead><tr><th><span data-gloss="Which slots you pay to keep before pressing reroll. Everything not listed is rerolled together — one attempt rerolls every unlocked slot at once.">Lock</span></th><th class="num"><span data-gloss="The average score this bracelet finishes at if you lock exactly these slots now and then play the remaining rolls perfectly. Rolls are free, so rolling always beats stopping.">Expected final</span></th><th class="num"><span data-gloss="What choosing this mask instead of the best one costs you, in gold, at your gold-per-1% rate.">vs best</span></th></tr></thead><tbody>';
    var n = Math.min(res.maskEV.length, 6), k;
    for (k = 0; k < n; k++) {
      var m = res.maskEV[k], fl = locksFromKeys(m.lockedKeys, lines, S.grade, profile), names = [], j;
      for (j = 0; j < fl.length; j++) if (fl[j]) names.push("slot " + (j + 1));
      h += "<tr" + (k === 0 ? ' class="accent"' : "") + "><td>" + (names.length ? esc(names.join(" + ")) : "nothing — reroll everything") +
        '</td><td class="num">' + fx(pct(m.ev), 3) + '%</td><td class="num">' +
        (k === 0 ? "—" : gold(deltaGold(m.ev, best.ev))) + "</td></tr>";
    }
    h += "</tbody></table></div>";
    if (res.maskCount > n) {
      var rest = res.maskCount - n;
      h += '<div class="note">' + rest + (rest === 1 ? " weaker mask" : " weaker masks") + " not shown.</div>";
    }

    h += '<div class="grid c2" style="margin-top:14px">';
    h += "<div><div class=\"subh\"><span data-gloss=\"How often the bracelet you end up with beats the one you are holding. It is not the chance any single roll is better — you keep the old set whenever the new one is worse, so the only way to finish below where you started is to never take a roll.\">Chance this improves</span></div><div style=\"font-size:22px;font-weight:800\">" +
      fx(res.pImprove * 100, 1) + "%</div><div class=\"note\">Probability the bracelet ends above its current " +
      fx(pct(res.currentScore), 2) + "%, over all " + S.rollsLeft + " remaining rolls played well.</div></div>";
    h += "<div><div class=\"subh\">Where it can land</div>" + quantileStrip(res.finalScore.quantiles, res.currentScore) +
      '<div class="note">Box = the middle half, whisker = p10 to p90, orange = today.</div></div>';
    h += "</div></div>";
    return h;
  }

  /** One row per active combat trait, with the arithmetic in its tooltip. */
  function traitRows(profile) {
    var tv = traitValues(), out = [], i, k, one;
    for (i = 0; i < TRAIT_KEYS.length; i++) {
      k = TRAIT_KEYS[i];
      if (!tv[k]) continue;
      one = {};
      one[k] = tv[k];
      var d = B.traitDamage(one, profile), why;
      if (k === "crit") {
        var pp = tv[k] * B.TRAIT_CRIT_PP_PER_POINT;
        why = tv[k] + " Crit converts at 25 points of crit rate per 699 trait points = +" + fx(pp, 2) +
          " pp crit rate, worth " + signPct(pct(d)) + " once your skills' crit rate and crit damage are applied.";
      } else {
        why = tv[k] + " " + TRAIT_LABELS[k] + " at " + fx(num(k === "spec" ? S.fight.wSpec : S.fight.wSwift, 0), 1) +
          "% per 100 points = " + fx(d, 2) + " points of damage.";
      }
      out.push({ label: TRAIT_LABELS[k] + " " + tv[k], damage: d, why: why });
    }
    return out;
  }

  function breakdownHtml(profile, lines, res) {
    var all = fixedLines().concat(lines);
    var traits = traitRows(profile);
    if (!all.length && !traits.length) return "";
    var h = '<div class="panel"><h2 style="margin-top:0">Line by line</h2><div class="bc-tabwrap"><table>' +
      '<thead><tr><th>Slot</th><th>Line</th><th class="num">Damage</th><th class="num">Share</th></tr></thead><tbody>';
    var total = 0, i, ds = [];
    for (i = 0; i < traits.length; i++) total += traits[i].damage;
    for (i = 0; i < all.length; i++) { var d = B.lineDamage(all[i], S.grade, profile); ds.push(d); total += d; }
    function shareCell(x) { return '<td class="num">' + (total > 1e-9 ? fx(x / total * 100, 0) + "%" : "—") + "</td>"; }
    for (i = 0; i < traits.length; i++) {
      h += "<tr><td>Trait " + (i + 1) + "</td><td>" + esc(traits[i].label) + "</td>" +
        '<td class="num"><span data-gloss="' + esc(traits[i].why) + '">' + signPct(pct(traits[i].damage)) + "</span></td>" +
        shareCell(traits[i].damage) + "</tr>";
    }
    var nFixed = fixedLines().length;
    for (i = 0; i < all.length; i++) {
      var lbl = i < nFixed ? "Fixed " + (i + 1) : "Slot " + (i - nFixed + 1);
      h += "<tr><td>" + lbl + "</td><td>" + esc(lineLabel(all[i], S.grade)) + '</td>' +
        '<td class="num"><span data-gloss="' + esc(explainLine(all[i], S.grade, profile)) + '">' + signPct(pct(ds[i])) + "</span></td>" +
        shareCell(ds[i]) + "</tr>";
    }
    h += "</tbody></table></div>";
    h += '<p class="note">Every line is scored D = 100·ln(multiplier), so multiplicative gains add up. The bracelet total is the exact (e^(ΣD/100) − 1)×100 = <b>' +
      fx(pct(total), 2) + "%</b>, a shade under the column sum because damage multiplies. Hover a number for the arithmetic behind it.</p></div>";
    return h;
  }

  // ---- cut flow ----

  function cutLocks(res, lines, profile) {
    if (S.locks && S.locks.length === S.slots) return S.locks;
    if (res && res.bestLockMask) return locksFromKeys(res.bestLockMask.lockedKeys, lines, S.grade, profile);
    var out = [], i;
    for (i = 0; i < S.slots; i++) out.push(false);
    return out;
  }

  function ensureRolled() {
    if (!S.rolled || S.rolled.length !== S.slots) {
      S.rolled = [];
      for (var i = 0; i < S.slots; i++) S.rolled.push(blankRow());
    }
    return S.rolled;
  }

  var lastVerdict = null;

  function cutHtml(res, profile, lines) {
    if (res.unrolled) return "";
    var h = '<div class="panel" id="bc-cut"><h2 style="margin-top:0">I rolled — keep or replace?</h2>';
    if (S.rollsLeft <= 0) {
      return h + "<p>No rolls left.</p>" + historyHtml() + "</div>";
    }
    var locks = cutLocks(res, lines, profile);
    ensureRolled();

    h += '<p class="note">Lock what you locked in game, type the lines the roll gave you, and the tool compares the two sets by what they are worth with ' +
      (S.rollsLeft - 1) + " roll" + (S.rollsLeft - 1 === 1 ? "" : "s") +
      ' still to come<span data-gloss="Not by which set scores more today. A weaker set can be worth more because of what it clears out of the pool for the rolls that follow.">*</span>.</p>';

    h += '<div class="bc-cutgrid"><div><div class="subh">Locked for this roll</div>';
    var i;
    for (i = 0; i < S.slots; i++) {
      h += '<div class="bc-lockrow"><input type="checkbox" data-lock="' + i + '"' + (locks[i] ? " checked" : "") +
        '><span class="ln">Slot ' + (i + 1) + " · " + esc(shortLabel(lines[i], S.grade)) + "</span></div>";
    }
    h += "</div><div><div class=\"subh\">What the roll gave you</div>";
    var any = false;
    for (i = 0; i < S.slots; i++) {
      if (locks[i]) continue;
      any = true;
      h += rowMarkup(i, S.rolled[i], "bc-n", "Slot " + (i + 1));
    }
    if (!any) h += '<div class="note">Every slot is locked — nothing would reroll.</div>';
    h += "</div></div>";

    h += '<div class="barrow"><button class="primary" id="bc-check" type="button">Check this roll</button>' +
      '<button class="mbtn" id="bc-undo" type="button"' + (S.history.length ? "" : " disabled") + ">Undo last</button></div>";

    if (lastVerdict) h += verdictHtml(lastVerdict);
    h += historyHtml();
    return h + "</div>";
  }

  function verdictHtml(v) {
    if (v.error) return '<div class="bc-warn">' + esc(v.error) + "</div>";
    var take = v.verdict === "replace";
    var dGold = deltaGold(v.vNew, v.vKeep);
    var h = '<div class="bc-verdict ' + (take ? "replace" : "keep") + '">' +
      '<div class="hd">' + (take ? "TAKE THE NEW SET" : "KEEP WHAT YOU HAVE") + "</div>" +
      '<div class="bd">New set is worth ' + fx(pct(v.vNew), 3) + "% against " + fx(pct(v.vKeep), 3) +
      "% for the old one, both counting the " + v.rollsLeft + " roll" + (v.rollsLeft === 1 ? "" : "s") + " still to come. " +
      "That is " + signPct(pct(v.vNew) - pct(v.vKeep)) + ", or " + (dGold >= 0 ? "+" : "−") + gold(Math.abs(dGold)) + " gold. " +
      "On today's score alone it would be " + fx(pct(v.scoreNew), 2) + "% against " + fx(pct(v.scoreKeep), 2) + "%.</div>" +
      '<div class="barrow"><button class="' + (take ? "primary" : "mbtn") + '" id="bc-apply-new" type="button">Apply — take the new set</button>' +
      '<button class="' + (take ? "mbtn" : "primary") + '" id="bc-apply-keep" type="button">Apply — keep the old set</button></div>' +
      "</div>";
    return h;
  }

  function historyHtml() {
    if (!S.history.length) return "";
    var h = '<div class="subh">This session</div><ul class="bc-hist">', i;
    for (i = S.history.length - 1; i >= 0; i--) {
      var e = S.history[i];
      h += "<li><b>" + (e.took ? "Replaced" : "Kept") + "</b> at " + e.rollsBefore + " rolls left · " +
        (e.locked.length ? "locked " + esc(e.locked.join(", ")) : "nothing locked") + " · rolled " +
        esc(e.rolledText) + " · " + signPct(e.deltaPct) + "</li>";
    }
    return h + "</ul>";
  }

  function renderResults(profile, err) {
    var box = $("bc-results");
    if (!box) return;
    if (err) {
      box.innerHTML = '<div class="panel"><div class="bc-warn">' + esc(err) + "</div></div>";
      return;
    }
    if (isPartial()) {
      box.innerHTML = '<div class="panel"><div class="bc-warn">Fill every granted slot, or leave them all empty for an unrolled bracelet — a half-filled bracelet is not a state the game can be in.</div></div>';
      return;
    }
    if (!lastSolve) {
      box.innerHTML = '<div class="panel"><div class="note">Solving…</div></div>';
      return;
    }
    var lines = grantedLines();
    box.innerHTML = cardsHtml(lastSolve, profile) +
      advisorHtml(lastSolve, profile, lines) +
      cutHtml(lastSolve, profile, lines) +
      breakdownHtml(profile, lines, lastSolve);
  }

  // ------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------

  // Rebuilding a field group under the cursor drops focus mid-keystroke, so the
  // cheap live parts (the read-out line, the share note, the priced pickers) are
  // refreshed on every edit, and the field groups themselves only when their
  // SHAPE changes — grade, slot count, the WP/main-stat override, adding a skill.
  function focusInside(id) {
    var el = $(id), a = document.activeElement;
    return !!(el && a && el.contains(a));
  }
  /** Rebuild markup, then put the cursor back on the element it was on. */
  function keepFocus(fn) {
    var a = document.activeElement, id = (a && a.id) ? a.id : null;
    fn();
    if (id) { var el = $(id); if (el && el.focus) el.focus(); }
  }
  /**
   * Picking a family has to redraw its row — that is where the tier dropdown and
   * the value box appear. Only a half-typed NUMBER is worth protecting: rebuild
   * that and the keystroke is lost.
   */
  function redrawSlots() {
    var a = document.activeElement, box = $("bc-slots");
    if (box && a && box.contains(a) && a.tagName === "INPUT") return;
    keepFocus(renderSlots);
  }
  function redrawLive() {
    updateBasicsNote();
    updateIlvl();
    redrawSlots();
  }

  var SHAPE_FIELDS = { grade: 1, slots: 1, useOverride: 1 };

  /** Rebuild every control, then the bracelet rows under it. */
  function redrawAll() {
    keepFocus(function () { renderInputs(); renderSlots(); });
  }

  /** A segmented/toggle press solves at once — no debounce to sit through. */
  function solveNow() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    recompute();
  }

  function onFieldChange(el) {
    var path = el.getAttribute && el.getAttribute("data-k"), t = el.getAttribute("data-t");
    if (!path) return false;
    if (t === "chk") setPath(S, path, !!el.checked);
    else if (t === "rng") setPath(S, path, Number(el.value));
    else if (t === "num") setPath(S, path, num(el.value, getPath(S, path)));
    else setPath(S, path, isNaN(Number(el.value)) ? el.value : Number(el.value));
    if (path === "rollsLeft") S.rollsTotal = Math.max(S.rollsTotal, num(el.value, 7));
    if (path === "grade" || path === "slots") { S.locks = null; S.rolled = null; lastVerdict = null; }
    save();
    if (t === "rng") {
      // Mid-drag: repaint the chip and the derived read-outs only. Rebuilding
      // the control would tear the slider out from under the mouse.
      var chip = $(chipId(path)), f = FMT[el.getAttribute("data-fmt")] || FMT.raw;
      if (chip) chip.textContent = f(Number(el.value));
      if (path.indexOf("gear.") === 0) updateIlvl();
      if (path === "kit.gems") updateKitNote();
    }
    if (SHAPE_FIELDS[path]) {
      if (path === "grade") fitTraits();
      fitRows();
      redrawAll();
    } else if (path === "adv.baseApOverride") {
      keepFocus(function () { renderKit(); renderAdvanced(); });
    } else if (path.indexOf("adv.") === 0) {
      // Karma and the attack-power override feed the two derived buckets the
      // Gear column prints; refresh that line without rebuilding the field.
      updateKitNote();
    }
    redrawLive();
    schedule();
    return true;
  }

  /** The one derived line under the gem slider that a drag has to keep honest. */
  function updateKitNote() {
    var box = $("bc-kit");
    if (!box) return;
    var n = box.getElementsByClassName("note");
    if (n.length) n[0].textContent = "Weapon power bucket " + fx(wpPctOf(), 1) +
      "% · attack power bucket " + fx(baseApPctOf(), 1) + "%.";
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
      renderInputs(); redrawLive(); solveNow();
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

  function bindPanel() {
    var panel = $("bc-inputs");
    function fieldEvent(e) {
      var el = e.target;
      if (el.id === "bc-gpd") {
        S.econ.gpd = gpdFromPos(Number(el.value));
        var gc = $("bc-gpd-chip");
        if (gc) gc.textContent = gold(S.econ.gpd);
        save(); schedule();                       // gold is not in the solve key: a cache hit
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
        save(); redrawLive(); schedule();
        return;
      }
      onFieldChange(el);
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
      renderSkills(); redrawLive(); schedule();
    });

    panel.addEventListener("click", function (e) {
      var t = e.target, d, seg, tgl, chip;
      // A click can land on the chip's own text node in some browsers.
      if (t && t.className && String(t.className).indexOf("chip") >= 0) chip = t;

      if ((seg = t.getAttribute && t.getAttribute("data-seg"))) {
        var raw = t.getAttribute("data-v");
        setPath(S, seg, (raw !== "" && !isNaN(Number(raw))) ? Number(raw) : raw);
        save();
        keepFocus(function () { renderKit(); renderAdvanced(); });
        redrawLive(); solveNow();
        return;
      }
      if ((tgl = t.getAttribute && t.getAttribute("data-tgl"))) {
        setPath(S, tgl, !getPath(S, tgl));
        save();
        keepFocus(function () { renderKit(); renderFight(); renderAdvanced(); });
        redrawLive(); solveNow();
        return;
      }
      if (chip && chip.getAttribute("data-editk")) {
        var ep = chip.getAttribute("data-editk");
        editChip(chip, function () { return getPath(S, ep); }, function (v) { setPath(S, ep, v); });
        return;
      }

      if (t.id === "bc-addskill") {
        S.skills.push({ name: "", share: 0, cr: 90, cd: 280 });
        normalizeShares();                       // a new skill enters at an equal share
        var eq = distribute((function () { var w = [], j; for (j = 0; j < S.skills.length; j++) w.push(1); return w; })(), 100), j2;
        for (j2 = 0; j2 < S.skills.length; j2++) S.skills[j2].share = eq[j2];
        save(); renderSkills(); redrawSlots(); solveNow();
      } else if (t.getAttribute && (d = t.getAttribute("data-delsk")) !== null && d !== "") {
        if (S.skills.length > 1) {
          S.skills.splice(Number(d), 1);
          normalizeShares();
          save(); renderSkills(); redrawSlots(); solveNow();
        }
      } else if (t.id === "bc-advtoggle") { S.advOpen = !S.advOpen; save(); renderAdvanced(); }
      else if (t.id === "bc-addfixed") {
        if (S.fixedRows.length < 2) { S.fixedRows.push(blankRow()); save(); renderAdvanced(); schedule(); }
      } else if (t.id === "bc-reset") {
        if (window.confirm("Reset every input, the bracelet and this session's rolls?")) {
          try { localStorage.removeItem(LS_KEY); } catch (er) { /* ignore */ }
          S = defaults(); lastVerdict = null; cache = {}; cacheOrder = [];
          freshSolve = null; lastSolve = null; freshSolveKey = null; lastSolveKey = null; workerCtxKey = null;
          fitRows(); renderInputs(); renderSlots();
          solveNow();
        }
      }
    });

    // The whole header row collapses the panel, not just the little arrow.
    var hdr = panel.getElementsByClassName("ihdr")[0];
    hdr.addEventListener("click", function () {
      var body = $("bc-inputs-body"), c = $("bc-caret");
      var hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      c.innerHTML = hidden ? "&#9662;" : "&#9656;";
    });
  }


  // Slot / fixed / rolled rows share one delegated handler, keyed by the id
  // prefix the row was rendered with.
  function rowsFor(prefix) {
    if (prefix === "bc-r") return S.rows;
    if (prefix === "bc-f") return S.fixedRows;
    return ensureRolled();
  }

  function handleRowEvent(el) {
    var id = el.id || "";
    var m = /^(bc-[rfn])-(fam|tier|val)-(\d+)$/.exec(id);
    if (!m) return false;
    var rows = rowsFor(m[1]), i = Number(m[3]), row = rows[i];
    if (!row) return false;
    if (m[2] === "fam") {
      row.fam = el.value;
      if (row.fam === JUNK) row.value = null;               // a junk line has no number and no rarity
      if (row.fam.indexOf("basic:") === 0 && (row.value === null || row.value === undefined || row.value === "")) {
        row.value = defaultBasicValue(S.grade, row.fam.slice(6));
      }
      // Repaint the closed control at once: every caller re-renders the row
      // afterwards, but not before the browser has painted the new selection.
      var lt = letterOf(row.fam, S.grade);
      el.style.color = lt ? GRADE_COLOR[lt] : "var(--text)";
      if (m[1] === "bc-r") { S.locks = null; lastVerdict = null; }
    } else if (m[2] === "tier") {
      row.tier = el.value;
    } else {
      row.value = num(el.value, row.value);
    }
    return true;
  }

  function bindBody() {
    var root = $("tab-calculator");
    root.addEventListener("change", function (e) {
      if (!handleRowEvent(e.target)) return;
      save();
      var pre = (e.target.id || "").slice(0, 4);
      if (pre === "bc-f") keepFocus(renderFixedRows);
      else if (pre === "bc-n") keepFocus(function () { renderResults(buildProfile(), null); });
      else redrawSlots();
      schedule();
    });
    root.addEventListener("input", function (e) {
      var id = e.target.id || "", tr;
      if (/^bc-[rfn]-val-\d+$/.test(id)) { handleRowEvent(e.target); save(); schedule(); return; }
      if ((tr = e.target.getAttribute && e.target.getAttribute("data-tr"))) {
        // Clamp what the MODEL sees to the official band, but leave the box
        // alone while it is being typed in.
        var bd = traitBand();
        S.traits[tr].v = clamp(Math.round(num(e.target.value, S.traits[tr].v)), bd[0], bd[1]);
        save(); updateBasicsNote(); schedule();
      }
    });
    root.addEventListener("focusout", function (e) {
      if (e.target.getAttribute && e.target.getAttribute("data-tr")) renderTraits();
    });
    root.addEventListener("click", function (e) {
      var t = e.target, lk, tron;
      if ((tron = t.getAttribute && t.getAttribute("data-tron"))) {
        // A plain on/off toggle. Turning a third one on is allowed — the panel
        // warns that the bracelet is illegal instead of silently dropping one.
        S.traits[tron].on = !S.traits[tron].on;
        save(); renderTraits(); updateBasicsNote(); solveNow();
        return;
      }
      if (t.id === "bc-clear") {
        S.rows = []; fitRows(); S.locks = null; S.rolled = null; lastVerdict = null;
        save(); redrawSlots(); recompute();
      } else if ((lk = t.getAttribute && t.getAttribute("data-lock")) !== null && lk !== undefined && lk !== "") {
        var locks = cutLocks(lastSolve, grantedLines(), buildProfile()).slice();
        locks[Number(lk)] = !!t.checked;
        S.locks = locks; lastVerdict = null; save();
        renderResults(buildProfile(), null);
      } else if (t.id === "bc-check") { checkRoll(); }
      else if (t.id === "bc-apply-new") { applyVerdict(true); }
      else if (t.id === "bc-apply-keep") { applyVerdict(false); }
      else if (t.id === "bc-undo") { undo(); }
    });
  }

  // ---- the cut flow ----

  function rolledSet(locks) {
    var lines = grantedLines(), reps = junkReps(), out = [], i;
    for (i = 0; i < S.slots; i++) {
      // Same slot, same junk stand-in on both sides, so a locked junk slot and
      // a rolled one can never collide into a duplicate family.
      out.push(locks[i] ? lines[i] : rowToLine(S.rolled[i], S.grade, reps[i]));
    }
    return out;
  }

  function checkRoll() {
    var profile = buildProfile(), lines = grantedLines();
    var locks = cutLocks(lastSolve, lines, profile);
    var newSet = rolledSet(locks), i;
    for (i = 0; i < newSet.length; i++) {
      if (!newSet[i]) { lastVerdict = { error: "Slot " + (i + 1) + " of the new roll is still empty — pick the line it gave you." }; renderResults(profile, null); return; }
    }
    var bad = validateSet(fixedLines().concat(newSet));
    if (bad) { lastVerdict = { error: "That roll is not legal: " + bad }; renderResults(profile, null); return; }

    // advise() reads the solved DP inside the worker. If the worker is holding a
    // different bracelet — a cache hit answered the display without ever calling
    // it — solve this one first, in the same click.
    var ready = (workerCtxKey === lastSolveKey && lastSolveKey)
      ? Promise.resolve()
      : solveState(profile, lines, S.rollsLeft, { force: true }).then(function (out) {
        lastSolve = out.res; lastSolveKey = out.key;
      });

    ready.then(function () {
      return send("advise", { current: lines, rolled: newSet, rollsLeft: S.rollsLeft - 1, ctxKey: lastSolveKey });
    }).then(function (v) {
      if (v.verdict === "unknown") lastVerdict = { error: "The solver does not recognise one of those sets — check for a duplicate effect." };
      else { v.newSet = newSet; v.locks = locks; lastVerdict = v; }
      renderResults(buildProfile(), null);
    }, function (e) {
      if (e && e.message === "superseded") return;
      lastVerdict = { error: "Could not judge that roll: " + ((e && e.message) || "unknown error") + ". Change any input to rebuild, then try again." };
      renderResults(buildProfile(), null);
    });
  }

  function applyVerdict(take) {
    if (!lastVerdict || lastVerdict.error) return;
    var lines = grantedLines(), locks = lastVerdict.locks, i;
    var lockNames = [];
    for (i = 0; i < locks.length; i++) if (locks[i]) lockNames.push("slot " + (i + 1));
    var rolledText = [];
    for (i = 0; i < S.slots; i++) if (!locks[i]) rolledText.push(shortLabel(lastVerdict.newSet[i], S.grade));

    S.history.push({
      rollsBefore: S.rollsLeft,
      locked: lockNames,
      rolledText: rolledText.join(" + "),
      took: !!take,
      deltaPct: pct(lastVerdict.vNew) - pct(lastVerdict.vKeep),
      prevRows: JSON.parse(JSON.stringify(S.rows))
    });

    if (take) {
      var rows = [];
      for (i = 0; i < S.slots; i++) rows.push(locks[i] ? S.rows[i] : JSON.parse(JSON.stringify(S.rolled[i])));
      S.rows = rows;
    }
    S.rollsLeft = Math.max(0, S.rollsLeft - 1);
    S.locks = null; S.rolled = null; lastVerdict = null;
    save(); renderTop(); renderSlots(); recompute();   // rollsLeft moved: redraw its field too
  }

  function undo() {
    var e = S.history.pop();
    if (!e) return;
    S.rows = e.prevRows;
    S.rollsLeft = e.rollsBefore;
    S.locks = null; S.rolled = null; lastVerdict = null;
    fitRows(); save(); renderTop(); renderSlots(); recompute();
  }

  // ------------------------------------------------------------------
  // init
  // ------------------------------------------------------------------

  function init() {
    var pane = $("tab-calculator");
    if (!pane || pane.getAttribute("data-init")) return;
    pane.setAttribute("data-init", "1");
    load();
    fitRows();
    pane.innerHTML = tabMarkup();
    renderInputs();
    renderSlots();
    bindPanel();
    bindBody();
    renderResults(buildProfile(), null);
    recompute();
  }

  /**
   * The one hook bible-import.js uses. It hands over a patch already in this
   * file's own shape — grade, slots, the two combat traits, the granted rows and
   * any fixed rows — and everything after that is the ordinary redraw an edit
   * would trigger. Keys the patch leaves out keep their current value, so an
   * import never disturbs the character or economy settings.
   */
  window.BraceletApp = {
    applyImport: function (patch) {
      if (!patch) return false;
      var keys = ["grade", "slots", "rollsLeft", "traits", "traitOrder", "rows", "fixedRows"], i;
      for (i = 0; i < keys.length; i++) {
        if (patch[keys[i]] !== undefined) S[keys[i]] = patch[keys[i]];
      }
      S.locks = null; S.rolled = null;      // a new bracelet voids the cut in progress
      fitRows();
      renderInputs();
      renderSlots();
      save();
      recompute();
      return true;
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
