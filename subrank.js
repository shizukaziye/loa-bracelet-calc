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
 *   perfect = the three highest-scoring DISTINCT special families at `mid`
 *             (Epic) tier, plus two combat traits at 110 (Ancient) / 92 (Relic).
 *             A REACHABLE good bracelet, not a theoretical maximum — so scores
 *             run past 100 and S+ means you beat it.
 *   floor   = both combat traits at the BOTTOM of the grade's band (61 Ancient,
 *             41 Relic) and three lines worth nothing — i.e. just traitDamage()
 *             on that pair. Shizu's rule: the worst bracelet the game can hand
 *             you scores 0.
 *   ceiling = the literal maximum: the three best distinct families at their
 *             HIGH (Legendary) roll plus both traits at the top of the band.
 *             Nothing to do with the scale — it is what isPerfect tests, and it
 *             is the only thing that earns the rainbow.
 *
 * Everything is in LOG SPACE (the model's D units), not in converted
 * percentages: the model adds in log space, so the scale has to.
 *
 * THE ANCHORS, read off model VERSION 0.4.0 on 2026-08-14. Ancient, damage
 * dealer: perfect = 19.97% damage, floor = 3.01%, ceiling = 22.76% (score 115.1).
 * Ancient, support: perfect = 6.44%, floor = 0.60%, ceiling = 7.54% (score 118.1).
 * They move whenever the model moves — this file computes them, it does not
 * carry them, and the version stamp is here so a reader can tell a stale quote
 * from a wrong one. Print anchorsFor("ancient") before believing anything else
 * this file says.
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
  // S+ starts just past 100 because 100 is the ANCHOR — a reachable good bracelet
  // (three best families at Epic, traits at 110), not a maximum. Clearing it is
  // the whole meaning of S+. Everything below is a flat five-point step.
  var LADDER = [
    ["S+", 100.1], ["S", 95], ["S-", 90],
    ["A+", 85], ["A", 80], ["A-", 75],
    ["B+", 70], ["B", 65], ["B-", 60],
    ["C+", 55], ["C", 50], ["C-", 45],
    ["D+", 40], ["D", 35], ["D-", 30],
    ["F+", 20], ["F", 10], ["F-", -Infinity]
  ];

  /**
   * The SUPPORT ladder, cut so that a letter means the same RARITY it means on
   * the DPS one — a support A- is as rare as a damage dealer's A-.
   *
   * The two axes already share a score shape and both normalise to their own
   * floor and anchor, but their distributions have different SHAPES. A support's
   * value is packed into six families where a dealer's is spread over thirty, so
   * the same cut lands at a different rarity on each and a shared ladder would
   * make every support rank a quiet lie. The astrogem calculator hit this first
   * and answered it the same way: match the rarities, not the numbers.
   *
   * Produced by tools/rank-match.mjs, which is exact rather than sampled — the
   * model's own DP returns the whole distribution of finished line scores after
   * seven attempts of optimal keep-or-replace, and that is convolved with the two
   * combat traits drawn from Stove's weighted bands.
   *
   * ROUNDED, on Shizu's call (2026-08-14). The exact rarity-matched cuts are
   * arbitrary decimals — 98.8, 83.2, 60.5 — so these are the nearest ladder built
   * from round numbers with a constant gap inside each stretch: a 10-point step
   * below S+, then 7.5 down the letter grades to B, then a flat 5 all the way to
   * the bottom.
   *
   * The two ends are chosen rather than fitted, and both mean something:
   *   S+ = 100  you reached the anchor, exactly as on the DPS ladder
   *   F  = 0    the worst bracelet the game can hand you — both combat traits at
   *             the bottom of the band and three lines worth nothing
   *
   * The rounding costs a mean rarity error of ×1.11, and every band holds real
   * occupancy rather than sitting empty for the look of the thing. Reusing the DPS
   * numbers outright would cost ×4.26 with B+ landing 8.5× too rare, which is why
   * this is not simply the same ladder twice.
   *
   * Rerun tools/rank-match.mjs after any change that moves a line's damage, then
   * tools/support-ladder-round.mjs to re-round against the new exact cuts.
   *
   * EVERY band is matched, S+ included: on the corrected distribution a fresh
   * Ancient bracelet reaches 115 on the DPS axis and 118 on the support one, so
   * there is real mass above 100 and no band needs guessing at.
   *
   * The first version of this table was WRONG, and the way it was wrong is worth
   * recording. tools/rank-match.mjs called Bracelet.solve() with invented key
   * names — `lines` and `traits` rather than `fixedLines`, `grantedLines`,
   * `traitValues` and `slots`. Every one fell through to a default, so it solved
   * TWO granted slots instead of three with the combat-trait category still live
   * in the draw pool, which put a 35% chance of a dead line on every slot of
   * every roll. The tell was that the DP's optimal play scored BELOW a crude
   * threshold heuristic, which an optimal solver cannot do; tools/roll-sim.mjs
   * exists to catch exactly that.
   */
  var SUPPORT_LADDER = [
    ["S+", 100], ["S", 90], ["S-", 82.5],
    ["A+", 75], ["A", 67.5], ["A-", 60],
    ["B+", 52.5], ["B", 45], ["B-", 40],
    ["C+", 35], ["C", 30], ["C-", 25],
    ["D+", 20], ["D", 15], ["D-", 10],
    ["F+", 5], ["F", 0], ["F-", -Infinity]
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
  // This is gated on THE CEILING, never on the band: an S+ bracelet is not a
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

  function buildBands(ladder) {
    return ladder.map(function (e, i) {
      var c = colorOf(e[0]);
      return {
        key: e[0],
        min: e[1],          // the percentage at which this band opens (-Infinity for F-)
        bg: c.bg,
        fg: c.fg,
        hue: c.bg,          // the fill to use where there is no text on top (dots, bars)
        i: i,               // 0 = S+, 17 = F-
        top: i === 0,
        letter: e[0].charAt(0)
      };
    });
  }

  var BANDS = buildBands(LADDER);
  var SUPPORT_BANDS = buildBands(SUPPORT_LADDER);

  /** The ladder a role reads. Same colours and same letters, different cuts. */
  function bandsFor(role) { return role === "support" ? SUPPORT_BANDS : BANDS; }

  var BY_KEY = {};
  for (var bi = 0; bi < BANDS.length; bi++) BY_KEY[BANDS[bi].key] = BANDS[bi];

  var BOTTOM = BANDS[BANDS.length - 1];        // F- — where a worthless line is pinned

  /**
   * of(pct, role) -> the band a percentage falls in. Not a number -> the bottom
   * band. `role` is optional and defaults to the damage dealer's ladder, so every
   * existing caller keeps its old answer.
   */
  function of(pct, role) {
    if (typeof pct !== "number" || !isFinite(pct)) return BOTTOM;
    var b = bandsFor(role);
    for (var i = 0; i < b.length; i++) if (pct >= b[i].min) return b[i];
    return b[b.length - 1];
  }

  // ------------------------------------------------------------------
  // the bracelet grade
  // ------------------------------------------------------------------

  // The highest a combat trait rolls, per grade. Same numbers bible-import.js and
  // leaderboard.js check a decode against.
  // The grade's yardstick is a REACHABLE bracelet, not a theoretical maximum
  // (Shizu, 2026-08-11): two traits at 110 and the three best families at EPIC.
  // A Legendary roll or a 120 trait then pushes the score past 100, which is the
  // point — S+ should mean "better than a very good bracelet", not "perfect".
  var TRAIT_ANCHOR = { relic: 92, ancient: 110 };
  // The LOWEST a combat trait rolls, per grade — Stove's own band ends. Score 0
  // therefore means the worst bracelet the game can actually hand you: both
  // traits at the bottom of the band and three lines worth nothing.
  //
  // It used to be a flat 40 on both grades, deliberately under the real minimum.
  // That put score 0 on a bracelet that cannot exist, and it hurt Ancient most:
  // an Ancient trait bottoms out at 61, not 40, so twenty-one points a line of
  // guaranteed value were being counted as earned rather than given (Shizu,
  // 2026-08-14). Raising the floor to the real band end lifts every Ancient
  // score's zero point and compresses the scale onto what a player can change.
  var TRAIT_FLOOR = { relic: 41, ancient: 61 };
  // The TOP of Stove's own band — the highest a combat trait can roll. Not the
  // yardstick (that is TRAIT_ANCHOR, deliberately under it): this is what the
  // literal best bracelet in the game carries, and it is only ever used to work
  // out where the ceiling is.
  var TRAIT_CEILING = { relic: 100, ancient: 120 };
  // How close to the ceiling still counts as reaching it. The ceiling is built
  // out of the same lineDamage() calls the score is, so an exact hit is exact to
  // the last bit — but a total assembled in a different order can land an ulp
  // out, and a rainbow that flickers on floating-point noise is worse than none.
  var PERFECT_EPS = 1e-6;

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
    var S = B.DATA.SPECIALS, byFam = [], byFamTop = [], i;
    for (i = 0; i < S.length; i++) {
      byFam.push({ id: S[i].id, d: B.lineDamage({ cat: "special", family: S[i].id, tier: "mid" }, grade, profile) });
      // The same three slots at their LEGENDARY roll — the other end of the same
      // bracelet, and the only thing `ceiling` is built from.
      byFamTop.push({ id: S[i].id, d: B.lineDamage({ cat: "special", family: S[i].id, tier: "high" }, grade, profile) });
    }
    byFam.sort(function (a, b) { return b.d - a.d; });
    byFamTop.sort(function (a, b) { return b.d - a.d; });
    var cap = TRAIT_ANCHOR[grade] || TRAIT_ANCHOR.ancient;
    var bottom = TRAIT_FLOOR[grade] || TRAIT_FLOOR.ancient;
    var top = TRAIT_CEILING[grade] || TRAIT_CEILING.ancient;
    // THE PAIR THE ROLE ACTUALLY RUNS. A damage dealer's yardstick bracelet
    // carries Crit and Specialization; a support's carries Specialization and
    // Swiftness, because crit does nothing for a support and scores zero. Using
    // the dealer's pair on both put HALF the support's trait anchor at zero, so
    // its floor and its ceiling were each a whole trait line short.
    var p = profile || canonProfile();
    var pair = p.role === "support" ? ["spec", "swift"] : ["crit", "spec"];
    function traitPair(v) {
      var t = {};
      t[pair[0]] = v; t[pair[1]] = v;
      return B.traitDamage(t, profile);
    }
    // THE ANCHORS ARE BRACELETS, SO THEY ARE SCORED AS BRACELETS. Since 0.4.1
    // a set pools its crit, its flats and its additional damage across every
    // line and trait before converting (jointScore) — summing the three line
    // damages and the trait pair here would rebuild the pre-pooling arithmetic
    // and put the yardstick above anything a real bracelet can score, so a
    // maximal bracelet could sit under its own ceiling and never rainbow, and
    // 100 would quietly stop being reachable. The three families are still
    // CHOSEN by their individual line scores — the selection rule is part of
    // the anchor's meaning — but the chosen trio is priced jointly.
    function pairTraits(v) {
      var t = {};
      t[pair[0]] = v; t[pair[1]] = v;
      return t;
    }
    function trio(list, tier) {
      return [
        { cat: "special", family: list[0].id, tier: tier },
        { cat: "special", family: list[1].id, tier: tier },
        { cat: "special", family: list[2].id, tier: tier }
      ];
    }
    return {
      best: d.length ? d[0] : 0,
      perfect: B.jointScore(trio(byFam, "mid"), pairTraits(cap), grade, p),
      floor: B.jointScore([], pairTraits(bottom), grade, p),
      // THE CEILING, and the whole reason it is here: the rainbow used to be
      // gated on `s > 100.1`, which is exactly the DPS ladder's S+ cut — so
      // every S+ bracelet took it, and on the support ladder (S+ opens at 100)
      // the gate did not even line up with the band it was pretending to be.
      // A bracelet cannot be improved past this, so this is what "perfect"
      // means.
      ceiling: B.jointScore(trio(byFamTop, "high"), pairTraits(top), grade, p)
    };
  }

  /**
   * Anchors for a grade. The canonical default profile is cached — it is a
   * constant and the Leaderboard asks for it once per row; anything else is
   * computed on the spot, which costs about 165 lineDamage() calls — the 99 of
   * rollScores plus a mid and a high pass over the families — and no one
   * notices. A caller that hands the same non-default profile in row after row
   * should memoise it: the Leaderboard does, for the support profile.
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
   *   { score, band, isPerfect, total, floor, perfect, ceiling, damagePct }
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
    // One pool for the whole bracelet — see computeAnchors. setDamage + traitDamage
    // summed was the 0.4.0 scoring and paid crit twice across the two halves.
    var total = B.jointScore(opts.lines || [], opts.traits || {}, grade, p);
    var span = a.perfect - a.floor;
    var s = span > 0 ? 100 * (total - a.floor) / span : 0;
    if (!isFinite(s)) s = 0;
    if (s < 0) s = 0;
    // NOT clamped at 100: the anchor is beatable, and S+ is exactly "over it".
    return {
      score: s,
      band: of(s, p.role),
      // The rainbow's one gate: the bracelet reached the CEILING — the three
      // best distinct families at Legendary with both traits at the top of the
      // band, on this grade and this role. Nothing else earns it, and an S+ is
      // not it: an ordinary S+ scores about 103, the ceiling about 115.
      // Named isPerfect, not perfect: `perfect` below is the ANCHOR, and one
      // object cannot carry both spellings without the flag silently losing.
      isPerfect: total >= a.ceiling - PERFECT_EPS,
      total: total,
      floor: a.floor,
      perfect: a.perfect,
      ceiling: a.ceiling,
      damagePct: B.damagePercent(total)
    };
  }

  var API = {
    BANDS: BANDS,
    BY_KEY: BY_KEY,
    BOTTOM: BOTTOM,
    RAINBOW: RAINBOW,
    SUPPORT_BANDS: SUPPORT_BANDS,
    bandsFor: bandsFor,
    TRAIT_ANCHOR: TRAIT_ANCHOR,
    TRAIT_FLOOR: TRAIT_FLOOR,
    TRAIT_CEILING: TRAIT_CEILING,
    of: of,
    colorOf: colorOf,
    bestRoll: bestRoll,
    anchorsFor: anchorsFor,
    braceletScore: braceletScore
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.Subrank = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
