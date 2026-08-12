# Fallback: reading a bracelet when `/api/oauth/rosters` has none

**Status: BUILT AND DEPLOYED, 2026-08-11.** `worker/bracelet.js` +
`worker/wrangler.toml` implement everything below, plus the canonical-default
scorer. Deploy steps: `docs/deploy-worker.md`. Local checks:
`node tools/test-worker.mjs`.

> **THE OWNERSHIP CHECK BELOW IS NO LONGER IN FORCE — 2026-08-11.** Anyone may
> look up any character by name, signed in or not. Shizu's permission from
> molenzwiebel covers arbitrary character-page fetches at his discretion, provided
> every request carries the token; the roster gate this document argues for was
> stricter than that permission, and it came off. It survives on `POST /forget`
> only, which deletes rows. The reasoning, the date and the revert condition are
> in `ARCHITECTURE.md` §0.3 — read that before "fixing" anything here. The rest of
> this file is kept as the record of the original design.

Four things came out different from the sketch below, all deliberate:

- The route is `GET /character?name=&region=` (`/bracelet` still works as an
  alias), and it also STORES a scored record, because the leaderboard needs one.
- The Worker scores every stored bracelet at the CANONICAL DEFAULT profile and
  returns it as `defaultScore`. The calculator scores the same bracelet on the
  user's own settings. Two numbers, both shown, never mixed.
- `POST /import` (bulk) and `POST /forget` (a user removes their own characters)
  were added; the leaderboard snapshot (`?list=1`) is live.
- The ownership check came off `/character` and `/import` (see the note above).
  What holds the volume down instead: a per-IP lookup throttle, a site-wide
  enqueue gate, the ≥3s spacing floor, a monthly budget and a 7-day cache.

The rest of this document is the original design and still describes the shape.

## The rule that shapes everything

The site owner banned scraping the raid statistics endpoints. Nothing here goes
near them, and nothing ever will. This fetches ONE character page per click a
human made. No crawling, no sweeps, no enumeration, no queue that grows on its
own — that much is unchanged and is not negotiable.

What DID change (2026-08-11): the click no longer has to come from the character's
owner. The rate limits are therefore not a fig leaf over a bad design, they are
the design — a paced queue, one page every three seconds, a site-wide cap on how
fast the queue can grow, and a monthly ceiling.

## Why a Worker at all

The character page is HTML from `lostark.bible`, and a browser cannot fetch it
cross-origin — no CORS on the page routes, only on `/api/oauth/*`. So a small
Cloudflare Worker sits in the middle: it fetches the page server-side, pulls the
bracelet out, and answers JSON with permissive CORS to our own origins.

`loastuff/loa-astrogem-calc/worker/astrogem-bible.js` already does exactly this
for accessories and ark-grid cores. Copy its skeleton; the only new part is the
bracelet regex.

## Shape

```
GET https://bracelet-bible.<sub>.workers.dev/bracelet
      ?name=<character>&region=NA|CE
    Authorization: Bearer uwo_…        (the caller's OWN OAuth token)

200 { name, region, grade?, bracelet: { type:"bracelet", stats:[…],
                                        numRerolls, numTicketRerolls } }
404 { error:"no_bracelet" }            character exists, wears nothing there
403 { error:"not_yours" }              POST /forget only — reading needs no ownership
429 { error:"slow_down" }
```

The browser hands the response's `bracelet.stats` straight to
`Bracelet.decodeBibleBracelet`, then to `BraceletApp.applyImport` — the same last
two steps `bible-import.js` already runs. Only the source of `stats` changes, so
the client-side change is one function.

### Ownership check — SUPERSEDED 2026-08-11

The original argument ran: the Worker MUST call `GET /api/oauth/rosters` with the
caller's token and refuse any name that is not on it, or it is "a public scraper
with a nice URL".

That over-read the permission. What molenzwiebel actually asked for is the TOKEN
on every request, not a roster check — arbitrary character fetching is allowed at
Shizu's discretion, and he has exercised it. The roster check now runs on
`POST /forget` alone, where the question is "may you delete this row", not "may
you read this page". Roster answers are still cached per token for five minutes,
keyed by a SHA-256 of the token.

Rate limits, the paced queue and the cache are what keep this polite now. See
`ARCHITECTURE.md` §0.3 for the decision, its date, and what reverses it.

### Credentials

- The caller's OAuth token, when they send one, fetches the page — the pull is
  then attributable to the human who asked, and the load spreads over many
  sign-ins instead of landing on one secret. It arrives in the Authorization
  header and is never logged or stored.
- `BIBLE_TOKEN`, the sanctioned token, is a Worker secret
  (`wrangler secret put BIBLE_TOKEN`). It carries every signed-out lookup, the
  cron drain, and one retry when a caller's token turns out to be stale. It never
  appears in source — this repo is public. Same arrangement as astrogem.
- **Neither token, no request.** A tokenless fetch is the actual violation, so
  `fetchCharacterPage` returns 503 rather than send one.

## Parsing the page

The bracelet lives in the SvelteKit hydration blob, in the same style as the
accessories `astrogem-bible.js` already scans:

```js
// astrogem's accessory scanner, for reference:
//   /slot:"(neck|ear1|ear2|finger1|finger2)",data:\{type:"tier4_accessory",stats:\[(.*?)\]\}/g
const RE = /slot:"bracelet",data:\{type:"bracelet",stats:\[(.*?)\](.*?)\}/;
```

The captured `stats` text is JS object literal source, not JSON — unquoted keys,
so it needs the same `{type:…,index:…,value:…,fixed:…}` field-by-field extraction
astrogem uses rather than a `JSON.parse`. Pull `numRerolls` and
`numTicketRerolls` out of the trailing capture the same way.

Verified example of what is in there (from
`docs/research/mechanics-bible-leaderboard.md`):

```js
{id:213400033, slot:"bracelet", data:{ type:"bracelet",
  stats:[
    {type:2, index:15,    id:213400023, value:101,   fixed:true},
    {type:2, index:18,    id:213400023, value:81,    fixed:true},
    {type:3, index:11051, id:213400023, value:5,     fixed:false},
    {type:2, index:11,    id:213400023, value:13888, fixed:false},
    {type:2, index:76,    id:213400023, value:840,   fixed:false}],
  numRerolls:4, numTicketRerolls:3 }}
```

Every one of those decodes today: `model/bracelet.js` `decodeBibleBracelet` is
unit-tested against this payload. The parser's only job is to hand over the
array.

## Limits

- `[[ratelimits]]` in `wrangler.toml`, as built: `HARD_CAP` 60/60s per IP,
  `LOOKUP_THROTTLE` 3 NEW characters per minute per IP, `IMPORT_GATE` 10 enqueues
  a minute site-wide, `GLOBAL_GATE` 1000/60s shared. Generous for a human clicking
  a character, useless for a crawler.
- Cache each character's parsed bracelet in KV for seven days, and serve a cached
  record at any age. A cached character costs nothing upstream, so a user who
  reloads or compares two characters causes no page fetch at all.
- CORS allowlist, not `*`: the GitHub Pages origin, the loseii origins, and a
  localhost regex — stamped once in `fetch()`, the way astrogem does it.
- `EU` is `CE` in this API. Reject anything that is not `NA` or `CE` rather than
  guessing.

## Client-side TODO marker

`bible-import.js` already lands on the "no bracelet came back" message and names
this file. When the Worker exists, the change is inside `pick()`: where it today
does `if (!data) { …nobracelet… }`, it instead calls the Worker, and on success
carries on into `buildPatch` unchanged.
