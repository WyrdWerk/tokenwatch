# TokenWatch SEO, provider discovery, and shareable pricing snapshots

**Date:** 2026-08-11  
**Repository:** `WyrdWerk/tokenwatch`  
**Production:** [tokenwatch.wyrdwerk.com](https://tokenwatch.wyrdwerk.com/)  
**Release commits:** [`fa80217`](https://github.com/WyrdWerk/tokenwatch/commit/fa80217) and [`ccef0cb`](https://github.com/WyrdWerk/tokenwatch/commit/ccef0cb)

## What this session changed

This session moved TokenWatch beyond a client-rendered pricing calculator. It now publishes crawlable pricing and provider pages, carries reviewed policy metadata for Aster Labs, uses one navigation and branding contract across its public surfaces, exports exact cost cards as images, and creates immutable image URLs for single-model and multi-model snapshots.

The work shipped as one feature commit and one deployment-hardening commit. Production was verified against the application, API, generated provider content, hashed assets, and both snapshot-image modes.

## Starting point

TokenWatch already compared pay-as-you-go text, image, and video model pricing. The browser handled cost calculations, filtering, grouping, comparison, budget inversion, ZDR filtering, and CSV export. The text homepage also had a generated top-25 table and an FAQ section.

Three gaps shaped this batch:

1. Search engines could crawl the text homepage, but image and video pricing remained mostly client-rendered. The sitemap exposed only the three calculator pages, so provider and long-tail pricing intent had little durable HTML to land on.
2. A provider detail page could show data only after the underlying catalog and metadata existed. Aster Labs needed a direct parser, policy metadata, and generated provider page rather than a manually maintained one-off page.
3. Users could compare models on screen or copy a comparison as an image, but they couldn't download a complete single-model cost card or share a URL that reproduced the exact frozen card later.

## Research and product decisions

### FAQ content remains useful, but not as a rich-result trick

The SEO/GEO review separated crawlability from presentation features in search results. Google removed ordinary FAQ rich results in 2026. The FAQ content and `FAQPage` data can still make concepts explicit to machines, but neither was treated as a ranking shortcut.

The practical decision was to keep FAQs for stable explanations—price units, cache behavior, token mixes, image units, video variants, and policy labels—while investing in pages that answer concrete pricing questions.

### Generated pages beat hand-maintained pages

Provider pages come from the same catalogs that power the calculators. A provider qualifies only when it has at least three distinct priced model identities across the text, image, and video catalogs. This prevents thin pages and makes stale provider pages disappear automatically when a provider no longer qualifies.

The same generator now owns calculator counts, crawlable tables, structured data, documentation pages, provider pages, sitemap entries, and robots output. Catalog refreshes therefore update the public search surface without a parallel editorial workflow.

### Search pages must preserve pricing semantics

The generated pages reuse TokenWatch's shared cost and normalization functions. They don't invent a second cost formula or collapse model variants differently from the API and browser. Text rankings use the existing agentic mix. Image and video pages choose comparable priced variants and state the unit being ranked.

### Share links must freeze values

A share URL represents the rendered cost card at capture time. It doesn't look the model up again when someone opens the link. Prices, workload basis, ZDR state, speed, blended rate, and total cost are encoded as display values in a bounded payload.

That choice matters. A link sent today should continue to show today's calculation after the live catalog changes.

## SEO and GEO generation

### Shared renderers

`scripts/seo-pages.mjs` became the shared, pure rendering layer for generated search content. It contains the helpers used to:

- rank and render text, image, and video pricing tables;
- generate calculator structured data;
- replace generated sections and JSON-LD safely;
- render current model and provider counts;
- build provider-page collections;
- render shared navigation and provider pages;
- build dynamic sitemap and robots content.

`scripts/generate-seo.mjs` orchestrates those helpers. A current run produces:

- 25 text-model rows on the homepage;
- 25 image-model rows on the image calculator page;
- 25 video-model rows on the video calculator page;
- 68 qualifying provider pages from the current catalog;
- methodology and API documentation pages;
- a sitemap with 74 current URLs;
- refreshed visible FAQ content and matching structured data;
- current title, description, subtitle, and catalog counts.

### Generated provider directory

The provider directory and individual pages live under `public/providers/`. Each provider page can combine text, image, and video offerings, identifies the pricing unit, links back to the relevant calculator, and exposes reviewed policy links when available.

Generation handles slug collisions as errors rather than silently overwriting pages. Old generated provider directories are removed before regeneration, so the directory reflects the current qualification rules.

### Documentation pages

The generator also produces:

- `public/docs/methodology/index.html`
- `public/docs/api/index.html`

These pages explain pricing normalization, source precedence, calculation behavior, and API discovery without depending on JavaScript-rendered calculator state.

### Verification gate

`scripts/verify-seo.mjs` runs before deployment. It checks generated HTML, sitemap targets, metadata, calculator pricing content, visible FAQ and JSON-LD parity, and provider-page integrity.

The final release check reported:

- 75 HTML pages;
- 68 provider pages;
- 74 sitemap URLs;
- calculator pricing, metadata, FAQ parity, and sitemap targets passing.

### Deployment integration

SEO generation and verification now run in every path that can publish the site:

- push-to-main deployment;
- scheduled/manual pricing refresh;
- performance refresh;
- Artificial Analysis refresh.

The deploy sequence is:

1. refresh applicable JSON catalogs;
2. generate SEO pages;
3. run the SEO integrity guard;
4. create content-hashed assets;
5. minify JSON for deployment;
6. deploy to Cloudflare Pages;
7. verify a bare hashed JavaScript URL returns JavaScript rather than the SPA HTML fallback.

`public/h/` remains a deployment artifact. Source HTML keeps stable development references such as `/app.js?v=dev`; CI rewrites them immediately before upload.

## Aster Labs integration

### Direct-provider parser

Aster was added as a Tier-1 direct provider in `scripts/fetch-pricing.mjs`. `parseAster()` in `scripts/lib.mjs` parses its model response into TokenWatch's common text-pricing schema.

The parser handles:

- model and organization identity;
- input and output prices in dollars per million tokens;
- cache-read pricing where published;
- context and output limits;
- missing or malformed records;
- exclusion of unpriced or per-search products that can't be compared as token pricing.

The release catalog contained five priced Aster text models.

### Reviewed policy metadata

Aster's manual provider metadata includes its official privacy and terms URLs, headquarters, zero-retention verdict for inference, zero-day retention, and an intentionally unknown training field.

That distinction is deliberate:

- `retains_prompts: false` reflects Aster's explicit inference FAQ: prompts and outputs are processed in memory and aren't stored by default;
- `retention_days: 0` follows the same inference statement;
- `may_train: null` stays unknown because the reviewed sources didn't make a broad, unambiguous no-training promise for every relevant service.

The provider metadata merge was tightened at the same time. OpenRouter enrichment now fills `retains_prompts`, `may_train`, and `retention_days` only when the manual object doesn't already own that property. Valid manual values such as `false`, `null`, and `0` can no longer be overwritten by truthiness-based checks.

The generated production page is available at [tokenwatch.wyrdwerk.com/providers/aster/](https://tokenwatch.wyrdwerk.com/providers/aster/).

## Shared navigation and branding

The three calculator pages now use one six-link navigation contract:

- Text
- Image
- Video
- Providers
- Methodology
- API

The active calculator uses `aria-current="page"`. The TokenWatch name in the main heading links back to `/`, and generated provider and documentation pages reuse the same brand/navigation pattern.

The existing visual system was extended rather than replaced. Desktop navigation stays on one row; mobile navigation can wrap without forcing page-level horizontal overflow.

## Single-model cost-card export

The text-model detail modal now offers **Download cost card**. The exported PNG contains the exact selected model and current workload calculation.

The card includes:

- title and workload basis;
- provider and model;
- input and output price;
- cache-read and cache-write price;
- Blended $/M;
- ZDR;
- Speed;
- token mix;
- Total Cost.

Missing source values render as an em dash. The renderer doesn't infer speed, ZDR, or pricing data that the catalog doesn't supply.

The card reuses the same accessors and cost functions as the detail and comparison UI. There is no export-only cost formula. The browser builds an off-screen card with live layout, passes it through the shared image renderer, downloads a PNG, restores the button state, and reports success or failure through an `aria-live` status region.

Filenames are deterministic and sanitized from the provider, model, and current cost mode.

## Comparison alignment and image export

The comparison table and its exported image now follow the same column contract:

- metric labels align left;
- values align right;
- model columns use consistent widths;
- long model names wrap at natural boundaries;
- winner highlighting remains readable;
- rows for Speed, Blended $/M, ZDR, and Total Cost use the same source values as the live table.

On narrow screens, horizontal scrolling is isolated to the table wrapper. The modal header, basis line, swipe hint, copy/share actions, and close control remain fixed in the modal. The metric column stays sticky while model columns scroll beneath it, and the document body doesn't acquire horizontal overflow.

## Immutable snapshot URLs

### Browser-side codec and renderer

`public/share-snapshot.mjs` defines the snapshot contract and the self-contained SVG renderer. It supports two snapshot kinds:

- `cost` for a single-model cost card;
- `compare` for a multi-model comparison.

The module:

- validates the schema and version;
- bounds encoded length and decoded JSON size;
- caps rows, columns, labels, values, titles, and basis text;
- requires exactly one model column for cost snapshots;
- accepts no more than six comparison columns;
- uses base64url-safe JSON;
- escapes every dynamic string before inserting it into SVG;
- computes deterministic SVG dimensions from the validated card.

### Cloudflare Pages Function

`functions/share.js` serves `/share?d=<payload>` directly as `image/svg+xml`.

The route supports `GET` and `HEAD` and returns explicit errors for missing, malformed, or oversized payloads. Successful responses include:

- one-year immutable cache control;
- `Content-Type: image/svg+xml; charset=utf-8`;
- `X-Content-Type-Options: nosniff`;
- a restrictive `default-src 'none'` content security policy;
- `X-Robots-Tag: noindex, nofollow`;
- permissive image CORS.

The immutable cache policy is safe because the SVG is a pure function of the payload in the URL.

### Share actions

The single-model detail modal has **Share card**. The comparison modal has **Share snapshot**. Both create a same-origin `/share?d=…` URL.

When the browser supports the Web Share API, TokenWatch opens the native share sheet with the image URL. Otherwise it copies the URL. The existing **Copy as image** and PNG download paths remain available.

### Dynamic-module cache policy

`shared-ui.js` dynamically imports `/share-snapshot.mjs`. That stable URL must not become stale after a codec or renderer update, so `public/_headers` gives it:

```text
Cache-Control: public, max-age=0, must-revalidate
```

The hashed application bundles remain immutable; the snapshot module always revalidates before reuse.

## Tests and review

The final suite contained 290 passing tests and no failures. New or expanded coverage includes:

- `test/share-snapshot.test.mjs`
  - exact-value encode/decode round trips;
  - cost and comparison shape rules;
  - malformed and oversized payload rejection;
  - SVG escaping and column alignment;
  - `GET` and `HEAD` route behavior;
  - response and cache headers.
- `test/aster-parser.test.mjs`
  - Aster model mapping;
  - token and cache pricing;
  - context metadata;
  - malformed and excluded product handling;
  - reviewed provider metadata.
- `test/generate-seo.test.mjs`
  - text, image, and video rankings;
  - structured data and visible FAQ parity;
  - generated section replacement;
  - dynamic counts and homepage metadata;
  - provider collection and collision rules;
  - sitemap and robots generation.
- `test/bust-cache.test.mjs`
  - nested HTML discovery;
  - root-relative hashed references;
  - idempotent rehashing.
- `test/write-if-changed.test.mjs`
  - generated-file stability and unchanged-write suppression.

A separate release review found no security or deployment blockers. The patch also passed `git diff --check`, Node syntax checks, the SEO guard, browser interaction tests, and production smoke checks.

## Visual and behavioral verification

The browser checks covered desktop and mobile behavior rather than relying on source inspection alone.

Observed results included:

- a six-model comparison with every column visible after wrapping;
- complete Speed, Blended $/M, ZDR, and Total Cost rows;
- no label/value overlap in exported images;
- a sticky metric column during mobile table scrolling;
- no page-level horizontal overflow;
- a 568×610 single-model share SVG;
- a 1176×822 six-model comparison SVG;
- successful native-share URL generation;
- direct share URLs returning immutable SVG images;
- the production snapshot module returning JavaScript with `must-revalidate`;
- the production API reporting 1,182 models across 82 providers at release time.

These catalog counts are observations from the release. Scheduled refreshes can change them.

## Deployment incident and fix

The first feature deployment uploaded successfully, but its workflow checked the stable Pages hostname immediately. Cloudflare hadn't propagated the new hashed JavaScript path yet, so the request fell through to the SPA HTML response and the workflow reported a failure.

The hashed file became available shortly afterward on the deployment URL, the stable Pages domain, and the production custom domain. The site was healthy; the check was too eager.

Commit `ccef0cb` fixed the check in all three refresh workflows. Each deploy now checks both the stable Pages origin and the custom production origin, retries up to 12 times with five-second pauses, logs the observed content type, and fails only when an origin never serves `application/javascript` within the retry window.

The next deployment run completed successfully.

## Release outcome

Commit `fa80217` shipped the SEO/GEO generation, provider pages, Aster data and policy metadata, shared navigation, cost-card image export, comparison alignment, and immutable snapshot URLs.

Commit `ccef0cb` hardened the deployment smoke checks against Cloudflare propagation delay.

At the end of the session:

- local `main` matched `origin/main`;
- the working tree was clean;
- the full regression suite passed;
- the SEO integrity guard passed;
- Cloudflare Pages deployed the current revision;
- production calculator, API, Aster page, hashed assets, cost-card URL, and comparison URL were exercised successfully.

## Follow-up opportunities

The work is complete, but several extensions fit the same architecture:

1. Generate selected model and workload pages where the content can remain substantial and non-duplicative.
2. Monitor Search Console discovery and indexing before increasing page volume.
3. Add historical price snapshots and price-change pages once the data has enough depth.
4. Revisit Aster's `may_train` field only if an official source states a service-wide training policy clearly enough to replace `null`.
5. Keep snapshot schema changes backward-compatible or introduce an explicit new version; old immutable URLs should continue rendering their original cards.

The session's main rule was simple: one live data model, one calculation path, and generated public surfaces that fail closed when their inputs stop making sense.
