/**
 * ocr/parse-worker.js — the parse, off the main thread.
 *
 * Panel-finding, row profiling and OCR are tight pixel loops and seconds of
 * work; on the main thread they freeze the whole site. This classic Web Worker
 * loads the same stack and runs it here, on a transferred RGBA buffer.
 *
 * Protocol (advisor-capture.js is the only client):
 *   -> { type:"init", urls:[…] }        importScripts the stack; the client
 *                                       sends its own cache-busted URLs so the
 *                                       worker and the page never version-skew
 *   <- { type:"ready" } | { type:"init-error", error }
 *   -> { type:"parse", id, width, height, buf }     buf: transferred RGBA
 *   <- { type:"result", id, result } | { type:"result", id, error }
 *
 * Any failure here disables the offload on the client side and the parse falls
 * back to the inline path — same behaviour, just blocking.
 */
"use strict";

self.onmessage = function (ev) {
  var msg = ev.data || {};

  if (msg.type === "init") {
    try {
      importScripts.apply(null, msg.urls || []);
      self.postMessage({ type: "ready", hasTesseract: typeof self.Tesseract !== "undefined" });
    } catch (e) {
      self.postMessage({ type: "init-error", error: String((e && e.message) || e) });
    }
    return;
  }

  if (msg.type === "parse") {
    var raster = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buf) };
    var TE = self.BraceletTooltipEngine;
    var OCR = self.BraceletOcr;
    if (!TE || !OCR) {
      self.postMessage({ type: "result", id: msg.id, error: "The parser did not load in the worker." });
      return;
    }
    Promise.resolve()
      .then(function () { return TE.parseRaster(raster, msg.opts || {}); })
      .then(function (out) {
        var snapped = OCR.constraintSnap(out.raw);
        snapped.notes = (out.notes || []).concat(snapped.notes);
        snapped.debug = out.debug;
        if (out.status) snapped.status = out.status;
        self.postMessage({ type: "result", id: msg.id, result: snapped });
      })
      .catch(function (e) {
        self.postMessage({ type: "result", id: msg.id, error: String((e && e.message) || e) });
      });
  }
};
