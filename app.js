/**
 * app.js — the Calculator tab.
 *
 * Layout (astrogem-grader house style: the control deck, then results):
 *   DECK       the character + bracelet controls. NOT built here any more —
 *              profile.js owns them, and this file mounts them (see below).
 *   PROFILE    the imported character's header: ★, class icon, name, cache pill
 *              and chips. Hidden until a character is imported.
 *   BRACELET   one row per granted slot — family picker (grouped and priced),
 *              tier, and a value box for the basic-stat families. All rows empty
 *              means an unrolled bracelet, which is the default.
 *   RESULTS    headline cards, the roll advisor (best locks, P(improve), the
 *              spread of final scores), the cut flow, and a per-line breakdown.
 *
 * THE STATE IS NOT HERE (since 2026-08-11). window.Profile owns it, persists it
 * and renders the control deck; this file holds the LIVE state object it returns,
 * mounts the deck into the Calculator pane, and re-solves whenever Profile says
 * something moved. The Tier List mounts the same deck, which is the whole point of
 * the split: one slider, every tab.
 *
 * THE MATH IS NOT HERE either. Every number comes from window.Bracelet
 * (model/bracelet.js), which this file only ever reads:
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
 */
(function () {
  "use strict";

  var B = window.Bracelet, DATA = window.BraceletData, P = window.Profile;
  if (!B || !DATA || !P) return;                 // model or spine failed to load; leave the shell alone

  var S = P.get();                               // the LIVE state object — never re-assigned
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

  // ------------------------------------------------------------------
  // the shared state, in this file's terms
  //
  // Everything below reads S (window.Profile's live object) and the handful of
  // derived numbers Profile exposes. Nothing here writes a control's value: the
  // deck does that and tells us through onChange. What this file DOES own is the
  // bracelet itself — rows, fixed rows, locks, the rolled set and the history —
  // because they are the Calculator's subject, not the character's.
  // ------------------------------------------------------------------

  function blankRow() { return P.blankRow(); }
  function traitValues() { return P.traitValues(); }
  function traitBand() { return P.traitBand(); }

  // ---- character settings vs default settings ----
  //
  // Two ways to score the same bracelet: the deck (this character, as imported
  // and then edited) and the CANONICAL DEFAULT profile, the one the leaderboard
  // ranks everyone on. The choice, the persistence and the control all live in
  // profile.js now — the Tier List scores on the same toggle, and a mode that
  // moved only this tab was a setting that lied about its own reach.
  //
  // Everything here reads P.scoringProfile(), which honours it.
  function hasCharacter() { return !!(S.char && S.char.name); }
  function onDefaults() { return P.onDefaults(); }
  function buildProfile() { return P.scoringProfile(); }
  function famGrades(grade) { return P.famGrades(grade); }
  function letterOf(val, grade) { return P.letterOf(val, grade); }
  var TRAIT_KEYS = P.TRAIT_KEYS, TRAIT_LABELS = P.TRAIT_LABELS;
  // The tooltip on each of the bracelet's two fixed combat-trait rows. It stays
  // here because the rows do: they are bracelet lines, not character settings.
  var TRAIT_GLOSS = {
    crit: "The Crit trait line your bracelet came with, in trait points. It converts exactly — 25 percentage points of crit rate per 699 trait points — and then runs through your skills' own crit numbers, so it is worth nothing to a build already at 100% crit.",
    spec: "The Specialization trait line your bracelet came with, in trait points. It scores at the Spec weight you set in the Traits block: value × weight ÷ 100.",
    swift: "The Swiftness trait line your bracelet came with, in trait points. It scores at the Swiftness weight you set in the Traits block: value × weight ÷ 100."
  };
  var GRADE_COLOR = P.GRADE_COLOR;
  var JUNK = P.JUNK;                             // the granted picker's one zero-damage option
  function save() { P.save(); }


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

  // The letters, their palette and the JUNK sentinel live in profile.js, so the
  // Tier List and this picker can never disagree about a family's grade.
  // Our low / mid / high are the game's Rare / Epic / Legendary rarities.
  var TIER_META = {
    low: { label: "Rare", color: "#5aa9e6" },
    mid: { label: "Epic", color: "#c78cff" },
    high: { label: "Legendary", color: "#ffb86b" }
  };

  // ---- "Junk Line": every F family under one option ----
  //
  // Fifteen of the families a granted slot can roll score exactly nothing —
  // Vitality, all six combat traits and thirteen of the specials — and the
  // model already treats them as one interchangeable atom. Listing them
  // separately was fifteen rows of noise, so the granted picker shows a single
  // "Junk Line" entry (Shizu, 2026-08-11). The FIXED-line editor keeps the full
  // list: see the note on junkFamPool.

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
      worker = new Worker("solver-worker.js?v=5");
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
      // The character banner reads its three figures off lastSolve, and it was
      // painted before the solve existed — so without this it kept showing the
      // placeholder dashes for ever.
      renderCharHeader();
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
  //
  // The deck's own builders (fldNum / slider / segmented / toggle and the chip
  // machinery) went to profile.js with the controls they draw. What stays here is
  // the bracelet's markup, which the deck never touches.
  // ------------------------------------------------------------------

  function styleBlock() {
    return "<style>" +
      // Scoped to the Calculator pane. The DECK's stylesheet is not here any
      // more: profile.js injects it, class-scoped, because the deck moves
      // between tabs and a pane-id prefix would strip its own styling.
      // ---- the imported character's header ----
      "#tab-calculator .bc-prof{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 4px}" +
      // An <img> cannot inherit the SVG's fill=currentColor, so flatten the
      // glyph to black and invert it to the theme's off-white.
      "#tab-calculator .bc-prof .bc-classicon{width:46px;height:46px;object-fit:contain;flex:0 0 auto;filter:brightness(0) invert(.82);opacity:.92}" +
      "#tab-calculator .bc-prof .bc-id{display:flex;flex-direction:column;gap:3px;min-width:0}" +
      "#tab-calculator .bc-prof .bc-name{font-size:30px;font-weight:800;letter-spacing:-.015em;line-height:1.05;color:var(--text)}" +
      "#tab-calculator .bc-prof .bc-name a{color:inherit;text-decoration:none;border-bottom:1px dotted transparent;transition:border-color .12s,color .12s}" +
      "#tab-calculator .bc-prof .bc-name a:hover{color:var(--accent);border-bottom-color:var(--accent)}" +
      "#tab-calculator .bc-prof .bc-meta{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12.5px;color:var(--dim)}" +
      "#tab-calculator .bc-prof .bc-meta .bc-chip{display:inline-flex;align-items:baseline;gap:5px;background:var(--panel);border:1px solid var(--border);border-radius:99px;padding:2px 10px;font-weight:600}" +
      "#tab-calculator .bc-prof .bc-meta .bc-chip b{color:var(--text);font-weight:700;font-variant-numeric:tabular-nums}" +
      "#tab-calculator .bc-star{background:none;border:none;cursor:pointer;font-size:24px;line-height:1;padding:0 2px;color:var(--none);font-family:inherit;vertical-align:middle;transition:color .12s,transform .08s}" +
      "#tab-calculator .bc-star:hover{transform:scale(1.12)}" +
      "#tab-calculator .bc-star.on{color:var(--high)}" +
      "#tab-calculator .bc-cache{display:inline-block;margin-left:10px;font-size:10px;font-weight:700;letter-spacing:.02em;color:var(--dim);background:var(--panel2);border:1px solid var(--border);border-radius:99px;padding:2px 9px;vertical-align:middle}" +
      "#tab-calculator .bc-cache.fresh{color:var(--good)}" +
      // The banner reloads its own character on click — everything the panel does
      // for a saved chip, for the character already on screen.
      "#tab-calculator .bc-profwrap{cursor:pointer}" +
      "#tab-calculator .bc-profwrap:hover .bc-name a{color:var(--accent)}" +
      // ---- the three headline stats, astrogem's .gr-sum ----
      "#tab-calculator .bc-sum{display:flex;gap:20px;flex-wrap:wrap;align-items:center;margin-top:10px}" +
      "#tab-calculator .bc-sum .stat{display:flex;flex-direction:column}" +
      "#tab-calculator .bc-sum .stat .k{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}" +
      "#tab-calculator .bc-sum .stat .v{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}" +
      "#tab-calculator .bc-sum .stat .v.acc{color:var(--accent)}" +
      "#tab-calculator .bc-sum .stat .v.gold{color:var(--high)}" +
      "#tab-calculator .bc-rankbadge{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:800;" +
        "font-size:18px;line-height:1.4;color:#fff}" +
      "#tab-calculator .bc-fieldrank{margin-top:6px;font-size:12px;opacity:.75;min-height:15px}" +
      // The character / default settings toggle is styled by profile.js, with the
      // rest of the control row it sits in: the Tier List draws the same row, and
      // a "#tab-calculator …" prefix here would have left that copy unstyled.
      // ---- the bracelet panel ----
      "#tab-calculator .bc-hdrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}" +
      // An illegal-but-scored state (three combat traits, or fewer than two):
      // the house note, flagged with the bad colour. A warning, not a block.
      "#tab-calculator .note.bc-illegal{color:var(--bad);border-left:2px solid var(--bad);padding-left:9px;margin-top:8px}" +
      // ---- the bracelet's two fixed combat traits ---------------------
      // .bc-sl itself is the deck's row shape (profile.js); these are the
      // overrides that make a trait row typed instead of slid.
      "#tab-calculator .bc-sl.bc-trrow{grid-template-columns:74px 96px 72px;justify-content:start}" +
      "#tab-calculator .bc-trrow input[type=number]{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 7px;font:inherit;font-size:13px;width:100%}" +
      "#tab-calculator .bc-trrow input[type=number]:focus{outline:1px solid var(--accent)}" +
      "#tab-calculator .bc-trrow input:disabled{opacity:.45;cursor:not-allowed}" +
      "#tab-calculator .bc-tract{padding:4px 8px;font-size:11px;width:100%}" +
      "@media(max-width:640px){#tab-calculator .bc-sl.bc-trrow{grid-template-columns:62px 84px 66px;gap:6px}}" +
      // ---- headline cards ----
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
      "</style>";
  }

  /**
   * The hosts, top to bottom, in the order the astrogem grader stacks them:
   *
   *   #bc-import          the character panel — mode pills, the pull row, the
   *                       saved-character grid (bible-import.js fills it)
   *   #bc-refresh-banner  the queue: a thin bar over a cached bracelet, or the
   *                       queued panel. Its own host so the calculator under it
   *                       is never blanked
   *   #bc-loadouts        the Raid / Chaos / Est. Raid pills, where astrogem has
   *                       its preset pills
   *   #bc-charhdr         the character banner: ★, class icon, name, cache pill,
   *                       chips, the three headline stats, the field rank and the
   *                       character/default settings toggle
   *   #bc-deckhost        the control deck (profile.js builds and owns it)
   *
   * The banner sits ABOVE the deck on purpose: it is who the deck is describing.
   * Every host is empty until something fills it.
   */
  function hostsMarkup() {
    return '<div id="bc-import"></div><div id="bc-refresh-banner"></div>' +
      '<div id="bc-loadouts"></div><div id="bc-charhdr"></div><div id="bc-deckhost"></div>';
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
    return styleBlock() + hostsMarkup() + braceletMarkup() +
      '<section id="bc-results"></section>';
  }

  // ------------------------------------------------------------------
  // what is left of "input rendering"
  //
  // The control deck's renderers (top row, gear, kit, fight, trait weights,
  // skills, economy, the Advanced fold) all moved to profile.js on 2026-08-11.
  // What stays is the bracelet: its read-out line, its two fixed combat traits,
  // and its granted / fixed rows.
  // ------------------------------------------------------------------

  // The live read-out under the bracelet header. Split out so a slider drag can
  // refresh it without rebuilding the fields under the cursor.
  function updateBasicsNote() {
    var note = $("bc-slotnote");
    if (!note) return;
    var base = P.baseStats(), p = buildProfile();
    // Defaults mode: the deck's own numbers are not what anything below is scored
    // on, so printing them here would be a lie of arrangement.
    if (onDefaults()) {
      note.textContent = "Scoring on the canonical default profile — the same one the leaderboard ranks everyone on. " +
        "The Character deck stays editable; nothing below reads it until you switch back. " +
        "Leave every granted slot empty for an unrolled bracelet.";
      return;
    }
    var msg = S.useOverride
      ? "Main stat " + nf(base.mainStatRaw) + " raw · weapon power " + nf(base.weaponPowerRaw) + " raw"
      : "Item level " + fx(P.ilvl(), 2) + " · main stat " + nf(base.mainStatRaw) + " raw · weapon power " + nf(base.weaponPowerRaw) + " raw";
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
    var n = P.traitOnCount();
    if (n > 2) {
      h += '<div class="note bc-illegal">Three combat traits are active. A real bracelet only ever carries two, ' +
        "so this bracelet cannot exist in game &mdash; every score below still counts all three exactly as entered.</div>";
    } else if (n < 2) {
      h += '<div class="note bc-illegal">' + (n === 1 ? "Only one combat trait is active" : "No combat trait is active") +
        ". Every bracelet carries two, so this one is short a line &mdash; the score counts only what is on.</div>";
    }
    box.innerHTML = h;
  }

  /**
   * Redraw everything on screen that is NOT a deck control. Called after any
   * change Profile announces, and after this file rewrites the rows itself.
   */
  function renderBracelet() {
    renderTraits();
    renderSlots();
    renderFixedRows();
    updateBasicsNote();
    renderCharHeader();          // its grade and rolls-left chips read the same state
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
    paintCharStats();          // the banner's headline stats read the same solve
  }

  /**
   * Refresh the two LIVE figures in the character banner in place. In place,
   * because a full renderCharHeader would rebuild the rank badge and the field
   * rank too, and those are async — the banner would blink on every solve.
   */
  function paintCharStats() {
    if (!lastSolve) return;
    var p = $("bc-sum-pct");
    if (p) p.textContent = fx(pct(lastSolve.currentScore), 2) + "%";
    var w = $("bc-sum-worth");
    if (w) {
      var val = valueGold(lastSolve.expectedFinal);
      w.textContent = (val >= 0 ? "" : "−") + gold(Math.abs(val));
    }
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
  /**
   * The cheap live parts, refreshed on every edit: the read-out line under the
   * bracelet header and the priced pickers. The deck redraws itself.
   */
  function redrawLive() {
    updateBasicsNote();
    redrawSlots();
  }

  /** A segmented/toggle press solves at once — no debounce to sit through. */
  function solveNow() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    recompute();
  }

  /**
   * Profile said something moved. The deck has already redrawn itself and
   * persisted; this is the Calculator catching up.
   *
   *   d.shape      grade / slots / the override moved, or a whole state was set:
   *                the bracelet's own rows and trait band change with it
   *   d.reset      the state went back to defaults, so every cached solve is for
   *                a bracelet that no longer exists
   *   d.immediate  a press rather than a drag — solve now instead of debouncing
   */
  function onProfileChange(d) {
    d = d || {};
    if (d.reset) {
      lastVerdict = null; cache = {}; cacheOrder = [];
      freshSolve = null; lastSolve = null; freshSolveKey = null; lastSolveKey = null; workerCtxKey = null;
    }
    if (d.shape || d.reset) {
      lastVerdict = null;
      keepFocus(renderBracelet);
    } else {
      redrawLive();
      // Two deck fields also sit in the character header's chips.
      if (d.path === "rollsLeft" || d.path === "grade") renderCharHeader();
    }
    // The scoring toggle moved: every number on screen is on a different profile
    // now, so the banner's figures and the priced pickers both have to follow.
    if (d.mode) { renderCharHeader(); redrawLive(); }
    if (d.immediate) solveNow(); else schedule();
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
    // The document, not the pane: the Advanced fold's fixed-line rows are drawn
    // by this file but live inside the deck, and the deck can be re-parented
    // into another tab at any moment. Every branch below is gated on an id or a
    // data- attribute only this file emits, so a wider net costs nothing.
    var root = document;
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
        S.rows = []; P.fit(); S.locks = null; S.rolled = null; lastVerdict = null;
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
    save(); P.render(); renderSlots(); renderCharHeader(); recompute();   // rollsLeft moved: redraw its field too
  }

  function undo() {
    var e = S.history.pop();
    if (!e) return;
    S.rows = e.prevRows;
    S.rollsLeft = e.rollsBefore;
    S.locks = null; S.rolled = null; lastVerdict = null;
    P.fit(); save(); P.render(); renderSlots(); renderCharHeader(); recompute();
  }

  // ------------------------------------------------------------------
  // the imported character's header
  //
  // Astrogem's loadout header, with our chips. It appears the moment a character
  // is imported and stays hidden otherwise — an empty header is worse than none.
  // ------------------------------------------------------------------

  /** "2d ago" for a timestamp, the same ladder astrogem uses. */
  function ageLabel(ts) {
    if (!ts) return "";
    var mins = Math.floor((Date.now() - Number(ts)) / 60000);
    if (!isFinite(mins) || mins < 0) return "";
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.floor(hrs / 24) + "d ago";
  }

  /** Cached / fresh / imported, in one pill beside the name. */
  function cacheNoteHtml(c) {
    if (!c) return "";
    var age = ageLabel(c.pulledAt), txt;
    if (c.source === "import" || c.cached == null) txt = "Imported" + (age ? " " + esc(age) : "");
    else if (c.cached) txt = "Cached &middot; pulled " + esc(age || "recently");
    else txt = "Freshly pulled";
    return ' <span class="bc-cache' + (c.cached === false ? " fresh" : "") + '">' + txt + "</span>";
  }

  /** The character's page on lostark.bible. EU is CE there, as their URLs have it. */
  function bibleUrl(region, name) {
    var r = String(region || "").toUpperCase();
    if (r === "EU" || r === "CE") return "https://lostark.bible/character/CE/" + encodeURIComponent(name || "");
    return "https://lostark.bible/character/" + encodeURIComponent(r || "NA") + "/" + encodeURIComponent(name || "");
  }

  /**
   * The class glyph, from assets/class-icons/<Class>.svg — the same 29 files the
   * astrogem calculator ships. The list is spelled out because a class we have no
   * file for must get NO icon rather than a wrong one or a broken image: we know
   * exactly which 29 exist, so there is no reason to ask the server and find out.
   * Matching ignores case and spacing, so "Guardian Knight" finds Guardianknight.
   * onerror still hides a file that fails to load for any other reason.
   */
  var CLASS_ICONS = ("Aeromancer Arcanist Artillerist Artist Bard Berserker Breaker Deadeye Deathblade " +
    "Destroyer Glaivier Guardianknight Gunlancer Gunslinger Machinist Paladin Reaper Scrapper " +
    "Shadowhunter Sharpshooter Slayer Sorceress Souleater Soulfist Striker Summoner Valkyrie " +
    "Wardancer Wildsoul").split(" ");
  var CLASS_ICON_BY_KEY = (function () {
    var m = {}, i;
    for (i = 0; i < CLASS_ICONS.length; i++) m[CLASS_ICONS[i].toLowerCase()] = CLASS_ICONS[i];
    return m;
  })();
  function classIconFile(className) {
    if (!className) return null;
    return CLASS_ICON_BY_KEY[String(className).replace(/[^A-Za-z]/g, "").toLowerCase()] || null;
  }
  function classIconHtml(className) {
    var file = classIconFile(className);
    if (!file) return "";
    return '<img class="bc-classicon" src="assets/class-icons/' + encodeURIComponent(file) +
      '.svg" alt="" aria-hidden="true" loading="lazy" onerror="this.style.display=\'none\'">';
  }

  function paintStar(btn, region, name) {
    var F = window.Favorites, on = F ? F.has(region, name) : false;
    btn.className = "bc-star" + (on ? " on" : "");
    btn.innerHTML = on ? "&#9733;" : "&#9734;";              // ★ / ☆
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? "Remove from saved characters" : "Save this character";
  }

  /**
   * The character banner — astrogem's loadout header, with our subject.
   *
   *   ★ · class icon · 30px name linking to lostark.bible · cache pill
   *   chips: region · class · ilvl · bracelet grade · rolls left
   *   three headline stats: BRACELET % · RANK · WORTH
   *   the field rank ("Top 11% of Reapers (#3 of 24) · #9 of 30 tracked")
   *   the character / default settings toggle
   *
   * The whole block is clickable and reloads its own character, so the banner and
   * a saved chip do exactly the same thing. The ★, the name link and the toggle
   * stop that click, because each of them means something else.
   *
   * BRACELET % and WORTH come from the live solve, so they follow the settings
   * toggle. RANK and the field line come from the character's DEFAULT-profile
   * score against the board — the board's number against the board's numbers, or
   * the comparison would be ranking gear.
   */
  function renderCharHeader() {
    var box = $("bc-charhdr");
    if (!box) return;
    var c = S.char;
    if (!c || !c.name) { box.innerHTML = ""; box.style.display = "none"; return; }
    box.style.display = "";

    var chips = "";
    if (c.region) chips += '<span class="bc-chip">' + esc(c.region) + "</span>";
    if (c["class"]) chips += '<span class="bc-chip">' + esc(c["class"]) + "</span>";
    if (c.itemLevel != null) chips += '<span class="bc-chip">ilvl <b>' + esc(Number(c.itemLevel).toLocaleString("en-US")) + "</b></span>";
    chips += '<span class="bc-chip">' + (S.grade === "relic" ? "Relic" : "Ancient") + "</span>";
    chips += '<span class="bc-chip">rolls left <b>' + S.rollsLeft + "</b></span>";

    // The live figures. Before the first solve lands they read "—" rather than a
    // stale number from the bracelet that was on screen a moment ago.
    var curTxt = "—", worthTxt = "—";
    if (lastSolve) {
      curTxt = fx(pct(lastSolve.currentScore), 2) + "%";
      var val = valueGold(lastSolve.expectedFinal);
      worthTxt = (val >= 0 ? "" : "−") + gold(Math.abs(val));
    }

    box.innerHTML = '<div class="panel">' +
      '<div class="bc-prof bc-profwrap" id="bc-profwrap" title="Load ' + esc(c.name) + ' again — bracelet and character settings">' +
      '<button type="button" class="bc-star" id="bc-fav-star"></button>' +
      classIconHtml(c["class"]) +
      '<div class="bc-id">' +
      '<div class="bc-name"><a href="' + bibleUrl(c.region, c.name) + '" target="_blank" rel="noopener">' +
      esc(c.name) + "</a>" + cacheNoteHtml(c) + "</div>" +
      '<div class="bc-meta">' + chips + "</div>" +
      "</div></div>" +
      '<div class="bc-sum">' +
      '<div class="stat"><span class="k">Bracelet %</span><span class="v acc" id="bc-sum-pct">' + curTxt + "</span></div>" +
      '<div class="stat"><span class="k" data-gloss="A letter for the whole bracelet on the same ladder the model grades families with: its share of the best bracelet on the board. S is 90% of the best or better, A 70%, B 50%, C 30%, D 10%. Scored on the canonical default profile, like the board itself.">Rank</span>' +
        '<span class="v" id="bc-sum-rank">—</span></div>' +
      '<div class="stat"><span class="k">Worth</span><span class="v gold" id="bc-sum-worth">' + worthTxt + "</span></div>" +
      "</div>" +
      '<div class="bc-fieldrank" id="bc-fieldrank"></div>' +
      '<div id="bc-pmodehost"></div>' +
      "</div>";

    var star = $("bc-fav-star");
    if (star) {
      if (!window.Favorites) { star.style.display = "none"; }
      else {
        paintStar(star, c.region, c.name);
        star.onclick = function (e) {                          // onclick, not addEventListener:
          if (e && e.stopPropagation) e.stopPropagation();     // this node is rebuilt constantly
          window.Favorites.toggle(c.region, c.name);
          paintStar(star, c.region, c.name);
        };
      }
    }

    // Clicking the banner loads this character again — the same path a saved chip
    // takes, so the bracelet AND the character settings both come back.
    var wrap = $("bc-profwrap");
    if (wrap) {
      wrap.onclick = function (e) {
        var t = e && e.target;
        if (t && t.closest && (t.closest("a") || t.closest("button"))) return;
        var imp = window.BraceletImport;
        if (imp && imp.loadCharacter) imp.loadCharacter(c.region, c.name);
      };
    }

    // ROW 3: the scoring toggle, the two resets and the left-column disclaimer.
    // profile.js builds and repaints it — the Tier List shows the same row from
    // the same source, so the wording cannot drift apart.
    P.mountModeControl($("bc-pmodehost"));

    fillFieldRank(c);
  }

  /**
   * The rank badge and the field-rank line, both off the baked board. Async: the
   * board is one fetch, session-cached. A late answer is dropped if a different
   * character has taken the banner in the meantime.
   */
  function fillFieldRank(c) {
    var imp = window.BraceletImport;
    if (!imp || !imp.fieldRank || c.defaultPct == null) return;
    imp.fieldRank(c, function (r) {
      var cur = S.char;
      if (!cur || cur.name !== c.name || cur.region !== c.region) return;   // superseded
      var el = $("bc-fieldrank");
      if (el) el.textContent = r.text;
      var rk = $("bc-sum-rank");
      if (rk) {
        rk.innerHTML = '<span class="bc-rankbadge" style="background:' +
          (GRADE_COLOR[r.letter] || GRADE_COLOR.F) + '">' + esc(r.letter) + "</span>";
        rk.title = "Worth " + fx(c.defaultPct, 2) + "% on default settings — " +
          Math.round(r.share * 100) + "% of the best bracelet on the board.";
      }
    });
  }

  // ------------------------------------------------------------------
  // init
  // ------------------------------------------------------------------

  function init() {
    var pane = $("tab-calculator");
    if (!pane || pane.getAttribute("data-init")) return;
    pane.setAttribute("data-init", "1");
    pane.innerHTML = tabMarkup();
    P.mount($("bc-deckhost"));            // the deck: built, bound and persisted by profile.js
    P.onAdvancedRender(function () { renderFixedRows(); });
    renderBracelet();
    bindBody();
    P.onChange(onProfileChange);
    renderResults(buildProfile(), null);
    recompute();
  }

  // The deck is a single element that MOVES between tabs (see profile.js): claim
  // it back whenever the Calculator is the tab on screen.
  document.addEventListener("tabselected", function (e) {
    if (!e || !e.detail || e.detail.tab !== "calculator") return;
    var host = $("bc-deckhost");
    if (host) P.mount(host);
  });

  /**
   * The one hook bible-import.js uses. It hands over a patch already in this
   * file's own shape — grade, slots, the two combat traits, the granted rows and
   * any fixed rows — and everything after that is the ordinary redraw an edit
   * would trigger. Keys the patch leaves out keep their current value, so an
   * import never disturbs the character or economy settings.
   *
   * `patch.character` is optional: {name, region, class, itemLevel, source,
   * pulledAt, cached}. When it is there the profile header appears, and anything
   * the page told us about the character's GEAR is applied as a marked, editable
   * suggestion — never silently.
   */
  window.BraceletApp = {
    applyImport: function (patch) {
      if (!patch) return false;
      var keys = ["grade", "slots", "rollsLeft", "traits", "traitOrder", "rows", "fixedRows"], i;
      var next = {};
      for (i = 0; i < keys.length; i++) {
        if (patch[keys[i]] !== undefined) next[keys[i]] = patch[keys[i]];
      }
      next.rolled = null;                          // a new bracelet voids the cut in progress
      // The padlocks the character is actually wearing, if the import found any.
      // lostark.bible's `fixed` flag is that padlock, not a drop-fixed line.
      if (patch.lockedIdx && patch.lockedIdx.length && next.rows) {
        var lk = [], li;
        for (li = 0; li < next.rows.length; li++) lk.push(patch.lockedIdx.indexOf(li) >= 0);
        next.locks = lk;
      } else {
        next.locks = null;
      }
      lastVerdict = null;
      // The banner and the cards read lastSolve. It belongs to the bracelet being
      // replaced, so drop it: "—" for a moment beats the previous character's score.
      lastSolve = null; lastSolveKey = null; freshSolve = null; freshSolveKey = null;
      if (patch.character) next.char = patch.character;
      P.set(next);                                 // merges, persists, re-renders the deck, notifies
      if (patch.character) importProfileValues(patch.character);
      renderCharHeader();
      return true;
    },
    /** Show a character's header without touching the bracelet. */
    setCharacter: function (c) { P.setCharacter(c); renderCharHeader(); },

    /**
     * The two economy defaults, once the whole import has landed.
     *
     * Called LAST by bible-import.js, after applyCharacterProfile has filled the
     * left column, because both numbers depend on what the deck ended up holding:
     *
     *   gold per 1%   from the character's combat power, on the astrogem
     *                 calculator's own ladder — the same rate a gem is priced at
     *   baseline %    the score of the bracelet this character is ALREADY
     *                 wearing, under the profile the numbers are on
     *
     * With that baseline, "worth" stops meaning "against no bracelet at all" and
     * starts meaning "what upgrading from what they wear would be worth" — for an
     * unrolled bracelet, the option value of rolling into something better.
     *
     * Both are one-shot per character and both stay editable: profile.js keeps
     * the character key each was seeded for and never seeds twice.
     */
    seedEcon: function (c) {
      if (!c) return false;
      var cur = null;
      try {
        // The bracelet as imported, under the profile it is being scored on.
        // The two FIXED COMBAT TRAITS are part of the bracelet and score with it
        // — the solver takes them as their own argument, so they have to be added
        // by hand here or the baseline comes out several points light.
        var prof = buildProfile();
        var lines = fixedLines().concat(grantedLines());
        cur = pct(B.setDamage(lines, S.grade, prof) + B.traitDamage(traitValues(), prof));
      } catch (e) { cur = null; }
      return P.seedEcon({
        key: P.charKey(c),
        combatPower: (c.profile && c.profile.combatPower != null) ? c.profile.combatPower : null,
        currentPct: (cur != null && isFinite(cur)) ? cur : null
      });
    }
  };

  /**
   * What of a character page's own numbers we can honestly put in the deck.
   *
   * ITEM LEVEL is always there: the roster and the page both carry an average, and
   * the six honing sliders are what the model reads. An average maps to a uniform
   * honing level (Serca 0 is 1675, every level is +5), which is a derivation and
   * not a measurement — so every slider it sets is MARKED, editable, and reverts to
   * a "suggests" note the moment it is touched.
   *
   * THE REST arrives only when the Worker reads the character page directly and
   * sends the `profile` block of ARCHITECTURE §1.1. Each field is applied only if
   * the record actually carries it — nothing here invents a number:
   *
   *   weaponPower + mainStat  -> the raw override pair, and the override switch
   *                              with them, because a raw main stat that the honing
   *                              sliders then overwrite would be worse than none
   *   gemLevels               -> the one gem-level control
   *   critRate / critDamage   -> the first skill row's crit numbers
   *
   * Everything else the deck holds — fight shares, weights, the economy knobs — is
   * judgment, not data, and is never imported. Nothing about the bracelet itself
   * comes through here; that is the patch.
   */
  function importProfileValues(c) {
    if (!c) return;
    var vals = {}, i, any = false;
    var G = window.BraceletGearData;

    if (G && c.itemLevel != null) {
      var lvl = clamp(Math.round((Number(c.itemLevel) - G.ILVL0) / G.ILVL_STEP), 0, 25);
      if (isFinite(lvl)) {
        var keys = ["head", "shoulder", "chest", "pants", "gloves", "weapon"];
        for (i = 0; i < keys.length; i++) vals["gear." + keys[i]] = lvl;
        any = true;
      }
    }

    var pr = c.profile;
    if (pr) {
      var wp = num(pr.weaponPower, NaN), ms = num(pr.mainStat, NaN);
      // Both or neither: the override pair is one setting, and half of it is worse
      // than none — the model would then read one raw number and one derived one.
      if (isFinite(wp) && wp > 0 && isFinite(ms) && ms > 0) {
        vals["ov.weaponPowerRaw"] = Math.round(wp);
        vals["ov.mainStatRaw"] = Math.round(ms);
        vals.useOverride = true;
        any = true;
      }
      var gl = num(pr.gemLevels, NaN);
      if (isFinite(gl) && gl >= 6 && gl <= 10) { vals["kit.gems"] = Math.round(gl); any = true; }
      var cr = num(pr.critRate, NaN);
      if (isFinite(cr) && cr > 0 && cr <= 100) { vals["skills.0.cr"] = cr; any = true; }
      var cd = num(pr.critDamage, NaN);
      if (isFinite(cd) && cd > 0) { vals["skills.0.cd"] = cd; any = true; }
    }

    if (!any) { P.setCharacter(c); return; }
    P.applyImported(vals, c);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
