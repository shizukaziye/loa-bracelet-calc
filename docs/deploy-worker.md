# Deploying `bracelet-bible` — the exact commands

The Worker is `worker/bracelet.js`, configured by `worker/wrangler.toml`. Nobody
has deployed it yet and no KV namespace exists yet. Everything below is for
Shizu to run; an agent must not run any of it.

Run every command from the repo root unless it says otherwise.

---

## 0. Before you start

You need the Cloudflare CLI and an account already logged in:

```bash
npx wrangler --version
npx wrangler whoami
```

You also need two secrets to hand:

- **`BIBLE_TOKEN`** — the Bearer token lostark.bible's owners issued. The same
  one the astrogem Worker uses; `npx wrangler secret list --config
  ../loastuff/loa-astrogem-calc/worker/wrangler.bible.toml` will confirm it is
  set there, but it will not print the value — get it from wherever you keep it.
- **`ADMIN_TOKEN`** — a fresh random string you invent, for `/admin/*`. Anything
  long: `openssl rand -base64 32`.

---

## 1. Create the two KV namespaces

```bash
cd worker
npx wrangler kv namespace create CHARS
npx wrangler kv namespace create OAUTH
```

Each prints a block like:

```
[[kv_namespaces]]
binding = "CHARS"
id = "0f51c3b5ac6d45a59186375d62879ad7"
```

**Copy each `id` into `worker/wrangler.toml`**, replacing the two placeholders:

| placeholder in `wrangler.toml` | replace with |
| --- | --- |
| `PUT_CHARS_NAMESPACE_ID_HERE` | the id printed for `CHARS` |
| `PUT_OAUTH_NAMESPACE_ID_HERE` | the id printed for `OAUTH` |

Both must be in the file before the first deploy. **A CLI `wrangler deploy`
replaces the whole binding set** — a namespace bound only in the dashboard is
silently dropped on the next deploy. That has already cost the astrogem Worker
once (2026-07).

`OAUTH` is unused today. It is declared now so that adding server-side sessions
later is one code change, not a redeploy that drops `CHARS`.

---

## 2. Set the secrets

```bash
cd worker
npx wrangler secret put BIBLE_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

Each prompts for the value on stdin. They never appear in any file — this repo
is public.

Until `ADMIN_TOKEN` is set, **every** `/admin/*` route answers 403. That is
deliberate: the admin check fails closed.

---

## 3. Deploy

```bash
cd worker
npx wrangler deploy
```

Wrangler bundles `worker/bracelet.js` together with `model/bracelet.js`,
`data/bracelet-data.js` and `data/gear-data.js` — the Worker and the browser run
the *same* model file, so there is no copy to keep in sync. If the deploy ever
fails to resolve those relative imports, fix the bundling; do not paste a copy of
the model into `worker/`.

It prints a URL like `https://bracelet-bible.shizukaziye.workers.dev`.

---

## 4. Paste the URL into the client

Open `bible-import.js` and fill in the constant near the top:

```js
var WORKER_URL = "https://bracelet-bible.shizukaziye.workers.dev";
```

Then bump the cache-buster in `index.html` (the loseii edge caches JS for 4h):

```html
<script src="bible-import.js?v=3"></script>
```

---

## 5. Check it answers

```bash
# health — no auth needed
curl -s https://bracelet-bible.shizukaziye.workers.dev/ | python -m json.tool
```

Expect `ok: true`, the model signature, `kv: true` and `bibleToken: true`. If
`kv` is false the namespace id did not make it into the toml; if `bibleToken` is
false the secret did not get set.

```bash
# admin metrics — should be an empty store, not a 403
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
  https://bracelet-bible.shizukaziye.workers.dev/admin/metrics | python -m json.tool
```

---

## 6. Load the 12 seeded characters

The Worker cannot read the repo, so the seed file is the request body. It is
re-scored on arrival — the file's own numbers are never trusted, so the board
and the calculator can never disagree about a stored bracelet.

```bash
curl -s -X POST \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @data/leaderboard-seed.json \
  https://bracelet-bible.shizukaziye.workers.dev/admin/seed | python -m json.tool
```

The response lists every entry with `pct` (what the shipped model scores),
`seedPct` (what the file recorded) and `delta`.

**Five of the twelve will come out lower, and that is expected.** Their payloads
use `type:2` indices `4`, `74` and `151`, which `model/bracelet.js`'s
`TYPE2_INDEX` does not map yet — the seed decoded them with a local extension
map that never shipped. Those lines score zero here. Index 74 alone is worth
about 4 percentage points on three characters, so **mapping those three indices
is the highest-value follow-up in this whole area.** Until then the board is
honest but under-scores five of its twelve rows, and `unmapped` on each record
says so.

---

## 7. Watch the first real import

```bash
npx wrangler tail --config worker/wrangler.toml
```

Then sign in on the site and click a character. The Worker will:

1. call `/api/oauth/rosters` itself with your token,
2. refuse if the name is not on your own roster,
3. fetch the character page,
4. parse, score on the canonical default profile, store, and answer.

---

## Routine operations

```bash
# take one character off the board (a takedown request)
curl -s -X POST -H "X-Admin-Token: $ADMIN_TOKEN" \
  "https://bracelet-bible.shizukaziye.workers.dev/admin/delete?region=NA&name=Someone"

# what the character page actually contains — the parse probe. This is how the
# calculator's profile auto-fill gets its field map without guessing.
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
  "https://bracelet-bible.shizukaziye.workers.dev/admin/page?region=NA&name=Paroxysmal" \
  | python -m json.tool

# drain the queue by hand instead of waiting for the cron minute
curl -s -H "X-Admin-Token: $ADMIN_TOKEN" \
  https://bracelet-bible.shizukaziye.workers.dev/admin/drain
```

---

## Local development

`wrangler dev` runs the Worker with a local KV simulation, so most of it works
without touching Cloudflare:

```bash
cd worker
npx wrangler dev
```

What works locally: health, the routing, the CORS allowlist, KV reads and
writes, `/admin/seed`. What does not: the rate-limit bindings (absent locally —
the code checks `if (env.X)` and skips them), and any route that reaches
lostark.bible, unless you set `BIBLE_TOKEN` in a local `.dev.vars`.

Everything that can be checked with no deploy at all is already a test:

```bash
node tools/test-worker.mjs     # scoring parity vs the seed, the page parser, the consent gate
node verify.js                 # the model's own parity battery
python verify.py               # the Python mirror
```

---

## What is NOT deployed yet

`GET /?list=1` answers **501**. The leaderboard snapshot — gzipped bytes served
with `encodeBody: "manual"`, the compact tuple format, the dirty-gated
incremental rebuild on a `BUILTAT` throttle — is designed but not written,
pending the architecture doc. Everything that feeds it already runs: each stored
record carries its canonical-default score, and every write drops an
`lb:dirty:<key>` marker. The rebuild is an addition, not a rewrite.

The `Leaderboard` tab in `index.html` is still the placeholder.
