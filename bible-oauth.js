/**
 * bible-oauth.js — "Sign in with lostark.bible" (OAuth 2.0 Authorization Code + PKCE).
 *
 * Ported from loa-astrogem-calc/bible-oauth.js, which has shipped since 2026-07.
 * Same flow, same client, different storage keys and a smaller scope set.
 *
 * lostark.bible asked us to stop pulling their pages, so character data comes
 * through their opt-in OAuth flow (https://lostark.bible/help/oauth-api): a user
 * signs in and grants US read access to THEIR OWN linked rosters. We never see
 * anyone else's characters, and the raid statistics endpoints stay untouched.
 *
 * PUBLIC client: no secret lives here (a static site has nowhere to hide one), so
 * PKCE carries the whole flow. The token is opaque, valid 90 days, and holds only
 * the scopes below. There is NO refresh token — when it dies we send the user back
 * through /oauth/authorize, which auto-approves while the grant is still alive.
 *
 * Browser-only. Attaches window.BibleOAuth:
 *   configured()            -> bool (CLIENT_ID filled in?)
 *   signedIn()              -> bool
 *   login(scopes?)          -> redirects to the consent screen (never returns)
 *   handleRedirect()        -> Promise<{ok, error?}|null>  — call once at load
 *   logout()                -> Promise (revokes the token, then forgets it)
 *   user() / rosters()      -> Promise<json> (throws {status} on failure)
 *   accessToken()           -> raw token, for handing to OUR OWN Worker
 *   scrubUrl()              -> drop code/state from the address bar
 *   onChange(fn)            -> subscribe to sign-in/sign-out
 */
(function (root) {
  "use strict";

  // lostark.bible allows ONE APP PER ACCOUNT, so this tool reuses the app already
  // registered as "Loseii Astrogem Calculator" (2026-07-22). Both clients are
  // PUBLIC — no secret — and each carries its own exact redirect-URI list (no
  // wildcards, trailing slash included):
  //   prod  https://shizukaziye.github.io/loa-bracelet-calc/  (+ the astrogem URLs)
  //   dev   http://localhost:8080/   (the port `npm run serve` uses)
  // Running off localhost picks the dev client, so testing never touches the
  // production grant.
  var CLIENT_PROD = "22zuv73nnkcgczoxitokvo2q6u";
  var CLIENT_DEV = "onwc5iva725mxhak2dxq3ikjti";
  var CLIENT_ID = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? CLIENT_DEV : CLIENT_PROD;

  var BASE = "https://lostark.bible";
  // `logs` is deliberately absent: it exists to carry combatPower, which the
  // bracelet model never reads. Ask for the least the tool can work with.
  var SCOPES = "identify rosters";
  var STORE_KEY = "bc_bible_oauth";   // localStorage: the token
  var PEND_KEY = "bc_bible_pkce";     // sessionStorage: verifier + state, one round trip

  var listeners = [];
  function emit() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  // The redirect URI must match a registered one EXACTLY, so derive it from the
  // page we are on (origin + path, no query/hash) rather than hardcoding one that
  // breaks on localhost.
  function redirectUri() {
    return location.origin + location.pathname;
  }

  // ---- token storage ----
  function read() {
    var t = null;
    try { t = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) {}
    if (!t || !t.access_token) return null;
    if (t.expires_at && Date.now() >= t.expires_at) { forget(); return null; }
    return t;
  }
  function write(tok) {
    var rec = {
      access_token: tok.access_token,
      scope: tok.scope || SCOPES,
      // Expire a day early so we re-authorize before a call fails mid-flow.
      expires_at: Date.now() + Math.max(0, (tok.expires_in || 0) - 86400) * 1000
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(rec)); } catch (e) {}
    emit();
  }
  function forget() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    emit();
  }

  // ---- PKCE ----
  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomString(bytes) {
    var a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return b64url(a);
  }
  function challenge(verifier) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
      .then(function (buf) { return b64url(new Uint8Array(buf)); });
  }

  // ---- step 1: send the user to the consent screen ----
  function login(scopes) {
    if (!CLIENT_ID) throw new Error("bible-oauth.js: CLIENT_ID is empty — register the app first.");
    var verifier = randomString(64);
    var state = randomString(16);
    return challenge(verifier).then(function (chal) {
      sessionStorage.setItem(PEND_KEY, JSON.stringify({ v: verifier, s: state, r: redirectUri() }));
      var q = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri(),
        response_type: "code",
        scope: scopes || SCOPES,
        state: state,
        code_challenge: chal,
        code_challenge_method: "S256"
      });
      location.href = BASE + "/oauth/authorize?" + q.toString();
    });
  }

  // ---- step 2: swap the code for a token ----
  // Returns null when this load isn't a redirect back from the consent screen.
  function handleRedirect() {
    var qs = new URLSearchParams(location.search);
    var code = qs.get("code");
    var err = qs.get("error");
    if (!code && !err) return Promise.resolve(null);

    var pend = null;
    try { pend = JSON.parse(sessionStorage.getItem(PEND_KEY) || "null"); } catch (e) {}
    sessionStorage.removeItem(PEND_KEY);
    scrubUrl();

    if (err) return Promise.resolve({ ok: false, error: err });
    // A code arriving without our stashed state is either a stale tab or a forged callback.
    if (!pend || !pend.v || pend.s !== qs.get("state")) {
      return Promise.resolve({ ok: false, error: "state_mismatch" });
    }

    var body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: pend.r,
      client_id: CLIENT_ID,
      code_verifier: pend.v
    });
    return fetch(BASE + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }).then(function (r) {
      return r.json().then(function (j) { return { r: r, j: j }; });
    }).then(function (o) {
      if (!o.r.ok || !o.j.access_token) return { ok: false, error: o.j.error || ("http_" + o.r.status) };
      write(o.j);
      return { ok: true };
    }).catch(function (e) {
      return { ok: false, error: String((e && e.message) || e) };
    });
  }

  // Drop code/state/error from the address bar so a reload can't replay a spent code.
  function scrubUrl() {
    var qs = new URLSearchParams(location.search);
    ["code", "state", "error", "error_description"].forEach(function (k) { qs.delete(k); });
    var rest = qs.toString();
    try {
      history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    } catch (e) {}
  }

  // ---- step 3: call the API ----
  function api(path) {
    var tok = read();
    if (!tok) return Promise.reject({ status: 401, error: "not_signed_in" });
    return fetch(BASE + path, { headers: { Authorization: "Bearer " + tok.access_token } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok) return j;
          // 401 means the token is dead (expired, revoked, or the app was disabled)
          // — drop it so the UI falls back to the signed-out state instead of
          // retrying forever.
          if (r.status === 401) forget();
          throw { status: r.status, error: j.error || ("http_" + r.status), description: j.error_description };
        });
      });
  }

  function logout() {
    var tok = read();
    forget();
    if (!tok) return Promise.resolve();
    return fetch(BASE + "/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tok.access_token, client_id: CLIENT_ID }).toString()
    }).catch(function () { /* revoke is best-effort; we've already forgotten it locally */ });
  }

  root.BibleOAuth = {
    configured: function () { return !!CLIENT_ID; },
    signedIn: function () { return !!read(); },
    scopes: function () { var t = read(); return t ? t.scope : ""; },
    expiresAt: function () { var t = read(); return t ? t.expires_at : 0; },
    login: login,
    logout: logout,
    handleRedirect: handleRedirect,
    scrubUrl: scrubUrl,
    // Raw access token, for handing to OUR OWN Worker (the bracelet fallback
    // fetch). Only same-origin app code calls this; the token still never goes
    // to any third party.
    accessToken: function () { var t = read(); return t ? t.access_token : ""; },
    user: function () { return api("/api/oauth/user"); },
    rosters: function () { return api("/api/oauth/rosters"); },
    api: api,
    onChange: function (fn) { listeners.push(fn); }
  };
})(window);
