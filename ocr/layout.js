/**
 * ocr/layout.js — the parser's pure image-analysis core.
 *
 * Environment-agnostic: everything here takes and returns plain rasters
 * ({ width, height, data: Uint8ClampedArray RGBA }), so the same code runs on a
 * browser canvas, inside a Web Worker on transferred ImageData, and in Node on a
 * hand-built buffer. No DOM, no canvas, no dependencies.
 *
 * The ordering this file exists to support: read the tooltip's STRUCTURE and its
 * COLOUR first — where the panel is, where the lines are, what colour each line
 * is, whether a padlock sits in the gutter — and only then hand the cropped,
 * cleaned strips to a text reader. Text is the weakest channel and it goes last.
 *
 * CALIBRATION STATUS (read this before trusting a constant): every threshold
 * below is a considered starting point, not a measured one. There were no real
 * bracelet screenshots when this was written. The functions are written to
 * SELF-CALIBRATE off the image (panel background luma, median row height, gutter
 * width) rather than to hardcode pixel offsets, so the constants that remain are
 * ratios and margins, which survive a resolution change. They still need a real
 * screenshot before anyone should believe a number that comes out of them.
 */
(function (root) {
  "use strict";

  var isNode = (typeof module !== "undefined" && module.exports);

  // ------------------------------------------------------------------
  // colour
  // ------------------------------------------------------------------

  function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

  /** Saturation and hue in the cheap HSV sense; hue in degrees, 0 when grey. */
  function hsv(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0;
    if (d > 0) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    return { h: h, s: mx === 0 ? 0 : d / mx, v: mx / 255, chroma: d };
  }

  function hueDist(a, b) { var d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  /**
   * The colours the game paints tooltip text with.
   *
   * PROVISIONAL. These are Lost Ark's published rarity colours plus the two
   * greys its tooltips use for body copy. Nothing here has been checked against
   * a bracelet screenshot. `classifyColor` reports how far the pixel actually
   * sat from the winner and how much it beat the runner-up by, so a palette that
   * turns out to be wrong shows up as low confidence rather than as a wrong
   * answer delivered confidently.
   */
  var PALETTE = [
    { name: "white",     rgb: [255, 255, 255] },
    { name: "grey",      rgb: [155, 155, 155] },
    { name: "green",     rgb: [106, 191, 75] },   // uncommon · bible bands 1-4
    { name: "blue",      rgb: [0, 176, 250] },    // rare · bible bands 5-7
    { name: "purple",    rgb: [206, 67, 252] },   // epic · bible bands 8-10
    { name: "gold",      rgb: [249, 146, 0] },    // legendary
    { name: "relic",     rgb: [250, 93, 0] },     // relic item name
    { name: "ancient",   rgb: [220, 201, 153] }   // ancient item name
  ];

  /**
   * Nearest palette entry to one colour.
   * Returns { name, dist, margin, sat } where `dist` is 0..1 (0 = exact) and
   * `margin` is how much clearer the winner was than the runner-up. Both feed
   * confidence directly: a washed-out or ambiguous colour earns little.
   */
  function classifyColor(r, g, b, palette) {
    palette = palette || PALETTE;
    var c = hsv(r, g, b);
    var scored = [];
    for (var i = 0; i < palette.length; i++) {
      var p = palette[i], pr = p.rgb;
      var pc = hsv(pr[0], pr[1], pr[2]);
      // Hue carries the meaning; saturation separates white from a colour; value
      // is deliberately weak, because in-game brightness moves it and brightness
      // was the single biggest source of misreads on astrogem's corpus.
      var dh = (c.s > 0.12 && pc.s > 0.12) ? hueDist(c.h, pc.h) / 180 : (c.s > 0.12 || pc.s > 0.12 ? 1 : 0);
      var ds = Math.abs(c.s - pc.s);
      var dv = Math.abs(c.v - pc.v);
      scored.push({ name: p.name, d: 0.62 * dh + 0.30 * ds + 0.08 * dv });
    }
    scored.sort(function (a, b2) { return a.d - b2.d; });
    return { name: scored[0].name, dist: scored[0].d,
      margin: scored[1] ? scored[1].d - scored[0].d : 1, sat: c.s, hue: c.h };
  }

  // ------------------------------------------------------------------
  // raster basics
  // ------------------------------------------------------------------

  function makeRaster(w, h, fill) {
    var d = new Uint8ClampedArray(w * h * 4);
    if (fill) {
      for (var i = 0; i < d.length; i += 4) {
        d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = 255;
      }
    } else {
      for (var j = 3; j < d.length; j += 4) d[j] = 255;
    }
    return { width: w, height: h, data: d };
  }

  function px(ras, x, y) {
    var i = (y * ras.width + x) * 4, d = ras.data;
    return [d[i], d[i + 1], d[i + 2]];
  }

  /** Box-filter downscale to at most maxW wide. Returns { raster, scale }. */
  function downscale(ras, maxW) {
    if (ras.width <= maxW) return { raster: ras, scale: 1 };
    var f = Math.ceil(ras.width / maxW);
    var w = Math.floor(ras.width / f), h = Math.floor(ras.height / f);
    var out = makeRaster(w, h), o = out.data, s = ras.data;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0, n = 0;
        for (var dy = 0; dy < f; dy++) {
          var sy = y * f + dy;
          if (sy >= ras.height) break;
          for (var dx = 0; dx < f; dx++) {
            var sx = x * f + dx;
            if (sx >= ras.width) break;
            var i = (sy * ras.width + sx) * 4;
            r += s[i]; g += s[i + 1]; b += s[i + 2]; n++;
          }
        }
        var oi = (y * w + x) * 4;
        o[oi] = r / n; o[oi + 1] = g / n; o[oi + 2] = b / n; o[oi + 3] = 255;
      }
    }
    return { raster: out, scale: f };
  }

  function crop(ras, box) {
    var x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
    var w = Math.min(Math.round(box.w), ras.width - x0), h = Math.min(Math.round(box.h), ras.height - y0);
    var out = makeRaster(Math.max(1, w), Math.max(1, h)), o = out.data, s = ras.data;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var si = ((y + y0) * ras.width + (x + x0)) * 4, oi = (y * w + x) * 4;
        o[oi] = s[si]; o[oi + 1] = s[si + 1]; o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
      }
    }
    return out;
  }

  /** Nearest-neighbour upscale — OCR reads small game text far better at 3-4x. */
  function upscale(ras, f) {
    var w = ras.width * f, h = ras.height * f;
    var out = makeRaster(w, h), o = out.data, s = ras.data;
    for (var y = 0; y < h; y++) {
      var sy = (y / f) | 0;
      for (var x = 0; x < w; x++) {
        var sx = (x / f) | 0;
        var si = (sy * ras.width + sx) * 4, oi = (y * w + x) * 4;
        o[oi] = s[si]; o[oi + 1] = s[si + 1]; o[oi + 2] = s[si + 2]; o[oi + 3] = 255;
      }
    }
    return out;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[a.length >> 1];
  }

  // ------------------------------------------------------------------
  // finding the tooltip panel
  // ------------------------------------------------------------------

  /**
   * The tooltip is a large, dark, nearly flat rectangle over a busy game scene.
   * Find it by masking "dark and unsaturated", knocking the mask down to a
   * coarse grid, taking the biggest connected blob and reporting its bounding
   * box. No fixed coordinates, so it survives any resolution or UI scale.
   *
   * Returns { x, y, w, h, conf, bgLuma } in the ORIGINAL raster's coordinates.
   * conf comes from the image: how solidly the box is filled with background
   * pixels, and how sharp the step in brightness is at its edges.
   */
  /** What share of one scan line looks like tooltip background. */
  function lineBgFrac(ras, horizontal, at, from, to, maxLuma, maxSat) {
    var n = 0, bgN = 0;
    var step = Math.max(1, Math.round((to - from) / 220));
    for (var t = from; t <= to; t += step) {
      var x = horizontal ? t : at, y = horizontal ? at : t;
      if (x < 0 || y < 0 || x >= ras.width || y >= ras.height) continue;
      var i = (y * ras.width + x) * 4, d = ras.data;
      var c = hsv(d[i], d[i + 1], d[i + 2]);
      n++;
      if (luma(d[i], d[i + 1], d[i + 2]) <= maxLuma && c.s <= maxSat) bgN++;
    }
    return n ? bgN / n : 0;
  }

  /** Push each edge of a coarse box out to, then in to, the real panel edge. */
  function refineBox(ras, box, maxLuma, maxSat) {
    var x0 = Math.round(box.x), y0 = Math.round(box.y);
    var x1 = Math.round(box.x + box.w - 1), y1 = Math.round(box.y + box.h - 1);
    var limX = Math.max(4, Math.round(box.w * 0.2)), limY = Math.max(4, Math.round(box.h * 0.2));
    var IN = 0.80, OUT = 0.92;
    var k;
    for (k = 0; k < limX && x0 > 0 && lineBgFrac(ras, false, x0 - 1, y0, y1, maxLuma, maxSat) >= OUT; k++) x0--;
    for (k = 0; k < limX && x0 < x1 && lineBgFrac(ras, false, x0, y0, y1, maxLuma, maxSat) < IN; k++) x0++;
    for (k = 0; k < limX && x1 < ras.width - 1 && lineBgFrac(ras, false, x1 + 1, y0, y1, maxLuma, maxSat) >= OUT; k++) x1++;
    for (k = 0; k < limX && x1 > x0 && lineBgFrac(ras, false, x1, y0, y1, maxLuma, maxSat) < IN; k++) x1--;
    for (k = 0; k < limY && y0 > 0 && lineBgFrac(ras, true, y0 - 1, x0, x1, maxLuma, maxSat) >= OUT; k++) y0--;
    for (k = 0; k < limY && y0 < y1 && lineBgFrac(ras, true, y0, x0, x1, maxLuma, maxSat) < IN; k++) y0++;
    for (k = 0; k < limY && y1 < ras.height - 1 && lineBgFrac(ras, true, y1 + 1, x0, x1, maxLuma, maxSat) >= OUT; k++) y1++;
    for (k = 0; k < limY && y1 > y0 && lineBgFrac(ras, true, y1, x0, x1, maxLuma, maxSat) < IN; k++) y1--;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function findPanel(ras, opts) {
    opts = opts || {};
    var small = downscale(ras, opts.workWidth || 900);
    var w = small.raster.width, h = small.raster.height, d = small.raster.data;
    var maxLuma = opts.maxLuma != null ? opts.maxLuma : 78;
    var maxSat = opts.maxSat != null ? opts.maxSat : 0.55;

    var cell = Math.max(4, Math.round(w / 120));
    var gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    var dens = new Float32Array(gw * gh);
    var cnt = new Float32Array(gw * gh);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var L = luma(d[i], d[i + 1], d[i + 2]);
        var c = hsv(d[i], d[i + 1], d[i + 2]);
        var gi = ((y / cell) | 0) * gw + ((x / cell) | 0);
        cnt[gi]++;
        if (L <= maxLuma && c.s <= maxSat) dens[gi]++;
      }
    }
    var on = new Uint8Array(gw * gh);
    for (var k = 0; k < dens.length; k++) on[k] = (cnt[k] > 0 && dens[k] / cnt[k] >= 0.72) ? 1 : 0;

    // biggest connected blob (4-neighbour flood fill)
    var seen = new Uint8Array(gw * gh), best = null, stack = [];
    for (var s0 = 0; s0 < on.length; s0++) {
      if (!on[s0] || seen[s0]) continue;
      stack.length = 0; stack.push(s0); seen[s0] = 1;
      var n = 0, x0 = gw, x1 = -1, y0 = gh, y1 = -1;
      while (stack.length) {
        var p = stack.pop(), pxx = p % gw, pyy = (p / gw) | 0;
        n++;
        if (pxx < x0) x0 = pxx; if (pxx > x1) x1 = pxx;
        if (pyy < y0) y0 = pyy; if (pyy > y1) y1 = pyy;
        if (pxx > 0 && on[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (pxx < gw - 1 && on[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (pyy > 0 && on[p - gw] && !seen[p - gw]) { seen[p - gw] = 1; stack.push(p - gw); }
        if (pyy < gh - 1 && on[p + gw] && !seen[p + gw]) { seen[p + gw] = 1; stack.push(p + gw); }
      }
      if (!best || n > best.n) best = { n: n, x0: x0, x1: x1, y0: y0, y1: y1 };
    }
    if (!best) return { x: 0, y: 0, w: ras.width, h: ras.height, conf: 0, bgLuma: 20, whole: true };

    var fill = best.n / ((best.x1 - best.x0 + 1) * (best.y1 - best.y0 + 1));
    var sx = cell * small.scale, sy = cell * small.scale;
    var box = {
      x: best.x0 * sx, y: best.y0 * sy,
      w: Math.min(ras.width - best.x0 * sx, (best.x1 - best.x0 + 1) * sx),
      h: Math.min(ras.height - best.y0 * sy, (best.y1 - best.y0 + 1) * sy)
    };
    // The coarse grid rounds outward, so the box usually carries a sliver of the
    // scene on one or more sides. One bright column of scene runs the whole
    // height of the box and welds every row of text into a single run, which
    // destroys line segmentation. Walk each edge to where the background
    // actually stops.
    box = refineBox(ras, box, maxLuma, maxSat);

    // Background level inside the box, and how sharply it steps up outside it.
    var inside = [], outside = [];
    for (var yy = 0; yy < box.h; yy += Math.max(1, Math.round(box.h / 60))) {
      for (var xx = 0; xx < box.w; xx += Math.max(1, Math.round(box.w / 60))) {
        var q = px(ras, Math.round(box.x + xx), Math.round(box.y + yy));
        inside.push(luma(q[0], q[1], q[2]));
      }
    }
    var pad = Math.max(3, Math.round(box.w * 0.01));
    for (var e = 0; e < 40; e++) {
      var t = e / 40;
      var cand = [
        [box.x + box.w * t, box.y - pad],
        [box.x + box.w * t, box.y + box.h + pad],
        [box.x - pad, box.y + box.h * t],
        [box.x + box.w + pad, box.y + box.h * t]
      ];
      for (var ci = 0; ci < cand.length; ci++) {
        var cxx = Math.round(cand[ci][0]), cyy = Math.round(cand[ci][1]);
        if (cxx < 0 || cyy < 0 || cxx >= ras.width || cyy >= ras.height) continue;
        var o2 = px(ras, cxx, cyy);
        outside.push(luma(o2[0], o2[1], o2[2]));
      }
    }
    var bgL = median(inside);
    var outL = outside.length ? median(outside) : bgL;
    var step = Math.min(1, Math.abs(outL - bgL) / 60);
    var area = (box.w * box.h) / (ras.width * ras.height);
    // A believable tooltip fills a decent share of the frame but not all of it.
    var areaOk = area > 0.02 && area < 0.85 ? 1 : 0.35;
    var conf = Math.max(0, Math.min(1, 0.5 * fill + 0.3 * step + 0.2 * areaOk));
    return { x: box.x, y: box.y, w: box.w, h: box.h, conf: conf, bgLuma: bgL, fill: fill, step: step };
  }

  // ------------------------------------------------------------------
  // rows of text
  // ------------------------------------------------------------------

  /**
   * Ink profile down a rectangle: how many pixels per row stand clear of the
   * panel background. The threshold is taken from the panel itself, so a dimmer
   * or brighter capture moves the whole profile and not the answer.
   */
  function inkProfile(ras, box, bgLuma, opts) {
    opts = opts || {};
    var over = opts.over != null ? opts.over : 38;
    var x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y));
    var w = Math.min(Math.round(box.w), ras.width - x0), h = Math.min(Math.round(box.h), ras.height - y0);
    var prof = new Float32Array(h);
    var firstX = new Int32Array(h), lastX = new Int32Array(h);
    for (var y = 0; y < h; y++) {
      var n = 0, fx = -1, lx = -1;
      for (var x = 0; x < w; x++) {
        var i = ((y + y0) * ras.width + (x + x0)) * 4, dd = ras.data;
        if (luma(dd[i], dd[i + 1], dd[i + 2]) - bgLuma > over) {
          n++;
          if (fx < 0) fx = x;
          lx = x;
        }
      }
      prof[y] = n; firstX[y] = fx; lastX[y] = lx;
    }
    return { prof: prof, firstX: firstX, lastX: lastX, x0: x0, y0: y0, w: w, h: h };
  }

  /** Contiguous runs of inked rows — one per visual line of text. */
  function segmentRows(profile, opts) {
    opts = opts || {};
    var minInk = opts.minInk != null ? opts.minInk : Math.max(2, Math.round(profile.w * 0.006));
    var rows = [], start = -1, y;
    for (y = 0; y < profile.h; y++) {
      var on = profile.prof[y] >= minInk;
      if (on && start < 0) start = y;
      else if (!on && start >= 0) { rows.push([start, y - 1]); start = -1; }
    }
    if (start >= 0) rows.push([start, profile.h - 1]);
    var minH = opts.minHeight != null ? opts.minHeight : 5;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i][0], b = rows[i][1];
      if (b - a + 1 < minH) continue;
      var fx = 1e9, lx = -1, ink = 0;
      for (y = a; y <= b; y++) {
        if (profile.firstX[y] >= 0 && profile.firstX[y] < fx) fx = profile.firstX[y];
        if (profile.lastX[y] > lx) lx = profile.lastX[y];
        ink += profile.prof[y];
      }
      out.push({ y0: profile.y0 + a, y1: profile.y0 + b,
        x0: profile.x0 + (fx === 1e9 ? 0 : fx), x1: profile.x0 + (lx < 0 ? profile.w - 1 : lx),
        ink: ink, h: b - a + 1 });
    }
    return out;
  }

  /**
   * Rows into entries. One tooltip effect can wrap onto a second visual row; a
   * wrapped row starts further right than the entry's own left margin, so the
   * left edge is what separates a new entry from a continuation. The margin is
   * measured off the rows themselves (the commonest left edge), never assumed.
   */
  function groupEntries(rows, opts) {
    opts = opts || {};
    if (!rows.length) return [];
    var lefts = rows.map(function (r) { return r.x0; });
    var margin = median(lefts);
    var heights = rows.map(function (r) { return r.h; });
    var mh = median(heights) || 10;
    var indentAt = opts.indent != null ? opts.indent : mh * 0.9;
    var gapBreak = opts.gapBreak != null ? opts.gapBreak : mh * 1.4;
    var entries = [], cur = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var continues = cur &&
        (r.x0 - margin > indentAt) &&
        (r.y0 - cur.y1 <= gapBreak);
      if (!continues) {
        cur = { rows: [r], x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 };
        entries.push(cur);
      } else {
        cur.rows.push(r);
        cur.x0 = Math.min(cur.x0, r.x0); cur.x1 = Math.max(cur.x1, r.x1);
        cur.y1 = r.y1;
      }
    }
    for (var e = 0; e < entries.length; e++) {
      entries[e].h = entries[e].y1 - entries[e].y0 + 1;
      entries[e].w = entries[e].x1 - entries[e].x0 + 1;
    }
    return { entries: entries, margin: margin, rowHeight: mh };
  }

  // ------------------------------------------------------------------
  // an entry's colour
  // ------------------------------------------------------------------

  /**
   * The dominant colour of one entry's text. Averaging every ink pixel washes
   * anti-aliased edges into the mean, so weight each pixel by how far it stands
   * clear of the background and how much colour it actually has.
   */
  function entryColor(ras, box, bgLuma, opts) {
    opts = opts || {};
    var over = opts.over != null ? opts.over : 46;
    var x0 = Math.max(0, Math.round(box.x0 != null ? box.x0 : box.x));
    var y0 = Math.max(0, Math.round(box.y0 != null ? box.y0 : box.y));
    var x1 = Math.min(ras.width - 1, Math.round(box.x1 != null ? box.x1 : x0 + box.w - 1));
    var y1 = Math.min(ras.height - 1, Math.round(box.y1 != null ? box.y1 : y0 + box.h - 1));
    var r = 0, g = 0, b = 0, wsum = 0, n = 0, lumas = [];
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var i = (y * ras.width + x) * 4, d = ras.data;
        var L = luma(d[i], d[i + 1], d[i + 2]);
        if (L - bgLuma <= over) continue;
        var c = hsv(d[i], d[i + 1], d[i + 2]);
        var wgt = (L - bgLuma) * (0.35 + c.s);
        r += d[i] * wgt; g += d[i + 1] * wgt; b += d[i + 2] * wgt;
        wsum += wgt; n++;
        lumas.push(L);
      }
    }
    if (!wsum) return { rgb: [0, 0, 0], pixels: 0, cls: { name: "unknown", dist: 1, margin: 0, sat: 0 } };
    var rgb = [r / wsum, g / wsum, b / wsum];
    return { rgb: rgb, pixels: n, meanLuma: median(lumas),
      cls: classifyColor(rgb[0], rgb[1], rgb[2]) };
  }

  // ------------------------------------------------------------------
  // the padlock gutter
  // ------------------------------------------------------------------

  /**
   * Is there an icon in the strip to the left of an entry?
   *
   * A padlock is a small, compact, roughly square blob sitting on its own in the
   * gutter. This reports whether one is there and how sure the PIXELS are — and
   * it is deliberately shy: an ambiguous gutter comes back `null`, which the
   * snap turns into a flagged unknown. A wrong lock is expensive (it decides
   * which lines the solver may reroll), so guessing here is worse than asking.
   *
   * UNVERIFIED. Neither the gutter's position nor the padlock's look has been
   * checked against a real screenshot.
   */
  function lockGutter(ras, entry, bgLuma, opts) {
    opts = opts || {};
    // Everything here is sized off ONE ROW, never off the entry: a wrapped entry
    // is two rows tall and the icon is not.
    var rowH = opts.rowHeight || (entry.rows && entry.rows[0] ? entry.rows[0].h : entry.h);
    var gw = opts.gutterWidth || Math.round(rowH * 1.6);
    var side = opts.side || "left";
    // The gutter is measured from the tooltip's common TEXT margin, not from
    // this entry's own left edge — a padlock pushes that edge left, and looking
    // left of it would look past the icon entirely.
    var leftEdge = (opts.margin != null ? opts.margin : entry.x0);
    var gx0 = side === "left"
      ? Math.max(0, leftEdge - gw)
      : Math.min(ras.width - 1, (opts.rightEdge != null ? opts.rightEdge : entry.x1) + Math.round(rowH * 0.2));
    // never look outside the tooltip: past its edge is the game scene, which is
    // bright everywhere and would read as an icon on every line
    if (opts.panelX0 != null) gx0 = Math.max(gx0, Math.round(opts.panelX0));
    var gx1 = Math.min(ras.width - 1, gx0 + gw);
    if (opts.panelX1 != null) gx1 = Math.min(gx1, Math.round(opts.panelX1));
    if (gx1 <= gx0) return { locked: null, conf: 0, fill: 0 };
    var y0 = Math.max(0, entry.y0 - Math.round(rowH * 0.2));
    var y1 = Math.min(ras.height - 1, entry.y0 + Math.round(rowH * 1.2));
    var over = opts.over != null ? opts.over : 34;
    var n = 0, total = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    for (var y = y0; y <= y1; y++) {
      for (var x = gx0; x <= gx1; x++) {
        total++;
        var i = (y * ras.width + x) * 4, d = ras.data;
        if (luma(d[i], d[i + 1], d[i + 2]) - bgLuma > over) {
          n++;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
      }
    }
    if (!total) return { locked: null, conf: 0, fill: 0 };
    var fill = n / total;
    if (n < 6) return { locked: false, conf: fill < 0.005 ? 0.55 : 0.2, fill: fill };
    var bw = maxx - minx + 1, bh = maxy - miny + 1;
    var squareness = Math.min(bw, bh) / Math.max(bw, bh);
    var density = n / (bw * bh);
    var sized = bh / Math.max(1, rowH);
    var sizeOk = sized > 0.45 && sized < 1.6;
    // Compact, square-ish, solid and the right height: that is an icon. Anything
    // else in the gutter is stray text or a border and settles nothing.
    var looksLikeIcon = squareness > 0.6 && density > 0.25 && sizeOk;
    if (!looksLikeIcon) return { locked: null, conf: 0, fill: fill };
    var conf = Math.min(0.75, 0.25 + 0.5 * squareness * Math.min(1, density * 2));
    return { locked: true, conf: conf, fill: fill, box: { x: minx, y: miny, w: bw, h: bh } };
  }

  // ------------------------------------------------------------------
  // preparing a strip for the text reader
  // ------------------------------------------------------------------

  /**
   * Crop one entry, upscale it, and paint it black-on-white with the threshold
   * taken from the panel background. Tesseract reads game text far better this
   * way than it does off the raw screenshot, and the binarisation is where the
   * colour information has already been taken out — which is why entryColor runs
   * BEFORE this, on the original pixels.
   */
  function textStrip(ras, box, bgLuma, opts) {
    opts = opts || {};
    var padX = Math.round((box.h || 12) * 0.3), padY = Math.round((box.h || 12) * 0.35);
    var x0 = Math.max(0, (box.x0 != null ? box.x0 : box.x) - padX);
    var y0 = Math.max(0, (box.y0 != null ? box.y0 : box.y) - padY);
    var x1 = Math.min(ras.width - 1, (box.x1 != null ? box.x1 : box.x + box.w) + padX);
    var y1 = Math.min(ras.height - 1, (box.y1 != null ? box.y1 : box.y + box.h) + padY);
    var c = crop(ras, { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    var rowH = box.rowHeight || box.h || (box.y1 - box.y0 + 1) || 12;
    var scale = opts.scale || Math.max(1, Math.round(44 / Math.max(6, rowH)));
    var up = scale > 1 ? upscale(c, scale) : c;
    var d = up.data, i, L;
    // A hard threshold throws away the anti-aliased edges, and at game text
    // sizes those edges are most of the letter: measured on the browser bench, a
    // binarised strip read "Cnt" where the same strip in grey read "Crit". So the
    // strip keeps its greys — inverted and stretched against the panel's own
    // background, which is what makes it robust to a dim or bright capture.
    var maxL = 0;
    for (i = 0; i < d.length; i += 4) {
      L = luma(d[i], d[i + 1], d[i + 2]);
      if (L > maxL) maxL = L;
    }
    var span = Math.max(20, maxL - bgLuma);
    var floor = opts.floor != null ? opts.floor : 0.12;   // ignore the faintest haze
    for (i = 0; i < d.length; i += 4) {
      L = luma(d[i], d[i + 1], d[i + 2]);
      var t = (L - bgLuma) / span;
      t = t < floor ? 0 : (t - floor) / (1 - floor);
      if (t > 1) t = 1;
      var v = Math.round(255 * (1 - t));
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    return up;
  }

  var API = {
    luma: luma, hsv: hsv, hueDist: hueDist,
    PALETTE: PALETTE, classifyColor: classifyColor,
    makeRaster: makeRaster, px: px, crop: crop, upscale: upscale, downscale: downscale, median: median,
    findPanel: findPanel, inkProfile: inkProfile, segmentRows: segmentRows, groupEntries: groupEntries,
    entryColor: entryColor, lockGutter: lockGutter, textStrip: textStrip
  };

  if (isNode) module.exports = API;
  else root.BraceletLayout = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
