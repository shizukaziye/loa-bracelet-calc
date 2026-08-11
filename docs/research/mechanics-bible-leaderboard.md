# T4 bracelet mechanics, lostark.bible integration, leaderboard model

Research consolidated 2026-08-11 (four-agent sweep). Companion to
`official-probabilities.md` (which wins on any probability/value conflict).

## Rolling mechanics (T4)

- A bracelet has fixed lines (1–2, from the drop) and granted slots (Ancient 2–3,
  Relic 1–2). **4 rolls by default, up to 3 more via Bracelet Effect Reconversion
  Tickets** — confirmed by live data (`numRerolls: 4, numTicketRerolls: 3`).
  Since the 2026-07-14 patch, reconversion tickets sell in the Support Shop **for gold**
  (previously Kazeros-Brelshaza-gated). Exact silver costs per roll: never published;
  "increases with each attempt". Treat costs as user inputs.
- Each attempt rerolls all UNLOCKED granted lines as a set. **T4 lets you keep the old
  set or take the newly rolled set — whole set only** (individual lines can be locked
  before rolling, and locked lines persist). This keep-or-replace choice is the core of
  the DP: after each roll you hold max(old, new).
- Relic→Ancient upgrade bumps existing lines: basics +1000, combat traits +20, special
  effects +1 tier.
- Combat stat caps: Relic ~100 / Ancient ~120 — stated by maxroll for T3 only; live T4
  observations (max seen 115) are consistent. UNVERIFIED, flag in UI copy if shown.
- Modeling assumption for this tool (Shizu's spec): the bracelet already has the two
  desired combat traits (e.g. crit+spec) as fixed lines → trait cap full → granted pool
  renormalizes over basic (35) + special (30). NOTE basics stay in the pool (~53.85% per
  roll) until 2 basics are granted — they are the junk outcome, not excluded.

## Community benchmarks

Bracelet worth ~7–9% damage = good; ≥10% = near-final (namuwiki standard, T3 wording).
lostark.bible character pages display exactly this: "Bracelet Effects +7.43%" alongside
Accessory Effects / Gems. That per-source % is the natural leaderboard score.

## lostark.bible raw bracelet payload (decoded from character pages)

Character pages embed the full bracelet in the SvelteKit hydration blob:

```js
{id:213400033, slot:"bracelet", data:{ type:"bracelet",
  stats:[
    {type:2, index:15,    id:213400023, value:101,   fixed:true},   // Crit +101
    {type:2, index:18,    id:213400023, value:81,    fixed:true},   // Swift +81
    {type:3, index:11051, id:213400023, value:5,     fixed:false},  // family 15 Legendary
    {type:2, index:11,    id:213400023, value:13888, fixed:false},  // Int +13888
    {type:2, index:76,    id:213400023, value:840,   fixed:false}], // Crit Dmg +8.40%
  numRerolls:4, numTicketRerolls:3 }}
```

Decode rules (verified on 4 characters):
- `type:2` plain stat line; `value` raw; percentages in **hundredths of a %** (840 = 8.40%).
- `type:3` special effect implemented as stat: `index = 11000 + 10*(family−10) + grade`.
- `type:4` special effect implemented as ability: `index = 605100000 + 10*(family−10) + grade`.
- Grade digit: **1 = high (Legendary), 2 = mid (Epic), 3 = low (Heroic)**.
- `fixed: true` = locked/fixed line.
- `type:2` index map (partial): 11 Int · 15 Crit · 16 Spec · 18 Swift · 50 Additional
  Damage (centi-%) · 76 Crit Damage (centi-%). UNMAPPED: Str, Dex, Vitality, Domination,
  Endurance, Expertise, remaining plain-effect indices — map opportunistically from live
  payloads and keep an `unknown` passthrough.
- **MEASURED GAP (2026-08-11, `node tools/test-worker.mjs` over the 12 seeded characters):**
  indices **74**, **4** and **151** appear in the wild and `TYPE2_INDEX` maps none of them,
  so 5 of the 12 score low — index 74 alone costs about **4 percentage points** on three
  characters. The seed file decoded them with a local extension map that never shipped.
  Astrogem's accessory table reads 74 as Crit Rate % and 151 as flat Weapon Attack Power;
  4 is unidentified. Mapping these three (in `model/bracelet.js` AND the Python mirror,
  with a refs regeneration) is the highest-value single fix in this area.
- Family numbering matches maxroll's 1–33 and `official-probabilities.md`.

The astrogem worker (`loastuff/loa-astrogem-calc/worker/astrogem-bible.js`) already
fetches + parses these character pages with a sanctioned `BIBLE_TOKEN`; its
`parseAccessories()` covers neck/ears/rings only — a bracelet parser is new but follows
the same hydration-blob scanning pattern.

## OAuth (lostark.bible) — the sanctioned path

Raid-stats scraping is BANNED (memory: reference_lostark_bible_stats_api). Character
data flows through OAuth 2.0 Authorization Code + PKCE (S256 only), documented at
https://lostark.bible/help/oauth-api. Facts:

- Public client + PKCE, no secret, CORS-enabled for browsers. Discord login upstream.
- `GET /oauth/authorize` → `POST /oauth/token` (form-encoded). Code single-use, 10 min.
- Token `uwo_…`, Bearer, **90 days, NO refresh token**; re-auth silently auto-approves
  while the grant lives. Scope grants are cumulative.
- Scopes: `identify`, `rosters` (linked rosters + non-hidden characters), `logs`
  (`GET /api/oauth/logs/{name}?region=NA|CE`, region REQUIRED, `CE` = EU Central).
- **`/api/oauth/rosters` response shape is undocumented; whether it includes bracelet
  data is UNKNOWN — probe with a real token before designing around it.** Fallback:
  rosters → character names → worker fetches character pages (payload above).
- **One app per account.** The account's app is "Loseii Astrogem Calculator"
  (prod client `22zuv73nnkcgczoxitokvo2q6u`, dev `onwc5iva725mxhak2dxq3ikjti`).
  The bracelet tool must REUSE this app — add its prod URL to the prod client's
  redirect set. Redirect URIs match exactly, no wildcards.
- **Dev redirect whitelist is `http://localhost:8080/` ONLY** — dev server must run on
  port 8080 (`npx http-server -p 8080 -c-1 .`).
- Copy-ready client: `loastuff/loa-astrogem-calc/bible-oauth.js` (window.BibleOAuth;
  PKCE, state, scrubUrl, 401→forget, 1-day-early expiry). Worker-side session flow also
  exists in astrogem-bible.js (implemented, unadopted) if XSS-hardening is ever wanted.

## Leaderboard model

lostark.bible has NO Ark Grid leaderboard (their only board is raid DPS at
/leaderboards, fed by LOA Logs uploads, self-reported). The model to imitate is the
**astrogem calculator's own leaderboard** (`loa-astrogem-calc/leaderboard.js` +
worker docs `docs/how-the-leaderboard-ranks.md`). Its hard-won rules:

- KV only, no D1. Gzip snapshot (`lb:snapshot:gz`) — plain JSON hit 26.1MB at ~5k chars,
  just under KV's 25MiB cap; serve stored gzip bytes as-is with `encodeBody: "manual"`.
- Compact tuple format v2 (`?list=1&fmt=2`) ≈ 10× less JSON for the browser.
- Incremental dirty-gated rebuild: `lb:dirty:*` markers, `BUILTAT_KEY` throttle read
  first, 30-min min interval, cron drain.
- Rate limits in wrangler `[[ratelimits]]`: hard cap 60/min, lookup 2/10s, board 3/min,
  global gate 1000/min shared counter, enqueue 10/min.
- CORS allowlist (loseii origins + localhost regex), stamped once in fetch(); admin via
  `X-Admin-Token` + constant-time compare, fail-closed. Never gate anything with a
  client-shipped hash.
- Client: single fetch on first tab activation, cookie-persisted filters, two boards
  (dps/support), PAGE_SIZE 100, four distinct degradation messages.
- Wrangler footgun: CLI deploy replaces ALL bindings — declare every KV namespace in
  the toml, never dashboard-only.

Nice leaderboard UX from bible's raid board worth copying: every row shows value AND
gap-to-#1; patch-window filter keeps stale records visible under their own patch;
self-reported-data disclosure in the footer.

## Loseii house style (template = loa-astrogem-calc)

Plain static, no framework, no build, dark-only. Split: `index.html` shell (tabbar +
lazy `LAZY_TABS` loader + `?v=` cache-busting on EVERY script — mandatory, loseii edge
caches JS 4h) · `styles.css` (copy the `:root` token block) · pure `model/*.js` core on
a `window.X` global UI never mutates · one IIFE per tab with scoped styles ·
`tip.js` data-gloss tooltips · last two body lines:
`<script src="https://www.loseii.com/nav.js" defer></script>` +
`<script src="https://www.loseii.com/social-bar.js" defer></script>`;
sticky panels use `top:var(--loseii-nav-offset,0px)`. Verified-model pattern:
`model/*.js` + `model/*.py` mirror + `verify.js`/`refs.json` parity battery.
Hub add: nav.js GROUPS entry + hub card + "N live tools" pill bump.
Git identity per-repo: Shizukaziye / lxpi94@gmail.com.
