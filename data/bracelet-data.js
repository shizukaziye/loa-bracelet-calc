/**
 * bracelet-data.js — the official T4 bracelet tables, transcribed from
 * docs/research/official-probabilities.md (Stove disclosure page, revised
 * 2025-12-30). Data only: no math, no DOM, no dependencies.
 *
 * Both grades share one shape; every value that differs by grade is keyed
 * `{ relic: …, ancient: … }`.
 *
 * Probabilities are the LISTED percentages exactly as published. The page
 * rounds, so the special table sums to 100.00016% rather than 100%; the model
 * normalises at read time and never "fixes" a listed number.
 *
 * Weight scale used by the model: every draw outcome carries a weight on ONE
 * 100-point scale — basic 35 (17.5 main stat / 17.5 vitality), combat trait 35
 * (35/6 each), special 30 (30 × listed / listed-sum). That matches the page's
 * renormalisation rule: real chance = listed / (100 − listed of everything
 * excluded).
 *
 * Value arrays hold one entry for single-value effects and two (A then B) for
 * the "A and B" combo families.
 *
 * `comp` describes what an effect DOES, so the scoring layer never hardcodes a
 * family number. Each component is { k: kind, v: literal | from: value index,
 * scaleKey: profile field multiplying it }.
 */
(function (root) {
  "use strict";

  var LEAP_POINTS = { relic: 9, ancient: 18 };

  // Fixed lines come with the drop; granted lines are the rerollable slots.
  var LINE_COUNTS = {
    fixed:   { relic: { 1: 65, 2: 35 }, ancient: { 1: 65, 2: 35 } },
    granted: { relic: { 1: 75, 2: 25 }, ancient: { 2: 75, 3: 25 } }
  };

  var CATEGORY_WEIGHTS = { basic: 35, trait: 35, special: 30 };
  // Caps count fixed + granted lines together.
  var CAPS = { basic: 2, trait: 2, special: 5 };

  // ---- Basic effects (기본 효과), 35% category ----
  // Two families at 50% each; the band is drawn inside the family, uniform
  // within the band's value range.
  var BASIC = {
    families: [
      { key: "mainStat", label: "Str / Dex / Int", pctOfCategory: 50 },
      { key: "vitality", label: "Vitality", pctOfCategory: 50 }
    ],
    bands: [
      { prob: 10, relic: { mainStat: [6400, 7040],   vitality: [3000, 3200] }, ancient: { mainStat: [9600, 10240],  vitality: [4000, 4200] } },
      { prob: 16, relic: { mainStat: [7041, 7680],   vitality: [3201, 3400] }, ancient: { mainStat: [10241, 10880], vitality: [4201, 4400] } },
      { prob: 16, relic: { mainStat: [7681, 8320],   vitality: [3401, 3600] }, ancient: { mainStat: [10881, 11520], vitality: [4401, 4600] } },
      { prob: 16, relic: { mainStat: [8321, 8960],   vitality: [3601, 3800] }, ancient: { mainStat: [11521, 12160], vitality: [4601, 4800] } },
      { prob: 10, relic: { mainStat: [8961, 9600],   vitality: [3801, 4000] }, ancient: { mainStat: [12161, 12800], vitality: [4801, 5000] } },
      { prob: 10, relic: { mainStat: [9601, 10240],  vitality: [4001, 4200] }, ancient: { mainStat: [12801, 13440], vitality: [5001, 5200] } },
      { prob: 10, relic: { mainStat: [10241, 10880], vitality: [4201, 4400] }, ancient: { mainStat: [13441, 14080], vitality: [5201, 5400] } },
      { prob: 4,  relic: { mainStat: [10881, 11520], vitality: [4401, 4600] }, ancient: { mainStat: [14081, 14720], vitality: [5401, 5600] } },
      { prob: 4,  relic: { mainStat: [11521, 12160], vitality: [4601, 4800] }, ancient: { mainStat: [14721, 15360], vitality: [5601, 5800] } },
      { prob: 4,  relic: { mainStat: [12161, 12800], vitality: [4801, 5000] }, ancient: { mainStat: [15361, 16000], vitality: [5801, 6000] } }
    ]
  };

  // ---- Combat traits (전투 특성), 35% category ----
  // Six families at 16.6667% each, one shared band table.
  var TRAITS = {
    families: [
      { key: "crit", label: "Crit" },
      { key: "spec", label: "Specialization" },
      { key: "domination", label: "Domination" },
      { key: "swiftness", label: "Swiftness" },
      { key: "endurance", label: "Endurance" },
      { key: "expertise", label: "Expertise" }
    ],
    bands: [
      { prob: 10, relic: [41, 46],   ancient: [61, 66] },
      { prob: 16, relic: [47, 52],   ancient: [67, 72] },
      { prob: 16, relic: [53, 58],   ancient: [73, 78] },
      { prob: 16, relic: [59, 64],   ancient: [79, 84] },
      { prob: 10, relic: [65, 70],   ancient: [85, 90] },
      { prob: 10, relic: [71, 76],   ancient: [91, 96] },
      { prob: 10, relic: [77, 82],   ancient: [97, 102] },
      { prob: 4,  relic: [83, 88],   ancient: [103, 108] },
      { prob: 4,  relic: [89, 94],   ancient: [109, 114] },
      { prob: 4,  relic: [95, 100],  ancient: [115, 120] }
    ]
  };

  var TIERS = ["low", "mid", "high"];

  // Listed per-tier percentages shared by whole blocks of families.
  var P_FIXED_1_10   = { low: 6, mid: 3, high: 1 };
  var P_GRANT_1_10   = { low: 4.2, mid: 2.1, high: 0.7 };
  var P_GRANT_11_22  = { low: 0.5, mid: 0.25, high: 0.08333 };
  var P_GRANT_23_33  = { low: 1.0909, mid: 0.5455, high: 0.1818 };

  function f(id, key, label, granted, fixed, relic, ancient, comp) {
    return {
      id: id, key: key, label: label,
      grantOnly: !fixed,
      granted: granted, fixed: fixed || null,
      values: { relic: { low: relic[0], mid: relic[1], high: relic[2] },
                ancient: { low: ancient[0], mid: ancient[1], high: ancient[2] } },
      comp: comp
    };
  }

  // Shorthand for single-value tier triples.
  function s(a, b, c) { return [[a], [b], [c]]; }
  // Shorthand for two-value (A&B) tier triples.
  function d(a1, a2, b1, b2, c1, c2) { return [[a1, a2], [b1, b2], [c1, c2]]; }

  var NONE = [{ k: "none", from: 0 }];

  var SPECIALS = [
    // --- 1–10: fixed-eligible. Fixed 6/3/1%, granted 4.2/2.1/0.7% ---
    f(1, "atkMoveSpeed", "Attack & Move Speed +X%", P_GRANT_1_10, P_FIXED_1_10,
      s(3, 4, 5), s(4, 5, 6), [{ k: "atkMoveSpeed", from: 0 }]),
    f(2, "dmgToSeedLower", "Damage to Seed-grade & lower +X%", P_GRANT_1_10, P_FIXED_1_10,
      s(3, 4, 5), s(4, 5, 6), NONE),
    f(3, "dmgTakenSeedLower", "Damage taken from Seed-grade & lower −X%", P_GRANT_1_10, P_FIXED_1_10,
      s(4, 6, 8), s(6, 8, 10), NONE),
    f(4, "physDef", "Physical Defense +X", P_GRANT_1_10, P_FIXED_1_10,
      s(4000, 5000, 6000), s(5000, 6000, 7000), NONE),
    f(5, "magDef", "Magic Defense +X", P_GRANT_1_10, P_FIXED_1_10,
      s(4000, 5000, 6000), s(5000, 6000, 7000), NONE),
    f(6, "maxHp", "Max HP +X", P_GRANT_1_10, P_FIXED_1_10,
      s(8400, 11200, 14000), s(11200, 14000, 16800), NONE),
    f(7, "hpRecovery", "Combat HP recovery +X", P_GRANT_1_10, P_FIXED_1_10,
      s(80, 100, 130), s(100, 130, 160), NONE),
    f(8, "resourceRecovery", "Combat resource natural recovery +X%", P_GRANT_1_10, P_FIXED_1_10,
      s(6, 8, 10), s(8, 10, 12), NONE),
    f(9, "moveSkillCd", "Movement / stand-up skill cooldown −X%", P_GRANT_1_10, P_FIXED_1_10,
      s(6, 8, 10), s(8, 10, 12), NONE),
    // Higher tier = SHORTER immunity and shorter cooldown; the listed number is the pair.
    f(10, "hitImmunity", "On-hit stagger/debuff immunity Xs, gone after 1 hit (CD Xs)", P_GRANT_1_10, P_FIXED_1_10,
      s(90, 80, 70), s(80, 70, 60), NONE),

    // --- 11–22: grant-only combos. Granted 0.5 / 0.25 / 0.08333% ---
    f(11, "critRateOnCrit", "Crit Rate +A%; on crit, damage +1.5%", P_GRANT_11_22, null,
      s(2.6, 3.4, 4.2), s(3.4, 4.2, 5.0),
      [{ k: "critRate", from: 0 }, { k: "onCritDamage", v: 1.5 }]),
    f(12, "critDmgOnCrit", "Crit Damage +A%; on crit, damage +1.5%", P_GRANT_11_22, null,
      s(5.2, 6.8, 8.4), s(6.8, 8.4, 10.0),
      [{ k: "critDamage", from: 0 }, { k: "onCritDamage", v: 1.5 }]),
    f(13, "dmgStagger", "Damage +A%; damage to Staggered +B%", P_GRANT_11_22, null,
      d(1.5, 3.5, 2.0, 4.0, 2.5, 4.5), d(2.0, 4.0, 2.5, 4.5, 3.0, 5.0),
      [{ k: "outgoing", from: 0 }, { k: "staggered", from: 1 }]),
    f(14, "addDmgDemon", "Additional Damage +A%; Demon/Archdemon damage +B%", P_GRANT_11_22, null,
      d(2.0, 2.5, 2.5, 2.5, 3.0, 2.5), d(2.5, 2.5, 3.0, 2.5, 3.5, 2.5),
      [{ k: "addDamage", from: 0 }, { k: "demon", from: 1 }]),
    f(15, "cdUpDmgUp", "Skill cooldown +2% but damage +A%", P_GRANT_11_22, null,
      s(4.0, 4.5, 5.0), s(4.5, 5.0, 5.5),
      [{ k: "outgoingCdPenalty", from: 0, cdPct: 2 }]),
    f(16, "defShredApBuff", "On-hit enemy Defense −A% (1/party); ally AP buff +B%", P_GRANT_11_22, null,
      d(1.5, 1.5, 1.8, 2.0, 2.1, 2.5), d(1.8, 2.0, 2.1, 2.5, 2.5, 3.0),
      [{ k: "defShred", from: 0 }, { k: "allyApBuff", from: 1 }]),
    f(17, "critResistShredApBuff", "On-hit enemy Crit Resist −A% (1/party); ally AP buff +B%", P_GRANT_11_22, null,
      d(1.5, 1.5, 1.8, 2.0, 2.1, 2.5), d(1.8, 2.0, 2.1, 2.5, 2.5, 3.0),
      [{ k: "critResistShred", from: 0 }, { k: "allyApBuff", from: 1 }]),
    f(18, "shieldedDmgApBuff", "Shielded party target damage +A% (1/party); ally AP buff +B%", P_GRANT_11_22, null,
      d(0.7, 1.5, 0.9, 2.0, 1.1, 2.5), d(0.9, 2.0, 1.1, 2.5, 1.3, 3.0),
      [{ k: "shieldedDamage", from: 0 }, { k: "allyApBuff", from: 1 }]),
    f(19, "critDmgResistShredApBuff", "On-hit enemy Crit DMG Resist −A% (1/party); ally AP buff +B%", P_GRANT_11_22, null,
      d(3.0, 1.5, 3.6, 2.0, 4.2, 2.5), d(3.6, 2.0, 4.2, 2.5, 4.8, 3.0),
      [{ k: "critDmgResistShred", from: 0 }, { k: "allyApBuff", from: 1 }]),
    f(20, "wpStackHit", "On-hit per sec for 10s: Weapon Power +A, atk/move speed +1% (max 6 stacks)", P_GRANT_11_22, null,
      s(1000, 1160, 1320), s(1160, 1320, 1480),
      [{ k: "weaponPower", from: 0, scaleKey: "wpStacks20" },
       { k: "atkMoveSpeed", v: 1, scaleKey: "wpStacks20" }]),
    f(21, "wpHpHigh", "Weapon Power +A; while HP≥50%, on-hit Weapon Power +B for 5s", P_GRANT_11_22, null,
      d(6300, 1800, 7200, 2000, 8100, 2200), d(7200, 2000, 8100, 2200, 9000, 2400),
      [{ k: "weaponPower", from: 0 }, { k: "weaponPower", from: 1, scaleKey: "wpUptime21" }]),
    f(22, "wpStack30s", "Weapon Power +A; on-hit every 30s Weapon Power +B for 120s (max 30 stacks)", P_GRANT_11_22, null,
      d(6000, 120, 6900, 130, 7800, 140), d(6900, 130, 7800, 140, 8700, 150),
      [{ k: "weaponPower", from: 0 }, { k: "weaponPower", from: 1, scaleKey: "wpStacks22" }]),

    // --- 23–33: grant-only singles. Granted 1.0909 / 0.5455 / 0.1818% ---
    f(23, "damage", "Damage to enemies +X%", P_GRANT_23_33, null,
      s(1.5, 2.0, 2.5), s(2.0, 2.5, 3.0), [{ k: "outgoing", from: 0 }]),
    f(24, "addDamage", "Additional Damage +X%", P_GRANT_23_33, null,
      s(2.5, 3.0, 3.5), s(3.0, 3.5, 4.0), [{ k: "addDamage", from: 0 }]),
    f(25, "backAttack", "Back Attack damage +X%", P_GRANT_23_33, null,
      s(2.0, 2.5, 3.0), s(2.5, 3.0, 3.5), [{ k: "backAttack", from: 0 }]),
    f(26, "frontAttack", "Head/Front Attack damage +X%", P_GRANT_23_33, null,
      s(2.0, 2.5, 3.0), s(2.5, 3.0, 3.5), [{ k: "frontAttack", from: 0 }]),
    f(27, "nonDirectional", "Non-directional skill damage +X% (not Awakening)", P_GRANT_23_33, null,
      s(2.0, 2.5, 3.0), s(2.5, 3.0, 3.5), [{ k: "nonDirectional", from: 0 }]),
    f(28, "partyShieldHeal", "Party shield / heal effects +X%", P_GRANT_23_33, null,
      s(2.0, 2.5, 3.0), s(2.5, 3.0, 3.5), [{ k: "partyShieldHeal", from: 0 }]),
    f(29, "allyApBuffEffect", "Ally Attack Power buff effect +X%", P_GRANT_23_33, null,
      s(3.0, 4.0, 5.0), s(4.0, 5.0, 6.0), [{ k: "allyApBuff", from: 0 }]),
    f(30, "allyDamageBuffEffect", "Ally Damage buff effect +X%", P_GRANT_23_33, null,
      s(4.5, 6.0, 7.5), s(6.0, 7.5, 9.0), [{ k: "allyDamageBuff", from: 0 }]),
    f(31, "critRate", "Crit Rate +X%", P_GRANT_23_33, null,
      s(2.6, 3.4, 4.2), s(3.4, 4.2, 5.0), [{ k: "critRate", from: 0 }]),
    f(32, "critDamage", "Crit Damage +X%", P_GRANT_23_33, null,
      s(5.2, 6.8, 8.4), s(6.8, 8.4, 10.0), [{ k: "critDamage", from: 0 }]),
    f(33, "weaponPower", "Weapon Power +X", P_GRANT_23_33, null,
      s(6300, 7200, 8100), s(7200, 8100, 9000), [{ k: "weaponPower", from: 0 }])
  ];

  var SPECIAL_BY_ID = {}, SPECIAL_BY_KEY = {};
  var GRANTED_LISTED_SUM = 0, FIXED_LISTED_SUM = 0;
  for (var i = 0; i < SPECIALS.length; i++) {
    var fam = SPECIALS[i];
    SPECIAL_BY_ID[fam.id] = fam;
    SPECIAL_BY_KEY[fam.key] = fam;
    for (var t = 0; t < TIERS.length; t++) {
      GRANTED_LISTED_SUM += fam.granted[TIERS[t]];
      if (fam.fixed) FIXED_LISTED_SUM += fam.fixed[TIERS[t]];
    }
  }

  var API = {
    GRADES: ["relic", "ancient"],
    TIERS: TIERS,
    LEAP_POINTS: LEAP_POINTS,
    LINE_COUNTS: LINE_COUNTS,
    CATEGORY_WEIGHTS: CATEGORY_WEIGHTS,
    CAPS: CAPS,
    BASIC: BASIC,
    TRAITS: TRAITS,
    SPECIALS: SPECIALS,
    SPECIAL_BY_ID: SPECIAL_BY_ID,
    SPECIAL_BY_KEY: SPECIAL_BY_KEY,
    // 100.00016 and 100 respectively — the page's rounding, kept as published.
    GRANTED_LISTED_SUM: GRANTED_LISTED_SUM,
    FIXED_LISTED_SUM: FIXED_LISTED_SUM
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.BraceletData = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
