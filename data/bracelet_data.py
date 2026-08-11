"""bracelet_data.py - Python mirror of data/bracelet-data.js.

Same official tables, same shapes, same weight scale. Kept honest by refs.json:
verify.py recomputes the JS-produced references with this module, so a typo in
the transcription shows up as a failed check rather than a silent wrong number.

Stdlib only, Python 3.6+.
"""

LEAP_POINTS = {"relic": 9, "ancient": 18}

LINE_COUNTS = {
    "fixed": {"relic": {1: 65, 2: 35}, "ancient": {1: 65, 2: 35}},
    "granted": {"relic": {1: 75, 2: 25}, "ancient": {2: 75, 3: 25}},
}

CATEGORY_WEIGHTS = {"basic": 35, "trait": 35, "special": 30}
CAPS = {"basic": 2, "trait": 2, "special": 5}

BASIC = {
    "families": [
        {"key": "mainStat", "label": "Str / Dex / Int", "pctOfCategory": 50},
        {"key": "vitality", "label": "Vitality", "pctOfCategory": 50},
    ],
    "bands": [
        {"prob": 10, "relic": {"mainStat": [6400, 7040], "vitality": [3000, 3200]},
         "ancient": {"mainStat": [9600, 10240], "vitality": [4000, 4200]}},
        {"prob": 16, "relic": {"mainStat": [7041, 7680], "vitality": [3201, 3400]},
         "ancient": {"mainStat": [10241, 10880], "vitality": [4201, 4400]}},
        {"prob": 16, "relic": {"mainStat": [7681, 8320], "vitality": [3401, 3600]},
         "ancient": {"mainStat": [10881, 11520], "vitality": [4401, 4600]}},
        {"prob": 16, "relic": {"mainStat": [8321, 8960], "vitality": [3601, 3800]},
         "ancient": {"mainStat": [11521, 12160], "vitality": [4601, 4800]}},
        {"prob": 10, "relic": {"mainStat": [8961, 9600], "vitality": [3801, 4000]},
         "ancient": {"mainStat": [12161, 12800], "vitality": [4801, 5000]}},
        {"prob": 10, "relic": {"mainStat": [9601, 10240], "vitality": [4001, 4200]},
         "ancient": {"mainStat": [12801, 13440], "vitality": [5001, 5200]}},
        {"prob": 10, "relic": {"mainStat": [10241, 10880], "vitality": [4201, 4400]},
         "ancient": {"mainStat": [13441, 14080], "vitality": [5201, 5400]}},
        {"prob": 4, "relic": {"mainStat": [10881, 11520], "vitality": [4401, 4600]},
         "ancient": {"mainStat": [14081, 14720], "vitality": [5401, 5600]}},
        {"prob": 4, "relic": {"mainStat": [11521, 12160], "vitality": [4601, 4800]},
         "ancient": {"mainStat": [14721, 15360], "vitality": [5601, 5800]}},
        {"prob": 4, "relic": {"mainStat": [12161, 12800], "vitality": [4801, 5000]},
         "ancient": {"mainStat": [15361, 16000], "vitality": [5801, 6000]}},
    ],
}

TRAITS = {
    "families": [
        {"key": "crit", "label": "Crit"},
        {"key": "spec", "label": "Specialization"},
        {"key": "domination", "label": "Domination"},
        {"key": "swiftness", "label": "Swiftness"},
        {"key": "endurance", "label": "Endurance"},
        {"key": "expertise", "label": "Expertise"},
    ],
    "bands": [
        {"prob": 10, "relic": [41, 46], "ancient": [61, 66]},
        {"prob": 16, "relic": [47, 52], "ancient": [67, 72]},
        {"prob": 16, "relic": [53, 58], "ancient": [73, 78]},
        {"prob": 16, "relic": [59, 64], "ancient": [79, 84]},
        {"prob": 10, "relic": [65, 70], "ancient": [85, 90]},
        {"prob": 10, "relic": [71, 76], "ancient": [91, 96]},
        {"prob": 10, "relic": [77, 82], "ancient": [97, 102]},
        {"prob": 4, "relic": [83, 88], "ancient": [103, 108]},
        {"prob": 4, "relic": [89, 94], "ancient": [109, 114]},
        {"prob": 4, "relic": [95, 100], "ancient": [115, 120]},
    ],
}

TIERS = ["low", "mid", "high"]

P_FIXED_1_10 = {"low": 6, "mid": 3, "high": 1}
P_GRANT_1_10 = {"low": 4.2, "mid": 2.1, "high": 0.7}
P_GRANT_11_22 = {"low": 0.5, "mid": 0.25, "high": 0.08333}
P_GRANT_23_33 = {"low": 1.0909, "mid": 0.5455, "high": 0.1818}


def _f(fid, key, label, granted, fixed, relic, ancient, comp):
    return {
        "id": fid, "key": key, "label": label,
        "grantOnly": fixed is None,
        "granted": granted, "fixed": fixed,
        "values": {
            "relic": {"low": relic[0], "mid": relic[1], "high": relic[2]},
            "ancient": {"low": ancient[0], "mid": ancient[1], "high": ancient[2]},
        },
        "comp": comp,
    }


def _s(a, b, c):
    return [[a], [b], [c]]


def _d(a1, a2, b1, b2, c1, c2):
    return [[a1, a2], [b1, b2], [c1, c2]]


NONE = [{"k": "none", "from": 0}]

SPECIALS = [
    _f(1, "atkMoveSpeed", "Attack & Move Speed +X%", P_GRANT_1_10, P_FIXED_1_10,
       _s(3, 4, 5), _s(4, 5, 6), [{"k": "atkMoveSpeed", "from": 0}]),
    _f(2, "dmgToSeedLower", "Damage to Seed-grade & lower +X%", P_GRANT_1_10, P_FIXED_1_10,
       _s(3, 4, 5), _s(4, 5, 6), NONE),
    _f(3, "dmgTakenSeedLower", "Damage taken from Seed-grade & lower -X%", P_GRANT_1_10, P_FIXED_1_10,
       _s(4, 6, 8), _s(6, 8, 10), NONE),
    _f(4, "physDef", "Physical Defense +X", P_GRANT_1_10, P_FIXED_1_10,
       _s(4000, 5000, 6000), _s(5000, 6000, 7000), NONE),
    _f(5, "magDef", "Magic Defense +X", P_GRANT_1_10, P_FIXED_1_10,
       _s(4000, 5000, 6000), _s(5000, 6000, 7000), NONE),
    _f(6, "maxHp", "Max HP +X", P_GRANT_1_10, P_FIXED_1_10,
       _s(8400, 11200, 14000), _s(11200, 14000, 16800), NONE),
    _f(7, "hpRecovery", "Combat HP recovery +X", P_GRANT_1_10, P_FIXED_1_10,
       _s(80, 100, 130), _s(100, 130, 160), NONE),
    _f(8, "resourceRecovery", "Combat resource natural recovery +X%", P_GRANT_1_10, P_FIXED_1_10,
       _s(6, 8, 10), _s(8, 10, 12), NONE),
    _f(9, "moveSkillCd", "Movement / stand-up skill cooldown -X%", P_GRANT_1_10, P_FIXED_1_10,
       _s(6, 8, 10), _s(8, 10, 12), NONE),
    _f(10, "hitImmunity", "On-hit stagger/debuff immunity Xs, gone after 1 hit (CD Xs)",
       P_GRANT_1_10, P_FIXED_1_10, _s(90, 80, 70), _s(80, 70, 60), NONE),

    _f(11, "critRateOnCrit", "Crit Rate +A%; on crit, damage +1.5%", P_GRANT_11_22, None,
       _s(2.6, 3.4, 4.2), _s(3.4, 4.2, 5.0),
       [{"k": "critRate", "from": 0}, {"k": "onCritDamage", "v": 1.5}]),
    _f(12, "critDmgOnCrit", "Crit Damage +A%; on crit, damage +1.5%", P_GRANT_11_22, None,
       _s(5.2, 6.8, 8.4), _s(6.8, 8.4, 10.0),
       [{"k": "critDamage", "from": 0}, {"k": "onCritDamage", "v": 1.5}]),
    _f(13, "dmgStagger", "Damage +A%; damage to Staggered +B%", P_GRANT_11_22, None,
       _d(1.5, 3.5, 2.0, 4.0, 2.5, 4.5), _d(2.0, 4.0, 2.5, 4.5, 3.0, 5.0),
       [{"k": "outgoing", "from": 0}, {"k": "staggered", "from": 1}]),
    _f(14, "addDmgDemon", "Additional Damage +A%; Demon/Archdemon damage +B%", P_GRANT_11_22, None,
       _d(2.0, 2.5, 2.5, 2.5, 3.0, 2.5), _d(2.5, 2.5, 3.0, 2.5, 3.5, 2.5),
       [{"k": "addDamage", "from": 0}, {"k": "demon", "from": 1}]),
    _f(15, "cdUpDmgUp", "Skill cooldown +2% but damage +A%", P_GRANT_11_22, None,
       _s(4.0, 4.5, 5.0), _s(4.5, 5.0, 5.5),
       [{"k": "outgoingCdPenalty", "from": 0, "cdPct": 2}]),
    _f(16, "defShredApBuff", "On-hit enemy Defense -A% (1/party); ally AP buff +B%", P_GRANT_11_22, None,
       _d(1.5, 1.5, 1.8, 2.0, 2.1, 2.5), _d(1.8, 2.0, 2.1, 2.5, 2.5, 3.0),
       [{"k": "defShred", "from": 0}, {"k": "allyApBuff", "from": 1}]),
    _f(17, "critResistShredApBuff", "On-hit enemy Crit Resist -A% (1/party); ally AP buff +B%",
       P_GRANT_11_22, None,
       _d(1.5, 1.5, 1.8, 2.0, 2.1, 2.5), _d(1.8, 2.0, 2.1, 2.5, 2.5, 3.0),
       [{"k": "critResistShred", "from": 0}, {"k": "allyApBuff", "from": 1}]),
    _f(18, "shieldedDmgApBuff", "Shielded party target damage +A% (1/party); ally AP buff +B%",
       P_GRANT_11_22, None,
       _d(0.7, 1.5, 0.9, 2.0, 1.1, 2.5), _d(0.9, 2.0, 1.1, 2.5, 1.3, 3.0),
       [{"k": "shieldedDamage", "from": 0}, {"k": "allyApBuff", "from": 1}]),
    _f(19, "critDmgResistShredApBuff", "On-hit enemy Crit DMG Resist -A% (1/party); ally AP buff +B%",
       P_GRANT_11_22, None,
       _d(3.0, 1.5, 3.6, 2.0, 4.2, 2.5), _d(3.6, 2.0, 4.2, 2.5, 4.8, 3.0),
       [{"k": "critDmgResistShred", "from": 0}, {"k": "allyApBuff", "from": 1}]),
    _f(20, "wpStackHit", "On-hit per sec for 10s: Weapon Power +A, atk/move speed +1% (max 6 stacks)",
       P_GRANT_11_22, None, _s(1000, 1160, 1320), _s(1160, 1320, 1480),
       [{"k": "weaponPower", "from": 0, "scaleKey": "wpStacks20"},
        {"k": "atkMoveSpeed", "v": 1, "scaleKey": "wpStacks20"}]),
    _f(21, "wpHpHigh", "Weapon Power +A; while HP>=50%, on-hit Weapon Power +B for 5s",
       P_GRANT_11_22, None,
       _d(6300, 1800, 7200, 2000, 8100, 2200), _d(7200, 2000, 8100, 2200, 9000, 2400),
       [{"k": "weaponPower", "from": 0}, {"k": "weaponPower", "from": 1, "scaleKey": "wpUptime21"}]),
    _f(22, "wpStack30s", "Weapon Power +A; on-hit every 30s Weapon Power +B for 120s (max 30 stacks)",
       P_GRANT_11_22, None,
       _d(6000, 120, 6900, 130, 7800, 140), _d(6900, 130, 7800, 140, 8700, 150),
       [{"k": "weaponPower", "from": 0}, {"k": "weaponPower", "from": 1, "scaleKey": "wpStacks22"}]),

    _f(23, "damage", "Damage to enemies +X%", P_GRANT_23_33, None,
       _s(1.5, 2.0, 2.5), _s(2.0, 2.5, 3.0), [{"k": "outgoing", "from": 0}]),
    _f(24, "addDamage", "Additional Damage +X%", P_GRANT_23_33, None,
       _s(2.5, 3.0, 3.5), _s(3.0, 3.5, 4.0), [{"k": "addDamage", "from": 0}]),
    _f(25, "backAttack", "Back Attack damage +X%", P_GRANT_23_33, None,
       _s(2.0, 2.5, 3.0), _s(2.5, 3.0, 3.5), [{"k": "backAttack", "from": 0}]),
    _f(26, "frontAttack", "Head/Front Attack damage +X%", P_GRANT_23_33, None,
       _s(2.0, 2.5, 3.0), _s(2.5, 3.0, 3.5), [{"k": "frontAttack", "from": 0}]),
    _f(27, "nonDirectional", "Non-directional skill damage +X% (not Awakening)", P_GRANT_23_33, None,
       _s(2.0, 2.5, 3.0), _s(2.5, 3.0, 3.5), [{"k": "nonDirectional", "from": 0}]),
    _f(28, "partyShieldHeal", "Party shield / heal effects +X%", P_GRANT_23_33, None,
       _s(2.0, 2.5, 3.0), _s(2.5, 3.0, 3.5), [{"k": "partyShieldHeal", "from": 0}]),
    _f(29, "allyApBuffEffect", "Ally Attack Power buff effect +X%", P_GRANT_23_33, None,
       _s(3.0, 4.0, 5.0), _s(4.0, 5.0, 6.0), [{"k": "allyApBuff", "from": 0}]),
    _f(30, "allyDamageBuffEffect", "Ally Damage buff effect +X%", P_GRANT_23_33, None,
       _s(4.5, 6.0, 7.5), _s(6.0, 7.5, 9.0), [{"k": "allyDamageBuff", "from": 0}]),
    _f(31, "critRate", "Crit Rate +X%", P_GRANT_23_33, None,
       _s(2.6, 3.4, 4.2), _s(3.4, 4.2, 5.0), [{"k": "critRate", "from": 0}]),
    _f(32, "critDamage", "Crit Damage +X%", P_GRANT_23_33, None,
       _s(5.2, 6.8, 8.4), _s(6.8, 8.4, 10.0), [{"k": "critDamage", "from": 0}]),
    _f(33, "weaponPower", "Weapon Power +X", P_GRANT_23_33, None,
       _s(6300, 7200, 8100), _s(7200, 8100, 9000), [{"k": "weaponPower", "from": 0}]),
]

SPECIAL_BY_ID = {}
SPECIAL_BY_KEY = {}
GRANTED_LISTED_SUM = 0.0
FIXED_LISTED_SUM = 0.0
for _fam in SPECIALS:
    SPECIAL_BY_ID[_fam["id"]] = _fam
    SPECIAL_BY_KEY[_fam["key"]] = _fam
    for _t in TIERS:
        GRANTED_LISTED_SUM += _fam["granted"][_t]
        if _fam["fixed"]:
            FIXED_LISTED_SUM += _fam["fixed"][_t]

GRADES = ["relic", "ancient"]
