/**
 * gear-data.js — the Serca honing table and the baseline constants that turn a
 * gear setup into a weapon-power / main-stat pair.
 *
 * Transcribed from docs/research/baseline-derivation.md (bebkok "LOA Sup buff
 * calc v3.81", tab `Gear data (Serca)`). Level 0 = ilvl 1675, +5 ilvl per level,
 * level 25 = ilvl 1800. Data only.
 *
 * Aegir gear (with its Advanced Honing multipliers) is not modelled in v1.
 */
(function (root) {
  "use strict";

  // [head, shoulder, chest, pants, gloves, weaponWP] per honing level 0…25.
  var SERCA = [
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
    [139346, 148304, 111477, 120435, 167216, 241367]
  ];

  var PIECES = ["head", "shoulder", "chest", "pants", "gloves", "weapon"];
  var ILVL0 = 1675, ILVL_STEP = 5;

  var DEFAULTS = {
    // Shizu's reference build: weapon +25, gloves +23, everything else +21 → ilvl 1785.
    pieceLevels: { head: 21, shoulder: 21, chest: 21, pants: 21, gloves: 23, weapon: 25 },
    // Accessories at the loseii accessory tool's MAIN_RANGE tops, no flat-stat rolls:
    // neck 17857 + 2 × earring 13889 + 2 × ring 12897.
    accessoryMainStat: 71429,
    baseMainStat: 477,
    rosterBonus: 2085,
    msPct: 0.09,        // 8% skins + 1% stronghold ranch
    wpPct: 0.085,       // 2 × 3% earring WP lines + 2.5% karma
    // 11 damage gems at level 9 (1.0% each) + a 9/7 ability stone (1.5%).
    // Per-gem tiers: lv7 0.6% · lv8 0.8% · lv9 1.0% · lv10 1.2%.
    // Cancels out of every line ratio when flatAP = 0.
    baseApPct: 0.125,
    flatAP: 2700        // ark-grid cores
  };

  var API = { SERCA: SERCA, PIECES: PIECES, ILVL0: ILVL0, ILVL_STEP: ILVL_STEP, DEFAULTS: DEFAULTS };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.BraceletGearData = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
