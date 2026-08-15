/**
 * solver-worker.js — the bracelet solver on a background thread.
 *
 * A three-slot, seven-roll solve enumerates ~48,000 states and takes ~3 s. On the
 * main thread that freezes the page on every keystroke, so every call to
 * Bracelet.solve() happens here instead.
 *
 * PROTOCOL (app.js drives it)
 *   in   { id, cmd:"solve",  payload:{grade, profile, fixedLines, grantedLines,
 *                                     traitValues, slots, rollsLeft,
 *                                     goldPer1Pct, baselinePct} }
 *   out  { id, ok:true, cmd:"solve", res:{...} }   // ctx STAYS here, see below
 *   in   { id, cmd:"advise", payload:{current, rolled, rollsLeft} }
 *   out  { id, ok:true, cmd:"advise", res:{verdict, delta, goldDelta, …} }
 *   out  { id, ok:false, error:"…" }               // any throw, reported not swallowed
 *
 * solve()'s `ctx` carries the whole DP (every layer, every state) — megabytes, and
 * full of typed maps that structured-clone would choke on. It never crosses the
 * wire: the worker keeps the last one and advise() answers keep-or-replace off it
 * in microseconds. app.js only has to solve the same state first, which it does.
 *
 * There is no cancel: a worker cannot interrupt its own running JS. app.js keeps
 * one request in flight and drops answers whose id is stale.
 */
"use strict";

/* global importScripts, Bracelet */
// THESE STAMPS MUST MATCH index.html's for the same files, or a returning
// browser runs one model on the page and an older one in here — the Advisor's
// verdicts quietly disagreeing with the Calculator's headline. It has happened:
// this worker sat two model versions behind the page for one commit.
// tools/check-cache-versions.mjs now cross-checks every stamped reference in
// every root script against index.html and fails the mismatch.
importScripts(
  "data/bracelet-data.js?v=2",
  "data/gear-data.js?v=4",
  "model/bracelet.js?v=12"
);

var lastCtx = null;
var lastCtxKey = null;

function solveCmd(p) {
  var r = Bracelet.solve({
    grade: p.grade,
    profile: p.profile,
    fixedLines: p.fixedLines || [],
    grantedLines: p.grantedLines || [],
    traitValues: p.traitValues || null,
    slots: p.slots,
    rollsLeft: p.rollsLeft,
    goldPer1Pct: p.goldPer1Pct,
    baselinePct: p.baselinePct
  });
  // Only ONE context is held, and it must be the bracelet the player is actually
  // cutting. The side solve that prices an unrolled bracelet passes keepCtx:false
  // so it cannot evict the one advise() needs.
  if (p.keepCtx !== false) {
    lastCtx = r.ctx;
    lastCtxKey = p.ctxKey || null;
  }

  // Everything except ctx, and the cdf trimmed to what the UI plots.
  return {
    grade: r.grade,
    slots: r.slots,
    unrolled: r.unrolled,
    currentScore: r.currentScore,
    fixedDamage: r.fixedDamage,
    traitDamage: r.traitDamage,
    expectedFinal: r.expectedFinal,
    gain: r.gain,
    valueGold: r.valueGold,
    bestLockMask: r.bestLockMask,
    maskEV: r.maskEV.slice(0, 12),
    maskCount: r.maskEV.length,
    evByRollsLeft: r.evByRollsLeft,
    pImprove: r.pImprove,
    finalScore: {
      mean: r.finalScore.mean,
      quantiles: r.finalScore.quantiles,
      cdf: thinCdf(r.finalScore.cdf)
    },
    ctxKey: p.ctxKey || null,
    stats: r.stats
  };
}

// The exact cdf can run to tens of thousands of points; the UI draws a strip and
// asks P(≥x) a handful of times. Keep at most ~400 rungs, each the cumulative
// probability at that score — quantiles are read off the full cdf before this.
function thinCdf(cdf) {
  var max = 400;
  if (cdf.length <= max) return cdf;
  var out = [], step = cdf.length / max;
  for (var i = 0; i < max; i++) {
    var j = Math.min(cdf.length - 1, Math.round(i * step));
    out.push(cdf[j]);
  }
  if (out[out.length - 1] !== cdf[cdf.length - 1]) out.push(cdf[cdf.length - 1]);
  return out;
}

function adviseCmd(p) {
  if (!lastCtx) throw new Error("no solved context yet");
  if (p.ctxKey && lastCtxKey && p.ctxKey !== lastCtxKey) throw new Error("context is stale");
  return Bracelet.advise(lastCtx, {
    current: p.current || [],
    rolled: p.rolled || [],
    rollsLeft: p.rollsLeft,
    locksUsed: p.locksUsed || []
  });
}

self.onmessage = function (e) {
  var msg = e.data || {};
  var out = { id: msg.id, cmd: msg.cmd };
  try {
    if (msg.cmd === "solve") out.res = solveCmd(msg.payload || {});
    else if (msg.cmd === "advise") out.res = adviseCmd(msg.payload || {});
    else throw new Error("unknown command " + msg.cmd);
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.error = (err && err.message) || String(err);
  }
  self.postMessage(out);
};
