/**
 * subrank.js — ONE subrank ladder for the whole tool, and the 0–100 bracelet
 * grade that rides on it.
 *
 * There used to be two ladders: the Tier List banded on six letters of its own,
 * and the Leaderboard had none. Both now read this file, so a letter means the
 * same thing wherever it appears.
 *
 * THE LADDER — astrogem's subranks, on flat 5-point bands of a percentage:
 *   S+ >=95  S >=90  S- >=85   A+ >=80  A >=75  A- >=70
 *   B+ >=65  B >=60  B- >=55   C+ >=50  C >=45  C- >=40
 *   D+ >=35  D >=30  D- >=25   F+ >=20  F >=10  F- <10
 * F is deliberately WIDE (20 points across F+ and F): a line worth a tenth of
 * the best line is not "one step worse" than a line worth a fifth, and F- is
 * reserved for the rows that are worth nothing at all.
 *
 * THE COLOURS are the astrogem calculator's, ported from its model/astrogem.js
 * rankColor() unchanged — F/D grey, C green, B blue, A purple as ramp anchors,
 * the intermediate steps read off that one ramp, and A+ through S+ leaving it
 * for an explicit cool-elite arc that ends on pale champagne. The two tools show
 * the same letter in the same colour, which is the whole point of porting rather
 * than inventing. Astrogem's ladder stops at F; our F+ and F- fall through to
 * its own +/- tilt on the F grey, which is what that fallback is for.
 *
 * THE BRACELET GRADE. braceletScore() maps a whole bracelet onto the same 0–100
 * scale the ladder bands:
 *
 *   score = 100 · (total − floor) / (perfect − floor),  clamped to [0, 100]
 *
 *   total   = Bracelet.setDamage(lines, grade, profile)
 *           + Bracelet.traitDamage(traits, profile)
 *     BOTH terms. setDamage() scores a combat trait in a granted slot as ZERO —
 *     only the two trait lines the bracelet came with carry value, and those
 *     come through traitDamage(). Dropping the second term was a live bug once;
 *     it is why the two are added here and never anywhere else.
 *   perfect = the three highest-scoring DISTINCT special families at `high`
 *             tier, plus two combat traits at the grade's cap (120 Ancient,
 *             100 Relic).
 *   floor   = two combat traits at 40 and three lines worth nothing — i.e. just
 *             traitDamage({crit:40, spec:40}). Shizu's rule: an empty bracelet
 *             with 40/40 and three junk lines scores 0.
 *
 * Everything is in LOG SPACE (the model's D units), not in converted
 * percentages: the model adds in log space, so the scale has to.
 *
 * On the canonical default profile, Ancient: perfect = 22.87% damage,
 * floor = 2.00% damage. Those two numbers are the anchors — check them before
 * believing anything else this file says.
 *
 * NO NETWORK, no state, no DOM. Pure arithmetic over window.Bracelet.
 */
(function (root) {
  "use strict";

  var B = (typeof module !== "undefined" && module.exports)
    ? require("./model/bracelet.js")
    : root.Bracelet;

  // ------------------------------------------------------------------
  // the ladder
  // ------------------------------------------------------------------

  // key, and the percentage at which the band OPENS. Descending, so the first
  // band whose min a percentage clears is the band it belongs to.
  var LADDER = [
    ["S+", 95], ["S", 90], ["S-", 85],
    ["A+", 80], ["A", 75], ["A-", 70],
    ["B+", 65], ["B", 60], ["B-", 55],
    ["C+", 50], ["C", 45], ["C-", 40],
    ["D+", 35], ["D", 30], ["D-", 25],
    ["F+", 20], ["F", 10], ["F-", -Infinity]
  ];

  // ---- astrogem's rank palette, ported verbatim from model/astrogem.js -------
  //
  // Grade-tier colours (the owner's percentile palette): F/D grey, C green,
  // B blue, A purple. These five are the ramp ANCHORS; C- through A- are read
  // off the ramp (RANK_STOPS).
  var RANK_COLORS = {
    F: { bg: "#6f747a", fg: "#ffffff" },
    D: { bg: "#6f747a", fg: "#ffffff" },
    C: { bg: "#4f9d5d", fg: "#ffffff" },
    B: { bg: "#3b7fd0", fg: "#ffffff" },
    A: { bg: "#7e5cc0", fg: "#ffffff" }
  };
  // The TOP of the ladder leaves the ramp for a smooth cool-elite arc — A purple
  // -> A+ violet -> S- orchid -> S rose -> S+ pale champagne. Explicit points,
  // not ramp mixes, so they read cleanly. Dark fg on the light champagne.
  var TOP_TIER = {
    "A+": { bg: "#a660be", fg: "#ffffff" },
    "S-": { bg: "#c15cad", fg: "#ffffff" },
    "S": { bg: "#cc5c81", fg: "#ffffff" },
    "S+": { bg: "#e6d5a6", fg: "#4a3a1e" }
  };
  // A PERFECT bracelet transcends the spectrum with the animated pastel rainbow
  // from the old tier list — `bg` is a GRADIENT, not a hex, dropped straight into
  // `background:`, and the `rank-rainbow` class adds the tiling and the seamless
  // slide. 90deg, so the two ends are the same red and the tile has no seam; a
  // diagonal gradient seams when tiled, which is the loa-tierlist lesson.
  // This is gated on a PERFECT SCORE, never on the band: an S+ bracelet is not a
  // perfect one, and the rainbow has to mean the ceiling and nothing else.
  var RAINBOW = {
    bg: "linear-gradient(90deg,#FF8A80,#FFC46B,#F8E081,#8CE99A,#7FD0FF,#C9A2FF,#FF8A80)",
    fg: "#2b2440",
    cls: "rank-rainbow"
  };

  /** Mix a hex toward white (amt > 0) or black (amt < 0). amt is 0..1. */
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var p = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      return Math.max(0, Math.min(255, Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt))));
    });
    return "#" + p.map(function (c) { return (c < 16 ? "0" : "") + c.toString(16); }).join("");
  }
  /** Mix two hexes: t=0 gives a, t=1 gives b. */
  function mix(a, b, t) {
    var x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
    var p = [16, 8, 0].map(function (sh) {
      var ca = (x >> sh) & 255, cb = (y >> sh) & 255;
      return Math.max(0, Math.min(255, Math.round(ca + (cb - ca) * t)));
    });
    return "#" + p.map(function (c) { return (c < 16 ? "0" : "") + c.toString(16); }).join("");
  }
  // The mid ranks are evenly spaced points on ONE ramp: D grey -> C green ->
  // B blue -> A purple, so C- through A- read as a single gradient.
  var RANK_STOPS = {
    "C-": ["D", "C", 2 / 3],
    "C+": ["C", "B", 1 / 3],
    "B-": ["C", "B", 2 / 3],
    "B+": ["B", "A", 1 / 3],
    "A-": ["B", "A", 2 / 3]
  };
  var RANK_TILT = 0.28;    // fallback for D and F, whose neighbours are the same grey

  /**
   * colorOf(key[, perfect]) -> { bg, fg, cls? }
   *
   * `bg` is a CSS background value — a hex for every rank, a gradient for the
   * rainbow — and `fg` the text colour to put on it. Pass perfect=true only for
   * a bracelet that scored a flat 100.
   */
  function colorOf(rank, perfect) {
    if (perfect) return RAINBOW;
    if (!rank) return RANK_COLORS.F;
    if (TOP_TIER[rank]) return TOP_TIER[rank];
    var stop = RANK_STOPS[rank];
    if (stop) return { bg: mix(RANK_COLORS[stop[0]].bg, RANK_COLORS[stop[1]].bg, stop[2]), fg: "#ffffff" };
    var base = RANK_COLORS[rank.charAt(0)] || RANK_COLORS.F;
    var mod = rank.charAt(1);
    if (mod !== "+" && mod !== "-") return base;
    // F+ and F- land here — astrogem's ladder has no such steps, and its own
    // +/- tilt on the F grey is exactly the right answer for them.
    return { bg: shade(base.bg, mod === "+" ? RANK_TILT : -RANK_TILT), fg: base.fg };
  }

  var BANDS = LADDER.map(function (e, i) {
    var c = colorOf(e[0]);
    return {
      key: e[0],
      min: e[1],            // the percentage at which this band opens (-Infinity for F-)
      bg: c.bg,
      fg: c.fg,
      hue: c.bg,            // the fill to use where there is no text on top (dots, bars)
      i: i,                 // 0 = S+, 17 = F-
      top: i === 0,
      letter: e[0].charAt(0)
    };
  });

  var BY_KEY = {};
  for (var bi = 0; bi < BANDS.length; bi++) BY_KEY[BANDS[bi].key] = BANDS[bi];

  var BOTTOM = BANDS[BANDS.length - 1];        // F- — where a worthless line is pinned

  /** of(pct) -> the band a percentage falls in. Not a number -> the bottom band. */
  function of(pct) {
    if (typeof pct !== "number" || !isFinite(pct)) return BOTTOM;
    for (var i = 0; i < BANDS.length; i++) if (pct >= BANDS[i].min) return BANDS[i];
    return BOTTOM;
  }

  // ------------------------------------------------------------------
  // the bracelet grade
  // ------------------------------------------------------------------

  // The highest a combat trait rolls, per grade. Same numbers bible-import.js and
  // leaderboard.js check a decode against.
  var TRAIT_MAX = { relic: 100, ancient: 120 };
  var TRAIT_FLOOR = 40;      // below the lowest real roll on either grade, on purpose

  var canonCache = {};       // grade -> anchors on the canonical default profile

  function canonProfile() { return B.normalizeProfile({}); }

  /**
   * Every family x tier score for one grade and profile, best first. The by-roll
   * tier list's own list, minus the main-stat row — which never comes near the
   * top and would only slow this down.
   */
  function rollScores(grade, profile) {
    var out = [], S = B.DATA.SPECIALS, tiers = ["low", "mid", "high"], i, t;
    for (i = 0; i < S.length; i++) {
      for (t = 0; t < tiers.length; t++) {
        out.push(B.lineDamage({ cat: "special", family: S[i].id, tier: tiers[t] }, grade, profile));
      }
    }
    out.sort(function (a, b) { return b - a; });
    return out;
  }

  /**
   * The strongest single roll available on a grade — the yardstick the by-roll
   * tier list bands on, and the one the Leaderboard's per-line subranks use, so
   * the two can never disagree about what an S+ line is.
   */
  function bestRoll(grade, profile) {
    return anchorsFor(grade, profile).best;
  }

  function computeAnchors(grade, profile) {
    var d = rollScores(grade, profile);
    // The three highest DISTINCT families, not the three highest rolls: a single
    // family cannot fill three slots, so "three of the best line" is not a
    // bracelet anyone can own.
    var S = B.DATA.SPECIALS, byFam = [], i;
    for (i = 0; i < S.length; i++) {
      byFam.push(B.lineDamage({ cat: "special", family: S[i].id, tier: "high" }, grade, profile));
    }
    byFam.sort(function (a, b) { return b - a; });
    var cap = TRAIT_MAX[grade] || TRAIT_MAX.ancient;
    return {
      best: d.length ? d[0] : 0,
      perfect: byFam[0] + byFam[1] + byFam[2] + B.traitDamage({ crit: cap, spec: cap }, profile),
      floor: B.traitDamage({ crit: TRAIT_FLOOR, spec: TRAIT_FLOOR }, profile)
    };
  }

  /**
   * Anchors for a grade. The canonical default profile is cached — it is a
   * constant and the Leaderboard asks for it once per row; anything else is
   * computed on the spot, which costs 99 lineDamage() calls and no one notices.
   */
  function anchorsFor(grade, profile) {
    if (!profile) {
      if (!canonCache[grade]) canonCache[grade] = computeAnchors(grade, canonProfile());
      return canonCache[grade];
    }
    return computeAnchors(grade, profile);
  }

  /**
   * braceletScore({lines, traits, grade, profile}) ->
   *   { score, band, total, floor, perfect, damagePct }
   *
   * `lines` are the effect lines — granted AND locked, but NOT the two combat
   * traits the bracelet came with; those are `traits`, as {crit, spec, swift}
   * point values, and they score through traitDamage(). Leave `profile` out for
   * the canonical default character, which is what the Leaderboard wants.
   */
  function braceletScore(opts) {
    opts = opts || {};
    var grade = opts.grade === "relic" ? "relic" : "ancient";
    var prof = opts.profile || null;
    var a = anchorsFor(grade, prof);
    var p = prof || canonProfile();
    var total = B.setDamage(opts.lines || [], grade, p) + B.traitDamage(opts.traits || {}, p);
    var span = a.perfect - a.floor;
    var s = span > 0 ? 100 * (total - a.floor) / span : 0;
    if (!isFinite(s)) s = 0;
    if (s < 0) s = 0;
    if (s > 100) s = 100;
    return {
      score: s,
      band: of(s),
      // The rainbow's one gate. A flat 100 means three of the best distinct
      // families at their best roll with both traits capped — not "very good".
      // Named isPerfect, not perfect: `perfect` below is the ANCHOR, and one
      // object cannot carry both spellings without the flag silently losing.
      isPerfect: s >= 100,
      total: total,
      floor: a.floor,
      perfect: a.perfect,
      damagePct: B.damagePercent(total)
    };
  }

  var API = {
    BANDS: BANDS,
    BY_KEY: BY_KEY,
    BOTTOM: BOTTOM,
    RAINBOW: RAINBOW,
    TRAIT_MAX: TRAIT_MAX,
    TRAIT_FLOOR: TRAIT_FLOOR,
    of: of,
    colorOf: colorOf,
    bestRoll: bestRoll,
    anchorsFor: anchorsFor,
    braceletScore: braceletScore
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Subrank = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
