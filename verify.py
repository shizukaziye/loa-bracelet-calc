#!/usr/bin/env python3
"""verify.py - recompute every entry in refs.json with model/bracelet.py and
assert equality to the JS-produced values, plus the same first-principles
re-derivations verify.js runs.

refs.json is generated FROM the JS core, so a green run here means bracelet.py
matches bracelet.js. Floats compare with abs tolerance refs.meta.floatTolerance
(1e-8); structure compares exactly. Stdlib only.

Run: python verify.py
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "model"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))

import bracelet as B          # noqa: E402
import bracelet_data as DATA  # noqa: E402
import gear_data as GEAR      # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "refs.json"), "r") as fh:
    refs = json.load(fh)

TOL = refs["meta"].get("floatTolerance", 1e-9)

_pass = 0
_fail = 0
_failures = []


def r9(x):
    if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x):
        return round(x * 1e9) / 1e9
    return x


def approx(a, b):
    if a == b:
        return True
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return False
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    return abs(a - b) <= TOL


def check(label, got, want, exact=False):
    global _pass, _fail
    ok = (got == want) if exact else approx(got, want)
    if ok:
        _pass += 1
    else:
        _fail += 1
        _failures.append("%s  got=%s  want=%s" % (label, got, want))


def check_true(label, cond):
    check(label, bool(cond), True, exact=True)


P = B.normalize_profile({})

# ================= 1. derivation =================
for i, c in enumerate(refs["derivation"]):
    d = B.derive_baseline(c["input"])
    check("derivation[%d].ilvl" % i, d["ilvl"], c["out"]["ilvl"], exact=True)
    check("derivation[%d].armorMainStat" % i, d["armorMainStat"], c["out"]["armorMainStat"], exact=True)
    check("derivation[%d].mainStatRaw" % i, d["mainStatRaw"], c["out"]["mainStatRaw"], exact=True)
    check("derivation[%d].weaponPowerRaw" % i, d["weaponPowerRaw"], c["out"]["weaponPowerRaw"], exact=True)
    check("derivation[%d].mainStatTotal" % i, r9(d["mainStatTotal"]), c["out"]["mainStatTotal"])
    check("derivation[%d].weaponPowerTotal" % i, r9(d["weaponPowerTotal"]), c["out"]["weaponPowerTotal"])

S = GEAR.SERCA
_armor = S[21][0] + S[21][1] + S[21][2] + S[21][3] + S[23][4]
_raw = _armor + 71429 + 477 + 2085
_d = B.derive_baseline()
check("analytic.armorMainStat", _d["armorMainStat"], 629835, exact=True)
check("analytic.armorMainStat.sum", _armor, 629835, exact=True)
check("analytic.mainStatRaw", _d["mainStatRaw"], _raw, exact=True)
check("analytic.mainStatRaw.value", _raw, 703826, exact=True)
check("analytic.weaponPowerRaw", _d["weaponPowerRaw"], 241367, exact=True)
check("analytic.mainStatTotal", r9(_d["mainStatTotal"]), r9(703826 * 1.09))
check("analytic.weaponPowerTotal", r9(_d["weaponPowerTotal"]), r9(241367 * 1.085))
check("analytic.ilvl", _d["ilvl"], 1785, exact=True)

# ================= 2. profile scalars =================
_s = refs["profileScalars"]
check("scalars.addDamagePool", r9(B.add_damage_pool(P)), _s["addDamagePool"])
check("scalars.addDamagePoolMaster", r9(B.add_damage_pool(B.normalize_profile({"master": True}))),
      _s["addDamagePoolMaster"])
check("scalars.critFactor", r9(B.crit_factor(P, 0, 0)), _s["critFactor"])
check("scalars.allyCritFactor", r9(B.ally_crit_factor(P, 0, 0)), _s["allyCritFactor"])
check("scalars.attackPower", r9(B.attack_power(P, 0, 0)), _s["attackPower"])
check("scalars.attackPowerNoFlat", r9(B.attack_power(B.normalize_profile({"flatAP": 0}), 0, 0)),
      _s["attackPowerNoFlat"])
check("scalars.defShredGain2_1", r9(B.def_shred_gain(P, 2.1)), _s["defShredGain2_1"])
check("scalars.basicExpectedRelic", r9(B.basic_band_expected("mainStat", "relic")), _s["basicExpectedRelic"])
check("scalars.basicExpectedAncient", r9(B.basic_band_expected("mainStat", "ancient")), _s["basicExpectedAncient"])
check("scalars.traitExpectedRelic", r9(B.trait_band_expected("relic")), _s["traitExpectedRelic"])
check("scalars.traitExpectedAncient", r9(B.trait_band_expected("ancient")), _s["traitExpectedAncient"])

check("analytic.addDamagePool", r9(B.add_damage_pool(P)), r9(0.30 + 0.01 + 0.0484 + 0.026))
check("analytic.master", r9(B.add_damage_pool(B.normalize_profile({"master": True})) - B.add_damage_pool(P)), 0.07)
check("analytic.critFactor", r9(B.crit_factor(P, 0, 0)), r9(1 + 0.9 * (2.8 - 1)))
check("analytic.attackPower", r9(B.attack_power(P, 0, 0)),
      r9(math.sqrt(703826 * 1.09 * 241367 * 1.085 / 6) * 1.125 + 2700))
check("analytic.defShred", r9(B.def_shred_gain(P, 2.1)), r9(2 / (2 - 0.021)))

# ================= 3. listed probabilities =================
_L = refs["listed"]
check("listed.grantedSum", r9(DATA.GRANTED_LISTED_SUM), _L["grantedListedSum"])
check("listed.fixedSum", r9(DATA.FIXED_LISTED_SUM), _L["fixedListedSum"])
check("analytic.grantedSum", r9(DATA.GRANTED_LISTED_SUM), 100.00016)
check("analytic.fixedSum", r9(DATA.FIXED_LISTED_SUM), 100)
for i, s in enumerate(_L["spot"]):
    fam = DATA.SPECIAL_BY_ID[s["id"]]
    check("listed.spot[%d].granted" % i, fam["granted"][s["tier"]], s["granted"])
    check("listed.spot[%d].fixed" % i, fam["fixed"][s["tier"]] if fam["fixed"] else None, s["fixed"], exact=True)
for i, v in enumerate(_L["values"]):
    got = DATA.SPECIAL_BY_ID[v["id"]]["values"][v["grade"]][v["tier"]]
    check("listed.values[%d].len" % i, len(got), len(v["value"]), exact=True)
    for j in range(len(v["value"])):
        check("listed.values[%d][%d]" % (i, j), got[j], v["value"][j])
check("analytic.grantOnlyCount",
      sum(1 for fid in range(1, 34) if DATA.SPECIAL_BY_ID[fid]["grantOnly"]), 23, exact=True)

# ================= 4. line scores =================
for i, c in enumerate(refs["lines"]):
    if c.get("cat") in ("basic", "trait"):
        line = {"cat": c["cat"], "family": c["family"], "value": c["value"]}
    else:
        line = {"cat": "special", "family": c["family"], "tier": c["tier"]}
    check("lines[%d]" % i, r9(B.line_damage(line, c["grade"], P)), c["damage"])

for i, c in enumerate(refs["profileVariants"]):
    p = B.normalize_profile(c["profile"])
    check("profileVariants[%d] %s" % (i, c["label"]),
          r9(B.line_damage({"cat": "special", "family": c["family"], "tier": c["tier"]}, c["grade"], p)),
          c["damage"])


def _D(m):
    return 100 * math.log(m)


def _d(fam, tier, grade="ancient"):
    return B.line_damage({"cat": "special", "family": fam, "tier": tier}, grade, P)


check("analytic.f23.ancient.high", r9(_d(23, "high")), r9(_D(1.03)))
check("analytic.f24.ancient.high", r9(_d(24, "high")), r9(_D((1.3844 + 0.04) / 1.3844)))
check("analytic.f32.ancient.high", r9(_d(32, "high")), r9(_D((1 + 0.9 * (2.9 - 1)) / (1 + 0.9 * (2.8 - 1)))))
check("analytic.f31.ancient.high", r9(_d(31, "high")), r9(_D((1 + 0.95 * 1.8) / (1 + 0.9 * 1.8))))
check("analytic.f12.ancient.high", r9(_d(12, "high")), r9(_D((1 + 0.9 * (2.9 * 1.015 - 1)) / (1 + 0.9 * 1.8))))

_ap0 = math.sqrt(703826 * 1.09 * 241367 * 1.085 / 6) * 1.125 + 2700
_ap1 = math.sqrt(703826 * 1.09 * 250367 * 1.085 / 6) * 1.125 + 2700
check("analytic.f33.ancient.high", r9(_d(33, "high")), r9(_D(_ap1 / _ap0)))
_p_no_flat = B.normalize_profile({"flatAP": 0})
check("analytic.f33.noFlatAP",
      r9(B.line_damage({"cat": "special", "family": 33, "tier": "high"}, "ancient", _p_no_flat)),
      r9(_D(math.sqrt(250367 / 241367))))
check_true("analytic.flatAP dampens WP lines",
           _d(33, "high") < B.line_damage({"cat": "special", "family": 33, "tier": "high"}, "ancient", _p_no_flat))
_ap_ms = math.sqrt((703826 + 13888) * 1.09 * 241367 * 1.085 / 6) * 1.125 + 2700
check("analytic.mainStat.13888",
      r9(B.line_damage({"cat": "basic", "family": "mainStat", "value": 13888}, "ancient", P)), r9(_D(_ap_ms / _ap0)))
check("analytic.f15.ancient.high", r9(_d(15, "high")), r9(_D(0.5 * 1.055 + 0.5 * 1.055 / 1.02)))
check("analytic.f14.ancient.high", r9(_d(14, "high")),
      r9(_D(((1.3844 + 0.035) / 1.3844) * (1 + 0.6 * 0.025 / 1.073))))
_ally_f = 1 + 0.921 * 1.8
check("analytic.f17.relic.high", r9(_d(17, "high", "relic")), r9(_D(1 + 3 * (_ally_f / 2.62 - 1))))
check("analytic.f17.allyFactor", r9(_ally_f), 2.6578)
_ally_g = 1 + 0.9 * (2.848 - 1)
check("analytic.f19.ancient.high", r9(_d(19, "high")), r9(_D(1 + 3 * (_ally_g / 2.62 - 1))))
check("analytic.f18.ancient.high", r9(_d(18, "high")), r9(_D(1 + 3 * 0.6 * 0.013)))
check("analytic.f16.ancient.high", r9(_d(16, "high")), r9(_D(1 + 3 * (2 / (2 - 0.025) - 1))))
check("analytic.f29.dps", r9(_d(29, "high")), 0)
check("analytic.f30.dps", r9(_d(30, "high")), 0)
check("analytic.f28.dps", r9(_d(28, "high")), 0)
for _id in (2, 3, 4, 5, 6, 7, 8, 9, 10):
    check("analytic.junk.%d" % _id, r9(_d(_id, "high")), 0)
check("analytic.vitality", r9(B.line_damage({"cat": "basic", "family": "vitality", "value": 6000}, "ancient", P)), 0)
check("analytic.trait", r9(B.line_damage({"cat": "trait", "family": "crit", "value": 120}, "ancient", P)), 0)
check("analytic.f1.default", r9(_d(1, "high")), 0)
for _id in range(11, 34):
    if _id in (26, 28, 29, 30):
        continue
    check_true("analytic.tierMonotone.%d" % _id,
               _d(_id, "low") <= _d(_id, "mid") + 1e-12 and _d(_id, "mid") <= _d(_id, "high") + 1e-12)
    check_true("analytic.gradeMonotone.%d" % _id, _d(_id, "high", "relic") <= _d(_id, "high") + 1e-12)
_two = B.set_damage([{"cat": "special", "family": 32, "tier": "high"},
                     {"cat": "special", "family": 23, "tier": "high"}], "ancient", P)
check("analytic.additive", r9(_two), r9(_d(32, "high") + _d(23, "high")))
check("analytic.damagePercent", r9(B.damage_percent(_two)), r9((math.exp(_two / 100) - 1) * 100))

# ================= 5. pools =================
for i, c in enumerate(refs["pools"]):
    pool = B.build_pool({"grade": c["grade"], "profile": P, "lines": c["lines"]})
    total = sum(e["p"] for e in pool["entries"])
    check("pools[%d].entries" % i, len(pool["entries"]), c["entries"], exact=True)
    check("pools[%d].pSum" % i, r9(total), c["pSum"])
    check_true("pools[%d].pSumIsOne" % i, abs(total - 1) < 1e-12)
    check("pools[%d].survivingMass" % i, r9(pool["survivingMass"]), c["survivingMass"])
    check("pools[%d].excludedMass" % i, r9(pool["excludedMass"]), c["excludedMass"])
    check_true("pools[%d].massAdds" % i, abs(pool["survivingMass"] + pool["excludedMass"] - 100) < 1e-9)
    for k in ("basic", "trait", "special"):
        check("pools[%d].byCategory.%s" % (i, k), r9(pool["byCategory"][k]), c["byCategory"][k])
    for k, want in c["pick"].items():
        got = None
        for e in pool["entries"]:
            if e["key"] == k:
                got = r9(e["p"])
                break
        check("pools[%d].pick.%s" % (i, k), got, want, exact=(got is None or want is None))

_pool = B.build_pool({"grade": "ancient", "profile": P,
                      "lines": [{"cat": "trait", "family": "crit"}, {"cat": "trait", "family": "spec"}]})
check("analytic.pool.basicShare", r9(_pool["byCategory"]["basic"]), r9(35 / 65.0))
check("analytic.pool.specialShare", r9(_pool["byCategory"]["special"]), r9(30 / 65.0))
check("analytic.pool.traitShare", r9(_pool["byCategory"]["trait"]), 0)
_before = B.build_pool({"grade": "ancient", "profile": P, "lines": []})
_after = B.build_pool({"grade": "ancient", "profile": P,
                       "lines": [{"cat": "special", "family": 33, "tier": "low"}]})
_w_gone = sum(e["listed"] for e in _before["entries"] if e["family"] == "special:33")
check("analytic.pool.excludedMass", r9(_after["excludedMass"]), r9(_w_gone))
_b0 = next(e["p"] for e in _before["entries"] if e["key"] == "special:32:high")
_a0 = next(e["p"] for e in _after["entries"] if e["key"] == "special:32:high")
check("analytic.pool.renorm", r9(_a0), r9(_b0 * 100 / (100 - _w_gone)))

# ================= 6. decoder =================
for i, c in enumerate(refs["decoder"]):
    out = B.decode_bible_bracelet(c["stats"], {"grade": c["grade"]} if c["grade"] else {})
    check("decoder[%d].grade" % i, out["grade"], c["out"]["grade"], exact=True)
    check("decoder[%d].lineCount" % i, len(out["lines"]), len(c["out"]["lines"]), exact=True)
    check("decoder[%d].unknownCount" % i, len(out["unknown"]), len(c["out"]["unknown"]), exact=True)
    for j, w in enumerate(c["out"]["lines"]):
        g = out["lines"][j]
        check("decoder[%d].lines[%d].cat" % (i, j), g["cat"], w["cat"], exact=True)
        check("decoder[%d].lines[%d].family" % (i, j), str(g["family"]), str(w["family"]), exact=True)
        check("decoder[%d].lines[%d].tier" % (i, j), str(g["tier"]), str(w["tier"]), exact=True)
        check("decoder[%d].lines[%d].fixed" % (i, j), g["fixed"], w["fixed"], exact=True)

_o = B.decode_bible_bracelet([{"type": 3, "index": 11000 + 10 * (15 - 10) + 1, "value": 5}], {"grade": "relic"})
check("analytic.decode.type3.family", _o["lines"][0]["family"], 15, exact=True)
check("analytic.decode.type3.tier", _o["lines"][0]["tier"], "high", exact=True)
_o4 = B.decode_bible_bracelet([{"type": 4, "index": 605100000 + 10 * (22 - 10) + 2, "value": 1}], {"grade": "ancient"})
check("analytic.decode.type4.family", _o4["lines"][0]["family"], 22, exact=True)
check("analytic.decode.type4.tier", _o4["lines"][0]["tier"], "mid", exact=True)
_o5 = B.decode_bible_bracelet([{"type": 4, "index": 605100000 + 10 * (11 - 10) + 3, "value": 1}], {"grade": "ancient"})
check("analytic.decode.gradeDigit3", _o5["lines"][0]["tier"], "low", exact=True)
_o6 = B.decode_bible_bracelet([{"type": 2, "index": 76, "value": 840}], {"grade": "relic"})
check("analytic.decode.centi", _o6["lines"][0]["value"][0], 8.4)
check("analytic.decode.centi.tier", _o6["lines"][0]["tier"], "high", exact=True)
_o7 = B.decode_bible_bracelet([{"type": 2, "index": 4242, "value": 7}], {"grade": "relic"})
check("analytic.decode.unknown", len(_o7["unknown"]), 1, exact=True)
check("analytic.decode.unknown.index", _o7["unknown"][0]["index"], 4242, exact=True)
_band = DATA.BASIC["bands"][6]["ancient"]["mainStat"]
check_true("analytic.decode.intBand", _band[0] <= 13888 <= _band[1])

# ================= 7. tiny DP vs brute force =================
for i, c in enumerate(refs["tinyDP"]):
    opts = {"grade": "ancient", "profile": {}, "slots": c["slots"], "rollsLeft": c["rollsLeft"],
            "grantedLines": c["granted"], "goldPer1Pct": 1000, "options": {"testPool": c["pool"]}}
    dp = B.solve(opts)
    bf = B.brute_solve(opts)
    check("tinyDP[%d].expectedFinal" % i, r9(dp["expectedFinal"]), c["expectedFinal"])
    check("tinyDP[%d].brute" % i, r9(bf["expectedFinal"]), c["brute"])
    check("tinyDP[%d].dpEqualsBrute" % i, dp["expectedFinal"], bf["expectedFinal"])
    check("tinyDP[%d].currentScore" % i, r9(dp["currentScore"]), c["currentScore"])
    check("tinyDP[%d].distMean" % i, r9(dp["finalScore"]["mean"]), c["distMean"])
    check("tinyDP[%d].meanEqualsEV" % i, dp["finalScore"]["mean"], dp["expectedFinal"])
    check("tinyDP[%d].states" % i, dp["stats"]["states"], c["states"], exact=True)
    check_true("tinyDP[%d].distMass" % i, abs(sum(row["p"] for row in dp["finalScore"]["cdf"]) - 1) < 1e-9)
    for r in range(len(dp["evByRollsLeft"])):
        check("tinyDP[%d].evByRollsLeft[%d]" % (i, r), r9(dp["evByRollsLeft"][r]), c["evByRollsLeft"][r])
        if r > 0:
            check_true("tinyDP[%d].monotone[%d]" % (i, r),
                       dp["evByRollsLeft"][r] >= dp["evByRollsLeft"][r - 1] - 1e-12)

# ================= 8. full solves =================
FIXED_TRAITS = [{"cat": "trait", "family": "crit", "value": 110},
                {"cat": "trait", "family": "spec", "value": 100}]
for i, c in enumerate(refs["solves"]):
    res = B.solve({"grade": c["grade"], "profile": {}, "slots": c["slots"], "rollsLeft": c["rollsLeft"],
                   "fixedLines": FIXED_TRAITS, "grantedLines": c["granted"],
                   "goldPer1Pct": 30000, "baselinePct": 0})
    check("solves[%d].unrolled" % i, res["unrolled"], c["unrolled"], exact=True)
    check("solves[%d].currentScore" % i, r9(res["currentScore"]), c["currentScore"])
    check("solves[%d].expectedFinal" % i, r9(res["expectedFinal"]), c["expectedFinal"])
    check("solves[%d].distMean" % i, r9(res["finalScore"]["mean"]), c["distMean"])
    check("solves[%d].valueGold" % i, r9(res["valueGold"]), c["valueGold"])
    check("solves[%d].pImprove" % i, r9(res["pImprove"]), c["pImprove"])
    for q in ("p10", "p25", "p50", "p75", "p90"):
        check("solves[%d].quantiles.%s" % (i, q), r9(res["finalScore"]["quantiles"][q]), c["quantiles"][q])
    check("solves[%d].states" % i, res["stats"]["states"], c["states"], exact=True)
    check("solves[%d].stateAtoms" % i, res["stats"]["stateAtoms"], c["stateAtoms"], exact=True)
    check("solves[%d].lockMasks" % i, res["stats"]["lockMasks"], c["lockMasks"], exact=True)
    for r in range(len(res["evByRollsLeft"])):
        check("solves[%d].evByRollsLeft[%d]" % (i, r), r9(res["evByRollsLeft"][r]), c["evByRollsLeft"][r])
        if r > 0:
            check_true("solves[%d].monotone[%d]" % (i, r),
                       res["evByRollsLeft"][r] >= res["evByRollsLeft"][r - 1] - 1e-12)
    check("solves[%d].meanEqualsEV" % i, res["finalScore"]["mean"], res["expectedFinal"])
    check_true("solves[%d].distMass" % i, abs(sum(row["p"] for row in res["finalScore"]["cdf"]) - 1) < 1e-9)
    q = res["finalScore"]["quantiles"]
    check_true("solves[%d].quantileOrder" % i,
               q["p10"] <= q["p25"] <= q["p50"] <= q["p75"] <= q["p90"])
    check_true("solves[%d].evAtLeastCurrent" % i, res["expectedFinal"] >= res["currentScore"] - 1e-12)
    if c["bestLockMask"]:
        check("solves[%d].bestLock.ev" % i, r9(res["bestLockMask"]["ev"]), c["bestLockMask"]["ev"])
        check("solves[%d].bestLock.keys" % i, "|".join(res["bestLockMask"]["lockedKeys"]),
              "|".join(c["bestLockMask"]["lockedKeys"]), exact=True)
        check("solves[%d].bestLockIsEV" % i, res["bestLockMask"]["ev"], res["expectedFinal"])
        for mm, m in enumerate(res["maskEV"]):
            check_true("solves[%d].maskEVsorted[%d]" % (i, mm), m["ev"] <= res["bestLockMask"]["ev"] + 1e-12)
    else:
        check("solves[%d].bestLockNull" % i, res["bestLockMask"], None, exact=True)
    for j, m in enumerate(c["maskEVTop"]):
        check("solves[%d].maskEV[%d].ev" % (i, j), r9(res["maskEV"][j]["ev"]), m["ev"])
        check("solves[%d].maskEV[%d].keys" % (i, j), "|".join(res["maskEV"][j]["lockedKeys"]),
              "|".join(m["lockedKeys"]), exact=True)
    cdf = res["finalScore"]["cdf"]
    check_true("solves[%d].pAtLeastFloor" % i, abs(B.p_at_least(cdf, cdf[0]["score"]) - 1) < 1e-9)
    check_true("solves[%d].pAtLeastCeil" % i, B.p_at_least(cdf, cdf[-1]["score"] + 1) == 0)
    check_true("solves[%d].pAtLeastMono" % i,
               B.p_at_least(cdf, q["p50"]) >= B.p_at_least(cdf, q["p90"]) - 1e-12)

_two_slot = next(c for c in refs["solves"] if "ancient, 2 slots" in c["label"])
_three_slot = next(c for c in refs["solves"] if "ancient, 3 slots" in c["label"])
_relic = next(c for c in refs["solves"] if "relic, 2 slots" in c["label"])
check_true("analytic.threeBeatsTwo", _three_slot["expectedFinal"] > _two_slot["expectedFinal"])
check_true("analytic.ancientBeatsRelic", _two_slot["expectedFinal"] > _relic["expectedFinal"])
check_true("analytic.valueGold", abs(_three_slot["valueGold"] - _three_slot["expectedFinal"] * 30000) < 1e-3)

# ================= 9. advise =================
_setup = refs["adviseSetup"]
_solved = B.solve({"grade": _setup["grade"], "profile": {}, "slots": _setup["slots"],
                   "rollsLeft": _setup["rollsLeft"], "fixedLines": _setup["fixedLines"],
                   "grantedLines": _setup["grantedLines"], "goldPer1Pct": _setup["goldPer1Pct"]})
for i, c in enumerate(refs["advise"]):
    a = B.advise(_solved["ctx"], {"current": c["current"], "rolled": c["rolled"], "rollsLeft": c["rollsLeft"]})
    check("advise[%d].verdict" % i, a["verdict"], c["verdict"], exact=True)
    check("advise[%d].vKeep" % i, r9(a["vKeep"]), c["vKeep"])
    check("advise[%d].vNew" % i, r9(a["vNew"]), c["vNew"])
    check("advise[%d].scoreKeep" % i, r9(a["scoreKeep"]), c["scoreKeep"])
    check("advise[%d].scoreNew" % i, r9(a["scoreNew"]), c["scoreNew"])
    check("advise[%d].verdictFollowsV" % i, a["verdict"],
          "replace" if a["vNew"] > a["vKeep"] + 1e-12 else "keep", exact=True)
_last = B.advise(_solved["ctx"], {"current": _setup["grantedLines"],
                                  "rolled": [{"cat": "special", "family": 12, "tier": "high"},
                                             {"cat": "special", "family": 31, "tier": "high"}],
                                  "rollsLeft": 0})
check("analytic.advise.zeroRolls.keep", r9(_last["vKeep"]), r9(_last["scoreKeep"]))
check("analytic.advise.zeroRolls.new", r9(_last["vNew"]), r9(_last["scoreNew"]))

# ================= summary =================
print("=== verify.py (JS <-> Python parity + first principles) ===")
print("PASS: %d   FAIL: %d" % (_pass, _fail))
if _fail > 0:
    print("\nFailures:")
    for fl in _failures[:40]:
        print("  " + fl)
    if len(_failures) > 40:
        print("  ... and %d more" % (len(_failures) - 40))
    sys.exit(1)
print("ALL CHECKS PASSED")
