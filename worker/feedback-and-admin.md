# What the Worker still owes `feedback.js` and `admin.html`

Both clients are built and shipped. Neither invents a number: where the Worker
does not answer, the panel says which route or field it is waiting on. This file
is the list, so the Worker side can be written against it without re-reading the
pages.

Nothing below is implemented in `worker/bracelet.js` today unless it says so.

---

## 1. `POST /feedback` — the Feedback tab

`feedback.js` sends, to `WORKER_URL + "/feedback"`, `Content-Type: application/json`:

```json
{ "type": "bug|wrong-number|feature|other", "message": "…", "contact": "…", "hp": "" }
```

Any 2xx with a JSON body counts as sent; the body is not read. 429 gets its own
sentence ("too many notes just now"); every other non-2xx says the status.

What the Worker owes, from ARCHITECTURE §3.6:

- **Honeypot.** `hp` non-empty → accept and drop **silently**: 200, no store. The
  client must never learn it was caught, so do not answer differently.
- **Throttle.** Its own key in the shared per-IP namespace, `fb:<ip>`, 2 per 10s,
  on top of `HARD_CAP`. Feedback is the one write path with no limit under the
  hard cap.
- **Caps, truncating not rejecting.** message 2000, type 40, contact 80, UA 160.
  The client truncates to the same numbers, so agreement is the normal case and a
  disagreement costs characters rather than the note.
- **Key `fb:<ts>-<rand6>`.** The millisecond timestamp makes lexicographic key
  order chronological, so the tail of a `list()` is the newest and the admin read
  is bounded at ≤200 gets.
- **TTL 90 days.** `contact` can hold PII and must not sit forever.

Not built on the client: the admin feedback reader. When `GET /admin/feedback`
(newest ≤200 plus `total` and `unread`) and `POST /admin/feedback` (mark read /
delete) exist, they get a panel on `admin.html`.

---

## 2. `GET /admin/metrics` — the four panels

Implemented, and it answers a **flat** shape:

```json
{ "ok": true, "characters": 0, "queued": 0, "dirty": 0,
  "lastWrite": 0, "snapshotBuiltAt": 0, "modelSig": "…", "hasBibleToken": false }
```

`admin.html` reads the §3.7 nested shape **first** and falls back to those flat
fields, so growing the fields below needs no client edit.

| Panel | Reads | State today |
|---|---|---|
| Queue depth | `queue.total` ← `queued` | **works** |
| Queue list | `queue.list[]` = `{region, name, ts}` (or `waitedS`) | **owed** — panel says so |
| Drain | `drain{mode, perMin, lastRun, budgetUsed, budgetCap}` | **owed** — whole panel |
| Log | `drainLog[]` = `{t, cached[], dropped[], failed[], stop, ms}`, rolling 1h | **owed** — whole panel |
| Health | `health.lastPull` ← `lastWrite`, `health.lastSnapshot` ← `snapshotBuiltAt`, `health.probeArmed` ← `hasBibleToken` | **works** on the fallbacks |

Two rules the client already honours and the Worker must not break:

- **`health.probeArmed` is a boolean.** Never return the token, not even
  truncated. Nothing on the page can render one.
- **A front-sentinel requeue carries `ts: 1`.** The client prints its wait as
  `—`; ageing it from the epoch would claim a 57-year wait.

`queue.list` should be sent whole and capped by the Worker at a sane size; the
client renders at most 500 rows and says when it trimmed.

---

## 3. Controls — all POST, all still owed except two

| Route | Body the client sends | State |
|---|---|---|
| `POST /admin/control` | `{mode}` or `{rate}` — mode one of `run`/`off`/`probe`, rate an integer already clamped 1–20 client-side | **owed** |
| `POST /admin/dequeue` | `{match: "<key substring>"}` or `{all: true}` | **owed** |
| `POST /admin/seed` | the parsed contents of `data/leaderboard-seed.json` | **exists** |
| `POST /admin/rescore` | `{}` | **owed** |
| `POST /admin/delete` | `{region, name}`, **and** the same pair repeated in the query string | **exists**, query-string only |

Useful answers, which the client shows verbatim when present:

- control → `{ok, config:{mode, drainPerMin}}`
- dequeue → `{ok, removed: <n>}`; always delete the order snapshot afterwards
- rescore → `{ok, parseVersion: <n>}`
- seed → `{ok, stored: <n>}` (already the shape)
- delete → `{ok, deleted: "<key>"}` (already the shape)

Two fixes on routes that already exist:

1. **`/admin/delete` reads query params, not the body.** §3.7 says POST with a
   body. The client sends both so it works either way today; when the handler
   learns to read the body, drop the query string from the client.
2. **`/admin/drain` answers a GET and drains.** That is a `GET` with side
   effects — the exact drive-by §3.7 forbids, and one `<img src>` away from a
   stranger triggering a drain. Make it POST-only. The client does not call it.

Auth is unchanged and must stay: `X-Admin-Token` header, constant-time compare,
fail closed, 403 on a miss. The client clears its token on 401 or 403 and returns
to the sign-in box, so a rotated secret costs one re-entry and nothing else.

---

## 4. Deliberately absent

No bulk-backfill button, on either side. Enqueuing thousands of characters is a
conversation with lostark.bible, not a control (§4).
