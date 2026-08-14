/**
 * tools/ladder-options.mjs — what each candidate rank ladder is worth in rarity.
 *
 *   node tools/ladder-options.mjs [ancient|relic] [slots]
 *
 * Prints, for both roles, the rarity every band cut lands at under the exact
 * distribution of a fresh bracelet rolled out over seven attempts. Read it before
 * choosing breakpoints: a ladder is only as good as the rarities its letters
 * mean, and a band nobody lands in is decoration.
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
  const profile = B.normalizeProfile(role === "support" ? { role: "support" } : {});
  const tk = role === "support" ? ["spec", "swift"] : ["crit", "spec"];
  const bands = B.DATA.TRAITS.bands;
  let bw = 0;
  for (const b of bands) bw += b.prob;
  const vals = [];
  for (const b of bands) {
    const lo = b[GRADE][0], hi = b[GRADE][1], n = hi - lo + 1;
    for (let v = lo; v <= hi; v++) vals.push({ v: v, p: b.prob / bw / n });
  }
  const tacc = new Map();
  for (const a of vals) {
    const o1 = {}; o1[tk[0]] = a.v;
    const da = B.traitDamage(o1, profile);
    for (const b of vals) {
      const o2 = {}; o2[tk[1]] = b.v;
      const k = Math.round((da + B.traitDamage(o2, profile)) * 1e6);
      tacc.set(k, (tacc.get(k) || 0) + a.p * b.p);
    }
  }
  const cdf = B.solve({
    grade: GRADE, profile: profile, fixedLines: TRAIT_FIXED, grantedLines: [],
    traitValues: {}, slots: SLOTS, rollsLeft: ROLLS
  }).finalScore.cdf;
  const a = SR.anchorsFor(GRADE, profile), span = a.perfect - a.floor;
  const acc = new Map();
  for (const [tkey, tp] of tacc) {
    const td = tkey / 1e6;
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
    above(x) { for (const r of rows) if (r.s >= x - 1e-9) return r.above; return 0; },
    at(share) { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].above >= share - 1e-15) return rows[i].s; return 0; }
  };
}

function one(p) {
  if (p <= 0) return "never";
  const n = 1 / p;
  return n < 10 ? "1 in " + n.toFixed(2) : "1 in " + Math.round(n).toLocaleString("en-US");
}

const D = { dps: dist("dps"), support: dist("support") };

// The ladder shipping today.
const TODAY = [100.1, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 20, 10, -Infinity];
// Recommendation: the same 5-point spacing, with the dead bottom lifted so every
// band holds somebody. Only F and F+ move.
const REC = [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, -Infinity];

for (const role of ["dps", "support"]) {
  const d = D[role];
  console.log("\n" + role.toUpperCase() + " — " + GRADE + ", " + SLOTS + " slots, " + ROLLS + " attempts");
  console.log("rank | today | rarity today   | rec | rarity rec     | share of the band");
  for (let i = 0; i < KEYS.length; i++) {
    const t = TODAY[i], r = REC[i];
    const pt = isFinite(t) ? d.above(t) : 1;
    const pr = isFinite(r) ? d.above(r) : 1;
    const prevR = i === 0 ? 0 : d.above(REC[i - 1]);
    const width = pr - prevR;
    console.log(
      KEYS[i].padEnd(4) + " | " + String(isFinite(t) ? t : "—").padStart(5) + " | " + one(pt).padStart(14) +
      " | " + String(isFinite(r) ? r : "—").padStart(3) + " | " + one(pr).padStart(14) +
      " | " + (width * 100).toFixed(2) + "%"
    );
  }
}

// A support ladder cut at the DPS ladder's own rarities.
console.log("\nSUPPORT cuts matched to the RECOMMENDED DPS rarities");
console.log("rank | dps cut | dps rarity     | support cut");
for (let i = 0; i < KEYS.length; i++) {
  const r = REC[i];
  if (!isFinite(r)) { console.log(KEYS[i].padEnd(4) + " |       — |              — |        —"); continue; }
  const rar = D.dps.above(r);
  console.log(KEYS[i].padEnd(4) + " | " + String(r).padStart(7) + " | " + one(rar).padStart(14) +
    " | " + D.support.at(rar).toFixed(1).padStart(11));
}
