# Hero + engagement batch (Battleships-inspired) — design & plan

Status: **shipped**. The hero (`scripts/hero.mjs`, `tw-hero` marker) and items 2–8 are on `main` and pinned by `test/engagement.test.mjs`. Kept as the design record.

Inspiration: battleships.dev (`ariana-dot-dev/battleships/site`) — an austere data
tool given personality by one build-time-rendered, compositor-only animated scene.
We borrow the *pattern*, not the boats: TokenWatch's scene is about tokens and price.

## 1. Hero — "Same model, different bill"

### What the visitor sees (desktop, ~240px tall, sits between the tab nav and the calculator)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Same model. 44 providers.            prompt ●●●●●●●───┬──▶ ▮ $0.020/M  🏆      │
│ Up to 4.3× apart.                                     ├──▶ ▮▮ $0.031/M         │
│                                                       ├──▶ ▮▮▮ $0.046/M        │
│ GLM 5.3 Flash at an agentic mix                       ├──▶ ▮▮▮▮ $0.061/M       │
│ (2.5% input · 97% cached · 0.5% output)               └──▶ ▮▮▮▮▮ $0.085/M      │
│ [ Estimate my workload ↓ ]  [ Compare GLM 5.3 Flash ]                         │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Left:** a one-line pitch with real numbers (provider count and max/min spread),
  the model name and the mix stated explicitly, and two CTAs:
  - *Estimate my workload* scrolls to and focuses the calculator.
  - *Compare <model>* fills the model search, so the summary panel, crossover chart and table appear.
- **Right:** an inline SVG. Token dots stream out of a "prompt" node into five lanes,
  one per provider. Each lane ends in a meter bar sized to that provider's blended $/M,
  and the cheapest lane lights up in the accent colour with a 🏆. One loop is about 8s.

### Data, all real and computed at build time

- The model is the canonical id with the **most distinct priced providers** at `AGENTIC_MIX`.
  - Batch/`:free` rows and non-positive rates are excluded.
  - Ties are broken by id.
  - The choice is deterministic, so the model changes only when the catalog does.
  - Today that is GLM 5.3 Flash: 44 providers, 4.3×.
- The five lanes are the cheapest offering, the 25th/50th/75th percentile providers and the most expensive,
  so the spread is shown honestly rather than cherry-picked.
- Each provider counts once, at its cheapest offering for that canonical id.
- Rates come from `blendedRate()` in `shared/cost.mjs`. This is the same math as the SEO
  table, so there is no new pricing logic.
- No claims beyond the data. Copy says "at an agentic mix" and links to Methodology.
- If no canonical has ≥3 providers, the hero renders the pitch and CTAs without the scene.

### Implementation

- `renderHero(models)` lives in `scripts/seo-pages.mjs` and is a pure function.
  - It is injected by `renderHomepage()` via the existing idempotent `replaceSection(…, 'tw-hero', …)`.
  - Markers are committed in `public/index.html` after `</nav>`.
  - It is regenerated on every deploy, like the SEO table.
- The SVG and CSS are inline in the markup. No new asset file, so the CSP, the `bust-cache`
  list and the preview build are unaffected.
- Animation uses CSS keyframes on `transform`/`opacity` only:
  - Dots use `translateX` along straight lanes.
  - Meters use `scaleX`.
  - Under `prefers-reduced-motion: reduce`, it renders a static final frame.
- App.js gets about 15 LOC:
  - An IntersectionObserver adds `.is-idle` (`animation-play-state: paused`) when the hero is off-screen or the tab is hidden.
  - The two CTA handlers.
- The hero is crawlable: the pitch is real text and the SVG has `role="img"` plus an `aria-label`
  summarising the five rates. There is no extra `h1`; the pitch is a `<p class="tw-hero-pitch">`.
- **Mobile (≤640px):** the scene is hidden and the pitch plus CTAs collapse to about 90px,
  so the calculator stays above the fold.
- **Theme:** uses existing tokens (`--accent`, `--text-dim`, `--border`, `--surface`) and works in both themes.

### Tests

- `renderHero`: deterministic model pick; the percentile-lane pick with dedup per provider;
  the honest spread ratio; HTML escaping; the fallback when fewer than 3 providers exist.
- `generate-seo` idempotence still holds with the new marker.
- The `layout-markup` id-uniqueness checks still pass.

### Open questions for approval

1. Is the hero copy tone right? Proposed: "Same model. N providers. Up to X× apart."
2. Should the hero be dismissible, remembering a per-visitor `localStorage` flag? Proposed: **no** for v1.
3. Text page only (proposed), or also Image/Video?

## 2–8. Approved items (building now)

| # | Item | Where | Notes |
|---|---|---|---|
| 2 | Crossover chart | `#modelSummary`, new `<details>` | Blended $/M against cache-read share from 0 to 100%, one line per provider (top 6 at the current mix), with a marker at the current mix. Pure `crossoverSeries()` plus a hand-drawn SVG. |
| 3 | Re-rank flash | results table | Rows get a stable `data-key`. FLIP animation of rows whose rank changed, plus a short highlight. Disabled under reduced motion and for more than 250 rows. |
| 4 | "Why is it missing?" | above table | When a provider or model search matches offerings that the active filters hide, name each blocking filter with a count, plus a one-click **Turn off** button. Uses a single filter registry shared with `matchingOfferings()`. |
| 5 | Copy agent prompt | results toolbar | Builds a prompt for a coding agent from the current mix, filters, top 5 offerings and share URL, with pointers to `/llms.txt`, `/openapi.json` and `/docs/api/`. |
| 6 | Close matches | below table | The cheapest five offerings that fail exactly one user-set filter, each labelled with the filter it misses. The default batch hiding is never counted. |
| 7 | Jargon tooltips | badges and headers | Hover/focus/tap `data-tip` tooltips for ZDR, cache read/write, blended $/M, promo and TTFT. Keyboard-accessible, about 40 LOC in `shared-ui.js`. |
| 8 | Rules we don't bend | Methodology and home | Static strip: unknown stays unknown; promo is always labelled; the estimate is not an invoice; published raw rates are never altered; direct provider beats reseller in dedup. |
