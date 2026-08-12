/**
 * ocr/fixture.js — a synthetic bracelet tooltip, drawn from the real tables.
 *
 * WHY THIS EXISTS, AND WHAT IT DOES NOT PROVE
 *
 * There were no real bracelet screenshots when this parser was written. A
 * fixture cannot fix that. What it CAN do is exercise every stage that does not
 * depend on the game's exact pixels: find the panel in a busy frame, cut it into
 * rows, group wrapped rows into entries, take each entry's colour, spot a
 * padlock in the gutter, hand strips to the reader, name the family from words
 * and numbers, and prove that constraintSnap turns the result into a state the
 * solver will accept.
 *
 * What it does NOT prove: that the thresholds match Lost Ark's real tooltip,
 * that the palette is the game's palette, that a padlock looks like this, or
 * that Tesseract can read the game's font at the size it renders. Those wait on
 * a real screenshot. See ocr/README.md, "What is proven".
 *
 * The text is drawn with a 5x7 bitmap font bundled below — letters use one
 * uppercase shape apiece, so the ink is realistically shaped and spaced without
 * pretending to be the game's typeface.
 */
(function (root) {
  "use strict";

  var isNode = (typeof module !== "undefined" && module.exports);
  var DATA = isNode ? require("../data/bracelet-data.js") : root.BraceletData;
  var L = isNode ? require("./layout.js") : root.BraceletLayout;

  // ------------------------------------------------------------------
  // a 5x7 bitmap font
  // ------------------------------------------------------------------

  var FONT = {
    "A": "01110100011000111111100011000110001",
    "B": "11110100011111010001100011000111110",
    "C": "01110100011000010000100001000101110",
    "D": "11110100011000110001100011000111110",
    "E": "11111100001111010000100001000011111",
    "F": "11111100001111010000100001000010000",
    "G": "01110100011000010111100011000101111",
    "H": "10001100011111110001100011000110001",
    "I": "01110001000010000100001000010001110",
    "J": "00111000100001000010000110010011100",
    "K": "10001100101010011000101001001010001",
    "L": "10000100001000010000100001000011111",
    "M": "10001110111010110101100011000110001",
    "N": "10001110011010110011100011000110001",
    "O": "01110100011000110001100011000101110",
    "P": "11110100011000111110100001000010000",
    "Q": "01110100011000110001101011001001101",
    "R": "11110100011000111110101001001010001",
    "S": "01111100001000001110000010000111110",
    "T": "11111001000010000100001000010000100",
    "U": "10001100011000110001100011000101110",
    "V": "10001100011000110001100010101000100",
    "W": "10001100011000110101101011101110001",
    "X": "10001010100010000100001000101010001",
    "Y": "10001010100010000100001000010000100",
    "Z": "11111000010001000100010001000011111",
    "0": "01110100011001110101110011000101110",
    "1": "00100011000010000100001000010001110",
    "2": "01110100010000100010001000100011111",
    "3": "11111000100010000010000011000101110",
    "4": "00010001100101010010111110001000010",
    "5": "11111100001111000001000011000101110",
    "6": "00110010001000011110100011000101110",
    "7": "11111000010001000100010000100001000",
    "8": "01110100011000101110100011000101110",
    "9": "01110100011000101111000010001001100",
    "+": "00000001000010011111001000010000000",
    "-": "00000000000000011111000000000000000",
    "%": "11001110100001000100010000101110011",
    ".": "00000000000000000000000001100011000",
    ",": "00000000000000000000011000110001000",
    ":": "00000011000110000000011000110000000",
    ";": "00000011000110000000011000110001000",
    "/": "00001000100001000100010000100010000",
    "(": "00010001000100001000010000010000010",
    ")": "01000001000001000010000100010001000",
    "&": "01100100101010001000101011001001101",
    "'": "00100001000010000000000000000000000",
    "!": "00100001000010000100000000010000100",
    "?": "01110100010000100010001000000000100",
    "=": "00000000001111100000111110000000000",
    " ": "00000000000000000000000000000000000"
  };
  var GW = 5, GH = 7;

  function glyph(ch) {
    var c = String(ch).toUpperCase();
    return FONT[c] || FONT["?"];
  }

  function textWidth(s, scale, tracking) {
    return s.length * (GW * scale + tracking) - tracking;
  }

  function drawText(ras, s, x, y, scale, rgb, tracking) {
    tracking = tracking == null ? scale : tracking;
    var cx = x;
    for (var i = 0; i < s.length; i++) {
      var g = glyph(s[i]);
      for (var gy = 0; gy < GH; gy++) {
        for (var gx = 0; gx < GW; gx++) {
          if (g[gy * GW + gx] !== "1") continue;
          fillRect(ras, cx + gx * scale, y + gy * scale, scale, scale, rgb);
        }
      }
      cx += GW * scale + tracking;
    }
    return cx;
  }

  function fillRect(ras, x, y, w, h, rgb) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    for (var yy = y; yy < y + h; yy++) {
      if (yy < 0 || yy >= ras.height) continue;
      for (var xx = x; xx < x + w; xx++) {
        if (xx < 0 || xx >= ras.width) continue;
        var i = (yy * ras.width + xx) * 4;
        ras.data[i] = rgb[0]; ras.data[i + 1] = rgb[1]; ras.data[i + 2] = rgb[2]; ras.data[i + 3] = 255;
      }
    }
  }

  function strokeRect(ras, x, y, w, h, rgb, t) {
    fillRect(ras, x, y, w, t, rgb);
    fillRect(ras, x, y + h - t, w, t, rgb);
    fillRect(ras, x, y, t, h, rgb);
    fillRect(ras, x + w - t, y, t, h, rgb);
  }

  // ------------------------------------------------------------------
  // a deterministic pseudo-random source, so a failure can be reproduced
  // ------------------------------------------------------------------

  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // ------------------------------------------------------------------
  // turning a family into the line the game would print
  // ------------------------------------------------------------------

  var COLORS = {
    grade: { relic: [250, 93, 0], ancient: [220, 201, 153] },
    tier: { low: [0, 176, 250], mid: [206, 67, 252], high: [249, 146, 0] },
    band: { green: [106, 191, 75], blue: [0, 176, 250], purple: [206, 67, 252] },
    body: [175, 175, 175],
    stat: [255, 255, 255],
    panel: [18, 20, 28],
    border: [58, 63, 78],
    lock: [120, 170, 235]
  };

  function fmt(v) {
    if (v >= 1000) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (Math.round(v * 100) / 100).toString();
  }

  /** The label with its A / B / X placeholders filled in from the table. */
  function lineText(fam, values) {
    var t = fam.label;
    t = t.replace(/\bA\b/g, fmt(values[0]));
    t = t.replace(/\bB\b/g, fmt(values.length > 1 ? values[1] : values[0]));
    t = t.replace(/X/g, fmt(values[0]));
    t = t.replace(/[−–—]/g, "-");
    t = t.replace(/[^A-Za-z0-9 +\-%.,:;/()&'!?=]/g, " ");
    return t.replace(/\s+/g, " ").trim();
  }

  var TRAIT_LABEL = { crit: "Crit", spec: "Specialization", swiftness: "Swiftness",
    domination: "Domination", endurance: "Endurance", expertise: "Expertise" };
  var BASIC_LABEL = { mainStat: "Intelligence", vitality: "Vitality" };

  // ------------------------------------------------------------------
  // build one bracelet, then draw it
  // ------------------------------------------------------------------

  /**
   * A legal random bracelet, straight off the data tables.
   * spec: { grade, seed, slots, traitKeys, families:[{key|id, tier, locked}] }
   */
  function makeBracelet(spec) {
    spec = spec || {};
    var rand = rng(spec.seed || 7);
    var grade = spec.grade || (rand() < 0.5 ? "relic" : "ancient");
    var slotChoices = grade === "relic" ? [1, 2] : [2, 3];
    var slots = spec.slots || slotChoices[Math.floor(rand() * slotChoices.length)];
    var traitKeys = spec.traitKeys || ["crit", "spec"];
    var traits = traitKeys.map(function (k) {
      var bands = DATA.TRAITS.bands;
      var band = bands[Math.floor(rand() * bands.length)][grade];
      return { family: k, value: band[0] + Math.floor(rand() * (band[1] - band[0] + 1)) };
    });

    var lines = [];
    if (spec.families) {
      lines = spec.families.map(function (f) {
        if (f.cat === "basic") {
          var bands = DATA.BASIC.bands;
          var bd = bands[(f.band != null ? f.band : Math.floor(rand() * bands.length))][grade][f.key];
          return { cat: "basic", family: f.key,
            value: f.value != null ? f.value : bd[0] + Math.floor(rand() * (bd[1] - bd[0] + 1)),
            locked: !!f.locked };
        }
        var fam = DATA.SPECIAL_BY_KEY[f.key] || DATA.SPECIAL_BY_ID[f.id];
        return { cat: "special", family: fam.id, key: fam.key,
          tier: f.tier || "mid", locked: !!f.locked };
      });
    } else {
      var used = {};
      while (lines.length < slots) {
        if (rand() < 0.25) {
          var bk = rand() < 0.6 ? "mainStat" : "vitality";
          if (used["b" + bk]) continue;
          used["b" + bk] = 1;
          var bands2 = DATA.BASIC.bands;
          var bd2 = bands2[Math.floor(rand() * bands2.length)][grade][bk];
          lines.push({ cat: "basic", family: bk,
            value: bd2[0] + Math.floor(rand() * (bd2[1] - bd2[0] + 1)), locked: rand() < 0.3 });
        } else {
          var fam2 = DATA.SPECIALS[Math.floor(rand() * DATA.SPECIALS.length)];
          if (used["s" + fam2.id]) continue;
          used["s" + fam2.id] = 1;
          lines.push({ cat: "special", family: fam2.id, key: fam2.key,
            tier: DATA.TIERS[Math.floor(rand() * 3)], locked: rand() < 0.3 });
        }
      }
    }
    return { grade: grade, slots: lines.length, traits: traits, lines: lines,
      rollsLeft: spec.rollsLeft != null ? spec.rollsLeft : 3 };
  }

  /**
   * The rows a tooltip would print, in order, with their colours — shared by the
   * Node renderer (bitmap font) and the browser one (real font on a canvas).
   */
  function buildPlan(bracelet, maxChars, opts, contIndent) {
    opts = opts || {};
    var plan = [], gapAfter = {};
    function plan1(text, colour, kind, ref, indent, lock) {
      plan.push({ text: text, colour: colour, kind: kind, ref: ref, indent: indent || 0, lock: !!lock });
    }
    plan1((bracelet.grade === "relic" ? "Relic" : "Ancient") + " Bracelet of Ruin",
      COLORS.grade[bracelet.grade], "name", null);
    plan1("Bracelet   Item Level 1700", COLORS.body, "body", null);
    gapAfter[plan.length - 1] = 1;
    for (var t = 0; t < bracelet.traits.length; t++) {
      var tr = bracelet.traits[t];
      plan1(TRAIT_LABEL[tr.family] + " +" + tr.value, COLORS.stat, "trait", tr);
    }
    for (var k = 0; k < bracelet.lines.length; k++) {
      var ln = bracelet.lines[k], text, colour;
      if (ln.cat === "basic") {
        text = BASIC_LABEL[ln.family] + " +" + fmt(ln.value);
        var bi = 1, bands = DATA.BASIC.bands;
        for (var bb = 0; bb < bands.length; bb++) {
          var rr = bands[bb][bracelet.grade][ln.family];
          if (ln.value >= rr[0] && ln.value <= rr[1]) { bi = bb + 1; break; }
        }
        colour = COLORS.band[bi <= 4 ? "green" : (bi <= 7 ? "blue" : "purple")];
      } else {
        var fam = DATA.SPECIAL_BY_ID[ln.family];
        text = lineText(fam, fam.values[bracelet.grade][ln.tier]);
        colour = COLORS.tier[ln.tier];
      }
      var parts = [text];
      if (opts.wrap !== false && text.length > maxChars) {
        parts = [];
        var words = text.split(" "), cur = "";
        for (var wI = 0; wI < words.length; wI++) {
          if ((cur + " " + words[wI]).trim().length > maxChars) { parts.push(cur.trim()); cur = words[wI]; }
          else cur = (cur + " " + words[wI]).trim();
        }
        if (cur) parts.push(cur);
      }
      plan1(parts[0], colour, ln.cat, ln, 0, ln.locked);
      for (var p = 1; p < parts.length; p++) plan1(parts[p], colour, "cont", ln, contIndent);
    }
    if (opts.showRolls !== false) {
      gapAfter[plan.length - 1] = 1;
      plan1(bracelet.rollsLeft + " rolls remaining", COLORS.body, "rolls", null);
    }
    return { plan: plan, gapAfter: gapAfter };
  }

  /**
   * The same tooltip, drawn on a real canvas with a real font.
   *
   * Browser only. This is the version worth pointing Tesseract at: anti-aliased
   * glyphs at a game-like size, which is the part the Node fixture cannot test.
   * Returns { canvas, truth, lines, panel }.
   */
  function renderToCanvas(bracelet, opts) {
    opts = opts || {};
    var W = opts.width || 1280, H = opts.height || 800;
    var fs = opts.fontSize || 15;
    var font = opts.font || '"Segoe UI", Arial, sans-serif';
    var bright = opts.brightness != null ? opts.brightness : 1;
    var cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var g = cv.getContext("2d");
    function css(rgb) {
      return "rgb(" + Math.min(255, Math.round(rgb[0] * bright)) + "," +
        Math.min(255, Math.round(rgb[1] * bright)) + "," +
        Math.min(255, Math.round(rgb[2] * bright)) + ")";
    }
    // A busy scene behind it. The whole frame is covered first: an uncovered
    // canvas is transparent black, which reads exactly like tooltip background
    // and would hand the panel finder a free pass.
    var grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#6a4a2a");
    grad.addColorStop(0.5, "#2f5a72");
    grad.addColorStop(1, "#7a3a5a");
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    for (var i = 0; i < 260; i++) {
      g.fillStyle = "hsl(" + ((i * 37) % 360) + ",65%," + (28 + (i % 40)) + "%)";
      g.fillRect((i * 97) % W, (i * 53) % H, 40 + (i % 90), 24 + (i % 60));
    }
    g.font = fs + "px " + font;
    var padX = 16, padY = 12, lineH = Math.round(fs * 1.55), gutter = Math.round(fs * 1.5);
    var panelW = Math.round(W * 0.52), panelX = Math.round(W * 0.22), panelY = Math.round(H * 0.05);
    var textX = panelX + padX + gutter;
    var maxChars = Math.floor((panelW - padX * 2 - gutter) / (fs * 0.52));
    var planned = buildPlan(bracelet, maxChars, opts, Math.round(fs * 1.2));
    var plan = planned.plan, gapAfter = planned.gapAfter;
    var panelH = padY * 2 + plan.length * lineH + Object.keys(gapAfter).length * Math.round(lineH * 0.4);

    g.fillStyle = css(COLORS.panel);
    g.fillRect(panelX, panelY, panelW, panelH);
    g.strokeStyle = css(COLORS.border);
    g.lineWidth = 1;
    g.strokeRect(panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1);

    var rows = [], y = panelY + padY;
    g.textBaseline = "top";
    for (var q = 0; q < plan.length; q++) {
      var it = plan[q];
      g.fillStyle = css(it.colour);
      g.fillText(it.text, textX + it.indent, y);
      if (it.lock) {
        g.fillStyle = css(COLORS.lock);
        var lw = Math.round(fs * 0.8);
        g.fillRect(textX - gutter, y + 2, lw, lw);
      }
      rows.push({ text: it.text, y0: y, y1: y + fs, kind: it.kind, ref: it.ref });
      y += lineH + (gapAfter[q] ? Math.round(lineH * 0.4) : 0);
    }
    return { canvas: cv, truth: bracelet, lines: rows,
      panel: { x: panelX, y: panelY, w: panelW, h: panelH } };
  }

  /**
   * Draw a bracelet as a tooltip over a busy background.
   *
   * opts: { width, height, scale, brightness (0.4..1.4), seed, noise,
   *         showRolls, lockSide, wrapAt }
   * Returns { raster, truth, lines:[{ text, y0, y1, kind, ref }] } — `lines` is
   * what a test reader uses to answer as OCR would for a given strip.
   */
  function render(bracelet, opts) {
    opts = opts || {};
    var W = opts.width || 1000, H = opts.height || 720;
    var scale = opts.scale || 2;
    var bright = opts.brightness != null ? opts.brightness : 1;
    var rand = rng(opts.seed || 99);
    var ras = L.makeRaster(W, H, [10, 14, 22]);

    function dim(rgb) {
      return [Math.min(255, rgb[0] * bright), Math.min(255, rgb[1] * bright), Math.min(255, rgb[2] * bright)];
    }

    // A busy, COLOURFUL scene behind the tooltip, so findPanel has something it
    // has to reject. A flat dark backdrop would let the panel finder pass by
    // luck; a game scene is bright and saturated, and this imitates that.
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = (y * W + x) * 4;
        var base = 120 + 60 * Math.sin(x / 41) * Math.cos(y / 57);
        ras.data[i] = Math.max(20, Math.min(255, base + 70 * Math.sin(x / 23 + y / 91) + 30 * rand()));
        ras.data[i + 1] = Math.max(20, Math.min(255, base * 0.55 + 60 * Math.cos(x / 67 - y / 31) + 30 * rand()));
        ras.data[i + 2] = Math.max(20, Math.min(255, base * 0.35 + 50 * Math.sin(y / 19) + 30 * rand()));
      }
    }

    var padX = Math.round(18 * scale / 2), padY = Math.round(14 * scale / 2);
    var lineH = GH * scale + Math.round(7 * scale / 2);
    var gutter = Math.round(GH * scale * 1.3);
    var panelW = Math.round(W * 0.62), panelX = Math.round(W * 0.2), panelY = Math.round(H * 0.06);
    var textX = panelX + padX + gutter;
    var maxChars = Math.floor((panelW - padX * 2 - gutter) / (GW * scale + scale));

    // ---- measure: build the list of rows before anything is painted ----
    var planned = buildPlan(bracelet, maxChars, opts, Math.round(GW * scale * 1.6));
    var plan = planned.plan, gapAfter = planned.gapAfter;

    var panelH = padY * 2 + plan.length * lineH +
      Object.keys(gapAfter).length * Math.round(lineH * 0.4);

    // ---- paint: plate first, then the text on top of it ----
    fillRect(ras, panelX, panelY, panelW, panelH, dim(COLORS.panel));
    strokeRect(ras, panelX, panelY, panelW, panelH, dim(COLORS.border), Math.max(1, Math.round(scale / 2)));

    var rows = [], y0 = panelY + padY;
    for (var q = 0; q < plan.length; q++) {
      var it = plan[q];
      drawText(ras, it.text, textX + it.indent, y0, scale, dim(it.colour));
      if (it.lock) {
        var side = opts.lockSide || "left";
        var lw = Math.round(GH * scale * 0.8);
        var lx = side === "left" ? textX - gutter : panelX + panelW - padX - lw;
        fillRect(ras, lx, y0, lw, lw, dim(COLORS.lock));
      }
      rows.push({ text: it.text, y0: y0, y1: y0 + GH * scale - 1, kind: it.kind, ref: it.ref });
      y0 += lineH + (gapAfter[q] ? Math.round(lineH * 0.4) : 0);
    }

    // sensor-ish noise, so no threshold gets to rely on perfectly flat pixels
    var noise = opts.noise != null ? opts.noise : 4;
    if (noise) {
      for (var n = 0; n < ras.data.length; n += 4) {
        var e = (rand() - 0.5) * 2 * noise;
        ras.data[n] += e; ras.data[n + 1] += e; ras.data[n + 2] += e;
      }
    }

    return { raster: ras, truth: bracelet, lines: rows,
      panel: { x: panelX, y: panelY, w: panelW, h: panelH } };
  }

  /**
   * A text reader that answers for the fixture the way OCR would: it finds the
   * drawn line whose vertical span the strip covers and returns its text, with
   * optional character noise and an honest confidence.
   *
   * This is a STUB. It proves the plumbing around the reader, not the reader.
   */
  function makeFixtureReader(fixture, opts) {
    opts = opts || {};
    var errRate = opts.errorRate || 0;
    var rand = rng(opts.seed || 12345);
    var SWAP = { "O": "0", "0": "O", "I": "1", "1": "I", "S": "5", "5": "S", "B": "8", "8": "B" };
    return {
      name: "fixture",
      isAvailable: function () { return true; },
      read: function (strip, o) {
        var box = o && o.box;
        var text = "", conf = 0;
        if (box) {
          var hits = fixture.lines.filter(function (r) {
            return !(r.y1 < box.y0 - 2 || r.y0 > box.y1 + 2);
          });
          text = hits.map(function (r) { return r.text; }).join(" ");
          conf = hits.length ? 0.93 : 0;
        }
        if (errRate && text) {
          var out = "";
          for (var i = 0; i < text.length; i++) {
            var ch = text[i].toUpperCase();
            if (SWAP[ch] && rand() < errRate) { out += SWAP[ch]; conf = Math.min(conf, 0.62); }
            else out += text[i];
          }
          text = out;
        }
        return Promise.resolve({ text: text, conf: conf, words: [] });
      }
    };
  }

  var API = { makeBracelet: makeBracelet, render: render, renderToCanvas: renderToCanvas,
    buildPlan: buildPlan, makeFixtureReader: makeFixtureReader,
    lineText: lineText, FONT: FONT, COLORS: COLORS, drawText: drawText };

  if (isNode) module.exports = API;
  else root.BraceletFixture = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
