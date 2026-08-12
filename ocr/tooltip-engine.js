/**
 * ocr/tooltip-engine.js — THE bracelet reader.
 *
 * Reads the in-game bracelet tooltip in the order the astrogem parser proved
 * works, and for the same reason: structure and colour are strong channels and
 * text is a weak one, so the strong ones go first and text is only asked about
 * the strips the structure has already isolated.
 *
 *   1. find the tooltip panel          (dark flat rectangle over a busy scene)
 *   2. cut it into rows of ink         (row profile against the panel's own bg)
 *   3. group rows into entries         (a wrapped line indents; a new one does not)
 *   4. take each entry's colour        (rarity colour of the name, roll-band hue)
 *   5. look for a padlock in the gutter
 *   6. binarise the strip and read it  (Tesseract, one line at a time)
 *   7. name the family by weighted words AND by the number the line printed
 *   8. constraintSnap                  (legal or unknown — never a guess)
 *
 * ------------------------------- CONFIDENCE -------------------------------
 * Every number this file emits traces back to the pixels: how solidly the panel
 * was found, how far the winning family beat the runner-up, what Tesseract said
 * about its own worst word, how clean the colour was. Nothing here raises
 * confidence because the answers agree with one another. Two INDEPENDENT reads
 * of the same field (the words and the printed number) agreeing is worth a
 * bounded lift; every other flavour of agreement is a checksum, and a checksum
 * launders errors — astrogem's 241-frame corpus paid for that lesson.
 *
 * The colour channel is judged on the image before it is allowed to matter: the
 * engine measures how often colour and number agree ACROSS the whole tooltip,
 * and only lets a colour disagreement pull a field down when the channel is
 * evidently working on that screenshot. A wrong palette therefore costs nothing
 * but a missed opportunity, instead of flagging every correct read.
 *
 * ------------------------------ WHAT IS FIXED ------------------------------
 * The tooltip does not say which lines came with the drop and which were rolled.
 * This engine uses the rule the rest of the repo already uses: the combat traits
 * are the fixed lines, everything else is a granted line (bible-import.js learnt
 * the hard way that sorting locked lines into fixedRows leaves the solver a
 * half-filled bracelet, which it refuses).
 */
(function (root) {
  "use strict";

  var isNode = (typeof module !== "undefined" && module.exports);
  var OCR = isNode ? require("./engine.js") : root.BraceletOcr;
  var L = isNode ? require("./layout.js") : root.BraceletLayout;
  var LEX = isNode ? require("./lexicon.js") : root.BraceletLexicon;
  var TR = isNode ? require("./text-reader.js") : root.BraceletTextReader;

  var GRADES = ["relic", "ancient"];

  // ------------------------------------------------------------------
  // getting pixels out of whatever the page handed us
  // ------------------------------------------------------------------

  function rasterFromCanvas(cv) {
    var ctx = cv.getContext("2d");
    var d = ctx.getImageData(0, 0, cv.width, cv.height);
    return { width: d.width, height: d.height, data: d.data };
  }

  function newCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    if (typeof document !== "undefined") {
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      return c;
    }
    return null;
  }

  /** Image element / canvas / Blob / ImageBitmap / ImageData / raw raster -> raster. */
  function toRaster(input) {
    if (!input) return Promise.reject(new Error("Nothing to read."));
    if (input.data && input.width && input.height) {                 // ImageData or raster
      return Promise.resolve({ width: input.width, height: input.height, data: input.data });
    }
    if (typeof HTMLCanvasElement !== "undefined" && input instanceof HTMLCanvasElement) {
      return Promise.resolve(rasterFromCanvas(input));
    }
    if (typeof OffscreenCanvas !== "undefined" && input instanceof OffscreenCanvas) {
      return Promise.resolve(rasterFromCanvas(input));
    }
    if (typeof HTMLImageElement !== "undefined" && input instanceof HTMLImageElement) {
      var c = newCanvas(input.naturalWidth || input.width, input.naturalHeight || input.height);
      c.getContext("2d").drawImage(input, 0, 0);
      return Promise.resolve(rasterFromCanvas(c));
    }
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(input).then(function (bm) {
        var c2 = newCanvas(bm.width, bm.height);
        c2.getContext("2d").drawImage(bm, 0, 0);
        try { bm.close(); } catch (e) {}
        return rasterFromCanvas(c2);
      });
    }
    return Promise.reject(new Error("Unsupported image input."));
  }

  // ------------------------------------------------------------------
  // naming one line
  // ------------------------------------------------------------------

  var TRAIT_UNION = [41, 120];        // Relic floor to Ancient cap

  /** Is this number a believable value for that candidate? Two channels, met. */
  function numericFit(cand, numbers) {
    if (!numbers.length) return { fit: "none", bonus: 0, tier: null, grade: null, exact: false };
    var v = numbers[0];
    if (cand.kind === "trait") {
      var ok = Number.isInteger ? Number.isInteger(v) : (v === Math.round(v));
      if (ok && v >= TRAIT_UNION[0] && v <= TRAIT_UNION[1]) {
        return { fit: "band", bonus: 0.6, tier: null,
          grade: v > 100 ? "ancient" : (v < 61 ? "relic" : null), exact: false };
      }
      return { fit: "bad", bonus: -0.75, tier: null, grade: null, exact: false };
    }
    if (cand.kind === "basic") {
      for (var g = 0; g < GRADES.length; g++) {
        var rg = OCR.basicRange(GRADES[g], cand.family);
        if (v >= rg[0] && v <= rg[1]) return { fit: "band", bonus: 0.6, tier: null, grade: null, exact: false };
      }
      return { fit: "bad", bonus: -0.75, tier: null, grade: null, exact: false };
    }
    // special: the strongest witness in the whole parser — the game prints table
    // values exactly, so an exact hit all but names the line.
    var best = null;
    for (var gi = 0; gi < GRADES.length; gi++) {
      var hit = OCR.tierForValues(cand.family, GRADES[gi], numbers);
      if (!hit) continue;
      if (!best || hit.dist < best.dist) best = { tier: hit.tier, dist: hit.dist, grade: GRADES[gi], exact: hit.exact };
    }
    if (!best) return { fit: "none", bonus: 0, tier: null, grade: null, exact: false, count: 0 };
    // How MANY numbers the line printed is its own reading, and it is the only
    // thing separating families whose words and first value are identical
    // ("Crit Damage +8.4%" against "Crit Damage +8.4%; on crit, damage +1.5%").
    var want = LEX.numberCount(cand.family), countBonus = 0;
    if (want != null) {
      var diff = Math.abs(numbers.length - want);
      countBonus = diff === 0 ? 0.3 : -Math.min(0.5, 0.25 * diff);
    }
    if (best.exact) return { fit: "exact", bonus: 1.0 + countBonus, tier: best.tier, grade: best.grade, exact: true, count: countBonus };
    if (best.dist < 0.06) return { fit: "near", bonus: 0.25 + countBonus, tier: best.tier, grade: best.grade, exact: false, count: countBonus };
    return { fit: "bad", bonus: -0.6, tier: best.tier, grade: null, exact: false, count: countBonus };
  }

  /**
   * Which family this entry is, from its words and its number together.
   * Returns null when nothing plausible turned up — an entry with no family is
   * not an effect line (an item level, a bind notice, a flavour string).
   */
  function nameEntry(text, numbers) {
    var cands = LEX.matchFamily(text);
    if (!cands.length) return null;
    var scored = [];
    for (var i = 0; i < Math.min(cands.length, 8); i++) {
      var c = cands[i];
      var nf = numericFit(c, numbers);
      // raw = how much telling vocabulary the line shares with the family;
      // score = how much of the family's own wording the line covers. The second
      // is what tells a short exact name from a long one that merely contains it.
      var rank = c.raw * (1 + nf.bonus) * (0.6 + 0.4 * c.score);
      scored.push({ cand: c, num: nf, rank: rank });
    }
    scored.sort(function (a, b) { return b.rank - a.rank; });
    var top = scored[0];
    if (top.rank <= 0) return null;
    var second = scored[1] ? scored[1].rank : 0;
    var margin = (top.rank - second) / Math.max(top.rank, 1e-9);
    return { kind: top.cand.kind, family: top.cand.family, key: top.cand.key,
      score: top.cand.score, margin: margin, num: top.num, label: top.cand.label,
      runnerUp: scored[1] ? scored[1].cand.key : null };
  }

  // ------------------------------------------------------------------
  // confidence, built from the image
  // ------------------------------------------------------------------

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function familyConfidence(named, textConf, panelScale) {
    var wordPart = 0.30 + 0.45 * Math.min(1, named.score / 0.65) + 0.25 * Math.min(1, named.margin / 0.30);
    var conf = wordPart * (0.55 + 0.45 * clamp01(textConf));
    // the number is a second, independent read of the same line
    if (named.num.fit === "exact" && conf >= 0.5 && textConf >= 0.5) conf = Math.min(0.95, conf + 0.08);
    if (named.num.fit === "bad") conf = Math.min(conf, 0.35);
    return clamp01(conf * panelScale);
  }

  // ------------------------------------------------------------------
  // the parse
  // ------------------------------------------------------------------

  var DIGITS = "0123456789.,+-%";

  function parseRaster(raster, opts) {
    opts = opts || {};
    var reader = opts.reader || TR.getReader();
    var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    var debug = { entries: [] };

    var panel = L.findPanel(raster, opts.panel);
    debug.panel = panel;
    var panelScale = 0.6 + 0.4 * clamp01(panel.conf);
    var bg = panel.bgLuma;

    // A small inset keeps the tooltip's own border out of the row profile.
    var inset = Math.max(2, Math.round(Math.min(panel.w, panel.h) * 0.012));
    var body = { x: panel.x + inset, y: panel.y + inset, w: panel.w - 2 * inset, h: panel.h - 2 * inset };
    var prof = L.inkProfile(raster, body, bg, opts.ink);
    var rows = L.segmentRows(prof, opts.rows);
    var grouped = L.groupEntries(rows, opts.group);
    var entries = grouped.entries || [];
    debug.rowCount = rows.length;
    debug.entryCount = entries.length;
    debug.margin = grouped.margin;
    debug.rowHeight = grouped.rowHeight;

    if (!entries.length) {
      return Promise.resolve({
        raw: { grade: null, slots: null, rollsLeft: null, traits: [], lines: [],
          confidence: { grade: 0, slots: 0, rollsLeft: 0, traits: [], lines: [] } },
        debug: debug,
        status: "No text was found in the screenshot. Is the bracelet tooltip on screen?"
      });
    }

    // ---- structure and colour first, for every entry -----------------
    // The gutter and the right edge are properties of the TOOLTIP, not of one
    // line, so they are measured once over all the rows.
    var rightEdge = 0;
    for (var re = 0; re < entries.length; re++) rightEdge = Math.max(rightEdge, entries[re].x1);
    var lockOpts = { margin: grouped.margin, rightEdge: rightEdge, rowHeight: grouped.rowHeight,
      panelX0: body.x, panelX1: body.x + body.w - 1 };
    if (opts.lock) for (var lk in opts.lock) if (opts.lock.hasOwnProperty(lk)) lockOpts[lk] = opts.lock[lk];

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      // Colour is taken from the TEXT, so the strip starts at the common margin:
      // a padlock left of it is an icon, not a letter, and must not tint the read.
      e.color = L.entryColor(raster, { x0: Math.max(e.x0, grouped.margin), x1: e.x1, y0: e.y0, y1: e.y1 }, bg, opts.color);
      e.lock = L.lockGutter(raster, e, bg, lockOpts);
      if (opts.lockBothSides) {
        var rOpts = {}; for (var rk in lockOpts) if (lockOpts.hasOwnProperty(rk)) rOpts[rk] = lockOpts[rk];
        rOpts.side = "right";
        var right = L.lockGutter(raster, e, bg, rOpts);
        if (right.locked === true && e.lock.locked !== true) e.lock = right;
        else if (right.locked === true && e.lock.locked === true) e.lock = { locked: true, conf: Math.max(e.lock.conf, right.conf) };
      }
    }

    // ---- then, and only then, the text -------------------------------
    var jobs = entries.map(function (e) {
      // the ROW height sets the upscale, not the entry's (a wrapped entry is two
      // rows tall and would be scaled half as much as a single-row one)
      var stripBox = { x0: e.x0, x1: e.x1, y0: e.y0, y1: e.y1, h: e.h, rowHeight: grouped.rowHeight };
      var strip = L.textStrip(raster, stripBox, bg, opts.strip);
      // The box travels with the strip: the real reader ignores it, and a test
      // reader uses it to answer as OCR would for that exact region.
      return reader.read(strip, { psm: "7", box: { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 } }).then(function (r) {
        e.text = r.text || "";
        e.textConf = r.conf || 0;
        e.readError = r.error || null;
        return e;
      });
    });

    return Promise.all(jobs).then(function () {
      var raw = { grade: null, slots: null, rollsLeft: null, traits: [], lines: [],
        confidence: { grade: 0, slots: 0, rollsLeft: 0, traits: [], lines: [] } };
      var notes = [];
      var allText = entries.map(function (e) { return e.text; }).join(" \n ");

      // ---- grade: the item-name colour and the word, two channels ----
      var gradeByColor = null, gradeColorConf = 0;
      for (var gi = 0; gi < Math.min(3, entries.length); gi++) {
        var cl = entries[gi].color.cls;
        if ((cl.name === "ancient" || cl.name === "relic") && cl.margin > 0.05) {
          gradeByColor = cl.name;
          gradeColorConf = clamp01(0.35 + 1.6 * cl.margin) * panelScale;
          break;
        }
      }
      var gradeByWord = /\bancient\b/i.test(allText) ? "ancient" : (/\brelic\b/i.test(allText) ? "relic" : null);
      if (gradeByColor && gradeByWord && gradeByColor === gradeByWord) {
        raw.grade = gradeByColor;
        raw.confidence.grade = Math.min(0.95, gradeColorConf + 0.1);
      } else if (gradeByColor && gradeByWord && gradeByColor !== gradeByWord) {
        raw.grade = gradeByWord;                  // the word is the plainer read
        raw.confidence.grade = 0.3;
        notes.push("The item name's colour and its text disagree about the grade.");
      } else if (gradeByWord) {
        raw.grade = gradeByWord; raw.confidence.grade = 0.7;
      } else if (gradeByColor) {
        raw.grade = gradeByColor; raw.confidence.grade = gradeColorConf;
      }

      // ---- rolls -----------------------------------------------------
      var rolls = LEX.readRolls(allText);
      if (rolls != null) {
        raw.rollsLeft = rolls;
        var rollEntry = null;
        for (var ri = 0; ri < entries.length; ri++) {
          if (/roll|reroll|attempt|change/i.test(entries[ri].text)) { rollEntry = entries[ri]; break; }
        }
        raw.confidence.rollsLeft = clamp01((rollEntry ? rollEntry.textConf : 0.3) * panelScale);
      }

      // ---- lines -----------------------------------------------------
      var colourAgree = 0, colourSeen = 0;
      var staged = [];
      for (var k = 0; k < entries.length; k++) {
        var en = entries[k];
        var nums = LEX.readNumbers(en.text);
        var named = nameEntry(en.text, nums);
        debug.entries.push({ text: en.text, textConf: en.textConf, numbers: nums,
          color: en.color.cls, lock: en.lock, box: { x0: en.x0, y0: en.y0, x1: en.x1, y1: en.y1 },
          named: named ? { kind: named.kind, key: named.key, score: named.score,
            margin: named.margin, fit: named.num.fit } : null });
        if (!named) continue;
        if (named.kind === "trait" && named.num.fit === "bad") continue;   // "Crit" in prose
        if (named.score < (opts.minScore != null ? opts.minScore : 0.12)) continue;

        // colour-vs-number agreement, measured before it is allowed to matter
        var expected = null;
        if (named.kind === "special" && named.num.tier) expected = LEX.tierColor(named.num.tier);
        else if (named.kind === "trait" && nums.length) {
          var gForBand = raw.grade || (nums[0] > 100 ? "ancient" : "relic");
          expected = LEX.bandColor(OCR.traitBandIndex(nums[0], gForBand));
        } else if (named.kind === "basic" && nums.length) {
          var gForBand2 = raw.grade || "ancient";
          expected = LEX.bandColor(OCR.basicBandIndex(nums[0], gForBand2, named.family));
        }
        var colourStrong = en.color.cls.margin > 0.12 && en.color.cls.sat > 0.18;
        if (expected && colourStrong) {
          colourSeen++;
          if (en.color.cls.name === expected) colourAgree++;
        }
        staged.push({ en: en, named: named, nums: nums, expected: expected, colourStrong: colourStrong });
      }

      // Does the colour channel work on THIS screenshot? If it plainly does not,
      // it is ignored rather than allowed to flag every correct read. This is a
      // judgement about a channel, not about the answers.
      var colourUsable = colourSeen >= 3 && (colourAgree / colourSeen) >= 0.5;
      debug.colour = { seen: colourSeen, agree: colourAgree, usable: colourUsable };

      for (var s = 0; s < staged.length; s++) {
        var st = staged[s], nmd = st.named, e2 = st.en;
        var famConf = familyConfidence(nmd, e2.textConf, panelScale);
        var digitConf = e2.textConf;                       // the reader's worst word
        if (nmd.kind === "trait") {
          raw.traits.push({ family: nmd.family, value: st.nums.length ? Math.round(st.nums[0]) : null });
          raw.confidence.traits.push({ family: famConf,
            value: clamp01(digitConf * panelScale * (st.nums.length ? 1 : 0)) });
          continue;
        }
        var line = { cat: nmd.kind, family: nmd.family, value: null, values: null,
          tier: null, locked: e2.lock.locked, fixed: false };
        var lconf = { family: famConf, value: 0, tier: 0, locked: clamp01(e2.lock.conf * panelScale) };

        if (nmd.kind === "basic") {
          line.value = st.nums.length ? Math.round(st.nums[0]) : null;
          lconf.value = clamp01(digitConf * panelScale * (st.nums.length ? 1 : 0));
        } else {
          line.values = st.nums.length ? st.nums.slice(0, 2) : null;
          line.tier = nmd.num.tier;
          var tierBase = nmd.num.fit === "exact" ? Math.min(0.9, digitConf)
            : (nmd.num.fit === "near" ? Math.min(0.45, digitConf * 0.5) : 0);
          if (colourUsable && st.expected && st.colourStrong) {
            if (e2.color.cls.name === st.expected) {
              if (tierBase >= 0.5) tierBase = Math.min(0.95, tierBase + 0.06);
            } else {
              tierBase = Math.min(tierBase, 0.4);
            }
          }
          lconf.tier = clamp01(tierBase * panelScale);
        }
        raw.lines.push(line);
        raw.confidence.lines.push(lconf);
      }

      // The tooltip does not label a line granted or fixed; the traits are the
      // fixed pair and everything else is a granted slot (see the file header).
      raw.slots = raw.lines.length || null;
      raw.confidence.slots = raw.slots ? clamp01(0.55 * panelScale) : 0;

      if (!reader.isAvailable || !reader.isAvailable()) {
        notes.push("No text reader was available, so nothing was read from words.");
      }
      var ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      debug.ms = Math.round(ms);
      return { raw: raw, debug: debug, notes: notes };
    });
  }

  // ------------------------------------------------------------------
  // the engine object
  // ------------------------------------------------------------------

  function TooltipEngine() {}
  TooltipEngine.prototype = Object.create(OCR.BaseEngine.prototype);
  TooltipEngine.prototype.constructor = TooltipEngine;
  TooltipEngine.prototype.name = "tooltip";
  TooltipEngine.prototype.label = "Tooltip reader";
  TooltipEngine.prototype.isAvailable = function () { return true; };
  TooltipEngine.prototype.parseScreenshot = function (input, opts) {
    var self = this;
    return toRaster(input).then(function (ras) {
      return parseRaster(ras, opts).then(function (out) {
        var snapped = OCR.constraintSnap(out.raw);
        snapped.notes = (out.notes || []).concat(snapped.notes);
        snapped.debug = out.debug;
        snapped.engine = self.name;
        snapped.ms = out.debug.ms;
        if (out.status) snapped.status = out.status;
        return snapped;
      });
    });
  };

  var engine = new TooltipEngine();
  OCR.registerEngine(engine);

  var API = { engine: engine, parseRaster: parseRaster, toRaster: toRaster, nameEntry: nameEntry };
  if (isNode) module.exports = API;
  else root.BraceletTooltipEngine = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
