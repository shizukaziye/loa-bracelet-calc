/**
 * ocr/text-reader.js — the one place text comes from, behind one interface.
 *
 * A reader is any object exposing:
 *
 *   read(raster, opts) -> Promise<{ text, conf, words:[{text, conf}] }>
 *   isAvailable() -> boolean
 *   name
 *
 * `conf` is 0..1 and must come from the reader's own view of the pixels. When a
 * reader cannot say how sure it is, it reports a LOW number, never a high one.
 *
 * Two readers ship:
 *   · tesseract — the real one, used in the browser and inside the parse worker.
 *     It lazily boots one Tesseract worker, serialises calls through it, and
 *     heals itself: a worker that dies is dropped and the next call re-boots it.
 *     If Tesseract is missing or blocked, the reader is simply unavailable and
 *     the engine degrades honestly (every text-derived field capped and flagged)
 *     instead of guessing.
 *   · null — always available, reads nothing, reports confidence 0. It exists so
 *     the structural half of the parser can be exercised on its own, and so a
 *     blocked CDN produces a flagged parse rather than an exception.
 *
 * Tests inject their own reader with setReader().
 */
(function (root) {
  "use strict";

  var isNode = (typeof module !== "undefined" && module.exports);

  // ------------------------------------------------------------------
  // the null reader
  // ------------------------------------------------------------------

  var nullReader = {
    name: "none",
    isAvailable: function () { return true; },
    read: function () { return Promise.resolve({ text: "", conf: 0, words: [] }); }
  };

  // ------------------------------------------------------------------
  // Tesseract
  // ------------------------------------------------------------------

  function tesseractGlobal() {
    return (typeof Tesseract !== "undefined") ? Tesseract
      : (root.Tesseract || (typeof self !== "undefined" ? self.Tesseract : null));
  }

  var _worker = null, _tail = Promise.resolve(), _lastParams = "";

  function bootWorker() {
    var T = tesseractGlobal();
    if (!T) return Promise.reject(new Error("Tesseract is not loaded."));
    if (_worker) return _worker;
    // Two worlds, one boot. Tesseract 4/5 take the language in createWorker and
    // are ready when it resolves; 2/3 need load -> loadLanguage -> initialize.
    // In 5 those three still EXIST but do nothing and return undefined, which is
    // why every step is wrapped rather than chained on its return value — the
    // unwrapped version failed with "Cannot read properties of undefined".
    _worker = Promise.resolve()
      .then(function () {
        if (!T.createWorker) throw new Error("Tesseract has no createWorker.");
        return Promise.resolve(T.createWorker("eng"))
          .catch(function () { return T.createWorker(); });
      })
      .then(function (worker) {
        if (!worker) throw new Error("Tesseract gave no worker.");
        function step(fn, arg) {
          try { return Promise.resolve(typeof fn === "function" ? fn.call(worker, arg) : null); }
          catch (e) { return Promise.resolve(null); }
        }
        return step(worker.load)
          .then(function () { return step(worker.loadLanguage, "eng"); })
          .then(function () { return step(worker.initialize, "eng"); })
          .catch(function () { return null; })          // deprecated no-ops must not kill the boot
          .then(function () { return worker; });
      })
      .catch(function (e) { _worker = null; throw e; });
    return _worker;
  }

  /**
   * Anything Tesseract will take. A bare {width,height,data} raster is NOT one
   * of those things — v5 answers "Error attempting to read image" — so it is
   * painted onto a canvas first (an OffscreenCanvas inside a worker).
   */
  function toImageLike(raster) {
    if (!raster || !raster.data || !raster.width) return raster;
    var data = (raster.data instanceof Uint8ClampedArray) ? raster.data : new Uint8ClampedArray(raster.data);
    var img = null;
    if (typeof ImageData !== "undefined") {
      try { img = new ImageData(data, raster.width, raster.height); } catch (e) { img = null; }
    }
    var cv = null;
    try {
      if (typeof OffscreenCanvas !== "undefined") cv = new OffscreenCanvas(raster.width, raster.height);
      else if (typeof document !== "undefined") {
        cv = document.createElement("canvas");
        cv.width = raster.width; cv.height = raster.height;
      }
    } catch (e2) { cv = null; }
    if (cv && img) {
      try { cv.getContext("2d").putImageData(img, 0, 0); return cv; } catch (e3) {}
    }
    return img || raster;
  }

  var tesseractReader = {
    name: "tesseract",
    isAvailable: function () { return !!tesseractGlobal(); },
    read: function (raster, opts) {
      opts = opts || {};
      var params = {
        tessedit_pageseg_mode: opts.psm || "7",              // one text line
        preserve_interword_spaces: "1"
      };
      if (opts.whitelist) params.tessedit_char_whitelist = opts.whitelist;
      var key = JSON.stringify(params);
      var job = _tail.then(function () {
        return bootWorker().then(function (w) {
          var p = (key === _lastParams || !w.setParameters)
            ? Promise.resolve()
            : Promise.resolve(w.setParameters(params)).then(function () { _lastParams = key; });
          return p.then(function () { return w.recognize(toImageLike(raster)); });
        });
      }).then(function (res) {
        var d = (res && res.data) || {};
        var words = (d.words || []).map(function (w) {
          return { text: w.text, conf: (w.confidence || 0) / 100 };
        });
        // Tesseract's own per-word confidence is the honest number here. The
        // line confidence is the WEAKEST word, not the mean: one unreadable word
        // in a bracelet line is usually the number, and the number is the field
        // that matters.
        var conf = words.length
          ? words.reduce(function (m, w) { return Math.min(m, w.conf); }, 1)
          : ((d.confidence || 0) / 100);
        return { text: (d.text || "").replace(/\s+/g, " ").trim(), conf: conf, words: words };
      }).catch(function (e) {
        // a dead worker must not poison every later call
        _worker = null; _lastParams = "";
        return { text: "", conf: 0, words: [], error: String(e && e.message || e) };
      });
      _tail = job.catch(function () {});
      return job;
    },
    terminate: function () {
      var w = _worker;
      _worker = null; _lastParams = "";
      if (!w) return Promise.resolve();
      return Promise.resolve(w).then(function (worker) {
        try { return worker.terminate(); } catch (e) { return null; }
      }).catch(function () {});
    }
  };

  // ------------------------------------------------------------------
  // selection
  // ------------------------------------------------------------------

  var _override = null;
  function setReader(r) { _override = r; }
  function getReader() {
    if (_override) return _override;
    if (tesseractReader.isAvailable()) return tesseractReader;
    return nullReader;
  }

  var API = {
    setReader: setReader, getReader: getReader,
    tesseractReader: tesseractReader, nullReader: nullReader
  };

  if (isNode) module.exports = API;
  else root.BraceletTextReader = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
