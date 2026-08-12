/**
 * ocr/lexicon.js — what the words on a bracelet tooltip can possibly say.
 *
 * Two indexes, both built at load time from data/bracelet-data.js so they can
 * never drift from the model:
 *
 *   1. a TEXT index — every family's distinctive words, weighted so that "Weapon
 *      Power" counts and "damage" barely does, because half the table says
 *      damage. Matching is by weighted recall with a margin over the runner-up,
 *      which is what a confidence number is allowed to be built from.
 *
 *   2. a VALUE index — every number the game can print, back to the family and
 *      tier that print it. The game prints table values exactly, so an exact hit
 *      is the strongest single witness available, and a near-miss is a misread
 *      that has to look like one.
 *
 * The labels in bracelet-data.js are our own English paraphrases of the official
 * table, not the game client's strings. Matching is therefore token-based and
 * forgiving: it asks "which family shares the most telling words with this
 * line", not "does this line equal that label". The ALIASES block below adds the
 * wording the English client is expected to use. It is UNVERIFIED against a real
 * screenshot; a family whose alias is wrong will show up as a low match score,
 * which the Advisor flags, rather than as a confident wrong answer.
 */
(function (root) {
  "use strict";

  var isNode = (typeof module !== "undefined" && module.exports);
  var DATA = isNode ? require("../data/bracelet-data.js") : root.BraceletData;

  var TIERS = DATA.TIERS;
  var GRADES = ["relic", "ancient"];

  // Words that say nothing about which family a line is.
  var STOP = {};
  ["and", "or", "the", "a", "an", "of", "to", "for", "on", "by", "with", "in", "at",
    "per", "up", "max", "when", "while", "after", "each", "every", "your", "you",
    "increase", "increases", "increased", "decrease", "decreases", "effect", "effects",
    "grade", "s", "x", "sec", "secs", "seconds", "second", "stack", "stacks", "party"
  ].forEach(function (w) { STOP[w] = 1; });

  /**
   * Extra wording the English client may use, per family key. These sit beside
   * the table's own label, not instead of it.
   */
  var ALIASES = {
    atkMoveSpeed: "attack movement speed atk move",
    dmgToSeedLower: "damage seed grade lower below enemies",
    dmgTakenSeedLower: "damage taken seed grade lower below received",
    physDef: "physical defense def",
    magDef: "magic magical defense def",
    maxHp: "max hp health maximum",
    hpRecovery: "hp health recovery regeneration combat",
    resourceRecovery: "resource natural recovery mana identity combat",
    moveSkillCd: "movement stand-up standup skill cooldown",
    hitImmunity: "immunity stagger debuff push immune",
    critRateOnCrit: "crit critical hit rate",
    critDmgOnCrit: "crit critical damage",
    dmgStagger: "damage staggered stagger",
    addDmgDemon: "additional damage demon archdemon",
    cdUpDmgUp: "cooldown skill damage penalty",
    defShredApBuff: "defense reduction ally attack power buff",
    critResistShredApBuff: "crit critical resistance ally attack power buff",
    shieldedDmgApBuff: "shielded shield ally attack power buff",
    critDmgResistShredApBuff: "crit critical damage resistance ally attack power buff",
    wpStackHit: "weapon power attack movement speed stacks",
    wpHpHigh: "weapon power hp health above",
    wpStack30s: "weapon power stacks",
    damage: "damage enemies dealt",
    addDamage: "additional damage add",
    backAttack: "back attack damage",
    frontAttack: "head front attack damage frontal",
    nonDirectional: "non-directional nondirectional skill damage awakening",
    partyShieldHeal: "party shield heal healing effects",
    allyApBuffEffect: "ally attack power buff",
    allyDamageBuffEffect: "ally damage buff",
    critRate: "crit critical hit rate",
    critDamage: "crit critical damage",
    weaponPower: "weapon power"
  };

  // Basics and traits print ONE of several names, never all of them, so each
  // name is its own variant. Scoring a line against the whole synonym list would
  // score "Intelligence +14,246" at one word in six and throw the line away.
  var BASIC_VARIANTS = {
    mainStat: ["Strength", "Dexterity", "Intelligence", "Str Dex Int"],
    vitality: ["Vitality", "Stamina"]
  };
  var TRAIT_VARIANTS = {
    crit: ["Crit", "Critical"],
    spec: ["Specialization", "Spec"],
    domination: ["Domination"],
    swiftness: ["Swiftness", "Swift"],
    endurance: ["Endurance"],
    expertise: ["Expertise"]
  };

  // ------------------------------------------------------------------
  // tokens
  // ------------------------------------------------------------------

  /** Letters only, lower-cased. Numbers are handled by readNumbers, not here. */
  function tokens(s) {
    var out = [], m = String(s || "").toLowerCase().match(/[a-z][a-z'-]*/g) || [];
    for (var i = 0; i < m.length; i++) {
      var t = m[i].replace(/[^a-z]/g, "");
      if (t.length < 2 || STOP[t]) continue;
      out.push(t);
    }
    return out;
  }

  /** Numbers, commas and percent signs stripped. Order is preserved. */
  function readNumbers(s) {
    var out = [];
    var re = /(\d[\d,]*(?:\.\d+)?)/g, m;
    var str = String(s || "");
    while ((m = re.exec(str)) !== null) {
      var v = parseFloat(m[1].replace(/,/g, ""));
      if (isFinite(v)) out.push(v);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // the text index
  // ------------------------------------------------------------------

  // One family, several VARIANTS: the table's own wording, and the wording the
  // client is expected to use. A line is scored against each variant and keeps
  // the best — so a family is never punished for the synonyms it did not print.
  var DOCS = [];   // { kind, family, key, variant, set }

  function addDoc(kind, family, key, text) {
    var set = {}, t = tokens(text);
    if (!t.length) return;
    for (var i = 0; i < t.length; i++) set[t[i]] = 1;
    DOCS.push({ kind: kind, family: family, key: key, variant: text, set: set });
  }

  for (var i = 0; i < DATA.SPECIALS.length; i++) {
    var f = DATA.SPECIALS[i];
    addDoc("special", f.id, f.key, f.label);
    if (ALIASES[f.key]) addDoc("special", f.id, f.key, ALIASES[f.key]);
  }
  for (var b = 0; b < DATA.BASIC.families.length; b++) {
    var bf = DATA.BASIC.families[b];
    (BASIC_VARIANTS[bf.key] || [bf.label]).forEach(function (v) { addDoc("basic", bf.key, bf.key, v); });
  }
  for (var tI = 0; tI < DATA.TRAITS.families.length; tI++) {
    var tf = DATA.TRAITS.families[tI];
    (TRAIT_VARIANTS[tf.key] || [tf.label]).forEach(function (v) { addDoc("trait", tf.key, tf.key, v); });
  }

  // A word's weight falls with how many families use it. "damage" is nearly
  // free; "archdemon" all but names its line on its own.
  var DF = {};
  DOCS.forEach(function (d) { Object.keys(d.set).forEach(function (t) { DF[t] = (DF[t] || 0) + 1; }); });
  var N = DOCS.length;
  function weight(t) { return Math.log((N + 1) / ((DF[t] || 0) + 0.5)); }
  DOCS.forEach(function (d) {
    d.total = 0;
    Object.keys(d.set).forEach(function (t) { d.total += weight(t); });
  });

  // ------------------------------------------------------------------
  // tolerating a slipped letter
  // ------------------------------------------------------------------

  var FUZZY_WEIGHT = 0.6;
  var VOCAB = Object.keys(DF), VOCAB_SET = {};
  VOCAB.forEach(function (v) { VOCAB_SET[v] = 1; });

  function editDistance(a, b, cap) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > cap) return cap + 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      var best = cur[0];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > cap) return cap + 1;
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  /** The lexicon word this OCR token most likely meant, or null. */
  function nearestToken(tok) {
    if (VOCAB_SET[tok]) return tok;
    if (tok.length < 4) return null;                 // too short to guess safely
    var cap = tok.length >= 7 ? 2 : 1;
    var best = null, bestD = cap + 1;
    for (var i = 0; i < VOCAB.length; i++) {
      var v = VOCAB[i];
      if (Math.abs(v.length - tok.length) > cap) continue;
      var d = editDistance(tok, v, cap);
      if (d < bestD) { bestD = d; best = v; }
      else if (d === bestD) best = null;             // a tie settles nothing
    }
    return bestD <= cap ? best : null;
  }

  /**
   * Which families this line's words point at.
   * Returns candidates sorted best-first, each { kind, family, key, score,
   * margin, hits }. `score` is the share of the family's own weighted words the
   * line actually contains (0..1) — recall, not precision, because our labels
   * carry words the client will not print. `margin` is how far clear of the
   * runner-up it finished, and it is the honest half of the confidence.
   */
  function matchFamily(text, opts) {
    opts = opts || {};
    var t = tokens(text), have = {};
    for (var i = 0; i < t.length; i++) have[t[i]] = 1;
    // OCR slips a letter at game text sizes — "Spedalization", "Cnt". A token
    // that is one or two edits from a word in the lexicon counts, but only
    // partly: a fuzzy hit is worth 60% of an exact one, so a line assembled from
    // guesses can never score like a line that was actually read.
    if (opts.fuzzy !== false) {
      for (var f = 0; f < t.length; f++) {
        if (have[t[f]] === 1 && VOCAB_SET[t[f]]) continue;
        var near = nearestToken(t[f]);
        if (near && !have[near]) have[near] = FUZZY_WEIGHT;
      }
    }
    var scored = [];
    for (var d = 0; d < DOCS.length; d++) {
      var doc = DOCS[d];
      if (opts.kind && doc.kind !== opts.kind) continue;
      var s = 0, hits = [];
      var keys = Object.keys(doc.set);
      for (var k = 0; k < keys.length; k++) {
        if (have[keys[k]]) { s += weight(keys[k]) * have[keys[k]]; hits.push(keys[k]); }
      }
      if (s <= 0) continue;
      scored.push({ kind: doc.kind, family: doc.family, key: doc.key,
        label: doc.variant, score: s / doc.total, raw: s, hits: hits });
    }
    // One entry per family: its best variant.
    var byFam = {}, out = [];
    for (var q = 0; q < scored.length; q++) {
      var c = scored[q], id = c.kind + ":" + c.family;
      var prev = byFam[id];
      if (!prev) { byFam[id] = c; out.push(c); continue; }
      if (c.raw > prev.raw || (c.raw === prev.raw && c.score > prev.score)) {
        out[out.indexOf(prev)] = c;
        byFam[id] = c;
      }
    }
    out.sort(function (a, b2) { return (b2.raw - a.raw) || (b2.score - a.score); });
    for (var j = 0; j < out.length; j++) {
      out[j].margin = j === 0
        ? (out[1] ? (out[0].raw - out[1].raw) / Math.max(out[0].raw, 1e-9) : 1)
        : 0;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // how many numbers a family's line prints
  // ------------------------------------------------------------------

  /** The label with its A / B / X placeholders filled in from the table. */
  function renderLabel(fam, values) {
    var t = fam.label;
    t = t.replace(/\bA\b/g, fmtNum(values[0]));
    t = t.replace(/\bB\b/g, fmtNum(values.length > 1 ? values[1] : values[0]));
    t = t.replace(/X/g, fmtNum(values[0]));
    return t.replace(/[−–—]/g, "-");
  }
  function fmtNum(v) {
    if (v >= 1000) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (Math.round(v * 100) / 100).toString();
  }

  // A family's printed line carries a fixed number of numbers — one for a plain
  // "+X%", four for a line with a duration, a cap and two values. That count is
  // read straight off the image and it is what separates "Crit Damage +8.4%"
  // (family 32) from "Crit Damage +8.4%; on crit, damage +1.5%" (family 12),
  // whose words are identical and whose first value is the same number.
  var NUM_COUNT = {};
  (function () {
    for (var s = 0; s < DATA.SPECIALS.length; s++) {
      var fam = DATA.SPECIALS[s];
      var g = fam.values.ancient ? "ancient" : "relic";
      var vals = fam.values[g].mid || fam.values[g].low;
      NUM_COUNT[fam.id] = readNumbers(renderLabel(fam, vals)).length;
    }
  })();
  function numberCount(familyId) { return NUM_COUNT[familyId]; }

  // ------------------------------------------------------------------
  // the value index
  // ------------------------------------------------------------------

  // key: grade|firstValue -> [{ family, tier, values }]
  var VALUE_INDEX = {};
  function vkey(grade, v) { return grade + "|" + (Math.round(v * 100) / 100); }
  for (var si = 0; si < DATA.SPECIALS.length; si++) {
    var sf = DATA.SPECIALS[si];
    for (var gi = 0; gi < GRADES.length; gi++) {
      var g = GRADES[gi];
      if (!sf.values[g]) continue;
      for (var ti = 0; ti < TIERS.length; ti++) {
        var tier = TIERS[ti], vals = sf.values[g][tier];
        if (!vals || vals[0] == null) continue;
        var kk = vkey(g, vals[0]);
        (VALUE_INDEX[kk] = VALUE_INDEX[kk] || []).push({ family: sf.id, key: sf.key, tier: tier, values: vals });
      }
    }
  }

  /**
   * Families and tiers that print exactly these numbers.
   * A one-entry answer is close to proof; a many-entry answer narrows the field
   * and settles nothing on its own, which is what the caller is told.
   */
  function familiesForValues(values, grade) {
    if (!values || values[0] == null) return [];
    var hits = (VALUE_INDEX[vkey(grade, values[0])] || []).slice();
    if (values.length > 1 && values[1] != null) {
      var tight = hits.filter(function (h) {
        return h.values.length > 1 && Math.abs(h.values[1] - values[1]) < 1e-9;
      });
      if (tight.length) return tight;
    }
    return hits;
  }

  /** Every legal basic value range, for testing a read number against a grade. */
  function basicBands(grade, fam) {
    return DATA.BASIC.bands.map(function (bd) { return bd[grade][fam]; });
  }
  function traitBands(grade) {
    return DATA.TRAITS.bands.map(function (bd) { return bd[grade]; });
  }

  /**
   * The colour lostark.bible paints a roll band with: green for bands 1-4, blue
   * for 5-7, purple for 8-10 (docs/research). Kept here so the parser can cross
   * a colour against a number WITHOUT either one being allowed to invent the
   * other — the caller compares them and lowers confidence when they disagree.
   */
  function bandColor(bandIndex) {
    if (bandIndex >= 1 && bandIndex <= 4) return "green";
    if (bandIndex >= 5 && bandIndex <= 7) return "blue";
    if (bandIndex >= 8 && bandIndex <= 10) return "purple";
    return null;
  }

  /** The colour a special-effect tier is expected to be drawn in. UNVERIFIED. */
  function tierColor(tier) {
    return tier === "high" ? "gold" : (tier === "mid" ? "purple" : "blue");
  }

  /** "3 + 2 rolls remaining", "5 rolls left", "Rolls: 4". Null when absent. */
  function readRolls(text) {
    var s = String(text || "").toLowerCase();
    var m = s.match(/(\d+)\s*\+\s*(\d+)\s*(?:roll|reroll|attempt|change)/);
    if (m) return parseInt(m[1], 10) + parseInt(m[2], 10);
    m = s.match(/(?:roll|reroll|attempt|change)[a-z ]*?(\d+)\s*(?:\/\s*(\d+))?/);
    if (m) return parseInt(m[1], 10);
    m = s.match(/(\d+)\s*(?:roll|reroll|attempt|change)/);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  var API = {
    tokens: tokens, readNumbers: readNumbers, readRolls: readRolls,
    matchFamily: matchFamily, familiesForValues: familiesForValues,
    renderLabel: renderLabel, numberCount: numberCount,
    basicBands: basicBands, traitBands: traitBands,
    bandColor: bandColor, tierColor: tierColor,
    ALIASES: ALIASES, DOCS: DOCS
  };

  if (isNode) module.exports = API;
  else root.BraceletLexicon = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
