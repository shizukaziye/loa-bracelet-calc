/**
 * tools/rank-match.mjs — cut the SUPPORT rank bands at the same RARITIES as the
 * DPS ones, so a support A- is exactly as rare as a damage dealer's A-.
 *
 *   node tools/rank-match.mjs
 *
 * WHY THIS AND NOT A SHARED SCALE. Both axes already use the same score shape —
 * 100 · (total − floor) / (anchor − floor) — but the two distributions have
 * different SHAPES, not just different scales. A support's value is packed into
 * six families where a dealer's is spread over thirty, so the same cut lands at
 * a different rarity on each. Reading a letter off a shared scale would make
 * every support rank a quiet lie. The astrogem calculator hit this first and
 * solved it the same way: match the rarities, not the numbers.
 *
 * NO MONTE CARLO. The model's own DP returns the EXACT distribution of finished
 * line scores — every reachable total with its probability, after seven attempts
 * of optimal keep-or-replace. The two combat traits are drawn separately from
 * Stove's banded table, so the finished bracelet is that cdf convolved with the
 * trait pair. Exact throughout, and it runs in a second.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const B = require("../model/bracelet.js");
const SR = require("../subrank.js");

const GRADE = process.argv[2] || "ancient";
const ROLLS = 7;

// The bracelet's two fixed lines are its COMBAT TRAITS — the calculator's
// standing assumption, and Shizu's: you start with the two you want. Naming them
// caps the trait category at 2, so a granted slot can never draw a dead trait
// line. Their VALUES ride in traitValues, which is why these carry none.
const TRAIT_FIXED = [
  { cat: "trait", family: "crit" },
  { cat: "trait", family: "spec" }
];
const SLOTS = 3;

/** Every trait value with its probability, from Stove's ten weighted bands. */
function traitValueDist(grade) {
  const bands = B.DATA.TRAITS.bands, out = [];
  let w = 0;
  for (const b of bands) w += b.prob;
  for (const b of bands) {
    const [lo, hi] = b[grade], n = hi - lo + 1;
    for (let v = lo; v <= hi; v++) out.push({ v: v, p: b.prob / w / n });
  }
  return out;
}

/** The two trait lines' combined damage, as a distribution. */
function traitDamageDist(grade, profile, keys) {
  const vals = traitValueDist(grade), acc = new Map();
  for (const a of vals) {
    const da = B.traitDamage({ [keys[0]]: a.v }, profile);
    for (const b of vals) {
      const d = da + B.traitDamage({ [keys[1]]: b.v }, profile);
      const k = Math.round(d * 1e6);
      acc.set(k, (acc.get(k) || 0) + a.p * b.p);
    }
  }
  return [...acc.entries()].map(([k, p]) => ({ d: k / 1e6, p: p }));
}

/** The finished bracelet's score distribution, sorted ascending, exact. */
function scoreDist(role) {
  const profile = B.normalizeProfile(role === "support" ? { role: "support" } : {});
  const keys = role === "support" ? ["spec", "swift"] : ["crit", "spec"];
  const solved = B.solve({
    grade: GRADE, profile: profile,
    // fixedLines carries the TWO COMBAT TRAITS. Naming them matters twice over:
    // it caps the trait category, so a granted slot can no longer draw a dead
    // trait line, and it fixes the slot count. Passing the wrong key names left
    // the solver on its 2-slot default with the trait category live in the pool,
    // which cost about a third of every draw and capped the reachable set well
    // under the truth.
    fixedLines: TRAIT_FIXED, grantedLines: [], traitValues: {},
    slots: SLOTS, rollsLeft: ROLLS
  });
  const lineCdf = solved.finalScore.cdf;
  const traits = traitDamageDist(GRADE, profile, keys);
  const a = SR.anchorsFor(GRADE, profile), span = a.perfect - a.floor;

  const acc = new Map();
  for (const t of traits) {
    for (const l of lineCdf) {
      let s = 100 * (l.score + t.d - a.floor) / span;
      if (s < 0) s = 0;
      const k = Math.round(s * 100);              // 0.01-score bins
      acc.set(k, (acc.get(k) || 0) + t.p * l.p);
    }
  }
  const rows = [...acc.entries()].map(([k, p]) => ({ s: k / 100, p: p }));
  rows.sort((x, y) => x.s - y.s);
  return { rows: rows, anchors: a, mean: rows.reduce((m, r) => m + r.s * r.p, 0) };
}

/** Share of the distribution at or above `score`. */
function shareAbove(d, score) {
  let n = 0;
  for (let i = d.rows.length - 1; i >= 0; i--) {
    if (d.rows[i].s < score - 1e-9) break;
    n += d.rows[i].p;
  }
  return n;
}
/** The score with exactly `share` of the distribution at or above it. */
function scoreAt(d, share) {
  let run = 0;
  for (let i = d.rows.length - 1; i >= 0; i--) {
    run += d.rows[i].p;
    if (run >= share - 1e-12) return d.rows[i].s;
  }
  return 0;
}

const dps = scoreDist("dps");
const sup = scoreDist("support");

console.log("grade " + GRADE + ", " + SLOTS + " granted slots, " + ROLLS + " attempts, optimal locking");
console.log("  DPS      floor " + dps.anchors.floor.toFixed(3) + "  anchor " + dps.anchors.perfect.toFixed(3) +
  "  mean score " + dps.mean.toFixed(1));
console.log("  support  floor " + sup.anchors.floor.toFixed(3) + "  anchor " + sup.anchors.perfect.toFixed(3) +
  "  mean score " + sup.mean.toFixed(1));
console.log("");
const top = { dps: dps.rows[dps.rows.length - 1].s, sup: sup.rows[sup.rows.length - 1].s };
console.log("  highest score a FRESH bracelet can roll into: DPS " + top.dps.toFixed(1) +
  ", support " + top.sup.toFixed(1) + " — the anchor is a bought bracelet, not a rolled one");
console.log("");

console.log("rank | DPS cut | DPS rarity |      1 in | support cut | how");
const cuts = [];
for (const band of SR.BANDS) {
  if (!isFinite(band.min)) { cuts.push({ key: band.key, cut: -Infinity, how: "the rest" }); continue; }
  const rarity = shareAbove(dps, band.min);
  let cut = null, how = "rarity";
  if (rarity > 0) cut = scoreAt(sup, rarity);
  else { how = "unreachable"; }
  cuts.push({ key: band.key, min: band.min, rarity: rarity, cut: cut, how: how });
}

// Bands no fresh bracelet reaches on EITHER axis cannot be matched by rarity, so
// they are spaced evenly between the highest band that could be and 100.1 — the
// anchor, which means the same thing on both axes ("you beat a very good
// bracelet of your role") and so needs no matching at all.
const firstReal = cuts.findIndex(function (c) { return c.cut !== null && isFinite(c.min); });
const S_PLUS = 100.1;
if (firstReal > 0) {
  const lo = cuts[firstReal].cut, n = firstReal + 1;
  for (let i = 0; i < firstReal; i++) {
    cuts[i].cut = Math.round((S_PLUS - (S_PLUS - lo) * (i + 1) / n) * 10) / 10;
    cuts[i].how = "spaced";
  }
  cuts[0].cut = S_PLUS;
  cuts[0].how = "the anchor";
}

for (const c of cuts) {
  if (!isFinite(c.min === undefined ? -Infinity : c.min)) {
    console.log(c.key.padEnd(4) + " |       — |          — |         — |    -Inf | " + c.how);
    continue;
  }
  console.log(
    c.key.padEnd(4) + " | " + String(c.min).padStart(7) + " | " +
    (c.rarity * 100).toPrecision(3).padStart(10) + "% | " +
    (c.rarity > 0 ? Math.round(1 / c.rarity).toLocaleString("en-US") : "never").padStart(9) + " | " +
    (c.cut === null ? "    —" : c.cut.toFixed(1).padStart(11)) + " | " + c.how
  );
}

console.log("");
console.log("  var SUPPORT_BANDS = [");
for (const c of cuts) {
  const v = c.cut === -Infinity ? "-Infinity" : c.cut.toFixed(1);
  console.log('    { key: "' + c.key + '", min: ' + v + " },");
}
console.log("  ];");
