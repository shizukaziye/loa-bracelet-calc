# What `/api/oauth/rosters` actually returns

**Status: PENDING — awaiting a signed-in run.** Nothing below claims to know the
schema. The endpoint has never been called with a live token from this repo, so
`bible-import.js` was written shape-blind on purpose (it matches on shapes, not
on key names). Fill in the "Recorded response" section the first time anyone
completes the sign-in, and delete this warning.

## Why it is still unknown

lostark.bible documents the endpoint list but not the payloads
(https://lostark.bible/help/oauth-api). Reaching it needs a Discord sign-in, and
only Shizu can complete that — the agent working on this stopped at Discord's
login page and entered nothing.

The open question is narrow and it decides the whole design:

> Does a roster entry carry the bracelet (a `stats` array of `{type, index, value,
> fixed}`), or is `/api/oauth/rosters` only an index of character names?

The odds favour "index only" — the scope is described as "linked rosters and
non-hidden characters", which sounds like a directory. If so, the fallback in
`docs/design/bible-import-fallback.md` is what gets built.

## How to run the probe

1. `npm run serve` (port 8080 — the dev client's redirect URI is
   `http://localhost:8080/` exactly, and nothing else is whitelisted).
2. Open `http://localhost:8080/`, click **Sign in with lostark.bible** in the
   Bracelet panel, and finish the Discord sign-in.
3. The redirect comes back to `http://localhost:8080/`, the token lands in
   `localStorage.bc_bible_oauth`, and the character list loads on its own.
4. Open the console and run:

   ```js
   __probeRosters()
   ```

   It prints every key path in the response, which nodes look like characters,
   whether a bracelet was found on the first one, and the raw payload.

5. Paste the key-path list and one redacted character node below. Redact the
   account name, the Discord id and the character names; keep every field name,
   every numeric value and the full `stats` array — those are the parts that
   matter.

Handy follow-ups in the same console:

```js
BraceletImport.raw()                              // the payload itself
BraceletImport.findCharacters(BraceletImport.raw())
BraceletImport.findBracelet(BraceletImport.findCharacters(BraceletImport.raw())[0].node)
Bracelet.decodeBibleBracelet(<that>.stats)        // does the decoder eat it?
```

## Recorded response

_(nothing recorded yet)_

```
key paths:   PENDING
```

```json
{ "PENDING": "one redacted character node goes here" }
```

### Answers to fill in

| Question | Answer |
| --- | --- |
| Top-level shape (array? `{rosters:[…]}`?) | PENDING |
| What identifies a character (name, class, item level, region?) | PENDING |
| Is region present, and is it `NA`/`CE` or a server name? | PENDING |
| Any gear / equipment / bracelet field at all? | PENDING |
| If yes: does `Bracelet.decodeBibleBracelet` eat its `stats` array unchanged? | PENDING |
| Are `numRerolls` / `numTicketRerolls` present, and do they count DOWN? | PENDING |
| Are hidden characters absent, or present with a flag? | PENDING |

## Facts that are NOT pending

These come from the OAuth help page and the shipped astrogem client, and are
already relied on in `bible-oauth.js`:

- Authorization Code + PKCE (S256), public client, no secret, CORS open to browsers.
- `GET /oauth/authorize` → `POST /oauth/token` (form-encoded). The code is
  single-use and lives 10 minutes.
- Token `uwo_…`, Bearer, 90 days, **no refresh token**. Re-auth auto-approves
  silently while the grant is alive. Stored a day early on purpose.
- `POST /oauth/revoke` for sign-out. 401 on any call means the token is dead.
- Scopes here: `identify rosters`. `logs` is deliberately not requested — it
  exists for `combatPower`, which the bracelet model never reads.
- One app per account: this tool reuses the astrogem app (prod
  `22zuv73nnkcgczoxitokvo2q6u`, dev `onwc5iva725mxhak2dxq3ikjti`).
- Raid statistics endpoints are off limits. Character data through OAuth only.
