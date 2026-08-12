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
- Combat stat caps: Relic 100 / Ancient 120 — stated by maxroll for T3 only, but every T4
  observation agrees: across 63 bracelets on 30 character pages the highest combat trait
  seen is **119** and **none exceeds 120**. Still not officially published, so flag it in
  UI copy if shown — but it is now load-bearing, because the cap is what
  `decodeWithGradeCheck` uses to tell Relic from Ancient (see Loadouts, below).
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

## Loadouts — one character, several brackets (2026-08-11, 30 saved pages)

The single biggest source of wrong numbers so far, and it has nothing to do with
the decode. **A character page carries one LOADOUT per lostark.bible tab, each
with its own `items` array — so each can hold a different bracelet.**

```js
{type:"data", data:{ loadouts:[
  { classification:"most_recent_raid", lastUpdated:1786337374000, itemLevel:1791.6661,
    items:[ …, {slot:"bracelet", data:{type:"bracelet", stats:[…]}} ], … },
  { classification:"raid_merged",              … },
  { classification:"most_recent_chaos_dungeon", … } ] }}
```

Classifications seen, with the button label bible prints for each. **Treat the
list as open** — read whatever `classification` strings turn up rather than
matching a fixed set.

| `classification` | bible's button | pages carrying it (of 30) |
|---|---|---|
| `most_recent_raid` | "Raid Loadout" | 30 |
| `most_recent_chaos_dungeon` | "Current Loadout (Chaos Dungeon)" | 27 |
| `raid_merged` | "Estimated Raid Loadout" | 2 (Bean, Venoms) |

An empty bracelet slot appears as `data: void 0`, not as a missing entry.

**How much it matters. 9 of the 30 characters carry a different bracelet payload
across their loadouts** (Bean, Kayamix, Kyulo, Subsz, Theschmeatdragon, Astoryu,
Bydsalvation, Chamchis, Venoms), and 8 of those 9 score differently:

| character | best | worst | spread |
|---|---|---|---|
| Bydsalvation | 12.58% | 6.83% | 5.76pp |
| Chamchis | 11.76% | 7.60% | 4.16pp |
| Astoryu | 11.08% | 7.13% | 3.95pp |
| Venoms | 10.84% | 7.41% | 3.43pp |
| Kyulo | 9.73% | 7.32% | 2.41pp |
| Theschmeatdragon | 7.41% | 5.98% | 1.43pp |
| Bean | 9.68% | 8.95% | 0.73pp |
| Subsz | 9.76% | 9.05% | 0.71pp |
| Kayamix | 7.35% | 7.35% | 0.00pp |

Kayamix is the instructive one: both payloads score the same, but the chaos copy
writes the main stat as type:2 index **4** (Dexterity) and the raid copy as index
**11** (the class's main stat). Same number, different index — so "match the
tooltip's trait values" is not enough to tell two loadouts apart, and bible
renders index 11 under the class's own stat name ("Dexterity +12,352"), which
makes the two indistinguishable from the rendered text alone.

The other 21 characters hold the same bracelet in every loadout, so the pick is
free — but you cannot know which case you are in without reading them all.

**THE RENDERED DOM SHOWS THE NEWEST LOADOUT, NOT THE RAID ONE.** The bracelet
tooltip the page draws — and the "Bracelet Effects +X%" figure beside it —
belongs to the loadout with the greatest `lastUpdated`, on **all 30 pages without
exception**. Run a chaos dungeon after your last raid and the page draws your
chaos bracelet. So:

- Reading the rendered DOM gives you the *displayed* bracelet, which is the right
  thing to validate a decode against (bible's own words for each line) and the
  wrong thing to rank on.
- Reading the hydration blob in **document order** is worse still: the order is
  not fixed. Chaos comes first on 16 of the 30 pages, so a "first hit wins" rule
  picked the wrong bracelet for 5 of 30 characters (Bean, Kayamix, Subsz,
  Theschmeatdragon, Chamchis) — that was `worker/bracelet.js`'s bug until now.
- **The rule the board uses (Shizu's): rank the HIGHEST loadout.** Ties go to the
  one bible draws, then raid > est. raid > chaos, then newest. `data/leaderboard-seed.json`
  carries every loadout per entry plus `chosenLoadout`; the import panel shows
  them as pills and loads the highest first.

Two other things the 30-page sweep settled:

- **`numRerolls` / `numTicketRerolls` are the counts USED, not left.** 4 and 3
  mean a fully-rolled bracelet. `rollsRemaining = 4−base / 3−ticket` reproduces
  bible's rendered "N+M rolls remaining" on all four pages that print it (bible
  omits the line at 0+0). `bible-import.js` reads them the other way round and
  says so in a comment — that comment is now answered, and the panel's
  `rollsLeft` is wrong for a fully-rolled bracelet.
- **The combat-trait cap outranks the slot count when guessing the grade.**
  Relic tops out at 100, Ancient at 120. `decodeWithGradeCheck` used the granted-
  slot count alone (Ancient 2–3, Relic 1–2) and so called four of the thirty
  characters Relic while they wore Crit +116 / Spec +119 — they lock four of five
  lines, which leaves one granted line, which reads as Relic. Players lock granted
  lines, so the slot count is a guess about behaviour; the cap is a fact about the
  item. Fixed in both `worker/bracelet.js` and `bible-import.js`; it moved the
  Worker's seed parity from 24/30 to 28/30.

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
- `/api/oauth/rosters` shape is now KNOWN — `docs/research/oauth-rosters-shape.md`.
  It is an INDEX and carries no bracelet, so the character-page fetch is the only
  way to a bracelet.
- **Character pages may be fetched for ANY name, not just the caller's own** —
  Shizu's discretion, molenzwiebel confirmed 2026-08-11, provided every request
  carries the token. `rosters` is now used only to prove ownership before a
  `POST /forget` deletes a row. See `ARCHITECTURE.md` §0.3 for what would reverse
  that.
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
