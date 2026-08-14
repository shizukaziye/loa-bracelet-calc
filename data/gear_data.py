"""gear_data.py - Python mirror of data/gear-data.js (Serca honing table)."""

# [head, shoulder, chest, pants, gloves, weaponWP] per honing level 0..25.
SERCA = [
    [72017, 76646, 57614, 62242, 86421, 124793],
    [73903, 78654, 59123, 63872, 88684, 128059],
    [75855, 80731, 60684, 65559, 91026, 131439],
    [77875, 82881, 62300, 67306, 93450, 134936],
    [79965, 85106, 63973, 69113, 95959, 138556],
    [82129, 87410, 65704, 70983, 98556, 142303],
    [84369, 89793, 67497, 72919, 101244, 146182],
    [86688, 92261, 69351, 74922, 104025, 150196],
    [89087, 94815, 71270, 76996, 106905, 154350],
    [91570, 97457, 73257, 79142, 109885, 158649],
    [94140, 100193, 75313, 81364, 112969, 163099],
    [96801, 103023, 77441, 83664, 116161, 167706],
    [99554, 105954, 79644, 86043, 119465, 172473],
    [102404, 108987, 81924, 88506, 122885, 177406],
    [105353, 112126, 84283, 91056, 126425, 182514],
    [108406, 115375, 86725, 93693, 130087, 187799],
    [111565, 118738, 89253, 96424, 133879, 193270],
    [114358, 121709, 91486, 98838, 137229, 198101],
    [117218, 124754, 93775, 101310, 140662, 203054],
    [120150, 127874, 96120, 103844, 144180, 208130],
    [123155, 131072, 98524, 106441, 147786, 213333],
    [126236, 134351, 100989, 109104, 151483, 218667],
    [129393, 137711, 103514, 111833, 155271, 224133],
    [132629, 141155, 106103, 114630, 159155, 229737],
    [135946, 144686, 108757, 117497, 163136, 235480],
    [139346, 148304, 111477, 120435, 167216, 241367],
]

PIECES = ["head", "shoulder", "chest", "pants", "gloves", "weapon"]
ILVL0 = 1675
ILVL_STEP = 5

DEFAULTS = {
    "pieceLevels": {"head": 21, "shoulder": 21, "chest": 21, "pants": 21, "gloves": 23, "weapon": 25},
    "accessoryMainStat": 71429,
    "baseMainStat": 477,
    "rosterBonus": 2085,
    "msPct": 0.09,
    "wpPct": 0.085,
    "baseApPct": 0.125,
    "flatAP": 3600,   # Ancient attack core at 17+ points: 900 + 2700
    # Flat WEAPON power - zero on the reference build (attack cores, no flat
    # weapon-power rolls). It is weapon power, so it goes inside the square root.
    "flatWP": 0,
}

# ---- ARK-GRID CORES --------------------------------------------------------
# A core grants flat power once its gems total 10 points, and more again at 17.
# Two of the cores matter to a damage dealer, and a build runs one or the other:
#
# A core's thresholds ADD - they do not replace:
#   attack core   10pt +900    17pt +1800 relic / +2700 ancient
#                 -> TOTAL     2700 relic / 3600 ancient, flat ATTACK power
#   weapon core   10pt +1300   17pt +2600 relic / +3900 ancient
#                 -> TOTAL     3900 relic / 5200 ancient, flat WEAPON power
# Points above 17 pay only a percentage, so the flat stops at the 17-point step.
#
# Flat attack power lands beside the square root; flat weapon power lands inside
# it, where the weapon-power bucket then amplifies it. That is why the weapon
# core's bigger number is not straightforwardly better.
#
# The character page carries each core's id, grade and point total, but says
# NOTHING about which effect a core has, so the type is the deck's to set.
ARK_CORE = {
    "thresholds": [17, 10],
    "attack": {"relic": {10: 900, 17: 2700}, "ancient": {10: 900, 17: 3600}},
    "weapon": {"relic": {10: 1300, 17: 3900}, "ancient": {10: 1300, 17: 5200}},
}


def ark_core_flat(type_, grade, points):
    """Flat power from one core: type_ "attack"|"weapon"|"none", points 0..20."""
    t = ARK_CORE.get(type_)
    if not t:
        return 0
    band = t["relic" if grade == "relic" else "ancient"]
    for th in ARK_CORE["thresholds"]:
        if points >= th:
            return band[th]
    return 0
