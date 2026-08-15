/**
 * advisor-capture.js — screenshot intake for the Advisor tab.
 *
 * Three ways in, the same three the astrogem Advisor has:
 *   · drop a file on the zone
 *   · paste from the clipboard (Win+Shift+S, then Ctrl+V anywhere on the page)
 *   · "Read screen now" — share the game window once, then grab ONE frame per
 *     press. It never streams: a frame is taken on demand and the video element
 *     exists only to hold the stream.
 *
 * The parse runs in ocr/parse-worker.js so the page never freezes; if the worker
 * cannot start, the same code runs inline and says so.
 *
 * ============================ WHAT THE ADVISOR CALLS ============================
 *
 *   var cap = BraceletCapture.mount(hostElement, {
 *     onParsed: function (result) { … },   // result.patch is bible-import shaped
 *     onStatus: function (text, kind) { … },   // kind: "" | "working" | "err"
 *     threshold: 0.8,                      // below this a field is "needs a look"
 *     version: "1"                         // ?v= for the worker's own imports
 *   });
 *
 * result = { patch, confidence, unknown, notes, debug }
 *   patch       { grade, slots, traits, traitOrder, rows, fixedRows, lockedIdx, rollsLeft }
 *               — exactly what bible-import.js#buildPatch produces, so whatever
 *                 path the Advisor already uses for an imported character works
 *                 unchanged for a screenshot.
 *   confidence  { "<patch path>": 0..1 }, e.g. "rows.1.tier"
 *   unknown     paths the read could not settle at all
 *   notes       plain-English account of every repair the snap had to make
 *
 * The controller:
 *   cap.parseImage(fileOrBlobOrCanvas)   feed it a picture yourself
 *   cap.readScreenNow()                  grab + parse one frame (needs a share)
 *   cap.startShare() / cap.stopShare() / cap.isSharing()
 *   cap.applyFlags(rootEl)               mark every [data-conf-key] element in
 *                                        rootEl whose field needs a look
 *   cap.markConfirmed(path)              clear one flag (also happens on click)
 *   cap.unconfirmedCount() / cap.flags() / cap.clearFlags()
 *   cap.lastResult()
 *   cap.destroy()
 *
 * ========================== WHAT THE ADVISOR MUST DO ==========================
 *
 * Put data-conf-key="<patch path>" on each control it renders — "grade",
 * "slots", "rollsLeft", "traits.crit", "rows.0.fam", "rows.0.tier",
 * "rows.0.value", "rows.0.locked" — then call cap.applyFlags(pane) after every
 * re-render. A flagged control gets the class bc-unconfirmed (an amber pulse);
 * clicking or changing it clears the flag, and the strip's count drops.
 *
 * The strip reads "Parsed — 3 fields need a look; tap the highlighted ones to
 * confirm." A wrong value the user can see and fix is fine. A wrong value
 * presented as certain is not, and that is the whole reason this file exists.
 */
(function (root) {
  "use strict";

  var VERSION = "1";
  var TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  var OCR_FILES = ["engine.js", "layout.js", "lexicon.js", "text-reader.js", "tooltip-engine.js"];
  // The worker has no window, so it needs the tables too — engine.js and
  // lexicon.js both read them at parse time. The page already has them.
  var DATA_FILE = "data/bracelet-data.js";

  // ---------------- styles, injected once ----------------
  var STYLE_ID = "bc-capture-style";
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = [
      ".bc-cap{display:flex;flex-direction:column;gap:8px}",
      ".bc-drop{border:2px dashed var(--border);border-radius:10px;padding:14px 12px;text-align:center;",
      "  color:var(--dim);background:var(--panel2);font-size:12.5px;transition:border-color .15s,background .15s}",
      ".bc-drop.drag{border-color:var(--accent);background:rgba(102,199,255,.08);color:var(--text)}",
      ".bc-drop b{color:var(--text)}",
      ".bc-drop.has-img{padding:8px;cursor:pointer}",
      ".bc-drop.has-img .bc-hint{display:none}",
      ".bc-prev{display:none;width:100%;height:auto;max-height:420px;object-fit:contain;object-position:top;",
      "  background:#0b0e14;border-radius:8px;border:1px solid var(--border)}",
      ".bc-drop.has-img .bc-prev{display:block}",
      ".bc-drop.bc-min .bc-prev{max-height:56px;object-fit:cover}",
      ".bc-drop .bc-cap-note{display:none;font-size:11px;color:var(--dim);margin-top:6px}",
      ".bc-drop.has-img .bc-cap-note{display:block}",
      ".bc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".bc-status{font-size:12px;color:var(--dim);min-height:16px}",
      ".bc-status.working{color:var(--accent)}",
      ".bc-status.err{color:var(--bad)}",
      ".bc-strip{display:none;border:1px solid var(--high);border-radius:8px;background:rgba(255,184,107,.10);",
      "  color:var(--text);font-size:12.5px;line-height:1.5;padding:8px 12px}",
      ".bc-strip.on{display:block}",
      ".bc-strip b{color:var(--high)}",
      ".bc-strip.done{border-color:var(--good);background:rgba(110,231,168,.10)}",
      ".bc-strip.done b{color:var(--good)}",
      ".bc-notes{font-size:11.5px;color:var(--dim);margin:0;padding-left:16px}",
      ".bc-tip{border:1px solid var(--accent);border-radius:8px;background:rgba(102,199,255,.09);",
      "  color:var(--text);font-size:12.5px;line-height:1.5;padding:8px 12px}",
      ".bc-tip b{color:var(--accent)}",
      ".bc-btn{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:8px;",
      "  padding:7px 12px;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}",
      ".bc-btn:hover{border-color:var(--accent)}",
      ".bc-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".bc-btn.primary{background:var(--accent);border-color:var(--accent);color:#06121f}",
      ".bc-link{background:none;border:0;color:var(--accent);cursor:pointer;font-size:12px;",
      "  padding:0 2px;text-decoration:underline;font-family:inherit}",
      ".bc-unconfirmed{outline:2px solid var(--high);outline-offset:2px;border-radius:8px;",
      "  animation:bcPulse 1.6s ease-in-out infinite}",
      "@keyframes bcPulse{0%,100%{outline-color:rgba(255,184,107,.45)}50%{outline-color:rgba(255,184,107,1)}}",
      "@media (prefers-reduced-motion:reduce){.bc-unconfirmed{animation:none;outline-color:var(--high)}}"
    ].join("");
    document.head.appendChild(s);
  }

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---------------- the parse, in a worker when it can be ----------------

  function Parser(opts) {
    this.base = opts.base || "ocr/";
    this.dataUrl = opts.dataUrl || DATA_FILE;
    this.v = opts.version || VERSION;
    this.worker = null;
    this.ready = null;
    this.seq = 0;
    this.pending = {};
    this.inlineLoaded = false;
    this.mode = "unknown";
  }

  /**
   * The shared data file rides at THE PAGE'S OWN STAMP, read off its script tag,
   * so the OCR worker can never hold a staler copy of the family tables than the
   * page is using. Only the ocr/* stack versions on this module's VERSION. The
   * fallback matters solely in tests, where no script tag exists.
   */
  function pageStamp(path) {
    var tag = document.querySelector('script[src^="' + path + '"]');
    var m = tag && /[?&]v=(\d+)/.exec(tag.getAttribute("src") || "");
    return m ? m[1] : null;
  }

  Parser.prototype.urls = function () {
    var self = this;
    function abs(p, v) { return new URL(p + "?v=" + (v || self.v), location.href).href; }
    return [TESSERACT_URL, abs(self.dataUrl, pageStamp(self.dataUrl))]
      .concat(OCR_FILES.map(function (p) { return abs(self.base + p); }));
  };

  Parser.prototype.start = function () {
    if (this.ready) return this.ready;
    var self = this;
    this.ready = new Promise(function (resolve) {
      if (typeof Worker === "undefined") { self.mode = "inline"; return resolve("inline"); }
      var w;
      try { w = new Worker(self.base + "parse-worker.js?v=" + self.v); }
      catch (e) { self.mode = "inline"; return resolve("inline"); }
      var settled = false;
      var giveUp = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { w.terminate(); } catch (e) {}
        self.worker = null; self.mode = "inline"; resolve("inline");
      }, 20000);
      w.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === "ready") {
          if (settled) return;
          settled = true; clearTimeout(giveUp);
          self.worker = w; self.mode = "worker"; resolve("worker");
          return;
        }
        if (m.type === "init-error") {
          if (settled) return;
          settled = true; clearTimeout(giveUp);
          try { w.terminate(); } catch (e) {}
          self.worker = null; self.mode = "inline"; resolve("inline");
          return;
        }
        if (m.type === "result") {
          var p = self.pending[m.id];
          if (!p) return;
          delete self.pending[m.id];
          if (m.error) p.reject(new Error(m.error));
          else p.resolve(m.result);
        }
      };
      w.onerror = function () {
        if (settled) return;
        settled = true; clearTimeout(giveUp);
        self.worker = null; self.mode = "inline"; resolve("inline");
      };
      w.postMessage({ type: "init", urls: self.urls() });
    });
    return this.ready;
  };

  /** Load the inline stack (only when the worker path is unavailable). */
  Parser.prototype.loadInline = function () {
    if (this.inlineLoaded) return Promise.resolve();
    var self = this;
    var list = [TESSERACT_URL];
    if (!root.BraceletData) list.push(self.dataUrl + "?v=" + (pageStamp(self.dataUrl) || self.v));
    list = list.concat(OCR_FILES.map(function (p) { return self.base + p + "?v=" + self.v; }));
    var chain = Promise.resolve();
    list.forEach(function (src) {
      chain = chain.then(function () {
        // already on the page (a second mount, or the bench) — do not load twice
        if (src === TESSERACT_URL && typeof root.Tesseract !== "undefined") return null;
        if (src.indexOf("tooltip-engine.js") >= 0 && root.BraceletTooltipEngine) return null;
        return new Promise(function (res) {
          var s = document.createElement("script");
          s.src = src;
          s.onload = function () { res(); };
          s.onerror = function () { res(); };   // a blocked CDN degrades, never throws
          document.head.appendChild(s);
        });
      });
    });
    return chain.then(function () { self.inlineLoaded = true; });
  };

  Parser.prototype.parse = function (raster) {
    var self = this;
    return this.start().then(function (mode) {
      if (mode === "worker" && self.worker) {
        var id = ++self.seq;
        return new Promise(function (resolve, reject) {
          self.pending[id] = { resolve: resolve, reject: reject };
          var buf = raster.data.buffer.slice(0);
          self.worker.postMessage({ type: "parse", id: id, width: raster.width,
            height: raster.height, buf: buf }, [buf]);
        });
      }
      return self.loadInline().then(function () {
        var TE = root.BraceletTooltipEngine, OCR = root.BraceletOcr;
        if (!TE || !OCR) throw new Error("The reader could not load.");
        return TE.parseRaster(raster, {}).then(function (out) {
          var snapped = OCR.constraintSnap(out.raw);
          snapped.notes = (out.notes || []).concat(snapped.notes);
          snapped.debug = out.debug;
          if (out.status) snapped.status = out.status;
          return snapped;
        });
      });
    });
  };

  // ---------------- pictures in, rasters out ----------------

  function blobToRaster(input) {
    return new Promise(function (resolve, reject) {
      function fromBitmapSource(src) {
        createImageBitmap(src).then(function (bm) {
          var c = document.createElement("canvas");
          c.width = bm.width; c.height = bm.height;
          c.getContext("2d").drawImage(bm, 0, 0);
          try { bm.close(); } catch (e) {}
          resolve(canvasRaster(c));
        }).catch(reject);
      }
      function canvasRaster(c) {
        var d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
        return { width: d.width, height: d.height, data: d.data };
      }
      if (!input) return reject(new Error("Nothing to read."));
      if (input.tagName === "CANVAS") return resolve(canvasRaster(input));
      if (input.width && input.height && input.data) return resolve(input);
      if (typeof createImageBitmap === "function") return fromBitmapSource(input);
      var img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        resolve(canvasRaster(c));
      };
      img.onerror = function () { reject(new Error("That file is not a picture this browser can open.")); };
      img.src = URL.createObjectURL(input);
    });
  }

  // ---------------- the mounted controller ----------------

  function mount(host, opts) {
    opts = opts || {};
    injectStyle();
    var threshold = opts.threshold != null ? opts.threshold : 0.8;
    var parser = new Parser({ base: opts.base || "ocr/", dataUrl: opts.dataUrl || DATA_FILE,
      version: opts.version || VERSION });

    host.classList.add("bc-cap");
    host.innerHTML = "";
    var tip = el("div", { class: "bc-tip" },
      "💡 Open the bracelet's tooltip in game (hover it, or pin it) and capture the " +
      "<b>whole tooltip</b>. Screen share reads the live window; drop or paste works from " +
      "any screenshot tool.");
    var drop = el("div", { class: "bc-drop", id: "bc-drop" });
    drop.appendChild(el("span", { class: "bc-hint" },
      "<b>Drop or paste</b> a bracelet screenshot here, or press <b>Read screen now</b>."));
    var prev = el("img", { class: "bc-prev", alt: "screenshot preview" });
    drop.appendChild(prev);
    drop.appendChild(el("span", { class: "bc-cap-note" },
      "drop or paste another to replace · click to expand or shrink"));
    var bar = el("div", { class: "bc-row" });
    var shareBtn = el("button", { class: "bc-btn", type: "button" }, "🖥 Share game screen");
    var readBtn = el("button", { class: "bc-btn primary", type: "button", style: "display:none" }, "📷 Read screen now");
    var stopBtn = el("button", { class: "bc-link", type: "button", style: "display:none" }, "stop sharing");
    bar.appendChild(shareBtn); bar.appendChild(readBtn); bar.appendChild(stopBtn);
    var status = el("div", { class: "bc-status" });
    var strip = el("div", { class: "bc-strip" });
    var notes = el("ul", { class: "bc-notes", style: "display:none" });
    host.appendChild(tip); host.appendChild(drop); host.appendChild(bar);
    host.appendChild(status); host.appendChild(strip); host.appendChild(notes);

    var state = {
      result: null,
      flags: {},          // path -> 1 while it still needs a look
      stream: null,
      video: null,
      objectUrl: null,
      busy: false,
      destroyed: false
    };

    function setStatus(text, kind) {
      status.className = "bc-status" + (kind ? " " + kind : "");
      status.textContent = text || "";
      if (opts.onStatus) try { opts.onStatus(text, kind || ""); } catch (e) {}
    }

    function showPreview(blob) {
      try {
        var url = URL.createObjectURL(blob);
        if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = url;
        prev.src = url;
        drop.classList.add("has-img");
        drop.classList.add("bc-min");
      } catch (e) {}
    }

    // ---- the confidence strip ----
    function renderStrip() {
      var n = Object.keys(state.flags).length;
      if (!state.result) { strip.className = "bc-strip"; strip.innerHTML = ""; return; }
      strip.className = "bc-strip on" + (n ? "" : " done");
      if (n) {
        strip.innerHTML = "<b>Parsed</b> — " + n + " field" + (n === 1 ? "" : "s") +
          " need" + (n === 1 ? "s" : "") + " a look; tap the highlighted ones to confirm.";
      } else {
        strip.innerHTML = "<b>Parsed</b> — every field read clearly. Check anything that looks wrong before you ask for advice.";
      }
    }

    function renderNotes(list) {
      if (!list || !list.length) { notes.style.display = "none"; notes.innerHTML = ""; return; }
      notes.style.display = "";
      notes.innerHTML = list.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("");
    }

    function flagsFrom(result) {
      var f = {}, c = result.confidence || {};
      Object.keys(c).forEach(function (k) { if (c[k] < threshold) f[k] = 1; });
      (result.unknown || []).forEach(function (k) { f[k] = 1; });
      return f;
    }

    /** Mark every control in root whose field still needs a look. */
    function applyFlags(rootEl) {
      var scope = rootEl || document;
      var nodes = scope.querySelectorAll ? scope.querySelectorAll("[data-conf-key]") : [];
      for (var i = 0; i < nodes.length; i++) {
        var key = nodes[i].getAttribute("data-conf-key");
        nodes[i].classList.toggle("bc-unconfirmed", !!state.flags[key]);
      }
      renderStrip();
    }

    function markConfirmed(key) {
      if (!key) return;
      var touched = false;
      // A parent key clears its children: confirming "rows.0" settles the whole row.
      Object.keys(state.flags).forEach(function (k) {
        if (k === key || k.indexOf(key + ".") === 0) { delete state.flags[k]; touched = true; }
      });
      if (touched) {
        applyFlags(document);
        if (opts.onFlagsChanged) try { opts.onFlagsChanged(Object.keys(state.flags).length); } catch (e) {}
      }
    }

    // Touching a flagged control is what confirms it. One delegated listener,
    // captured at the document, so it works whatever the Advisor re-renders.
    function onTouch(ev) {
      var t = ev.target;
      while (t && t !== document) {
        if (t.getAttribute && t.getAttribute("data-conf-key")) {
          markConfirmed(t.getAttribute("data-conf-key"));
          return;
        }
        t = t.parentNode;
      }
    }
    document.addEventListener("click", onTouch, true);
    document.addEventListener("change", onTouch, true);

    // ---- parsing ----
    function setBusy(b) {
      state.busy = b;
      readBtn.disabled = b;
      shareBtn.disabled = b;
    }

    function parseImage(input, label) {
      if (state.busy) return Promise.resolve(null);
      setBusy(true);
      setStatus("Reading the screenshot…", "working");
      return blobToRaster(input).then(function (raster) {
        return parser.parse(raster);
      }).then(function (result) {
        if (state.destroyed) return null;
        state.result = result;
        state.flags = flagsFrom(result);
        var n = Object.keys(state.flags).length;
        setStatus(result.status ? result.status
          : ("Read " + (label || "the screenshot") + " in " + (result.ms || result.debug && result.debug.ms || 0) +
             " ms" + (parser.mode === "inline" ? " (on the page's own thread — the background reader would not start)" : "") + "."),
          result.status ? "err" : "");
        renderNotes(result.notes);
        applyFlags(document);
        if (opts.onParsed) try { opts.onParsed(result); } catch (e) {}
        if (opts.onFlagsChanged) try { opts.onFlagsChanged(n); } catch (e) {}
        return result;
      }).catch(function (e) {
        if (!state.destroyed) setStatus("Could not read that: " + (e && e.message || e), "err");
        return null;
      }).then(function (r) {
        setBusy(false);
        return r;
      });
    }

    function onFile(file) {
      if (!file) return;
      if (!/^image\//.test(file.type || "")) { setStatus("That is not a picture.", "err"); return; }
      showPreview(file);
      parseImage(file, "the screenshot");
    }

    // ---- drop / paste ----
    function onDragOver(e) { e.preventDefault(); drop.classList.add("drag"); }
    function onDragLeave() { drop.classList.remove("drag"); }
    function onDrop(e) {
      e.preventDefault();
      drop.classList.remove("drag");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      onFile(f);
    }
    drop.addEventListener("dragover", onDragOver);
    drop.addEventListener("dragleave", onDragLeave);
    drop.addEventListener("drop", onDrop);
    drop.addEventListener("click", function () {
      if (drop.classList.contains("has-img")) drop.classList.toggle("bc-min");
    });

    function onPaste(e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image") === 0) {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); onFile(f); return; }
        }
      }
    }
    document.addEventListener("paste", onPaste);

    // ---- screen share ----
    // getDisplayMedia needs a real click and a secure context. Where it is not
    // available the button says why instead of failing silently.
    function shareSupported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    }
    function secureEnough() {
      return root.isSecureContext !== false;
    }
    function renderShareBar() {
      if (!shareSupported() || !secureEnough()) {
        shareBtn.disabled = true;
        shareBtn.title = !secureEnough()
          ? "Reading the screen needs a secure page (https, or localhost while developing)."
          : "This browser cannot share a screen. Drop or paste a screenshot instead.";
        shareBtn.textContent = "🖥 Screen share unavailable";
        return;
      }
      shareBtn.style.display = state.stream ? "none" : "";
      readBtn.style.display = state.stream ? "" : "none";
      stopBtn.style.display = state.stream ? "" : "none";
    }
    function startShare() {
      if (!shareSupported() || !secureEnough()) {
        setStatus(!secureEnough()
          ? "Reading the screen needs a secure page — open the site over https, or localhost while developing. Drop or paste a screenshot instead."
          : "This browser cannot share a screen. Drop or paste a screenshot instead.", "err");
        return Promise.resolve(false);
      }
      return navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 2, max: 5 } },
        audio: false
      }).then(function (stream) {
        state.stream = stream;
        var v = document.createElement("video");
        v.muted = true;
        v.srcObject = stream;
        state.video = v;
        var track = stream.getVideoTracks()[0];
        if (track) track.addEventListener("ended", stopShare);
        v.addEventListener("loadeddata", function () {
          renderShareBar();
          readScreenNow();          // the picker click IS the first read
        }, { once: true });
        return v.play().then(function () { return true; });
      }).catch(function (err) {
        var name = (err && err.name) || "";
        setStatus(name === "NotAllowedError"
          ? "Screen share was cancelled."
          : "Screen share failed: " + ((err && err.message) || err), "err");
        stopShare();
        return false;
      });
    }
    function stopShare() {
      if (state.stream) {
        state.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      }
      state.stream = null; state.video = null;
      renderShareBar();
    }
    /** One frame, on demand. Nothing is grabbed between presses. */
    function readScreenNow() {
      if (!state.stream || !state.video || !state.video.videoWidth) {
        setStatus("No frame from the shared screen yet — press again in a moment.", "err");
        return Promise.resolve(null);
      }
      var c = document.createElement("canvas");
      c.width = state.video.videoWidth;
      c.height = state.video.videoHeight;
      c.getContext("2d").drawImage(state.video, 0, 0);
      try { c.toBlob(function (b) { if (b) showPreview(b); }, "image/png"); } catch (e) {}
      return parseImage(c, "the shared screen");
    }

    shareBtn.addEventListener("click", startShare);
    readBtn.addEventListener("click", readScreenNow);
    stopBtn.addEventListener("click", stopShare);
    renderShareBar();
    parser.start();   // warm the worker while the user is still reading the page

    return {
      parseImage: parseImage,
      readScreenNow: readScreenNow,
      startShare: startShare,
      stopShare: stopShare,
      isSharing: function () { return !!state.stream; },
      applyFlags: applyFlags,
      markConfirmed: markConfirmed,
      clearFlags: function () { state.flags = {}; applyFlags(document); },
      flags: function () { return Object.keys(state.flags); },
      unconfirmedCount: function () { return Object.keys(state.flags).length; },
      lastResult: function () { return state.result; },
      setStatus: setStatus,
      parserMode: function () { return parser.mode; },
      destroy: function () {
        state.destroyed = true;
        stopShare();
        document.removeEventListener("paste", onPaste);
        document.removeEventListener("click", onTouch, true);
        document.removeEventListener("change", onTouch, true);
        if (state.objectUrl) { try { URL.revokeObjectURL(state.objectUrl); } catch (e) {} }
        host.innerHTML = "";
      }
    };
  }

  root.BraceletCapture = { mount: mount, VERSION: VERSION, TESSERACT_URL: TESSERACT_URL };
})(typeof globalThis !== "undefined" ? globalThis : this);
