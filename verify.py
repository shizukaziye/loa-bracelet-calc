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
    check("derivation[%d].flatWP" % i, d["flatWP"], c["out"]["flatWP"], exact=True)

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

# Flat WEAPON power is weapon power: it joins the weapon's raw figure and the
# wpPct bucket amplifies the sum. Main stat is untouched.
_d_wp = B.derive_baseline({"flatWP": 9000})
check("analytic.flatWP.total", r9(_d_wp["weaponPowerTotal"]), r9((241367 + 9000) * 1.085))
check("analytic.flatWP.raisesTotalByTheBucket",
      r9(_d_wp["weaponPowerTotal"] - _d["weaponPowerTotal"]), r9(9000 * 1.085))
check("analytic.flatWP.leavesWeaponPowerRawAlone", _d_wp["weaponPowerRaw"], 241367, exact=True)
check("analytic.flatWP.leavesMainStatAlone", r9(_d_wp["mainStatTotal"]), r9(_d["mainStatTotal"]))

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
check("scalars.attackPowerFlatWP", r9(B.attack_power(B.normalize_profile({"flatWP": 9000}), 0, 0)),
      _s["attackPowerFlatWP"])
check("scalars.defShredGain2_1", r9(B.def_shred_gain(P, 2.1)), _s["defShredGain2_1"])
check("scalars.basicExpectedRelic", r9(B.basic_band_expected("mainStat", "relic")), _s["basicExpectedRelic"])
check("scalars.basicExpectedAncient", r9(B.basic_band_expected("mainStat", "ancient")), _s["basicExpectedAncient"])
check("scalars.traitExpectedRelic", r9(B.trait_band_expected("relic")), _s["traitExpectedRelic"])
check("scalars.traitExpectedAncient", r9(B.trait_band_expected("ancient")), _s["traitExpectedAncient"])

check("analytic.addDamagePool", r9(B.add_damage_pool(P)), r9(0.30 + 0.01 + 0.0484 + 0.026))
check("analytic.master", r9(B.add_damage_pool(B.normalize_profile({"master": True})) - B.add_damage_pool(P)), 0.07)
check("analytic.critFactor", r9(B.crit_factor(P, 0, 0)), r9(1 + 0.9 * (2.8 - 1)))
check("analytic.attackPower", r9(B.attack_power(P, 0, 0)),
      r9(math.sqrt(703826 * 1.09 * 241367 * 1.085 / 6) * 1.125 + 3600))
check("analytic.defShred", r9(B.def_shred_gain(P, 2.1)), r9(2 / (2 - 0.021)))

# WHERE FLAT WEAPON POWER GOES - the same three-way pin as verify.js.
_p_flat_wp = B.normalize_profile({"flatWP": 9000})
check("analytic.flatWP.attackPower", r9(B.attack_power(_p_flat_wp, 0, 0)),
      r9(math.sqrt(703826 * 1.09 * (241367 + 9000) * 1.085 / 6) * 1.125 + 3600))
check("analytic.flatWP.isRawWeaponPower", r9(B.attack_power(_p_flat_wp, 0, 0)),
      r9(B.attack_power(B.normalize_profile({"weaponPowerRaw": 241367 + 9000}), 0, 0)))
check("analytic.flatWP.isABraceletWeaponPowerLine", r9(B.attack_power(_p_flat_wp, 0, 0)),
      r9(B.attack_power(P, 0, 9000)))
check_true("analytic.flatWP is not flatAP",
           abs(B.attack_power(_p_flat_wp, 0, 0)
               - B.attack_power(B.normalize_profile({"flatAP": 3600 + 9000}), 0, 0)) > 1)
check_true("analytic.flatWP is worth less per point than flatAP",
           B.attack_power(_p_flat_wp, 0, 0)
           < B.attack_power(B.normalize_profile({"flatAP": 3600 + 9000}), 0, 0))
check("analytic.flatWP.defaultIsZero", P["flatWP"], 0, exact=True)

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

_ap0 = math.sqrt(703826 * 1.09 * 241367 * 1.085 / 6) * 1.125 + 3600
_ap1 = math.sqrt(703826 * 1.09 * 250367 * 1.085 / 6) * 1.125 + 3600
check("analytic.f33.ancient.high", r9(_d(33, "high")), r9(_D(_ap1 / _ap0)))
_p_no_flat = B.normalize_profile({"flatAP": 0})
check("analytic.f33.noFlatAP",
      r9(B.line_damage({"cat": "special", "family": 33, "tier": "high"}, "ancient", _p_no_flat)),
      r9(_D(math.sqrt(250367 / 241367))))
check_true("analytic.flatAP dampens WP lines",
           _d(33, "high") < B.line_damage({"cat": "special", "family": 33, "tier": "high"}, "ancient", _p_no_flat))
_ap_ms = math.sqrt((703826 + 13888) * 1.09 * 241367 * 1.085 / 6) * 1.125 + 3600
check("analytic.mainStat.13888",
      r9(B.line_damage({"cat": "basic", "family": "mainStat", "value": 13888}, "ancient", P)), r9(_D(_ap_ms / _ap0)))
check("analytic.f15.ancient.high", r9(_d(15, "high")), r9(_D(0.7 * 1.055 + 0.3 * 1.055 / 1.02)))
check("analytic.f13.ancient.high", r9(_d(13, "high")), r9(_D(1.03 * (1 + 0.10 * 0.05))))


def _ap_wp(dw):
    return math.sqrt(703826 * 1.09 * (241367 + dw) * 1.085 / 6) * 1.125 + 3600


# family 20 stacks 6x(+1% atk/move speed) alongside the weapon power, and log
# space is additive, so the expected value carries both terms.
check("analytic.f20.ancient.high", r9(_d(20, "high")), r9(_D(_ap_wp(1480 * 6) / _ap0) + _D(1.006)))
# A family carrying TWO weapon-power components adds them and takes ONE
# attack-power ratio - they are the same square root, not two of them. Multiplying
# two ratios, which is what this did until 0.4.0, overstated family 21 by 0.76%
# and family 22 by 1.19% at the top tier.
check("analytic.f21.ancient.high", r9(_d(21, "high")), r9(_D(_ap_wp(9000 + 2400 * 1.0) / _ap0)))
check("analytic.f22.ancient.high", r9(_d(22, "high")), r9(_D(_ap_wp(8700 + 150 * 30) / _ap0)))
# The old form, kept as the thing being ruled out: strictly bigger, because the
# flat attack term breaks the pure ratio.
check_true("analytic.f21.oneSquareRootIsLower",
           _d(21, "high") < _D((_ap_wp(9000) / _ap0) * (_ap_wp(2400) / _ap0)) - 1e-9)
check_true("analytic.f22.oneSquareRootIsLower",
           _d(22, "high") < _D((_ap_wp(8700) / _ap0) * (_ap_wp(4500) / _ap0)) - 1e-9)
# And a two-component family prices exactly like ONE weapon-power component
# carrying the sum: family 22 high is 8,700 + 30 x 150 = 13,200, full stop.
check("analytic.f22.equalsOneWeaponPowerComponent", r9(_d(22, "high")),
      r9(_D(B.component_multiplier("weaponPower", 8700 + 150 * 30, P))))
check("analytic.f21.equalsOneWeaponPowerComponent", r9(_d(21, "high")),
      r9(_D(B.component_multiplier("weaponPower", 9000 + 2400 * 1.0, P))))
check("analytic.f14.ancient.high", r9(_d(14, "high")), r9(_D((1.3844 + 0.035) / 1.3844)))
check_true("analytic.f14.belowF24", _d(14, "high") < _d(24, "high"))
_p_demon = B.normalize_profile({"demonShare": 1})
check("analytic.f14.demonOn",
      r9(B.line_damage({"cat": "special", "family": 14, "tier": "high"}, "ancient", _p_demon)),
      r9(_D(((1.3844 + 0.035) / 1.3844) * (1 + 1 * 0.025 / 1.073))))
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
# +6% atk/move speed at 0.1% damage per 1% = +0.600% damage = 100*ln(1.006)
check("analytic.f1.default", r9(_d(1, "high")), 0.598207168)
for _id in range(11, 34):
    if _id in (28, 29, 30):
        continue
    check_true("analytic.tierMonotone.%d" % _id,
               _d(_id, "low") <= _d(_id, "mid") + 1e-12 and _d(_id, "mid") <= _d(_id, "high") + 1e-12)
    check_true("analytic.gradeMonotone.%d" % _id, _d(_id, "high", "relic") <= _d(_id, "high") + 1e-12)
_two = B.set_damage([{"cat": "special", "family": 32, "tier": "high"},
                     {"cat": "special", "family": 23, "tier": "high"}], "ancient", P)
check("analytic.additive", r9(_two), r9(_d(32, "high") + _d(23, "high")))
check("analytic.damagePercent", r9(B.damage_percent(_two)), r9((math.exp(_two / 100) - 1) * 100))

# ================= 4b. fixed combat traits =================
for i, c in enumerate(refs["traits"]):
    _p = B.normalize_profile(c["profile"])
    check("traits[%d] %s" % (i, c["label"]), r9(B.trait_damage(c["traits"], _p)), c["damage"])

_dcr = 120 * 25 / 699.0 / 100.0
check("analytic.trait.crit120", r9(B.trait_damage({"crit": 120}, P)),
      r9(_D((1 + (0.9 + _dcr) * 1.8) / (1 + 0.9 * 1.8))))
check("analytic.trait.critPP", r9(120 * B.TRAIT_CRIT_PP_PER_POINT), 4.291845494)
# Spec / Swiftness: flat points per 100 trait points, no log-space curve. The
# shipped weight is crit's own worth per point, so on default settings all three
# combat traits price alike.
check("analytic.trait.spec120", r9(B.trait_damage({"spec": 120}, P)), 2.9094)
check("analytic.trait.swift96", r9(B.trait_damage({"swift": 96}, P)), 2.32752)
# It is ANCHORED AT 110 — subrank.js's own yardstick — and there it tracks crit to
# four decimal places.
check("analytic.trait.anchor110.spec", r9(B.trait_damage({"spec": 110}, P)), 2.66695)
check("analytic.trait.anchor110.crit", r9(B.trait_damage({"crit": 110}, P)), 2.666997141)
check_true("analytic.trait.anchorHolds",
           abs(B.trait_damage({"spec": 110}, P) - B.trait_damage({"crit": 110}, P)) < 0.001)


# Away from the anchor the two drift apart, and that is the design, not a slip:
# crit is faintly non-linear — 0.0244 a point at 61, 0.0242 at 120, because a
# character nearer the cap gains less from each point — so no one constant can
# track it everywhere. At the bottom of the Ancient band the gap is about 0.6%.
def _trait_gap_at(n):
    c = B.trait_damage({"crit": n}, P)
    return abs(c - B.trait_damage({"spec": n}, P)) / c


check_true("analytic.trait.critIsNonLinear",
           B.trait_damage({"crit": 61}, P) / 61 > B.trait_damage({"crit": 120}, P) / 120)
check_true("analytic.trait.driftAt61", 0.005 < _trait_gap_at(61) < 0.007)
check_true("analytic.trait.anchorIsTightest",
           _trait_gap_at(110) < _trait_gap_at(61) and _trait_gap_at(110) < _trait_gap_at(120))
# A user-set weight overrides outright — the slider still means what it says.
check("analytic.trait.numericWeightSpec",
      r9(B.trait_damage({"spec": 100}, B.normalize_profile({"traitWeights": {"spec": 0.025}}))), 2.5)
check("analytic.trait.numericWeightSwift",
      r9(B.trait_damage({"swift": 96}, B.normalize_profile({"traitWeights": {"swift": 0.025}}))), 2.4)
# Zero scores nothing, and so does an explicit null: _alias skips both.
check("analytic.trait.zeroWeight",
      r9(B.trait_damage({"spec": 120}, B.normalize_profile({"traitWeights": {"spec": 0}}))), 0)
check("analytic.trait.nullWeightScoresZero",
      r9(B.trait_damage({"spec": 120}, B.normalize_profile({"traitWeights": {"spec": None}}))), 0)
# An EMPTY override merges nothing and leaves the defaults standing. This is the
# JS/Python seam: {} is truthy in JS and falsy here, so normalize_profile has to
# reach for `is not None` rather than a plain truth test.
check("analytic.trait.emptyOverrideKeepsDefaults",
      r9(B.trait_damage({"spec": 120}, B.normalize_profile({"traitWeights": {}}))), 2.9094)
check("analytic.trait.additive", r9(B.trait_damage({"crit": 120, "spec": 120}, P)),
      r9(B.trait_damage({"crit": 120}, P) + B.trait_damage({"spec": 120}, P)))
# At 100% base crit a crit trait pays its SUBSTITUTION value, not zero — the
# uncap ruling (Shizu, 2026-08-14): overflow crit rate keeps the (cd-1) slope.
check("analytic.trait.critUncappedAtBase100",
      r9(B.trait_damage({"crit": 120},
                        B.normalize_profile({"skills": [{"share": 1, "critRate": 1, "critDamage": 2.8}]}))),
      r9(_D((1 + (1 + 120 * (25 / 699) / 100) * 1.8) / (1 + 1.0 * 1.8))))
check("analytic.trait.none", r9(B.trait_damage({}, P)), 0)
# line_damage() scores a trait line ZERO by design: set_damage() is the EFFECT-line
# scorer, so lines_pct keeps meaning what bible's "Bracelet Effects +X%" means, and
# every trait point on the bracelet — granted slot included — goes through
# trait_damage() instead. See model/bracelet.js's traitDamage() header.
check("analytic.trait.setDamageScoresNoTrait",
      r9(B.line_damage({"cat": "trait", "family": "crit", "value": 120}, "ancient", P)), 0)
check("analytic.trait.setDamageScoresNoTrait.viaSet",
      r9(B.set_damage([{"cat": "trait", "family": "crit", "value": 120},
                       {"cat": "special", "family": 23, "tier": "high"}], "ancient", P)),
      r9(B.line_damage({"cat": "special", "family": 23, "tier": "high"}, "ancient", P)))
check_true("analytic.trait.grantedWorthTheSame", B.trait_damage({"crit": 120}, P) > 0)

_t = refs["traitSolve"]
_plain = B.solve({"grade": _t["grade"], "profile": {}, "slots": _t["slots"], "rollsLeft": _t["rollsLeft"],
                  "fixedLines": [], "grantedLines": _t["granted"],
                  "goldPer1Pct": _t["goldPer1Pct"], "baselinePct": 0})
_with = B.solve({"grade": _t["grade"], "profile": {}, "slots": _t["slots"], "rollsLeft": _t["rollsLeft"],
                 "fixedLines": [], "grantedLines": _t["granted"],
                 "goldPer1Pct": _t["goldPer1Pct"], "baselinePct": 0,
                 "traitValues": _t["traitValues"]})
check("traitSolve.traitDamage", r9(_with["traitDamage"]), _t["traitDamage"])
check("traitSolve.plainCurrent", r9(_plain["currentScore"]), _t["plainCurrent"])
check("traitSolve.plainFinal", r9(_plain["expectedFinal"]), _t["plainFinal"])
check("traitSolve.traitCurrent", r9(_with["currentScore"]), _t["traitCurrent"])
check("traitSolve.traitFinal", r9(_with["expectedFinal"]), _t["traitFinal"])
check("traitSolve.valueGold", r9(_with["valueGold"]), _t["traitValueGold"])
check("traitSolve.states", _with["stats"]["states"], _t["states"], exact=True)
# With NO granted line to pool against, the traits are still exactly their own
# score: this case is unrolled, so the current score is the fixed term alone.
check_true("analytic.traitSolve.currentShift",
           abs((_with["currentScore"] - _plain["currentScore"]) - _with["traitDamage"]) < 1e-9)
# The FINAL score no longer shifts by that same constant, and must not: every
# reachable state carries crit lines, and 120 points of Crit trait is 4.29pp of
# crit rate competing with them for one cap.
_shift = _with["expectedFinal"] - _plain["expectedFinal"]
check_true("analytic.traitSolve.finalShiftIsNotTheConstant", abs(_shift - _with["traitDamage"]) > 1e-6)
check_true("analytic.traitSolve.finalShiftIsSmaller", _shift < _with["traitDamage"])
check_true("analytic.traitSolve.finalShiftIsClose", _shift > _with["traitDamage"] - 1.5)
# NAMING THE TRAITS FILLS THEIR PLACES: traitValues counts against the trait cap,
# so `_with` can no longer draw a third combat trait and `_plain` still can.
check_true("analytic.traitSolve.namedTraitsCapTheCategory",
           _with["stats"]["states"] < _plain["stats"]["states"])
_as_lines = B.solve({"grade": _t["grade"], "profile": {}, "slots": _t["slots"], "rollsLeft": _t["rollsLeft"],
                     "fixedLines": [{"cat": "trait", "family": "crit"}, {"cat": "trait", "family": "spec"}],
                     "grantedLines": _t["granted"], "goldPer1Pct": _t["goldPer1Pct"], "baselinePct": 0})
check("analytic.traitSolve.valuesCapLikeLines", _as_lines["stats"]["states"], _with["stats"]["states"], exact=True)
# See verify.js: worth is E[max(0, final% - baseline%)] x gpd, recomputed from this
# live solve's own distribution rather than restating the formula.
_w_exp = 0.0
for _wr in _with["finalScore"]["cdf"]:
    _w_over = B.damage_percent(_wr["score"]) - _t.get("baselinePct", 0)
    if _w_over > 0:
        _w_exp += _wr["p"] * _w_over
check_true("analytic.traitSolve.valueGold",
           abs(_with["valueGold"] - _w_exp * _t["goldPer1Pct"]) < 1e-6)

# ================= 4e. joint scoring across a set =================
# A bracelet is not the sum of its lines. Crit (capped at 100%), the
# additional-damage pool and the one square root that flat weapon power and flat
# main stat both move are shared by the whole item, so the lines feeding one of
# them pool first and the bucket applies once.
for i, c in enumerate(refs["joint"]):
    _p = B.normalize_profile(c["profile"])
    check("joint[%d].setDamage %s" % (i, c["label"]), r9(B.set_damage(c["lines"], c["grade"], _p)), c["setDamage"])
    check("joint[%d].traitDamage" % i, r9(B.trait_damage(c["traits"], _p)), c["traitDamage"])
    check("joint[%d].jointScore" % i, r9(B.joint_score(c["lines"], c["traits"], c["grade"], _p)), c["jointScore"])

for c in refs["traitAtoms"]:
    for _role in ("dps", "support"):
        _atoms = B.build_atoms(c["grade"], B.normalize_profile({"role": "support"} if _role == "support" else {}), {})
        _got = dict((a["key"], r9(a["damage"])) for a in _atoms if a["cat"] == "trait")
        check("traitAtoms[%s][%s].count" % (c["grade"], _role), len(_got), len(c[_role]), exact=True)
        for _k, _v in c[_role].items():
            check("traitAtoms[%s][%s].%s" % (c["grade"], _role, _k), _got.get(_k), _v)

_f11h = {"cat": "special", "family": 11, "tier": "high"}     # crit +5%, on crit +1.5%
_f31h = {"cat": "special", "family": 31, "tier": "high"}     # crit +5%
_f32h = {"cat": "special", "family": 32, "tier": "high"}     # crit damage +10%
_f24h = {"cat": "special", "family": 24, "tier": "high"}     # additional damage +4%
_f33h = {"cat": "special", "family": 33, "tier": "high"}     # weapon power +9000
_f23h = {"cat": "special", "family": 23, "tier": "high"}     # outgoing damage +3%
_f25h = {"cat": "special", "family": 25, "tier": "high"}     # back attack +3.5%

# Pooled UNCAPPED — the substitution ruling (Shizu, 2026-08-14). Cross-terms
# still price jointly, so the pooled answer sits BELOW the per-line double count
# and ABOVE the hard-cap floor. cr pools to 0.90+0.05+0.05+120·(25/699)/100.
_apart = (B.line_damage(_f11h, "ancient", P) + B.line_damage(_f31h, "ancient", P)
          + B.trait_damage({"crit": 120, "spec": 120}, P))
_together = B.joint_score([_f11h, _f31h], {"crit": 120, "spec": 120}, "ancient", P)
check("analytic.joint.crit.apart", r9(_apart), 14.03181578)
_cr_pool = 0.9 + 0.05 + 0.05 + 120 * (25 / 699) / 100
check("analytic.joint.crit.closedForm", r9(_together),
      r9(_D((1 + _cr_pool * (2.8 * 1.015 - 1)) / (1 + 0.9 * 1.8)) + 120 * 0.024245))
_capped = _D((1 + 1.0 * (2.8 * 1.015 - 1)) / (1 + 0.9 * 1.8)) + 120 * 0.024245
check_true("analytic.joint.crit.betweenCapAndDoubleCount",
           _capped + 1 < _together < _apart)

# Other buckets are untouched: family 17's crit-resist shred is a party
# multiplier, not a crit-rate source.
_sat_base = B.joint_score([_f11h, _f31h], {"crit": 120}, "ancient", P)
_sat_plus = B.joint_score([_f11h, _f31h, {"cat": "special", "family": 17, "tier": "high"}],
                          {"crit": 120}, "ancient", P)
check_true("analytic.joint.saturated.otherBucketsStillPay", _sat_plus > _sat_base + 1)
# The marginal crit line at 98.93% committed — the case the hard cap collapsed
# to 0.69 — now pays the at-cap slope: cr 0.9893 + 0.05 = 1.0393.
_at_cap = B.normalize_profile({"skills": [{"share": 1, "critRate": 0.9893, "critDamage": 2.8}]})
_marginal = B.joint_score([_f31h], {}, "ancient", _at_cap)
check("analytic.joint.marginalCritUncapped", r9(_marginal),
      r9(_D((1 + 1.0393 * 1.8) / (1 + 0.9893 * 1.8))))
check_true("analytic.joint.marginalCritStaysNearStandalone",
           B.line_damage(_f31h, "ancient", P) / _marginal < 1.1)
# Crit DAMAGE has no cap, so two crit lines of different kinds do not fight.
check("analytic.joint.critDamageIsNotCapped", r9(B.set_damage([_f31h, _f32h], "ancient", P)),
      r9(_D((1 + 0.95 * (2.9 - 1)) / (1 + 0.9 * 1.8))))

# Two lines feeding one additional-damage pool dilute each other.
_f14h = {"cat": "special", "family": 14, "tier": "high"}     # additional damage +3.5%
check("analytic.joint.addPool", r9(B.set_damage([_f24h, _f14h], "ancient", P)),
      r9(_D((1.3844 + 0.04 + 0.035) / 1.3844)))
check_true("analytic.joint.addPoolIsLessThanApart",
           B.set_damage([_f24h, _f14h], "ancient", P)
           < B.line_damage(_f24h, "ancient", P) + B.line_damage(_f14h, "ancient", P) - 1e-9)

# Flat weapon power and flat main stat move the SAME attack-power figure.
_ms = {"cat": "basic", "family": "mainStat", "value": 13888}


def _ap2(d_ms, d_wp):
    return math.sqrt((703826 + d_ms) * 1.09 * (241367 + d_wp) * 1.085 / 6) * 1.125 + 3600


check("analytic.joint.oneSquareRoot", r9(B.set_damage([_f33h, _ms], "ancient", P)),
      r9(_D(_ap2(13888, 9000) / _ap2(0, 0))))
# Two sources on the SAME side of the root dilute each other, which is the 0.4.0
# fix to families 21 and 22.
_f21h = {"cat": "special", "family": 21, "tier": "high"}
check_true("analytic.joint.sameSideDilutes",
           B.set_damage([_f33h, _f21h], "ancient", P)
           < B.line_damage(_f33h, "ancient", P) + B.line_damage(_f21h, "ancient", P) - 0.07)
# Main stat and weapon power sit on OPPOSITE sides, where the two ratios would
# multiply cleanly if attack power were a pure square root. The flat attack term
# sits outside it, so pooling is a hair HIGHER, not lower.
check_true("analytic.joint.oppositeSidesBarelyMove",
           B.set_damage([_f33h, _ms], "ancient", P)
           > B.line_damage(_f33h, "ancient", P) + B.line_damage(_ms, "ancient", P))
check_true("analytic.joint.oppositeSidesMoveLittle",
           B.set_damage([_f33h, _ms], "ancient", P)
           - (B.line_damage(_f33h, "ancient", P) + B.line_damage(_ms, "ancient", P)) < 0.001)
_p_no_flat2 = B.normalize_profile({"flatAP": 0})
check("analytic.joint.oppositeSidesExactWithoutFlatAP",
      r9(B.set_damage([_f33h, _ms], "ancient", _p_no_flat2)),
      r9(B.line_damage(_f33h, "ancient", _p_no_flat2) + B.line_damage(_ms, "ancient", _p_no_flat2)))

# What pooling must NOT touch.
check("analytic.joint.orthogonalStillAdds", r9(B.set_damage([_f23h, _f25h], "ancient", P)),
      r9(B.line_damage(_f23h, "ancient", P) + B.line_damage(_f25h, "ancient", P)))
check("analytic.joint.oneLineIsItself", r9(B.set_damage([_f11h], "ancient", P)),
      r9(B.line_damage(_f11h, "ancient", P)))
check("analytic.joint.emptySetIsZero", r9(B.set_damage([], "ancient", P)), 0)
check("analytic.joint.noTraitsIsSetDamage", r9(B.joint_score([_f11h, _f23h], {}, "ancient", P)),
      r9(B.set_damage([_f11h, _f23h], "ancient", P)))
check("analytic.joint.traitLineScoresZero",
      r9(B.set_damage([{"cat": "trait", "family": "crit", "value": 120}, _f23h], "ancient", P)),
      r9(B.line_damage(_f23h, "ancient", P)))
check("analytic.joint.orderFree", r9(B.set_damage([_f11h, _f24h, _f33h], "ancient", P)),
      r9(B.set_damage([_f33h, _f24h, _f11h], "ancient", P)))
_S2 = B.normalize_profile({"role": "support"})
check("analytic.joint.supportPoolsWeaponPower",
      r9(B.set_damage([_f33h, _f21h], "ancient", _S2)),
      r9(_D(B.support_gain(_S2, None, 0, 9000 + 9000 + 2400))))

# THE PYTHON SEAM. line_damage() normalises a partial profile, as the JS has
# always done. This mirror did not: {"master": True} has no "role" key, so every
# call raised KeyError: 'role' the moment it reached component_multiplier. Both
# sides now answer, and answer the same.
check("analytic.joint.partialProfileNormalises",
      r9(B.line_damage(_f31h, "ancient", {"master": True})), r9(B.line_damage(_f31h, "ancient", P)))
check("analytic.joint.emptyProfileNormalises",
      r9(B.line_damage(_f31h, "ancient", {})), r9(B.line_damage(_f31h, "ancient", P)))
check("analytic.joint.partialProfileIsUsed",
      r9(B.line_damage(_f24h, "ancient", {"master": True})),
      r9(B.line_damage(_f24h, "ancient", B.normalize_profile({"master": True}))))
check_true("analytic.joint.partialProfileMasterMoves",
           B.line_damage(_f24h, "ancient", {"master": True}) < B.line_damage(_f24h, "ancient", P))

# ================= 4f. the combat-trait draw =================
# A trait DRAW is priced now; a trait LINE still is not.
_TRAIT_LINES = [{"cat": "trait", "family": "crit"}, {"cat": "trait", "family": "spec"}]
_draw_base = {"grade": "ancient", "profile": {}, "slots": 3, "rollsLeft": 2,
              "grantedLines": [], "goldPer1Pct": 0, "baselinePct": 0}


def _solve_with(o):
    m = dict(_draw_base)
    m.update(o)
    return B.solve(m)


# TWO PLACES FILLED: the trait atoms cannot be drawn, so what they are priced at
# cannot move the answer, however wildly they are repriced.
_two = _solve_with({"fixedLines": _TRAIT_LINES})
_two_reprice = _solve_with({"fixedLines": _TRAIT_LINES,
                            "profile": {"traitWeights": {"spec": 1.5, "swift": 1.5}}})
check_true("analytic.traitDraw.cappedIsInvariant",
           abs(_two["expectedFinal"] - _two_reprice["expectedFinal"]) < 1e-12)
check("analytic.traitDraw.cappedStatesInvariant",
      _two_reprice["stats"]["states"], _two["stats"]["states"], exact=True)
_two_v = _solve_with({"traitValues": {"crit": 110, "spec": 100}})
_two_v_reprice = _solve_with({"traitValues": {"crit": 110, "spec": 100},
                              "profile": {"traitWeights": {"spec": 0.024245, "swift": 1.5}}})
check_true("analytic.traitDraw.cappedByValuesIsInvariant",
           abs(_two_v["expectedFinal"] - _two_v_reprice["expectedFinal"]) < 1e-12)

# ONE PLACE OPEN: the draw is real, so its price reaches the answer.
_one = _solve_with({"traitValues": {"crit": 110}})
_one_reprice = _solve_with({"traitValues": {"crit": 110},
                            "profile": {"traitWeights": {"spec": 1.5, "swift": 1.5}}})
check_true("analytic.traitDraw.openPlacePaysMore", _one_reprice["expectedFinal"] > _one["expectedFinal"] + 1)
_one_dead = _solve_with({"traitValues": {"crit": 110}, "profile": {"traitWeights": {"spec": 0, "swift": 0}}})
check_true("analytic.traitDraw.openPlaceIsWorthSomething", _one["expectedFinal"] > _one_dead["expectedFinal"])

_trait_atoms = [a for a in B.build_atoms("ancient", P, {}) if a["cat"] == "trait"]
check("analytic.traitDraw.pricedFamilies", len([a for a in _trait_atoms if not a["junk"]]), 3, exact=True)
check("analytic.traitDraw.deadFamilies", len([a for a in _trait_atoms if a["junk"]]), 3, exact=True)
check("analytic.traitDraw.lineStillScoresZero",
      r9(B.line_damage({"cat": "trait", "family": "crit", "value": 120}, "ancient", P)), 0)
check("analytic.traitDraw.familyLetterStillF",
      B.family_grades("ancient")["trait"]["crit"]["letter"], "F", exact=True)
# A trait the bracelet already carries is not a draw it can still make, so a
# caller holding the line in grantedLines is not paid for it twice.
_held = B.solve({"grade": "ancient", "profile": {}, "slots": 2, "rollsLeft": 1,
                 "fixedLines": [], "traitValues": {"crit": 110, "spec": 100},
                 "grantedLines": [{"cat": "trait", "family": "crit"}, _f23h],
                 "goldPer1Pct": 0, "baselinePct": 0})
check("analytic.traitDraw.heldTraitIsNotPaidTwice", r9(_held["currentScore"]),
      r9(B.joint_score([_f23h], {"crit": 110, "spec": 100}, "ancient", P)))

# ================= 4d. the support channel =================
# A support scores nothing for its own damage. What it scores is what its buffs
# add to ONE damage dealer: ap . brand . identity, each channel scaled by its own
# uptime. The whole model is re-derived here from docs/research/support-model.md
# so the numbers are checked against the write-up rather than against themselves.
_S = B.normalize_profile({"role": "support"})


def _sup_contribution(lines=None, d_ms=0, d_wp=0):
    """`lines` are the extra buff FRACTIONS a bracelet adds; d_ms / d_wp are flat
    main stat / weapon power it adds to the support itself."""
    lines = lines or {}
    ally_dmg = 38.26 / 100 + (lines.get("allyDmg") or 0)
    ally_dmg_t = 9.26 / 100 + (lines.get("allyDmg") or 0)
    atk_enh = 68.55 / 100 + (lines.get("allyAtkEnh") or 0)
    brand_pow = 45.00 / 100 + (lines.get("brand") or 0)
    spec_eff = (1016 + (lines.get("spec") or 0)) * 0.0005005722461
    # The support's own base attack power: no flat attack term, because the buff
    # reads the base figure and not the total.
    sup_atk = math.sqrt(((703826 + d_ms) * 1.09) * ((241367 + d_wp) * 1.085) / 6) * 1.125
    # The dealer being buffed is OUR OWN default dealer since 0.4.0: weapon power
    # 241,367 x 1.085 and main stat 703,826 x 1.09, the two figures the profile
    # itself carries, instead of the accessory calculator's inherited pair.
    dps_atk = math.sqrt(261883.195 * 767170 / 6)
    mults = 1 + 0.2948
    ap_mult = ((dps_atk + sup_atk * 0.22 * (1 + atk_enh)) * mults + 3600) / (dps_atk * mults + 3600)
    ap = 1 + 0.95 * (ap_mult - 1)
    brand = 1 + 1.00 * (0.1 * (1 + brand_pow))
    # Serenade, Major Chord and the T-skill all raise the dealer's ADDITIONAL
    # damage, so they share one bracket and the dealer's own base dilutes them.
    identity = 1 + (0.70 * (0.15 * (1 + ally_dmg) * (1 + spec_eff)) +
                    0.70 * (0.02 * (1 + ally_dmg) * (1 + spec_eff)) +
                    0.40 * (0.10 * (1 + ally_dmg_t))) / (1 + 0.3844)
    return ap * brand * identity


def _sup_gain(lines=None, d_ms=0, d_wp=0):
    return _sup_contribution(lines, d_ms, d_wp) / _sup_contribution(None, 0, 0)


def _fam_d(fid, tier, prof=None):
    return B.line_damage({"cat": "special", "family": fid, "tier": tier}, "ancient", prof or _S)


# What a naked support is already worth to one dealer. Every other number in this
# block is a ratio against it, so pin it outright — twice: the model's own figure,
# and the re-derivation above landing on the same one.
check("analytic.support.contribution", r9(B.support_contribution(_S, None, 0, 0)), 1.927654588)
check("analytic.support.contributionRederived", r9(_sup_contribution(None, 0, 0)), 1.927654588)
# THE DEALER IS OUR OWN. Two of the four figures describing the damage dealer a
# support is scored against were the accessory calculator's, and named a slightly
# different character than this model's own defaults do: 2.1% karma against our
# 2.5%, and a 35.85% additional-damage pool against our 38.44%. Both are now read
# off the profile, so one reference build stands behind both roles.
check("analytic.support.dealerIsOurWeaponPower", B.DEFAULT_PROFILE["support"]["dpsWP"], 241367 * 1.085)
check("analytic.support.dealerIsOurMainStat", B.DEFAULT_PROFILE["support"]["dpsMS"],
      round(703826 * 1.09), exact=True)
check("analytic.support.dealerCarriesOurAddPool", B.DEFAULT_PROFILE["support"]["baseAdd"], B.add_damage_pool(P))
check("analytic.support.dealerCarriesOurFlatAP", B.DEFAULT_PROFILE["support"]["dpsFlatAtk"], P["flatAP"], exact=True)
check_true("analytic.support.dealerMainStatIsWithinAPoint",
           abs(B.DEFAULT_PROFILE["support"]["dpsMS"] - 703826 * 1.09) < 1)
# A gain is that contribution with the line over the contribution without.
check("analytic.support.gainIsARatio", r9(B.support_gain(_S, {"allyDmg": 0.09}, 0, 0)),
      r9(B.support_contribution(_S, {"allyDmg": 0.09}, 0, 0) / B.support_contribution(_S, None, 0, 0)))
# The base the ally buff is a share of drops the flat ATTACK term, because the
# buff reads the base figure rather than the total. That one subtraction is the
# whole difference from attack_power().
check("analytic.support.baseAtkDropsFlatAP", r9(B.support_base_atk(_S, 0, 0)), r9(B.attack_power(_S, 0, 0) - 3600))

# Families 29 and 30 are the two ally-buff riders, and on a support they are the
# point of the item: 29 scales the attack-power buff, 30 the damage buff.
check("analytic.support.f29.high", r9(_fam_d(29, "high")), r9(_D(_sup_gain({"allyAtkEnh": 0.06}))))
check("analytic.support.f30.high", r9(_fam_d(30, "high")), r9(_D(_sup_gain({"allyDmg": 0.09}))))
check_true("analytic.support.f29.pays", _fam_d(29, "high") > 0)
check_true("analytic.support.f30.pays", _fam_d(30, "high") > 0)
# A legendary ally-DAMAGE line beats a legendary ally-AP line: 9% into the identity
# bracket outruns 6% into a buff that is only a share of the support's own attack
# power.
check_true("analytic.support.f30BeatsF29", _fam_d(30, "high") > _fam_d(29, "high"))

# Personal damage scores nothing on a support — crit, back attack and the
# additional-damage pool all move only the support's own hits, which nobody counts.
# These are the lines a DPS pays most for, so they are the ones a role mix-up would
# show up in first.
check("analytic.support.critRate", r9(_fam_d(31, "high")), 0)
check("analytic.support.critPlusOnCrit", r9(_fam_d(11, "high")), 0)
check("analytic.support.backAttack", r9(_fam_d(25, "high")), 0)
check("analytic.support.addDamage", r9(_fam_d(24, "high")), 0)

# Weapon power and main stat are NOT dead weight on a support: both raise the base
# its ally attack-power buff is a share of. Thin channels, but real ones.
check("analytic.support.weaponPower", r9(_fam_d(33, "high")), r9(_D(_sup_gain(None, 0, 9000))))
check("analytic.support.mainStat",
      r9(B.line_damage({"cat": "basic", "family": "mainStat", "value": 13888}, "ancient", _S)),
      r9(_D(_sup_gain(None, 13888, 0))))
check_true("analytic.support.wpUnderBlueAllyDamage", _fam_d(33, "high") < _fam_d(30, "low"))

# The three channels MULTIPLY, so a line that touches only one of them prices the
# same whatever the other two are doing: the identity bracket cancels top and
# bottom of the ratio. Move the support's spec by 184 points and family 29 must not
# budge — while family 30, which lives in that bracket, must.
_sup_over = dict(B.DEFAULT_PROFILE["support"])
_sup_over["spec"] = 1200
_more_spec = B.normalize_profile({"role": "support", "support": _sup_over})
check("analytic.support.apChannelIgnoresSpec", r9(_fam_d(29, "high", _more_spec)), r9(_fam_d(29, "high")))
check_true("analytic.support.identityChannelFollowsSpec", _fam_d(30, "high", _more_spec) > _fam_d(30, "high"))

# Families 16-19 carry a party DEBUFF that lands on every dealer who has it. A
# support is scored on ONE dealer — the unit its buff channels are already in — so
# the score must not move with allyDpsCount. Price the debuff across the party and
# the same line gets two different party sizes at once, since the ally-buff rider
# beside it is priced across one.
_big_party = B.normalize_profile({"role": "support", "allyDpsCount": 7})
check("analytic.support.partyLineIgnoresPartySize", r9(_fam_d(16, "high", _big_party)), r9(_fam_d(16, "high")))
check_true("analytic.support.partyLinePays", _fam_d(16, "high") > 0)
# A DPS still counts itself plus its allies, so party size moves its score.
check_true("analytic.support.dpsStillCountsAllies",
           B.line_damage({"cat": "special", "family": 16, "tier": "high"}, "ancient",
                         B.normalize_profile({"allyDpsCount": 7}))
           > B.line_damage({"cat": "special", "family": 16, "tier": "high"}, "ancient", P))

# Combat traits on a support are not a matter of taste, so traitWeights do not
# apply. Spec pays through the identity bracket and Swiftness is priced THE SAME
# (Shizu); crit, domination, endurance and expertise pay nothing.
check("analytic.support.traitSpec", r9(B.trait_damage({"spec": 120}, _S)), r9(_D(_sup_gain({"spec": 120}))))
check("analytic.support.traitSwiftEqualsSpec", r9(B.trait_damage({"swift": 120}, _S)),
      r9(B.trait_damage({"spec": 120}, _S)))
check("analytic.support.traitCrit", r9(B.trait_damage({"crit": 120}, _S)), 0)
check("analytic.support.traitIgnoresWeights",
      r9(B.trait_damage({"spec": 120},
                        B.normalize_profile({"role": "support", "traitWeights": {"spec": 0.04}}))),
      r9(B.trait_damage({"spec": 120}, _S)))

# NESTED MERGE. normalize_profile merges addDamage, traitWeights and support key by
# key, so a caller who sets one field of one of them means "this field, everything
# else as it was". For `support` that is not cosmetic: a partial override that
# REPLACED the block would leave support_contribution reading a missing allyDmg and
# every support score would raise KeyError. That was the behaviour until
# 2026-08-14; these checks guard the repair.
_partial = B.normalize_profile({"support": {"spec": 1200}})
check("analytic.support.partialOverrideTakesTheField", _partial["support"]["spec"], 1200, exact=True)
check("analytic.support.partialOverrideKeepsTheRest",
      len(_partial["support"]), len(B.DEFAULT_PROFILE["support"]), exact=True)
check("analytic.support.partialOverrideStaysFinite",
      1 if math.isfinite(B.line_damage({"cat": "special", "family": 30, "tier": "high"}, "ancient",
                                       B.normalize_profile({"role": "support", "support": {"spec": 1200}}))) else 0,
      1, exact=True)

# THE FAMILY LETTER FOLLOWS THE ROLE - see the JS twin. Every other input is kept
# out of the letters so they label the family rather than the build; the role
# decides which families score at all, so it has to reach them.
_gD = B.family_grades("ancient")
_gS = B.family_grades("ancient", "support")
check("analytic.grades.critRateIsSForADealer", _gD["special"][11]["letter"], "S", exact=True)
check("analytic.grades.critRateIsFForASupport", _gS["special"][11]["letter"], "F", exact=True)
check("analytic.grades.critRateScoresNothingForASupport",
      B.line_damage({"cat": "special", "family": 11, "tier": "high"}, "ancient",
                    B.normalize_profile({"role": "support"})), 0, exact=True)
check("analytic.grades.critResistIsSForBoth",
      1 if (_gD["special"][17]["letter"] == "S" and _gS["special"][17]["letter"] == "S") else 0,
      1, exact=True)
check("analytic.grades.omittingRoleMeansDealer",
      1 if B.family_grades("ancient") == B.family_grades("ancient", "dps") else 0, 1, exact=True)

# ================= 4c. family letter grades =================
for c in refs["familyGrades"]:
    fg = B.family_grades(c["grade"])
    flat = {}
    for cat in ("basic", "trait", "special"):
        for k, v in fg[cat].items():
            flat["%s:%s" % (cat, k)] = v
    check("familyGrades[%s].bestAvg" % c["grade"], r9(fg["bestAvg"]), c["bestAvg"])
    check("familyGrades[%s].count" % c["grade"], len(flat), len(c["entries"]), exact=True)
    for k, want in c["entries"].items():
        check("familyGrades[%s].%s.avg" % (c["grade"], k), r9(flat[k]["avg"]), want["avg"])
        check("familyGrades[%s].%s.share" % (c["grade"], k), r9(flat[k]["share"]), want["share"])
        check("familyGrades[%s].%s.letter" % (c["grade"], k), flat[k]["letter"], want["letter"], exact=True)

_fg = B.family_grades("ancient")
check("analytic.familyGrades.avg32", r9(_fg["special"][32]["avg"]),
      r9(0.6 * _d(32, "low") + 0.3 * _d(32, "mid") + 0.1 * _d(32, "high")))
_best = max(range(1, 34), key=lambda i: _fg["special"][i]["avg"])
check("analytic.familyGrades.bestShare", r9(_fg["special"][_best]["share"]), 1)
check("analytic.familyGrades.bestLetter", _fg["special"][_best]["letter"], "S", exact=True)
check("analytic.familyGrades.bestAvg", r9(_fg["bestAvg"]), r9(_fg["special"][_best]["avg"]))
_ORDERED = "FDCBAS"
for _i in range(1, 34):
    if _fg["special"][_i]["avg"] <= 0:
        check_true("analytic.familyGrades.zeroIsF.%d" % _i, _fg["special"][_i]["letter"] == "F")
    check_true("analytic.familyGrades.known.%d" % _i, _fg["special"][_i]["letter"] in _ORDERED)
for _i in range(1, 34):
    for _j in range(1, 34):
        if _fg["special"][_i]["avg"] > _fg["special"][_j]["avg"]:
            check_true("analytic.familyGrades.monotone.%dv%d" % (_i, _j),
                       _ORDERED.index(_fg["special"][_i]["letter"]) >= _ORDERED.index(_fg["special"][_j]["letter"]))
check("analytic.familyGrades.vitality", _fg["basic"]["vitality"]["letter"], "F", exact=True)
check("analytic.familyGrades.trait", _fg["trait"]["crit"]["letter"], "F", exact=True)
check("analytic.familyGrades.stable", B.family_grades("ancient")["special"][32]["letter"],
      _fg["special"][32]["letter"], exact=True)

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


# First principles: grade inference. Mirrors verify.js's block of the same name —
# a type:3/4 line takes its tier from the index and its value from whichever table
# it is handed, so it is no evidence at all. The witnesses that are:
def _TR(v):
    return {"type": 2, "index": 15, "value": v, "fixed": True}


def _MS(v):
    return {"type": 2, "index": 11, "value": v, "fixed": True}


def _SP(n):
    return [{"type": 3, "index": 11000 + 10 * (15 - 10) + 3, "value": 5, "fixed": False}
            for _ in range(n)]


def _gr(stats):
    return B.decode_bible_bracelet(stats)["grade"]


_LC = DATA.LINE_COUNTS
check("analytic.grade.relicMaxLines",
      max(int(k) for k in _LC["fixed"]["relic"]) + max(int(k) for k in _LC["granted"]["relic"]), 4, exact=True)
check("analytic.grade.ancientMaxLines",
      max(int(k) for k in _LC["fixed"]["ancient"]) + max(int(k) for k in _LC["granted"]["ancient"]), 5, exact=True)
check("analytic.grade.fiveLinesIsAncient", _gr([_TR(83), _MS(11000)] + _SP(3)), "ancient", exact=True)
check("analytic.grade.traitAboveRelicCap", _gr([_TR(104), _MS(11000)] + _SP(2)), "ancient", exact=True)
check("analytic.grade.traitBelowAncientFloor", _gr([_TR(45), _MS(7000)] + _SP(2)), "relic", exact=True)
check("analytic.grade.mainStatAboveRelic", _gr([_TR(80), _MS(13760)] + _SP(2)), "ancient", exact=True)
check("analytic.grade.mainStatBelowAncient", _gr([_TR(80), _MS(7000)] + _SP(2)), "relic", exact=True)
check("analytic.grade.noEvidenceIsAncient", _gr([_TR(80), _TR(80)] + _SP(2)), "ancient", exact=True)
check("analytic.grade.gradesStartAtRelic", DATA.GRADES[0], "relic", exact=True)

_forced = B.decode_bible_bracelet([_TR(83), _MS(11000)] + _SP(3), {"grade": "relic"})
check("analytic.grade.forcedImpossibleRefused", _forced["grade"], "ancient", exact=True)
check("analytic.grade.forcedImpossibleSaysSo", _forced.get("gradeOverridden"), "relic", exact=True)
_okForced = B.decode_bible_bracelet([_TR(80), _MS(11000)] + _SP(2), {"grade": "relic"})
check("analytic.grade.forcedPossibleObeyed", _okForced["grade"], "relic", exact=True)
check("analytic.grade.forcedPossibleQuiet", str(_okForced.get("gradeOverridden")), "None", exact=True)
_frag = B.decode_bible_bracelet([{"type": 2, "index": 76, "value": 840}], {"grade": "relic"})
check("analytic.grade.fragmentObeyed", _frag["grade"], "relic", exact=True)

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
        if m.get("mean") is not None:
            check("solves[%d].maskEV[%d].mean" % (i, j), r9(res["maskEV"][j]["mean"]), m["mean"])
            check_true("solves[%d].maskEV[%d].evEqualsMean" % (i, j),
                       abs(res["maskEV"][j]["ev"] - res["maskEV"][j]["mean"]) < 1e-9)
            check("solves[%d].maskEV[%d].cdfLen" % (i, j),
                  len(res["maskEV"][j]["cdf"]), len(m["cdf"]), exact=True)
            for qi, cc in enumerate(m["cdf"]):
                if qi % 20 != 0 and qi != len(m["cdf"]) - 1:
                    continue
                check("solves[%d].maskEV[%d].cdf[%d]" % (i, j, qi),
                      r9(res["maskEV"][j]["cdf"][qi]["cum"]), cc["cum"])
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
# See verify.js: at baseline 0 the worth is never negative, and by Jensen it is at
# least damage_percent(expectedFinal) x gpd, since the log->percent map is convex.
check_true("analytic.valueGoldNeverNegative", _three_slot["valueGold"] >= 0)
check_true("analytic.valueGoldJensen",
           _three_slot["valueGold"] >= B.damage_percent(_three_slot["expectedFinal"]) * 30000 - 1e-6)

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
