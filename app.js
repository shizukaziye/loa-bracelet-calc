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
  var GPD_TIERS = [500000, 1000000, 1500000, 2500000, 3500000, 5000000, 7500000, 10000000];
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
      v: 1,
      grade: "ancient",
      slots: 3,
      rollsLeft: 7,
      rollsTotal: 7,                 // what a FRESH bracelet gets — drives the "unrolled" price
      useOverride: false,
      gear: { weapon: 25, gloves: 23, other: 21 },
      ov: { mainStatRaw: 703826, weaponPowerRaw: 241367 },
      adv: {
        msPct: 9, wpPct: 8.5, baseApPct: 12.5, flatAP: 2700,
        accessoryMainStat: 71429, rosterBonus: 2085,
        addWeapon: 30, addPet: 1, addNeck: 2.6, addAstrogem: 4.84, master: false,
        backShare: 0, frontShare: 0, nonDirShare: 0, staggerShare: 5,
        demonShare: 0, demonBase: 7.3, shieldUptime: 60, enemyDR: 50,
        cdWeight: 0.5, allyCount: 2,
        wpStacks20: 4.8, wpUptime21: 90, wpStacks22: 4
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
    if (!got || got.v !== 1) return;             // a future format: start clean rather than guess
    var d = defaults(), k;
    for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) {
      if (got[k] === undefined || got[k] === null) continue;
      if (k === "adv" || k === "gear" || k === "ov" || k === "econ") {
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
  }

  // ------------------------------------------------------------------
  // state -> model profile
  // ------------------------------------------------------------------

  function baseStats() {
    if (S.useOverride) {
      return { mainStatRaw: num(S.ov.mainStatRaw, 703826), weaponPowerRaw: num(S.ov.weaponPowerRaw, 241367), ilvl: null };
    }
    var g = S.gear, a = S.adv;
    return B.deriveBaseline({
      pieceLevels: { head: g.other, shoulder: g.other, chest: g.other, pants: g.other, gloves: g.gloves, weapon: g.weapon },
      msPct: a.msPct / 100, wpPct: a.wpPct / 100, baseApPct: a.baseApPct / 100, flatAP: a.flatAP,
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
      msPct: a.msPct / 100, wpPct: a.wpPct / 100, baseApPct: a.baseApPct / 100, flatAP: a.flatAP,
      skills: sk,
      master: !!a.master,
      addDamage: {
        weaponQuality: a.addWeapon / 100, pet: a.addPet / 100,
        astrogemLv60: a.addAstrogem / 100, neck: a.addNeck / 100
      },
      backAttackShare: a.backShare / 100,
      frontAttackShare: a.frontShare / 100,
      nonDirectionalShare: a.nonDirShare / 100,
      staggeredShare: a.staggerShare / 100,
      demonShare: a.demonShare / 100,
      demonBase: a.demonBase / 100,
      shieldUptime: a.shieldUptime / 100,
      allyDpsCount: a.allyCount,
      allyCritRate: 0.90, allyCritDamage: 2.8,
      enemyBaseDR: a.enemyDR / 100,
      cooldownPenaltyWeight: a.cdWeight,
      wpStacks20: a.wpStacks20, wpUptime21: a.wpUptime21 / 100, wpStacks22: a.wpStacks22,
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

  function rowToLine(r, grade) {
    if (!r || !r.fam || r.fam === "none") return null;
    if (r.fam.indexOf("basic:") === 0) {
      var fam = r.fam.slice(6);
      var v = (r.value === null || r.value === undefined || r.value === "") ? defaultBasicValue(grade, fam) : num(r.value, defaultBasicValue(grade, fam));
      var rg = msRange(grade, fam);
      return { cat: "basic", family: fam, value: clamp(v, rg[0], rg[1]) };
    }
    if (r.fam.indexOf("trait:") === 0) return { cat: "trait", family: r.fam.slice(6) };
    return { cat: "special", family: Number(r.fam.slice(3)), tier: r.tier || "mid" };
  }

  function linesOf(rows, grade) {
    var out = [], i, l;
    for (i = 0; i < rows.length; i++) { l = rowToLine(rows[i], grade); if (l) out.push(l); }
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

  function fixedLines() { return linesOf(S.fixedRows, S.grade); }
  function grantedLines() { return linesOf(S.rows, S.grade); }
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
    return (wp && only) ? "Weapon Power" : null;      // null = decide by damage
  }

  /**
   * Every family a slot can hold, grouped and priced for THIS profile at the
   * row's current tier. `msValue` prices the main-stat option at the number the
   * row actually holds.
   */
  function familyOptions(grade, profile, tier, msValue) {
    var G = { Damage: [], Party: [], "Weapon Power": [], Stats: [], Junk: [] };
    var i, t;

    G.Stats.push({ val: "basic:mainStat", text: "Str / Dex / Int",
      dmg: B.lineDamage({ cat: "basic", family: "mainStat", value: msValue }, grade, profile) });
    G.Stats.push({ val: "basic:vitality", text: "Vitality", dmg: 0 });
    for (i = 0; i < DATA.TRAITS.families.length; i++) {
      G.Stats.push({ val: "trait:" + DATA.TRAITS.families[i].key, text: DATA.TRAITS.families[i].label + " (combat trait)", dmg: 0 });
    }

    for (i = 0; i < DATA.SPECIALS.length; i++) {
      var fam = DATA.SPECIALS[i], best = 0, here = 0;
      for (t = 0; t < TIERS.length; t++) {
        var d = B.lineDamage({ cat: "special", family: fam.id, tier: TIERS[t] }, grade, profile);
        if (d > best) best = d;
        if (TIERS[t] === tier) here = d;
      }
      var g = famGroupOf(fam);
      if (!g) g = best > 1e-9 ? "Damage" : "Junk";
      G[g].push({ val: "sp:" + fam.id, text: fam.label, dmg: here, best: best });
    }

    var groups = [], order = ["Damage", "Party", "Weapon Power", "Stats", "Junk"], max = 0;
    for (i = 0; i < order.length; i++) {
      var items = G[order[i]];
      items.sort(function (a, b) { return b.dmg - a.dmg; });
      for (t = 0; t < items.length; t++) if (items[t].dmg > max) max = items[t].dmg;
      groups.push({ label: order[i], items: items });
    }
    for (i = 0; i < groups.length; i++) {
      for (t = 0; t < groups[i].items.length; t++) groups[i].items[t].color = dmgColor(groups[i].items[t].dmg, max);
    }
    return groups;
  }

  // Colour by share of the best line on offer, so the scale follows the profile
  // rather than a hardcoded idea of what "good" is.
  function dmgColor(d, max) {
    if (d <= 1e-9) return "var(--useless)";
    if (max <= 0) return "var(--text)";
    var f = d / max;
    if (f >= 0.75) return "var(--high)";
    if (f >= 0.50) return "var(--mid)";
    if (f >= 0.25) return "var(--low)";
    return "var(--dim)";
  }

  function pickerHtml(id, groups, selected) {
    var h = '<select id="' + id + '" class="bc-fam">', i, j;
    h += '<option value="none"' + (selected === "none" ? " selected" : "") + '>— empty —</option>';
    for (i = 0; i < groups.length; i++) {
      if (!groups[i].items.length) continue;
      h += '<optgroup label="' + esc(groups[i].label) + '">';
      for (j = 0; j < groups[i].items.length; j++) {
        var it = groups[i].items[j];
        h += '<option value="' + esc(it.val) + '" style="color:' + it.color + '"' +
          (selected === it.val ? " selected" : "") + '>' +
          esc(it.text) + "  ·  " + signPct(pct(it.dmg)) + '</option>';
      }
      h += "</optgroup>";
    }
    return h + "</select>";
  }

  // ------------------------------------------------------------------
  // per-line explanations (the data-gloss text on the breakdown table)
  // ------------------------------------------------------------------

  function nf(v) { return Math.round(v).toLocaleString("en-US"); }

  function explainLine(line, grade, profile) {
    if (!line) return "";
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
      profile.shieldUptime, profile.allyDpsCount, profile.enemyBaseDR, profile.cooldownPenaltyWeight
    ]);
  }

  // Gold is deliberately NOT in the key: value = (expectedFinal − baseline) × gpd
  // is arithmetic we redo here, so moving the gold slider never re-solves.
  function keyOf(profile, granted, rolls) {
    return JSON.stringify([S.grade, S.slots, rolls, fixedLines(), granted]) + "|" + profileSig(profile);
  }

  function ensureWorker() {
    if (worker) return worker;
    try {
      worker = new Worker("solver-worker.js?v=2");
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

  function styleBlock() {
    return "<style>" +
      // The inputs panel sticks, but a tall sticky block would cover the whole
      // screen while you read the results under it. Cap it and let it scroll
      // inside itself; below tablet width it just scrolls with the page.
      "#tab-calculator #bc-inputs{max-height:78vh;overflow:auto}" +
      "@media(max-width:760px){#tab-calculator #bc-inputs{position:static;max-height:none;overflow:visible}}" +
      "#tab-calculator .bc-busy{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--border);margin-left:8px;vertical-align:middle;transition:background .15s}" +
      "#tab-calculator .bc-busy.on{background:var(--accent);animation:bc-pulse 1s ease-in-out infinite}" +
      "@keyframes bc-pulse{0%,100%{opacity:.25}50%{opacity:1}}" +
      "#tab-calculator .bc-sub{font-size:11px;color:var(--dim);margin:-4px 0 10px}" +
      "#tab-calculator .bc-hdrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}" +
      "#tab-calculator .bc-fam{width:100%}" +
      "#tab-calculator .bc-slot{display:grid;grid-template-columns:44px minmax(0,1fr) 120px 130px;gap:8px;align-items:end;margin-bottom:8px}" +
      "#tab-calculator .bc-slot .sn{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;padding-bottom:7px}" +
      "@media(max-width:640px){#tab-calculator .bc-slot{grid-template-columns:1fr;gap:5px}#tab-calculator .bc-slot .sn{padding-bottom:0}}" +
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
      "#tab-calculator .bc-skill{display:grid;grid-template-columns:minmax(0,1.4fr) 90px 100px 110px 32px;gap:8px;align-items:end;margin-bottom:7px}" +
      "@media(max-width:640px){#tab-calculator .bc-skill{grid-template-columns:1fr 1fr}" +
      "#tab-calculator .bc-skill .bc-x{justify-self:start;width:44px}}" +
      "#tab-calculator .bc-x{background:var(--panel2);border:1px solid var(--border);color:var(--dim);border-radius:6px;height:29px;cursor:pointer;font-family:inherit;font-size:14px}" +
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
      '    <div class="ig" id="bc-basics"></div>' +
      '    <div class="subh">Skills — damage share, crit rate, crit damage</div>' +
      '    <div id="bc-skills"></div>' +
      '    <div class="barrow"><button class="mbtn" id="bc-addskill" type="button">+ Add skill</button>' +
      '      <span class="note" id="bc-sharenote"></span></div>' +
      '    <div class="subh">Economy</div>' +
      '    <div class="ig" id="bc-econ"></div>' +
      '    <div class="barrow">' +
      '      <button class="mbtn" id="bc-advtoggle" type="button">Advanced ▾</button>' +
      '      <button class="mbtn" id="bc-reset" type="button">Reset to defaults</button>' +
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

  function renderBasics() {
    var lv = [], i;
    for (i = 0; i <= 25; i++) lv.push({ v: i, t: "+" + i });
    var ch = slotChoices(), chOpts = [], j;
    for (j = 0; j < ch.length; j++) chOpts.push({ v: ch[j], t: ch[j] + " slots" });

    var h = "";
    h += fldSel("grade", "Grade", [{ v: "ancient", t: "Ancient" }, { v: "relic", t: "Relic" }],
      "Ancient bracelets roll 2 or 3 granted slots and higher line values; Relic rolls 1 or 2.");
    h += fldSel("slots", "Granted slots", chOpts,
      "The rerollable lines. Ancient: 3 slots on 25% of drops, 2 on 75%. Slot count moves the value of an unrolled bracelet a lot.");
    h += fldNum("rollsLeft", "Rolls left", "1", "A fresh bracelet has 4 rolls plus up to 3 reconversion-ticket rolls = 7. The cut flow counts this down.");
    h += fldChk("useOverride", "Enter WP / main stat directly", "Skip the honing table and type the two raw numbers straight off your character sheet (before the % buckets).");
    if (S.useOverride) {
      h += fldNum("ov.mainStatRaw", "Main stat (raw)", "1", "Before the main-stat % bucket: the five armour pieces + accessories + base + roster.");
      h += fldNum("ov.weaponPowerRaw", "Weapon power (raw)", "1", "Before the weapon-power % bucket: the weapon's table value.");
    } else {
      h += fldSel("gear.weapon", "Weapon honing", lv, "Serca honing level of the weapon. Level 25 = item level 1800.");
      h += fldSel("gear.gloves", "Gloves honing", lv, "Serca honing level of the gloves.");
      h += fldSel("gear.other", "Other four", lv, "Head, shoulder, chest and pants — all at this honing level.");
    }
    $("bc-basics").innerHTML = h;
    updateBasicsNote();
  }

  // The live read-out under the bracelet header. Split out of renderBasics so a
  // keystroke can refresh it without rebuilding the fields under the cursor.
  function updateBasicsNote() {
    var note = $("bc-slotnote");
    if (!note) return;
    var base = baseStats(), p = buildProfile();
    var msg = S.useOverride
      ? "Main stat " + nf(base.mainStatRaw) + " raw · weapon power " + nf(base.weaponPowerRaw) + " raw"
      : "Item level " + base.ilvl + " · main stat " + nf(base.mainStatRaw) + " raw · weapon power " + nf(base.weaponPowerRaw) + " raw";
    msg += " · attack power " + nf(B.attackPower(p, 0, 0)) + " · additional damage pool " + fx(B.addDamagePool(p) * 100, 2) + "%";
    note.textContent = msg + ". Leave every slot empty for an unrolled bracelet.";
  }

  function renderSkills() {
    var h = "", i;
    for (i = 0; i < S.skills.length; i++) {
      var s = S.skills[i];
      h += '<div class="bc-skill">' +
        '<div class="fld"><label>Name (optional)</label><input type="text" data-sk="' + i + '" data-f="name" value="' + esc(s.name || "") + '" placeholder="e.g. Awakening"></div>' +
        '<div class="fld"><label>Share %</label><input type="number" step="1" data-sk="' + i + '" data-f="share" value="' + esc(s.share) + '"></div>' +
        '<div class="fld"><label>Crit rate %</label><input type="number" step="0.1" data-sk="' + i + '" data-f="cr" value="' + esc(s.cr) + '"></div>' +
        '<div class="fld"><label>Crit damage %</label><input type="number" step="1" data-sk="' + i + '" data-f="cd" value="' + esc(s.cd) + '"></div>' +
        '<button class="bc-x" type="button" data-delsk="' + i + '"' + (S.skills.length < 2 ? " disabled" : "") + '>&times;</button>' +
        "</div>";
    }
    $("bc-skills").innerHTML = h;
    updateShareNote();
  }

  function updateShareNote() {
    var n = $("bc-sharenote");
    if (!n) return;
    var sum = 0, i;
    for (i = 0; i < S.skills.length; i++) sum += num(S.skills[i].share, 0);
    var ok = Math.abs(sum - 100) < 0.01;
    n.textContent = ok ? "Shares sum to 100%."
      : "Shares sum to " + fx(sum, 1) + "% — they are normalised for you, but they read cleaner at 100.";
    n.className = ok ? "note" : "note bc-warn";
  }

  function renderEcon() {
    var tiers = [], i;
    for (i = 0; i < GPD_TIERS.length; i++) tiers.push({ v: GPD_TIERS[i], t: gold(GPD_TIERS[i]) + " gold" });
    var h = fldSel("econ.gpd", "Gold per 1% damage", tiers,
      "What one percent of damage is worth to you in gold — the same convention the accessory and astrogem tools use. Higher for a whale roster, lower for a fresh one.");
    h += fldNum("econ.baseline", "Baseline bracelet %", "0.1",
      "The bracelet you would use instead. Value is (expected final − baseline) × gold per 1%. Leave at 0 to price against no bracelet at all.");
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
    h += fldNum("adv.wpPct", "Weapon power %", "0.1", "6% from two earring weapon-power lines + 2.5% karma.");
    h += fldNum("adv.baseApPct", "Attack power %", "0.1", "11 damage gems at level 9 (1.0% each) + a 9/7 ability stone (1.5%). It cancels out of most ratios but shifts the balance between the square-root term and flat attack power.");
    h += fldNum("adv.flatAP", "Flat attack power", "1", "Ark-grid cores. Flat attack power is what stops a weapon-power line from being a pure square-root ratio.");
    h += fldNum("adv.accessoryMainStat", "Accessory main stat", "1", "Neck 17,857 + two earrings 13,889 + two rings 12,897, all at the top of their range with no flat-stat rolls.");
    h += fldNum("adv.rosterBonus", "Roster bonus", "1", "Main stat from roster level.");
    h += "</div>";

    h += '<div class="subh">Additional damage pool</div><div class="ig">';
    h += fldNum("adv.addWeapon", "Weapon quality %", "0.1", "A 100-quality weapon gives 30%.");
    h += fldNum("adv.addPet", "Pet %", "0.1", "Pet additional damage.");
    h += fldNum("adv.addNeck", "Necklace %", "0.1", "A high additional-damage necklace.");
    h += fldNum("adv.addAstrogem", "Astrogem grid %", "0.01", "60 grid levels × 0.080667% per level.");
    h += fldChk("adv.master", "Master node (+7% additional damage)", "Shizu's ruling: the Master node counts as +7% additional damage and nothing else.");
    h += "</div>";

    h += '<div class="subh">Where your damage lands</div><div class="ig">';
    h += fldNum("adv.backShare", "Back attack %", "1", "Share of your damage that hits from behind. Left at 0 by default — set it and the back-attack lines start scoring.");
    h += fldNum("adv.frontShare", "Front attack %", "1", "Share of your damage that hits the front.");
    h += fldNum("adv.nonDirShare", "Non-directional %", "1", "Share from skills with no positional requirement (Awakening excluded).");
    h += fldNum("adv.staggerShare", "Stagger windows %", "1", "Share of your damage dealt while the boss is staggered.");
    h += fldNum("adv.demonShare", "Demon bosses %", "1", "Share of your damage dealt to Demon / Archdemon bosses.");
    h += fldNum("adv.demonBase", "Demon damage held %", "0.1", "Demon damage you already carry from cards and pets — it dilutes a demon line.");
    h += fldNum("adv.shieldUptime", "Shield uptime %", "1", "How much of the fight your party sits under a shield, for the shielded-target line.");
    h += fldNum("adv.enemyDR", "Enemy damage reduction %", "1", "The boss's damage reduction before any shred. It sets how much a defense shred is worth: gain = (D+K)/(D(1−A)+K).");
    h += fldNum("adv.cdWeight", "Burst weight", "0.05", "Family 15 trades +2% cooldown for damage. 1 scores pure burst (no penalty), 0 scores pure sustained; 0.5 is the mean of the two.");
    h += fldNum("adv.allyCount", "Ally DPS in party", "1", "How many other damage dealers share your party debuffs. Each is assumed to deal what you deal before the line.");
    h += "</div>";

    h += '<div class="subh">Conditional weapon-power lines</div><div class="ig">';
    h += fldNum("adv.wpStacks20", "Family 20 stacks held", "0.1", "The on-hit stacking weapon-power line caps at 6 stacks. 4.8 is roughly 80% average fill.");
    h += fldNum("adv.wpUptime21", "Family 21 uptime %", "1", "The HP≥50% on-hit rider lasts 5s and refreshes on every hit, so it is up nearly all the time.");
    h += fldNum("adv.wpStacks22", "Family 22 stacks held", "0.1", "One stack every 30s held for 120s settles at four.");
    h += "</div>";

    h += '<div class="subh">Fixed lines (come with the drop, never rerolled)</div>';
    h += '<div class="bc-sub">Optional. They score their own damage and they lock their family and category slot out of every future roll, so they change what an empty bracelet is worth.</div>';
    h += '<div id="bc-fixedrows"></div>';
    h += '<div class="barrow"><button class="mbtn" id="bc-addfixed" type="button"' + (S.fixedRows.length >= 2 ? " disabled" : "") + '>+ Add fixed line</button></div>';

    box.innerHTML = h;
    renderFixedRows();
  }

  function rowMarkup(idx, row, prefix, label) {
    var grade = S.grade, profile = buildProfile();
    var isBasic = row.fam.indexOf("basic:") === 0;
    var isSpecial = row.fam.indexOf("sp:") === 0;
    var famKey = isBasic ? row.fam.slice(6) : "mainStat";
    var msValue = (row.value === null || row.value === undefined || row.value === "") ? defaultBasicValue(grade, famKey) : num(row.value, defaultBasicValue(grade, famKey));
    var groups = familyOptions(grade, profile, row.tier || "mid", msValue);
    var rg = msRange(grade, famKey);

    var h = '<div class="bc-slot">' +
      '<div class="sn">' + esc(label) + "</div>" +
      '<div class="fld">' + pickerHtml(prefix + "-fam-" + idx, groups, row.fam) + "</div>";
    if (isSpecial) {
      h += '<div class="fld"><select id="' + prefix + "-tier-" + idx + '">' +
        opts([{ v: "low", t: "Low (Heroic)" }, { v: "mid", t: "Mid (Epic)" }, { v: "high", t: "High (Legendary)" }], row.tier || "mid") +
        "</select></div>";
    } else {
      h += "<div></div>";
    }
    if (isBasic) {
      h += '<div class="fld"><input type="number" id="' + prefix + "-val-" + idx + '" step="1" min="' + rg[0] + '" max="' + rg[1] + '" value="' + msValue + '"></div>';
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
      '<div class="bc-qlab"><span>p10 ' + fx(pct(q.p10), 2) + "%</span><span>p25 " + fx(pct(q.p25), 2) +
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
      h += '<div class="bc-card"><div class="k">Unrolled, ' + S.slots + ' slots</div><div class="v">' + gold(fval) +
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

    h += '<div class="bc-tabwrap"><table><thead><tr><th>Lock</th><th class="num">Expected final</th><th class="num">vs best</th></tr></thead><tbody>';
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
    h += "<div><div class=\"subh\">Chance this improves</div><div style=\"font-size:22px;font-weight:800\">" +
      fx(res.pImprove * 100, 1) + "%</div><div class=\"note\">Probability the bracelet ends above its current " +
      fx(pct(res.currentScore), 2) + "%, over all " + S.rollsLeft + " remaining rolls played well.</div></div>";
    h += "<div><div class=\"subh\">Where it can land</div>" + quantileStrip(res.finalScore.quantiles, res.currentScore) +
      '<div class="note">Box = the middle half, whisker = p10 to p90, orange = today.</div></div>';
    h += "</div></div>";
    return h;
  }

  function breakdownHtml(profile, lines, res) {
    var all = fixedLines().concat(lines);
    if (!all.length) return "";
    var h = '<div class="panel"><h2 style="margin-top:0">Line by line</h2><div class="bc-tabwrap"><table>' +
      '<thead><tr><th>Slot</th><th>Line</th><th class="num">Damage</th><th class="num">Share</th></tr></thead><tbody>';
    var total = 0, i, ds = [];
    for (i = 0; i < all.length; i++) { var d = B.lineDamage(all[i], S.grade, profile); ds.push(d); total += d; }
    var nFixed = fixedLines().length;
    for (i = 0; i < all.length; i++) {
      var lbl = i < nFixed ? "Fixed " + (i + 1) : "Slot " + (i - nFixed + 1);
      h += "<tr><td>" + lbl + "</td><td>" + esc(lineLabel(all[i], S.grade)) + '</td>' +
        '<td class="num"><span data-gloss="' + esc(explainLine(all[i], S.grade, profile)) + '">' + signPct(pct(ds[i])) + "</span></td>" +
        '<td class="num">' + (total > 1e-9 ? fx(ds[i] / total * 100, 0) + "%" : "—") + "</td></tr>";
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
    updateShareNote();
    redrawSlots();
  }

  var SHAPE_FIELDS = { grade: 1, slots: 1, useOverride: 1 };

  function onFieldChange(el) {
    var path = el.getAttribute && el.getAttribute("data-k"), t = el.getAttribute("data-t");
    if (!path) return false;
    if (t === "chk") setPath(S, path, !!el.checked);
    else if (t === "num") setPath(S, path, num(el.value, getPath(S, path)));
    else setPath(S, path, isNaN(Number(el.value)) ? el.value : Number(el.value));
    if (path === "rollsLeft") S.rollsTotal = Math.max(S.rollsTotal, num(el.value, 7));
    if (path === "grade" || path === "slots") { S.locks = null; S.rolled = null; lastVerdict = null; }
    save();
    if (SHAPE_FIELDS[path]) {
      fitRows();
      keepFocus(function () { renderBasics(); renderSlots(); renderFixedRows(); });
    }
    redrawLive();
    schedule();
    return true;
  }

  function bindPanel() {
    var panel = $("bc-inputs");
    function fieldEvent(e) {
      var el = e.target;
      if (el.getAttribute && el.getAttribute("data-sk") !== null) {
        var i = Number(el.getAttribute("data-sk")), f = el.getAttribute("data-f");
        if (!S.skills[i]) return;
        S.skills[i][f] = f === "name" ? el.value : num(el.value, S.skills[i][f]);
        save(); redrawLive(); schedule();
        return;
      }
      onFieldChange(el);
    }
    // Selects fire input then change; both paths are idempotent.
    panel.addEventListener("input", fieldEvent);
    panel.addEventListener("change", fieldEvent);

    panel.addEventListener("click", function (e) {
      var t = e.target, d;
      if (t.id === "bc-addskill") { S.skills.push({ name: "", share: 0, cr: 90, cd: 280 }); save(); renderSkills(); redrawSlots(); schedule(); }
      else if (t.getAttribute && (d = t.getAttribute("data-delsk")) !== null && d !== "") {
        if (S.skills.length > 1) { S.skills.splice(Number(d), 1); save(); renderSkills(); redrawSlots(); schedule(); }
      } else if (t.id === "bc-advtoggle") { S.advOpen = !S.advOpen; save(); renderAdvanced(); }
      else if (t.id === "bc-addfixed") {
        if (S.fixedRows.length < 2) { S.fixedRows.push(blankRow()); save(); renderAdvanced(); schedule(); }
      } else if (t.id === "bc-reset") {
        if (window.confirm("Reset every input, the bracelet and this session's rolls?")) {
          try { localStorage.removeItem(LS_KEY); } catch (er) { /* ignore */ }
          S = defaults(); lastVerdict = null; cache = {}; cacheOrder = [];
          freshSolve = null; lastSolve = null; freshSolveKey = null; lastSolveKey = null; workerCtxKey = null;
          fitRows(); renderBasics(); renderSkills(); renderEcon(); renderAdvanced(); renderSlots();
          recompute();
        }
      }
    });

    $("bc-toggle").addEventListener("click", function () {
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
      if (row.fam.indexOf("basic:") === 0 && (row.value === null || row.value === undefined || row.value === "")) {
        row.value = defaultBasicValue(S.grade, row.fam.slice(6));
      }
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
      var id = e.target.id || "";
      if (/^bc-[rfn]-val-\d+$/.test(id)) { handleRowEvent(e.target); save(); schedule(); }
    });
    root.addEventListener("click", function (e) {
      var t = e.target, lk;
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
    var lines = grantedLines(), out = [], i;
    for (i = 0; i < S.slots; i++) {
      out.push(locks[i] ? lines[i] : rowToLine(S.rolled[i], S.grade));
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
    save(); renderBasics(); renderSlots(); recompute();   // rollsLeft moved: redraw its field too
  }

  function undo() {
    var e = S.history.pop();
    if (!e) return;
    S.rows = e.prevRows;
    S.rollsLeft = e.rollsBefore;
    S.locks = null; S.rolled = null; lastVerdict = null;
    fitRows(); save(); renderBasics(); renderSlots(); recompute();
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
    renderBasics();
    renderSkills();
    renderEcon();
    renderAdvanced();
    renderSlots();
    bindPanel();
    bindBody();
    renderResults(buildProfile(), null);
    recompute();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
