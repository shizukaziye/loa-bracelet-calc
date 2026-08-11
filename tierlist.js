/**
 * tierlist.js — the Tier List tab: every bracelet effect ranked by what it is
 * worth to YOUR character, live.
 *
 * Ranking is pure scoring — no DP, no solver, no worker — so 33 or 99 rows come
 * out in well under a millisecond and the table recomputes on every input event
 * instead of being debounced into a worker the way the Calculator's advice is.
 * That immediacy is the whole point: drag Back share to 0 and watch the
 * positional lines fall through the table.
 *
 * WHAT IT SHOWS
 *   By family (33 rows, default) — each special family at its odds-weighted
 *     average roll (the three tiers land 6:3:1, so 0.6 low + 0.3 mid + 0.1 high).
 *     Same number Bracelet.familyGrades() computes for the Calculator's picker,
 *     so the two can never disagree about which family is better.
 *   By roll (99 rows) — every family x tier separately, coloured by rarity:
 *     low = Rare blue, mid = Epic purple, high = Legendary gold. A Legendary junk
 *     line sitting far below a Rare crit line is the lesson the table teaches.
 *
 * BANDING: S >=95 - A >=65 - B >=55 - C >=45 - D >0 - F = no damage, as a
 * percentage of the BEST line for the current profile, with empty bands drawn
 * explicitly rather than skipped. The best line is the best line FOR THE CURRENT
 * PROFILE, so the bands move as the profile does. That is the feature, and the
 * copy above the table says so.
 *
 * THE DECK. There is exactly one control deck in the document and mount() MOVES
 * it (see profile.js's header). This tab claims it on activation; app.js claims
 * it back when the Calculator is selected. Nothing to release — the last
 * mount() wins, and only one tab is ever visible.
 *
 * NO NETWORK. This tab fetches nothing, from anywhere.
 */
(function () {
  "use strict";

  var B = window.Bracelet, DATA = window.BraceletData, P = window.Profile;
  if (!B || !DATA || !P) return;                 // model or spine missing; leave the placeholder

  var PANE_ID = "tab-tierlist";
  var DECK_HOST = "bctl-deckhost";

  // ------------------------------------------------------------------
  // small helpers (three lines each; there is no module system here)
  // ------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fx(v, n) { return (Math.round(v * Math.pow(10, n)) / Math.pow(10, n)).toFixed(n); }
  function nf(n) { return Math.round(n).toLocaleString("en-US"); }
  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  // ------------------------------------------------------------------
  // bands and palettes
  // ------------------------------------------------------------------

  // loa-tierlist's own ladder and hues, so a user who knows that site reads this
  // table without being taught anything.
  // Bands are a % of the best line, but NOT the loa-tierlist ladder: that one is
  // tuned for raid classes bunched within 20% of each other. Bracelet families run
  // from 100% down to 37%, and thirteen of them do no damage at all, so the 98/95/90
  // ladder put every real line in F. Here F means EXACTLY ONE THING — the line is
  // worth nothing — and the live bands rank the twenty that do something.
  var BANDS = [
    { key: "S", pct: 95, hue: "#E8CD8A", glow: true },
    { key: "A", pct: 65, hue: "#E25C55" },
    { key: "B", pct: 55, hue: "#E29A50" },
    { key: "C", pct: 45, hue: "#D9C25F" },
    { key: "D", pct: 0.0001, hue: "#7DB56E" },
    { key: "F", pct: 0, hue: "#7290C7" }
  ];
  function bandOf(pct) {
    for (var i = 0; i < BANDS.length; i++) if (pct >= BANDS[i].pct) return BANDS[i];
    return BANDS[BANDS.length - 1];
  }

  // Rarity of a roll, and the house tokens for it. The three tiers ARE the three
  // rarities in game: low Rare, mid Epic, high Legendary.
  var RARITY = {
    low: { name: "Rare", hue: "#6ad4ff" },
    mid: { name: "Epic", hue: "#c78cff" },
    high: { name: "Legendary", hue: "#ffb86b" }
  };
  var TIERS = ["low", "mid", "high"];
  var TIER_ODDS = { low: 0.6, mid: 0.3, high: 0.1 };

  // ------------------------------------------------------------------
  // official odds
  //
  // Every draw outcome sits on ONE 100-point scale: basic 35, combat trait 35,
  // special 30. Inside the special category the listed per-tier percentages are
  // renormalised by their own sum (the disclosure page rounds, so it comes to
  // 100.00016 rather than 100) and scaled to the category's 30 points — exactly
  // the page's own rule, real chance = listed / (100 - listed of everything
  // excluded). Nothing here "fixes" a published number.
  // ------------------------------------------------------------------

  var SPEC_SUM = DATA.GRANTED_LISTED_SUM;
  var SPEC_W = DATA.CATEGORY_WEIGHTS.special;

  function tierOdds(fam, tier) { return SPEC_W * fam.granted[tier] / SPEC_SUM; }
  function famOdds(fam) { return tierOdds(fam, "low") + tierOdds(fam, "mid") + tierOdds(fam, "high"); }

  function fmtOdds(p) {
    if (p >= 1) return fx(p, 2) + "%";
    if (p >= 0.1) return fx(p, 3) + "%";
    return fx(p, 4) + "%";
  }
  function oneIn(p) { return p > 0 ? "1 in " + nf(100 / p) : "never"; }

  // ------------------------------------------------------------------
  // labels
  // ------------------------------------------------------------------

  /**
   * The official labels carry placeholders (+A%, +X, +B%) that say nothing until
   * the tier is known. Strip them and you have the family's name. Same rule the
   * Calculator's picker uses, so the two name a family identically.
   */
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

  /** The tier's actual roll, formatted: percentages as %, flat stats as a count. */
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

  // ------------------------------------------------------------------
  // scoring
  // ------------------------------------------------------------------

  var view = "family";                                // "family" | "roll"
  var defaultCache = {};                              // grade -> the canonical-profile ranking

  /** Per-tier log-space damage for one family under one profile. */
  function famDamages(fam, grade, prof) {
    var d = [], i;
    for (i = 0; i < TIERS.length; i++) {
      d.push(B.lineDamage({ cat: "special", family: fam.id, tier: TIERS[i] }, grade, prof));
    }
    return d;
  }

  /**
   * Every row of one view, scored under one profile, sorted best first and
   * banded as a percentage of the best row.
   *
   * The whole cost of this tab: 33 families x 3 tiers of lineDamage, twice
   * (yours, and the canonical default for the ghost markers — that one cached).
   */
  function rank(grade, prof) {
    var rows = [], i, t, fam, d;
    for (i = 0; i < DATA.SPECIALS.length; i++) {
      fam = DATA.SPECIALS[i];
      d = famDamages(fam, grade, prof);
      if (view === "family") {
        var avg = TIER_ODDS.low * d[0] + TIER_ODDS.mid * d[1] + TIER_ODDS.high * d[2];
        rows.push({
          key: "f" + fam.id, fam: fam, tier: null, d: avg, tierD: d,
          odds: famOdds(fam), name: cleanFamLabel(fam)
        });
      } else {
        for (t = 0; t < TIERS.length; t++) {
          rows.push({
            key: "r" + fam.id + ":" + TIERS[t], fam: fam, tier: TIERS[t], d: d[t], tierD: d,
            odds: tierOdds(fam, TIERS[t]), name: cleanFamLabel(fam)
          });
        }
      }
    }
    // Main stat is a real granted outcome — 17.5% of a roll before renormalisation,
    // the single likeliest thing to land — so it belongs in the ranking even though it
    // is not a "special family". It rolls a continuous value rather than three tiers,
    // so it contributes ONE row in both views, scored at its expected band value.
    (function () {
      var msVal = B.basicBandExpected("mainStat", grade);
      var msD = B.lineDamage({ cat: "basic", family: "mainStat", value: msVal }, grade, prof);
      var bands = (DATA.BASIC && DATA.BASIC.bands) || [];
      var lo = bands.length ? bands[0][grade].mainStat[0] : null;
      var hi = bands.length ? bands[bands.length - 1][grade].mainStat[1] : null;
      rows.push({
        key: "basic:mainStat", fam: { id: 0, key: "mainStat" }, tier: null,
        d: msD, tierD: [msD, msD, msD],
        odds: 17.5, isBasic: true,
        valsOverride: lo != null ? (lo.toLocaleString() + "–" + hi.toLocaleString()) : "",
        name: "Str / Dex / Int"
      });
    })();

    rows.sort(function (a, b) { return b.d - a.d || a.fam.id - b.fam.id; });
    var best = rows.length ? rows[0].d : 0;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      r.rank = i + 1;
      r.pct = best > 0 ? r.d / best * 100 : 0;
      r.band = r.d > 0 ? bandOf(r.pct) : BANDS[BANDS.length - 1];
      r.dmg = B.damagePercent(r.d);
    }
    return { rows: rows, best: best, bestRow: rows[0] || null };
  }

  /**
   * The same ranking on the CANONICAL default profile — the ghost markers, and
   * the "how your build differs" half of every popover. Cached per grade and
   * per view; the default profile never moves.
   */
  function defaultRank(grade) {
    var k = grade + "|" + view;
    if (!defaultCache[k]) {
      var out = rank(grade, B.normalizeProfile({})), map = {};
      for (var i = 0; i < out.rows.length; i++) map[out.rows[i].key] = out.rows[i];
      defaultCache[k] = { by: map, best: out.best, bestRow: out.bestRow, rows: out.rows };
    }
    return defaultCache[k];
  }

  // ------------------------------------------------------------------
  // the spread strip (loa-tierlist's dot strip, on our axis)
  // ------------------------------------------------------------------

  function stripSVG(res, grade) {
    var rows = res.rows;
    if (!rows.length || res.best <= 0) return "";
    var maxDmg = B.damagePercent(res.best);
    var hi = maxDmg * 1.06, lo = 0;
    var X0 = 34, X1 = 966;
    function X(v) { return X0 + (v - lo) / (hi - lo) * (X1 - X0); }

    // dots, ascending, staggered into lanes so a dense cluster stays readable
    var asc = rows.slice().sort(function (a, b) { return a.dmg - b.dmg; });
    var laneCount = rows.length > 50 ? 5 : 3;
    var laneDy = laneCount > 3 ? 12 : 14;
    var laneLastX = [], i;
    for (i = 0; i < laneCount; i++) laneLastX.push(-1e9);
    var dots = "";
    for (i = 0; i < asc.length; i++) {
      var e = asc[i], x = X(e.dmg), lane = -1, j;
      for (j = 0; j < laneCount; j++) if (x - laneLastX[j] >= 12) { lane = j; break; }
      if (lane === -1) lane = laneCount - 1;
      laneLastX[lane] = x;
      var fill = view === "roll" && e.tier ? RARITY[e.tier].hue : e.band.hue;
      dots += '<circle' + (e.band.key === "S" ? ' class="tlrb"' : "") + ' cx="' + fx(x, 1) + '" cy="' +
        (106 - lane * laneDy) + '" r="4.6" fill="' + fill + '" stroke="#0d1017" stroke-width="1.6">' +
        "<title>" + esc(e.name) + (e.tier ? " (" + e.tier + ")" : "") + " — " + fx(e.dmg, 2) +
        "% (" + fx(e.pct, 1) + "% of best)</title></circle>";
    }

    // the band cuts, drawn to scale: this IS the methodology
    var cuts = "", letters = "", cutXs = [];
    for (i = 0; i < BANDS.length; i++) {
      var b = BANDS[i];
      var upper = i === 0 ? hi : maxDmg * BANDS[i - 1].pct / 100;
      var lower = b.pct ? maxDmg * b.pct / 100 : lo;
      if (b.pct && lower > lo && lower < hi) {
        var cx = X(lower);
        cutXs.push(cx);
        cuts += '<line x1="' + fx(cx, 1) + '" y1="68" x2="' + fx(cx, 1) +
          '" y2="124" stroke="#97a0b4" stroke-width="1" stroke-dasharray="2 4" opacity=".55"/>' +
          '<text x="' + fx(cx, 1) + '" y="140" text-anchor="middle" class="tlax">' + b.pct + "%</text>";
      }
      var l = Math.max(lower, lo), u = Math.min(upper, hi);
      if (u > l && (u - l) / (hi - lo) > 0.03) {
        letters += '<text x="' + fx((X(l) + X(u)) / 2, 1) + '" y="46" text-anchor="middle" class="tlrl' +
          (b.key === "S" ? " tlrb" : "") + '" fill="' + b.hue + '">' + b.key + "</text>";
      }
    }

    var axis = '<line x1="' + X0 + '" y1="118" x2="' + X1 + '" y2="118" stroke="#2a3142" stroke-width="1"/>';
    var step = maxDmg > 6 ? 2 : maxDmg > 3 ? 1 : maxDmg > 1.2 ? 0.5 : 0.25;
    for (var tv = 0; tv < hi; tv += step) {
      var tx = X(tv), ok = true;
      for (j = 0; j < cutXs.length; j++) if (Math.abs(cutXs[j] - tx) <= 20) ok = false;
      axis += '<line x1="' + fx(tx, 1) + '" y1="118" x2="' + fx(tx, 1) + '" y2="123" stroke="#2a3142" stroke-width="1"/>';
      if (ok) axis += '<text x="' + fx(tx, 1) + '" y="136" text-anchor="middle" class="tlax">' + fx(tv, tv % 1 ? 2 : 0) + "%</text>";
    }
    var bestRow = res.bestRow;
    axis += '<text x="' + (X1 - 2) + '" y="64" text-anchor="end" class="tlend">' +
      esc(bestRow.name) + (bestRow.tier ? " (" + bestRow.tier + ")" : "") + " · " + fx(bestRow.dmg, 2) + "%</text>";
    axis += '<text x="' + X0 + '" y="154" text-anchor="start" class="tlcap">% damage on ' +
      (grade === "relic" ? "a Relic" : "an Ancient") + " bracelet, for your character →</text>";
    axis += '<text x="' + X1 + '" y="154" text-anchor="end" class="tlcap">dashed cuts are the band thresholds (% of the best line)</text>';

    return '<svg viewBox="0 0 1000 162" role="img" aria-label="Every effect on a damage-percent axis with the tier thresholds drawn to scale">' +
      axis + cuts + letters + dots + "</svg>";
  }

  // ------------------------------------------------------------------
  // rows
  // ------------------------------------------------------------------

  var REG = {};        // tip id -> the row object; the popover HTML is built on hover
  var SEQ = 0;

  function rowHTML(r, grade, ghostPct) {
    var id = "tl" + (SEQ++);
    REG[id] = { row: r, grade: grade, ghost: ghostPct };
    var letter = P.letterOf("sp:" + r.fam.id, grade) || "F";
    var barHue = view === "roll" && r.tier ? RARITY[r.tier].hue : r.band.hue;
    var vals = r.valsOverride !== undefined ? r.valsOverride : tierValueText(r.fam, grade, r.tier || "mid");
    var ghost = "";
    if (ghostPct !== null && ghostPct !== undefined) {
      ghost = '<u class="tl-ghost" style="left:' + fx(Math.max(0, Math.min(100, ghostPct)), 2) + '%"></u>';
    }
    var rar = r.tier
      ? '<span class="tl-rar" style="background:' + RARITY[r.tier].hue + '" title="' + RARITY[r.tier].name + '"></span>'
      : "";
    return '<div class="tl-row" data-tip="' + id + '" data-key="' + esc(r.key) + '" tabindex="0" role="button" ' +
      'aria-label="' + esc(r.name + (r.tier ? " " + r.tier : "") + ", " + fx(r.dmg, 2) + " percent damage, band " + r.band.key) + '">' +
      '<span class="tl-rank">' + pad2(r.rank) + "</span>" +
      '<span class="tl-gl" style="color:' + r.band.hue + '" title="this row\'s band">' + r.band.key + "</span>" +
      '<span class="tl-nm">' + rar + esc(r.name) +
      (r.tier ? ' <em style="color:' + RARITY[r.tier].hue + '">' + RARITY[r.tier].name + "</em>" : "") + "</span>" +
      '<span class="tl-vals">' + esc(vals) + "</span>" +
      '<span class="tl-odds">' + fmtOdds(r.odds) + "</span>" +
      '<span class="tl-bar"><i style="width:' + fx(Math.max(0, Math.min(100, r.pct)), 2) + '%;background:' + barHue + '"></i>' + ghost + "</span>" +
      '<span class="tl-pct">' + fx(r.dmg, 2) + "%</span>" +
      "</div>";
  }

  function bandsHTML(res, grade) {
    var dr = defaultRank(grade);
    var out = "", i, j;
    for (i = 0; i < BANDS.length; i++) {
      var b = BANDS[i];
      var mine = [];
      for (j = 0; j < res.rows.length; j++) if (res.rows[j].band.key === b.key) mine.push(res.rows[j]);
      var body = "";
      for (j = 0; j < mine.length; j++) {
        var dref = dr.by[mine[j].key];
        var gp = (dref && dr.best > 0) ? dref.pct : null;
        body += rowHTML(mine[j], grade, gp);
      }
      // Empty bands are DRAWN, not skipped — an empty A tier is information.
      if (!body) {
        body = '<div class="tl-empty">nothing in the ' +
          (b.key === "F" ? "no damage" : b.key === "D" ? "&gt;0%" : "&#8805;" + b.pct + "%") + " band</div>";
      }
      out += '<section class="tl-band">' +
        '<div class="tl-chip' + (b.glow ? " tl-chip-z" : "") + (b.key === "S" ? " tl-chip-s" : "") +
        '" style="--tl-hue:' + b.hue + '"><span>' + b.key + "</span></div>" +
        '<div class="tl-rows">' + body + "</div></section>";
    }
    return out;
  }

  // ------------------------------------------------------------------
  // the hover card
  //
  // astrogem's data-tip registry: the row markup carries only an id, the content
  // is built on hover, and ONE floating node on <body> shows it. 60ms hide grace
  // so the pointer can travel from the row into the card.
  // ------------------------------------------------------------------

  function popEl() {
    var el = $("bctl-pop");
    if (!el) {
      el = document.createElement("div");
      el.id = "bctl-pop";
      el.className = "tl-pop";
      el.style.display = "none";
      document.body.appendChild(el);
    }
    return el;
  }
  function hidePop() { var el = $("bctl-pop"); if (el) el.style.display = "none"; }

  function tipHTML(entry, res) {
    var r = entry.row, grade = entry.grade, fam = r.fam;
    var dr = defaultRank(grade), dref = dr.by[r.key];
    var pill = '<span class="tp-pill' + (r.band.key === "S" ? " tlrb" : "") + '" style="background:' + r.band.hue + '">' + r.band.key + "</span>";
    var h = '<div class="tp-head">' + esc(r.name) + " " + pill +
      '<span class="tp-rank">#' + pad2(r.rank) + " of " + res.rows.length + "</span></div>";

    // the full official wording, placeholders and all
    h += '<div class="tp-full">' + esc(fam.label) + "</div>";

    // all three tiers, always — the row may be one of them, but the choice is
    // between three and the reader is deciding which they want.
    h += '<table class="tp-tbl"><thead><tr><th>Roll</th><th>Values</th><th class="tp-num">Odds</th>' +
      '<th class="tp-num">% dmg</th><th class="tp-num">of best</th></tr></thead><tbody>';
    for (var t = 0; t < TIERS.length; t++) {
      var tr = TIERS[t], d = r.tierD[t];
      var dmg = B.damagePercent(d);
      var p = res.best > 0 ? d / res.best * 100 : 0;
      var bd = d > 0 ? bandOf(p) : BANDS[BANDS.length - 1];
      var isMe = r.tier === tr;                       // the row's own tier, in the by-roll view
      h += '<tr class="' + (isMe ? "tp-best" : "") + '">' +
        '<td><span class="tp-rar" style="background:' + RARITY[tr].hue + '"></span>' +
        (isMe ? "&#9656; " : "") + RARITY[tr].name + '<span class="tp-dim"> ' + tr + "</span></td>" +
        "<td>" + esc(tierValueText(fam, grade, tr)) + "</td>" +
        '<td class="tp-num">' + fmtOdds(tierOdds(fam, tr)) + "</td>" +
        '<td class="tp-num">' + fx(dmg, 2) + "%</td>" +
        '<td class="tp-num"><span class="tp-tier' + (bd.key === "S" ? " tlrb" : "") + '" style="background:' + bd.hue + '">' +
        bd.key + "</span> " + fx(p, 1) + "%</td></tr>";
    }
    h += "</tbody></table>";

    // what it is worth to THIS character, and the arithmetic behind it
    var mult = Math.exp(r.d / 100);
    var kv = "";
    if (view === "family") {
      kv += '<span class="tp-k">average roll</span><span class="tp-v">0.6&#215;' + fx(r.tierD[0], 3) +
        " + 0.3&#215;" + fx(r.tierD[1], 3) + " + 0.1&#215;" + fx(r.tierD[2], 3) + " = " + fx(r.d, 3) + "</span>";
    }
    kv += '<span class="tp-k">score</span><span class="tp-v">' + fx(r.d, 3) +
      ' <span class="tp-dim">= 100 &#215; ln(' + fx(mult, 6) + ")</span></span>";
    kv += '<span class="tp-k">damage</span><span class="tp-v">' + fx(r.dmg, 3) +
      '% <span class="tp-dim">= (e<sup>' + fx(r.d, 3) + "/100</sup> &#8722; 1) &#215; 100</span></span>";
    kv += '<span class="tp-k">band</span><span class="tp-v">' + fx(r.pct, 1) + "% of the best line" +
      (r.band.key === "F" ? ' <span class="tp-dim">&#183; does no damage for this character</span>'
        : ' <span class="tp-dim">&#183; ' + fx(r.pct - r.band.pct, 1) + "pp above the " + r.band.key + " cut</span>") + "</span>";
    h += '<div class="tp-sec"><div class="tp-sec-h">Worth to your character</div><div class="tp-grid">' + kv + "</div></div>";

    // how your build differs from the canonical default
    if (dref) {
      var dd = r.pct - dref.pct;
      var word = Math.abs(dd) < 0.05 ? "the same place" : (dd > 0 ? "higher" : "lower");
      h += '<div class="tp-sec"><div class="tp-sec-h">Compared to the default character</div><div class="tp-grid">' +
        '<span class="tp-k">default</span><span class="tp-v">#' + pad2(dref.rank) + " &#183; " + fx(dref.dmg, 2) +
        "% &#183; " + fx(dref.pct, 1) + '% of best <span class="tp-tier" style="background:' + dref.band.hue + '">' + dref.band.key + "</span></span>" +
        '<span class="tp-k">yours</span><span class="tp-v">#' + pad2(r.rank) + " &#183; " + fx(r.dmg, 2) +
        "% &#183; " + fx(r.pct, 1) + "% of best</span>" +
        '<span class="tp-k">shift</span><span class="tp-v">' + (Math.abs(dd) < 0.05 ? "sits in " + word :
          (dd > 0 ? "+" : "") + fx(dd, 1) + "pp " + word + " for you") + "</span>" +
        "</div></div>";
    }

    // odds, and where they come from
    var o = view === "family" ? famOdds(fam) : tierOdds(fam, r.tier);
    h += '<div class="tp-sec"><div class="tp-sec-h">Odds of landing it</div><div class="tp-grid">' +
      '<span class="tp-k">per roll</span><span class="tp-v">' + fmtOdds(o) + ' <span class="tp-dim">&#183; ' + oneIn(o) + "</span></span>" +
      '<span class="tp-k">listed</span><span class="tp-v">' +
      (view === "family"
        ? fx(fam.granted.low + fam.granted.mid + fam.granted.high, 5) + "% across the three tiers"
        : fam.granted[r.tier] + "% for " + RARITY[r.tier].name) +
      '<span class="tp-dim"> &#183; &#215; 30 &#247; ' + fx(SPEC_SUM, 5) + "</span></span></div></div>";

    h += '<div class="tp-foot">Click the row to drop this effect into a Calculator slot.</div>';
    return h;
  }

  function positionPop(el, row) {
    var r = row.getBoundingClientRect();
    var pw = el.offsetWidth, ph = el.offsetHeight;
    var pad = 10, gap = 8;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var left = r.right + gap;                                   // prefer the right of the row
    if (left + pw > vw - pad) left = r.left - gap - pw;          // flip left if it would clip
    if (left < pad) left = Math.max(pad, Math.min(vw - pw - pad, r.left));   // last resort: clamp
    var top = r.top;
    if (top + ph > vh - pad) top = vh - ph - pad;
    if (top < pad) top = pad;
    el.style.left = (left + window.pageXOffset) + "px";
    el.style.top = (top + window.pageYOffset) + "px";
  }

  var popKey = null;                     // the row key the card is showing, across re-renders

  function wirePop() {
    var el = popEl(), hideT = null, cur = null;
    function showFor(row) {
      var id = row.getAttribute("data-tip");
      var entry = REG[id];
      if (!entry || !last) return;
      if (hideT) { clearTimeout(hideT); hideT = null; }
      cur = row;
      popKey = row.getAttribute("data-key");
      el.innerHTML = tipHTML(entry, last);
      el.style.display = "block";
      el.style.visibility = "hidden";                            // measure, then place
      positionPop(el, row);
      el.style.visibility = "visible";
    }
    function hide() {
      cur = null; popKey = null;
      hideT = setTimeout(function () { el.style.display = "none"; }, 60);
    }
    document.addEventListener("mouseover", function (e) {
      var row = e.target.closest ? e.target.closest(".tl-row[data-tip]") : null;
      if (row && row !== cur) showFor(row);
    });
    document.addEventListener("mouseout", function (e) {
      var to = e.relatedTarget;
      if (to && el.contains(to)) return;                          // moving into the card
      var row = e.target.closest ? e.target.closest(".tl-row[data-tip]") : null;
      if (row && to && row.contains(to)) return;                  // still inside the same row
      if (row) hide();
    });
    document.addEventListener("focusin", function (e) {
      var row = e.target.closest ? e.target.closest(".tl-row[data-tip]") : null;
      if (row) showFor(row);
    });
    document.addEventListener("focusout", function (e) {
      var row = e.target.closest ? e.target.closest(".tl-row[data-tip]") : null;
      if (row) hide();
    });
    el.addEventListener("mouseenter", function () { if (hideT) { clearTimeout(hideT); hideT = null; } });
    el.addEventListener("mouseleave", hide);
    window.addEventListener("resize", hidePop);
    document.addEventListener("tabselected", hidePop);
    // The table rebuilds under the pointer on every slider move; put the card
    // back on the same row rather than leaving it stranded on a dead node.
    reattachPop = function () {
      if (!popKey) return;
      var row = document.querySelector('.tl-row[data-key="' + popKey.replace(/"/g, '\\"') + '"]');
      if (row) showFor(row); else { popKey = null; el.style.display = "none"; }
    };
  }
  var reattachPop = function () {};

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------

  var last = null;                       // the current ranking, for the popover

  function copyHTML() {
    return '<div class="tl-copy">' +
      "<p><b>Bands are a percentage of the best line for <i>your</i> character.</b> " +
      "S is 98% of the best line or better, then A 95, B 90, C 85, D 80; anything under 80% is F. " +
      "That best line is whatever the profile below makes best, so <b>every number here moves when you change the profile</b> — " +
      "drag a slider and the table reorders under your hand, with no wait.</p>" +
      "<p>The small letter beside each name is a different thing: the family's grade on the " +
      '<span data-gloss="The canonical default character the leaderboard scores on. Family letters are fixed to it so they label a family, not a build, and never shuffle mid-edit.">default character</span>' +
      ", on the Calculator picker's own coarser ladder. It is here so the two tools can never disagree about a family — " +
      "the band chip is <i>your</i> character, the small letter is the picker's. " +
      "The faint tick on each bar is where the line sits for that default character: bar past the tick means it is worth more to you than to the average build.</p>" +
      "</div>";
  }

  function controlsHTML() {
    var S = P.get();
    var fight = S.fight;
    var backOn = fight.back > 0, frontOn = fight.front > 0;
    return '<div class="tl-ctl">' +
      '<div class="tl-seg" role="group" aria-label="View">' +
      '<button type="button" class="mbtn' + (view === "family" ? " active" : "") + '" data-view="family">By family <span class="tl-n">33</span></button>' +
      '<button type="button" class="mbtn' + (view === "roll" ? " active" : "") + '" data-view="roll">By roll <span class="tl-n">99</span></button>' +
      "</div>" +
      '<div class="tl-presets"><span class="tl-plabel">Presets</span>' +
      '<button type="button" class="mbtn' + (backOn && !frontOn ? " active" : "") + '" data-preset="back">Back attack</button>' +
      '<button type="button" class="mbtn' + (frontOn && !backOn ? " active" : "") + '" data-preset="front">Frontal</button>' +
      '<button type="button" class="mbtn' + (!backOn && !frontOn ? " active" : "") + '" data-preset="nonpos">Non-positional</button>' +
      '<button type="button" class="mbtn' + (fight.demon ? " active" : "") + '" data-preset="demon">Demon boss ' + (fight.demon ? "on" : "off") + "</button>" +
      "</div></div>";
  }

  function headHTML() {
    return '<div class="tl-head">' +
      '<span class="tl-rank">#</span>' +
      '<span class="tl-gl" data-gloss="The band this row sits in, for your current character.">band</span>' +
      '<span class="tl-nm">Effect</span>' +
      '<span class="tl-vals">' + (view === "family" ? "Roll (mid)" : "Roll") + "</span>" +
      '<span class="tl-odds" data-gloss="Chance one granted slot lands this, from the official listed percentages: renormalised by their own sum and scaled to the special category\'s 30 points.">Odds</span>' +
      '<span class="tl-bar">% of the best line</span>' +
      '<span class="tl-pct">Damage</span>' +
      "</div>";
  }

  function footHTML(res, grade) {
    var n = res.rows.length;
    return '<div class="tl-foot">' +
      "<b>" + n + (view === "family" ? " families" : " rolls") + "</b> on " +
      (grade === "relic" ? "a Relic" : "an Ancient") + " bracelet, ranked by the same % damage figure the Calculator reports. " +
      "Odds are the official listed probabilities, renormalised the way the disclosure page requires " +
      "(listed ÷ the listed sum, scaled to the 30-point special category). " +
      "A family whose every tier scores nothing sits in F at 0% — it is not broken, it is worth nothing to a damage dealer. " +
      "F is a wide band and most families live there; the rows inside it are still in order, and the strip above shows the real spread. " +
      "Combat traits and Vitality are not listed: rolled into a granted slot they score nothing at all." +
      "</div>";
  }

  function render() {
    var pane = $(PANE_ID);
    if (!pane) return;
    var S = P.get(), grade = S.grade;
    var res = rank(grade, P.profile());
    last = res;
    REG = {}; SEQ = 0;

    $("bctl-controls").innerHTML = controlsHTML();
    $("bctl-strip").innerHTML = stripSVG(res, grade);
    $("bctl-bands").innerHTML = headHTML() + bandsHTML(res, grade);
    $("bctl-foot").innerHTML = footHTML(res, grade);
    reattachPop();
  }

  // Coalesce into one frame: a slider drag fires many input events and the table
  // only has to be right once per paint. Still live — no debounce, no worker.
  //
  // A HIDDEN document never fires requestAnimationFrame, so a change made while
  // the page is in a background tab would leave the table showing the old
  // ranking until the next event after it came back. Fall back to a timer in
  // that case: the table is right the moment the page is looked at again.
  var frame = 0;
  function runFrame() {
    frame = 0;
    try { render(); } catch (e) { /* a bad frame must not kill the subscription */ }
  }
  function schedule() {
    if (frame) return;
    if (window.requestAnimationFrame && !document.hidden) frame = window.requestAnimationFrame(runFrame);
    else frame = setTimeout(runFrame, 16);
  }

  // ------------------------------------------------------------------
  // interactions
  // ------------------------------------------------------------------

  var PRESETS = {
    back: { back: 100, front: 0, nonDir: 100 },
    front: { back: 0, front: 100, nonDir: 100 },
    nonpos: { back: 0, front: 0, nonDir: 100 }
  };

  /** Drop an effect into the first empty granted slot, then show the Calculator. */
  function tryInCalculator(key) {
    var m = /^[fr](\d+)(?::(low|mid|high))?$/.exec(key);
    if (!m) return;
    var id = Number(m[1]), tier = m[2] || "mid";
    var S = P.get(), rows = [], i, target = -1;
    for (i = 0; i < S.rows.length; i++) {
      rows.push({ fam: S.rows[i].fam, tier: S.rows[i].tier, value: S.rows[i].value });
      if (target === -1 && (!S.rows[i].fam || S.rows[i].fam === "none")) target = i;
    }
    if (!rows.length) return;
    if (target === -1) target = rows.length - 1;      // every slot full: replace the last
    rows[target] = { fam: "sp:" + id, tier: tier, value: null };
    // A granted row changing voids any cut in progress, exactly as the picker does.
    P.set({ rows: rows, locks: null, rolled: null });
    if (typeof window.selectTab === "function") window.selectTab("calculator");
  }

  function bind(pane) {
    pane.addEventListener("click", function (e) {
      var t = e.target;
      var vb = t.closest ? t.closest("[data-view]") : null;
      if (vb) { view = vb.getAttribute("data-view"); hidePop(); render(); return; }
      var pb = t.closest ? t.closest("[data-preset]") : null;
      if (pb) {
        var k = pb.getAttribute("data-preset");
        if (k === "demon") P.set({ fight: { demon: !P.get().fight.demon } });
        else P.set({ fight: PRESETS[k] });
        return;                                       // P.set notifies; the table redraws itself
      }
      var row = t.closest ? t.closest(".tl-row[data-key]") : null;
      if (row) tryInCalculator(row.getAttribute("data-key"));
    });
    pane.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var row = e.target.closest ? e.target.closest(".tl-row[data-key]") : null;
      if (!row) return;
      e.preventDefault();
      tryInCalculator(row.getAttribute("data-key"));
    });
  }

  // ------------------------------------------------------------------
  // styles
  //
  // Injected from here rather than added to styles.css: this tab owns its look,
  // every rule is inside the tl- namespace, and the shared sheet belongs to the
  // shell. Dark only, like the rest of the tool.
  // ------------------------------------------------------------------

  function injectStyle() {
    if ($("bctl-style")) return;
    var css = "" +
      "#tab-tierlist .tl-copy{color:var(--dim);font-size:13px;line-height:1.6;max-width:78ch;margin:0 0 14px}" +
      "#tab-tierlist .tl-copy p{margin:0 0 8px}#tab-tierlist .tl-copy b{color:var(--text);font-weight:600}" +
      "#tab-tierlist .tl-copy i{font-style:italic;color:var(--text)}" +
      "#tab-tierlist .tl-ctl{display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin:14px 0 4px}" +
      "#tab-tierlist .tl-seg,#tab-tierlist .tl-presets{display:flex;gap:6px;align-items:center;flex-wrap:wrap}" +
      "#tab-tierlist .tl-plabel{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-right:2px}" +
      "#tab-tierlist .tl-n{opacity:.6;font-weight:400;font-size:11px;margin-left:3px}" +
      // the spread strip
      "#tab-tierlist .tl-strip{margin:16px 0 4px;padding-bottom:8px;border-bottom:1px solid var(--border)}" +
      "#tab-tierlist .tl-strip svg{width:100%;height:auto;display:block}" +
      "#tab-tierlist .tlax,#tab-tierlist .tlcap{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:10.5px;fill:var(--dim)}" +
      "#tab-tierlist .tlend{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;fill:var(--text)}" +
      "#tab-tierlist .tlrl{font-size:16px;font-weight:800}" +
      // the table
      "#tab-tierlist .tl-head,#tab-tierlist .tl-row{display:grid;grid-template-columns:26px 16px minmax(140px,1fr) 128px 62px minmax(90px,180px) 60px;" +
      "gap:10px;align-items:center}" +
      "#tab-tierlist .tl-head{padding:14px 8px 6px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}" +
      "#tab-tierlist .tl-head .tl-bar,#tab-tierlist .tl-head .tl-pct,#tab-tierlist .tl-head .tl-odds{background:none;border:0}" +
      "#tab-tierlist .tl-band{display:grid;grid-template-columns:64px 1fr;gap:14px;padding:14px 0;border-bottom:1px solid var(--border)}" +
      "#tab-tierlist .tl-band:last-child{border-bottom:none}" +
      "#tab-tierlist .tl-chip{align-self:start;position:sticky;top:8px}" +
      "#tab-tierlist .tl-chip span{display:flex;width:64px;height:64px;align-items:center;justify-content:center;" +
      "background:var(--tl-hue);color:#0d1017;border-radius:6px;font-size:30px;font-weight:900;line-height:1}" +
      "#tab-tierlist .tl-chip-z span{box-shadow:0 0 26px rgba(232,205,138,.38)}" +
      // S tier: 90deg so the gradient's two ends are the same red and the tile has
      // no seam; 0%->400% is exactly three tile widths, so the slide loops clean.
      "#tab-tierlist .tl-chip-s span{background:linear-gradient(90deg,#FF8A80,#FFC46B,#F8E081,#8CE99A,#7FD0FF,#C9A2FF,#FF8A80);background-size:400% 100%}" +
      "#tab-tierlist .tlrb,.tl-pop .tlrb{will-change:filter}" +
      "#tab-tierlist .tl-rows{min-width:0}" +
      "#tab-tierlist .tl-row{padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12.5px}" +
      "#tab-tierlist .tl-row:nth-child(even){background:rgba(255,255,255,.022)}" +
      "#tab-tierlist .tl-row:hover{background:var(--panel2);outline:1px solid var(--border)}" +
      "#tab-tierlist .tl-row:focus-visible{outline:2px solid var(--accent);outline-offset:1px}" +
      "#tab-tierlist .tl-rank{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;color:var(--dim);text-align:right}" +
      "#tab-tierlist .tl-gl{font-weight:900;font-size:12px;text-align:center}" +
      "#tab-tierlist .tl-nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#tab-tierlist .tl-nm em{font-style:normal;font-size:10px;letter-spacing:.04em;text-transform:uppercase;opacity:.85}" +
      "#tab-tierlist .tl-rar{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;vertical-align:1px}" +
      "#tab-tierlist .tl-vals{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#tab-tierlist .tl-odds{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;color:var(--dim);text-align:right}" +
      "#tab-tierlist .tl-bar{position:relative;height:9px;background:var(--panel2);border-radius:5px;overflow:visible}" +
      "#tab-tierlist .tl-head .tl-bar{height:auto;background:none}" +
      "#tab-tierlist .tl-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:5px;display:block}" +
      "#tab-tierlist .tl-ghost{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;background:var(--text);" +
      "opacity:.55;text-decoration:none;border-radius:1px}" +
      "#tab-tierlist .tl-pct{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;text-align:right;font-variant-numeric:tabular-nums}" +
      "#tab-tierlist .tl-empty{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;color:var(--dim);opacity:.7;padding:12px 8px}" +
      "#tab-tierlist .tl-foot{margin-top:18px;color:var(--dim);font-size:12px;line-height:1.65;max-width:82ch}" +
      "#tab-tierlist .tl-foot b{color:var(--text)}" +
      // the hover card
      ".tl-pop{position:absolute;z-index:9999;max-width:460px;min-width:360px;background:#10131c;border:1px solid var(--border);" +
      "border-radius:8px;box-shadow:0 10px 34px rgba(0,0,0,.62);padding:11px 13px;color:var(--text);font:12px/1.45 inherit}" +
      ".tl-pop .tp-head{font-size:13px;font-weight:800;color:var(--accent);margin-bottom:6px;display:flex;align-items:center;gap:8px}" +
      ".tl-pop .tp-pill{font-size:10px;letter-spacing:.04em;color:#0d1017;border-radius:99px;padding:1px 8px;font-weight:900}" +
      ".tl-pop .tp-rank{margin-left:auto;font-family:'SF Mono',Menlo,monospace;font-size:10px;color:var(--dim);font-weight:400}" +
      ".tl-pop .tp-full{font-size:11.5px;color:var(--dim);margin:0 0 8px;line-height:1.4}" +
      ".tl-pop .tp-tbl{width:100%;border-collapse:collapse;margin:0 0 4px;font-size:11.5px}" +
      ".tl-pop .tp-tbl th{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);font-weight:700;" +
      "text-align:left;padding:2px 4px;border-bottom:1px solid var(--border)}" +
      ".tl-pop .tp-tbl th.tp-num{text-align:right}" +
      ".tl-pop .tp-tbl td{padding:3px 4px;border-bottom:1px solid #1c2230;font-variant-numeric:tabular-nums}" +
      ".tl-pop .tp-tbl tr:last-child td{border-bottom:none}" +
      ".tl-pop td.tp-num{text-align:right;font-family:'SF Mono',Menlo,monospace;font-size:11px}" +
      ".tl-pop .tp-rar{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:5px}" +
      ".tl-pop .tp-tier{display:inline-block;min-width:15px;text-align:center;border-radius:4px;color:#0d1017;font-size:10px;" +
      "font-weight:900;padding:0 4px;line-height:1.4}" +
      ".tl-pop .tp-best td{color:var(--text);font-weight:700}" +
      ".tl-pop .tp-dim{color:var(--dim);font-weight:400;font-size:10.5px}" +
      ".tl-pop .tp-sec{margin-top:8px;border-top:1px solid var(--border);padding-top:7px}" +
      ".tl-pop .tp-sec-h{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);font-weight:800;margin-bottom:5px}" +
      ".tl-pop .tp-grid{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;align-items:baseline}" +
      ".tl-pop .tp-k{font-size:9.5px;color:var(--dim);font-weight:700;text-transform:uppercase;letter-spacing:.04em}" +
      ".tl-pop .tp-v{font-size:11.5px;font-variant-numeric:tabular-nums}" +
      ".tl-pop .tp-v sup{font-size:8.5px}" +
      ".tl-pop .tp-foot{margin-top:8px;font-size:10.5px;color:var(--dim);opacity:.85}" +
      // motion, with a static fallback that is the same gradient standing still
      "@media (prefers-reduced-motion:no-preference){" +
      "#tab-tierlist .tl-chip-s span{animation:tl-slide 8s linear infinite}" +
      "#tab-tierlist .tlrb,.tl-pop .tlrb{animation:tl-hue 6s linear infinite}" +
      "@keyframes tl-slide{from{background-position:0% 50%}to{background-position:400% 50%}}" +
      "@keyframes tl-hue{from{filter:hue-rotate(0deg)}to{filter:hue-rotate(360deg)}}}" +
      // Phones: seven columns will not fit, and squeezing them turns the effect
      // name into two characters. Give the name the full width on its own line
      // and put the bar, the odds and the damage on a second — and drop the
      // column header, which no longer describes anything.
      "@media (max-width:760px){" +
      "#tab-tierlist .tl-head{display:none}" +
      "#tab-tierlist .tl-row{grid-template-columns:22px 14px minmax(0,1fr) 58px 52px;" +
      "grid-template-areas:'rank gr nm nm nm' 'bar bar bar odds pct';gap:4px 7px;padding:7px 4px}" +
      "#tab-tierlist .tl-row .tl-rank{grid-area:rank}#tab-tierlist .tl-row .tl-gl{grid-area:gr}" +
      "#tab-tierlist .tl-row .tl-nm{grid-area:nm}#tab-tierlist .tl-row .tl-bar{grid-area:bar;align-self:center}" +
      "#tab-tierlist .tl-row .tl-odds{grid-area:odds}#tab-tierlist .tl-row .tl-pct{grid-area:pct}" +
      "#tab-tierlist .tl-vals{display:none}" +
      "#tab-tierlist .tl-band{grid-template-columns:44px 1fr;gap:10px}" +
      "#tab-tierlist .tl-chip span{width:44px;height:44px;font-size:22px;border-radius:5px}" +
      "#tab-tierlist .tl-row{font-size:12px;padding:5px 4px}" +
      ".tl-pop{max-width:calc(100vw - 20px);min-width:0}}";
    var st = document.createElement("style");
    st.id = "bctl-style";
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------
  // init
  // ------------------------------------------------------------------

  function init() {
    var pane = $(PANE_ID);
    if (!pane || pane.getAttribute("data-init")) return;
    pane.setAttribute("data-init", "1");
    injectStyle();
    pane.innerHTML = copyHTML() +
      '<div id="' + DECK_HOST + '"></div>' +
      '<div id="bctl-controls"></div>' +
      '<div class="tl-strip" id="bctl-strip"></div>' +
      '<div id="bctl-bands"></div>' +
      '<div id="bctl-foot"></div>';
    bind(pane);
    wirePop();
    claimDeck();
    P.onChange(function () { schedule(); });     // every change, no debounce: scoring is free
    render();
  }

  /**
   * The deck is one element that MOVES (profile.js's header). Claim it whenever
   * this tab is the one on screen; app.js claims it back for the Calculator.
   */
  function claimDeck() {
    var host = $(DECK_HOST);
    if (host) P.mount(host);
  }

  document.addEventListener("tabselected", function (e) {
    if (!e || !e.detail || e.detail.tab !== "tierlist") return;
    init();
    claimDeck();
    schedule();
  });

  init();
})();
