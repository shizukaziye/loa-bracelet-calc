/**
 * ocr/self-test.js — what can be proved without a real screenshot.
 *
 *   node ocr/self-test.js            the whole battery
 *   node ocr/self-test.js --pipeline just the fixture pipeline
 *   node ocr/self-test.js --snap     just the constraintSnap battery
 *   node ocr/self-test.js --verbose  print every mismatch
 *
 * Two halves, and they prove very different things:
 *
 *   1. THE PIPELINE, on a synthetic tooltip. This proves the plumbing: a panel
 *      is found in a busy frame, rows are cut, wrapped rows are joined to their
 *      entry, colours come out, padlocks are seen, families are named from words
 *      and numbers, and the result is legal. It does NOT prove the parser reads
 *      Lost Ark, because the fixture is not Lost Ark.
 *
 *   2. constraintSnap, against deliberately illegal states. This one proves what
 *      it claims outright: whatever goes in, what comes out is a bracelet the
 *      solver accepts, or an honest unknown.
 */
"use strict";

var path = require("path");
var OCR = require("./engine.js");
var LEX = require("./lexicon.js");
var FIX = require("./fixture.js");
var TE = require("./tooltip-engine.js");
var DATA = require("../data/bracelet-data.js");

var argv = process.argv.slice(2);
var VERBOSE = argv.indexOf("--verbose") >= 0;
var ONLY = argv.indexOf("--pipeline") >= 0 ? "pipeline" : (argv.indexOf("--snap") >= 0 ? "snap" : "all");

var pass = 0, fail = 0;
function ok(cond, what, detail) {
  if (cond) { pass++; return true; }
  fail++;
  console.log("  FAIL  " + what + (detail ? "  — " + detail : ""));
  return false;
}

// ------------------------------------------------------------------
// 1. the pipeline, on synthetic tooltips
// ------------------------------------------------------------------

function truthToExpected(truth) {
  var rows = truth.lines.map(function (l) {
    return l.cat === "basic"
      ? { fam: "basic:" + l.family, value: l.value }
      : { fam: "sp:" + l.family, tier: l.tier };
  });
  return { grade: truth.grade, slots: truth.lines.length, rows: rows,
    traits: truth.traits, rollsLeft: truth.rollsLeft };
}

function runOne(spec, renderOpts, readerOpts) {
  var bracelet = FIX.makeBracelet(spec);
  var fx = FIX.render(bracelet, renderOpts);
  var reader = FIX.makeFixtureReader(fx, readerOpts || {});
  return TE.parseRaster(fx.raster, { reader: reader }).then(function (out) {
    var snapped = OCR.constraintSnap(out.raw);
    return { bracelet: bracelet, fx: fx, out: out, snapped: snapped,
      expected: truthToExpected(bracelet) };
  });
}

function scoreOne(r, tally) {
  var exp = r.expected, patch = r.snapped.patch;
  var legal = OCR.isLegalPatch(patch);
  tally.n++;
  if (!legal.legal) {
    tally.illegal++;
    console.log("  ILLEGAL PATCH: " + legal.why.join("; "));
  }
  function hit(name, got, want) {
    tally[name] = tally[name] || { hit: 0, n: 0 };
    tally[name].n++;
    var good = String(got) === String(want);
    if (good) tally[name].hit++;
    else if (VERBOSE) console.log("    " + name + ": read " + got + ", truth " + want);
    return good;
  }
  hit("grade", patch.grade, exp.grade);
  hit("slots", patch.slots, exp.slots);
  // rows are compared as a SET: the tooltip's order is not load-bearing
  var got = patch.rows.map(function (rw) { return rw.fam + (rw.fam.indexOf("sp:") === 0 ? "/" + rw.tier : "/" + rw.value); }).sort();
  var want = exp.rows.map(function (rw) { return rw.fam + (rw.fam.indexOf("sp:") === 0 ? "/" + rw.tier : "/" + rw.value); }).sort();
  tally.rowsExact = tally.rowsExact || { hit: 0, n: 0 };
  tally.rowsExact.n++;
  if (got.join("|") === want.join("|")) tally.rowsExact.hit++;
  else if (VERBOSE) console.log("    rows: read [" + got.join(", ") + "] truth [" + want.join(", ") + "]");
  // per-line family and tier
  tally.fam = tally.fam || { hit: 0, n: 0 };
  tally.tier = tally.tier || { hit: 0, n: 0 };
  for (var i = 0; i < want.length; i++) {
    tally.fam.n++;
    var wf = want[i].split("/")[0];
    if (got.some(function (g) { return g.split("/")[0] === wf; })) tally.fam.hit++;
    tally.tier.n++;
    if (got.indexOf(want[i]) >= 0) tally.tier.hit++;
  }
  // locks
  var wantLocks = [];
  r.bracelet.lines.forEach(function (l, ix) { if (l.locked) wantLocks.push(ix); });
  tally.locks = tally.locks || { hit: 0, n: 0 };
  tally.locks.n++;
  if (patch.lockedIdx.length === wantLocks.length) tally.locks.hit++;
  else if (VERBOSE) console.log("    locks: read " + patch.lockedIdx.length + ", truth " + wantLocks.length);
  hit("rolls", patch.rollsLeft, exp.rollsLeft);
  // confidence discipline: a field that is WRONG must not be confident
  var conf = r.snapped.confidence;
  tally.silentWrong = tally.silentWrong || 0;
  for (var ri = 0; ri < patch.rows.length; ri++) {
    var mine = patch.rows[ri].fam + (patch.rows[ri].fam.indexOf("sp:") === 0 ? "/" + patch.rows[ri].tier : "/" + patch.rows[ri].value);
    if (want.indexOf(mine) < 0 && (conf["rows." + ri + ".fam"] || 0) >= 0.8) {
      tally.silentWrong++;
      if (VERBOSE) console.log("    SILENT WRONG rows." + ri + " = " + mine + " at conf " + conf["rows." + ri + ".fam"]);
    }
  }
  return tally;
}

function pipelineTests() {
  console.log("\n--- 1. the pipeline, on synthetic tooltips ---");
  var runs = [];
  // a fixed, hand-picked bracelet first: the one everything else is read against
  runs.push({
    name: "hand-picked ancient, three granted lines, one locked",
    spec: { grade: "ancient", seed: 3, rollsLeft: 3, traitKeys: ["crit", "spec"],
      families: [
        { key: "weaponPower", tier: "high" },
        { key: "critDamage", tier: "mid", locked: true },
        { cat: "basic", key: "mainStat", band: 7 }
      ] },
    render: { seed: 11 }
  });
  runs.push({
    name: "relic, two granted lines, a wrapping combo family",
    spec: { grade: "relic", seed: 5, slots: 2, rollsLeft: 5,
      families: [ { key: "dmgStagger", tier: "low" }, { key: "addDamage", tier: "high" } ] },
    render: { seed: 21 }
  });
  runs.push({
    name: "dim capture (brightness 0.6)",
    spec: { grade: "ancient", seed: 3, rollsLeft: 2,
      families: [ { key: "weaponPower", tier: "mid" }, { key: "damage", tier: "high" } ] },
    render: { seed: 31, brightness: 0.6 }
  });
  runs.push({
    name: "bright capture (brightness 1.35)",
    spec: { grade: "ancient", seed: 3, rollsLeft: 2,
      families: [ { key: "weaponPower", tier: "mid" }, { key: "damage", tier: "high" } ] },
    render: { seed: 32, brightness: 1.35 }
  });
  runs.push({
    name: "noisy OCR (12% character swaps)",
    spec: { grade: "ancient", seed: 3, rollsLeft: 2,
      families: [ { key: "critRate", tier: "high" }, { key: "addDamage", tier: "low" } ] },
    render: { seed: 41 }, reader: { errorRate: 0.12 }
  });
  runs.push({
    name: "no text reader at all",
    spec: { grade: "ancient", seed: 3, rollsLeft: 2,
      families: [ { key: "weaponPower", tier: "mid" }, { key: "damage", tier: "high" } ] },
    render: { seed: 51 }, noReader: true
  });

  var chain = Promise.resolve();
  var results = [];
  runs.forEach(function (r) {
    chain = chain.then(function () {
      if (r.noReader) {
        var b = FIX.makeBracelet(r.spec);
        var fx = FIX.render(b, r.render);
        var TR = require("./text-reader.js");
        return TE.parseRaster(fx.raster, { reader: TR.nullReader }).then(function (out) {
          var snapped = OCR.constraintSnap(out.raw);
          results.push({ name: r.name, res: { bracelet: b, fx: fx, out: out, snapped: snapped,
            expected: truthToExpected(b) }, noReader: true });
        });
      }
      return runOne(r.spec, r.render, r.reader).then(function (res) {
        results.push({ name: r.name, res: res });
      });
    });
  });

  return chain.then(function () {
    results.forEach(function (R) {
      console.log("\n  " + R.name);
      var res = R.res;
      var panel = res.out.debug.panel, truePanel = res.fx.panel;
      var dx = Math.abs(panel.x - truePanel.x), dy = Math.abs(panel.y - truePanel.y);
      ok(dx < truePanel.w * 0.06 && dy < truePanel.h * 0.08,
        "panel found within 6% of where it was drawn",
        "read " + Math.round(panel.x) + "," + Math.round(panel.y) + " drawn " + truePanel.x + "," + truePanel.y);
      ok(panel.conf > 0.5, "panel confidence above 0.5", "conf " + panel.conf.toFixed(2));
      ok(res.out.debug.entryCount >= res.fx.lines.filter(function (l) { return l.kind !== "cont"; }).length - 1,
        "entries grouped (wrapped rows joined)",
        "entries " + res.out.debug.entryCount + " drawn rows " + res.fx.lines.length);
      var legal = OCR.isLegalPatch(res.snapped.patch);
      ok(legal.legal, "the snapped patch is legal", legal.why.join("; "));
      if (R.noReader) {
        // With no words at all, nothing that DEPENDS on words may be confident.
        // The grade may still be read, because it comes off the name's colour —
        // that is a picture, not a word.
        var maxConf = Object.keys(res.snapped.confidence).reduce(function (m, k) {
          if (k === "grade") return m;
          return Math.max(m, res.snapped.confidence[k]);
        }, 0);
        ok(maxConf < 0.5, "no reader means no confident field", "highest confidence " + maxConf.toFixed(2));
        ok(res.snapped.unknown.length > 0, "no reader means fields come back unknown");
      } else {
        var tally = scoreOne(res, { n: 0, illegal: 0 });
        var fams = tally.fam || { hit: 0, n: 0 }, tiers = tally.tier || { hit: 0, n: 0 };
        console.log("    families " + fams.hit + "/" + fams.n +
          " · family+tier " + tiers.hit + "/" + tiers.n +
          " · grade " + (tally.grade ? tally.grade.hit + "/" + tally.grade.n : "-") +
          " · rolls " + (tally.rolls ? tally.rolls.hit + "/" + tally.rolls.n : "-") +
          " · locks " + (tally.locks ? tally.locks.hit + "/" + tally.locks.n : "-"));
        ok(tally.silentWrong === 0, "no wrong field was reported confidently",
          tally.silentWrong + " silent errors");
      }
    });

    // a wider sweep: 40 random bracelets, clean reader
    console.log("\n  sweep: 40 random bracelets, clean reader");
    var tally = { n: 0, illegal: 0 };
    var seq = Promise.resolve();
    for (var i = 0; i < 40; i++) {
      (function (n) {
        seq = seq.then(function () {
          return runOne({ seed: 100 + n }, { seed: 900 + n }).then(function (res) { scoreOne(res, tally); });
        });
      })(i);
    }
    return seq.then(function () {
      function pctOf(o) { return o ? (100 * o.hit / o.n).toFixed(0) + "%" : "-"; }
      console.log("    grade " + pctOf(tally.grade) + " · slots " + pctOf(tally.slots) +
        " · family " + pctOf(tally.fam) + " · family+tier " + pctOf(tally.tier) +
        " · whole set " + pctOf(tally.rowsExact) + " · locks " + pctOf(tally.locks) +
        " · rolls " + pctOf(tally.rolls));
      ok(tally.illegal === 0, "every one of the 40 produced a legal patch", tally.illegal + " illegal");
      ok(tally.silentWrong === 0, "no wrong field was reported confidently across the sweep",
        tally.silentWrong + " silent errors");
      ok(tally.fam.hit / tally.fam.n > 0.9, "families read above 90% on the fixture",
        pctOf(tally.fam));
    });
  });
}

// ------------------------------------------------------------------
// 2. constraintSnap against illegal states
// ------------------------------------------------------------------

function snapTests() {
  console.log("\n--- 2. constraintSnap, against states the solver would refuse ---");

  function check(name, raw, extra) {
    var out = OCR.constraintSnap(raw);
    var legal = OCR.isLegalPatch(out.patch);
    ok(legal.legal, name + " -> legal", legal.why.join("; "));
    if (extra) extra(out, legal);
    return out;
  }

  // a) a value that exists in no table
  check("a special-effect value found in no tier",
    { grade: "ancient", slots: 2,
      lines: [ { cat: "special", family: 33, values: [12345] },
        { cat: "special", family: 24, values: [3.5] } ],
      confidence: { lines: [ { family: 0.9, value: 0.9 }, { family: 0.9, value: 0.9 } ] } },
    function (out) {
      ok(out.confidence["rows.0.tier"] <= 0.45,
        "  ...and its tier is not reported confidently",
        "tier confidence " + out.confidence["rows.0.tier"]);
    });

  // b) a basic value outside every band
  check("a main-stat value far above every Ancient band",
    { grade: "ancient", slots: 2,
      lines: [ { cat: "basic", family: "mainStat", value: 99999 },
        { cat: "special", family: 24, values: [3.5] } ],
      confidence: { lines: [ { family: 0.9, value: 0.9 }, { family: 0.9, value: 0.9 } ] } },
    function (out) {
      var v = out.patch.rows[0].value;
      ok(v >= 9600 && v <= 16000, "  ...and it is pulled into the Ancient range", "value " + v);
      ok(out.confidence["rows.0.value"] <= 0.3, "  ...and the value is flagged",
        "confidence " + out.confidence["rows.0.value"]);
    });

  // c) the same family twice
  check("the same family read twice",
    { grade: "ancient", slots: 3,
      lines: [ { cat: "special", family: 33, values: [9000] },
        { cat: "special", family: 33, values: [9000] },
        { cat: "special", family: 24, values: [4.0] } ],
      confidence: { lines: [ { family: 0.9 }, { family: 0.4 }, { family: 0.9 } ] } },
    function (out) {
      var empties = out.patch.rows.filter(function (r) { return r.fam === "none"; }).length;
      ok(empties === 1, "  ...the weaker duplicate becomes an empty slot", empties + " empty slots");
    });

  // d) three combat traits
  check("three combat traits",
    { grade: "ancient",
      traits: [ { family: "crit", value: 110 }, { family: "spec", value: 100 }, { family: "swiftness", value: 90 } ],
      lines: [ { cat: "special", family: 33, values: [9000] }, { cat: "special", family: 24, values: [4.0] } ],
      confidence: { traits: [ { value: 0.9 }, { value: 0.9 }, { value: 0.9 } ], lines: [{}, {}] } },
    function (out) {
      var on = ["crit", "spec", "swift"].filter(function (k) { return out.patch.traits[k].on; });
      ok(on.length === 2, "  ...exactly two survive", on.join("+"));
    });

  // e) four granted lines on an Ancient (max 3)
  check("four granted lines on an Ancient bracelet",
    { grade: "ancient", slots: 4,
      lines: [ { cat: "special", family: 33, values: [9000] }, { cat: "special", family: 24, values: [4.0] },
        { cat: "special", family: 23, values: [3.0] }, { cat: "special", family: 31, values: [5.0] } ],
      confidence: { lines: [{}, {}, {}, {}] } },
    function (out) {
      ok(out.patch.slots === 3 && out.patch.rows.length === 3,
        "  ...cut to three, and said so", "slots " + out.patch.slots);
      ok(out.notes.join(" ").indexOf("went unread") >= 0 || out.notes.length > 0,
        "  ...with a note explaining the cut");
    });

  // f) zero granted lines on a Relic (min 1)
  check("no granted lines at all on a Relic",
    { grade: "relic", slots: 0, lines: [],
      traits: [ { family: "crit", value: 90 }, { family: "spec", value: 80 } ],
      confidence: { traits: [{ value: 0.9 }, { value: 0.9 }] } },
    function (out) {
      ok(out.patch.rows.length === 1, "  ...padded to one empty slot", out.patch.rows.length + " rows");
      ok(out.unknown.indexOf("rows.0.fam") >= 0, "  ...and the empty slot is unknown, not invented");
    });

  // g) a trait value above the Relic cap forces Ancient
  check("Crit 116 read as a Relic",
    { grade: "relic",
      traits: [ { family: "crit", value: 116 }, { family: "spec", value: 110 } ],
      lines: [ { cat: "special", family: 33, values: [9000] } ],
      confidence: { grade: 0.9, traits: [{ value: 0.9 }, { value: 0.9 }], lines: [{}] } },
    function (out) {
      ok(out.patch.grade === "ancient", "  ...the cap outranks the read grade", out.patch.grade);
      ok(out.confidence.grade <= 0.3, "  ...and the grade is flagged", "conf " + out.confidence.grade);
    });

  // h) a tier the grade's table does not carry
  check("Crit Damage 10% (Ancient-only) read as a Relic line",
    { grade: "relic",
      traits: [ { family: "crit", value: 90 }, { family: "spec", value: 80 } ],
      lines: [ { cat: "special", family: 32, values: [10.0] } ],
      confidence: { traits: [{ value: 0.9 }, { value: 0.9 }], lines: [{ family: 0.9, value: 0.9 }] } },
    function (out) {
      ok(out.patch.grade === "ancient", "  ...the value settles the grade", out.patch.grade);
    });

  // i) nonsense everywhere
  check("nothing readable at all",
    { grade: null, slots: null, rollsLeft: null, traits: [], lines: [], confidence: {} },
    function (out) {
      ok(out.unknown.length > 0, "  ...everything comes back unknown", out.unknown.join(", "));
      ok(out.confidence.grade === 0, "  ...with the grade at zero confidence");
    });

  // j) impossible roll counts
  check("11 rolls remaining",
    { grade: "ancient", slots: 2, rollsLeft: 11,
      traits: [ { family: "crit", value: 110 }, { family: "spec", value: 100 } ],
      lines: [ { cat: "special", family: 33, values: [9000] }, { cat: "special", family: 24, values: [4.0] } ],
      confidence: { rollsLeft: 0.9, traits: [{ value: 0.9 }, { value: 0.9 }], lines: [{}, {}] } },
    function (out) {
      ok(out.patch.rollsLeft === 7, "  ...clamped to seven", String(out.patch.rollsLeft));
      ok(out.confidence.rollsLeft <= 0.3, "  ...and flagged");
    });

  // k) a family the model does not know
  check("a family id that does not exist",
    { grade: "ancient", slots: 2,
      lines: [ { cat: "special", family: 999, values: [1] }, { cat: "special", family: 24, values: [4.0] } ],
      confidence: { lines: [{}, {}] } });

  // l) more basic lines than the cap allows
  check("three basic lines (cap is two)",
    { grade: "ancient", slots: 3,
      lines: [ { cat: "basic", family: "mainStat", value: 12000 },
        { cat: "basic", family: "vitality", value: 5000 },
        { cat: "basic", family: "mainStat", value: 13000 } ],
      confidence: { lines: [{ family: 0.9 }, { family: 0.9 }, { family: 0.5 }] } });

  // m) a combat trait the panel has no row for
  check("a Domination trait line",
    { grade: "ancient",
      traits: [ { family: "domination", value: 100 }, { family: "crit", value: 110 } ],
      lines: [ { cat: "special", family: 33, values: [9000] }, { cat: "special", family: 24, values: [4.0] } ],
      confidence: { traits: [{ value: 0.9 }, { value: 0.9 }], lines: [{}, {}] } },
    function (out) {
      ok(out.notes.join(" ").toLowerCase().indexOf("domination") >= 0,
        "  ...and the user is told it was left out", out.notes.join(" | "));
    });

  // n) an exhaustive crawl: every family, every tier, both grades, on its own
  console.log("\n  crawling every family x tier x grade through the snap");
  var bad = 0, checked = 0;
  ["relic", "ancient"].forEach(function (g) {
    DATA.SPECIALS.forEach(function (f) {
      DATA.TIERS.forEach(function (tier) {
        if (!f.values[g] || !f.values[g][tier]) return;
        checked++;
        var out = OCR.constraintSnap({
          grade: g, slots: g === "relic" ? 1 : 2,
          traits: [ { family: "crit", value: g === "relic" ? 90 : 110 },
            { family: "spec", value: g === "relic" ? 80 : 100 } ],
          lines: [ { cat: "special", family: f.id, values: f.values[g][tier] } ],
          confidence: { traits: [{ value: 0.9 }, { value: 0.9 }], lines: [{ family: 0.9, value: 0.9 }] }
        });
        var legal = OCR.isLegalPatch(out.patch);
        if (!legal.legal) { bad++; console.log("    " + g + " " + f.key + " " + tier + ": " + legal.why.join("; ")); }
        var row = out.patch.rows[0];
        if (row.fam !== "sp:" + f.id || row.tier !== tier) {
          bad++;
          console.log("    " + g + " " + f.key + " " + tier + " came back as " + row.fam + "/" + row.tier);
        }
      });
    });
  });
  ok(bad === 0, "every family x tier x grade (" + checked + ") snaps back to itself, legally", bad + " failures");
}

// ------------------------------------------------------------------

var run = Promise.resolve();
if (ONLY === "all" || ONLY === "pipeline") run = run.then(pipelineTests);
if (ONLY === "all" || ONLY === "snap") run = run.then(snapTests);
run.then(function () {
  console.log("\n" + pass + " checks passed, " + fail + " failed.");
  process.exit(fail ? 1 : 0);
}).catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(2);
});
