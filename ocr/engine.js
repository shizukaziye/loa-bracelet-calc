/**
 * ocr/engine.js — the screenshot-reader interface, the constraintSnap repair
 * pass, and a small engine registry.
 *
 * Ported from loa-astrogem-calc/ocr/engine.js. Runs as a browser <script> (reads
 * window.BraceletData, hangs its exports on the global) and as a Node require().
 *
 * ============================ CONTRACT ============================
 *
 * An engine is any object exposing:
 *
 *   async parseScreenshot(imageElOrBlobOrCanvas) -> ParseResult
 *   isAvailable() -> boolean
 *   name, label
 *
 * RAW parse (what an engine produces internally, before the snap):
 *
 *   {
 *     grade:     "relic" | "ancient" | null,
 *     slots:     1..3 | null,               // granted-slot count if the tooltip says
 *     rollsLeft: 0..7 | null,
 *     traits:  [ { family:"crit"|"spec"|"swiftness"|…, value:Number } ],
 *     lines:   [ { cat:"basic"|"special"|"trait",
 *                  family: "mainStat"|"vitality" | <special id 1..33> | <trait key>,
 *                  value:  Number | null,    // the number the tooltip printed
 *                  values: [A,B] | null,     // both numbers for an "A and B" family
 *                  tier:   "low"|"mid"|"high" | null,
 *                  locked: true|false|null,  // padlock; null = could not tell
 *                  fixed:  true|false } ],
 *     confidence: {                          // 0..1, straight from the IMAGE
 *       grade, slots, rollsLeft,
 *       traits: [ { family, value } ],
 *       lines:  [ { family, value, tier, locked } ]
 *     }
 *   }
 *
 * SNAPPED result (what the Advisor consumes) — `patch` is byte-for-byte the shape
 * bible-import.js#buildPatch already hands app.js, so the Advisor applies a
 * screenshot exactly the way it applies an imported character:
 *
 *   {
 *     patch: { grade, slots, traits:{crit:{on,v},spec:{…},swift:{…}}, traitOrder,
 *              rows:[{fam,tier,value}], fixedRows:[…], lockedIdx:[…], rollsLeft },
 *     confidence: { "<patch path>": 0..1 },   // flat, keyed by path — see PATHS
 *     unknown: ["<patch path>", …],           // fields the read could not settle
 *     notes:   ["plain-English account of every repair"],
 *   }
 *
 * PATHS used by the confidence map (the Advisor puts these in data-conf-key):
 *   "grade" · "slots" · "rollsLeft"
 *   "traits.crit" · "traits.spec" · "traits.swift"
 *   "rows.<i>.fam" · "rows.<i>.tier" · "rows.<i>.value" · "rows.<i>.locked"
 *   "fixedRows.<i>.fam" · "fixedRows.<i>.tier" · "fixedRows.<i>.value"
 *
 * ================== WHY THE SNAP MATTERS MORE HERE ==================
 *
 * The astrogem solver tolerates a silly state; ours does not. A bracelet with
 * four granted lines, or a duplicated family, or a special-effect value that
 * exists in no table, is not a bad answer — the solver refuses it outright. So
 * every field leaves this file legal or leaves it UNKNOWN. It never leaves as a
 * guess dressed up as a reading.
 *
 * ====================== CONFIDENCE, HONESTLY ========================
 *
 * Confidence must come from the image. A field the snap had to DEFAULT drops to
 * 0; a field the snap materially CHANGED drops to min(raw, 0.3). The snap never
 * raises a number. Nothing in this file infers confidence from values agreeing
 * with each other — a self-consistency check launders errors, it does not catch
 * them (astrogem's 241-frame corpus, the hard way).
 * =================================================================
 */
(function (root) {
  "use strict";

  var isNode = (typeof module !== "undefined" && module.exports);
  var DATA = isNode ? require("../data/bracelet-data.js") : root.BraceletData;

  // ------------------------------------------------------------------
  // constants read off the data tables (never re-typed here)
  // ------------------------------------------------------------------

  var GRADES = ["relic", "ancient"];
  var TIERS = DATA.TIERS;                                  // ["low","mid","high"]
  var SLOT_CHOICES = { relic: [1, 2], ancient: [2, 3] };
  var MAX_ROLLS = 7;                                       // 4 base + 3 ticket
  // The panel carries rows for three combat traits only; the other three exist
  // in game and have nowhere to go (bible-import.js hits the same wall).
  var TRAIT_APP = { crit: "crit", spec: "spec", swiftness: "swift" };
  var APP_TRAIT_KEYS = ["crit", "spec", "swift"];

  /** The full legal span of a combat-trait line, both ends inclusive. */
  function traitBand(grade) {
    var b = DATA.TRAITS.bands;
    return [b[0][grade][0], b[b.length - 1][grade][1]];
  }
  /** The full legal span of a basic line for one family. */
  function basicRange(grade, fam) {
    var b = DATA.BASIC.bands;
    return [b[0][grade][fam][0], b[b.length - 1][grade][fam][1]];
  }
  /** Which of the ten bands a trait value sits in (1-based), or 0 if outside. */
  function traitBandIndex(value, grade) {
    var b = DATA.TRAITS.bands;
    for (var i = 0; i < b.length; i++) {
      if (value >= b[i][grade][0] && value <= b[i][grade][1]) return i + 1;
    }
    return 0;
  }
  function basicBandIndex(value, grade, fam) {
    var b = DATA.BASIC.bands;
    for (var i = 0; i < b.length; i++) {
      if (value >= b[i][grade][fam][0] && value <= b[i][grade][fam][1]) return i + 1;
    }
    return 0;
  }

  function resolveSpecial(f) {
    if (f === null || f === undefined) return null;
    if (typeof f === "object") return f;
    return DATA.SPECIAL_BY_ID[f] || DATA.SPECIAL_BY_KEY[f] || null;
  }

  /**
   * The tier whose printed values match what was read, for one family and grade.
   * `exact` is the whole point: the game prints table values, so an exact hit is
   * strong evidence and anything else is a misread that must show as one.
   * Returns { tier, exact, dist } or null when the family has no table here.
   */
  function tierForValues(family, grade, values) {
    var fam = resolveSpecial(family);
    if (!fam || !fam.values[grade]) return null;
    if (!values || !values.length || values[0] == null) return null;
    // The read numbers are every number ON THE LINE, and a line carries literals
    // the table never mentions ("for 120s", "max 30 stacks"). So each table value
    // is matched to the nearest number not already spoken for, rather than to
    // whatever happens to sit at the same position.
    var best = null;
    for (var t = 0; t < TIERS.length; t++) {
      var tier = TIERS[t], table = fam.values[grade][tier];
      if (!table) continue;
      var taken = {}, d = 0, counted = 0;
      for (var i = 0; i < table.length; i++) {
        var bestD = Infinity, bestJ = -1;
        var scale = Math.max(Math.abs(table[i]), 1);
        for (var j = 0; j < values.length; j++) {
          if (taken[j] || values[j] == null) continue;
          var rd = Math.abs(values[j] - table[i]) / scale;
          if (rd < bestD) { bestD = rd; bestJ = j; }
        }
        if (bestJ < 0) continue;
        taken[bestJ] = 1;
        d += bestD;
        counted++;
      }
      if (!counted) continue;
      d /= counted;
      if (!best || d < best.dist) best = { tier: tier, dist: d, exact: d < 1e-9 };
    }
    return best;
  }

  /**
   * Which grade a set of read numbers PROVES, if any. The bands overlap in the
   * middle, so most readings prove nothing — and this says so rather than
   * guessing. The combat-trait cap is a fact about the item and outranks the
   * granted-slot count, which is only a guess about how the player has been
   * playing (docs/research/mechanics-bible-leaderboard.md, the 30-page sweep).
   */
  function gradeEvidence(traits, lines) {
    var i, l, ev = { grade: null, conf: 0, why: "" };
    function prove(g, why) {
      if (!ev.grade) { ev.grade = g; ev.conf = 0.9; ev.why = why; }
    }
    for (i = 0; i < (traits || []).length; i++) {
      var v = traits[i].value;
      if (v == null) continue;
      if (v > traitBand("relic")[1]) prove("ancient", "a combat trait above the Relic cap of 100");
      else if (v < traitBand("ancient")[0]) prove("relic", "a combat trait below the Ancient floor of 61");
    }
    for (i = 0; i < (lines || []).length; i++) {
      l = lines[i];
      if (l.cat === "basic" && l.value != null) {
        var rr = basicRange("relic", l.family), ar = basicRange("ancient", l.family);
        if (l.value > rr[1]) prove("ancient", "a basic line above every Relic band");
        else if (l.value < ar[0]) prove("relic", "a basic line below every Ancient band");
      } else if (l.cat === "special" && (l.values || l.value != null)) {
        var vals = l.values || [l.value];
        var r = tierForValues(l.family, "relic", vals);
        var a = tierForValues(l.family, "ancient", vals);
        if (r && a) {
          if (r.exact && !a.exact) prove("relic", "a special effect whose value only the Relic table carries");
          else if (a.exact && !r.exact) prove("ancient", "a special effect whose value only the Ancient table carries");
        }
      }
    }
    return ev;
  }

  // ------------------------------------------------------------------
  // small helpers
  // ------------------------------------------------------------------

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v) { var n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : null; }
  function nearlyEqual(a, b) { return a != null && b != null && Math.abs(a - b) < 1e-9; }

  /**
   * The one rule for every field: absent input means no confidence at all, a
   * value the snap had to change is worth little, and an untouched value keeps
   * whatever the image earned it.
   */
  function fieldConf(raw, present, changed) {
    if (!present) return 0;
    var c = (raw == null) ? 1 : clamp(raw, 0, 1);
    return changed ? Math.min(c, 0.3) : c;
  }

  // ------------------------------------------------------------------
  // the repair pass
  // ------------------------------------------------------------------

  var UNKNOWN_AT = 0.001;   // a confidence at or below this means "we do not know"

  function constraintSnap(parsed) {
    parsed = parsed || {};
    var cIn = parsed.confidence || {};
    var traitsIn = (parsed.traits || []).slice();
    var linesIn = (parsed.lines || []).slice();
    var tConfIn = cIn.traits || [];
    var lConfIn = cIn.lines || [];
    var notes = [];
    var conf = {};
    var unknown = [];
    var i, j;

    function set(path, value, isUnknown) {
      conf[path] = clamp(value, 0, 1);
      if (isUnknown || conf[path] <= UNKNOWN_AT) {
        if (unknown.indexOf(path) < 0) unknown.push(path);
      }
    }

    // ---- grade -------------------------------------------------------
    // The values win over the read word: a tooltip name colour is one channel
    // and a number outside a cap is a fact.
    var ev = gradeEvidence(traitsIn, linesIn);
    var grade = GRADES.indexOf(parsed.grade) >= 0 ? parsed.grade : null;
    var gradeChanged = false;
    if (ev.grade && grade && ev.grade !== grade) {
      notes.push("The grade read as " + grade + " but " + ev.why + " puts it at " + ev.grade + ".");
      grade = ev.grade;
      gradeChanged = true;
    } else if (!grade && ev.grade) {
      grade = ev.grade;
      notes.push("The grade was not read; " + ev.why + " settles it as " + ev.grade + ".");
    }
    var gradeKnown = !!grade;
    if (!grade) { grade = "ancient"; notes.push("The grade could not be read. Ancient is assumed — check it."); }
    set("grade", gradeChanged ? Math.min(cIn.grade == null ? 1 : cIn.grade, 0.3)
      : fieldConf(gradeKnown && ev.grade ? Math.max(cIn.grade == null ? 0 : cIn.grade, ev.conf) : cIn.grade,
        gradeKnown, false), !gradeKnown);

    // ---- combat traits ----------------------------------------------
    // Exactly two ride on a real bracelet, the panel shows three rows, and the
    // model has no row at all for Domination / Endurance / Expertise.
    var traits = { crit: { on: false, v: null }, spec: { on: false, v: null }, swift: { on: false, v: null } };
    var traitConf = { crit: 0, spec: 0, swift: 0 };
    var traitOrder = [];
    var band = traitBand(grade);
    var seenTrait = {};
    for (i = 0; i < traitsIn.length; i++) {
      var tr = traitsIn[i] || {};
      var key = TRAIT_APP[tr.family] || (APP_TRAIT_KEYS.indexOf(tr.family) >= 0 ? tr.family : null);
      var tc = (tConfIn[i] && tConfIn[i].value != null) ? tConfIn[i].value : null;
      if (!key) {
        if (tr.family) notes.push("The bracelet carries a " + tr.family +
          " trait line, which this panel has no row for — it was left out.");
        continue;
      }
      if (seenTrait[key]) {
        notes.push("Two " + key + " trait lines were read; the second was dropped.");
        continue;
      }
      if (traitOrder.length >= 2) {
        notes.push("A third combat trait (" + key + ") was read. A bracelet carries two, so it was dropped.");
        continue;
      }
      var v = num(tr.value);
      var changed = false;
      if (v == null) { traits[key] = { on: true, v: Math.round((band[0] + band[1]) / 2) }; traitConf[key] = 0; }
      else {
        var cv = clamp(Math.round(v), band[0], band[1]);
        if (cv !== Math.round(v)) {
          changed = true;
          notes.push("A " + key + " value of " + Math.round(v) + " is outside the " + grade +
            " range " + band[0] + "-" + band[1] + "; it was pulled to " + cv + ".");
        }
        traits[key] = { on: true, v: cv };
        traitConf[key] = fieldConf(tc, true, changed);
      }
      seenTrait[key] = true;
      traitOrder.push(key);
    }
    // Fewer than two read: keep the panel sane, exactly as bible-import does,
    // and flag what was invented.
    while (traitOrder.length < 2) {
      var fill = traitOrder.indexOf("crit") < 0 ? "crit" : (traitOrder.indexOf("spec") < 0 ? "spec" : "swift");
      traits[fill] = { on: true, v: traits[fill].v == null ? Math.round((band[0] + band[1]) / 2) : traits[fill].v };
      traitConf[fill] = 0;
      traitOrder.push(fill);
      notes.push("Only " + (traitOrder.length - 1) + " combat trait was read, so " + fill +
        " was switched on at a middling value — set it yourself.");
    }
    for (i = 0; i < APP_TRAIT_KEYS.length; i++) {
      var k = APP_TRAIT_KEYS[i];
      if (traits[k].v == null) traits[k] = { on: false, v: Math.round((band[0] + band[1]) / 2) };
      if (traits[k].on) set("traits." + k, traitConf[k], traitConf[k] <= UNKNOWN_AT);
    }

    // ---- lines: legality one at a time ------------------------------
    // Every line is repaired on its own first, then the set-level rules (no
    // duplicate family, category caps, slot count) run over what survived.
    var kept = [];
    for (i = 0; i < linesIn.length; i++) {
      var raw = linesIn[i] || {};
      var lc = lConfIn[i] || {};
      var line = { fam: null, tier: "mid", value: null, locked: null, fixed: !!raw.fixed,
        c: { fam: 0, tier: 0, value: 0, locked: 0 }, why: null };

      if (raw.cat === "basic") {
        var famB = (raw.family === "mainStat" || raw.family === "vitality") ? raw.family : null;
        if (!famB) { notes.push("A basic line named no family this model knows; it was dropped."); continue; }
        var rng = basicRange(grade, famB);
        var bv = num(raw.value);
        var bChanged = false;
        if (bv == null) {
          bv = Math.round(DATA.BASIC.bands[4][grade][famB][0]);
          notes.push("A " + famB + " line had no readable number; a middling one was put in its place.");
        } else if (bv < rng[0] || bv > rng[1]) {
          notes.push("A " + famB + " value of " + bv + " exists in no " + grade + " band (" +
            rng[0] + "-" + rng[1] + "); it was pulled into range.");
          bv = clamp(Math.round(bv), rng[0], rng[1]);
          bChanged = true;
        } else bv = Math.round(bv);
        line.fam = "basic:" + famB;
        line.value = bv;
        line.c.fam = fieldConf(lc.family, true, false);
        line.c.value = fieldConf(lc.value, num(raw.value) != null, bChanged);
        line.c.tier = 1;                                  // basics have no tier
      } else if (raw.cat === "trait") {
        // A trait among the granted lines is possible in principle; the panel
        // has no granted row for it, so say so instead of inventing a slot.
        notes.push("A combat-trait line turned up among the granted lines; this panel " +
          "keeps traits in their own rows, so it was left out.");
        continue;
      } else {
        var fam = resolveSpecial(raw.family);
        if (!fam) { notes.push("A special effect matched no family in the table; it was dropped."); continue; }
        if (!fam.values[grade]) {
          notes.push("Family " + fam.id + " has no " + grade + " table; the line was dropped.");
          continue;
        }
        var vals = raw.values || (raw.value != null ? [raw.value] : null);
        var hit = tierForValues(fam, grade, vals);
        var tier = null, tChanged = false;
        if (raw.tier && TIERS.indexOf(raw.tier) >= 0) tier = raw.tier;
        if (hit && hit.exact) {
          // the printed number is the strongest witness there is
          if (tier && tier !== hit.tier) {
            notes.push("The " + fam.label + " line read as " + tier + " tier, but its number is " +
              "exactly the " + hit.tier + " value; " + hit.tier + " was kept.");
            tChanged = true;
          }
          tier = hit.tier;
        } else if (hit && !tier) {
          tier = hit.tier;
          tChanged = true;                                // nearest, not read
          notes.push("The " + fam.label + " line's number matched no " + grade +
            " tier exactly; the nearest (" + hit.tier + ") was used — confirm it.");
        } else if (!tier) {
          tier = "mid";
          tChanged = true;
          notes.push("The " + fam.label + " line gave no tier and no usable number; mid was assumed.");
        }
        line.fam = "sp:" + fam.id;
        line.tier = tier;
        line.value = null;                                // specials carry no free value
        line.c.fam = fieldConf(lc.family, raw.family != null, false);
        line.c.tier = fieldConf(lc.tier != null ? lc.tier : lc.value,
          (raw.tier != null) || (vals && vals[0] != null), tChanged);
        line.c.value = 1;
      }

      line.locked = (raw.locked === true || raw.locked === false) ? raw.locked : null;
      line.c.locked = fieldConf(lc.locked, raw.locked === true || raw.locked === false, false);
      line.famKey = line.fam;
      kept.push(line);
    }

    // ---- no duplicate family ----------------------------------------
    // Two lines of one family is not a rare bracelet, it is a misread. The
    // better-read one stays; the other becomes an empty slot, and says so.
    var byFam = {};
    var deduped = [];
    for (i = 0; i < kept.length; i++) {
      var f = kept[i].famKey;
      if (byFam[f] === undefined) { byFam[f] = deduped.length; deduped.push(kept[i]); continue; }
      var prev = deduped[byFam[f]];
      var keepNew = (kept[i].c.fam > prev.c.fam);
      notes.push("Two lines read as the same effect (" + f + "); the weaker read was emptied.");
      if (keepNew) { deduped[byFam[f]] = kept[i]; deduped.push(blankLine()); }
      else deduped.push(blankLine());
    }
    function blankLine() {
      return { fam: null, tier: "mid", value: null, locked: null, fixed: false,
        c: { fam: 0, tier: 0, value: 0, locked: 0 } };
    }

    // ---- category caps ----------------------------------------------
    var counts = { basic: 0, trait: traitOrder.length, special: 0 };
    for (i = 0; i < deduped.length; i++) {
      var d = deduped[i];
      if (!d.fam) continue;
      var cat = d.fam.indexOf("basic:") === 0 ? "basic" : "special";
      counts[cat]++;
      if (counts[cat] > DATA.CAPS[cat]) {
        notes.push("More " + cat + " lines were read than a bracelet can carry (" +
          DATA.CAPS[cat] + "); the extra one was emptied.");
        deduped[i] = blankLine();
        counts[cat]--;
      }
    }

    // ---- fixed vs granted -------------------------------------------
    // A padlock is a LOCK the player set, not a fixed line from the drop (the
    // lesson bible-import learned: sorting locked lines into fixedRows left the
    // solver a half-filled bracelet, which it refuses). Only a line the parse
    // explicitly marked `fixed` — never a padlock — goes to fixedRows.
    var rows = [], fixedRows = [], lockedIdx = [];
    for (i = 0; i < deduped.length; i++) {
      var L = deduped[i];
      if (L.fixed) { fixedRows.push(L); continue; }
      rows.push(L);
    }
    if (fixedRows.length > 2) {
      notes.push("More than two fixed lines were read; the extra ones were dropped.");
      fixedRows.length = 2;
    }

    // ---- granted-slot count -----------------------------------------
    var choices = SLOT_CHOICES[grade];
    var slotsIn = parsed.slots != null ? parseInt(parsed.slots, 10) : null;
    var filled = 0;
    for (i = 0; i < rows.length; i++) if (rows[i].fam) filled++;
    var slots = slotsIn != null ? slotsIn : rows.length;
    var slotsChanged = false;
    if (choices.indexOf(slots) < 0) {
      var was = slots;
      slots = slots < choices[0] ? choices[0] : choices[choices.length - 1];
      slotsChanged = true;
      notes.push((grade === "relic" ? "Relic" : "Ancient") + " bracelets have " +
        choices.join(" or ") + " granted slots; " + was + " was read, so " + slots + " was used.");
    }
    while (rows.length > slots) {
      var lost = rows.pop();
      if (lost.fam) notes.push("One granted line past the " + slots +
        " this grade allows went unread — check the bracelet.");
    }
    while (rows.length < slots) rows.push(blankLine());
    for (i = 0; i < rows.length; i++) if (rows[i].locked === true) lockedIdx.push(i);

    // ---- rolls ------------------------------------------------------
    var rl = parsed.rollsLeft != null ? parseInt(parsed.rollsLeft, 10) : null;
    var rlChanged = false;
    if (rl != null && (rl < 0 || rl > MAX_ROLLS)) {
      notes.push("A roll count of " + rl + " is impossible (0-" + MAX_ROLLS + "); it was pulled into range.");
      rl = clamp(rl, 0, MAX_ROLLS);
      rlChanged = true;
    }
    set("rollsLeft", fieldConf(cIn.rollsLeft, rl != null, rlChanged), rl == null);

    // ---- assemble the patch -----------------------------------------
    function outRow(L) {
      return { fam: L.fam || "none", tier: L.tier || "mid", value: L.value };
    }
    var patch = {
      grade: grade,
      slots: slots,
      traits: {
        crit: { on: traits.crit.on, v: traits.crit.v },
        spec: { on: traits.spec.on, v: traits.spec.v },
        swift: { on: traits.swift.on, v: traits.swift.v }
      },
      traitOrder: traitOrder,
      rows: rows.map(outRow),
      fixedRows: fixedRows.map(outRow),
      lockedIdx: lockedIdx
    };
    if (rl != null) patch.rollsLeft = rl;

    set("slots", fieldConf(cIn.slots, slotsIn != null, slotsChanged), slotsIn == null);
    // A confidence key is only emitted for a field that EXISTS: an empty slot has
    // no tier and no padlock, and inventing a key for one would light up a
    // control the panel does not draw.
    function emitRow(R, p) {
      set(p + "fam", R.c.fam, !R.fam);
      if (!R.fam) return;
      if (R.fam.indexOf("sp:") === 0) set(p + "tier", R.c.tier, R.c.tier <= UNKNOWN_AT);
      if (R.fam.indexOf("basic:") === 0) set(p + "value", R.c.value, R.c.value <= UNKNOWN_AT);
      if (p.indexOf("rows.") === 0) set(p + "locked", R.c.locked, R.locked === null);
    }
    for (i = 0; i < rows.length; i++) emitRow(rows[i], "rows." + i + ".");
    for (i = 0; i < fixedRows.length; i++) emitRow(fixedRows[i], "fixedRows." + i + ".");

    return { patch: patch, confidence: conf, unknown: unknown, notes: notes };
  }

  /**
   * Is this patch something the solver will accept? The snap guarantees it, so a
   * false here is a bug in the snap, not a bad screenshot — the self-test leans
   * on that.
   */
  function isLegalPatch(patch) {
    var why = [];
    if (GRADES.indexOf(patch.grade) < 0) why.push("grade " + patch.grade);
    if (SLOT_CHOICES[patch.grade] && SLOT_CHOICES[patch.grade].indexOf(patch.slots) < 0) {
      why.push(patch.slots + " granted slots on " + patch.grade);
    }
    if (patch.rows.length !== patch.slots) why.push("row count " + patch.rows.length + " != slots " + patch.slots);
    var on = 0, i, seen = {}, cats = { basic: 0, trait: 0, special: 0 };
    for (i = 0; i < APP_TRAIT_KEYS.length; i++) {
      var t = patch.traits[APP_TRAIT_KEYS[i]];
      if (!t.on) continue;
      on++;
      cats.trait++;
      var bandT = traitBand(patch.grade);
      if (!(t.v >= bandT[0] && t.v <= bandT[1])) why.push(APP_TRAIT_KEYS[i] + " value " + t.v + " outside " + bandT.join("-"));
    }
    if (on !== 2) why.push(on + " combat traits switched on");
    var all = patch.rows.concat(patch.fixedRows);
    for (i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r.fam || r.fam === "none") continue;
      if (seen[r.fam]) why.push("duplicate family " + r.fam);
      seen[r.fam] = 1;
      if (r.fam.indexOf("basic:") === 0) {
        cats.basic++;
        var famB = r.fam.slice(6);
        if (famB !== "mainStat" && famB !== "vitality") { why.push("unknown basic " + famB); continue; }
        var rg = basicRange(patch.grade, famB);
        if (!(r.value >= rg[0] && r.value <= rg[1])) why.push(famB + " value " + r.value + " outside " + rg.join("-"));
      } else if (r.fam.indexOf("sp:") === 0) {
        cats.special++;
        var fam = resolveSpecial(Number(r.fam.slice(3)));
        if (!fam) { why.push("unknown special " + r.fam); continue; }
        if (!fam.values[patch.grade] || !fam.values[patch.grade][r.tier]) {
          why.push("family " + fam.id + " has no " + patch.grade + " " + r.tier + " tier");
        }
      } else why.push("unparseable family " + r.fam);
    }
    if (cats.basic > DATA.CAPS.basic) why.push(cats.basic + " basic lines");
    if (cats.special > DATA.CAPS.special) why.push(cats.special + " special lines");
    if (patch.rollsLeft != null && (patch.rollsLeft < 0 || patch.rollsLeft > MAX_ROLLS)) {
      why.push("rollsLeft " + patch.rollsLeft);
    }
    return { legal: why.length === 0, why: why };
  }

  // ------------------------------------------------------------------
  // registry
  // ------------------------------------------------------------------

  var _registry = {};
  function registerEngine(e) { if (e && e.name) _registry[e.name] = e; return e; }
  function getEngine(n) { return _registry[n] || null; }
  function listEngines() { return Object.keys(_registry).map(function (k) { return _registry[k]; }); }

  function BaseEngine() {}
  BaseEngine.prototype.name = "base";
  BaseEngine.prototype.label = "Base (unimplemented)";
  BaseEngine.prototype.isAvailable = function () { return false; };
  BaseEngine.prototype.parseScreenshot = function () {
    return Promise.reject(new Error("BaseEngine.parseScreenshot is abstract."));
  };
  BaseEngine.prototype.constraintSnap = function (p) { return constraintSnap(p); };

  var API = {
    constraintSnap: constraintSnap,
    isLegalPatch: isLegalPatch,
    gradeEvidence: gradeEvidence,
    tierForValues: tierForValues,
    traitBand: traitBand,
    basicRange: basicRange,
    traitBandIndex: traitBandIndex,
    basicBandIndex: basicBandIndex,
    resolveSpecial: resolveSpecial,
    SLOT_CHOICES: SLOT_CHOICES,
    TRAIT_APP: TRAIT_APP,
    APP_TRAIT_KEYS: APP_TRAIT_KEYS,
    MAX_ROLLS: MAX_ROLLS,
    BaseEngine: BaseEngine,
    registerEngine: registerEngine,
    getEngine: getEngine,
    listEngines: listEngines
  };

  if (isNode) module.exports = API;
  else {
    root.BraceletOcr = API;
    root.bcRegisterEngine = registerEngine;
    root.bcGetEngine = getEngine;
    root.bcListEngines = listEngines;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
