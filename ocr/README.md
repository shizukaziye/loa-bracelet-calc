# Reading a bracelet off the screen

The Advisor tab can fill itself in from a screenshot of the in-game bracelet
tooltip. This directory is the reader. It is a port of the astrogem calculator's
`ocr/` stack (`loastuff/loa-astrogem-calc/ocr/`), keeping the two things that
made that one work: **structure and colour before text**, and a shared repair
pass (`constraintSnap`) that guarantees the Advisor only ever sees a **legal**
bracelet.

| file | what it is |
|---|---|
| `engine.js` | the interface, `constraintSnap`, `isLegalPatch`, and the engine registry. No image code. |
| `layout.js` | pure image analysis: find the panel, cut it into rows, group rows into entries, take a colour, spot a padlock, prepare a strip for OCR. Works on plain `{width,height,data}` rasters, so it runs in a page, in a worker and in Node. |
| `lexicon.js` | what the words can say. Every family's telling vocabulary and every number the game can print, both built from `data/bracelet-data.js`. |
| `text-reader.js` | the pluggable text reader — Tesseract in the browser, a null reader when it is missing, an injected one in tests. |
| `tooltip-engine.js` | THE parser. Runs the stages in order and hands the raw read to `constraintSnap`. |
| `parse-worker.js` | the same parse, off the main thread. |
| `fixture.js` | a synthetic tooltip drawn from the real tables, for testing. |
| `self-test.js` | `node ocr/self-test.js` — the pipeline on fixtures, and `constraintSnap` against illegal states. |
| `fixture.html` | a browser bench: real font on a real canvas, real Tesseract. |

The UI side lives one directory up, in `advisor-capture.js`.

## The interface

```js
engine.parseScreenshot(imageElOrBlobOrCanvas) -> {
  patch,        // exactly bible-import.js#buildPatch's shape
  confidence,   // { "<patch path>": 0..1 }
  unknown,      // ["rows.1.fam", …] — fields the read could not settle
  notes,        // plain-English account of every repair
  debug
}
```

`patch` is deliberately the same object `bible-import.js` produces for an
imported character — `{ grade, slots, traits, traitOrder, rows, fixedRows,
lockedIdx, rollsLeft }` — so a screenshot travels the path the Advisor already
has for an import.

Engines self-register; the Advisor lists them with `bcListEngines()` and picks
one with `bcGetEngine("tooltip")`. There is one live engine.

## `constraintSnap` — the accuracy lever

The astrogem solver tolerates a silly state. Ours does not: a bracelet with four
granted lines, a duplicated family, or a value that exists in no table is not a
bad answer, it is a refusal. So every field leaves the snap **legal or unknown**,
never as a guess wearing a legal costume.

- **grade** — the values outrank the read word. A combat trait over 100 is
  Ancient whatever the tooltip's colour said; a special-effect value that only
  one grade's table carries settles it the same way. (This is the rule the 30
  character-page sweep established: the cap is a fact about the item, the slot
  count is a guess about the player.)
- **combat traits** — at most two, no duplicates, value clamped to the grade's
  band (Relic 41–100, Ancient 61–120). A trait the panel has no row for
  (Domination, Endurance, Expertise) is dropped with a note.
- **basic lines** — the value must sit inside some band for that grade and
  family, or it is pulled in and the field drops to low confidence.
- **special lines** — the family must exist, and the tier must exist for that
  grade. The printed number chooses the tier; a number matching no tier exactly
  gets the nearest one **and a flag**.
- **no duplicate family** across fixed and granted lines. The better-read one
  stays, the other becomes an empty slot.
- **category caps** from the data tables: 2 basic, 2 trait, 5 special.
- **granted-slot count** legal for the grade — Ancient 2–3, Relic 1–2. Too many
  and the extras are emptied with a note naming what went; too few and the rest
  are padded as unknown.
- **rolls** clamped to 0–7 (4 base + 3 ticket).

`isLegalPatch(patch)` is the same rules read back, and the self-test asserts it
on every snap it performs.

### What is fixed and what is granted

The tooltip does not say. The reader uses the rule the rest of the repo already
uses: the **combat traits are the fixed lines**, everything else is a granted
line, and a padlock is a **lock**, not a fixed line. `bible-import.js` learnt
this the hard way — sorting locked lines into `fixedRows` left the solver a
half-filled bracelet, which it refuses.

## Confidence

**Confidence comes from the image.** It is built out of: how solidly the panel
was found and how sharp its edges are; how far the winning family beat the
runner-up in weighted vocabulary; what Tesseract said about its own worst word on
that line; how clean and how unambiguous the entry's colour was; and whether the
printed number is exactly a table value or merely near one.

Nothing raises a confidence because the answers agree with one another. **A
checksum launders errors** — the astrogem parser reported high confidence on
wrong values for exactly that reason (241-frame corpus, `ACCURACY-LOG.md`). Two
genuinely independent reads of one field — the words and the printed number —
agreeing is worth a bounded lift of +0.08, capped at 0.95, and only when both
channels are individually credible. Everything else about agreement is used to
**lower** confidence, never to raise it.

The snap then attenuates: a field it had to default drops to 0, a field it
materially changed drops to `min(raw, 0.3)`. It never raises a number.

### The colour channel is judged before it is trusted

The palette in `layout.js` is Lost Ark's published rarity colours plus the two
greys its tooltips use. **It has never been checked against a bracelet
screenshot.** So the parser measures, on each screenshot, how often the colour it
read agrees with the number it read (roll bands: green 1–4, blue 5–7, purple
8–10, from `docs/research`), and only lets a colour disagreement pull a field
down when the channel is evidently working on that image. A wrong palette
therefore costs a missed opportunity, not a page full of false flags.

## What is proven, and what is not

**There were no real bracelet screenshots when this was written.** Nothing below
is a claim about reading Lost Ark.

Proven, and reproducible:

- `node ocr/self-test.js` — 65 checks. The pipeline end to end on synthetic
  tooltips (panel found within a few pixels of where it was drawn; rows cut;
  wrapped lines joined to their entry; colours read; padlocks seen), and
  `constraintSnap` against every illegal state that could be constructed: a value
  in no table, a basic value outside every band, a duplicated family, three
  combat traits, four granted lines on an Ancient, none on a Relic, Crit 116 read
  as Relic, an Ancient-only value read as Relic, an unknown family id, three
  basic lines, a Domination line, 11 rolls, and nothing readable at all. Every
  one comes out legal or unknown. It also crawls **every family × tier × grade**
  (198 combinations) through the snap and asserts each one comes back as itself.
- On a 40-bracelet synthetic sweep with a clean text reader: family 100%,
  family+tier 100%, whole set 100%, grade 100%, slots 100%, rolls 100%, locks
  98%, and **zero** fields that were both wrong and confident.
- `ocr/fixture.html` in a browser, with **real Tesseract on real anti-aliased
  text**. Ten random bracelets at 18px text: family 100%, family+tier 100%, whole
  set 100%, traits 100%, locks 100%, rolls 100%, **zero** wrong-and-confident
  fields, and 2.4 fields flagged for a look per bracelet. Text height is what
  drives it — at 18px and 22px everything reads, traits at 0.93–0.94 confidence;
  at 13–15px Tesseract reads "Crit" as "Cnt", the trait line is dropped, and both
  trait fields come back at **0.00 confidence**. Wrong-and-flagged, never
  wrong-and-confident, is the behaviour the whole design is for.
- Two findings that came out of that bench and are now baked in: a **hard
  binarised** strip reads worse than a grey one (the same line read "Cnt"
  binarised and "Crit" in grey), so `textStrip` keeps its greys; and Tesseract 5
  refuses a bare `{width,height,data}` raster, so `text-reader.js` paints it onto
  a canvas first.
- `advisor-capture.js`, mounted in that same page: the parse ran **in the
  worker** (407 ms), the confidence strip said "Parsed — 4 fields need a look",
  the `bc-unconfirmed` marker landed on the matching `data-conf-key` element, and
  clicking it cleared the flag and dropped the count to 3. The drop and paste
  paths use ordinary DOM events and were not exercised in that bench; the screen
  share was not exercised at all, because it needs a real click on a real picker.

NOT proven, and waiting on a real screenshot:

- that the panel finder's thresholds (dark, unsaturated, ≥72% of a cell) match a
  real Lost Ark tooltip over a real game scene;
- that the palette is the game's palette, or that the roll-band colours apply to
  the in-game tooltip at all rather than only to lostark.bible's web page;
- that a padlock looks anything like the compact square blob `lockGutter` hunts
  for, or that it sits on the left;
- that the gutter/indent rule separates a wrapped line from a new one in the real
  tooltip;
- that the ALIASES in `lexicon.js` match the English client's wording — they are
  guesses, and a family whose alias is wrong will score low and be flagged;
- what the tooltip actually prints about rolls remaining, if anything.

## What to capture first

For the first real test, the most useful thing is a handful of screenshots with
their true values written out beside them:

- **Native resolution, no downscaling.** Text height is the whole game: 18px is
  comfortable, 13px is where words start to fail. A 2560×1440 or 3840×2160 grab
  of the full screen is right; a screenshot resized to fit a Discord message is
  not.
- **PNG, not a re-compressed JPEG.** Win+Shift+S or the Steam screenshot key are
  both fine.
- **The whole tooltip**, with a little of the game scene around it — the panel
  finder needs an edge to find, and a picture cropped exactly to the tooltip
  gives it nothing to reject.
- **The tooltip expanded**, if the game has a compact and a full form: capture
  the one that lists every effect line with its numbers.
- **A spread**: one Ancient and one Relic; one with a padlock set and one
  without; one with a wrapped long effect line (a family in the 11–22 range);
  one at your usual in-game brightness and one at a noticeably different setting.
  Brightness was the single biggest source of misreads on astrogem's corpus, so
  it is worth knowing early where this one stands.

Drop them in `ocr/samples/` with a `.json` of the true values beside each, and
`self-test.js` gains a real scoring row.
