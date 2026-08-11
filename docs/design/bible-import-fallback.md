# Fallback: reading a bracelet when `/api/oauth/rosters` has none

**Status: BUILT (first pass, 2026-08-11), not deployed.** `worker/bracelet.js` +
`worker/wrangler.toml` implement everything below, plus the consent gate and the
canonical-default scorer. Deploy steps: `docs/deploy-worker.md`. Local checks:
`node tools/test-worker.mjs`.

Three things came out different from the sketch below, all deliberate:

- The route is `GET /character?name=&region=` (`/bracelet` still works as an
  alias), and it also STORES a scored record, because the leaderboard needs one.
- The Worker scores every stored bracelet at the CANONICAL DEFAULT profile and
  returns it as `defaultScore`. The calculator scores the same bracelet on the
  user's own settings. Two numbers, both shown, never mixed.
- `POST /import` (bulk) and `POST /forget` (a user removes their own characters)
  were added; the leaderboard snapshot (`?list=1`) is stubbed at 501 pending the
  architecture doc.

The rest of this document is the original design and still describes the shape.

## The rule that shapes everything

The site owner banned scraping the raid statistics endpoints. Nothing here goes
near them. This fetches ONE character page, on a click the signed-in user made,
for a character on that user's own roster. No crawling, no sweeps, no queue that
grows on its own. If it ever needs a rate limit to stay polite, it is already the
wrong design.

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
403 { error:"not_yours" }              the token's roster does not list that name
429 { error:"slow_down" }
```

The browser hands the response's `bracelet.stats` straight to
`Bracelet.decodeBibleBracelet`, then to `BraceletApp.applyImport` — the same last
two steps `bible-import.js` already runs. Only the source of `stats` changes, so
the client-side change is one function.

### Ownership check, and why it is not optional

The Worker MUST verify the caller owns the character before fetching anything:
call `GET /api/oauth/rosters` with the caller's own token and check the name is
in it. Without that check the Worker is a public scraper with a nice URL, which
is the thing we were asked to stop doing. Cache the roster answer per token for
a few minutes so the check costs one extra fetch, not two per click.

### Credentials

- The caller's OAuth token is used for the ownership check ONLY. It arrives in
  the Authorization header and is never logged or stored.
- The page fetch uses `BIBLE_TOKEN`, the sanctioned token, as a Worker secret
  (`wrangler secret put BIBLE_TOKEN`). It never appears in source — this repo is
  public. Same arrangement as astrogem.

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

- `[[ratelimits]]` in `wrangler.toml`: one lookup per 10 s per caller, 20 per
  hour. Generous for a human clicking a character, useless for a crawler.
- Cache each character's parsed bracelet in KV for an hour. A user who reloads
  the page or compares two characters must not cause two page fetches.
- CORS allowlist, not `*`: the GitHub Pages origin, the loseii origins, and a
  localhost regex — stamped once in `fetch()`, the way astrogem does it.
- `EU` is `CE` in this API. Reject anything that is not `NA` or `CE` rather than
  guessing.

## Client-side TODO marker

`bible-import.js` already lands on the "no bracelet came back" message and names
this file. When the Worker exists, the change is inside `pick()`: where it today
does `if (!data) { …nobracelet… }`, it instead calls the Worker, and on success
carries on into `buildPatch` unchanged.
