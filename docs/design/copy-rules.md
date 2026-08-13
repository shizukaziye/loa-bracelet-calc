# Copy rules

How this tool talks. Applies to every tab, every panel, every string a user can
read. Written 2026-08-12 from Shizu's brief: *"in general you have too much
commentary, i would like to see commentary removed for the most part or left in
tooltips and on the bottom of each tab include methodology/commentary."*

The house writing rules (Orwell, 1946) still apply on top of this: short words,
active voice, cut what can be cut, no stock metaphors.

---

## 1. The interface states, it does not explain

A number, a label, a unit. Nothing else.

If a control's behaviour is obvious from the control, say nothing. A slider
labelled **Combat traits, total** with a range and a value beside it does not
need a sentence saying you can drag it. A picker that lists three rarities does
not need a sentence saying it lists three rarities.

Ask of every sentence on screen: *does the control already say this?* If it
does, cut it.

```
BAD   Rolls are free, so rolling always beats stopping. This is the average
      final score under the best lock-and-keep policy.
GOOD  after 4 rolls
```

## 2. Explanation lives in a tooltip

Two carriers, both already built:

- **`data-gloss`** — one short, plain string on any element. `tip.js` shows it
  instantly on hover, and on tap for touch. The element gets a dotted underline
  and a help cursor for free, so it advertises itself. This is the default.
- **`data-tip`** — the rich `.pl-pop` popover, for content that is
  **table-shaped**: several rows of figures, a breakdown, a list of
  alternatives. Do not reach for it to hold a paragraph.

Anything sitting on screen as a sentence that could be a tooltip becomes one.

Put the gloss on the thing it explains. A column's explanation goes on that
column's `<th>`. A figure's arithmetic goes on the figure. A section's rules go
on the section heading. Never on a neighbour.

Keep a gloss to one or two sentences. If it needs three, it is methodology —
see rule 3.

```
BAD   <div class="s">What the bracelet is worth over the one you would wear
                     instead. 62% of the outcomes beat your 4.10% baseline.
                     Worth is how far they clear it, on average, at 4,200 gold
                     per 1%. It is never negative.</div>
GOOD  <div class="k" data-gloss="What this bracelet is worth over the one you
                     would wear instead …">Worth</div>
      <div class="s">62% of outcomes clear your 4.10% baseline</div>
```

## 3. Methodology lives at the bottom of the tab

**One `<details class="method">` per tab, last element in the pane, collapsed by
default.** The Tier List set the pattern ("How these ranks are worked out"); the
`details.method` rule in `styles.css` is the whole style.

```html
<details class="method">
  <summary>How the numbers on this tab are worked out</summary>
  <p>…</p>
</details>
```

- **Summary line:** how something is worked out, in one short phrase. Not
  "Methodology", not "More info".
- **Never `open`.** The table, the cards, the answer is what the reader came
  for. The reasoning waits until asked.
- This is where the reasoning, the formulas and the caveats go — **in full**.
  Nothing is too long for this block. Everything else on the tab is too short
  for prose.
- Write it **static**. A method block built once at mount cannot quote a live
  figure without going stale; quote the model's constants, not the current
  solve.

### Dividing the tab blocks from the Method tab

The Method tab (`method.js`) is the long-form home for **the model**: where the
baseline comes from, how each bucket is scored, which tables the numbers were
transcribed from, what the tool does not model.

A per-tab method block answers a narrower question: **what am I looking at on
this screen.** It names the figures on that tab, gives the formula where the
figure *is* a formula, and stops. It ends by pointing at the Method tab for the
model behind it.

The same formula may appear in both — a formula has no voice. The same
*paragraph* may not. If you find yourself explaining where the baseline comes
from inside a tab block, you are writing the Method tab in the wrong place.

## 4. What stays inline, always

Four things say something the controls cannot, so they earn their space on
screen:

1. **An impossible or wrong state.** "Three combat traits are active. A real
   bracelet only ever carries two." "Fill every granted slot, or leave them all
   empty." The state on screen could not exist in game, and only a sentence can
   say so.
2. **An error.** A failed lookup, a service that is down, a name that came back
   empty. Every failure gets its own sentence — never one shrug for all of them.
3. **An empty or degraded state that tells the reader what to do next.** "No
   saved characters yet — grade one and tap its ★." "Cached characters still
   work."
4. **A value's provenance.** Which source the table came from, which loadout is
   being scored, whether a figure is cached or live. The number on screen means
   something different depending on the answer.

Everything else is commentary.

## 5. Prefer cutting to rewording

If a sentence survives only because it is true, cut it. True is not the test —
*needed* is.

Before rewriting a sentence shorter, check whether it needs to exist at all.
Most of the prose this pass removed was accurate, well written and answering a
question nobody had asked yet.

## 6. Notes on the mechanics

- **A `.note` is not a home for prose.** `.note` is the small dim style. It is
  right for a warning, a provenance line or a one-line empty state, and wrong
  for a paragraph.
- **Do not leave an empty element behind.** If cutting a sub-line empties a
  card's `.s` slot, either give the slot a value or drop the element, so the
  layout does not keep a hole where the sentence was.
- **A table's summary belongs in a `<tfoot>` row**, not in a paragraph under the
  table. `Total | +4.12% | 100%` beats a sentence about totals.
- **Do not gloss a `<button class="primary">`** — the dotted underline lands on
  its label and reads as damage. Put the gloss on the section heading or the
  field label instead.
- **Escape what you gloss.** `data-gloss="…"` takes a raw attribute value: run
  user- or model-derived text through `esc()`.
- **One idea per gloss.** If a tooltip has an "and also", it is two tooltips or
  it is methodology.
