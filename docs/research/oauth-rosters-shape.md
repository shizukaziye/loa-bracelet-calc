# What `/api/oauth/rosters` actually returns

**Status: ANSWERED, 2026-08-11.** Captured from Shizu's own signed-in session in
the local dev browser (`http://localhost:8080`, dev client). The answer is in
"Recorded response" below.

**The headline: it is an INDEX. There is no bracelet, and no gear of any kind.**
Four fields per character — `name`, `class`, `ilvl`, `lastUpdate` — and nothing
else. So the Worker fallback is not optional; it is the only way to read a
bracelet, and `worker/bracelet.js` is it.

Two more facts that shaped the code:

- **`region` sits on the ROSTER, not on the character.** Any walker has to
  inherit it downward. `collectRosterChars()` in the Worker and `findCharacters`
  in `bible-import.js` both do; the Worker's test pins it.
- **`class` is the game's internal snake_case code**, not the English display
  name the character page's badge shows. `devil_hunter_female`, not
  `Gunslinger`. The map is below.

## Why it was unknown for so long

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

Every key path in the payload — the whole schema, it is this small:

```
rosters
rosters[].region
rosters[].world
rosters[].characters
rosters[].characters[].name
rosters[].characters[].class
rosters[].characters[].ilvl
rosters[].characters[].lastUpdate
```

One roster head and one character node, verbatim:

```json
{
  "rosters": [
    {
      "region": "NA",
      "world": "Nineveh",
      "characters": [
        { "name": "Paroxysmal", "class": "devil_hunter_female", "ilvl": 1795, "lastUpdate": 1786438275 }
      ]
    }
  ]
}
```

The account under test returned **two rosters, both `NA` / `Nineveh`**, holding
11 characters between them. Two rosters on one world is normal — a second roster
is a second character slot group, not a second server.

`lastUpdate` is a UNIX timestamp in seconds (1786438275 = 2026-08-11). It is
when lostark.bible last synced that character, which makes it the honest "how
stale is this" field for anything built on top.

### The answers

| Question | Answer |
| --- | --- |
| Top-level shape | `{ rosters: [ … ] }` |
| What identifies a character | `name`, `class`, `ilvl`, `lastUpdate` — nothing else |
| Is region present, and where | Yes, `NA` — on the **roster**, not the character. `world` is the server name (`Nineveh`) and must not be read as a region. |
| Any gear / equipment / bracelet field | **None.** No equipment, no stats, no engravings, no gems. |
| Does `decodeBibleBracelet` eat it | N/A — there is nothing to decode. The character page is the only source. |
| `numRerolls` / `numTicketRerolls` | Absent. They come from the character page. |
| Hidden characters | Absent entirely, with no flag — a hidden character simply is not in the list, so the Worker will refuse it as "not yours". That is the right behaviour but it will read as a bug to the user; the import panel's `notyours` message says to check for hidden characters because of this. |

### Class codes

`class` is the game's internal name. Eight of these were confirmed by joining
this payload against `data/leaderboard-seed.json`, whose class names were read
off the character PAGES (which render the English display name):

| roster `class` | display name |
| --- | --- |
| `arcana` | Arcanist |
| `berserker` | Berserker |
| `blade` | Deathblade |
| `devil_hunter_female` | Gunslinger |
| `dragon_knight` | Guardianknight |
| `alchemist` | Wildsoul |
| `reaper` | Reaper |
| `soul_eater` | Souleater |
| `bard` | Bard *(seen in the payload, not yet cross-checked against a page)* |

Note `devil_hunter_female` → **Gunslinger**, not Deadeye: Devil Hunter is the
base class and the suffix carries the advanced class. Expect a
`devil_hunter_male` → Deadeye and the same pattern on other gendered bases.

The map lives in `worker/bracelet.js` (`ROSTER_CLASS`) and is used only as a
fallback for the page badge, with unknown codes title-cased rather than dropped.

### What this settled

- `docs/design/bible-import-fallback.md` is required, not contingent. Built.
- `bible-import.js` can keep listing characters straight from this payload —
  name, class and item level are all it needs for the list.
- Anything wanting gear, stats or a profile must go through the character page,
  which means through the Worker. There is no browser-only path.

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
