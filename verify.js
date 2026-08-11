/**
 * verify.js — recompute every entry in refs.json with model/bracelet.js and
 * assert equality, then re-derive a set of cases from first principles so the
 * battery is not just the model agreeing with itself.
 *
 * Floats compare with abs tolerance refs.meta.floatTolerance (1e-8); structure
 * compares exactly. Prints a PASS/FAIL tally and exits 1 on any mismatch.
 *
 * Run: node verify.js   (or `npm run verify`)
 */
"use strict";
var fs = require("fs");
var path = require("path");
var B = require("./model/bracelet.js");
var DATA = require("./data/bracelet-data.js");
var GEAR = require("./data/gear-data.js");

var refs = JSON.parse(fs.readFileSync(path.join(__dirname, "refs.json"), "utf8"));
var TOL = refs.meta.floatTolerance || 1e-9;

var pass = 0, fail = 0, failures = [];

function r9(x) { return (typeof x === "number" && isFinite(x)) ? Math.round(x * 1e9) / 1e9 : x; }
function approx(a, b) {
  if (a === b) return true;
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (!isFinite(a) || !isFinite(b)) return a === b;
  return Math.abs(a - b) <= TOL;
}
function check(label, got, want, exact) {
  var ok = exact ? (got === want) : approx(got, want);
  if (ok) pass++;
  else { fail++; failures.push(label + "  got=" + got + "  want=" + want); }
}
function checkTrue(label, cond) { check(label, !!cond, true, true); }

var P = B.normalizeProfile({});

// ================= 1. derivation =================
refs.derivation.forEach(function (c, i) {
  var d = B.deriveBaseline(c.input);
  check("derivation[" + i + "].ilvl", d.ilvl, c.out.ilvl, true);
  check("derivation[" + i + "].armorMainStat", d.armorMainStat, c.out.armorMainStat, true);
  check("derivation[" + i + "].mainStatRaw", d.mainStatRaw, c.out.mainStatRaw, true);
  check("derivation[" + i + "].weaponPowerRaw", d.weaponPowerRaw, c.out.weaponPowerRaw, true);
  check("derivation[" + i + "].mainStatTotal", r9(d.mainStatTotal), c.out.mainStatTotal);
  check("derivation[" + i + "].weaponPowerTotal", r9(d.weaponPowerTotal), c.out.weaponPowerTotal);
});

// First principles: the reference build, summed by hand from the Serca table.
(function () {
  var S = GEAR.SERCA;
  var armor = S[21][0] + S[21][1] + S[21][2] + S[21][3] + S[23][4];
  var raw = armor + 71429 + 477 + 2085;
  var d = B.deriveBaseline();
  check("analytic.armorMainStat", d.armorMainStat, 629835, true);
  check("analytic.armorMainStat.sum", armor, 629835, true);
  check("analytic.mainStatRaw", d.mainStatRaw, raw, true);
  check("analytic.mainStatRaw.value", raw, 703826, true);
  check("analytic.weaponPowerRaw", d.weaponPowerRaw, 241367, true);
  check("analytic.mainStatTotal", r9(d.mainStatTotal), r9(703826 * 1.09));
  check("analytic.weaponPowerTotal", r9(d.weaponPowerTotal), r9(241367 * 1.085));
  check("analytic.ilvl", d.ilvl, 1785, true);
})();

// ================= 2. profile scalars =================
(function () {
  var s = refs.profileScalars;
  check("scalars.addDamagePool", r9(B.addDamagePool(P)), s.addDamagePool);
  check("scalars.addDamagePoolMaster", r9(B.addDamagePool(B.normalizeProfile({ master: true }))), s.addDamagePoolMaster);
  check("scalars.critFactor", r9(B.critFactor(P, 0, 0)), s.critFactor);
  check("scalars.allyCritFactor", r9(B.allyCritFactor(P, 0, 0)), s.allyCritFactor);
  check("scalars.attackPower", r9(B.attackPower(P, 0, 0)), s.attackPower);
  check("scalars.attackPowerNoFlat", r9(B.attackPower(B.normalizeProfile({ flatAP: 0 }), 0, 0)), s.attackPowerNoFlat);
  check("scalars.defShredGain2_1", r9(B.defShredGain(P, 2.1)), s.defShredGain2_1);
  check("scalars.basicExpectedRelic", r9(B.basicBandExpected("mainStat", "relic")), s.basicExpectedRelic);
  check("scalars.basicExpectedAncient", r9(B.basicBandExpected("mainStat", "ancient")), s.basicExpectedAncient);
  check("scalars.traitExpectedRelic", r9(B.traitBandExpected("relic")), s.traitExpectedRelic);
  check("scalars.traitExpectedAncient", r9(B.traitBandExpected("ancient")), s.traitExpectedAncient);

  // First principles.
  check("analytic.addDamagePool", r9(B.addDamagePool(P)), r9(0.30 + 0.01 + 0.0484 + 0.026));
  check("analytic.master", r9(B.addDamagePool(B.normalizeProfile({ master: true })) - B.addDamagePool(P)), 0.07);
  check("analytic.critFactor", r9(B.critFactor(P, 0, 0)), r9(1 + 0.9 * (2.8 - 1)));
  check("analytic.attackPower", r9(B.attackPower(P, 0, 0)),
    r9(Math.sqrt(703826 * 1.09 * 241367 * 1.085 / 6) * 1.125 + 2700));
  // Enemy DR 50% -> D = K, so shredding A of the defense gives 2/(2−A).
  check("analytic.defShred", r9(B.defShredGain(P, 2.1)), r9(2 / (2 - 0.021)));
})();

// ================= 3. listed probabilities =================
(function () {
  var L = refs.listed;
  check("listed.grantedSum", r9(DATA.GRANTED_LISTED_SUM), L.grantedListedSum);
  check("listed.fixedSum", r9(DATA.FIXED_LISTED_SUM), L.fixedListedSum);
  // The page rounds: granted lands on 100.00016%, fixed on exactly 100%.
  check("analytic.grantedSum", r9(DATA.GRANTED_LISTED_SUM), 100.00016);
  check("analytic.fixedSum", r9(DATA.FIXED_LISTED_SUM), 100);
  L.spot.forEach(function (s, i) {
    var fam = DATA.SPECIAL_BY_ID[s.id];
    check("listed.spot[" + i + "].granted", fam.granted[s.tier], s.granted);
    check("listed.spot[" + i + "].fixed", fam.fixed ? fam.fixed[s.tier] : null, s.fixed, true);
  });
  L.values.forEach(function (v, i) {
    var got = DATA.SPECIAL_BY_ID[v.id].values[v.grade][v.tier];
    check("listed.values[" + i + "].len", got.length, v.value.length, true);
    for (var j = 0; j < v.value.length; j++) check("listed.values[" + i + "][" + j + "]", got[j], v.value[j]);
  });
  // Families 1–10 are the only fixed-eligible ones.
  var grantOnly = 0;
  for (var id = 1; id <= 33; id++) if (DATA.SPECIAL_BY_ID[id].grantOnly) grantOnly++;
  check("analytic.grantOnlyCount", grantOnly, 23, true);
})();

// ================= 4. line scores =================
refs.lines.forEach(function (c, i) {
  var line = c.cat === "basic" || c.cat === "trait"
    ? { cat: c.cat, family: c.family, value: c.value }
    : { cat: "special", family: c.family, tier: c.tier };
  check("lines[" + i + "]", r9(B.lineDamage(line, c.grade, P)), c.damage);
});

refs.profileVariants.forEach(function (c, i) {
  var p = B.normalizeProfile(c.profile);
  check("profileVariants[" + i + "] " + c.label,
    r9(B.lineDamage({ cat: "special", family: c.family, tier: c.tier }, c.grade, p)), c.damage);
});

// First principles, one closed form per scoring mechanism.
(function () {
  function D(m) { return 100 * Math.log(m); }
  function d(fam, tier, grade) { return B.lineDamage({ cat: "special", family: fam, tier: tier }, grade || "ancient", P); }

  // Outgoing damage: undiluted bucket.
  check("analytic.f23.ancient.high", r9(d(23, "high")), r9(D(1.03)));
  // Additional damage: one additive pool.
  check("analytic.f24.ancient.high", r9(d(24, "high")), r9(D((1.3844 + 0.04) / 1.3844)));
  // Crit damage: 2.8 means a crit deals 2.8x.
  check("analytic.f32.ancient.high", r9(d(32, "high")), r9(D((1 + 0.9 * (2.9 - 1)) / (1 + 0.9 * (2.8 - 1)))));
  // Crit rate.
  check("analytic.f31.ancient.high", r9(d(31, "high")), r9(D((1 + 0.95 * 1.8) / (1 + 0.9 * 1.8))));
  // Crit-hit-damage rider, resolved jointly with the crit-damage part.
  check("analytic.f12.ancient.high", r9(d(12, "high")),
    r9(D((1 + 0.9 * (2.9 * 1.015 - 1)) / (1 + 0.9 * 1.8))));
  // Weapon power: full attack-power ratio (flat AP breaks the pure sqrt).
  var ap0 = Math.sqrt(703826 * 1.09 * 241367 * 1.085 / 6) * 1.125 + 2700;
  var ap1 = Math.sqrt(703826 * 1.09 * 250367 * 1.085 / 6) * 1.125 + 2700;
  check("analytic.f33.ancient.high", r9(d(33, "high")), r9(D(ap1 / ap0)));
  // With flatAP = 0 it collapses to the sqrt ratio.
  var pNoFlat = B.normalizeProfile({ flatAP: 0 });
  check("analytic.f33.noFlatAP",
    r9(B.lineDamage({ cat: "special", family: 33, tier: "high" }, "ancient", pNoFlat)),
    r9(D(Math.sqrt(250367 / 241367))));
  checkTrue("analytic.flatAP dampens WP lines", d(33, "high") <
    B.lineDamage({ cat: "special", family: 33, tier: "high" }, "ancient", pNoFlat));
  // Main stat, same shape.
  var apMs = Math.sqrt((703826 + 13888) * 1.09 * 241367 * 1.085 / 6) * 1.125 + 2700;
  check("analytic.mainStat.13888",
    r9(B.lineDamage({ cat: "basic", family: "mainStat", value: 13888 }, "ancient", P)), r9(D(apMs / ap0)));
  // Family 15: burst-weighted mean of the burst and sustained cases (w = 0.7).
  check("analytic.f15.ancient.high", r9(d(15, "high")), r9(D(0.7 * 1.055 + 0.3 * 1.055 / 1.02)));
  // Family 13: undiluted +3% damage, plus +5% inside stagger windows at a 10% share.
  check("analytic.f13.ancient.high", r9(d(13, "high")), r9(D(1.03 * (1 + 0.10 * 0.05))));
  // Families 20/21/22: weapon power at the hard max-stack / full-uptime
  // assumption. Each component is its own attack-power ratio.
  function apWp(dw) { return Math.sqrt(703826 * 1.09 * (241367 + dw) * 1.085 / 6) * 1.125 + 2700; }
  check("analytic.f20.ancient.high", r9(d(20, "high")), r9(D(apWp(1480 * 6) / ap0)));
  check("analytic.f21.ancient.high", r9(d(21, "high")), r9(D((apWp(9000) / ap0) * (apWp(2400 * 1.0) / ap0))));
  check("analytic.f22.ancient.high", r9(d(22, "high")), r9(D((apWp(8700) / ap0) * (apWp(150 * 30) / ap0))));
  // Family 14: additional damage plus a demon bucket that is GATED OFF by
  // default, so only the additional-damage half of the line scores. That is
  // what keeps it strictly below family 24, which rolls more of the same stat.
  check("analytic.f14.ancient.high", r9(d(14, "high")), r9(D((1.3844 + 0.035) / 1.3844)));
  checkTrue("analytic.f14.belowF24", d(14, "high") < d(24, "high"));
  // Turn the demon gate on and the second half starts paying.
  var pDemon = B.normalizeProfile({ demonShare: 1 });
  check("analytic.f14.demonOn",
    r9(B.lineDamage({ cat: "special", family: 14, tier: "high" }, "ancient", pDemon)),
    r9(D(((1.3844 + 0.035) / 1.3844) * (1 + 1 * 0.025 / 1.073))));
  // Party lines: self gain + 2 ally gains, allies fixed at 90% / 280%.
  var allyF = 1 + 0.921 * 1.8;                       // crit resist −2.1pp
  check("analytic.f17.relic.high", r9(d(17, "high", "relic")), r9(D(1 + 3 * (allyF / 2.62 - 1))));
  check("analytic.f17.allyFactor", r9(allyF), 2.6578);
  var allyG = 1 + 0.9 * (2.848 - 1);                 // crit dmg resist −4.8pp
  check("analytic.f19.ancient.high", r9(d(19, "high")), r9(D(1 + 3 * (allyG / 2.62 - 1))));
  // Family 18: flat +A% at 60% shield uptime, for all three players.
  check("analytic.f18.ancient.high", r9(d(18, "high")), r9(D(1 + 3 * 0.6 * 0.013)));
  // Family 16: defense shred, flat and identical for everyone.
  check("analytic.f16.ancient.high", r9(d(16, "high")), r9(D(1 + 3 * (2 / (2 - 0.025) - 1))));
  // The ally AP-buff rider is worth nothing to a DPS: 16/17 share the A values
  // in the low tier, so their scores must be identical there apart from the
  // shred kind — and 29 (pure ally buff) must score exactly 0.
  check("analytic.f29.dps", r9(d(29, "high")), 0);
  check("analytic.f30.dps", r9(d(30, "high")), 0);
  check("analytic.f28.dps", r9(d(28, "high")), 0);
  // Junk families and vitality score nothing.
  [2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(function (id) { check("analytic.junk." + id, r9(d(id, "high")), 0); });
  check("analytic.vitality", r9(B.lineDamage({ cat: "basic", family: "vitality", value: 6000 }, "ancient", P)), 0);
  check("analytic.trait", r9(B.lineDamage({ cat: "trait", family: "crit", value: 120 }, "ancient", P)), 0);
  // Attack & move speed is out of scope in v1 and scores 0 by default.
  check("analytic.f1.default", r9(d(1, "high")), 0);
  // Tiers are monotone within every scoring family.
  for (var id2 = 11; id2 <= 33; id2++) {
    if (id2 === 28 || id2 === 29 || id2 === 30) continue;   // pure ally-buff: 0 for a DPS
    checkTrue("analytic.tierMonotone." + id2, d(id2, "low") <= d(id2, "mid") + 1e-12 && d(id2, "mid") <= d(id2, "high") + 1e-12);
    checkTrue("analytic.gradeMonotone." + id2, d(id2, "high", "relic") <= d(id2, "high") + 1e-12);
  }
  // Log space is additive: two lines together equal the sum of their scores.
  var two = B.setDamage([{ cat: "special", family: 32, tier: "high" }, { cat: "special", family: 23, tier: "high" }], "ancient", P);
  check("analytic.additive", r9(two), r9(d(32, "high") + d(23, "high")));
  check("analytic.damagePercent", r9(B.damagePercent(two)), r9((Math.exp(two / 100) - 1) * 100));
})();

// ================= 4b. fixed combat traits =================
refs.traits.forEach(function (c, i) {
  var p = B.normalizeProfile(c.profile);
  check("traits[" + i + "] " + c.label, r9(B.traitDamage(c.traits, p)), c.damage);
});

// First principles.
(function () {
  function D(m) { return 100 * Math.log(m); }
  // Crit: 25 pp per 699 points, additive into the crit model, capped at 100%.
  var dcr = 120 * 25 / 699 / 100;
  check("analytic.trait.crit120", r9(B.traitDamage({ crit: 120 }, P)),
    r9(D((1 + (0.9 + dcr) * 1.8) / (1 + 0.9 * 1.8))));
  check("analytic.trait.critPP", r9(120 * B.TRAIT_CRIT_PP_PER_POINT), 4.291845494);
  // Spec / Swiftness: flat points per 100 trait points, no log-space curve.
  check("analytic.trait.spec120", r9(B.traitDamage({ spec: 120 }, P)), 3);
  check("analytic.trait.swift96", r9(B.traitDamage({ swift: 96 }, P)), 2.4);
  // Additive across the two active lines.
  check("analytic.trait.additive", r9(B.traitDamage({ crit: 120, spec: 120 }, P)),
    r9(B.traitDamage({ crit: 120 }, P) + B.traitDamage({ spec: 120 }, P)));
  // A class already at 100% crit gains nothing from a crit trait line.
  check("analytic.trait.critCapped",
    r9(B.traitDamage({ crit: 120 }, B.normalizeProfile({ skills: [{ share: 1, critRate: 1, critDamage: 2.8 }] }))), 0);
  check("analytic.trait.none", r9(B.traitDamage({}, P)), 0);
  // A granted trait roll is still worth nothing — that is what makes the fixed
  // trait total a constant the DP never has to see.
  check("analytic.trait.grantedStillZero",
    r9(B.lineDamage({ cat: "trait", family: "crit", value: 120 }, "ancient", P)), 0);

  // The solve shifts by exactly the constant, and the DP is untouched.
  var t = refs.traitSolve;
  var plain = B.solve({ grade: t.grade, profile: {}, slots: t.slots, rollsLeft: t.rollsLeft,
    fixedLines: [], grantedLines: t.granted, goldPer1Pct: t.goldPer1Pct, baselinePct: 0 });
  var withT = B.solve({ grade: t.grade, profile: {}, slots: t.slots, rollsLeft: t.rollsLeft,
    fixedLines: [], grantedLines: t.granted, goldPer1Pct: t.goldPer1Pct, baselinePct: 0,
    traitValues: t.traitValues });
  check("traitSolve.traitDamage", r9(withT.traitDamage), t.traitDamage);
  check("traitSolve.plainCurrent", r9(plain.currentScore), t.plainCurrent);
  check("traitSolve.plainFinal", r9(plain.expectedFinal), t.plainFinal);
  check("traitSolve.traitCurrent", r9(withT.currentScore), t.traitCurrent);
  check("traitSolve.traitFinal", r9(withT.expectedFinal), t.traitFinal);
  check("traitSolve.valueGold", r9(withT.valueGold), t.traitValueGold);
  check("traitSolve.states", withT.stats.states, t.states, true);
  checkTrue("analytic.traitSolve.currentShift",
    Math.abs((withT.currentScore - plain.currentScore) - withT.traitDamage) < 1e-9);
  checkTrue("analytic.traitSolve.finalShift",
    Math.abs((withT.expectedFinal - plain.expectedFinal) - withT.traitDamage) < 1e-9);
  checkTrue("analytic.traitSolve.gainUnchanged", Math.abs(withT.gain - plain.gain) < 1e-9);
  checkTrue("analytic.traitSolve.dpUnchanged", withT.stats.states === plain.stats.states);
  checkTrue("analytic.traitSolve.pImproveUnchanged", Math.abs(withT.pImprove - plain.pImprove) < 1e-12);
  checkTrue("analytic.traitSolve.valueGold",
    Math.abs(withT.valueGold - withT.expectedFinal * t.goldPer1Pct) < 1e-3);
})();

// ================= 4c. family letter grades =================
refs.familyGrades.forEach(function (c) {
  var fg = B.familyGrades(c.grade);
  var flat = {}, k;
  ["basic", "trait", "special"].forEach(function (cat) {
    for (k in fg[cat]) if (Object.prototype.hasOwnProperty.call(fg[cat], k)) flat[cat + ":" + k] = fg[cat][k];
  });
  check("familyGrades[" + c.grade + "].bestAvg", r9(fg.bestAvg), c.bestAvg);
  check("familyGrades[" + c.grade + "].count", Object.keys(flat).length, Object.keys(c.entries).length, true);
  Object.keys(c.entries).forEach(function (k2) {
    check("familyGrades[" + c.grade + "]." + k2 + ".avg", r9(flat[k2].avg), c.entries[k2].avg);
    check("familyGrades[" + c.grade + "]." + k2 + ".share", r9(flat[k2].share), c.entries[k2].share);
    check("familyGrades[" + c.grade + "]." + k2 + ".letter", flat[k2].letter, c.entries[k2].letter, true);
  });
});

// First principles.
(function () {
  var fg = B.familyGrades("ancient");
  var P0 = B.normalizeProfile({});
  function d(id, t) { return B.lineDamage({ cat: "special", family: id, tier: t }, "ancient", P0); }
  // The average roll is the three tiers weighted 6 : 3 : 1.
  check("analytic.familyGrades.avg32", r9(fg.special[32].avg),
    r9(0.6 * d(32, "low") + 0.3 * d(32, "mid") + 0.1 * d(32, "high")));
  // Exactly one family tops the table, and it is graded S.
  var bestId = null, i;
  for (i = 1; i <= 33; i++) if (bestId === null || fg.special[i].avg > fg.special[bestId].avg) bestId = i;
  check("analytic.familyGrades.bestShare", r9(fg.special[bestId].share), 1);
  check("analytic.familyGrades.bestLetter", fg.special[bestId].letter, "S", true);
  check("analytic.familyGrades.bestAvg", r9(fg.bestAvg), r9(fg.special[bestId].avg));
  // Nothing scoring nothing may grade above F, and every junk family is junk.
  var ordered = "FDCBAS";
  for (i = 1; i <= 33; i++) {
    if (fg.special[i].avg <= 0) checkTrue("analytic.familyGrades.zeroIsF." + i, fg.special[i].letter === "F");
    checkTrue("analytic.familyGrades.known." + i, ordered.indexOf(fg.special[i].letter) >= 0);
  }
  // Monotone: a higher average can never carry a lower letter.
  for (i = 1; i <= 33; i++) {
    for (var j = 1; j <= 33; j++) {
      if (fg.special[i].avg > fg.special[j].avg) {
        checkTrue("analytic.familyGrades.monotone." + i + "v" + j,
          ordered.indexOf(fg.special[i].letter) >= ordered.indexOf(fg.special[j].letter));
      }
    }
  }
  // Vitality and a granted combat trait are dead weight, so both grade F.
  check("analytic.familyGrades.vitality", fg.basic.vitality.letter, "F", true);
  check("analytic.familyGrades.trait", fg.trait.crit.letter, "F", true);
  // The letters come from the DEFAULTS, so a wild profile cannot move them.
  var wild = B.familyGrades("ancient");
  check("analytic.familyGrades.stable", wild.special[32].letter, fg.special[32].letter, true);
})();

// ================= 5. pools =================
refs.pools.forEach(function (c, i) {
  var pool = B.buildPool({ grade: c.grade, profile: P, lines: c.lines });
  var sum = 0, j;
  for (j = 0; j < pool.entries.length; j++) sum += pool.entries[j].p;
  check("pools[" + i + "].entries", pool.entries.length, c.entries, true);
  check("pools[" + i + "].pSum", r9(sum), c.pSum);
  checkTrue("pools[" + i + "].pSumIsOne", Math.abs(sum - 1) < 1e-12);
  check("pools[" + i + "].survivingMass", r9(pool.survivingMass), c.survivingMass);
  check("pools[" + i + "].excludedMass", r9(pool.excludedMass), c.excludedMass);
  checkTrue("pools[" + i + "].massAdds", Math.abs(pool.survivingMass + pool.excludedMass - 100) < 1e-9);
  ["basic", "trait", "special"].forEach(function (k) {
    check("pools[" + i + "].byCategory." + k, r9(pool.byCategory[k]), c.byCategory[k]);
  });
  Object.keys(c.pick).forEach(function (k) {
    var got = null;
    for (var q = 0; q < pool.entries.length; q++) if (pool.entries[q].key === k) { got = r9(pool.entries[q].p); break; }
    check("pools[" + i + "].pick." + k, got, c.pick[k], got === null || c.pick[k] === null);
  });
});

// First principles: with both trait slots used up, the 35% trait mass leaves
// and basics/specials renormalise to 35/65 and 30/65.
(function () {
  var pool = B.buildPool({ grade: "ancient", profile: P,
    lines: [{ cat: "trait", family: "crit" }, { cat: "trait", family: "spec" }] });
  check("analytic.pool.basicShare", r9(pool.byCategory.basic), r9(35 / 65));
  check("analytic.pool.specialShare", r9(pool.byCategory.special), r9(30 / 65));
  check("analytic.pool.traitShare", r9(pool.byCategory.trait), 0);
  // A present family is gone entirely, and everything else scales by the same factor.
  var before = B.buildPool({ grade: "ancient", profile: P, lines: [] });
  var after = B.buildPool({ grade: "ancient", profile: P, lines: [{ cat: "special", family: 33, tier: "low" }] });
  var wGone = 0, k;
  for (k = 0; k < before.entries.length; k++) if (before.entries[k].family === "special:33") wGone += before.entries[k].listed;
  check("analytic.pool.excludedMass", r9(after.excludedMass), r9(wGone));
  var b0 = null, a0 = null;
  for (k = 0; k < before.entries.length; k++) if (before.entries[k].key === "special:32:high") b0 = before.entries[k].p;
  for (k = 0; k < after.entries.length; k++) if (after.entries[k].key === "special:32:high") a0 = after.entries[k].p;
  check("analytic.pool.renorm", r9(a0), r9(b0 * 100 / (100 - wGone)));
})();

// ================= 6. decoder =================
refs.decoder.forEach(function (c, i) {
  var out = B.decodeBibleBracelet(c.stats, c.grade ? { grade: c.grade } : {});
  check("decoder[" + i + "].grade", out.grade, c.out.grade, true);
  check("decoder[" + i + "].lineCount", out.lines.length, c.out.lines.length, true);
  check("decoder[" + i + "].unknownCount", out.unknown.length, c.out.unknown.length, true);
  for (var j = 0; j < c.out.lines.length; j++) {
    var g = out.lines[j], w = c.out.lines[j];
    check("decoder[" + i + "].lines[" + j + "].cat", g.cat, w.cat, true);
    check("decoder[" + i + "].lines[" + j + "].family", String(g.family), String(w.family), true);
    check("decoder[" + i + "].lines[" + j + "].tier", String(g.tier), String(w.tier), true);
    check("decoder[" + i + "].lines[" + j + "].fixed", g.fixed, w.fixed, true);
  }
});

// First principles: the index formulas from the mechanics doc.
(function () {
  // type 3: index = 11000 + 10·(family−10) + gradeDigit, 1 = high.
  var out = B.decodeBibleBracelet([{ type: 3, index: 11000 + 10 * (15 - 10) + 1, value: 5 }], { grade: "relic" });
  check("analytic.decode.type3.family", out.lines[0].family, 15, true);
  check("analytic.decode.type3.tier", out.lines[0].tier, "high", true);
  // type 4: same shape off 605100000; grade digit 2 = mid, 3 = low.
  var o4 = B.decodeBibleBracelet([{ type: 4, index: 605100000 + 10 * (22 - 10) + 2, value: 1 }], { grade: "ancient" });
  check("analytic.decode.type4.family", o4.lines[0].family, 22, true);
  check("analytic.decode.type4.tier", o4.lines[0].tier, "mid", true);
  var o5 = B.decodeBibleBracelet([{ type: 4, index: 605100000 + 10 * (11 - 10) + 3, value: 1 }], { grade: "ancient" });
  check("analytic.decode.gradeDigit3", o5.lines[0].tier, "low", true);
  // type 2 percentages arrive in hundredths of a %.
  var o6 = B.decodeBibleBracelet([{ type: 2, index: 76, value: 840 }], { grade: "relic" });
  check("analytic.decode.centi", o6.lines[0].value[0], 8.4);
  check("analytic.decode.centi.tier", o6.lines[0].tier, "high", true);
  // Unmapped indexes pass through untouched.
  var o7 = B.decodeBibleBracelet([{ type: 2, index: 4242, value: 7 }], { grade: "relic" });
  check("analytic.decode.unknown", o7.unknown.length, 1, true);
  check("analytic.decode.unknown.index", o7.unknown[0].index, 4242, true);
  // The live payload's Int +13888 must land in official band 7 (13441–14080).
  var band = DATA.BASIC.bands[6].ancient.mainStat;
  checkTrue("analytic.decode.intBand", 13888 >= band[0] && 13888 <= band[1]);
})();

// ================= 7. tiny DP vs brute force =================
refs.tinyDP.forEach(function (c, i) {
  var opts = { grade: "ancient", profile: {}, slots: c.slots, rollsLeft: c.rollsLeft,
    grantedLines: c.granted, goldPer1Pct: 1000, options: { testPool: c.pool } };
  var dp = B.solve(opts);
  var bf = B.bruteSolve(opts);
  check("tinyDP[" + i + "].expectedFinal", r9(dp.expectedFinal), c.expectedFinal);
  check("tinyDP[" + i + "].brute", r9(bf.expectedFinal), c.brute);
  check("tinyDP[" + i + "].dpEqualsBrute", dp.expectedFinal, bf.expectedFinal);
  check("tinyDP[" + i + "].currentScore", r9(dp.currentScore), c.currentScore);
  check("tinyDP[" + i + "].distMean", r9(dp.finalScore.mean), c.distMean);
  check("tinyDP[" + i + "].meanEqualsEV", dp.finalScore.mean, dp.expectedFinal);
  check("tinyDP[" + i + "].states", dp.stats.states, c.states, true);
  var mass = 0;
  for (var m = 0; m < dp.finalScore.cdf.length; m++) mass += dp.finalScore.cdf[m].p;
  checkTrue("tinyDP[" + i + "].distMass", Math.abs(mass - 1) < 1e-9);
  for (var r = 0; r < dp.evByRollsLeft.length; r++) {
    check("tinyDP[" + i + "].evByRollsLeft[" + r + "]", r9(dp.evByRollsLeft[r]), c.evByRollsLeft[r]);
    if (r > 0) checkTrue("tinyDP[" + i + "].monotone[" + r + "]", dp.evByRollsLeft[r] >= dp.evByRollsLeft[r - 1] - 1e-12);
  }
});

// ================= 8. full solves =================
var FIXED_TRAITS = [{ cat: "trait", family: "crit", value: 110 }, { cat: "trait", family: "spec", value: 100 }];
refs.solves.forEach(function (c, i) {
  var res = B.solve({ grade: c.grade, profile: {}, slots: c.slots, rollsLeft: c.rollsLeft,
    fixedLines: FIXED_TRAITS, grantedLines: c.granted, goldPer1Pct: 30000, baselinePct: 0 });
  check("solves[" + i + "].unrolled", res.unrolled, c.unrolled, true);
  check("solves[" + i + "].currentScore", r9(res.currentScore), c.currentScore);
  check("solves[" + i + "].expectedFinal", r9(res.expectedFinal), c.expectedFinal);
  check("solves[" + i + "].distMean", r9(res.finalScore.mean), c.distMean);
  check("solves[" + i + "].valueGold", r9(res.valueGold), c.valueGold);
  check("solves[" + i + "].pImprove", r9(res.pImprove), c.pImprove);
  ["p10", "p25", "p50", "p75", "p90"].forEach(function (q) {
    check("solves[" + i + "].quantiles." + q, r9(res.finalScore.quantiles[q]), c.quantiles[q]);
  });
  check("solves[" + i + "].states", res.stats.states, c.states, true);
  check("solves[" + i + "].stateAtoms", res.stats.stateAtoms, c.stateAtoms, true);
  check("solves[" + i + "].lockMasks", res.stats.lockMasks, c.lockMasks, true);
  for (var r = 0; r < res.evByRollsLeft.length; r++) {
    check("solves[" + i + "].evByRollsLeft[" + r + "]", r9(res.evByRollsLeft[r]), c.evByRollsLeft[r]);
    // Free rolls: more attempts can never be worth less.
    if (r > 0) checkTrue("solves[" + i + "].monotone[" + r + "]", res.evByRollsLeft[r] >= res.evByRollsLeft[r - 1] - 1e-12);
  }
  // The forward pass walks the DP's own policy, so its mean must be the DP value.
  check("solves[" + i + "].meanEqualsEV", res.finalScore.mean, res.expectedFinal);
  var mass = 0;
  for (var m = 0; m < res.finalScore.cdf.length; m++) mass += res.finalScore.cdf[m].p;
  checkTrue("solves[" + i + "].distMass", Math.abs(mass - 1) < 1e-9);
  // Quantiles must be ordered, and the value can never drop below what you hold.
  var q = res.finalScore.quantiles;
  checkTrue("solves[" + i + "].quantileOrder", q.p10 <= q.p25 && q.p25 <= q.p50 && q.p50 <= q.p75 && q.p75 <= q.p90);
  checkTrue("solves[" + i + "].evAtLeastCurrent", res.expectedFinal >= res.currentScore - 1e-12);
  if (c.bestLockMask) {
    check("solves[" + i + "].bestLock.ev", r9(res.bestLockMask.ev), c.bestLockMask.ev);
    check("solves[" + i + "].bestLock.keys", res.bestLockMask.lockedKeys.join("|"), c.bestLockMask.lockedKeys.join("|"), true);
    // The best mask is the DP's own value at the root.
    check("solves[" + i + "].bestLockIsEV", r9(res.bestLockMask.ev), r9(res.expectedFinal));
    for (var mm = 0; mm < res.maskEV.length; mm++) {
      checkTrue("solves[" + i + "].maskEVsorted[" + mm + "]", res.maskEV[mm].ev <= res.bestLockMask.ev + 1e-12);
    }
  } else {
    check("solves[" + i + "].bestLockNull", res.bestLockMask, null, true);
  }
  c.maskEVTop.forEach(function (m, j) {
    check("solves[" + i + "].maskEV[" + j + "].ev", r9(res.maskEV[j].ev), m.ev);
    check("solves[" + i + "].maskEV[" + j + "].keys", res.maskEV[j].lockedKeys.join("|"), m.lockedKeys.join("|"), true);
  });
  // P(final >= x): everything at or above the floor, nothing above the ceiling,
  // and non-increasing in between.
  var cdfArr = res.finalScore.cdf;
  checkTrue("solves[" + i + "].pAtLeastFloor", Math.abs(B.pAtLeast(cdfArr, cdfArr[0].score) - 1) < 1e-9);
  checkTrue("solves[" + i + "].pAtLeastCeil", B.pAtLeast(cdfArr, cdfArr[cdfArr.length - 1].score + 1) === 0);
  checkTrue("solves[" + i + "].pAtLeastMono",
    B.pAtLeast(cdfArr, res.finalScore.quantiles.p50) >= B.pAtLeast(cdfArr, res.finalScore.quantiles.p90) - 1e-12);
});

// A three-slot bracelet must beat a two-slot one, and Ancient must beat Relic.
(function () {
  var two = null, three = null, relic = null;
  refs.solves.forEach(function (c) {
    if (c.label.indexOf("ancient, 2 slots") >= 0) two = c;
    if (c.label.indexOf("ancient, 3 slots") >= 0) three = c;
    if (c.label.indexOf("relic, 2 slots") >= 0) relic = c;
  });
  checkTrue("analytic.threeBeatsTwo", three.expectedFinal > two.expectedFinal);
  checkTrue("analytic.ancientBeatsRelic", two.expectedFinal > relic.expectedFinal);
  // valueGold is just the score gap times gold per 1% (the refs values are
  // rounded at 1e-9, which 30000× amplifies — compare loosely).
  checkTrue("analytic.valueGold", Math.abs(three.valueGold - three.expectedFinal * 30000) < 1e-3);
})();

// ================= 9. advise =================
(function () {
  var setup = refs.adviseSetup;
  var solved = B.solve({ grade: setup.grade, profile: {}, slots: setup.slots, rollsLeft: setup.rollsLeft,
    fixedLines: setup.fixedLines, grantedLines: setup.grantedLines, goldPer1Pct: setup.goldPer1Pct });
  refs.advise.forEach(function (c, i) {
    var a = B.advise(solved.ctx, { current: c.current, rolled: c.rolled, rollsLeft: c.rollsLeft });
    check("advise[" + i + "].verdict", a.verdict, c.verdict, true);
    check("advise[" + i + "].vKeep", r9(a.vKeep), c.vKeep);
    check("advise[" + i + "].vNew", r9(a.vNew), c.vNew);
    check("advise[" + i + "].scoreKeep", r9(a.scoreKeep), c.scoreKeep);
    check("advise[" + i + "].scoreNew", r9(a.scoreNew), c.scoreNew);
    // The verdict follows the CONTINUATION values, not the raw scores.
    check("advise[" + i + "].verdictFollowsV", a.verdict, a.vNew > a.vKeep + 1e-12 ? "replace" : "keep", true);
  });
  // At zero rolls left the continuation value is just the score.
  var last = B.advise(solved.ctx, { current: setup.grantedLines,
    rolled: [{ cat: "special", family: 12, tier: "high" }, { cat: "special", family: 31, tier: "high" }], rollsLeft: 0 });
  check("analytic.advise.zeroRolls.keep", r9(last.vKeep), r9(last.scoreKeep));
  check("analytic.advise.zeroRolls.new", r9(last.vNew), r9(last.scoreNew));
})();

// ================= summary =================
console.log("=== verify.js (JS self-consistency + first principles) ===");
console.log("PASS: " + pass + "   FAIL: " + fail);
if (fail > 0) {
  console.log("\nFailures:");
  failures.slice(0, 40).forEach(function (f) { console.log("  " + f); });
  if (failures.length > 40) console.log("  ... and " + (failures.length - 40) + " more");
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
