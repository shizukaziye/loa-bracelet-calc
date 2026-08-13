/**
 * gen-refs.js — regenerate refs.json from model/bracelet.js.
 *
 * refs.json is the shared contract: verify.js recomputes every entry with the
 * JS core (self-consistency) and verify.py recomputes the same entries with
 * model/bracelet.py (JS <-> Python parity). Both also re-derive a handful of
 * cases from first principles rather than trusting the model.
 *
 * Run: node tools/gen-refs.js   (or `npm run genrefs`)
 */
"use strict";
var fs = require("fs");
var path = require("path");
var B = require("../model/bracelet.js");
var DATA = require("../data/bracelet-data.js");

function r9(x) { return (typeof x === "number" && isFinite(x)) ? Math.round(x * 1e9) / 1e9 : x; }

var P = B.normalizeProfile({});

// ---------------------------------------------------------------- derivation
var derivation = [
  { label: "default 1785 build", input: {} },
  { label: "flat AP off", input: { flatAP: 0 } },
  { label: "all +21, no karma/ranch", input: { pieceLevels: { weapon: 21, gloves: 21 }, msPct: 0.08, wpPct: 0.06 } },
  { label: "fresh 1700 build", input: { pieceLevels: { head: 5, shoulder: 5, chest: 5, pants: 5, gloves: 5, weapon: 5 } } },
  // A weapon ark-grid core instead of an attack one: flat WEAPON power, which
  // lands inside the square root and takes the wpPct bucket with it.
  { label: "weapon core: flat WP 9000", input: { flatWP: 9000 } }
].map(function (c) {
  var d = B.deriveBaseline(c.input);
  return { label: c.label, input: c.input, out: {
    ilvl: d.ilvl, armorMainStat: d.armorMainStat, mainStatRaw: d.mainStatRaw,
    weaponPowerRaw: d.weaponPowerRaw, mainStatTotal: r9(d.mainStatTotal),
    weaponPowerTotal: r9(d.weaponPowerTotal), flatWP: d.flatWP } };
});

// ---------------------------------------------------------------- profile scalars
var profileScalars = {
  addDamagePool: r9(B.addDamagePool(P)),
  addDamagePoolMaster: r9(B.addDamagePool(B.normalizeProfile({ master: true }))),
  critFactor: r9(B.critFactor(P, 0, 0)),
  allyCritFactor: r9(B.allyCritFactor(P, 0, 0)),
  attackPower: r9(B.attackPower(P, 0, 0)),
  attackPowerNoFlat: r9(B.attackPower(B.normalizeProfile({ flatAP: 0 }), 0, 0)),
  // Flat weapon power inside the root. Equal to the same character with 9000
  // more weaponPowerRaw, and NOT to the same character with 9000 more flatAP —
  // which is exactly the claim the two checks in verify.js pin down.
  attackPowerFlatWP: r9(B.attackPower(B.normalizeProfile({ flatWP: 9000 }), 0, 0)),
  defShredGain2_1: r9(B.defShredGain(P, 2.1)),
  basicExpectedRelic: r9(B.basicBandExpected("mainStat", "relic")),
  basicExpectedAncient: r9(B.basicBandExpected("mainStat", "ancient")),
  traitExpectedRelic: r9(B.traitBandExpected("relic")),
  traitExpectedAncient: r9(B.traitBandExpected("ancient"))
};

// ---------------------------------------------------------------- listed probabilities
var listed = {
  grantedListedSum: r9(DATA.GRANTED_LISTED_SUM),
  fixedListedSum: r9(DATA.FIXED_LISTED_SUM),
  spot: [
    { id: 1, tier: "low", granted: DATA.SPECIAL_BY_ID[1].granted.low, fixed: DATA.SPECIAL_BY_ID[1].fixed.low },
    { id: 10, tier: "high", granted: DATA.SPECIAL_BY_ID[10].granted.high, fixed: DATA.SPECIAL_BY_ID[10].fixed.high },
    { id: 15, tier: "mid", granted: DATA.SPECIAL_BY_ID[15].granted.mid, fixed: null },
    { id: 22, tier: "high", granted: DATA.SPECIAL_BY_ID[22].granted.high, fixed: null },
    { id: 33, tier: "low", granted: DATA.SPECIAL_BY_ID[33].granted.low, fixed: null }
  ],
  values: [
    { id: 13, grade: "relic", tier: "mid", value: DATA.SPECIAL_BY_ID[13].values.relic.mid },
    { id: 21, grade: "ancient", tier: "high", value: DATA.SPECIAL_BY_ID[21].values.ancient.high },
    { id: 32, grade: "relic", tier: "high", value: DATA.SPECIAL_BY_ID[32].values.relic.high }
  ]
};

// ---------------------------------------------------------------- line scores
var lines = [];
["relic", "ancient"].forEach(function (g) {
  for (var id = 1; id <= 33; id++) {
    DATA.TIERS.forEach(function (t) {
      lines.push({ grade: g, family: id, tier: t, damage: r9(B.lineDamage({ cat: "special", family: id, tier: t }, g, P)) });
    });
  }
  lines.push({ grade: g, cat: "basic", family: "mainStat", value: null, damage: r9(B.lineDamage({ cat: "basic", family: "mainStat" }, g, P)) });
  lines.push({ grade: g, cat: "basic", family: "mainStat", value: 13888, damage: r9(B.lineDamage({ cat: "basic", family: "mainStat", value: 13888 }, g, P)) });
  lines.push({ grade: g, cat: "basic", family: "vitality", value: null, damage: 0 });
  lines.push({ grade: g, cat: "trait", family: "crit", value: 100, damage: 0 });
});

// A few alternative profiles, to prove the inputs really drive the numbers.
var profileVariants = [
  { label: "master on", profile: { master: true }, family: 24, tier: "high", grade: "ancient" },
  { label: "two skills", profile: { skills: [{ share: 0.6, critRate: 0.75, critDamage: 2.6 }, { share: 0.4, critRate: 1.0, critDamage: 2.9 }] }, family: 31, tier: "high", grade: "ancient" },
  { label: "crit already capped", profile: { skills: [{ share: 1, critRate: 1.0, critDamage: 2.8 }] }, family: 31, tier: "high", grade: "ancient" },
  { label: "no flat AP", profile: { flatAP: 0 }, family: 33, tier: "high", grade: "ancient" },
  { label: "front-attack build", profile: { frontAttackShare: 0.7, backAttackShare: 0 }, family: 26, tier: "high", grade: "ancient" },
  { label: "burst only", profile: { cooldownPenaltyWeight: 1 }, family: 15, tier: "high", grade: "ancient" },
  { label: "sustained only", profile: { cooldownPenaltyWeight: 0 }, family: 15, tier: "high", grade: "ancient" },
  { label: "support stub", profile: { role: "support" }, family: 29, tier: "high", grade: "ancient" },
  { label: "solo (no allies)", profile: { allyDpsCount: 0 }, family: 17, tier: "high", grade: "ancient" }
].map(function (c) {
  var p = B.normalizeProfile(c.profile);
  return { label: c.label, profile: c.profile, grade: c.grade, family: c.family, tier: c.tier,
    damage: r9(B.lineDamage({ cat: "special", family: c.family, tier: c.tier }, c.grade, p)) };
});

// ---------------------------------------------------------------- traits
// The bracelet's two FIXED combat-trait lines. Crit converts exactly (35 pp of
// crit rate per 699 points) and runs through the crit model; Spec and
// Swiftness are scored by the class's own weight, in points per 100 points.
var traitCases = [
  { label: "default: crit 120 + spec 120", traits: { crit: 120, spec: 120 }, profile: {} },
  { label: "relic band top: crit 100 + spec 100", traits: { crit: 100, spec: 100 }, profile: {} },
  { label: "band floor: crit 61 + swift 61", traits: { crit: 61, swift: 61 }, profile: {} },
  { label: "spec + swift only", traits: { spec: 120, swift: 96 }, profile: {} },
  { label: "crit only", traits: { crit: 120 }, profile: {} },
  { label: "crit at cap (crit rate already 100%)", traits: { crit: 120 },
    profile: { skills: [{ share: 1, critRate: 1.0, critDamage: 2.8 }] } },
  { label: "zero weights", traits: { crit: 120, spec: 120 },
    profile: { traitWeights: { spec: 0, swift: 0 } } },
  { label: "heavy spec weight", traits: { spec: 120 }, profile: { traitWeights: { spec: 0.04 } } },
  { label: "no traits", traits: {}, profile: {} }
].map(function (c) {
  var p = B.normalizeProfile(c.profile);
  return { label: c.label, traits: c.traits, profile: c.profile, damage: r9(B.traitDamage(c.traits, p)) };
});

// A solve carrying the fixed traits: the whole readout shifts by exactly that
// constant, and nothing about the DP's shape changes.
var traitSolve = (function () {
  var base = { grade: "ancient", profile: {}, slots: 2, rollsLeft: 3,
    fixedLines: [], grantedLines: [{ cat: "special", family: 32, tier: "high" }],
    goldPer1Pct: 30000, baselinePct: 0 };
  var plain = B.solve(base);
  var withT = B.solve({ grade: base.grade, profile: base.profile, slots: base.slots,
    rollsLeft: base.rollsLeft, fixedLines: base.fixedLines, grantedLines: base.grantedLines,
    goldPer1Pct: base.goldPer1Pct, baselinePct: base.baselinePct,
    traitValues: { crit: 120, spec: 120 } });
  return {
    traitValues: { crit: 120, spec: 120 },
    grade: base.grade, slots: base.slots, rollsLeft: base.rollsLeft,
    granted: base.grantedLines, goldPer1Pct: base.goldPer1Pct,
    traitDamage: r9(withT.traitDamage),
    plainCurrent: r9(plain.currentScore), plainFinal: r9(plain.expectedFinal),
    traitCurrent: r9(withT.currentScore), traitFinal: r9(withT.expectedFinal),
    traitValueGold: r9(withT.valueGold),
    states: withT.stats.states
  };
})();

// ---------------------------------------------------------------- family grades
// The F-to-S letter each family carries in the slot picker, from the canonical
// default profile. Captured for both grades, flattened for an easy diff.
var familyGradeCases = ["relic", "ancient"].map(function (g) {
  var fg = B.familyGrades(g);
  var flat = {}, cat, k;
  ["basic", "trait", "special"].forEach(function (c) {
    for (k in fg[c]) if (Object.prototype.hasOwnProperty.call(fg[c], k)) {
      flat[c + ":" + k] = { avg: r9(fg[c][k].avg), share: r9(fg[c][k].share), letter: fg[c][k].letter };
    }
  });
  return { grade: g, bestAvg: r9(fg.bestAvg), entries: flat };
});

// ---------------------------------------------------------------- pools
var poolCases = [
  { label: "empty bracelet", grade: "ancient", lines: [] },
  { label: "two fixed traits (trait cap full)", grade: "ancient",
    lines: [{ cat: "trait", family: "crit" }, { cat: "trait", family: "spec" }] },
  { label: "traits full + one special", grade: "ancient",
    lines: [{ cat: "trait", family: "crit" }, { cat: "trait", family: "spec" }, { cat: "special", family: 32, tier: "high" }] },
  { label: "basics full", grade: "relic",
    lines: [{ cat: "basic", family: "mainStat" }, { cat: "basic", family: "vitality" }] },
  { label: "five specials (special cap full)", grade: "ancient",
    lines: [{ cat: "special", family: 31, tier: "high" }, { cat: "special", family: 32, tier: "high" },
      { cat: "special", family: 33, tier: "high" }, { cat: "special", family: 23, tier: "high" },
      { cat: "special", family: 24, tier: "high" }] }
].map(function (c) {
  var pool = B.buildPool({ grade: c.grade, profile: P, lines: c.lines });
  var sum = 0, i;
  for (i = 0; i < pool.entries.length; i++) sum += pool.entries[i].p;
  var pick = {};
  ["basic:mainStat:b0", "basic:vitality", "trait:crit", "special:32:high", "special:33:low", "special:4"].forEach(function (k) {
    for (var j = 0; j < pool.entries.length; j++) if (pool.entries[j].key === k) { pick[k] = r9(pool.entries[j].p); return; }
    pick[k] = null;
  });
  return { label: c.label, grade: c.grade, lines: c.lines, entries: pool.entries.length,
    pSum: r9(sum), survivingMass: r9(pool.survivingMass), excludedMass: r9(pool.excludedMass),
    byCategory: { basic: r9(pool.byCategory.basic), trait: r9(pool.byCategory.trait), special: r9(pool.byCategory.special) },
    pick: pick };
});

// ---------------------------------------------------------------- decoder
var decoderCases = [
  {
    label: "live payload (mechanics doc)",
    grade: "ancient",
    stats: [
      { type: 2, index: 15, id: 213400023, value: 101, fixed: true },
      { type: 2, index: 18, id: 213400023, value: 81, fixed: true },
      { type: 3, index: 11051, id: 213400023, value: 5, fixed: false },
      { type: 2, index: 11, id: 213400023, value: 13888, fixed: false },
      { type: 2, index: 76, id: 213400023, value: 840, fixed: false }
    ]
  },
  {
    label: "type 4 ability + unknown index",
    grade: "relic",
    stats: [
      { type: 4, index: 605100133, value: 1, fixed: false },   // family 22, grade 3 -> low
      { type: 2, index: 9999, value: 42, fixed: false },
      { type: 2, index: 50, value: 350, fixed: false }         // Additional Damage 3.50%
    ]
  },
  { label: "grade inferred", grade: null,
    stats: [{ type: 2, index: 76, value: 1000, fixed: false }] }
].map(function (c) {
  var out = B.decodeBibleBracelet(c.stats, c.grade ? { grade: c.grade } : {});
  return { label: c.label, grade: c.grade, stats: c.stats, out: out };
});

// ---------------------------------------------------------------- tiny DP vs brute force
// Three families, small slot counts, hand-sized so the naked recursion in
// bruteSolve() can enumerate the whole tree.
var TINY = [
  { key: "A", cat: "special", family: "t:A", weight: 20, damage: 3.0 },
  { key: "B", cat: "special", family: "t:B", weight: 30, damage: 1.5 },
  { key: "C", cat: "special", family: "t:C", weight: 50, damage: 0 }
];
var TINY2 = [
  { key: "A", cat: "special", family: "t:A", weight: 12, damage: 4.0 },
  { key: "B", cat: "special", family: "t:B", weight: 18, damage: 2.5 },
  { key: "D", cat: "basic", family: "b:D", weight: 40, damage: 1.0 },
  { key: "E", cat: "basic", family: "b:E", weight: 30, damage: 0 }
];
var tinyCases = [];
[
  { pool: TINY, slots: 2, rolls: 2, granted: [] },
  { pool: TINY, slots: 2, rolls: 2, granted: [{ key: "B", cat: "special", family: "t:B" }, { key: "C", cat: "special", family: "t:C" }] },
  { pool: TINY, slots: 2, rolls: 3, granted: [{ key: "A", cat: "special", family: "t:A" }, { key: "C", cat: "special", family: "t:C" }] },
  { pool: TINY, slots: 3, rolls: 2, granted: [] },
  { pool: TINY, slots: 1, rolls: 4, granted: [{ key: "B", cat: "special", family: "t:B" }] },
  { pool: TINY2, slots: 2, rolls: 2, granted: [{ key: "E", cat: "basic", family: "b:E" }, { key: "B", cat: "special", family: "t:B" }] },
  { pool: TINY2, slots: 3, rolls: 3, granted: [] },
  { pool: TINY2, slots: 2, rolls: 1, granted: [{ key: "A", cat: "special", family: "t:A" }, { key: "D", cat: "basic", family: "b:D" }] }
].forEach(function (c, i) {
  var opts = { grade: "ancient", profile: {}, slots: c.slots, rollsLeft: c.rolls,
    grantedLines: c.granted, goldPer1Pct: 1000, options: { testPool: c.pool } };
  var dp = B.solve(opts);
  var bf = B.bruteSolve(opts);
  tinyCases.push({
    label: "tiny#" + i, pool: c.pool, slots: c.slots, rollsLeft: c.rolls, granted: c.granted,
    expectedFinal: r9(dp.expectedFinal), brute: r9(bf.expectedFinal),
    currentScore: r9(dp.currentScore), distMean: r9(dp.finalScore.mean),
    states: dp.stats.states, evByRollsLeft: dp.evByRollsLeft.map(r9)
  });
});

// ---------------------------------------------------------------- full solves
var FIXED_TRAITS = [{ cat: "trait", family: "crit", value: 110 }, { cat: "trait", family: "spec", value: 100 }];
var solveCases = [
  { label: "unrolled ancient, 2 slots, 7 rolls", grade: "ancient", slots: 2, rollsLeft: 7, granted: [] },
  { label: "unrolled ancient, 3 slots, 7 rolls", grade: "ancient", slots: 3, rollsLeft: 7, granted: [] },
  { label: "unrolled relic, 2 slots, 7 rolls", grade: "relic", slots: 2, rollsLeft: 7, granted: [] },
  { label: "mid-roll ancient 3 slots, 4 left", grade: "ancient", slots: 3, rollsLeft: 4,
    granted: [{ cat: "special", family: 32, tier: "high" }, { cat: "special", family: 23, tier: "low" },
      { cat: "basic", family: "mainStat", value: 13888 }] },
  { label: "near-final ancient 2 slots, 1 left", grade: "ancient", slots: 2, rollsLeft: 1,
    granted: [{ cat: "special", family: 32, tier: "high" }, { cat: "special", family: 12, tier: "high" }] }
].map(function (c) {
  var res = B.solve({ grade: c.grade, profile: {}, slots: c.slots, rollsLeft: c.rollsLeft,
    fixedLines: FIXED_TRAITS, grantedLines: c.granted, goldPer1Pct: 30000, baselinePct: 0 });
  return {
    label: c.label, grade: c.grade, slots: c.slots, rollsLeft: c.rollsLeft, granted: c.granted,
    unrolled: res.unrolled,
    currentScore: r9(res.currentScore), expectedFinal: r9(res.expectedFinal),
    distMean: r9(res.finalScore.mean), valueGold: r9(res.valueGold), pImprove: r9(res.pImprove),
    quantiles: { p10: r9(res.finalScore.quantiles.p10), p25: r9(res.finalScore.quantiles.p25),
      p50: r9(res.finalScore.quantiles.p50), p75: r9(res.finalScore.quantiles.p75),
      p90: r9(res.finalScore.quantiles.p90) },
    evByRollsLeft: res.evByRollsLeft.map(r9),
    bestLockMask: res.bestLockMask ? { lockedKeys: res.bestLockMask.lockedKeys, ev: r9(res.bestLockMask.ev) } : null,
    maskEVTop: res.maskEV.slice(0, 3).map(function (m) { return { lockedKeys: m.lockedKeys, ev: r9(m.ev) }; }),
    states: res.stats.states, stateAtoms: res.stats.stateAtoms, lockMasks: res.stats.lockMasks
  };
});

// ---------------------------------------------------------------- advise
var adviseCtx = B.solve({ grade: "ancient", profile: {}, slots: 2, rollsLeft: 3,
  fixedLines: FIXED_TRAITS, grantedLines: [{ cat: "special", family: 32, tier: "high" }, { cat: "special", family: 23, tier: "low" }],
  goldPer1Pct: 30000 });
var adviseCases = [
  { label: "clear upgrade", current: [{ cat: "special", family: 32, tier: "high" }, { cat: "special", family: 23, tier: "low" }],
    rolled: [{ cat: "special", family: 12, tier: "high" }, { cat: "special", family: 31, tier: "high" }], rollsLeft: 2 },
  { label: "clear downgrade", current: [{ cat: "special", family: 32, tier: "high" }, { cat: "special", family: 23, tier: "low" }],
    rolled: [{ cat: "special", family: 4 }, { cat: "basic", family: "vitality" }], rollsLeft: 2 },
  { label: "last roll", current: [{ cat: "special", family: 32, tier: "high" }, { cat: "special", family: 23, tier: "low" }],
    rolled: [{ cat: "special", family: 12, tier: "mid" }, { cat: "special", family: 23, tier: "high" }], rollsLeft: 0 }
].map(function (c) {
  var a = B.advise(adviseCtx.ctx, { current: c.current, rolled: c.rolled, rollsLeft: c.rollsLeft });
  return { label: c.label, current: c.current, rolled: c.rolled, rollsLeft: c.rollsLeft,
    verdict: a.verdict, vKeep: r9(a.vKeep), vNew: r9(a.vNew),
    scoreKeep: r9(a.scoreKeep), scoreNew: r9(a.scoreNew) };
});
var adviseSetup = { grade: "ancient", slots: 2, rollsLeft: 3, fixedLines: FIXED_TRAITS,
  grantedLines: [{ cat: "special", family: 32, tier: "high" }, { cat: "special", family: 23, tier: "low" }],
  goldPer1Pct: 30000 };

// ---------------------------------------------------------------- write
var refs = {
  meta: {
    generated: new Date().toISOString(),
    modelSig: B.MODEL_SIG,
    floatTolerance: 1e-8,
    note: "Captured references for the bracelet core. Regenerate with `node tools/gen-refs.js`. " +
      "Scoring is % damage in log space (D = 100*ln(multiplier)); the solver's V is the expected " +
      "final score under optimal play with free rerolls."
  },
  derivation: derivation,
  profileScalars: profileScalars,
  listed: listed,
  lines: lines,
  profileVariants: profileVariants,
  traits: traitCases,
  traitSolve: traitSolve,
  familyGrades: familyGradeCases,
  pools: poolCases,
  decoder: decoderCases,
  tinyDP: tinyCases,
  solves: solveCases,
  adviseSetup: adviseSetup,
  advise: adviseCases
};

fs.writeFileSync(path.join(__dirname, "..", "refs.json"), JSON.stringify(refs, null, 2) + "\n");
console.log("wrote refs.json  (" +
  derivation.length + " derivation, " + lines.length + " lines, " + poolCases.length + " pools, " + traitCases.length + " traits, " +
  decoderCases.length + " decoder, " + tinyCases.length + " tiny DP, " + solveCases.length + " solves)");
