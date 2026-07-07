# TokenWatch — Budget Mode + Compare Mode + Mobile Fix

**Session date**: 2026-07-07
**Commits**: 4 (all deployed to Cloudflare Pages)
**Live site**: https://tokenwatch.wyrdwerk.com

## Overview

This session shipped three major features for TokenWatch, a static site comparing pay-as-you-go LLM/image/video inference pricing across 75+ providers:

1. **Budget Mode** — an inversion of the cost math that lets users enter a $ budget and see how many tokens/images/seconds they can afford across providers
2. **Compare Mode** — ported the compare-up-to-6 feature from the text tab to the image and video tabs (which previously had no comparison capability), plus a "Basis:" snapshot header inside the compare modal
3. **Mobile Compare Fix** — fixed a bug where the compare checkbox was invisible on mobile, preventing any model selection for comparison on phones

---

## 1. Budget Mode

### The Problem

The existing site answers: "If I run X tokens, what does it cost?" Users wanted the inverse: "I have $Y budget — how many tokens/images/seconds can I afford?" This is closer to actual procurement planning.

### The Math

Budget Mode inverts the forward cost function (`costFor`) into an affordability function (`affordabilityFor`):

```
affordableUnits = (budget - fixedCharge) / effectiveRate
```

Where:
- `effectiveRate` = the blended $/unit rate from the user's percentage breakdown (input %, cached %, output %)
- `fixedCharge` = one-time cache-write charge amortized over N requests (text tab only)
- `budget` = user's dollar budget (per session, or per month in monthly mode)

The math is a clean algebraic inversion — linear in both directions. The percentage breakdown stays constant across providers, so the comparison is apples-to-apples.

### Design Conventions

| Convention | Decision | Rationale |
|---|---|---|
| `r.cost` storage | Raw positive affordable quantity (never negated) | Sort comparator handles Infinity > finite with dir=-1 |
| Sort direction | Auto-flips to `desc` in budget mode (only on cost column) | Most-affordable-first = best-first |
| Display format | Raw count with thousands separators, no K/M/T suffixes | Suffix collides with header's own "(M)" unit — "2.0K" is ambiguous |
| Exclusion filter | `budget ≤ fixedCharge → null` (offering dropped) | Can't even cover the one-time setup charge |
| Free offerings | `effectiveRate = 0 → Infinity` | Displayed as ∞ badge; ranks top in budget mode |

### Per-Tab Adaptation

| Tab | Unit | Formula | Exclusion |
|---|---|---|---|
| Text | M tokens | `(budget - cwFixed) / effectiveRate` | Null when offering can't serve the token mix; null when budget ≤ cache-write fixed charge |
| Image | images | `budget / costPerImage` | Only `image`-unit rows; `megapixel`/`token` rows keep existing "varies" exclusion |
| Video | seconds | `budget / costPerSecond` | Null when no per-second pricing for selected resolution |

### UI

A "Compute by" toggle above the existing Per Session / Monthly toggle:

```
Compute by:  [Tokens → Cost]   [Budget → Tokens]
```

In Budget mode:
- The token/count/seconds input is hidden
- A "Budget $" input appears (default $20)
- The "Total Cost" column header becomes "Affordable Tokens (M)" / "Affordable Images" / "Affordable Seconds"
- Sort direction auto-flips to descending (most-affordable first)
- The URL hash persists `by=budget&budget=20` for shareable affordability comparisons

### Monthly Mode Interaction

In monthly mode, the budget is the monthly budget. Per-session budget = monthly / 30. The affordable quantity is computed per-session, then ×30 for the monthly display — symmetric with how the forward mode scales cost ×30.

---

## 2. Compare Mode + Snapshot Header

### The Problem

The text tab had a compare-up-to-4 feature (select rows via checkboxes → side-by-side modal). The image and video tabs had **no compare infrastructure at all**. Additionally, users couldn't tell what the comparison basis was without scrolling back to the page controls.

### What Shipped

**Compare Mode ported to image + video tabs:**
- Per-row checkboxes in the results table
- Fixed tray at the bottom with count + Compare/Clear buttons
- Modal with side-by-side metrics table
- Budget-aware headline row: "Total Cost" (forward) ↔ "Affordable Images/Seconds/Tokens" (budget)
- Dedup keys adapted per tab: text uses `id+provider`, image uses `id+provider+variant+rawUnit`, video uses `id+provider+resolution+audio` (so users can compare variants of the same model)
- Compare stores full row objects (with `r.pricing`) not bare models — image/video rows have a different data shape than text rows

**Snapshot header inside the compare modal:**

| Tab | Forward | Budget |
|---|---|---|
| Text | `1,000M tokens · mix: Input 2.5% / Cached 97% / Output 0.5%` | `Budget $20 (per session) · mix: Input 2.5% / Cached 97% / Output 0.5%` |
| Image | `100 images` | `Budget $20` |
| Video | `60 seconds` | `Budget $20` |

No more reverting to the page to check the comparison basis.

**Compare cap raised from 4 to 6** per user request. The modal has `overflow: auto` so 6 columns scroll on narrow screens.

---

## 3. Mobile Compare Fix

### The Bug

On mobile (≤640px), the results table transforms into stacked cards. The rank column (`data-label="#"`) — which contains the compare checkbox — was set to `display: none` in the mobile CSS. This made the checkbox invisible and untappable on mobile. Users couldn't select models for comparison at all — "nothing happens when I click Compare on mobile."

### The Fix

Changed the mobile CSS rule from `display: none` to `display: flex` for the rank cell, and suppressed the `::before` pseudo-element label (so it doesn't render a stray "#" in card mode). The checkbox is now visible at the top of each card, tappable, and the compare flow works end-to-end on mobile.

Verified at 390px viewport: checkbox visible (13px, tappable), selecting 2 models works, tray appears, Compare opens modal with snapshot header, 6-cap enforced (7th checkbox disabled).

---

## Commits

| Commit | Description | Files | Lines |
|---|---|---|---|
| `bce3c2d` | Budget mode — invert cost math to affordability across all 3 tabs | 7 | +548 −77 |
| `25bb70c` | Compare mode + snapshot header across all 3 tabs | 6 | +378 −30 |
| `40d5996` | Mobile compare checkbox hidden + raise compare cap to 6 | 7 | +14 −13 |
| `b250fb1` | Fix stale max-4 comment in state (now max 6) | 1 | +1 −1 |

All commits deployed to Cloudflare Pages via GitHub Actions (auto-deploy on push to main).

---

## Technical Notes

### Key functions added

- `affordabilityFor(pricing, tokens, budget)` — inverse of `costFor`: `(budget - cwFixed) / effectiveRate`
- `fmtAffordability(tokens_M)` — raw count with `toLocaleString()`, Infinity → ∞ badge, null → N/A
- `setComputeBy(mode)` — toggles computeBy state, swaps input fields, flips sortDir on cost column
- `updateLabelsAndHeaders()` — 4-state label/header logic (computeBy × costMode)
- `globalBestValue(rows)` — replaces `globalCheapestCost`: min forward / max budget (Infinity ranks top)

### CSS additions

- `.compute-by-toggle` + `.compute-btn` — the Compute by toggle button group
- `.compare-snapshot` + `.snapshot-label` — the Basis header inside the compare modal
- Mobile fix: `#resultsTable td[data-label="#"]` changed from `display: none` to `display: flex`

### Cache-bust

All 3 HTML pages bumped from `?v=20260707b` → `?v=20260707c` → `?v=20260707d` across the session.

### Data shape difference across tabs

| Tab | Row shape | `pricing` location | Dedup key |
|---|---|---|---|
| Text | `{ model }` | `m.pricing` (flat) | `id + provider` |
| Image | `{ model, pricing, unit, variant }` | `r.pricing` (from `m.pricing[]`) | `id + provider + variant + rawUnit` |
| Video | `{ model, pricing, resolution, audio }` | `r.pricing` (from variant) | `id + provider + resolution + audio` |

This difference is critical when porting features across tabs — function signatures must pass `r.pricing` (the pricing object), not the model, for image/video tabs.
