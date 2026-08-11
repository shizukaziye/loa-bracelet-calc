"""bracelet.py - Python mirror of model/bracelet.js.

Same scoring, same pool builder, same exact reroll DP, same decoder. Kept in
lockstep by the captured-reference battery: refs.json is generated from the JS
core and verify.py recomputes every entry with this module (abs tolerance 1e-9
for floats, exact for structure). Read bracelet.js for the full commentary; the
comments here only cover what differs.

Stdlib only, Python 3.6+.
"""

import bisect
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data"))

import bracelet_data as DATA      # noqa: E402
import gear_data as GEAR          # noqa: E402

VERSION = "0.1.0"
MODEL_SIG = "bracelet-v1"

ADD_DMG_ASTROGEM_LV60 = 0.0484
# T4 combat-trait conversion for Crit: 25 pp of crit rate per 699 trait points
# (Shizu, 2026-08-11). Matches Arsonistic's sheet (0.25/699). Earlier drafts used 35/699 in error; corrected 0.25/699.
TRAIT_CRIT_PP_PER_POINT = 25 / 699.0
# Fixed order, so JS and Python sum the same floats in the same sequence.
TRAIT_KEYS = ["crit", "spec", "swift"]
# Shizu's ruling: Master is +7% additional damage only.
MASTER_ADD_DAMAGE = 0.07

DEFAULT_PROFILE = {
    "role": "dps",

    "ilvl": 1785,
    "mainStatRaw": 703826,
    "weaponPowerRaw": 241367,
    "msPct": 0.09,
    "wpPct": 0.085,
    "baseApPct": 0.125,
    "flatAP": 2700,

    "skills": [{"share": 1, "critRate": 0.90, "critDamage": 2.8}],
    "master": False,

    # Points of damage per 100 trait points, for Spec and Swiftness. Crit has
    # no weight: it converts exactly (see trait_damage).
    "traitWeights": {"spec": 0.025, "swift": 0.025},

    "addDamage": {
        "weaponQuality": 0.30,
        "pet": 0.01,
        "astrogemLv60": ADD_DMG_ASTROGEM_LV60,
        "neck": 0.026,
    },

    # All three ship at 100% (Shizu, 2026-08-11): they gate a bucket, they do
    # not partition your damage.
    "backAttackShare": 1.00,
    "frontAttackShare": 1.00,
    "nonDirectionalShare": 1.00,
    "staggeredShare": 0.10,
    # A boolean gate, not a share: the toggle drives exactly 0 or 1.
    "demonShare": 0.00,
    "demonBase": 0.073,
    "shieldUptime": 0.60,

    "allyDpsCount": 2,
    "allyCritRate": 0.90,
    "allyCritDamage": 2.8,
    "enemyBaseDR": 0.50,

    # Hard assumptions (2026-08-11): max stacks, full uptime. Not inputs.
    "wpStacks20": 6,
    "wpUptime21": 1.00,
    "wpStacks22": 30,

    "cooldownPenaltyWeight": 0.7,
    "atkMoveSpeedDamagePerPct": 0,

    "allyApBuffDamagePerPct": 0.45,
    "allyDamageBuffDamagePerPct": 0.30,
    "partyShieldHealValuePerPct": 0.10,
}

# The additional-damage pool must be summed in the same order as the JS object
# literal, or the two sides can differ in the last float bit.
ADD_DAMAGE_ORDER = ["weaponQuality", "pet", "astrogemLv60", "neck"]


def _deep_copy(o):
    if isinstance(o, dict):
        return dict((k, _deep_copy(v)) for k, v in o.items())
    if isinstance(o, list):
        return [_deep_copy(v) for v in o]
    return o


def normalize_profile(p):
    out = _deep_copy(DEFAULT_PROFILE)
    if not p:
        return out
    for k, v in p.items():
        if k in ("addDamage", "traitWeights") and v:
            for a, av in v.items():
                out[k][a] = av
        elif v is not None:
            out[k] = _deep_copy(v)
    if not out.get("skills"):
        out["skills"] = _deep_copy(DEFAULT_PROFILE["skills"])
    return out


def derive_baseline(o=None):
    o = o or {}
    D = GEAR.DEFAULTS
    lv = dict(D["pieceLevels"])
    if o.get("pieceLevels"):
        lv.update(o["pieceLevels"])

    armor = 0
    ilvl_sum = 0
    for piece in ("head", "shoulder", "chest", "pants", "gloves"):
        armor += GEAR.SERCA[lv[piece]][GEAR.PIECES.index(piece)]
        ilvl_sum += GEAR.ILVL0 + GEAR.ILVL_STEP * lv[piece]
    weapon_power_raw = GEAR.SERCA[lv["weapon"]][5]
    ilvl_sum += GEAR.ILVL0 + GEAR.ILVL_STEP * lv["weapon"]

    acc_ms = o.get("accessoryMainStat", D["accessoryMainStat"])
    base_ms = o.get("baseMainStat", D["baseMainStat"])
    roster = o.get("rosterBonus", D["rosterBonus"])
    ms_pct = o.get("msPct", D["msPct"])
    wp_pct = o.get("wpPct", D["wpPct"])

    main_stat_raw = armor + acc_ms + base_ms + roster
    return {
        "ilvl": int(round(ilvl_sum / 6.0)),
        "armorMainStat": armor,
        "mainStatRaw": main_stat_raw,
        "weaponPowerRaw": weapon_power_raw,
        "mainStatTotal": main_stat_raw * (1 + ms_pct),
        "weaponPowerTotal": weapon_power_raw * (1 + wp_pct),
        "msPct": ms_pct, "wpPct": wp_pct,
        "baseApPct": o.get("baseApPct", D["baseApPct"]),
        "flatAP": o.get("flatAP", D["flatAP"]),
    }


def attack_power(profile, d_ms_raw=0, d_wp_raw=0):
    ms = (profile["mainStatRaw"] + d_ms_raw) * (1 + profile["msPct"])
    wp = (profile["weaponPowerRaw"] + d_wp_raw) * (1 + profile["wpPct"])
    return math.sqrt(ms * wp / 6.0) * (1 + profile["baseApPct"]) + profile["flatAP"]


def add_damage_pool(profile):
    d = profile["addDamage"]
    s = 0.0
    for k in ADD_DAMAGE_ORDER:
        s += d.get(k, 0) or 0
    for k in d:
        if k not in ADD_DAMAGE_ORDER:
            s += d[k] or 0
    if profile.get("master"):
        s += MASTER_ADD_DAMAGE
    return s


def _crit_factor_of(skills, d_crit_rate, d_crit_damage):
    tot = 0.0
    wsum = 0.0
    for sk in skills:
        cr = (sk.get("critRate") or 0) + (d_crit_rate or 0)
        cr = 1 if cr > 1 else (0 if cr < 0 else cr)
        cd = (sk.get("critDamage") or 0) + (d_crit_damage or 0)
        tot += (sk.get("share") or 0) * (1 + cr * (cd - 1))
        wsum += (sk.get("share") or 0)
    return tot / wsum if wsum > 0 else 0


def crit_factor(profile, d_crit_rate=0, d_crit_damage=0):
    return _crit_factor_of(profile["skills"], d_crit_rate, d_crit_damage)


def ally_crit_factor(profile, d_crit_rate=0, d_crit_damage=0):
    return _crit_factor_of(
        [{"share": 1, "critRate": profile["allyCritRate"], "critDamage": profile["allyCritDamage"]}],
        d_crit_rate, d_crit_damage)


def crit_factor_full(profile, dcr, dcd, chd):
    tot = 0.0
    wsum = 0.0
    for sk in profile["skills"]:
        cr = min(1, max(0, (sk.get("critRate") or 0) + dcr))
        cd = (sk.get("critDamage") or 0) + dcd
        tot += (sk.get("share") or 0) * (1 + cr * (cd * (1 + chd) - 1))
        wsum += (sk.get("share") or 0)
    return tot / wsum if wsum > 0 else 0


def def_shred_gain(profile, a_pct):
    dr = profile["enemyBaseDR"]
    if dr <= 0:
        return 1
    if dr >= 1:
        dr = 0.999999
    ratio = dr / (1 - dr)
    a = a_pct / 100.0
    return (ratio + 1) / (ratio * (1 - a) + 1)


def party_mult(profile, self_gain, ally_gain):
    n = profile["allyDpsCount"]
    if profile["role"] == "support":
        return 1 + n * ally_gain
    return 1 + self_gain + n * ally_gain


def component_multiplier(kind, x, profile, comp=None):
    dps = profile["role"] != "support"

    if kind == "none":
        return 1
    if kind == "weaponPower":
        return attack_power(profile, 0, x) / attack_power(profile, 0, 0) if dps else 1
    if kind == "mainStat":
        return attack_power(profile, x, 0) / attack_power(profile, 0, 0) if dps else 1
    if kind == "critRate":
        return crit_factor(profile, x / 100.0, 0) / crit_factor(profile, 0, 0) if dps else 1
    if kind == "critDamage":
        return crit_factor(profile, 0, x / 100.0) / crit_factor(profile, 0, 0) if dps else 1
    if kind == "onCritDamage":
        if not dps:
            return 1
        tot = 0.0
        wsum = 0.0
        for sk in profile["skills"]:
            cr = min(1, sk.get("critRate") or 0)
            cd = sk.get("critDamage") or 0
            b = 1 + cr * (cd - 1)
            n = 1 + cr * (cd * (1 + x / 100.0) - 1)
            tot += (sk.get("share") or 0) * (n / b)
            wsum += (sk.get("share") or 0)
        return tot / wsum if wsum > 0 else 1
    if kind == "addDamage":
        if not dps:
            return 1
        pool = add_damage_pool(profile)
        return (1 + pool + x / 100.0) / (1 + pool)
    if kind == "outgoing":
        return (1 + x / 100.0) if dps else 1
    if kind == "staggered":
        return (1 + profile["staggeredShare"] * x / 100.0) if dps else 1
    if kind == "demon":
        return (1 + profile["demonShare"] * (x / 100.0) / (1 + profile["demonBase"])) if dps else 1
    if kind == "backAttack":
        return (1 + profile["backAttackShare"] * x / 100.0) if dps else 1
    if kind == "frontAttack":
        return (1 + profile["frontAttackShare"] * x / 100.0) if dps else 1
    if kind == "nonDirectional":
        return (1 + profile["nonDirectionalShare"] * x / 100.0) if dps else 1
    if kind == "outgoingCdPenalty":
        if not dps:
            return 1
        cd_pct = (comp or {}).get("cdPct", 0)
        burst = 1 + x / 100.0
        sustained = burst / (1 + cd_pct / 100.0)
        w = profile["cooldownPenaltyWeight"]
        return w * burst + (1 - w) * sustained
    if kind == "atkMoveSpeed":
        return (1 + x * profile["atkMoveSpeedDamagePerPct"] / 100.0) if dps else 1

    if kind == "defShred":
        g = def_shred_gain(profile, x) - 1
        return party_mult(profile, g, g)
    if kind == "critResistShred":
        self_g = (crit_factor(profile, x / 100.0, 0) / crit_factor(profile, 0, 0) - 1) if dps else 0
        ally_g = ally_crit_factor(profile, x / 100.0, 0) / ally_crit_factor(profile, 0, 0) - 1
        return party_mult(profile, self_g, ally_g)
    if kind == "critDmgResistShred":
        self_g = (crit_factor(profile, 0, x / 100.0) / crit_factor(profile, 0, 0) - 1) if dps else 0
        ally_g = ally_crit_factor(profile, 0, x / 100.0) / ally_crit_factor(profile, 0, 0) - 1
        return party_mult(profile, self_g, ally_g)
    if kind == "shieldedDamage":
        g = profile["shieldUptime"] * x / 100.0
        return party_mult(profile, g, g)

    if kind == "allyApBuff":
        return 1 if dps else 1 + x * profile["allyApBuffDamagePerPct"] / 100.0
    if kind == "allyDamageBuff":
        return 1 if dps else 1 + x * profile["allyDamageBuffDamagePerPct"] / 100.0
    if kind == "partyShieldHeal":
        return 1 if dps else 1 + x * profile["partyShieldHealValuePerPct"] / 100.0
    return 1


def to_d(mult):
    return 100 * math.log(mult)


def damage_percent(d):
    return (math.exp(d / 100.0) - 1) * 100


def _band_mid(rng):
    return (rng[0] + rng[1]) / 2.0


def basic_band_expected(fam_key, grade):
    s = 0.0
    w = 0.0
    for band in DATA.BASIC["bands"]:
        s += band["prob"] * _band_mid(band[grade][fam_key])
        w += band["prob"]
    return s / w


def trait_band_expected(grade):
    s = 0.0
    w = 0.0
    for band in DATA.TRAITS["bands"]:
        s += band["prob"] * _band_mid(band[grade])
        w += band["prob"]
    return s / w


def resolve_special(f):
    if f is None:
        return None
    if isinstance(f, dict):
        return f
    return DATA.SPECIAL_BY_ID.get(f) or DATA.SPECIAL_BY_KEY.get(f)


def special_multiplier(family, tier, grade, profile):
    vals = family["values"][grade][tier]
    m = 1.0
    dcr = 0.0
    dcd = 0.0
    chd = 0.0
    any_crit = False
    for c in family["comp"]:
        x = c["v"] if "v" in c else vals[c["from"]]
        if c.get("scaleKey"):
            x = x * profile[c["scaleKey"]]
        if profile["role"] != "support" and c["k"] in ("critRate", "critDamage", "onCritDamage"):
            any_crit = True
            if c["k"] == "critRate":
                dcr += x / 100.0
            elif c["k"] == "critDamage":
                dcd += x / 100.0
            else:
                chd += x / 100.0
            continue
        m *= component_multiplier(c["k"], x, profile, c)
    if any_crit:
        m *= crit_factor_full(profile, dcr, dcd, chd) / crit_factor_full(profile, 0, 0, 0)
    return m


def line_damage(line, grade, profile):
    if line["cat"] == "trait":
        return 0.0
    if line["cat"] == "basic":
        if line["family"] != "mainStat":
            return 0.0
        v = line.get("value")
        if v is None:
            v = basic_band_expected("mainStat", grade)
        return to_d(component_multiplier("mainStat", v, profile))
    fam = resolve_special(line["family"])
    if not fam:
        return 0.0
    # A tier the family's table for THIS grade does not carry. Reachable from a
    # decode that landed on the wrong grade — Crit Damage +10% exists on Ancient
    # and not on Relic, so the Relic table has no tier for it. Score it zero and
    # let the caller's unmatchedValue flag do the complaining; a raised error
    # here takes a whole import down over one line.
    if line["tier"] not in fam["values"].get(grade, {}):
        return 0.0
    return to_d(special_multiplier(fam, line["tier"], grade, profile))


def line_info(line, grade, profile):
    profile = normalize_profile(profile)
    out = {"cat": line["cat"], "family": line["family"], "tier": line.get("tier"),
           "damage": 0.0, "value": None, "label": ""}
    if line["cat"] == "trait":
        out["value"] = line.get("value") if line.get("value") is not None else trait_band_expected(grade)
        out["label"] = "Combat trait"
        out["traitValue"] = out["value"]
        return out
    if line["cat"] == "basic":
        out["value"] = line.get("value") if line.get("value") is not None else basic_band_expected(line["family"], grade)
        out["label"] = "Str / Dex / Int" if line["family"] == "mainStat" else "Vitality"
        out["damage"] = line_damage(line, grade, profile)
        return out
    fam = resolve_special(line["family"])
    if fam:
        out["family"] = fam["id"]
        out["label"] = fam["label"]
        out["value"] = fam["values"][grade][line["tier"]]
        out["damage"] = line_damage(line, grade, profile)
    return out


def trait_damage(traits, profile):
    """Score of the bracelet's two FIXED combat-trait lines.

    traits = {"crit", "spec", "swift"} in trait points; inactive trait = 0.
    Crit converts exactly (25 pp of crit rate per 699 points) and runs through
    the per-skill crit model, additive with every other crit source and capped
    at 100%. Spec and Swiftness use the class's own weight.

    Fixed lines never reroll, so this is a constant on every reachable state:
    it rides inside solve()'s fixed_damage and never enters the DP alphabet.
    """
    profile = profile if (profile and profile.get("role")) else normalize_profile(profile)
    traits = traits or {}
    w = profile.get("traitWeights") or {}
    s = 0.0
    for k in TRAIT_KEYS:
        v = traits.get(k) or 0
        if not v:
            continue
        if k == "crit":
            if profile.get("role") == "support":
                continue
            dcr = v * TRAIT_CRIT_PP_PER_POINT / 100.0
            s += to_d(crit_factor(profile, dcr, 0) / crit_factor(profile, 0, 0))
        else:
            s += v * (w.get(k) or 0)
    return s


# Within one family the three tiers land 6 : 3 : 1.
TIER_ODDS = {"low": 0.6, "mid": 0.3, "high": 0.1}
# Share of the best family's average roll -> letter. Monotone, round numbers.
FAMILY_GRADE_BANDS = [(0.90, "S"), (0.70, "A"), (0.50, "B"), (0.30, "C"), (0.10, "D"), (-1, "F")]


def _band_letter(share):
    for lo, letter in FAMILY_GRADE_BANDS:
        if share >= lo:
            return letter
    return "F"


def family_grades(grade="ancient"):
    """An F-to-S letter for every family a granted slot can hold.

    Rated on the family's AVERAGE roll (tiers weighted 6:3:1) against the best
    family's, and always computed from the CANONICAL DEFAULT profile so the
    labels do not shuffle when the user moves a slider.
    """
    P = normalize_profile({})
    out = {"grade": grade, "bestAvg": 0.0, "basic": {}, "trait": {}, "special": {}}
    tiers = ["low", "mid", "high"]

    for fam in ("mainStat", "vitality"):
        avg = line_damage({"cat": "basic", "family": fam}, grade, P)
        out["basic"][fam] = {"avg": avg}
        if avg > out["bestAvg"]:
            out["bestAvg"] = avg
    for t in DATA.TRAITS["families"]:
        # A trait in a GRANTED slot scores nothing; only the two fixed ones count.
        out["trait"][t["key"]] = {"avg": 0.0}
    for fam in DATA.SPECIALS:
        avg = 0.0
        for tier in tiers:
            avg += TIER_ODDS[tier] * line_damage({"cat": "special", "family": fam["id"], "tier": tier}, grade, P)
        out["special"][fam["id"]] = {"avg": avg}
        if avg > out["bestAvg"]:
            out["bestAvg"] = avg

    for cat in ("basic", "trait", "special"):
        for e in out[cat].values():
            e["share"] = (e["avg"] / out["bestAvg"]) if out["bestAvg"] > 0 else 0.0
            e["letter"] = _band_letter(e["share"]) if e["avg"] > 0 else "F"
    return out


def set_damage(lines, grade, profile):
    profile = normalize_profile(profile)
    return sum(line_damage(ln, grade, profile) for ln in lines)


# ----------------------------------------------------------------------
# Draw atoms and the pool
# ----------------------------------------------------------------------

def build_atoms(grade, profile, options=None):
    options = options or {}
    basic_mode = options.get("basicMode", "bands")
    atoms = []
    cat_w = DATA.CATEGORY_WEIGHTS

    def push(a):
        a["idx"] = len(atoms)
        atoms.append(a)

    basic_fam_w = cat_w["basic"] * 0.5
    if basic_mode == "expected":
        ev = basic_band_expected("mainStat", grade)
        push({"key": "basic:mainStat", "cat": "basic", "family": "basic:mainStat", "tier": None,
              "band": None, "weight": basic_fam_w, "value": ev, "label": "Str / Dex / Int",
              "damage": to_d(component_multiplier("mainStat", ev, profile))})
    else:
        for b, bd in enumerate(DATA.BASIC["bands"]):
            mv = _band_mid(bd[grade]["mainStat"])
            push({"key": "basic:mainStat:b%d" % b, "cat": "basic", "family": "basic:mainStat",
                  "tier": None, "band": b, "weight": basic_fam_w * bd["prob"] / 100.0, "value": mv,
                  "label": "Str / Dex / Int %d-%d" % (bd[grade]["mainStat"][0], bd[grade]["mainStat"][1]),
                  "damage": to_d(component_multiplier("mainStat", mv, profile))})
    push({"key": "basic:vitality", "cat": "basic", "family": "basic:vitality", "tier": None,
          "band": None, "weight": basic_fam_w, "value": basic_band_expected("vitality", grade),
          "label": "Vitality", "damage": 0.0})

    trait_ev = trait_band_expected(grade)
    for tf in DATA.TRAITS["families"]:
        push({"key": "trait:" + tf["key"], "cat": "trait", "family": "trait:" + tf["key"],
              "tier": None, "band": None, "weight": cat_w["trait"] / float(len(DATA.TRAITS["families"])),
              "value": trait_ev, "label": tf["label"], "damage": 0.0})

    total = DATA.GRANTED_LISTED_SUM
    for fam in DATA.SPECIALS:
        dmg = []
        fam_w = 0.0
        any_dmg = False
        for tier in DATA.TIERS:
            d = to_d(special_multiplier(fam, tier, grade, profile))
            if abs(d) > 1e-12:
                any_dmg = True
            dmg.append(d)
            fam_w += cat_w["special"] * fam["granted"][tier] / total
        if not any_dmg:
            push({"key": "special:%d" % fam["id"], "cat": "special", "family": "special:%d" % fam["id"],
                  "tier": None, "band": None, "weight": fam_w, "value": None,
                  "label": fam["label"], "damage": 0.0})
        else:
            for ti, tr in enumerate(DATA.TIERS):
                push({"key": "special:%d:%s" % (fam["id"], tr), "cat": "special",
                      "family": "special:%d" % fam["id"], "tier": tr, "band": None,
                      "weight": cat_w["special"] * fam["granted"][tr] / total,
                      "value": fam["values"][grade][tr],
                      "label": "%s (%s)" % (fam["label"], tr), "damage": dmg[ti]})

    for a in atoms:
        a["junk"] = abs(a["damage"]) <= 1e-12
        a["stateKey"] = ("junk:" + a["cat"]) if a["junk"] else a["key"]
    return atoms


def line_family_id(line):
    if line["cat"] == "basic":
        return "basic:" + line["family"]
    if line["cat"] == "trait":
        return "trait:" + line["family"]
    fam = resolve_special(line["family"])
    return "special:%s" % (fam["id"] if fam else line["family"])


def count_cats(lines):
    c = {"basic": 0, "trait": 0, "special": 0}
    for ln in lines:
        if ln["cat"] in c:
            c[ln["cat"]] += 1
    return c


def build_pool(opts):
    profile = normalize_profile(opts.get("profile"))
    grade = opts.get("grade", "ancient")
    lines = opts.get("lines") or []
    atoms = opts.get("atoms") or build_atoms(grade, profile, opts.get("options"))

    present = {}
    for ln in lines:
        present[line_family_id(ln)] = True
    counts = count_cats(lines)

    survivors = []
    mass = 0.0
    excluded = 0.0
    for a in atoms:
        if present.get(a["family"]) or counts[a["cat"]] >= DATA.CAPS[a["cat"]]:
            excluded += a["weight"]
            continue
        survivors.append(a)
        mass += a["weight"]
    entries = []
    for a in survivors:
        entries.append({
            "key": a["key"], "cat": a["cat"], "family": a["family"], "tier": a["tier"],
            "band": a["band"], "label": a["label"], "damage": a["damage"],
            "listed": a["weight"], "p": (a["weight"] / mass) if mass > 0 else 0,
        })
    by_cat = {"basic": 0.0, "trait": 0.0, "special": 0.0}
    for e in entries:
        by_cat[e["cat"]] += e["p"]
    return {"entries": entries, "survivingMass": mass, "excludedMass": excluded,
            "byCategory": by_cat, "atoms": atoms}


# ----------------------------------------------------------------------
# Solver
# ----------------------------------------------------------------------

def _make_state_atoms(atoms):
    mapping = {}
    lst = []
    for a in atoms:
        k = a["stateKey"]
        if k not in mapping:
            mapping[k] = len(lst)
            lst.append({"key": k, "cat": a["cat"], "damage": a["damage"], "junk": a["junk"],
                        "label": ("(no-damage %s line)" % a["cat"]) if a["junk"] else a["label"],
                        "family": None if a["junk"] else a["family"],
                        "tier": a["tier"], "band": a["band"]})
        a["stateIdx"] = mapping[k]
    return lst


class _Codec(object):
    def __init__(self, n_state_atoms, slots):
        self.base = n_state_atoms + 1
        self.slots = slots

    def encode(self, sorted_idx):
        v = 0
        for i in range(self.slots):
            v = v * self.base + (sorted_idx[i] + 1 if i < len(sorted_idx) else 0)
        return v

    def decode(self, code):
        out = []
        for _ in range(self.slots):
            out.insert(0, code % self.base)
            code //= self.base
        return [x - 1 for x in out if x > 0]


def _enumerate_completions(atoms, present_families, counts, k, base_pieces, codec, caps):
    acc = {}
    pieces = list(base_pieces)
    present = dict((f, True) for f, v in present_families.items() if v)
    cnt = dict(counts)

    def rec(depth, prob):
        if depth == k:
            code = codec.encode(sorted(pieces))
            acc[code] = acc.get(code, 0.0) + prob
            return
        mass = 0.0
        for a in atoms:
            if present.get(a["family"]) or cnt[a["cat"]] >= caps[a["cat"]]:
                continue
            mass += a["weight"]
        if mass <= 0:
            return
        for a in atoms:
            if present.get(a["family"]) or cnt[a["cat"]] >= caps[a["cat"]]:
                continue
            present[a["family"]] = True
            cnt[a["cat"]] += 1
            pieces.append(a["stateIdx"])
            rec(depth + 1, prob * a["weight"] / mass)
            pieces.pop()
            present[a["family"]] = False
            cnt[a["cat"]] -= 1

    rec(0, 1.0)
    codes = list(acc.keys())
    return {"codes": codes, "probs": [acc[c] for c in codes]}


def _build_f(completion, V):
    pairs = sorted(zip((V[c] for c in completion["codes"]), completion["probs"], completion["codes"]),
                   key=lambda t: t[0])
    vals = [p[0] for p in pairs]
    probs = [p[1] for p in pairs]
    ids = [p[2] for p in pairs]
    n = len(vals)
    cum_p = [0.0] * (n + 1)
    cum_pv = [0.0] * (n + 1)
    for i in range(n):
        cum_p[i + 1] = cum_p[i] + probs[i]
        cum_pv[i + 1] = cum_pv[i] + probs[i] * vals[i]
    return {"vals": vals, "probs": probs, "ids": ids, "cumP": cum_p, "cumPV": cum_pv,
            "totalPV": cum_pv[n], "n": n}


def _query_f(F, v):
    i = bisect.bisect_right(F["vals"], v)
    return v * F["cumP"][i] + (F["totalPV"] - F["cumPV"][i])


def _match_atom(atoms, line, grade):
    # A line may name an atom outright (the test pools do); otherwise it is
    # matched by family, then by tier or value band.
    if line.get("key"):
        for a in atoms:
            if a["key"] == line["key"]:
                return a
    fam_id = line_family_id(line)
    best = None
    for a in atoms:
        if a["family"] != fam_id:
            continue
        if line["cat"] == "special":
            if a["tier"] is None or a["tier"] == line.get("tier"):
                best = a
                if a["tier"] == line.get("tier"):
                    return a
        elif line["cat"] == "basic" and a["band"] is not None and line.get("value") is not None:
            bd = DATA.BASIC["bands"][a["band"]][grade][line["family"]]
            if bd[0] <= line["value"] <= bd[1]:
                return a
            if best is None:
                best = a
        else:
            if best is None:
                best = a
    return best


def _normalize_test_pool(pool):
    atoms = []
    for i, p in enumerate(pool):
        atoms.append({"idx": i, "key": p["key"], "cat": p.get("cat", "special"),
                      "family": p.get("family", "test:" + p["key"]), "tier": p.get("tier"),
                      "band": None, "weight": p["weight"], "value": p.get("value"),
                      "label": p.get("label", p["key"]), "damage": p.get("damage", 0.0)})
    for a in atoms:
        a["junk"] = abs(a["damage"]) <= 1e-12
        a["stateKey"] = ("junk:" + a["cat"]) if a["junk"] else a["key"]
    return atoms


def solve(opts):
    profile = normalize_profile(opts.get("profile"))
    grade = opts.get("grade", "ancient")
    options = opts.get("options") or {}
    caps = DATA.CAPS

    atoms = _normalize_test_pool(options["testPool"]) if options.get("testPool") \
        else build_atoms(grade, profile, options)
    state_atoms = _make_state_atoms(atoms)

    fixed_lines = opts.get("fixedLines") or []
    granted_lines = opts.get("grantedLines") or []
    slots = opts.get("slots") or len(granted_lines) or 2
    codec = _Codec(len(state_atoms), slots)

    fixed_present = {}
    for ln in fixed_lines:
        fixed_present[line_family_id(ln)] = True
    fixed_counts = count_cats(fixed_lines)
    # The two fixed combat traits are a constant on every reachable state.
    trait_bonus = trait_damage(opts.get("traitValues"), profile)
    fixed_damage = set_damage(fixed_lines, grade, profile) + trait_bonus

    start_pieces = []
    for ln in granted_lines:
        a = _match_atom(atoms, ln, grade)
        if a:
            start_pieces.append(a["stateIdx"])
    start_code = codec.encode(sorted(start_pieces))

    all_t = _enumerate_completions(atoms, fixed_present, fixed_counts, slots, [], codec, caps)
    codes = list(all_t["codes"])
    if start_code not in set(codes):
        codes.append(start_code)

    max_states = options.get("maxStates", 400000)
    if len(codes) > max_states:
        raise ValueError("bracelet.solve: %d states exceeds maxStates %d" % (len(codes), max_states))

    pieces = {}
    score = {}
    masks_of = {}
    allow_lock_junk = bool(options.get("allowLockJunk"))
    completions = {}

    for code in codes:
        pc = codec.decode(code)
        pieces[code] = pc
        sc = fixed_damage
        for idx in pc:
            sc += state_atoms[idx]["damage"]
        score[code] = sc

        lockable = [j for j in range(len(pc)) if allow_lock_junk or not state_atoms[pc[j]]["junk"]]
        masks = []
        for m in range(1 << len(lockable)):
            sel = [lockable[b] for b in range(len(lockable)) if m & (1 << b)]
            if len(sel) >= len(pc) and len(pc) == slots:
                continue
            idxs = sorted(pc[s] for s in sel)
            lk = ",".join(str(x) for x in idxs)
            masks.append({"slots": sel, "atomIdx": idxs, "key": lk})
            if lk not in completions:
                pres = dict((f, True) for f, v in fixed_present.items() if v)
                cnt = dict(fixed_counts)
                base_pieces = []
                for q in idxs:
                    st = state_atoms[q]
                    if st["family"]:
                        pres[st["family"]] = True
                    cnt[st["cat"]] += 1
                    base_pieces.append(q)
                completions[lk] = _enumerate_completions(
                    atoms, pres, cnt, slots - len(idxs), base_pieces, codec, caps)
        masks_of[code] = masks

    if opts.get("rollsLeft") is not None:
        R = opts["rollsLeft"]
    else:
        rolls = opts.get("rolls") or {}
        R = rolls.get("normal", 4) + rolls.get("ticket", 3)
    gold_per_1pct = opts.get("goldPer1Pct", 0)
    baseline_pct = opts.get("baselinePct", 0)

    layers = [dict((c, score[c]) for c in codes)]
    policies = [None]

    for _r in range(1, R + 1):
        prev = layers[_r - 1]
        Fs = dict((lk, _build_f(completions[lk], prev)) for lk in completions)
        Vr = {}
        Pr = {}
        for c in codes:
            best = None
            best_key = None
            vs = prev[c]
            for mk in masks_of[c]:
                ev = _query_f(Fs[mk["key"]], vs)
                if best is None or ev > best + 1e-12:
                    best = ev
                    best_key = mk["key"]
            if best_key is None:
                best = vs
            Vr[c] = best
            Pr[c] = best_key
        layers.append(Vr)
        policies.append(Pr)

    unrolled = len(start_pieces) < slots
    mask_ev = []
    ev_by_rolls_left = []
    seed_mu = None

    if unrolled:
        all0 = completions.get("", all_t)
        seed_mu = dict(zip(all0["codes"], all0["probs"]))
        for r in range(R + 1):
            ev_by_rolls_left.append(sum(p * layers[r][c] for c, p in zip(all0["codes"], all0["probs"])))
        expected_final = ev_by_rolls_left[R]
        cur = fixed_damage
    elif R == 0:
        # No attempts left. Nothing to lock, nothing to roll: the bracelet is what
        # it is. (Without this branch layers[R - 1] would wrap round to layers[-1]
        # and quietly report the wrong mask values.)
        expected_final = layers[0][start_code]
        ev_by_rolls_left = [expected_final]
        cur = score[start_code]
    else:
        root_prev = layers[R - 1]
        root_fs = {}
        for mk in masks_of[start_code]:
            if mk["key"] not in root_fs:
                root_fs[mk["key"]] = _build_f(completions[mk["key"]], root_prev)
            mask_ev.append({
                "lockedSlots": list(mk["slots"]),
                "lockedKeys": [state_atoms[i]["key"] for i in mk["atomIdx"]],
                "ev": _query_f(root_fs[mk["key"]], root_prev[start_code]),
            })
        mask_ev.sort(key=lambda m: -m["ev"])
        expected_final = layers[R][start_code]
        ev_by_rolls_left = [layers[r][start_code] for r in range(R + 1)]
        cur = score[start_code]

    final_dist = _forward_distribution(start_code, R, layers, policies, completions, score, seed_mu)

    p_improve = 0.0
    mean = 0.0
    for sv, pv in final_dist.items():
        mean += sv * pv
        if sv > cur + 1e-9:
            p_improve += pv
    keys = sorted(final_dist.keys())
    cdf = []
    acc = 0.0
    for k in keys:
        acc += final_dist[k]
        cdf.append({"score": k, "p": final_dist[k], "cum": acc})

    def quant(q):
        for row in cdf:
            if row["cum"] >= q - 1e-12:
                return row["score"]
        return cdf[-1]["score"] if cdf else cur

    ctx = {"grade": grade, "profile": profile, "slots": slots, "rolls": R,
           "atoms": atoms, "stateAtoms": state_atoms, "codec": codec,
           "layers": layers, "policies": policies, "score": score,
           "goldPer1Pct": gold_per_1pct, "baselinePct": baseline_pct}

    return {
        "grade": grade, "slots": slots,
        "unrolled": unrolled,
        "currentScore": cur,
        "fixedDamage": fixed_damage,
        "traitDamage": trait_bonus,
        "expectedFinal": expected_final,
        "gain": expected_final - cur,
        "valueGold": (expected_final - baseline_pct) * gold_per_1pct,
        "bestLockMask": mask_ev[0] if mask_ev else None,
        "maskEV": mask_ev,
        "evByRollsLeft": ev_by_rolls_left,
        "pImprove": p_improve,
        "finalScore": {
            "mean": mean,
            "quantiles": {"p10": quant(0.10), "p25": quant(0.25), "p50": quant(0.50),
                          "p75": quant(0.75), "p90": quant(0.90)},
            "cdf": cdf,
        },
        "ctx": ctx,
        "stats": {"states": len(codes), "atoms": len(atoms), "stateAtoms": len(state_atoms),
                  "lockMasks": len(completions), "rolls": R},
    }


def _forward_distribution(start_code, R, layers, policies, completions, score, seed_mu=None):
    final_dist = {}
    mu = dict(seed_mu) if seed_mu else {start_code: 1.0}

    def add_final(code, m):
        k = score[code]
        final_dist[k] = final_dist.get(k, 0.0) + m

    for r in range(R, 0, -1):
        prev = layers[r - 1]
        pol = policies[r]
        groups = {}
        for code, m in mu.items():
            if m <= 0:
                continue
            lk = pol[code]
            if lk is None:
                add_final(code, m)
                continue
            groups.setdefault(lk, []).append({"code": code, "mass": m, "v": prev[code]})
        nxt = {}
        for key, members in groups.items():
            members.sort(key=lambda x: x["v"])
            F = _build_f(completions[key], prev)
            for mem in members:
                idx = bisect.bisect_right(F["vals"], mem["v"])
                stay = mem["mass"] * F["cumP"][idx]
                if stay > 0:
                    nxt[mem["code"]] = nxt.get(mem["code"], 0.0) + stay
            ptr = 0
            below = 0.0
            for t in range(F["n"]):
                while ptr < len(members) and members[ptr]["v"] < F["vals"][t]:
                    below += members[ptr]["mass"]
                    ptr += 1
                if below > 0 and F["probs"][t] > 0:
                    tid = F["ids"][t]
                    nxt[tid] = nxt.get(tid, 0.0) + below * F["probs"][t]
        mu = nxt
    for code, m in mu.items():
        add_final(code, m)
    return final_dist


def advise(ctx, o):
    rl = o.get("rollsLeft", ctx["rolls"] - 1)
    if rl < 0:
        rl = 0
    if rl >= len(ctx["layers"]):
        rl = len(ctx["layers"]) - 1
    layer = ctx["layers"][rl]

    def code_of(lines):
        p = []
        for ln in lines or []:
            a = _match_atom(ctx["atoms"], ln, ctx["grade"])
            if a:
                p.append(a["stateIdx"])
        return ctx["codec"].encode(sorted(p))

    c_keep = code_of(o.get("current"))
    c_new = code_of(o.get("rolled"))
    v_keep = layer.get(c_keep)
    v_new = layer.get(c_new)
    if v_keep is None or v_new is None:
        return {"verdict": "unknown", "vKeep": v_keep, "vNew": v_new}
    return {
        "verdict": "replace" if v_new > v_keep + 1e-12 else "keep",
        "vKeep": v_keep, "vNew": v_new, "delta": v_new - v_keep,
        "scoreKeep": ctx["score"][c_keep], "scoreNew": ctx["score"][c_new],
        "goldDelta": (v_new - v_keep) * ctx["goldPer1Pct"],
        "locksUsed": o.get("locksUsed") or [],
        "rollsLeft": rl,
    }


def p_at_least(cdf, x):
    for i, row in enumerate(cdf):
        if row["score"] >= x - 1e-12:
            return 1 - (cdf[i - 1]["cum"] if i > 0 else 0)
    return 0


def brute_solve(opts):
    """Naked recursion, no memoisation: the independent oracle for solve()."""
    profile = normalize_profile(opts.get("profile"))
    grade = opts.get("grade", "ancient")
    options = opts.get("options") or {}
    caps = options.get("caps", DATA.CAPS)
    atoms = _normalize_test_pool(options["testPool"]) if options.get("testPool") \
        else build_atoms(grade, profile, options)
    state_atoms = _make_state_atoms(atoms)
    slots = opts.get("slots", 2)
    codec = _Codec(len(state_atoms), slots)

    fixed_lines = opts.get("fixedLines") or []
    fixed_present = dict((line_family_id(ln), True) for ln in fixed_lines)
    fixed_counts = count_cats(fixed_lines)
    fixed_damage = set_damage(fixed_lines, grade, profile) + trait_damage(opts.get("traitValues"), profile)

    start_pieces = []
    for ln in opts.get("grantedLines") or []:
        a = _match_atom(atoms, ln, grade)
        if a:
            start_pieces.append(a["stateIdx"])

    if opts.get("rollsLeft") is not None:
        R = opts["rollsLeft"]
    else:
        rolls = opts.get("rolls") or {}
        R = rolls.get("normal", 0) + rolls.get("ticket", 0)
    allow_lock_junk = bool(options.get("allowLockJunk"))

    def score_of(pc):
        return fixed_damage + sum(state_atoms[i]["damage"] for i in pc)

    def V(pc, r):
        if r == 0:
            return score_of(pc)
        best = None
        lockable = [j for j in range(len(pc)) if allow_lock_junk or not state_atoms[pc[j]]["junk"]]
        v_self = V(pc, r - 1)
        for m in range(1 << len(lockable)):
            sel = [lockable[b] for b in range(len(lockable)) if m & (1 << b)]
            if len(sel) >= len(pc) and len(pc) == slots:
                continue
            idxs = sorted(pc[s] for s in sel)
            pres = dict((f, True) for f, v in fixed_present.items() if v)
            cnt = dict(fixed_counts)
            for q in idxs:
                st = state_atoms[q]
                if st["family"]:
                    pres[st["family"]] = True
                cnt[st["cat"]] += 1
            comp = _enumerate_completions(atoms, pres, cnt, slots - len(idxs), idxs, codec, caps)
            ev = 0.0
            for code, p in zip(comp["codes"], comp["probs"]):
                v_t = V(codec.decode(code), r - 1)
                ev += p * (v_self if v_self > v_t else v_t)
            if best is None or ev > best:
                best = ev
        if best is None:
            best = v_self
        return best

    # Same unrolled convention as solve().
    if len(start_pieces) < slots:
        all_t = _enumerate_completions(atoms, fixed_present, fixed_counts, slots, [], codec, caps)
        ev0 = sum(p * V(codec.decode(c), R) for c, p in zip(all_t["codes"], all_t["probs"]))
        return {"expectedFinal": ev0, "currentScore": fixed_damage}
    return {"expectedFinal": V(sorted(start_pieces), R), "currentScore": score_of(sorted(start_pieces))}


# ----------------------------------------------------------------------
# lostark.bible payload decoder
# ----------------------------------------------------------------------

# Mirrors TYPE2_INDEX in bracelet.js — see the note there for the evidence
# behind indices 4, 74 and 151.
TYPE2_INDEX = {
    3: {"cat": "basic", "family": "mainStat", "stat": "str"},
    4: {"cat": "basic", "family": "mainStat", "stat": "dex"},
    5: {"cat": "basic", "family": "mainStat", "stat": "int"},
    6: {"cat": "basic", "family": "vitality"},
    11: {"cat": "basic", "family": "mainStat"},
    15: {"cat": "trait", "family": "crit"},
    16: {"cat": "trait", "family": "spec"},
    17: {"cat": "trait", "family": "domination"},
    18: {"cat": "trait", "family": "swiftness"},
    19: {"cat": "trait", "family": "endurance"},
    20: {"cat": "trait", "family": "expertise"},
    27: {"cat": "special", "family": 6},
    50: {"cat": "special", "family": 24, "centi": True},
    74: {"cat": "special", "family": 31, "centi": True},
    76: {"cat": "special", "family": 32, "centi": True},
    149: {"cat": "special", "family": 8, "centi": True},
    151: {"cat": "special", "family": 33},
}
GRADE_DIGIT = {1: "high", 2: "mid", 3: "low"}


def tier_from_value(family_id, value, grade):
    fam = DATA.SPECIAL_BY_ID.get(family_id)
    if not fam:
        return None
    for t in DATA.TIERS:
        if abs(fam["values"][grade][t][0] - value) < 1e-9:
            return t
    return None


def infer_grade(stats):
    best = "ancient"
    best_hits = -1
    for g in DATA.GRADES:
        hits = 0
        for st in stats:
            if st.get("type") != 2:
                continue
            m = TYPE2_INDEX.get(st.get("index"))
            if not m or m["cat"] != "special":
                continue
            v = st["value"] / 100.0 if m.get("centi") else st["value"]
            if tier_from_value(m["family"], v, g):
                hits += 1
        if hits > best_hits:
            best_hits = hits
            best = g
    return best


def decode_bible_bracelet(stats, opts=None):
    opts = opts or {}
    grade = opts.get("grade") or infer_grade(stats)
    lines = []
    unknown = []
    for st in stats:
        line = None
        t = st.get("type")
        if t in (3, 4):
            base = 11000 if t == 3 else 605100000
            off = st["index"] - base
            gd = off % 10
            fam = (off - gd) // 10 + 10
            tier = GRADE_DIGIT.get(gd)
            if tier and fam in DATA.SPECIAL_BY_ID:
                line = {"cat": "special", "family": fam, "tier": tier,
                        "value": DATA.SPECIAL_BY_ID[fam]["values"][grade][tier],
                        "fixed": bool(st.get("fixed")), "raw": st.get("value")}
        elif t == 2:
            m = TYPE2_INDEX.get(st.get("index"))
            if m:
                v = st["value"] / 100.0 if m.get("centi") else st["value"]
                if m["cat"] == "special":
                    t2 = tier_from_value(m["family"], v, grade)
                    line = {"cat": "special", "family": m["family"], "tier": t2, "value": [v],
                            "fixed": bool(st.get("fixed")), "raw": st.get("value")}
                    if not t2:
                        line["unmatchedValue"] = True
                else:
                    line = {"cat": m["cat"], "family": m["family"], "tier": None, "value": v,
                            "fixed": bool(st.get("fixed")), "raw": st.get("value")}
                    if m.get("stat"):
                        line["stat"] = m["stat"]
        if line:
            line["source"] = {"type": t, "index": st.get("index")}
            lines.append(line)
        else:
            unknown.append({"type": t, "index": st.get("index"), "value": st.get("value"),
                            "fixed": bool(st.get("fixed"))})
    return {"grade": grade, "lines": lines, "unknown": unknown}
