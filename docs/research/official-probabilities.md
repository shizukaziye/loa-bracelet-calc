# Official T4 bracelet probabilities (Stove disclosure page)

Source: https://m-lostark.game.onstove.com/Probability/%ED%8C%94%EC%B0%8C%20T4
Page last revised 2025-12-30. Extracted 2026-08-11. Raw HTML archived in the session
scratchpad as `palchi.html` (may be gone; re-fetch with a browser UA if needed).

Grades on this page: **Relic (유물)** and **Ancient (고대)** only. No lower grades, no
ilvl bands, no costs, no pity. Reroll (재부여) costs are NOT published anywhere official.

## Leap points

| | Relic | Ancient |
|---|---|---|
| Leap points | 9P | 18P |

## Line counts

Fixed effects (고정 효과) — both grades: 1 line 65%, 2 lines 35%.

Granted effects (부여 효과): Relic 1 slot 75% / 2 slots 25%; Ancient 2 slots 75% / 3 slots 25%.

## Assignment / conversion rules (verbatim semantics)

- Category roll: **basic 35% / combat trait 35% / special 30%**.
- Caps, shared across fixed + granted lines: **max 2 basic effects, max 2 combat traits,
  max 5 special effects**.
- An already-granted effect is never granted again (no duplicate families).
- Effects marked grant-only never appear as fixed lines.
- Renormalization: real chance of each effect =
  `listed% / (100% − sum of listed% of all excluded effects)` — excluded = capped
  categories + already-present families.

## Basic effects (기본 효과) — 35% category

Str/Dex/Int 50% vs Vitality 50%. Value bands (uniform within band):

| Band prob | Str/Dex/Int Relic | Str/Dex/Int Ancient | Vitality Relic | Vitality Ancient |
|---|---|---|---|---|
| 10% | 6400–7040 | 9600–10240 | 3000–3200 | 4000–4200 |
| 16% | 7041–7680 | 10241–10880 | 3201–3400 | 4201–4400 |
| 16% | 7681–8320 | 10881–11520 | 3401–3600 | 4401–4600 |
| 16% | 8321–8960 | 11521–12160 | 3601–3800 | 4601–4800 |
| 10% | 8961–9600 | 12161–12800 | 3801–4000 | 4801–5000 |
| 10% | 9601–10240 | 12801–13440 | 4001–4200 | 5001–5200 |
| 10% | 10241–10880 | 13441–14080 | 4201–4400 | 5201–5400 |
| 4% | 10881–11520 | 14081–14720 | 4401–4600 | 5401–5600 |
| 4% | 11521–12160 | 14721–15360 | 4601–4800 | 5601–5800 |
| 4% | 12161–12800 | 15361–16000 | 4801–5000 | 5801–6000 |

## Combat traits (전투 특성) — 35% category

Crit / Spec / Domination / Swiftness / Endurance / Expertise, each 16.6667% (fixed and
granted alike). Shared value bands (uniform within band):

| Band prob | Relic | Ancient |
|---|---|---|
| 10% | 41–46 | 61–66 |
| 16% | 47–52 | 67–72 |
| 16% | 53–58 | 73–78 |
| 16% | 59–64 | 79–84 |
| 10% | 65–70 | 85–90 |
| 10% | 71–76 | 91–96 |
| 10% | 77–82 | 97–102 |
| 4% | 83–88 | 103–108 |
| 4% | 89–94 | 109–114 |
| 4% | 95–100 | 115–120 |

## Special effects (특수 효과) — 30% category

33 families × 3 tiers (low/mid/high). Identical probability structure for Relic and
Ancient; only values differ. Probabilities below are the LISTED (pre-renormalization)
percentages. Granted column sums to ~100% across all 99 rows (page rounds; actual sum
100.00016%). Fixed column exists only for families 1–10 and sums to exactly 100% over
its 30 rows.

Family numbering follows page order and matches the maxroll 1–33 numbering and the
lostark.bible index encoding (see mechanics doc).

### Families 1–10 — fixed-eligible. Fixed 6/3/1%, granted 4.2/2.1/0.7% per tier

| # | Effect | Relic low/mid/high | Ancient low/mid/high |
|---|---|---|---|
| 1 | Attack & Move Speed +X% | 3/4/5 | 4/5/6 |
| 2 | Damage to Seed-grade & lower +X% | 3/4/5 | 4/5/6 |
| 3 | Damage taken from Seed-grade & lower −X% | 4/6/8 | 6/8/10 |
| 4 | Physical Defense +X | 4000/5000/6000 | 5000/6000/7000 |
| 5 | Magic Defense +X | 4000/5000/6000 | 5000/6000/7000 |
| 6 | Max HP +X | 8400/11200/14000 | 11200/14000/16800 |
| 7 | Combat HP recovery +X | 80/100/130 | 100/130/160 |
| 8 | Combat resource natural recovery +X% | 6/8/10 | 8/10/12 |
| 9 | Movement/stand-up skill CD −X% | 6/8/10 | 8/10/12 |
| 10 | On-hit stagger/debuff immunity Xs, gone after 1 hit (CD Xs) | 90/80/70 | 80/70/60 |

(Family 10: higher tier = shorter duration AND cooldown.)

### Families 11–22 — grant-only combos. Granted 0.5 / 0.25 / 0.08333% per tier

| # | Effect | Relic low/mid/high | Ancient low/mid/high |
|---|---|---|---|
| 11 | Crit Rate +A%; on crit, damage +1.5% | A=2.6/3.4/4.2 | A=3.4/4.2/5.0 |
| 12 | Crit Damage +A%; on crit, damage +1.5% | A=5.2/6.8/8.4 | A=6.8/8.4/10.0 |
| 13 | Damage +A%; damage to Staggered +B% | 1.5&3.5 / 2.0&4.0 / 2.5&4.5 | 2.0&4.0 / 2.5&4.5 / 3.0&5.0 |
| 14 | Additional Damage +A%; Demon/Archdemon damage +B% | 2.0&2.5 / 2.5&2.5 / 3.0&2.5 | 2.5&2.5 / 3.0&2.5 / 3.5&2.5 |
| 15 | Skill CD +2% but damage +A% | 4.0/4.5/5.0 | 4.5/5.0/5.5 |
| 16 | On-hit enemy Defense −A% (1/party); ally AP buff +B% | 1.5&1.5 / 1.8&2.0 / 2.1&2.5 | 1.8&2.0 / 2.1&2.5 / 2.5&3.0 |
| 17 | On-hit enemy Crit Resist −A% (1/party); ally AP buff +B% | 1.5&1.5 / 1.8&2.0 / 2.1&2.5 | 1.8&2.0 / 2.1&2.5 / 2.5&3.0 |
| 18 | Shielded party target damage +A% (1/party); ally AP buff +B% | 0.7&1.5 / 0.9&2.0 / 1.1&2.5 | 0.9&2.0 / 1.1&2.5 / 1.3&3.0 |
| 19 | On-hit enemy Crit DMG Resist −A% (1/party); ally AP buff +B% | 3.0&1.5 / 3.6&2.0 / 4.2&2.5 | 3.6&2.0 / 4.2&2.5 / 4.8&3.0 |
| 20 | On-hit per sec 10s: Weapon Power +A, atk/move speed +1% (max 6 stacks) | 1000/1160/1320 | 1160/1320/1480 |
| 21 | Weapon Power +A; while HP≥50%, on-hit WP +B for 5s | 6300&1800 / 7200&2000 / 8100&2200 | 7200&2000 / 8100&2200 / 9000&2400 |
| 22 | Weapon Power +A; on-hit every 30s WP +B for 120s (max 30 stacks) | 6000&120 / 6900&130 / 7800&140 | 6900&130 / 7800&140 / 8700&150 |

### Families 23–33 — grant-only singles. Granted 1.0909 / 0.5455 / 0.1818% per tier

| # | Effect | Relic low/mid/high | Ancient low/mid/high |
|---|---|---|---|
| 23 | Damage to enemies +X% | 1.5/2.0/2.5 | 2.0/2.5/3.0 |
| 24 | Additional Damage +X% | 2.5/3.0/3.5 | 3.0/3.5/4.0 |
| 25 | Back Attack damage +X% | 2.0/2.5/3.0 | 2.5/3.0/3.5 |
| 26 | Head/Front Attack damage +X% | 2.0/2.5/3.0 | 2.5/3.0/3.5 |
| 27 | Non-directional skill damage +X% (not Awakening) | 2.0/2.5/3.0 | 2.5/3.0/3.5 |
| 28 | Party shield/heal effects +X% | 2.0/2.5/3.0 | 2.5/3.0/3.5 |
| 29 | Ally Attack Power buff effect +X% | 3.0/4.0/5.0 | 4.0/5.0/6.0 |
| 30 | Ally Damage buff effect +X% | 4.5/6.0/7.5 | 6.0/7.5/9.0 |
| 31 | Crit Rate +X% | 2.6/3.4/4.2 | 3.4/4.2/5.0 |
| 32 | Crit Damage +X% | 5.2/6.8/8.4 | 6.8/8.4/10.0 |
| 33 | Weapon Power +X | 6300/7200/8100 | 7200/8100/9000 |

## Rounding disclaimer

The page states probabilities are rounded to ≥4 digits past the first non-zero digit;
sums may not hit exactly 100%. Normalize in code; do not "fix" the listed numbers.
