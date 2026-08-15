/**
 * advisor.js — the Advisor tab: what to DO with the bracelet you are holding.
 *
 * The Calculator says what a bracelet IS — its lines, its score, its worth, the
 * per-line breakdown. This tab says what to do next, the way the astrogem
 * calculator splits Grader from Advisor:
 *
 *   CHARACTER  name the character to advise on — type-ahead over the board
 *              snapshot, or one click on a saved ★. The control is
 *              char-picker.js, and this is now the only tab that mounts it;
 *              this file only gives it a box at the top, above the deck.
 *   INTAKE     drop / paste a screenshot, or "Read screen now" — the reader
 *              itself is advisor-capture.js, which plugs in through
 *              window.BraceletAdvisor (see THE CAPTURE SEAM below). Everything
 *              on this tab works without it.
 *   HEADLINE   play all the remaining rolls and you land here: expected final,
 *              what that is worth, and how often it beats what you hold.
 *   LOCKS      the recommended lock mask as slot pills, then every mask ranked
 *              by expected final with the gold it costs against the best one.
 *   SPREAD     P(improve) and the p10-p90 quantile strip.
 *   CUT        type the set the roll gave you, get KEEP or REPLACE with the
 *              delta in % and gold, apply it (advances rolls, appends to the
 *              session log) or undo.
 *
 * ONE DECK. There is exactly one control deck in the document and Profile.mount()
 * MOVES it (profile.js's header explains why). This tab claims it on activation;
 * app.js claims it back for the Calculator. Nothing to release — last mount wins,
 * and only one tab is ever visible.
 *
 * ONE SOLVER. A three-slot, seven-roll solve is ~48,000 states and ~3 s, so it
 * runs in solver-worker.js and never on this thread. app.js owns that worker,
 * its request-id discipline and its LRU cache, and it keeps ONE DP context —
 * advise() reads that context, so a second worker would not merely double the
 * cost, it would answer the cut flow off a different bracelet. This file
 * therefore owns no worker at all. It asks through the hook app.js exposes:
 *
 *     window.BraceletApp.solver = {
 *       solveState: solveState,                        // (profile, granted, rolls, opts)
 *                                                      //   -> Promise({key, res, cached})
 *       send: send,                                    // (cmd, payload) -> Promise(res)
 *       ctxKey: function () { return workerCtxKey; }   // whose DP the worker holds
 *     };
 *
 * Until that hook lands the tab degrades to a single honest message rather than
 * quietly starting a rival worker.
 *
 * Solving is also gated on this tab being the visible one. Both tabs subscribe to
 * Profile, the worker keeps one request in flight, and a newer request supersedes
 * whatever is queued — so an invisible tab that kept solving would cancel the
 * visible tab's solve for nothing.
 *
 * THE CAPTURE SEAM. advisor-capture.js (a separate file, separately owned) reads
 * a bracelet off a screenshot or a shared screen. It talks to this file through
 * window.BraceletAdvisor:
 *
 *   registerCapture(api)      the reader announces itself; the intake zone stops
 *                             saying "not wired yet" and wires its buttons to
 *                             api.onFiles / api.onPaste / api.readScreen
 *   applyParsed(parsed, conf) the ONE call that hands a bracelet over
 *   setStatus(text, kind)     "" | "working" | "err" — the line under the zone
 *   setPreview(url)           show the captured image (pass null to clear)
 *   setBusy(on)               the indeterminate bar
 *
 * `parsed` is the same patch shape bible-import.js already hands app.js, so one
 * decoder can feed both:
 *
 *   { target:    "bracelet" | "rolled"        // default "bracelet": the set you
 *                                             // HOLD. "rolled" fills the cut
 *                                             // flow's "what the roll gave you"
 *     grade:     "ancient" | "relic",
 *     slots:     2 | 3,
 *     rollsLeft: 0..7,
 *     traits:    { crit:{on,v}, spec:{on,v}, swift:{on,v} },
 *     rows:      [ {fam, tier, value}, ... ]  // one per granted slot
 *     fixedRows: [ {fam, tier, value}, ... ]
 *     lockedIdx: [0,2] }                      // the padlocks worn in game
 *
 *   `fam` is the picker's own value: "sp:<id>" | "basic:mainStat" |
 *   "basic:vitality" | "trait:<key>" | "junk" | "none". `tier` is
 *   "low"|"mid"|"high" (Rare/Epic/Legendary). Every key is optional; what is
 *   left out keeps its current value.
 *
 * `conf` is a flat map of state paths to 0..1 confidence:
 *   { "rows.0.fam": 0.98, "rows.0.tier": 0.42, "grade": 1, "rollsLeft": 0.6 }
 * Anything below 0.75 is marked UNCONFIRMED: it shows in the "what was read"
 * strip with a count and an accent marker, exactly astrogem's pattern, and the
 * mark clears for good when the user confirms or edits that field.
 *
 * NO NETWORK OF ITS OWN. This file opens no connection to anything. The character
 * picker's two needs — the board snapshot and a character lookup — both go through
 * bible-import.js (BraceletImport.seed / .loadCharacter), which already owns the
 * Worker call, the queue and the one absolute rule: the browser never fetches a
 * lostark.bible page itself.
 */
(function () {
  "use strict";

  var B = window.Bracelet, DATA = window.BraceletData, P = window.Profile;
  if (!B || !DATA || !P) return;                 // model or spine missing; leave the placeholder

  var PANE_ID = "tab-advisor";
  var DECK_HOST = "av-deckhost";
  var S = P.get();                               // the LIVE state object — never re-assigned
  var PARTY_IDS = { 16: 1, 17: 1, 18: 1, 19: 1 };
  var DEBOUNCE_MS = 300;
  var LOW_CONF = 0.75;                           // below this a parsed field wants a human look

  // ------------------------------------------------------------------
  // small helpers (three lines each, duplicated across the modules — there is no
  // module system here and profile.js's header says the same about its copies)
  // ------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fx(v, n) { return (Math.round(v * Math.pow(10, n)) / Math.pow(10, n)).toFixed(n); }
  function nf(v) { return Math.round(v).toLocaleString("en-US"); }
  function gold(g) {
    var a = Math.abs(g);
    if (a >= 1e6) return (g / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return Math.round(g / 1e3) + "k";
    return String(Math.round(g));
  }
  function signPct(d) { return (d >= 0 ? "+" : "") + fx(d, 2) + "%"; }
  /** D (log-space score) -> the exact combined damage percentage. */
  function pct(D) { return B.damagePercent(D); }

  // Gold always converts the EXACT damage percentage, never the log-space score,
  // so the arithmetic on screen matches the percentages printed beside it.
  function gpd() { return num(S.econ.gpd, 0); }
  // A DIFFERENCE between two options — lock mask A against lock mask B, the new
  // set against the old one. Both are futures you could still choose, so this one
  // is signed on purpose. WORTH is not a difference of that kind; see below.
  function deltaGold(Da, Db) { return (pct(Da) - pct(Db)) * gpd(); }

  // ------------------------------------------------------------------
  // WORTH — one implementation, on both tabs
  //
  //     E[ max(0, final% - baseline%) ] x gold per 1%
  //
  // You are paid only by the outcomes that BEAT the bracelet you would wear
  // instead, weighted by how often they happen and by how far they clear it. So
  // the figure is never negative: a bracelet you would not equip is worth
  // nothing, not a debt.
  //
  // This tab used to carry its own (expectedFinal - baseline) x gold — a
  // difference of MEANS, which goes negative the moment the baseline outruns the
  // bracelet, and which compared a LOG-SPACE score against a damage percentage,
  // mixing units on top (Shizu, 2026-08-11). Both halves of that are gone.
  //
  // Not read off res.valueGold: the solve is run with goldPer1Pct 0 and
  // baselinePct 0 on purpose, to keep gold out of the solve cache key so the gold
  // slider drags without a three-second re-solve. The worker's own valueGold is
  // therefore identically zero and its pBeatBaseline is P(final > 0) ~ 1.
  //
  // The Calculator and the Advisor must never quote different worths for the same
  // bracelet, so the arithmetic is app.js's and this file only asks for it.
  // ------------------------------------------------------------------

  /**
   * app.js's worth object, and there is no second copy of it anywhere.
   *
   * There used to be a LOCAL_WORTH mirror of the same four functions here,
   * carrying its own note to delete it the moment app.js exported `worth`.
   * app.js does — BraceletApp.worth, beside .solver — and it could never have
   * been reached anyway: app.js is an EAGER script in index.html and this file
   * is lazy, loaded only when someone opens the Advisor tab, so the export is
   * always already there. Two copies of one formula is exactly the drift this
   * seam exists to prevent, so the copy is gone and these are through-calls.
   */
  function W() {
    var A = window.BraceletApp;
    return (A && A.worth) || null;
  }
  /** { gold, p } — what it is worth, and the odds of clearing the baseline at all. */
  function worthOf(res, shift) { var w = W(); return w ? w.of(res, shift) : null; }
  function worthNote(w) { var x = W(); return x ? x.note(w) : ""; }
  function worthGloss(w) { var x = W(); return x ? x.gloss(w) : ""; }

  /** The one profile every tab scores on: whatever the deck holds. */
  function buildProfile() { return P.profile(); }

  var GRADE_COLOR = P.GRADE_COLOR, JUNK = P.JUNK;

  // ------------------------------------------------------------------
  // rows <-> model lines
  //
  // A copy of app.js's, deliberately: this file has to stand alone, and the
  // rolled-set pickers are the same widget the Bracelet panel draws. Both read
  // the same official tables and the same Profile helpers, so they cannot drift
  // in what they MEAN — only in where they live.
  // ------------------------------------------------------------------

  function msBands() { return DATA.BASIC.bands; }
  function msRange(grade, fam) {
    var b = msBands();
    return [b[0][grade][fam][0], b[b.length - 1][grade][fam][1]];
  }
  function defaultBasicValue(grade, fam) { return Math.round(B.basicBandExpected(fam, grade)); }

  function rowToLine(r, grade, junkFam) {
    if (!r || !r.fam || r.fam === "none") return null;
    if (r.fam === JUNK) {
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

  /** The solver's own label for a line. Locks come back as these keys. */
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

  function traitValues() { return P.traitValues(); }
  function fixedLines() { return linesOf(S.fixedRows, S.grade); }
  function grantedLines() { return linesOf(S.rows, S.grade, junkReps()); }
  function isPartial() { var n = grantedLines().length; return n > 0 && n < S.slots; }
  function isUnrolled() { return grantedLines().length === 0; }

  // ---- the "Junk Line" stand-ins (see app.js's long note on junkFamPool) ----

  var junkPoolCache = {};
  function junkFamPool(grade) {
    if (junkPoolCache[grade]) return junkPoolCache[grade];
    var fg = P.famGrades(grade), sum = DATA.GRANTED_LISTED_SUM, list = [], k, id, fam, w, t;
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

  /** One stand-in per granted slot, skipping anything a fixed line already holds. */
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

  // ------------------------------------------------------------------
  // the family / rarity pickers for the rolled set
  // ------------------------------------------------------------------

  var TIER_META = {
    low: { label: "Rare", color: "#5aa9e6" },
    mid: { label: "Epic", color: "#c78cff" },
    high: { label: "Legendary", color: "#ffb86b" }
  };

  function famGroupOf(fam) {
    if (PARTY_IDS[fam.id]) return "Party";
    var wp = false, only = true, i;
    for (i = 0; i < fam.comp.length; i++) {
      var k = fam.comp[i].k;
      if (k === "weaponPower") wp = true;
      else if (k !== "atkMoveSpeed") only = false;
    }
    return (wp && only) ? "Weapon Power" : null;
  }

  function cleanFamLabel(fam) {
    return fam.label
      .replace(/;\s*ally[^;]*$/i, "")
      .replace(/\(1\/party\)/g, "")
      .replace(/[+−-]\s*[AXB]%?/g, "")
      .replace(/\s+([;,])/g, "$1")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[;,]$/, "");
  }

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

  /** Every family a rolled slot can hold, grouped, letter-graded, F folded to one. */
  function familyOptions(grade) {
    var fg = P.famGrades(grade);
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
    for (i = 0; i < order.length; i++) {
      var keep = [];
      for (j = 0; j < G[order[i]].length; j++) if (G[order[i]][j].letter !== "F") keep.push(G[order[i]][j]);
      G[order[i]] = keep;
    }
    G.Junk = [{ val: JUNK, text: "Junk Line — no damage at all", letter: "F", avg: 0 }];

    var groups = [];
    for (i = 0; i < order.length; i++) {
      G[order[i]].sort(function (a, b) { return b.avg - a.avg; });
      groups.push({ label: order[i], items: G[order[i]] });
    }
    return groups;
  }

  function pickerHtml(id, groups, selected, grade) {
    var full = "", i, j;
    for (i = 0; i < groups.length; i++) {
      for (j = 0; j < groups[i].items.length; j++) if (groups[i].items[j].val === selected) full = groups[i].items[j].text;
    }
    var gloss = (full ? full + " — " : "") +
      "the effect family this slot rolled. The letter is the family's own grade, F to S: how good its AVERAGE roll is next to the best family in the game, always measured on the default character so the letters mean the same thing to everyone. What a particular roll is worth is the rarity box beside it.";
    var letter = P.letterOf(selected, grade);
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
          (selected === it.val ? " selected" : "") + ">" + esc(it.letter + " · " + it.text) + "</option>";
      }
      h += "</optgroup>";
    }
    return h + "</select>";
  }

  function tierHtml(id, fam, grade, selected) {
    var order = ["high", "mid", "low"], h = "", i, t;
    for (i = 0; i < order.length; i++) {
      t = order[i];
      h += '<option value="' + t + '" style="color:' + TIER_META[t].color + '"' +
        (selected === t ? " selected" : "") + ">" + esc(TIER_META[t].label + " · " + tierValueText(fam, grade, t)) + "</option>";
    }
    var cur = TIER_META[selected] ? TIER_META[selected].color : "var(--text)";
    return '<select id="' + id + '" style="color:' + cur + ';font-weight:700" data-gloss="' +
      "The rarity this line rolled at, and what it is worth. Legendary is the family's best roll, Epic the middle one, Rare the weakest; the numbers are the actual values for the family on the left." +
      '">' + h + "</select>";
  }

  /**
   * One rolled slot. The id prefix is "av-n", NOT app.js's "bc-n": app.js binds
   * its row handler on the DOCUMENT, so a shared prefix would have both files
   * writing the same row on one change event.
   */
  function rowMarkup(idx, row, label) {
    var grade = S.grade;
    var isBasic = row.fam.indexOf("basic:") === 0;
    var isSpecial = row.fam.indexOf("sp:") === 0;
    var famKey = isBasic ? row.fam.slice(6) : "mainStat";
    var msValue = (row.value === null || row.value === undefined || row.value === "") ? defaultBasicValue(grade, famKey) : num(row.value, defaultBasicValue(grade, famKey));
    var groups = familyOptions(grade);
    var rg = msRange(grade, famKey);

    var h = '<div class="bc-slot"><div class="sn">' + esc(label) + "</div>";
    if (isSpecial) {
      var fam = DATA.SPECIAL_BY_ID[Number(row.fam.slice(3))];
      h += '<div class="fld">' + (fam ? tierHtml("av-n-tier-" + idx, fam, grade, row.tier || "mid") : "") + "</div>";
    } else {
      h += "<div></div>";
    }
    h += '<div class="fld">' + pickerHtml("av-n-fam-" + idx, groups, row.fam, grade) + "</div>";
    if (isBasic) {
      h += '<div class="fld"><input type="number" id="av-n-val-' + idx + '" step="1" min="' + rg[0] + '" max="' + rg[1] +
        '" value="' + msValue + '" data-gloss="The number this stat line actually rolled. The official bands run ' +
        rg[0] + "–" + rg[1] + " on " + (grade === "relic" ? "Relic" : "Ancient") + '."></div>';
    } else {
      h += "<div></div>";
    }
    return h + "</div>";
  }

  // ------------------------------------------------------------------
  // line labels
  // ------------------------------------------------------------------

  function lineLabel(line, grade) {
    if (!line) return "—";
    if (line.junk) return "Junk Line";
    if (line.cat === "basic") return (line.family === "mainStat" ? "Str / Dex / Int +" : "Vitality +") + nf(line.value);
    if (line.cat === "trait") {
      var t = null, i;
      for (i = 0; i < DATA.TRAITS.families.length; i++) if (DATA.TRAITS.families[i].key === line.family) t = DATA.TRAITS.families[i];
      return (t ? t.label : line.family) + " (combat trait)";
    }
    var fam = DATA.SPECIAL_BY_ID[line.family];
    if (!fam) return "unknown";
    return fam.label + " · " + line.tier + " (" + fam.values[grade][line.tier].join(" / ") + ")";
  }

  /** A pill-sized name: the placeholders and the value list stripped, tier kept. */
  function shortLabel(line, grade) {
    if (!line) return "—";
    if (line.junk) return "Junk Line";
    if (line.cat === "basic") return (line.family === "mainStat" ? "Str / Dex / Int +" : "Vitality +") + nf(line.value);
    if (line.cat === "trait") return lineLabel(line, grade);
    var fam = DATA.SPECIAL_BY_ID[line.family];
    if (!fam) return "unknown";
    var s = cleanFamLabel(fam);
    if (s.length > 40) s = s.slice(0, 38).replace(/[\s,;]+$/, "") + "…";
    return s + " · " + line.tier;
  }

  /**
   * The solver reports locks as state atom keys. Walk them back onto the slots on
   * screen: greedy, because two slots can share a key only when both are junk,
   * and junk is never locked.
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

  // ------------------------------------------------------------------
  // the shared solver
  //
  // No worker is created here. See the header: app.js owns the one worker, its
  // one DP context and its LRU cache, and hands both tabs the same handle.
  // ------------------------------------------------------------------

  function solverApi() {
    var A = window.BraceletApp;
    return (A && A.solver && typeof A.solver.solveState === "function") ? A.solver : null;
  }

  var lastSolve = null, lastKey = null, lastErr = null, solving = false;
  var lastVerdict = null, verdictSig = null;

  /** What a verdict was judged against. It is only good for that exact bracelet. */
  function braceletSig() { return JSON.stringify([S.grade, S.slots, S.rollsLeft, grantedLines(), fixedLines()]); }

  /**
   * The Calculator edits the granted rows by direct mutation — save(), no notify
   * — so this tab cannot hear it happen. Anything that came back to this tab
   * therefore re-checks: a verdict judged against some other bracelet is worse
   * than no verdict.
   */
  function dropStaleVerdict() {
    if (lastVerdict && verdictSig !== braceletSig()) { lastVerdict = null; verdictSig = null; }
  }

  function solveError(e) {
    if (!e) return "solve failed";
    return e.message || String(e);
  }

  var debounceTimer = null, computeSeq = 0, dirty = true;

  function schedule(immediate) {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (immediate) recompute();
    else debounceTimer = setTimeout(recompute, DEBOUNCE_MS);
  }

  /**
   * Solve, then paint. Only ever runs while this tab is the visible one: the
   * worker keeps one request in flight and a newer one supersedes whatever is
   * queued, so a background tab that kept solving would cancel the foreground
   * tab's solve for a result nobody can see.
   */
  function recompute() {
    debounceTimer = null;
    if (!isActive()) { dirty = true; return; }
    dirty = false;

    var api = solverApi();
    if (!api) { lastSolve = null; lastErr = null; render(); return; }

    var profile = buildProfile();
    var granted = grantedLines();

    if (isPartial()) { lastSolve = null; lastKey = null; lastErr = null; render(); return; }
    var bad = validateSet(fixedLines().concat(granted));
    if (bad) { lastSolve = null; lastKey = null; lastErr = bad; render(); return; }

    var mine = ++computeSeq;
    solving = true;
    render();
    api.solveState(profile, granted, S.rollsLeft).then(function (out) {
      if (mine !== computeSeq) return;
      solving = false;
      lastSolve = out.res; lastKey = out.key; lastErr = null;
      render();
    }, function (e) {
      if (mine !== computeSeq) return;
      if (e && e.message === "superseded") return;   // a newer request took the worker
      solving = false;
      lastSolve = null; lastKey = null;
      lastErr = solveError(e);
      render();
    });
  }

  // ------------------------------------------------------------------
  // styles
  //
  // Injected from here, not added to styles.css: this tab owns its look, every
  // rule is inside the av- namespace or scoped to the pane, and the shared sheet
  // belongs to the shell. Dark only, like the rest of the tool.
  // ------------------------------------------------------------------

  function injectStyle() {
    if ($("av-style")) return;
    var css = "" +
      "#tab-advisor .av-lead{color:var(--dim);font-size:13px;line-height:1.6;max-width:78ch;margin:0 0 14px}" +
      "#tab-advisor .av-lead b{color:var(--text);font-weight:600}" +
      // ---- intake ----
      "#tab-advisor .av-intake{margin-bottom:14px}" +
      // The screenshot zone has the row to itself now: the character picker used
      // to sit beside it and has moved to the top of the tab, above the deck.
      "#tab-advisor .av-intakegrid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}" +
      // The picker itself is char-picker.js's; this is only the frame it sits in.
      // Styled by id, because CharPicker.mount() owns the host's class list. It is
      // the FIRST thing on the tab — name the character, then read the board it
      // feeds — and it takes the full width, so the ★ strip can wrap freely.
      "#av-who{border:1px solid var(--border);border-radius:10px;background:var(--panel);" +
        "padding:11px 12px;min-width:0;margin:0 0 12px}" +
      "#tab-advisor .av-nopicker{color:var(--dim);font-size:12.5px;line-height:1.55}" +
      "#tab-advisor .av-nopicker b{color:var(--text)}" +
      "#tab-advisor .av-drop{border:2px dashed var(--border);border-radius:10px;padding:14px 12px;text-align:center;" +
        "color:var(--dim);cursor:default;transition:border-color .15s,background .15s;background:var(--panel2);font-size:12.5px}" +
      "#tab-advisor .av-drop.drag{border-color:var(--accent);background:rgba(102,199,255,.08);color:var(--text)}" +
      "#tab-advisor .av-drop.has-img{cursor:pointer;padding:8px}" +
      "#tab-advisor .av-drop.has-img .hint{display:none}" +
      "#tab-advisor .av-drop b{color:var(--text)}" +
      "#tab-advisor .av-preview{display:none;width:100%;height:auto;max-height:420px;object-fit:contain;object-position:top;" +
        "background:#0b0e14;border-radius:8px;border:1px solid var(--border)}" +
      "#tab-advisor .av-drop.has-img .av-preview{display:block}" +
      "#tab-advisor .av-drop.av-min .av-preview{max-height:56px;object-fit:cover}" +
      "#tab-advisor .av-drop .cap{display:none;font-size:11px;color:var(--dim);margin-top:7px}" +
      "#tab-advisor .av-drop.has-img .cap{display:block}" +
      "#tab-advisor .av-status{font-size:12px;color:var(--dim);margin-top:6px;min-height:16px}" +
      "#tab-advisor .av-status.working{color:var(--accent)}" +
      "#tab-advisor .av-status.err{color:var(--bad)}" +
      "#tab-advisor .av-bar{height:6px;border-radius:3px;background:var(--border);overflow:hidden;margin-top:8px;display:none}" +
      "#tab-advisor .av-bar.on{display:block}" +
      "#tab-advisor .av-bar>i{display:block;height:100%;width:40%;background:var(--accent)}" +
      "@media (prefers-reduced-motion:no-preference){#tab-advisor .av-bar.on>i{animation:av-bar-slide 1.1s ease-in-out infinite}}" +
      "@keyframes av-bar-slide{0%{margin-left:-40%}100%{margin-left:100%}}" +
      "#tab-advisor .av-readbtns{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:9px}" +
      // what the reader made of it
      "#tab-advisor .av-parsed{margin-top:10px;border:1px solid var(--border);border-radius:9px;background:var(--panel);padding:10px 12px}" +
      "#tab-advisor .av-parsed .av-pline{display:flex;gap:9px;align-items:baseline;padding:4px 0;font-size:12.5px;border-bottom:1px solid var(--border)}" +
      "#tab-advisor .av-parsed .av-pline:last-child{border-bottom:none}" +
      "#tab-advisor .av-parsed .k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);min-width:62px}" +
      "#tab-advisor .av-unconf{color:var(--accent);border-bottom:1px dashed var(--accent)}" +
      "#tab-advisor .av-okbtn{background:none;border:1px solid var(--border);border-radius:99px;color:var(--dim);" +
        "font:inherit;font-size:10.5px;font-weight:700;padding:1px 9px;cursor:pointer;margin-left:auto}" +
      "#tab-advisor .av-okbtn:hover{color:var(--text);border-color:var(--accent)}" +
      // ---- headline cards ----
      "#tab-advisor .av-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}" +
      "#tab-advisor .av-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}" +
      "#tab-advisor .av-card .k{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:700}" +
      "#tab-advisor .av-card .v{font-size:25px;font-weight:800;letter-spacing:-.02em;margin-top:5px;line-height:1.1}" +
      "#tab-advisor .av-card .s{font-size:11px;color:var(--dim);margin-top:5px;line-height:1.45}" +
      "#tab-advisor .av-card.hero{border-color:var(--accent)}" +
      "#tab-advisor .av-card .v.acc{color:var(--accent)}" +
      "#tab-advisor .av-card .v.gold{color:var(--high)}" +
      "#tab-advisor .av-card .v.good{color:var(--good)}" +
      // ---- locks ----
      "#av-workgrid{display:grid;grid-template-columns:minmax(340px,5fr) minmax(420px,7fr);gap:14px;align-items:start}" +
      "#av-workgrid > #av-brhost > .panel{margin-top:0}" +
      "@media (max-width:1020px){#av-workgrid{grid-template-columns:1fr}}" +
      "#tab-advisor .av-lockline{font-size:14px;line-height:1.6;margin:2px 0 8px}" +
      "#tab-advisor .av-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11.5px;font-weight:700;" +
        "background:var(--panel2);border:1px solid var(--border);margin:0 4px 4px 0}" +
      "#tab-advisor .av-pill.lock{border-color:var(--accent);color:var(--accent)}" +
      "#tab-advisor .av-pill.roll{color:var(--dim)}" +
      "#tab-advisor .av-tabwrap{overflow-x:auto}" +
      // ---- the quantile strip ----
      "#tab-advisor .av-strip{position:relative;height:34px;margin:12px 0 4px}" +
      "#tab-advisor .av-strip .track{position:absolute;left:0;right:0;top:13px;height:8px;border-radius:4px;background:var(--panel2);border:1px solid var(--border)}" +
      "#tab-advisor .av-strip .whisk{position:absolute;top:16px;height:2px;background:var(--border)}" +
      "#tab-advisor .av-strip .box{position:absolute;top:9px;height:16px;border-radius:4px;background:rgba(102,199,255,.22);border:1px solid var(--accent)}" +
      "#tab-advisor .av-strip .med{position:absolute;top:5px;width:2px;height:24px;background:var(--accent)}" +
      "#tab-advisor .av-strip .cur{position:absolute;top:2px;width:2px;height:30px;background:var(--high)}" +
      "#tab-advisor .av-qlab{display:flex;justify-content:space-between;gap:4px;flex-wrap:wrap;font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums}" +
      // ---- the cut flow ----
      // minmax(0,1fr), never a bare 1fr. A bare 1fr is minmax(AUTO,1fr), and auto
      // is the widest thing inside — here a <select> whose longest option name is
      // half a sentence. That pushed the column past the phone and scrolled the
      // whole page sideways. minmax(0,…) lets the column be narrower than its
      // contents, which is what the ellipsis and the scroll wrappers are for.
      "#tab-advisor .av-cutgrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}" +
      "@media(max-width:760px){#tab-advisor .av-cutgrid{grid-template-columns:minmax(0,1fr)}}" +
      // The rolled-set rows are app.js's .bc-slot widget, borrowed. Its phone
      // layout (profile.js, max-width 640) has the same bare 1fr, so cap it here
      // rather than reach into profile.js's sheet: on this tab the row sits inside
      // a grid column, not across the page, so it has less room to start with and
      // the fix belongs where the crowding is. Desktop columns are left alone.
      "#tab-advisor .bc-slot>*{min-width:0}" +
      "#tab-advisor .bc-slot select,#tab-advisor .bc-slot input{max-width:100%}" +
      "@media(max-width:640px){#tab-advisor .bc-slot{grid-template-columns:minmax(0,1fr)}}" +
      "#tab-advisor .av-lockrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--border);" +
        "border-radius:7px;margin-bottom:6px;background:var(--panel2);font-size:12.5px}" +
      "#tab-advisor .av-lockrow input{accent-color:var(--accent);flex:0 0 auto}" +
      "#tab-advisor .av-lockrow .ln{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#tab-advisor .av-verdict{border-radius:10px;padding:13px 15px;margin-top:12px;border:1px solid var(--border);background:var(--panel2)}" +
      "#tab-advisor .av-verdict.keep{border-color:var(--good)}" +
      "#tab-advisor .av-verdict.replace{border-color:var(--high)}" +
      "#tab-advisor .av-verdict .hd{font-size:19px;font-weight:800;letter-spacing:-.01em}" +
      "#tab-advisor .av-verdict.keep .hd{color:var(--good)}" +
      "#tab-advisor .av-verdict.replace .hd{color:var(--high)}" +
      "#tab-advisor .av-verdict .bd{font-size:12.5px;color:var(--dim);margin-top:6px;line-height:1.55}" +
      "#tab-advisor .av-hist{list-style:none;margin:8px 0 0;padding:0;font-size:12.5px}" +
      "#tab-advisor .av-hist li{padding:6px 0;border-bottom:1px solid var(--border);line-height:1.5}" +
      "#tab-advisor .av-hist li:last-child{border-bottom:none}" +
      "#tab-advisor .av-warn{color:var(--bad);font-size:12.5px;margin:8px 0;line-height:1.55}" +
      "#tab-advisor .av-empty{border:1px dashed var(--border);border-radius:10px;background:var(--panel2);color:var(--dim);" +
        "font-size:13px;padding:22px 16px;line-height:1.6}" +
      "#tab-advisor .av-empty b{color:var(--text)}" +
      // The character's two buttons take their own line under the deck.
      "#tab-advisor .av-hdr{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0 6px}" +
      "#tab-advisor .av-hdr>.bc-hdrctl{flex:1 0 100%}" +
      // Phones: the tables scroll inside their own wrapper, never the page.
      "@media(max-width:420px){" +
      "#tab-advisor .av-card .v{font-size:21px}" +
      "#tab-advisor .av-qlab{font-size:10px}" +
      "#tab-advisor .av-qlab span{white-space:nowrap}}";
    var st = document.createElement("style");
    st.id = "av-style";
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------
  // the character picker
  // ------------------------------------------------------------------
  //
  // char-picker.js owns it. The Tier List used to mount the same control; Shizu
  // took the picker and the deck off that tab (2026-08-12), so this is the only
  // tab that mounts it now — char-picker.js still supports several, and the
  // Calculator's own ★ chips are the other way in.
  //
  // This file only gives it a box at the top of the tab, above the character
  // board: name the character first, then read what the board and the advice make
  // of them.
  //
  // It loads nothing itself (BraceletImport.loadCharacter is the one load path —
  // see the module header). A pick lands in the shared state, Profile notifies,
  // and onProfileChange re-renders and re-solves, so the headline cards, the mask
  // table and the cut flow all follow.
  //
  // It leaves the SCORING MODE alone, deliberately. On this tab that costs
  // nothing: a new character brings a new bracelet, and the advice is about that
  // bracelet whichever settings it is scored on. The lead line says which.

  var whoCtl = null;

  function mountWho() {
    var host = $("av-who");
    if (!host || whoCtl) return;
    if (!window.CharPicker || typeof window.CharPicker.mount !== "function") {
      host.innerHTML = '<div class="av-nopicker"><b>Character lookup did not load.</b> ' +
        "char-picker.js is not on the page, so this tab cannot name a character. " +
        "Load one in the Calculator and come back — everything else here works.</div>";
      return;
    }
    whoCtl = window.CharPicker.mount(host, {
      layout: "row",
      title: "Character",
      emptyText: "None loaded — the advice below is about whatever bracelet the Calculator holds."
    });
  }


  // ------------------------------------------------------------------
  // the intake zone
  // ------------------------------------------------------------------

  var capture = null;               // whatever advisor-capture.js registered
  var parsedReport = null;          // { fields:[{path,label,text,conf}], from }
  var confirmed = {};               // path -> 1 once the user says it reads right

  function intakeMarkup() {
    return '' +
      '<div class="av-intake">' +
      '  <div class="av-intakegrid">' +
      '    <div class="av-drop" id="av-drop">' +
      '      <span class="hint" id="av-hint"></span>' +
      '      <img id="av-preview" class="av-preview" alt="screenshot preview">' +
      '      <span class="cap">drop or paste a new screenshot to replace · click to expand / minimize</span>' +
      '      <div class="av-readbtns" id="av-readbtns"></div>' +
      '    </div>' +
      '  </div>' +
      '  <div class="av-status" id="av-status"></div>' +
      '  <div class="av-bar" id="av-bar"><i></i></div>' +
      '  <div id="av-parsed"></div>' +
      "</div>";
  }

  function renderIntake() {
    var hint = $("av-hint"), btns = $("av-readbtns");
    if (!hint || !btns) return;
    if (!capture) {
      hint.innerHTML = "<b>Reading a bracelet off the screen is not wired up yet.</b> " +
        "The reader (advisor-capture.js) has not loaded. Everything else here works &mdash; " +
        "type the lines into the Bracelet panel above.";
      btns.innerHTML = "";
    } else {
      hint.innerHTML = "<b>Drop or paste</b> a bracelet screenshot and the reader fills the lines in for you." +
        (capture.readScreen ? " Or share your screen and read it live." : "");
      var h = '<button type="button" class="mbtn" id="av-pick">Choose a screenshot</button>';
      if (capture.readScreen) h += '<button type="button" class="mbtn" id="av-read">Read screen now</button>';
      btns.innerHTML = h;
    }
    renderParsed();
  }

  function renderParsed() {
    var box = $("av-parsed");
    if (!box) return;
    if (!parsedReport || !parsedReport.fields.length) { box.innerHTML = ""; return; }
    var f = parsedReport.fields, i, open = 0;
    for (i = 0; i < f.length; i++) if (f[i].conf < LOW_CONF && !confirmed[f[i].path]) open++;
    var h = '<div class="av-parsed"><div class="subh" style="margin-top:0">What the reader made of it</div>';
    for (i = 0; i < f.length; i++) {
      var low = f[i].conf < LOW_CONF && !confirmed[f[i].path];
      h += '<div class="av-pline"><span class="k">' + esc(f[i].label) + "</span>" +
        '<span class="' + (low ? "av-unconf" : "") + '"' +
        (low ? ' data-gloss="The reader is only ' + Math.round(f[i].conf * 100) + '% sure of this one. Check it against the game, then mark it right."' : "") +
        ">" + esc(f[i].text) + "</span>" +
        (low ? '<button type="button" class="av-okbtn" data-avok="' + esc(f[i].path) + '">looks right</button>' : "") +
        "</div>";
    }
    h += '<div class="note">' + (open
      ? "<b>" + open + (open === 1 ? " field needs" : " fields need") + " a look</b> — the marked ones. Fix anything wrong in the Bracelet panel above; the numbers here follow."
      : "Every field read cleanly.") + "</div></div>";
    box.innerHTML = h;
  }

  function setStatus(text, kind) {
    var el = $("av-status");
    if (!el) return;
    el.className = "av-status" + (kind ? " " + kind : "");
    el.textContent = text || "";
  }
  function setBusy(on) {
    var el = $("av-bar");
    if (el) el.className = on ? "av-bar on" : "av-bar";
  }
  function setPreview(url) {
    var img = $("av-preview"), drop = $("av-drop");
    if (!img || !drop) return;
    if (!url) { img.removeAttribute("src"); drop.classList.remove("has-img"); drop.classList.remove("av-min"); return; }
    img.src = url;
    drop.classList.add("has-img");
    drop.classList.add("av-min");                // starts minimised; a click expands it
  }

  function handOff(files) {
    if (!capture || !capture.onFiles) {
      setStatus("Nothing here can read a screenshot yet — advisor-capture.js has not loaded.", "err");
      return;
    }
    try { capture.onFiles(files); }
    catch (e) { setStatus("The reader failed: " + ((e && e.message) || "unknown error"), "err"); }
  }

  // ------------------------------------------------------------------
  // markup — the advice itself
  // ------------------------------------------------------------------

  function quantileStrip(q, cur) {
    var lo = Math.min(pct(q.p10), pct(cur)), hi = Math.max(pct(q.p90), pct(cur));
    var pad = Math.max(0.3, (hi - lo) * 0.12);
    lo -= pad; hi += pad;
    var span = hi - lo || 1;
    function x(v) { return ((pct(v) - lo) / span * 100).toFixed(2) + "%"; }
    function w(a, b) { return ((pct(b) - pct(a)) / span * 100).toFixed(2) + "%"; }
    return '<div class="av-strip">' +
      '<div class="track"></div>' +
      '<div class="whisk" style="left:' + x(q.p10) + ";width:" + w(q.p10, q.p90) + '"></div>' +
      '<div class="box" style="left:' + x(q.p25) + ";width:" + w(q.p25, q.p75) + '"></div>' +
      '<div class="med" style="left:' + x(q.p50) + '"></div>' +
      '<div class="cur" style="left:' + x(cur) + '" data-gloss="Where the bracelet sits right now."></div>' +
      "</div>" +
      '<div class="av-qlab" data-gloss="The spread of where this bracelet finishes, over every way the remaining rolls can land under the best play. p10 means one bracelet in ten ends below this; p90, one in ten ends above. The blue box is the middle half, the blue line the median, the orange line where you are today.">' +
      "<span>p10 " + fx(pct(q.p10), 2) + "%</span><span>p25 " + fx(pct(q.p25), 2) +
      "%</span><span>median " + fx(pct(q.p50), 2) + "%</span><span>p75 " + fx(pct(q.p75), 2) +
      "%</span><span>p90 " + fx(pct(q.p90), 2) + "%</span></div>";
  }

  /** The advice framing: play every remaining roll and this is where you land. */
  function cardsHtml(res) {
    var curPct = pct(res.currentScore), finPct = pct(res.expectedFinal);
    var w = worthOf(res, 0);
    var n = S.rollsLeft, plural = n === 1 ? "" : "s";
    var h = '<div class="av-cards">';
    h += '<div class="av-card hero"><div class="k">Play all ' + n + " roll" + plural + " and you land at</div>" +
      '<div class="v acc">' + fx(finPct, 2) + "%</div>" +
      '<div class="s">The average finish under the best lock-and-keep play<span data-gloss="Rolls are free, so rolling always beats stopping. This is the expected final score if every remaining decision is the one the solver names — not a promise, an expectation.">*</span>, ' +
      "up from " + fx(curPct, 2) + "% today.</div></div>";
    h += '<div class="av-card"><div class="k">Still to gain</div><div class="v good">' +
      signPct(finPct - curPct) + "</div>" +
      '<div class="s">What the ' + n + " remaining roll" + plural + " are expected to add to the bracelet you hold.</div></div>";
    h += '<div class="av-card"><div class="k">Chance it improves</div><div class="v">' + fx(res.pImprove * 100, 1) + "%</div>" +
      '<div class="s"><span data-gloss="Not the chance any single roll comes out better. You keep the old set whenever the new one is worse, so the only way to finish below where you started is to never take a roll.">How often</span> the bracelet you end with beats the ' +
      fx(curPct, 2) + "% you hold.</div></div>";
    h += '<div class="av-card"><div class="k" data-gloss="' + esc(worthGloss(w)) + '">Worth playing out</div>' +
      '<div class="v gold">' + (w ? gold(w.gold) : "—") + "</div>" +
      '<div class="s">' + esc(worthNote(w)) + "</div></div>";
    return h + "</div>";
  }

  function locksHtml(res, profile, lines) {
    var h = '<div class="panel"><h2 style="margin-top:0">Best locks for the next roll</h2>';
    if (!res.maskEV.length) {
      return h + "<p>No rolls left — nothing to lock.</p></div>";
    }
    var best = res.maskEV[0];
    var lockFlags = locksFromKeys(best.lockedKeys, lines, S.grade, profile);

    h += '<div class="av-lockline">';
    if (!best.lockedKeys.length) {
      h += "<b>Lock nothing.</b> Reroll all " + S.slots + " slots.";
    } else {
      h += "<b>Lock</b> ";
      var i;
      for (i = 0; i < lockFlags.length; i++) if (lockFlags[i]) h += '<span class="av-pill lock">Slot ' + (i + 1) + " · " + esc(shortLabel(lines[i], S.grade)) + "</span>";
      h += "<b>reroll</b> ";
      for (i = 0; i < lockFlags.length; i++) if (!lockFlags[i]) h += '<span class="av-pill roll">Slot ' + (i + 1) + " · " + esc(shortLabel(lines[i], S.grade)) + "</span>";
    }
    h += "</div>";

    var second = res.maskEV.length > 1 ? res.maskEV[1] : null;
    h += '<p class="note">Expected final ' + fx(pct(best.ev), 3) + "%" +
      (second ? ", worth " + gold(deltaGold(best.ev, second.ev)) + " gold more than the next best mask" : "") +
      ". A lock is only worth it when the line it holds is scarcer than what a fresh draw would give you — the solver weighs both, over every remaining roll.</p>";

    h += '<div class="av-tabwrap"><table><thead><tr>' +
      '<th><span data-gloss="Which slots you pay to keep before pressing reroll. Everything not listed is rerolled together — one attempt rerolls every unlocked slot at once.">Lock</span></th>' +
      '<th class="num"><span data-gloss="The average score this bracelet finishes at if you lock exactly these slots now and then play the remaining rolls perfectly. Rolls are free, so rolling always beats stopping.">Expected final</span></th>' +
      '<th class="num"><span data-gloss="What choosing this mask instead of the best one costs you, in gold, at your gold-per-1% rate.">vs best</span></th>' +
      "</tr></thead><tbody>";
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
    return h + "</div>";
  }

  function spreadHtml(res) {
    return '<div class="panel"><h2 style="margin-top:0">Where it can land</h2>' +
      quantileStrip(res.finalScore.quantiles, res.currentScore) +
      '<p class="note">Box = the middle half of the outcomes, whisker = p10 to p90, orange = where the bracelet sits today. ' +
      "Every ending is counted over all " + S.rollsLeft + " remaining roll" + (S.rollsLeft === 1 ? "" : "s") +
      " played the way the lock table says.</p></div>";
  }

  // ---- the cut flow ----

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
      for (var i = 0; i < S.slots; i++) S.rolled.push(P.blankRow());
    }
    return S.rolled;
  }

  function cutHtml(res, profile, lines) {
    var h = '<div class="panel" id="av-cut"><h2 style="margin-top:0">I rolled — keep or replace?</h2>';
    if (S.rollsLeft <= 0) return h + "<p>No rolls left.</p>" + historyHtml() + "</div>";

    var locks = cutLocks(res, lines, profile);
    ensureRolled();

    h += '<p class="note">Lock what you locked in game, type the lines the roll gave you, and the tool compares the two sets by what they are worth with ' +
      (S.rollsLeft - 1) + " roll" + (S.rollsLeft - 1 === 1 ? "" : "s") +
      ' still to come<span data-gloss="Not by which set scores more today. A weaker set can be worth more because of what it clears out of the pool for the rolls that follow.">*</span>.</p>';

    h += '<div class="av-cutgrid"><div><div class="subh">Locked for this roll</div>';
    var i;
    for (i = 0; i < S.slots; i++) {
      h += '<div class="av-lockrow"><input type="checkbox" data-avlock="' + i + '"' + (locks[i] ? " checked" : "") +
        '><span class="ln">Slot ' + (i + 1) + " · " + esc(shortLabel(lines[i], S.grade)) + "</span></div>";
    }
    h += '</div><div><div class="subh">What the roll gave you</div>';
    var any = false;
    for (i = 0; i < S.slots; i++) {
      if (locks[i]) continue;
      any = true;
      h += rowMarkup(i, S.rolled[i], "Slot " + (i + 1));
    }
    if (!any) h += '<div class="note">Every slot is locked — nothing would reroll.</div>';
    h += "</div></div>";

    h += '<div class="barrow"><button class="primary" id="av-check" type="button">Check this roll</button>' +
      '<button class="mbtn" id="av-undo" type="button"' + (S.history.length ? "" : " disabled") + ">Undo last</button></div>";

    if (lastVerdict) h += verdictHtml(lastVerdict);
    h += historyHtml();
    return h + "</div>";
  }

  function verdictHtml(v) {
    if (v.error) return '<div class="av-warn">' + esc(v.error) + "</div>";
    var take = v.verdict === "replace";
    var dGold = deltaGold(v.vNew, v.vKeep);
    return '<div class="av-verdict ' + (take ? "replace" : "keep") + '">' +
      '<div class="hd">' + (take ? "TAKE THE NEW SET" : "KEEP WHAT YOU HAVE") + "</div>" +
      '<div class="bd">New set is worth ' + fx(pct(v.vNew), 3) + "% against " + fx(pct(v.vKeep), 3) +
      "% for the old one, both counting the " + v.rollsLeft + " roll" + (v.rollsLeft === 1 ? "" : "s") + " still to come. " +
      "That is " + signPct(pct(v.vNew) - pct(v.vKeep)) + ", or " + (dGold >= 0 ? "+" : "−") + gold(Math.abs(dGold)) + " gold. " +
      "On today's score alone it would be " + fx(pct(v.scoreNew), 2) + "% against " + fx(pct(v.scoreKeep), 2) + "%.</div>" +
      '<div class="barrow"><button class="' + (take ? "primary" : "mbtn") + '" id="av-apply-new" type="button">Apply — take the new set</button>' +
      '<button class="' + (take ? "mbtn" : "primary") + '" id="av-apply-keep" type="button">Apply — keep the old set</button></div>' +
      "</div>";
  }

  function historyHtml() {
    if (!S.history.length) return "";
    var h = '<div class="subh">This session</div><ul class="av-hist">', i;
    for (i = S.history.length - 1; i >= 0; i--) {
      var e = S.history[i];
      h += "<li><b>" + (e.took ? "Replaced" : "Kept") + "</b> at " + e.rollsBefore + " rolls left · " +
        (e.locked.length ? "locked " + esc(e.locked.join(", ")) : "nothing locked") + " · rolled " +
        esc(e.rolledText) + " · " + signPct(e.deltaPct) + "</li>";
    }
    return h + "</ul>";
  }

  // ------------------------------------------------------------------
  // render
  // ------------------------------------------------------------------

  function leadHtml() {
    return '<div class="av-lead">The Calculator says what this bracelet <b>is</b>. This tab says what to <b>do</b> with it: ' +
      "which slots to lock before the next roll, how the remaining rolls are likely to land, and whether the set you just rolled beats the one you are holding." +
      "</div>";
  }

  /**
   * worthNote() is a FIGURE, not a sentence — "94% of the outcomes clear your
   * 0.00% baseline" — so it is written to sit in a chip on its own and starts
   * lowercase. Dropped straight after a full stop it reads as a broken join:
   * "...worth 2.25M gold. very nearly all of the outcomes...". This closes it off
   * as its own sentence. The "Nothing it can roll beats..." case already ends in a
   * full stop and passes through untouched.
   */
  function sentenceTail(note) {
    if (!note) return "";
    var t = String(note);
    if (/[.!?]$/.test(t)) return t;
    return t.charAt(0).toUpperCase() + t.slice(1) + ".";
  }

  function bodyHtml() {
    var api = solverApi();
    if (!api) {
      return '<div class="av-empty"><b>The solver is not shared with this tab yet.</b><br>' +
        "app.js owns the one Web Worker that solves a bracelet, and it has to hand it over " +
        "(<code>window.BraceletApp.solver</code>). Until that wiring lands the Advisor cannot compute anything — " +
        "and starting a second worker would answer the cut flow off a different bracelet, so it does not.</div>";
    }
    if (isPartial()) {
      return '<div class="av-empty"><b>Half a bracelet is not a state the game can be in.</b><br>' +
        "Fill every granted slot in the Bracelet panel above, or clear them all for an unrolled bracelet. " +
        "The solver refuses the in-between, and so does this tab.</div>";
    }
    if (lastErr) {
      return '<div class="panel"><div class="av-warn"><b>The solve failed:</b> ' + esc(lastErr) + "<br>" +
        "Change any input to rebuild, then try again.</div></div>";
    }
    if (!lastSolve) {
      return '<div class="av-empty">' + (solving ? "Solving — a three-slot, seven-roll bracelet takes a few seconds…" : "Nothing solved yet.") + "</div>";
    }

    var profile = buildProfile();
    var lines = grantedLines();
    var res = lastSolve;

    if (res.unrolled || isUnrolled()) {
      var wu = worthOf(res, 0);
      return '<div class="av-empty"><b>The bracelet has not been opened yet.</b><br>' +
        "An unrolled " + esc(S.grade) + " bracelet with " + S.slots + " granted slots and " + S.rollsLeft +
        " rolls lands at <b>" + fx(pct(res.expectedFinal), 2) + "%</b> expected, and is worth <b>" +
        (wu ? gold(wu.gold) : "—") + "</b> gold" +
        // worthNote() is empty at a 0% baseline — a comparison against nothing —
        // so the joining dash must go with it or the sentence trails off mid-air.
        (worthNote(wu) ? " — " + esc(sentenceTail(worthNote(wu))) : ".") +
        " Fill the granted slots in the Bracelet panel above and this tab will name the lines to lock.</div>" +
        '<div class="panel" style="margin-top:12px"><h2 style="margin-top:0">Where an unrolled one can land</h2>' +
        quantileStrip(res.finalScore.quantiles, res.currentScore) +
        '<p class="note">Every way the ' + S.rollsLeft + " rolls can go, played the way the solver would play them.</p></div>";
    }

    if (S.rollsLeft <= 0) {
      // A finished bracelet has one outcome, so its worth is simply how far that
      // one outcome clears the baseline — and nothing if it does not clear it.
      // Say so in those words: "worth 0" with no explanation reads as a bug.
      var wf = worthOf(res, 0), baseF = fx(num(S.econ.baseline, 0), 2) + "%";
      var tail = (wf && wf.gold > 0)
        ? "It clears your " + baseF + " baseline by " + fx(pct(res.currentScore) - num(S.econ.baseline, 0), 2) +
          "%, so it is worth <b>" + gold(wf.gold) + "</b> gold at " + gold(gpd()) + " gold per 1%."
        : "It does not beat your " + baseF + " baseline, so it is worth <b>0</b> to you — " +
          "the bracelet you already wear is the better one, and worth is never a debt.";
      return '<div class="av-empty"><b>No rolls left — this bracelet is final at ' + fx(pct(res.currentScore), 2) + "%.</b><br>" +
        "Nothing to advise: there is no decision in front of you. The Calculator has the line-by-line breakdown. " +
        tail + "</div>" +
        (S.history.length ? '<div class="panel" style="margin-top:12px">' + historyHtml() + "</div>" : "");
    }

    return cardsHtml(res) + locksHtml(res, profile, lines) + spreadHtml(res) + cutHtml(res, profile, lines);
  }

  /**
   * The methodology block: LAST element in the pane, collapsed, one per tab —
   * the shape the Tier List set and docs/design/copy-rules.md fixes. The Method
   * tab's own header promises every tab carries one; this tab had none.
   *
   * STATIC, and appended to whatever bodyHtml() returns, so it is there in every
   * state the tab can be in — including the three that print nothing else. It
   * quotes the model, never the solve: a live figure here would go stale the
   * moment the deck moved.
   */
  function methodHtml() {
    return '<details class="method">' +
      "<summary>How the numbers on this tab are worked out</summary>" +

      "<p><b>The lock table ranks lock masks, not lines.</b> One attempt rerolls every unlocked slot at once, " +
      "so the decision is which SET to freeze. For each legal mask the solver reports <b>expected final</b>: " +
      "what the bracelet is worth after you lock exactly those slots and then play every remaining roll the way " +
      "it would play them. The <b>vs best</b> column prices the gap against the top mask at your gold rate.</p>" +

      "<p><b>The verdict never compares today&rsquo;s scores.</b> It compares <b>continuation values</b> &mdash; " +
      "<code>V(s, n)</code>, what a set is worth with n rolls still to come, solved backwards from the last roll. " +
      "A weaker set can genuinely be worth more, because the families it holds are out of the pool and the next " +
      "draw comes from a better one. That is why KEEP sometimes lands on the lower number.</p>" +

      "<p><b>Expected final is an average</b>, over every way the remaining rolls can land under that best play. " +
      "Every outcome is enumerated and the recursion solved exactly &mdash; no simulation &mdash; so it is the " +
      "model&rsquo;s own expectation rather than a sample of it. It is not a promise: half of all bracelets finish " +
      "below the median.</p>" +

      "<p><b>The strip is that spread drawn out.</b> Whisker p10 to p90, box the middle half, blue line the " +
      "median, orange line where the bracelet sits today. One bracelet in ten ends below p10 and one in ten " +
      "above p90, so the distance from the box to the whisker is the risk the average hides.</p>" +

      "<p><b>Worth</b> is <code>E[max(0, final% &minus; baseline%)] &times; gold per 1%</code>. Only the outcomes " +
      "that beat the bracelet you would wear instead pay, weighted by how often they land and by how far they " +
      "clear it &mdash; so it is never negative: a bracelet you would not equip is worth nothing, not a debt. " +
      "Both inputs are yours, and the truncation sits inside the expectation, which is the whole argument.</p>" +

      "<p><b>A support is scored on one damage dealer.</b> Every figure on this tab &mdash; the score, the " +
      "expected final, the strip, the gold &mdash; is what a single dealer standing next to you gains, not the " +
      "party total. It is the one unit that compares directly against a damage dealer&rsquo;s own bracelet.</p>" +

      "<p>Rolls cost silver, not gold, and this tool treats them as free. That settles a lot: rolling always beats " +
      "stopping, so there is no should-I-stop question and the value of a state is simply its best-play " +
      "expectation. Where the character baseline comes from and how each bucket is scored: the <b>Method</b> tab.</p>" +
      "</details>";
  }

  function render() {
    var body = $("av-body"), lead = $("av-lead");
    if (!body) return;
    if (lead) lead.innerHTML = leadHtml();
    body.innerHTML = bodyHtml() + methodHtml();
    if (typeof P.mountCharControls === "function") P.mountCharControls($("av-hdrctl"));
  }

  /** Rebuild, then put the cursor back where it was. */
  function keepFocus(fn) {
    var a = document.activeElement, id = (a && a.id) ? a.id : null;
    fn();
    if (id) { var el = $(id); if (el && el.focus) el.focus(); }
  }

  // ------------------------------------------------------------------
  // the cut flow's behaviour
  // ------------------------------------------------------------------

  function rolledSet(locks) {
    var lines = grantedLines(), reps = junkReps(), out = [], i;
    for (i = 0; i < S.slots; i++) {
      // Same slot, same junk stand-in on both sides, so a locked junk slot and a
      // rolled one can never collide into a duplicate family.
      out.push(locks[i] ? lines[i] : rowToLine(S.rolled[i], S.grade, reps[i]));
    }
    return out;
  }

  function checkRoll() {
    var api = solverApi();
    if (!api) return;
    var profile = buildProfile(), lines = grantedLines();
    var locks = cutLocks(lastSolve, lines, profile);
    var newSet = rolledSet(locks), i;
    for (i = 0; i < newSet.length; i++) {
      if (!newSet[i]) {
        lastVerdict = { error: "Slot " + (i + 1) + " of the new roll is still empty — pick the line it gave you." };
        render(); return;
      }
    }
    var bad = validateSet(fixedLines().concat(newSet));
    if (bad) { lastVerdict = { error: "That roll is not legal: " + bad }; render(); return; }

    // advise() reads the DP the worker is holding. If that is some other
    // bracelet — a cache hit answered the display without ever reaching the
    // worker, or the Calculator solved something else last — solve this one
    // first, in the same click.
    var ready = (lastKey && api.ctxKey && api.ctxKey() === lastKey)
      ? Promise.resolve()
      : api.solveState(profile, lines, S.rollsLeft, { force: true }).then(function (out) {
        lastSolve = out.res; lastKey = out.key;
      });

    setBusyVerdict(true);
    ready.then(function () {
      return api.send("advise", { current: lines, rolled: newSet, rollsLeft: S.rollsLeft - 1, ctxKey: lastKey });
    }).then(function (v) {
      setBusyVerdict(false);
      if (v.verdict === "unknown") { lastVerdict = { error: "The solver does not recognise one of those sets — check for a duplicate effect." }; verdictSig = null; }
      else { v.newSet = newSet; v.locks = locks; lastVerdict = v; verdictSig = braceletSig(); }
      render();
    }, function (e) {
      setBusyVerdict(false);
      if (e && e.message === "superseded") return;
      lastVerdict = { error: "Could not judge that roll: " + solveError(e) + ". Change any input to rebuild, then try again." };
      render();
    });
  }

  function setBusyVerdict(on) {
    var b = $("av-check");
    if (!b) return;
    b.disabled = !!on;
    b.textContent = on ? "Checking…" : "Check this roll";
  }

  function applyVerdict(take) {
    if (!lastVerdict || lastVerdict.error) return;
    var locks = lastVerdict.locks, i;
    var lockNames = [], rolledText = [];
    for (i = 0; i < locks.length; i++) if (locks[i]) lockNames.push("slot " + (i + 1));
    for (i = 0; i < S.slots; i++) if (!locks[i]) rolledText.push(shortLabel(lastVerdict.newSet[i], S.grade));

    S.history.push({
      rollsBefore: S.rollsLeft,
      locked: lockNames,
      rolledText: rolledText.join(" + "),
      took: !!take,
      deltaPct: pct(lastVerdict.vNew) - pct(lastVerdict.vKeep),
      prevRows: JSON.parse(JSON.stringify(S.rows))
    });

    var rows = S.rows;
    if (take) {
      rows = [];
      for (i = 0; i < S.slots; i++) rows.push(locks[i] ? S.rows[i] : JSON.parse(JSON.stringify(S.rolled[i])));
    }
    lastVerdict = null;
    // set() merges, re-fits, persists, redraws the deck and notifies — which is
    // how the Calculator's own rows and rolls-left field follow this tab.
    P.set({ rows: rows, rollsLeft: Math.max(0, S.rollsLeft - 1), locks: null, rolled: null });
  }

  function undo() {
    var e = S.history.pop();
    if (!e) return;
    lastVerdict = null;
    P.set({ rows: e.prevRows, rollsLeft: e.rollsBefore, locks: null, rolled: null });
  }

  // ------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------

  /** A rolled row changed. The ids are av-n-*, never app.js's bc-n-*. */
  function handleRowEvent(el) {
    var m = /^av-n-(fam|tier|val)-(\d+)$/.exec(el.id || "");
    if (!m) return false;
    var rows = ensureRolled(), i = Number(m[2]), row = rows[i];
    if (!row) return false;
    if (m[1] === "fam") {
      row.fam = el.value;
      if (row.fam === JUNK) row.value = null;
      if (row.fam.indexOf("basic:") === 0 && (row.value === null || row.value === undefined || row.value === "")) {
        row.value = defaultBasicValue(S.grade, row.fam.slice(6));
      }
      var lt = P.letterOf(row.fam, S.grade);
      el.style.color = lt ? GRADE_COLOR[lt] : "var(--text)";
    } else if (m[1] === "tier") {
      row.tier = el.value;
    } else {
      row.value = num(el.value, row.value);
    }
    return true;
  }

  function bind(pane) {
    pane.addEventListener("change", function (e) {
      var t = e.target, lk;
      if (handleRowEvent(t)) {
        P.save();
        lastVerdict = null;
        // A family pick grows or drops the tier and value boxes, so the row has
        // to be redrawn — but only the cut section, and only when a NUMBER is
        // not mid-edit.
        keepFocus(render);
        return;
      }
      if ((lk = t.getAttribute && t.getAttribute("data-avlock")) !== null && lk !== undefined && lk !== "") {
        var locks = cutLocks(lastSolve, grantedLines(), buildProfile()).slice();
        locks[Number(lk)] = !!t.checked;
        S.locks = locks; lastVerdict = null; P.save();
        render();
      }
    });

    pane.addEventListener("input", function (e) {
      if (/^av-n-val-\d+$/.test(e.target.id || "")) { handleRowEvent(e.target); P.save(); }
    });

    pane.addEventListener("click", function (e) {
      var t = e.target, ok;
      if (t.id === "av-check") { checkRoll(); return; }
      if (t.id === "av-apply-new") { applyVerdict(true); return; }
      if (t.id === "av-apply-keep") { applyVerdict(false); return; }
      if (t.id === "av-undo") { undo(); return; }
      if (t.id === "av-pick") { pickFile(); return; }
      if (t.id === "av-read") { readScreen(); return; }
      if ((ok = t.getAttribute && t.getAttribute("data-avok"))) { confirmed[ok] = 1; renderParsed(); return; }
      // A click anywhere on the zone with an image toggles the preview's size.
      var drop = $("av-drop");
      if (drop && drop.classList.contains("has-img") && drop.contains(t) && t.tagName !== "BUTTON") {
        drop.classList.toggle("av-min");
      }
    });

    // ---- intake: drag, drop, paste ----
    var drop = null;
    pane.addEventListener("dragover", function (e) {
      drop = $("av-drop");
      if (!drop || !drop.contains(e.target)) return;
      e.preventDefault();
      drop.classList.add("drag");
    });
    pane.addEventListener("dragleave", function (e) {
      drop = $("av-drop");
      if (drop && drop.contains(e.target)) drop.classList.remove("drag");
    });
    pane.addEventListener("drop", function (e) {
      drop = $("av-drop");
      if (!drop || !drop.contains(e.target)) return;
      e.preventDefault();
      drop.classList.remove("drag");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handOff(e.dataTransfer.files);
    });
    // Paste is a document event — it has no target inside the zone — so it is
    // taken only while this tab is the one on screen.
    document.addEventListener("paste", function (e) {
      if (!isActive()) return;
      if (capture && capture.onPaste) { try { capture.onPaste(e); } catch (err) { /* the reader's problem */ } return; }
      var items = e.clipboardData && e.clipboardData.items, files = [], i;
      if (!items) return;
      for (i = 0; i < items.length; i++) {
        if (items[i].kind === "file") { var f = items[i].getAsFile(); if (f) files.push(f); }
      }
      if (files.length) { e.preventDefault(); handOff(files); }
    });
  }

  var fileInput = null;
  function pickFile() {
    if (!fileInput) {
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.style.display = "none";
      fileInput.addEventListener("change", function () {
        if (fileInput.files && fileInput.files.length) handOff(fileInput.files);
        fileInput.value = "";
      });
      document.body.appendChild(fileInput);
    }
    fileInput.click();
  }

  function readScreen() {
    if (!capture || !capture.readScreen) {
      setStatus("Reading the screen is not wired up yet.", "err");
      return;
    }
    try { capture.readScreen(); }
    catch (e) { setStatus("Could not read the screen: " + ((e && e.message) || "unknown error"), "err"); }
  }

  // ------------------------------------------------------------------
  // the capture seam (see the header for the shapes)
  // ------------------------------------------------------------------

  /** A label for one parsed field, for the "what was read" strip. */
  function fieldReport(path, patch) {
    var m = /^rows\.(\d+)\.(fam|tier|value)$/.exec(path), i;
    if (m && patch.rows && patch.rows[Number(m[1])]) {
      i = Number(m[1]);
      var line = rowToLine(patch.rows[i], patch.grade || S.grade, junkReps()[i]);
      return { label: "Slot " + (i + 1), text: line ? lineLabel(line, patch.grade || S.grade) : "empty" };
    }
    if (path === "grade") return { label: "Grade", text: patch.grade === "relic" ? "Relic" : "Ancient" };
    if (path === "slots") return { label: "Slots", text: String(patch.slots) };
    if (path === "rollsLeft") return { label: "Rolls left", text: String(patch.rollsLeft) };
    if (path.indexOf("traits.") === 0) {
      var k = path.split(".")[1], t = patch.traits && patch.traits[k];
      return { label: P.TRAIT_LABELS[k] || k, text: t ? (t.on ? String(t.v) : "off") : "—" };
    }
    return { label: path, text: "read" };
  }

  /**
   * The one call advisor-capture.js makes. Everything it leaves out keeps its
   * current value, exactly as bible-import.js's patch does.
   */
  function applyParsed(parsed, conf) {
    if (!parsed) return { ok: false, error: "nothing to apply", unconfirmed: 0 };
    conf = conf || {};

    // Rolled set: the cut flow's own rows, not the bracelet you hold.
    if (parsed.target === "rolled") {
      if (!parsed.rows || !parsed.rows.length) return { ok: false, error: "no rows in the parse", unconfirmed: 0 };
      ensureRolled();
      var i;
      for (i = 0; i < S.slots && i < parsed.rows.length; i++) {
        if (parsed.rows[i]) S.rolled[i] = { fam: parsed.rows[i].fam || "none", tier: parsed.rows[i].tier || "mid", value: parsed.rows[i].value == null ? null : parsed.rows[i].value };
      }
      lastVerdict = null;
      P.save();
      render();                                  // the cut flow's pickers show what was read
    } else {
      var next = {}, keys = ["grade", "slots", "rollsLeft", "traits", "rows", "fixedRows"], k;
      for (k = 0; k < keys.length; k++) if (parsed[keys[k]] !== undefined) next[keys[k]] = parsed[keys[k]];
      next.rolled = null;                          // a new bracelet voids the cut in progress
      if (parsed.lockedIdx && parsed.lockedIdx.length && next.rows) {
        var lk = [], li;
        for (li = 0; li < next.rows.length; li++) lk.push(parsed.lockedIdx.indexOf(li) >= 0);
        next.locks = lk;
      } else {
        next.locks = null;
      }
      lastVerdict = null;
      lastSolve = null; lastKey = null;
      P.set(next);                                 // merges, persists, redraws, notifies
    }

    // The provenance strip: every field the reader reported, low-confidence ones
    // marked. A mark clears when the user says it reads right.
    var fields = [], path, low = 0;
    confirmed = {};
    for (path in conf) if (Object.prototype.hasOwnProperty.call(conf, path)) {
      var c = num(conf[path], 1), r = fieldReport(path, parsed);
      fields.push({ path: path, label: r.label, text: r.text, conf: c });
      if (c < LOW_CONF) low++;
    }
    fields.sort(function (a, b) { return a.conf - b.conf; });
    parsedReport = fields.length ? { fields: fields, from: parsed.from || null } : null;
    renderParsed();
    return { ok: true, unconfirmed: low };
  }

  window.BraceletAdvisor = {
    /** advisor-capture.js announces itself here. */
    registerCapture: function (api) {
      capture = api || null;
      renderIntake();
      return true;
    },
    /** The one call that hands a parsed bracelet over. See the file header. */
    applyParsed: applyParsed,
    setStatus: setStatus,
    setBusy: setBusy,
    setPreview: setPreview,
    /** How many parsed fields still want a human look. */
    unconfirmed: function () {
      if (!parsedReport) return 0;
      var n = 0, i;
      for (i = 0; i < parsedReport.fields.length; i++) {
        if (parsedReport.fields[i].conf < LOW_CONF && !confirmed[parsedReport.fields[i].path]) n++;
      }
      return n;
    },
    /** Force a re-solve and repaint — for anything that changed state directly. */
    refresh: function () { schedule(true); }
  };

  // ------------------------------------------------------------------
  // init
  // ------------------------------------------------------------------

  function isActive() {
    var p = $(PANE_ID);
    return !!(p && p.classList.contains("active"));
  }

  function init() {
    var pane = $(PANE_ID);
    if (!pane || pane.getAttribute("data-init")) return;
    pane.setAttribute("data-init", "1");
    injectStyle();
    pane.innerHTML =
      // Picker first, then the character board, then this tab's own work. Its OWN
      // host, above the deck host: the deck is one element that moves between tabs,
      // so nothing of ours may live inside it.
      '<div id="av-who"></div>' +
      '<div id="' + DECK_HOST + '"></div>' +
      '<div class="av-hdr" id="av-hdrctl"></div>' +
      '<div id="av-lead"></div>' +
      intakeMarkup() +
      // THE WORK AREA IS TWO COLUMNS on a wide screen: the bracelet editor on
      // the left, this tab's answers on the right, so editing a line and
      // watching the advice move happens without scrolling. One column again
      // under 1020px. #av-brhost holds app.js's #bc-braceletpanel — one LIVE
      // element that moves between tabs like the deck. Static shell, never
      // rewritten: render() only touches av-lead and av-body, so the panel
      // survives every repaint.
      '<div id="av-workgrid">' +
      '<div id="av-brhost"></div>' +
      '<div id="av-body"></div>' +
      '</div>';
    bind(pane);
    claimDeck();
    renderIntake();
    mountWho();
    render();
    P.onChange(onProfileChange);
    schedule(true);
  }

  /**
   * Profile said something moved. The deck has redrawn itself and persisted;
   * this is the Advisor catching up.
   */
  function onProfileChange(d) {
    d = d || {};
    if (d.reset || d.shape || d.set) { lastVerdict = null; lastSolve = null; lastKey = null; }
    if (!isActive()) { dirty = true; return; }
    render();
    schedule(!!(d.immediate || d.mode || d.shape || d.reset));
  }

  /**
   * The deck is one element that MOVES (profile.js's header). Claim it whenever
   * this tab is on screen; app.js claims it back for the Calculator.
   */
  function claimDeck() {
    var host = $(DECK_HOST);
    if (host) P.mount(host);
    // Full manual editing on this tab (Shizu, 2026-08-15): the Advisor is
    // self-contained, so the bracelet panel comes with the deck.
    var A = window.BraceletApp;
    if (A && A.mountBracelet) A.mountBracelet("av-brhost");
  }

  // Row edits do not go through Profile; app.js announces them instead. Only
  // the ACTIVE advisor reacts — on activation the tabselected handler below
  // re-solves anyway, so a parked tab stays quiet.
  document.addEventListener("braceletedited", function () {
    var pane = $(PANE_ID);
    if (!pane || !pane.classList.contains("active")) return;
    dropStaleVerdict();
    render();
    schedule(true);
  });

  document.addEventListener("tabselected", function (e) {
    if (!e || !e.detail || e.detail.tab !== "advisor") return;
    init();
    claimDeck();
    mountWho();
    dropStaleVerdict();
    render();
    // Always re-solve on activation, never only when `dirty`: the Calculator
    // edits the bracelet's rows without notifying Profile, so this tab cannot
    // know the bracelet moved. The shared LRU cache makes an unchanged bracelet
    // a cache hit, so the honest thing is also the cheap one.
    schedule(true);
  });

  init();
})();
