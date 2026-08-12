/**
 * advisor-glue.js — joins the screenshot reader to the Advisor tab.
 *
 * The two halves were built to different seams and neither is wrong:
 *
 *   advisor.js         waits to be told about a reader —
 *                      BraceletAdvisor.registerCapture({onFiles, onPaste, readScreen})
 *                      and hands a bracelet over through applyParsed(patch, conf).
 *   advisor-capture.js is a self-contained controller —
 *                      BraceletCapture.mount(hostEl, {onParsed, onStatus}).
 *
 * Rather than rewrite either, this adapts one to the other. It is the whole
 * integration: no parsing, no UI, no state.
 *
 * Load order does not matter. Both modules are lazy, so whichever arrives second
 * finds the first already sitting on window; if the reader never arrives, the
 * Advisor keeps its own "not wired yet" message and nothing throws.
 */
(function () {
  "use strict";

  var joined = false;

  function join() {
    if (joined) return true;
    var A = window.BraceletAdvisor, C = window.BraceletCapture;
    if (!A || !C || typeof A.registerCapture !== "function" || typeof C.mount !== "function") return false;

    // The capture module wants a host element to own. The Advisor's intake zone
    // already has one, so mount into it and let the reader draw its own buttons
    // inside the Advisor's frame.
    var host = document.getElementById("av-readbtns") || document.getElementById("av-drop");
    if (!host) return false;

    var ctl = C.mount(host, {
      threshold: 0.8,
      version: "1",
      onStatus: function (text, kind) { A.setStatus(text, kind); },
      onParsed: function (result) {
        if (!result || !result.patch) { A.setStatus("Nothing readable in that image.", "err"); return; }
        var out = A.applyParsed(result.patch, result.confidence || {});
        if (out && out.ok === false) { A.setStatus(out.error || "That parse could not be applied.", "err"); return; }
        var n = out && out.unconfirmed ? out.unconfirmed : 0;
        A.setStatus(n ? ("Read — " + n + " field" + (n === 1 ? "" : "s") + " need a look.") : "Read.", n ? "" : "ok");
      }
    });
    if (!ctl) return false;

    A.registerCapture({
      onFiles: function (files) { return ctl.parseImage(files && files[0]); },
      onPaste: function (blob) { return ctl.parseImage(blob); },
      // Omitted when the browser cannot share a screen, so the Advisor hides the
      // button instead of offering something that will fail.
      readScreen: (typeof ctl.readScreenNow === "function" && navigator.mediaDevices &&
                   navigator.mediaDevices.getDisplayMedia)
        ? function () { return ctl.readScreenNow(); }
        : null
    });

    joined = true;
    return true;
  }

  // Both tabs load lazily and in either order, so try now and again on the tab
  // that owns them; a handful of cheap attempts beats a polling timer.
  if (!join()) {
    document.addEventListener("tabselected", function (e) {
      if (e && e.detail && e.detail.tab === "advisor") join();
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", join);
  }

  window.BraceletAdvisorGlue = { join: join, joined: function () { return joined; } };
})();
