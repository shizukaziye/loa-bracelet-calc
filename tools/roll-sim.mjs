/**
 * tools/roll-sim.mjs — an INDEPENDENT bracelet simulator.
 *
 *   node tools/roll-sim.mjs [ancient|relic] [slots] [count] [dps|support]
 *
 * Deliberately shares nothing with model/bracelet.js's DP except the per-line
 * damage numbers. It draws granted slots straight from the official weights and
 * plays the seven attempts with a sampled lock threshold, so if the DP is
 * truncating its state space this will say so — a simulator's tail is limited
 * only by how long you run it.
 *
 * MECHANICS (docs/research/mechanics-bible-leaderboard.md):
 *   - three granted slots; four rolls plus three ticket rolls is seven attempts
 *   - one attempt rerolls EVERY unlocked slot as a set; locked lines stay
 *   - a family never appears twice, and at most two basic effects
 *   - both combat-trait places are filled at drop, so a granted slot is basic or
 *     special, renormalised over the excluded trait category
 *   - lock a line worth more than the slot itself is worth with the attempts
 *     remaining: V(n) = E[max(X, V(n-1))], sampled once up front
 *
 * The two combat traits are drawn from Stove's weighted bands.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const B = require("../model/bracelet.js");
const SR = require("../subrank.js");

const GRADE = process.argv[2] === "relic" ? "relic" : "ancient";
const SLOTS = Number(process.argv[3]) || 3;
const N = Number(process.argv[4]) || 1000000;
const ROLE = process.argv[5] === "support" ? "support" : "dps";
const ATTEMPTS = 7;

const profile = B.normalizeProfile(ROLE === "support" ? { role: "support" } : {});
const traitKeys = ROLE === "support" ? ["spec", "swift"] : ["crit", "spec"];

// xorshift128, fixed seed — reproducible, and Math.random is unavailable here.
let x = 88675123, y = 123456789, z = 362436069, w = 521288629;
function rnd() {
  const t = x ^ (x << 11); x = y; y = z; z = w;
  w = (w ^ (w >>> 19)) ^ (t ^ (t >>> 8));
  return (w >>> 0) / 4294967296;
}

// ---- the draw pool, straight from the official tables ----------------------
const CAT = B.DATA.CATEGORY_WEIGHTS;
const SPEC_SUM = B.DATA.GRANTED_LISTED_SUM;
const TIERS = B.DATA.TIERS;

const pool = [];
for (const band of B.DATA.BASIC.bands) {
  const v = (band[GRADE].mainStat[0] + band[GRADE].mainStat[1]) / 2;
  pool.push({
    fam: "basic:mainStat", basic: true, w: CAT.basic * 0.5 * band.prob / 100,
    d: B.lineDamage({ cat: "basic", family: "mainStat", value: v }, GRADE, profile)
  });
}
pool.push({ fam: "basic:vitality", basic: true, w: CAT.basic * 0.5, d: 0 });
for (const fam of B.DATA.SPECIALS) {
  for (const tier of TIERS) {
    pool.push({
      fam: "f" + fam.id, w: CAT.special * fam.granted[tier] / SPEC_SUM,
      d: B.lineDamage({ cat: "special", family: fam.id, tier: tier }, GRADE, profile)
    });
  }
}
// Combat traits are excluded: both places are filled at drop. The disclosure's
// own rule renormalises over what is excluded, which is what dividing by the
// surviving mass does.
const TOTAL_W = pool.reduce((s, e) => s + e.w, 0);

/** One granted slot. `used` stops a family repeating and caps basics at two. */
function drawSlot(used) {
  let live = 0;
  for (const e of pool) if (!used.fam[e.fam] && !(e.basic && used.basics >= 2)) live += e.w;
  if (live <= 0) return { fam: null, d: 0 };
  let r = rnd() * live;
  for (const e of pool) {
    if (used.fam[e.fam] || (e.basic && used.basics >= 2)) continue;
    r -= e.w;
    if (r <= 0) {
      used.fam[e.fam] = true;
      if (e.basic) used.basics++;
      return e;
    }
  }
  return { fam: null, d: 0 };
}

/** V(n) = E[max(X, V(n-1))]: what one slot is worth with n attempts left. */
function lockThresholds(samples) {
  const draws = [];
  for (let i = 0; i < samples; i++) draws.push(drawSlot({ fam: {}, basics: 0 }).d);
  const v = [0];
  for (let n = 1; n <= ATTEMPTS; n++) {
    let s = 0;
    for (const d of draws) s += Math.max(d, v[n - 1]);
    v.push(s / draws.length);
  }
  return v;
}
const V = lockThresholds(200000);

// ---- traits ----------------------------------------------------------------
const bands = B.DATA.TRAITS.bands;
let bw = 0;
for (const b of bands) bw += b.prob;
const tvals = [], tcum = [];
let acc = 0;
for (const b of bands) {
  const lo = b[GRADE][0], hi = b[GRADE][1], n = hi - lo + 1;
  for (let v = lo; v <= hi; v++) { tvals.push(v); acc += b.prob / bw / n; tcum.push(acc); }
}
const traitD = traitKeys.map(k => tvals.map(v => {
  const o = {}; o[k] = v;
  return B.traitDamage(o, profile);
}));
function drawTrait(which) {
  const r = rnd();
  let lo = 0, hi = tcum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (tcum[m] < r) lo = m + 1; else hi = m; }
  return traitD[which][lo];
}

/**
 * One finished bracelet, in line damage.
 *
 * THE ORDER MATTERS AND IT IS EASY TO GET WRONG. You choose the lock mask BEFORE
 * the roll, on the lines you already have; then every unlocked slot is redrawn as
 * one set; then you keep the old unlocked group or take the new one.
 *
 * Filtering the lines AFTER seeing the draw — the obvious way to write it, and the
 * way loa-gpd's simulator writes it — is locking with hindsight: it cherry-picks a
 * good line out of three fresh ones without having paid a lock for it.
 *
 * Worth about 2 score points on the mean (41.7 against 39.6), so it is a detail
 * rather than a hole. Both orderings still sit BELOW the DP's optimal 45.5,
 * because the threshold rule itself is myopic — hindsight partly compensates for
 * that, which is why the wrong order scores nearer the optimum than the right one.
 *
 * An earlier draft of this comment claimed the gap was fourteen points. That
 * number came from a DP that was itself misconfigured (see score-distribution.md
 * §1) and was never true.
 */
function rollLines() {
  let held = [];
  for (let attempt = ATTEMPTS; attempt >= 1; attempt--) {
    // Lock first, on what is in front of you.
    const floor = V[attempt - 1];
    const locked = held.filter(h => h.d >= floor);
    const oldRest = held.filter(h => h.d < floor);

    // Reroll every unlocked slot as one set.
    const used = { fam: {}, basics: 0 };
    for (const h of locked) { used.fam[h.fam] = true; if (h.basic) used.basics++; }
    const fresh = [];
    while (locked.length + fresh.length < SLOTS) fresh.push(drawSlot(used));

    // Keep the old group or take the new one — as a group, not line by line.
    let oldSum = 0, newSum = 0;
    for (const h of oldRest) oldSum += h.d;
    for (const h of fresh) newSum += h.d;
    held = locked.concat(newSum >= oldSum || oldRest.length < SLOTS - locked.length ? fresh : oldRest);
  }
  let s = 0;
  for (const h of held) s += h.d;
  return s;
}

// ---- run --------------------------------------------------------------------
const a = SR.anchorsFor(GRADE, profile), span = a.perfect - a.floor;
const BIN = 0.1;
const hist = new Float64Array(2000);
let sum = 0, max = 0, maxLine = 0;
for (let i = 0; i < N; i++) {
  const line = rollLines();
  if (line > maxLine) maxLine = line;
  let s = 100 * (line + drawTrait(0) + drawTrait(1) - a.floor) / span;
  if (s < 0) s = 0;
  if (s > max) max = s;
  sum += s;
  const k = Math.min(hist.length - 1, Math.round(s / BIN));
  hist[k]++;
}
function above(score) {
  let n = 0;
  for (let k = Math.ceil(score / BIN); k < hist.length; k++) n += hist[k];
  return n / N;
}
function one(p) {
  if (p <= 0) return "none seen";
  const n = 1 / p;
  return n < 10 ? "1 in " + n.toFixed(1) : "1 in " + Math.round(n).toLocaleString("en-US");
}

console.log("independent simulator — " + ROLE + ", " + GRADE + ", " + SLOTS + " slots, " +
  ATTEMPTS + " attempts, " + N.toLocaleString("en-US") + " brackets");
console.log("lock thresholds V(1..7): " + V.slice(1).map(v => v.toFixed(3)).join(" "));
console.log("mean score " + (sum / N).toFixed(3) + "   best rolled " + max.toFixed(1) +
  "   best line total " + maxLine.toFixed(3));
console.log("");
console.log("  score |      sampled ≥ |         odds");
for (let s = 0; s <= 100; s += 5) {
  const p = above(s);
  console.log("  " + String(s).padStart(5) + " | " +
    (p > 0 ? (p * 100).toPrecision(4) + "%" : "0").padStart(14) + " | " + one(p).padStart(12));
  if (p <= 0) break;
}
