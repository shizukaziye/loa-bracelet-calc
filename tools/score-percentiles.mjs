/**
 * tools/score-percentiles.mjs — the score distribution of a rolled bracelet.
 *
 *   node tools/score-percentiles.mjs [ancient|relic] [slots] [--mc N]
 *
 * EXACT, not sampled. The model's DP returns the whole distribution of finished
 * LINE scores after seven attempts of optimal keep-or-replace — every reachable
 * total with its probability — and the two combat traits are an independent draw
 * from Stove's weighted bands, so the finished bracelet is one convolved with the
 * other. That is what a simulator converges towards, without the sampling error:
 * a hundred million rolls still miss a 1-in-2,000,000 tail by a few percent, and
 * the top of a rank ladder is made of exactly those tails.
 *
 * --mc N runs a Monte Carlo of N brackets beside it as a cross-check.
 *
 * SCALE: 0 = the worst bracelet the game can produce — both combat traits at the
 * bottom of the band and three lines worth nothing. 100 = both traits at 110 and
 * the three best distinct families at Epic. Neither end is clamped.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const B = require("../model/bracelet.js");
const SR = require("../subrank.js");

const GRADE = process.argv[2] === "relic" ? "relic" : "ancient";
const SLOTS = Number(process.argv[3]) || 3;
const MC = process.argv.includes("--mc") ? Number(process.argv[process.argv.indexOf("--mc") + 1]) : 0;
const ROLLS = 7;

// The bracelet's two fixed lines are its COMBAT TRAITS — the calculator's
// standing assumption, and Shizu's: you start with the two you want. Naming them
// caps the trait category at 2, so a granted slot can never draw a dead trait
// line. Their VALUES ride in traitValues, which is why these carry none.
const TRAIT_FIXED = [
  { cat: "trait", family: "crit" },
  { cat: "trait", family: "spec" }
];

/** Every combat-trait value with its probability, from Stove's ten bands. */
function traitValueDist(grade) {
  const bands = B.DATA.TRAITS.bands, out = [];
  let w = 0;
  for (const b of bands) w += b.prob;
  for (const b of bands) {
    const lo = b[grade][0], hi = b[grade][1], n = hi - lo + 1;
    for (let v = lo; v <= hi; v++) out.push({ v: v, p: b.prob / w / n });
  }
  return out;
}

function lineCdf(profile) {
  return B.solve({
    grade: GRADE, profile: profile,
    // fixedLines carries the TWO COMBAT TRAITS. Naming them matters twice over:
    // it caps the trait category, so a granted slot can no longer draw a dead
    // trait line, and it fixes the slot count. Passing the wrong key names left
    // the solver on its 2-slot default with the trait category live in the pool,
    // which cost about a third of every draw and capped the reachable set well
    // under the truth.
    fixedLines: TRAIT_FIXED, grantedLines: [], traitValues: {},
    slots: SLOTS, rollsLeft: ROLLS
  }).finalScore.cdf;
}

function dist(role) {
  const profile = B.normalizeProfile(role === "support" ? { role: "support" } : {});
  const keys = role === "support" ? ["spec", "swift"] : ["crit", "spec"];
  const vals = traitValueDist(GRADE);

  // The two trait lines, collapsed into one distribution.
  const tacc = new Map();
  for (const a of vals) {
    const one = {}; one[keys[0]] = a.v;
    const da = B.traitDamage(one, profile);
    for (const b of vals) {
      const two = {}; two[keys[1]] = b.v;
      const k = Math.round((da + B.traitDamage(two, profile)) * 1e6);
      tacc.set(k, (tacc.get(k) || 0) + a.p * b.p);
    }
  }

  const cdf = lineCdf(profile);
  const a = SR.anchorsFor(GRADE, profile), span = a.perfect - a.floor;

  const acc = new Map();
  for (const [tk, tp] of tacc) {
    const td = tk / 1e6;
    for (let i = 0; i < cdf.length; i++) {
      let s = 100 * (cdf[i].score + td - a.floor) / span;
      if (s < 0) s = 0;
      const k = Math.round(s * 100);
      acc.set(k, (acc.get(k) || 0) + tp * cdf[i].p);
    }
  }
  const rows = [...acc.entries()].map(([k, p]) => ({ s: k / 100, p: p })).sort((x, y) => x.s - y.s);

  let run = 0;
  for (let i = rows.length - 1; i >= 0; i--) { run += rows[i].p; rows[i].above = run; }
  return {
    rows: rows, anchors: a,
    mean: rows.reduce((m, r) => m + r.s * r.p, 0),
    max: rows[rows.length - 1].s,
    above: function (x) {
      for (let i = 0; i < rows.length; i++) if (rows[i].s >= x - 1e-9) return rows[i].above;
      return 0;
    },
    at: function (share) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].above >= share - 1e-15) return rows[i].s;
      return 0;
    }
  };
}

function one(p) {
  if (p <= 0) return "never";
  const n = 1 / p;
  return n < 10 ? "1 in " + n.toFixed(1) : "1 in " + Math.round(n).toLocaleString("en-US");
}
function pc(p) {
  if (p <= 0) return "0";
  if (p >= 0.01) return (p * 100).toFixed(2) + "%";
  if (p >= 0.000001) return (p * 100).toFixed(5) + "%";
  return (p * 100).toExponential(2) + "%";
}

const dpsD = dist("dps"), supD = dist("support");

for (const [name, d] of [["DPS", dpsD], ["SUPPORT", supD]]) {
  console.log("\n" + "=".repeat(70));
  console.log(name + " — " + GRADE + ", " + SLOTS + " granted slots, " + ROLLS + " attempts, optimal locking");
  console.log("floor " + d.anchors.floor.toFixed(3) + "   anchor " + d.anchors.perfect.toFixed(3) +
    "   mean " + d.mean.toFixed(1) + "   best a fresh roll reaches " + d.max.toFixed(1));
  console.log("=".repeat(70));

  console.log("\n  every 5 points");
  console.log("  score |    at or above |         odds");
  for (let s = 0; s <= 100; s += 5) {
    const p = d.above(s);
    console.log("  " + String(s).padStart(5) + " | " + pc(p).padStart(14) + " | " + one(p).padStart(12));
    if (p <= 0) break;
  }

  console.log("\n  the top, one point at a time");
  console.log("  score |    at or above |         odds");
  for (let s = Math.max(0, Math.floor(d.at(0.05))); s <= Math.ceil(d.max); s += 1) {
    const p = d.above(s);
    if (p <= 0) break;
    console.log("  " + String(s).padStart(5) + " | " + pc(p).padStart(14) + " | " + one(p).padStart(12));
  }

  console.log("\n  by rarity");
  console.log("      1 in | score");
  for (const n of [2, 3, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 5e4, 1e5, 1e6]) {
    console.log("  " + n.toLocaleString("en-US").padStart(8) + " | " + d.at(1 / n).toFixed(1).padStart(5));
  }
}

// ---- Monte Carlo cross-check ------------------------------------------------
if (MC) {
  console.log("\n" + "=".repeat(70));
  console.log("Monte Carlo cross-check — " + MC.toLocaleString("en-US") + " brackets, DPS");
  console.log("=".repeat(70));
  const profile = B.normalizeProfile({});
  const vals = traitValueDist(GRADE), cum = [];
  let c = 0;
  for (const v of vals) { c += v.p; cum.push(c); }
  const lc = lineCdf(profile);
  const a = SR.anchorsFor(GRADE, profile), span = a.perfect - a.floor;

  // Trait damage is a lookup, not a call, inside the hot loop.
  const critD = vals.map(v => B.traitDamage({ crit: v.v }, profile));
  const specD = vals.map(v => B.traitDamage({ spec: v.v }, profile));

  // xorshift128, fixed seed — reproducible, and Math.random is not allowed here.
  let x = 123456789, y = 362436069, z = 521288629, w = 88675123;
  function rnd() {
    const t = x ^ (x << 11); x = y; y = z; z = w;
    w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
    return (w >>> 0) / 4294967296;
  }
  function idx(arr, key) {
    const r = rnd();
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if ((key ? arr[m][key] : arr[m]) < r) lo = m + 1; else hi = m; }
    return lo;
  }

  const cuts = [10, 20, 30, 40, 50, 60, 65, 70, 75, 80];
  const hits = {};
  for (const q of cuts) hits[q] = 0;
  let sum = 0;
  for (let i = 0; i < MC; i++) {
    const t = critD[idx(cum)] + specD[idx(cum)];
    let s = 100 * (lc[idx(lc, "cum")].score + t - a.floor) / span;
    if (s < 0) s = 0;
    sum += s;
    for (let q = 0; q < cuts.length; q++) if (s >= cuts[q]) hits[cuts[q]]++;
  }
  console.log("  mean   sampled " + (sum / MC).toFixed(3) + "    exact " + dpsD.mean.toFixed(3));
  console.log("  score |   sampled ≥ |      exact ≥ | gap");
  for (const q of cuts) {
    const smp = hits[q] / MC, ex = dpsD.above(q);
    const gap = ex > 0 ? ((smp - ex) / ex * 100).toFixed(2) + "%" : "—";
    console.log("  " + String(q).padStart(5) + " | " + pc(smp).padStart(11) + " | " + pc(ex).padStart(12) + " | " + gap.padStart(7));
  }
}
