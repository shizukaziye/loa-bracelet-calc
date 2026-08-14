/**
 * tools/support-ladder-round.mjs — round support cuts, and what they cost.
 *
 *   node tools/support-ladder-round.mjs [ancient|relic] [slots]
 *
 * The exactly-matched support ladder puts a letter at the same rarity it means on
 * the DPS axis, but its cuts are arbitrary decimals (98.8, 83.2, 60.5, …). This
 * scores candidate ladders built from ROUND numbers — multiples of 2.5, with the
 * gap between adjacent tiers held constant within a stretch — against those exact
 * rarities, so the cost of rounding is a number rather than a guess.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const B = require("../model/bracelet.js");
const SR = require("../subrank.js");

const GRADE = process.argv[2] === "relic" ? "relic" : "ancient";
const SLOTS = Number(process.argv[3]) || 3;
const ROLLS = 7;
const TRAIT_FIXED = [{ cat: "trait", family: "crit" }, { cat: "trait", family: "spec" }];
const KEYS = ["S+", "S", "S-", "A+", "A", "A-", "B+", "B", "B-",
              "C+", "C", "C-", "D+", "D", "D-", "F+", "F", "F-"];

function dist(role) {
  const p = B.normalizeProfile(role === "support" ? { role: "support" } : {});
  const keys = role === "support" ? ["spec", "swift"] : ["crit", "spec"];
  const bands = B.DATA.TRAITS.bands;
  let w = 0;
  for (const b of bands) w += b.prob;
  const vals = [];
  for (const b of bands) {
    const lo = b[GRADE][0], hi = b[GRADE][1], n = hi - lo + 1;
    for (let v = lo; v <= hi; v++) vals.push({ v: v, p: b.prob / w / n });
  }
  const tacc = new Map();
  for (const a of vals) {
    const o1 = {}; o1[keys[0]] = a.v;
    const da = B.traitDamage(o1, p);
    for (const b of vals) {
      const o2 = {}; o2[keys[1]] = b.v;
      const k = Math.round((da + B.traitDamage(o2, p)) * 1e6);
      tacc.set(k, (tacc.get(k) || 0) + a.p * b.p);
    }
  }
  const cdf = B.solve({
    grade: GRADE, profile: p, fixedLines: TRAIT_FIXED, grantedLines: [],
    traitValues: {}, slots: SLOTS, rollsLeft: ROLLS
  }).finalScore.cdf;
  const an = SR.anchorsFor(GRADE, p), span = an.perfect - an.floor;
  const acc = new Map();
  for (const [tk, tp] of tacc) {
    const td = tk / 1e6;
    for (const l of cdf) {
      let s = 100 * (l.score + td - an.floor) / span;
      if (s < 0) s = 0;
      const k = Math.round(s * 100);
      acc.set(k, (acc.get(k) || 0) + tp * l.p);
    }
  }
  const rows = [...acc.entries()].map(([k, pp]) => ({ s: k / 100, p: pp })).sort((a, b) => a.s - b.s);
  let run = 0;
  for (let i = rows.length - 1; i >= 0; i--) { run += rows[i].p; rows[i].above = run; }
  return {
    above(x) { for (const r of rows) if (r.s >= x - 1e-9) return r.above; return 0; },
    at(share) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].above >= share - 1e-15) return rows[i].s; return 0; }
  };
}

const dps = dist("dps"), sup = dist("support");
// The ladder shipping on the DPS side — the rarities every candidate is judged by.
const DPS_CUTS = SR.BANDS.map(b => b.min);
const TARGET = DPS_CUTS.map(c => (isFinite(c) ? dps.above(c) : 1));
const EXACT = TARGET.map(r => (r >= 1 ? -Infinity : sup.at(r)));

/** Cuts from a run-length list of [count, gap] stretches, starting at `top`. */
function ladder(top, stretches) {
  const out = [top];
  for (const [n, g] of stretches) for (let i = 0; i < n; i++) out.push(out[out.length - 1] - g);
  out.push(-Infinity);
  return out;
}

const CANDIDATES = [
  ["7.5 / 5 / 2.5 from 100, split at B- and D", ladder(100, [[8, 7.5], [5, 5], [3, 2.5]])],
  ["7.5 / 5 / 2.5 from 97.5", ladder(97.5, [[8, 7.5], [5, 5], [3, 2.5]])],
  ["7.5 / 5 / 2.5 from 100, split at C+ and D", ladder(100, [[9, 7.5], [4, 5], [3, 2.5]])],
  ["7.5 / 5 / 2.5 from 100, split at B and D-", ladder(100, [[7, 7.5], [7, 5], [2, 2.5]])],
  ["7.5 / 5 / 2.5 from 100, split at B- and D-", ladder(100, [[8, 7.5], [6, 5], [2, 2.5]])],
  ["7.5 / 5 / 2.5 from 100, split at B- and F+", ladder(100, [[8, 7.5], [7, 5], [1, 2.5]])],
  ["7.5 / 5, split at B+", ladder(100, [[6, 7.5], [10, 5]])],
  ["a flat 5 (the DPS numbers)", ladder(100, [[16, 5]])],
  ["7.5 / 2.5, split at B-", ladder(100, [[8, 7.5], [8, 2.5]])],
  ["a flat 5.5 — NOT round, for reference", ladder(98.5, [[16, 5.5]])],
];

function one(p) {
  if (p <= 0) return "never";
  const n = 1 / p;
  return n < 10 ? "1 in " + n.toFixed(2) : "1 in " + Math.round(n).toLocaleString("en-US");
}

console.log("exact matched cuts (the yardstick):");
console.log("  " + KEYS.slice(0, 17).map((k, i) => k + " " + EXACT[i].toFixed(1)).join("  "));

for (const [name, cuts] of CANDIDATES) {
  // Error is measured in RARITY, not in score points: two cuts a point apart at
  // the top of the ladder are a world apart in how often they happen, and a point
  // apart at the bottom is nothing.
  let worst = 0, worstAt = "", sumLog = 0, n = 0;
  for (let i = 0; i < 17; i++) {
    const got = sup.above(cuts[i]), want = TARGET[i];
    if (got <= 0 || want <= 0 || want >= 1) continue;
    const ratio = got / want;
    const err = Math.abs(Math.log(ratio));
    sumLog += err; n++;
    if (err > worst) { worst = err; worstAt = KEYS[i] + " " + (ratio > 1 ? ratio.toFixed(2) + "x too common" : (1 / ratio).toFixed(2) + "x too rare"); }
  }
  console.log("\n" + name);
  console.log("  cuts: " + cuts.slice(0, 17).map(c => (Number.isInteger(c) ? c : c.toFixed(1))).join(" "));
  console.log("  mean rarity error " + (Math.exp(sumLog / n) - 1 >= 0 ? "×" + Math.exp(sumLog / n).toFixed(3) : "") +
    "   worst: " + worstAt);
}

const best = CANDIDATES[0][1];
console.log("\n\nfull table for the first candidate");
console.log("rank | cut  | its rarity     | DPS twin       | gap to the one above");
for (let i = 0; i < KEYS.length; i++) {
  const c = best[i];
  if (!isFinite(c)) { console.log(KEYS[i].padEnd(4) + " |  —   |              — |              — |  —"); continue; }
  const gap = i === 0 ? "" : (best[i - 1] - c).toFixed(1);
  console.log(KEYS[i].padEnd(4) + " | " + String(c).padStart(4) + " | " + one(sup.above(c)).padStart(14) +
    " | " + one(TARGET[i]).padStart(14) + " | " + gap.padStart(4));
}

console.log("\n  var SUPPORT_LADDER = [");
for (let i = 0; i < KEYS.length; i++) {
  const c = best[i];
  console.log('    ["' + KEYS[i] + '", ' + (isFinite(c) ? c : "-Infinity") + "],");
}
console.log("  ];");
