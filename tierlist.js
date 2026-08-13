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
 * BANDING: the shared eighteen-step subrank ladder in subrank.js, applied to
 * 100 x d / THE ANCHOR OF THIS VIEW — see rank() for what each view anchors on
 * and why the two differ.
 *
 * A line that does no damage is pinned to F- whatever the arithmetic says. On a
 * six-band ladder every empty band was drawn, because an empty A tier was
 * information; on eighteen it is noise, so empty bands are skipped and the strip
 * above the table carries the shape of the distribution instead.
 *
 * ALWAYS THE DEFAULT CHARACTER (Shizu, 2026-08-12: "for tier list lets just make
 * it simple and remove character select / character board and leave it to our
 * defaults"). This tab had a character picker and the shared control deck; both
 * are gone. Every row is scored on Bracelet.normalizeProfile({}) — the canonical
 * build, every setting untouched — so the ranking is a fact about the game rather
 * than about whoever last dragged a slider on another tab.
 *
 * That buys three simplifications. There is no window.Profile here at all, so a
 * deck edit on the Calculator cannot move this table and this table cannot move
 * the Calculator. The GHOST TICK is gone with it: it marked where each line sat
 * for the default character, and on a table that IS the default character it sat
 * under the end of every bar, always. And the anchors below are stable, because
 * nothing can move them.
 *
 * WHAT STILL TOGGLES: the view (by family / by roll), the bracelet grade, and the
 * two fight presets. All four are THIS TAB'S OWN state — plain module variables,
 * never persisted, never written into the shared profile. The presets patch the
 * default profile for the ranking and stop there.
 *
 * NO NETWORK OF ITS OWN. This file opens no connection and reads no character.
 */
(function () {
  "use strict";

  var B = window.Bracelet, DATA = window.BraceletData, SR = window.Subrank;
  if (!B || !DATA || !SR) return;                // model, data or ladder missing; leave the placeholder

  var PANE_ID = "tab-tierlist";

  // ---- this tab's own state. Four variables, none of them shared, none saved ----
  var gradeSel = "ancient";                      // the same grade profile.js starts on
  // The deck's own names, not the model's: `supportEffects` means "count the four
  // party lines", the model's `supportHasEffects` means the opposite. Both start
  // where the deck starts, so an untouched table is normalizeProfile({}) exactly.
  var fight = { supportEffects: true, demon: false };

  /** The default character, with only this tab's two presets patched in. */
  function tlProfile() {
    return B.normalizeProfile({
      supportHasEffects: !fight.supportEffects,
      demonShare: fight.demon ? 1 : 0
    });
  }

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

  // The tier list has its OWN ladder, anchored differently from the Leaderboard's
  // (Shizu, 2026-08-11).
  //
  // THE ANCHOR IS THE BEST EPIC ROLL, NOT THE BEST ROLL. Set that to 100 and the
  // scale reads the way a player already thinks: the five best families' Legendary
  // rolls clear 100 and take S+, their Epics land S (the best Epic is exactly
  // 100.0 by construction), and their Rares land S-. A Legendary is meant to look
  // better than full marks, because it is.
  //
  // Everything below S+ is a flat five-point step. S- comes out EMPTY on the
  // default profile — the gap between the Epic cluster (~98-100) and the Rare one
  // (~87-89) is real, and Shizu would rather see the gap than bend the ladder to
  // hide it. Empty bands are simply not drawn.
  var TL_BANDS = [
    { key: "S+", pct: 100.1 }, { key: "S",  pct: 95 }, { key: "S-", pct: 90 },
    { key: "A+", pct: 85 },    { key: "A",  pct: 80 }, { key: "A-", pct: 75 },
    { key: "B+", pct: 70 },    { key: "B",  pct: 65 }, { key: "B-", pct: 60 },
    { key: "C+", pct: 55 },    { key: "C",  pct: 50 }, { key: "C-", pct: 45 },
    { key: "D+", pct: 40 },    { key: "D",  pct: 35 }, { key: "D-", pct: 30 },
    { key: "F+", pct: 20 },    { key: "F",  pct: 0.0001 }, { key: "F-", pct: 0 }
  ];
  var BANDS = SR.BANDS;
  var BOTTOM = SR.BOTTOM;

  /**
   * The cut this tab opens a band at — TL_BANDS, never the shared ladder's own
   * `min`. The two ladders carry the same eighteen keys and DIFFERENT numbers, and
   * reading the wrong one is a wrong sentence about a right colour.
   */
  function tlCutOf(key) {
    for (var i = 0; i < TL_BANDS.length; i++) if (TL_BANDS[i].key === key) return TL_BANDS[i].pct;
    return 0;
  }
  /** The cut of the band ABOVE this one, or null at the top of the ladder. */
  function tlCeilOf(key) {
    for (var i = 0; i < TL_BANDS.length; i++) if (TL_BANDS[i].key === key) return i ? TL_BANDS[i - 1].pct : null;
    return null;
  }

  function tlBand(key) {
    var c = SR.colorOf(key, key === "S+");           // S+ takes the rainbow
    // `bg` and `hue` are the same value under two names: the strip and dots read
    // `hue`, the chips and pills read `bg`.
    // `min` is this band's own cut. It used to be left off, so the hover card's
    // "N pp above the X cut" read `undefined` on every row, failed its isFinite
    // test and told the reader that the best line in the game was under the F cut.
    return { key: key, min: tlCutOf(key), bg: c.bg, hue: c.bg, fg: c.fg, cls: c.cls, glow: key === "S+" };
  }
  /**
   * pct is a percentage of the anchor (the best Epic roll = 100). A line worth no
   * damage is F- outright, never a band it could reach on arithmetic alone.
   */
  function bandFor(d, pct) {
    if (d <= 0) return tlBand("F-");
    for (var i = 0; i < TL_BANDS.length; i++) if (pct >= TL_BANDS[i].pct) return tlBand(TL_BANDS[i].key);
    return tlBand("F-");
  }


  // The six letter GROUPS, for the strip: eighteen dashed cuts and eighteen
  // letters on one 1000-unit axis is a picket fence. The strip draws one cut per
  // GROUP boundary — 85, 70, 55, 40, 25 — and one letter per group, which is the
  // old six-band picture with the ladder's own colours on it.
  var GROUPS = (function () {
    var out = [], i, b;
    for (i = 0; i < BANDS.length; i++) {
      b = BANDS[i];
      if (!out.length || out[out.length - 1].letter !== b.letter) {
        out.push({ letter: b.letter, hue: BANDS[Math.min(i + 1, BANDS.length - 1)].hue, bottom: 0 });
      }
      out[out.length - 1].bottom = isFinite(b.min) ? b.min : 0;
    }
    return out;                       // descending: S 85, A 70, B 55, C 40, D 25, F 0
  })();

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

  /**
   * The by-family view keeps the placeholders — the row is an average across all
   * three tiers, so a concrete number would be a lie. "+X%" reads as "some
   * amount", which is exactly what the row means.
   */
  function famTemplateLabel(fam) {
    return fam.label
      .replace(/\(1\/party\)/g, "")
      .replace(/\s+([;,])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
  }


  /**
   * The family's own wording with the roll substituted in, so a row reads the way
   * the line reads in game — "Crit Damage +10%; on crit, damage +1.5%" — rather
   * than a name and a separate column of numbers.
   *
   * Placeholders come in order: A then B, or a lone X. Flat stats (weapon power,
   * main stat) print with a thousands separator and no percent sign.
   */
  function namedWithValues(fam, grade, tier) {
    var vals = fam.values[grade][tier];
    // Word boundaries matter: without them the A in "ally AP buff" gets eaten and
    // the row reads "ally 3P buff". Only a standalone A, B or X is a placeholder.
    return fam.label
      .replace(/\(1\/party\)/g, "")
      .replace(/\b([ABX])\b(%?)/g, function (m, letter, pct) {
        var i = (letter === "B") ? 1 : 0;
        var v = vals[i];
        if (v === undefined) return m;
        return pct ? v + "%" : nf(v);
      })
      .replace(/\s+([;,])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
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

  var view = "roll";                                // "family" | "roll"

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
   * The whole cost of this tab: 33 families x 3 tiers of lineDamage, once. It ran
   * twice while a ghost marker needed the default ranking beside the live one;
   * the table IS the default ranking now, so one pass is the whole job.
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
          odds: famOdds(fam), name: famTemplateLabel(fam)
        });
      } else {
        for (t = 0; t < TIERS.length; t++) {
          rows.push({
            key: "r" + fam.id + ":" + TIERS[t], fam: fam, tier: TIERS[t], d: d[t], tierD: d,
            odds: tierOdds(fam, TIERS[t]), name: namedWithValues(fam, grade, TIERS[t])
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

    // THE ANCHOR — what scores 100 — IS THE BEST THING IN THIS VIEW, and the two
    // views hold different things.
    //
    // BY ROLL it is the best EPIC (mid-tier) roll, not the best row. A Legendary
    // then scores above 100, which is the point: full marks is what a good Epic
    // gets, and beating it should look like beating it. Shizu designed that scale
    // and likes it, so it is untouched.
    //
    // BY FAMILY it is the best FAMILY AVERAGE. A family row is 0.6 low + 0.3 mid +
    // 0.1 high, which is necessarily well below a pure Epic roll — so scoring that
    // view against the best Epic put the best family in the game at 94.2 and read
    // S-, and the whole top of the table with it. Nothing about that is a fact a
    // player would recognise; it is the wrong yardstick (Shizu, 2026-08-12: "by
    // family tier list the S- tier should be S or S+"). Anchored on the best
    // family the top four read S. Nothing reaches S+ there, and cannot: S+ is
    // above the anchor, and nothing beats the row the scale is built on.
    //
    // Main stat is skipped when picking the family anchor — it is a basic line
    // riding along, not a special family — but it is still SCORED against it, so
    // it may sit above 100 if it ever out-earns every family.
    var best = rows.length ? rows[0].d : 0;          // the top row, for the bars
    var anchor = 0;
    if (view === "family") {
      for (i = 0; i < rows.length; i++) if (!rows[i].isBasic && rows[i].d > anchor) anchor = rows[i].d;
    } else {
      for (i = 0; i < DATA.SPECIALS.length; i++) {
        var mid = B.lineDamage({ cat: "special", family: DATA.SPECIALS[i].id, tier: "mid" }, grade, prof);
        if (mid > anchor) anchor = mid;
      }
    }
    if (anchor <= 0) anchor = best;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      r.rank = i + 1;
      r.pct = anchor > 0 ? r.d / anchor * 100 : 0;        // the score: this view's anchor = 100
      // The BAR stays a share of the #1 line, in both views. Drawing it against the
      // Epic anchor made every Legendary overflow its own track, which just looked
      // broken.
      r.barPct = best > 0 ? r.d / best * 100 : 0;
      r.band = bandFor(r.d, r.pct);
      r.dmg = B.damagePercent(r.d);
    }
    return { rows: rows, best: best, anchor: anchor, bestRow: rows[0] || null };
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
      dots += '<circle cx="' + fx(x, 1) + '" cy="' +
        (106 - lane * laneDy) + '" r="4.6" fill="' + fill + '" stroke="#0d1017" stroke-width="1.6">' +
        "<title>" + esc(e.name) + (e.tier ? " (" + e.tier + ")" : "") + " — " + fx(e.dmg, 2) +
        " (score " + fx(e.pct, 1) + ")</title></circle>";
    }

    // the GROUP cuts, drawn to scale: this IS the methodology. One per letter
    // group rather than one per subrank — eighteen dashed lines across 930 units
    // is a fence, not a chart, and the group edges are the ones a reader reasons
    // about ("this is B territory").
    var cuts = "", letters = "", cutXs = [];
    for (i = 0; i < GROUPS.length; i++) {
      var g = GROUPS[i];
      var upper = i === 0 ? hi : maxDmg * GROUPS[i - 1].bottom / 100;
      var lower = g.bottom ? maxDmg * g.bottom / 100 : lo;
      if (g.bottom && lower > lo && lower < hi) {
        var cx = X(lower);
        cutXs.push(cx);
        cuts += '<line x1="' + fx(cx, 1) + '" y1="68" x2="' + fx(cx, 1) +
          '" y2="124" stroke="#97a0b4" stroke-width="1" stroke-dasharray="2 4" opacity=".55"/>' +
          '<text x="' + fx(cx, 1) + '" y="140" text-anchor="middle" class="tlax">' + g.bottom + "%</text>";
      }
      var l = Math.max(lower, lo), u = Math.min(upper, hi);
      if (u > l && (u - l) / (hi - lo) > 0.03) {
        letters += '<text x="' + fx((X(l) + X(u)) / 2, 1) + '" y="46" text-anchor="middle" class="tlrl' +
          '" fill="' + g.hue + '">' + g.letter + "</text>";
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
      (grade === "relic" ? "a Relic" : "an Ancient") + " bracelet, on the default character →</text>";
    axis += '<text x="' + X1 + '" y="154" text-anchor="end" class="tlcap">dashed cuts are the letter-group edges (% of the best line); each group holds three subranks</text>';

    return '<svg viewBox="0 0 1000 162" role="img" aria-label="Every effect on a damage-percent axis with the tier thresholds drawn to scale">' +
      axis + cuts + letters + dots + "</svg>";
  }

  // ------------------------------------------------------------------
  // rows
  // ------------------------------------------------------------------

  var REG = {};        // tip id -> the row object; the popover HTML is built on hover
  var SEQ = 0;

  function rowHTML(r, grade) {
    var id = "tl" + (SEQ++);
    REG[id] = { row: r, grade: grade };
    var barHue = view === "roll" && r.tier ? RARITY[r.tier].hue : r.band.hue;
    var vals = r.valsOverride !== undefined ? r.valsOverride : tierValueText(r.fam, grade, r.tier || "mid");
    var rar = r.tier
      ? '<span class="tl-rar" style="background:' + RARITY[r.tier].hue + '" title="' + RARITY[r.tier].name + '"></span>'
      : "";
    // A plain row. It used to be a button that dropped its effect into a
    // Calculator slot; Shizu cut that (2026-08-11), and with it the role, the
    // tab stop and the pointer cursor that promised it. The hover card is the
    // row's whole interaction now — tabindex stays so the card is still
    // reachable from the keyboard, but the row no longer claims to be a control.
    return '<div class="tl-row" data-tip="' + id + '" data-key="' + esc(r.key) + '" tabindex="0" ' +
      'aria-label="' + esc(r.name + (r.tier ? " " + r.tier : "") + ", " + fx(r.dmg, 2) + " percent damage, band " + r.band.key) + '">' +
      '<span class="tl-rank">' + pad2(r.rank) + "</span>" +
      // S+ is a GRADIENT, so it paints the chip background with the .rank-rainbow
      // tiling class rather than a text colour.
      (r.band.cls
        ? '<span class="tl-gl ' + r.band.cls + '" style="background:' + r.band.bg +
          ";color:" + (r.band.fg || "#2b2440") + '" title="top five — nothing honest separates them">' +
          r.band.key + "</span>"
        : '<span class="tl-gl" style="color:' + r.band.bg +
      '" title="this row\'s subrank">' + r.band.key + "</span>") +
      '<span class="tl-nm">' + rar + esc(r.name) +
      (r.tier ? ' <em style="color:' + RARITY[r.tier].hue + '">' + RARITY[r.tier].name + "</em>" : "") + "</span>" +
      '<span class="tl-vals">' + esc(vals) + "</span>" +
      '<span class="tl-bar"><i style="width:' + fx(Math.max(0, Math.min(100, r.barPct)), 2) + '%;background:' + barHue + '"></i></span>' +
      '<span class="tl-score">' + fx(r.pct, 1) + "</span>" +
      '<span class="tl-pct">' + fx(r.dmg, 2) + "%</span>" +
      "</div>";
  }

  /**
   * One section per band THAT HAS ROWS. On the old six-band ladder every band
   * was drawn even when empty, because an empty A tier said something; at
   * eighteen steps most of the ladder is empty in any one view and drawing it
   * all buries the rows under a wall of "nothing here". The strip above already
   * shows where the gaps are, to scale.
   */
  function bandsHTML(res, grade) {
    var out = "", i, j;
    for (i = 0; i < BANDS.length; i++) {
      var b = BANDS[i];
      var mine = [];
      for (j = 0; j < res.rows.length; j++) if (res.rows[j].band.key === b.key) mine.push(res.rows[j]);
      if (!mine.length) continue;
      var body = "";
      for (j = 0; j < mine.length; j++) body += rowHTML(mine[j], grade);
      out += '<section class="tl-band">' +
        '<div class="tl-chip' + (b.top ? " tl-chip-z" : "") +
        '" style="--tl-bg:' + b.bg + ';--tl-fg:' + b.fg + '"><span data-gloss="' + esc(bandGloss(b, res)) + '">' +
        esc(b.key) + "</span></div>" +
        '<div class="tl-rows">' + body + "</div></section>";
    }
    return out;
  }

  /** What a band chip means, in one sentence, for the tooltip. */
  function bandGloss(b, res) {
    var best = res.bestRow;
    var name = best ? (best.name + (best.tier ? " (" + best.tier + ")" : "")) : "the best line";
    if (b === BOTTOM) {
      return "F- — worth nothing at all, or so near it that it rounds there. " +
        "A line that does no damage is pinned here whatever the arithmetic says.";
    }
    var lo = tlCutOf(b.key), hi = tlCeilOf(b.key);
    return b.key + " — " + (hi === null ? lo + "% of this view's anchor and up" : lo + "% to " + hi + "% of this view's anchor") +
      ". The top line is " + name + ", at " + fx(best ? best.dmg : 0, 2) + "% damage on the default character.";
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
    var pill = '<span class="tp-pill" style="background:' + r.band.bg + ';color:' + r.band.fg + '">' + r.band.key + "</span>";
    var h = '<div class="tp-head">' + esc(r.name) + " " + pill +
      '<span class="tp-rank">#' + pad2(r.rank) + " of " + res.rows.length + "</span></div>";

    // the full official wording, placeholders and all
    h += '<div class="tp-full">' + esc(fam.label) + "</div>";

    // all three tiers, always — the row may be one of them, but the choice is
    // between three and the reader is deciding which they want.
    h += '<table class="tp-tbl"><thead><tr><th>Roll</th><th>Values</th><th class="tp-num">Odds</th>' +
      '<th class="tp-num">% dmg</th><th class="tp-num">score</th></tr></thead><tbody>';
    for (var t = 0; t < TIERS.length; t++) {
      var tr = TIERS[t], d = r.tierD[t];
      var dmg = B.damagePercent(d);
      // res.anchor, never a second reckoning of it: this card must band a tier the
      // same way the row it came from does, and two ways of computing one number is
      // how the card and the row came to disagree once already.
      var p = res.anchor > 0 ? d / res.anchor * 100 : 0;
      // Find this tier's own rank in the current ranking so the card cannot show a
      // different band than the row it came from (the top five are S+ by rank, not
      // by percentage, so a rank-blind lookup here would read S).
      var tRank = null, tKey = "r" + fam.id + ":" + tr;
      for (var tq = 0; tq < res.rows.length; tq++) {
        if (res.rows[tq].key === tKey) { tRank = res.rows[tq].rank; break; }
      }
      var bd = bandFor(d, p);
      var isMe = r.tier === tr;                       // the row's own tier, in the by-roll view
      h += '<tr class="' + (isMe ? "tp-best" : "") + '">' +
        '<td><span class="tp-rar" style="background:' + RARITY[tr].hue + '"></span>' +
        (isMe ? "&#9656; " : "") + RARITY[tr].name + '<span class="tp-dim"> ' + tr + "</span></td>" +
        "<td>" + esc(tierValueText(fam, grade, tr)) + "</td>" +
        '<td class="tp-num">' + fmtOdds(tierOdds(fam, tr)) + "</td>" +
        '<td class="tp-num">' + fx(dmg, 2) + "%</td>" +
        '<td class="tp-num"><span class="tp-tier" style="background:' + bd.bg + ';color:' + bd.fg + '">' +
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
    kv += '<span class="tp-k">subrank</span><span class="tp-v">' + fx(r.pct, 1) + "% of the anchor" +
      (r.d <= 0 ? ' <span class="tp-dim">&#183; does no damage, so F-</span>'
        : ' <span class="tp-dim">&#183; ' + fx(r.pct - r.band.min, 1) + "pp above the " + r.band.key + " cut at " +
          r.band.min + "%</span>") + "</span>";
    h += '<div class="tp-sec"><div class="tp-sec-h">What it is worth</div><div class="tp-grid">' + kv + "</div></div>";

    // A "compared to the default character" section used to sit here. The table is
    // the default character now, so both of its columns would carry the same three
    // numbers.

    // odds, and where they come from
    var o = view === "family" ? famOdds(fam) : tierOdds(fam, r.tier);
    h += '<div class="tp-sec"><div class="tp-sec-h">Odds of landing it</div><div class="tp-grid">' +
      '<span class="tp-k">per roll</span><span class="tp-v">' + fmtOdds(o) + ' <span class="tp-dim">&#183; ' + oneIn(o) + "</span></span>" +
      '<span class="tp-k">listed</span><span class="tp-v">' +
      (view === "family"
        ? fx(fam.granted.low + fam.granted.mid + fam.granted.high, 5) + "% across the three tiers"
        : fam.granted[r.tier] + "% for " + RARITY[r.tier].name) +
      '<span class="tp-dim"> &#183; &#215; 30 &#247; ' + fx(SPEC_SUM, 5) + "</span></span></div></div>";

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

  /**
   * The explainer sits at the BOTTOM in a collapsed <details>, the same shape as
   * astrogem's method blocks — the table should be the first thing you see, not a
   * wall of prose (Shizu, 2026-08-11).
   */
  function copyHTML() {
    return '<details class="method tl-method"><summary>How these ranks are worked out</summary>' +
      "<p><b>Every row is scored on the " +
      '<span data-gloss="Bracelet.normalizeProfile({}) — the canonical build, every setting untouched. The Leaderboard scores on the same one.">default character</span>' +
      ", not on yours.</b> " +
      "Nothing you do on the Calculator moves this table, and nothing you do here moves the " +
      "Calculator. The three controls above are this tab's own: the view, the bracelet grade, and " +
      "the two fight toggles.</p>" +
      "<p><b>Each view is scored against the best line in that view</b>, and the two are not the same " +
      "line. By roll the anchor is the best <i>Epic</i>, set to 100: the five Legendary crit and shred " +
      "lines clear it and take the rainbow <b>S+</b>, their Epics land <b>S</b>, their Rares land " +
      "<b>S-</b>. Beating a good Epic ought to look like beating it. By family every row is an " +
      "odds-weighted average of all three tiers (0.6 low + 0.3 mid + 0.1 high), which no average can " +
      "push as high as a pure Epic — so that view anchors on the best <i>family average</i> instead. " +
      "Judged against the best Epic the best family in the game came out at 94.2 and read S-, which " +
      "told a player nothing true.</p>" +
      "<p>The ladder is a flat five-point step: <b>S</b> from 95%, <b>S-</b> from 90%, <b>A+</b> from " +
      "85%, on down to <b>F-</b>, which means the line does no damage at all. <b>S+</b> sits above the " +
      "anchor, so only the by-roll view reaches it. The <b>bar</b> measures something else and always " +
      "has: it is the line as a share of the #1 row, so the top bar is always full.</p>" +
      "<p>These bands are more lenient than the Leaderboard's, deliberately: that one scores a whole " +
      "bracelet against a perfect one, this ranks a single line against the best single line.</p>" +
      "</details>";
  }

  /**
   * Three groups, all of them local. The grade pair replaces the one this tab used
   * to borrow from the shared deck: the table is ranked per grade, and both grades
   * are worth reading, so the control has to live somewhere.
   */
  function controlsHTML() {
    return '<div class="tl-ctl">' +
      '<div class="tl-seg" role="group" aria-label="View">' +
      '<button type="button" class="mbtn' + (view === "family" ? " active" : "") + '" data-view="family">By family <span class="tl-n">33</span></button>' +
      '<button type="button" class="mbtn' + (view === "roll" ? " active" : "") + '" data-view="roll">By roll <span class="tl-n">99</span></button>' +
      "</div>" +
      '<div class="tl-seg" role="group" aria-label="Bracelet grade">' +
      '<span class="tl-plabel">Grade</span>' +
      '<button type="button" class="mbtn' + (gradeSel === "ancient" ? " active" : "") + '" data-grade="ancient">Ancient</button>' +
      '<button type="button" class="mbtn' + (gradeSel === "relic" ? " active" : "") + '" data-grade="relic">Relic</button>' +
      "</div>" +
      '<div class="tl-presets"><span class="tl-plabel">Fight</span>' +
      '<button type="button" class="mbtn' + (fight.supportEffects ? " active" : "") + '" data-preset="support"' +
      ' data-gloss="On: you are the one bringing the party debuffs, so the four party lines score in full. Off: your support already applies them — they apply once per party, so a copy on your bracelet is worth nothing.">' +
      "Support effects · " + (fight.supportEffects ? "on" : "off") + "</button>" +
      '<button type="button" class="mbtn' + (fight.demon ? " active" : "") + '" data-preset="demon"' +
      ' data-gloss="On: the fight is a Demon or Archdemon boss, so demon-damage lines score in full. Off: they score nothing.">' +
      "Demon boss · " + (fight.demon ? "on" : "off") + "</button>" +
      "</div>" +
      "</div>";
  }

  function headHTML() {
    return '<div class="tl-head">' +
      '<span class="tl-rank">#</span>' +
      '<span class="tl-gl" data-gloss="The subrank this row sits in: its damage as a percentage of this view&apos;s anchor, on the shared S+ to F- ladder.">rank</span>' +
      '<span class="tl-nm">Effect</span>' +
      '<span class="tl-vals">' + (view === "family" ? "Roll (mid)" : "Roll") + "</span>" +
      '<span class="tl-bar" data-gloss="This line as a share of the #1 line in the table, so the top bar is always full. The Score beside it measures something else — see that column.">% of the best line</span>' +
      '<span class="tl-score" data-gloss="' +
      (view === "family"
        ? "Score for this line, with the best FAMILY AVERAGE set to 100. A family row averages all three tiers, so it can never reach a pure Epic roll — this view is scored against the best of its own kind."
        : "Score for this line, with the best EPIC roll set to 100. A Legendary scores above 100 — beating a good Epic is exactly what that should look like.") +
      '">Score</span>' +
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
      "A family whose every tier scores nothing sits in F- at 0% — it is not broken, it is worth nothing to a damage dealer. " +
      "F- is a wide band and most families live there; the rows inside it are still in order, and the strip above shows the real spread. " +
      "A subrank nobody landed in is left out rather than drawn empty — at eighteen steps that is most of them. " +
      "Combat traits and Vitality are not listed: rolled into a granted slot they score nothing at all." +
      "</div>";
  }

  function render() {
    var pane = $(PANE_ID);
    if (!pane) return;
    // The default character, patched by this tab's own two toggles and nothing
    // else. window.Profile is not consulted, so no edit made anywhere else in the
    // app can move a row here.
    var res = rank(gradeSel, tlProfile());
    last = res;
    REG = {}; SEQ = 0;

    $("bctl-controls").innerHTML = controlsHTML();
    $("bctl-strip").innerHTML = stripSVG(res, gradeSel);
    $("bctl-bands").innerHTML = headHTML() + bandsHTML(res, gradeSel);
    $("bctl-foot").innerHTML = footHTML(res, gradeSel);
    reattachPop();
  }

  // Coalesce into one frame. Nothing drags on this tab any more, but a rebuild is
  // still cheap enough to ask for freely and this keeps two asks in one paint.
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

  // Clicking a row used to drop its effect into the first empty granted slot and
  // jump to the Calculator. Shizu cut it (2026-08-11): the table is for reading,
  // and a whole-row click target under a hover card was one interaction too many.
  // The buttons in the control row are the only things here that still act.
  //
  // Each of them moves a MODULE variable and calls render(). None of them touches
  // window.Profile: these four settings belong to this table, and a player who
  // turns the demon boss on to read the shred lines has not asked the Calculator
  // to re-price their bracelet.

  function bind(pane) {
    pane.addEventListener("click", function (e) {
      var t = e.target;
      if (!t.closest) return;
      var vb = t.closest("[data-view]");
      if (vb) { view = vb.getAttribute("data-view"); hidePop(); render(); return; }
      var gb = t.closest("[data-grade]");
      if (gb) { gradeSel = gb.getAttribute("data-grade"); hidePop(); render(); return; }
      var pb = t.closest("[data-preset]");
      if (pb) {
        var k = pb.getAttribute("data-preset");
        if (k === "demon") fight.demon = !fight.demon;
        else if (k === "support") fight.supportEffects = !fight.supportEffects;
        else return;
        hidePop(); render();
      }
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
      "#tab-tierlist .tl-ctl{display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin:0 0 4px}" +
      "#tab-tierlist .tl-seg,#tab-tierlist .tl-presets{display:flex;gap:6px;align-items:center;flex-wrap:wrap}" +
      "#tab-tierlist .tl-plabel{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-right:2px}" +
      "#tab-tierlist .tl-n{opacity:.6;font-weight:400;font-size:11px;margin-left:3px}" +
      "#tab-tierlist .tl-ctl .mbtn[disabled]{opacity:.45;cursor:default}" +
      // the spread strip
      "#tab-tierlist .tl-strip{margin:16px 0 4px;padding-bottom:8px;border-bottom:1px solid var(--border)}" +
      "#tab-tierlist .tl-strip svg{width:100%;height:auto;display:block}" +
      "#tab-tierlist .tlax,#tab-tierlist .tlcap{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:10.5px;fill:var(--dim)}" +
      "#tab-tierlist .tlend{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;fill:var(--text)}" +
      "#tab-tierlist .tlrl{font-size:16px;font-weight:800}" +
      // the table
      "#tab-tierlist .tl-head,#tab-tierlist .tl-row{display:grid;grid-template-columns:26px 26px minmax(140px,1fr) 128px minmax(90px,180px) 52px 60px;" +
      "gap:10px;align-items:center}" +
      "#tab-tierlist .tl-head{padding:14px 8px 6px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);font-weight:600}" +
      "#tab-tierlist .tl-head .tl-bar,#tab-tierlist .tl-head .tl-pct{background:none;border:0}" +
      "#tab-tierlist .tl-band{display:grid;grid-template-columns:64px 1fr;gap:14px;padding:14px 0;border-bottom:1px solid var(--border)}" +
      "#tab-tierlist .tl-band:last-child{border-bottom:none}" +
      "#tab-tierlist .tl-chip{align-self:start;position:sticky;top:8px}" +
      // 18 subranks means two-character chips ("S+", "B-"), so the type is sized
      // to the widest of them rather than to a single letter.
      "#tab-tierlist .tl-chip span{display:flex;width:64px;height:64px;align-items:center;justify-content:center;" +
      "background:var(--tl-bg);color:var(--tl-fg);border-radius:6px;font-size:26px;font-weight:900;line-height:1;" +
      "letter-spacing:-.02em;text-decoration:none;cursor:help}" +
      // The champagne S+ gets a glow and nothing else. The animated rainbow is
      // reserved for a bracelet that scored a flat 100 on the Leaderboard: if the
      // top BAND wore it, it would stop meaning the ceiling.
      "#tab-tierlist .tl-chip-z span{box-shadow:0 0 26px rgba(230,213,166,.38)}" +
      "#tab-tierlist .tl-rows{min-width:0}" +
      // Not a control: no pointer cursor. The row highlights on hover and on
      // focus because that is when its card is showing, not to invite a click.
      "#tab-tierlist .tl-row{padding:5px 8px;border-radius:6px;font-size:12.5px}" +
      "#tab-tierlist .tl-row:nth-child(even){background:rgba(255,255,255,.022)}" +
      "#tab-tierlist .tl-row:hover{background:var(--panel2);outline:1px solid var(--border)}" +
      "#tab-tierlist .tl-row:focus-visible{outline:2px solid var(--accent);outline-offset:1px}" +
      "#tab-tierlist .tl-rank{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;color:var(--dim);text-align:right}" +
      "#tab-tierlist .tl-gl{font-weight:900;font-size:12px;text-align:center;letter-spacing:-.03em;white-space:nowrap}" +
      // The S+ rainbow. 90deg, NOT diagonal: a diagonal gradient's left and right
      // edges differ, so a repeat-tiled background seams visibly at the wrap.
      // 400% spans three whole tiles, so the slide loops with no visible reset.
      "#tab-tierlist .tl-gl.rank-rainbow{background-size:400% 100%;border-radius:4px;padding:1px 5px}" +
      "@media (prefers-reduced-motion:no-preference){" +
      "#tab-tierlist .tl-gl.rank-rainbow{animation:tl-rb-slide 8s linear infinite}" +
      "@keyframes tl-rb-slide{from{background-position:0% 50%}to{background-position:400% 50%}}}" +
      "#tab-tierlist .tl-nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#tab-tierlist .tl-nm em{font-style:normal;font-size:10px;letter-spacing:.04em;text-transform:uppercase;opacity:.85}" +
      "#tab-tierlist .tl-rar{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:6px;vertical-align:1px}" +
      "#tab-tierlist .tl-vals{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      "#tab-tierlist .tl-score{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;font-weight:700;text-align:right;color:var(--text)}" +
      "#tab-tierlist .tl-head .tl-score{background:none;border:0;font-weight:600;color:var(--dim)}" +
      "#tab-tierlist .tl-bar{position:relative;height:9px;background:var(--panel2);border-radius:5px;overflow:hidden}" +
      "#tab-tierlist .tl-head .tl-bar{height:auto;background:none}" +
      "#tab-tierlist .tl-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:5px;display:block}" +
      "#tab-tierlist .tl-pct{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:12px;text-align:right;font-variant-numeric:tabular-nums}" +
      "#tab-tierlist .tl-foot{margin-top:18px;color:var(--dim);font-size:12px;line-height:1.65;max-width:82ch}" +
      "#tab-tierlist .tl-foot b{color:var(--text)}" +
      // the hover card
      ".tl-pop{position:absolute;z-index:9999;max-width:460px;min-width:360px;background:#10131c;border:1px solid var(--border);" +
      "border-radius:8px;box-shadow:0 10px 34px rgba(0,0,0,.62);padding:11px 13px;color:var(--text);font:12px/1.45 inherit}" +
      ".tl-pop .tp-head{font-size:13px;font-weight:800;color:var(--accent);margin-bottom:6px;display:flex;align-items:center;gap:8px}" +
      ".tl-pop .tp-pill{font-size:10px;letter-spacing:.04em;border-radius:99px;padding:1px 8px;font-weight:900}" +
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
      ".tl-pop .tp-tier{display:inline-block;min-width:15px;text-align:center;border-radius:4px;font-size:10px;" +
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
      "#tab-tierlist .tl-chip-z span{box-shadow:0 0 26px rgba(230,213,166,.38),0 0 42px rgba(230,213,166,.18)}}" +
      // Phones: seven columns will not fit, and squeezing them turns the effect
      // name into two characters. Give the name the full width on its own line
      // and put the bar, the odds and the damage on a second — and drop the
      // column header, which no longer describes anything.
      "@media (max-width:760px){" +
      "#tab-tierlist .tl-head{display:none}" +
      "#tab-tierlist .tl-row{grid-template-columns:22px 22px minmax(0,1fr) 46px 52px;" +
      "grid-template-areas:'rank gr nm nm nm' 'bar bar bar sc pct';gap:4px 7px;padding:7px 4px}" +
      "#tab-tierlist .tl-row .tl-rank{grid-area:rank}#tab-tierlist .tl-row .tl-gl{grid-area:gr}" +
      "#tab-tierlist .tl-row .tl-nm{grid-area:nm}#tab-tierlist .tl-row .tl-bar{grid-area:bar;align-self:center}" +
      "#tab-tierlist .tl-row .tl-pct{grid-area:pct}" +
      "#tab-tierlist .tl-row .tl-score{grid-area:sc;text-align:right}" +
      "#tab-tierlist .tl-vals{display:none}" +
      "#tab-tierlist .tl-band{grid-template-columns:44px 1fr;gap:10px}" +
      "#tab-tierlist .tl-chip span{width:44px;height:44px;font-size:18px;border-radius:5px}" +
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
    pane.innerHTML =
      '<div id="bctl-controls"></div>' +
      '<div class="tl-strip" id="bctl-strip"></div>' +
      '<div id="bctl-bands"></div>' +
      '<div id="bctl-foot"></div>' +
      copyHTML();                                  // explainer last, collapsed
    bind(pane);
    wirePop();
    render();
  }

  // The character picker and the shared control deck both used to be mounted here.
  // Shizu removed them (2026-08-12) — see the header. Nothing replaced them: this
  // tab never claims the deck, so the deck simply stays wherever the Calculator or
  // the Advisor last put it, and switching through the Tier List and back cannot
  // strand it.

  document.addEventListener("tabselected", function (e) {
    if (!e || !e.detail || e.detail.tab !== "tierlist") return;
    init();
    schedule();
  });

  init();
})();
