# Architecture

> Full pipeline diagram for TokenWatch. For prose conventions see `AGENTS.md`;
> for canonicalization traps see `docs/canonicalization-edge-cases.md`;
> for settled design choices see `docs/adr/`.

## Pipeline

TokenWatch runs **three parallel fetch pipelines** — text, image, and video —
each with its own source fetch, dedup, and output. Only the text pipeline runs
the non-fatal sidecar enrichments (models.dev, benchmarks, ZDR); image and video
do org resolution and dedup only. A separate performance fetcher writes its own
JSON. Outputs are served by a Cloudflare Pages Functions API and a
zero-dependency static frontend.

```mermaid
flowchart TD
    %% ── TEXT PIPELINE ──────────────────────────────────────
    subgraph TEXT["Text pipeline (scripts/fetch-pricing.mjs)"]
        direction TB
    subgraph T1T["Tier 1 — Direct providers (authoritative)"]
      T1A["DeepInfra /v1/models"]
      T1B["Crof /v1/models"]
      T1C["EmberCloud /v1/models"]
      T1D["Wafer /v1/models"]
      T1E["Synthetic /v1/models"]
      T1F["Lilac /v1/models"]
      T1G["SambaNova /v1/models"]
      T1H["HyperCharm /v1/models"]
      T1I["Sference /v1/models"]
      T1J["Neuralwatt /v1/models"]
      T1K["Merius /v1/models"]
      T1L["Aster Labs /v1/models"]
      T1M["SingularityAPI /v1/models (auth)"]
      T1N["RunInfra /v1/models (auth)"]
    end
        subgraph T2T["Tier 2 — OpenRouter de-aggregated"]
            T2A["/v1/models aggregate"]
            T2B["/endpoints per model (~317 calls)"]
            T2A --> T2B
        end
        subgraph T3T["Tier 3 — CSV / hardcoded"]
            T3A["Makora / Xiaomimimo CSV"]
            T3B["OpenCode Go hardcoded"]
            T3C["Umans manual table"]
        end
        T1T --> DEDUPT
        T2T --> DEDUPT
        T3T --> DEDUPT
        DEDUPT["Dedup key: canonicalId(m.id) | normalized_provider<br/>precedence: T1 > T2 > T3 (first-seen wins)<br/>quant suffixes PRESERVED → distinct quants = distinct rows"]
    end

    %% ── IMAGE PIPELINE ────────────────────────────────────
    subgraph IMG["Image pipeline (scripts/fetch-images.mjs)"]
        direction TB
        subgraph IMG1["Tier 1 — fal.ai (authoritative for image)"]
            IMG1A["fal.ai /v1/models<br/>+ /v1/models/pricing per endpoint<br/>falCanonicalId preserves modality"]
        end
        subgraph IMG2["Tier 2 — OpenRouter image rows"]
            IMG2A["/api/v1/images/models<br/>+ /images/models/:id/endpoints<br/>3 unit types: image / megapixel / token"]
        end
        IMG1A --> DEDUPIMG
        IMG2A --> DEDUPIMG
        DEDUPIMG["Dedup with Tier-1 precedence<br/>fal.ai prepended → first-seen wins<br/>org extraction via shared lib"]
    end

    %% ── VIDEO PIPELINE ────────────────────────────────────
    subgraph VID["Video pipeline (scripts/fetch-videos.mjs)"]
        direction TB
        subgraph VID1["Tier 1 — fal.ai (authoritative for video)"]
            VID1A["fal.ai /v1/models<br/>+ /v1/models/pricing per endpoint<br/>falCanonicalId preserves modality"]
        end
        subgraph VID2["Tier 2 — OpenRouter video rows"]
            VID2A["/api/v1/videos/models<br/>pricing_skus on model level<br/>(no endpoint fetch)"]
        end
        VID1A --> DEDUPVID
        VID2A --> DEDUPVID
        DEDUPVID["Dedup with Tier-1 precedence<br/>fal.ai prepended → first-seen wins<br/>org extraction via shared lib<br/>cents→dollars; non-per-second filtered"]
    end

    %% ── TEXT-ONLY ENRICHMENTS (post-dedup, non-fatal) ──────
    DEDUPT --> ENRICH
    subgraph ENRICH["Text sidecar enrichments (non-fatal, text-only)"]
        E1["models.dev ~40%<br/>exact + bounded fuzzy"]
        E2["Benchmarks ~75%<br/>AA indices + design_arena Elo"]
        E3["ZDR tagging<br/>endpoint-level + provider fallback"]
    end

    %% ── PERFORMANCE (separate fetcher) ────────────────────
    PERF["Performance fetcher (scripts/fetch-performance.mjs)<br/>latency / throughput percentiles"]
    PERF --> OUT

    %% ── OUTPUTS ───────────────────────────────────────────
    ENRICH --> O1
    DEDUPIMG --> O2
    DEDUPVID --> O3
    subgraph OUT["Outputs → public/"]
        O1["pricing.json ~940 text models"]
        O2["image-pricing.json ~160 models"]
        O3["video-pricing.json ~100 models"]
        O4["performance.json ~1000 records"]
    end

    %% ── SERVING ───────────────────────────────────────────
    OUT --> API["Cloudflare Pages Functions<br/>functions/api/v1/[[route]].js<br/>14+ filters, sort, pagination, CORS"]
    OUT --> FE["Static frontend public/<br/>3 tabs, client-side cost calc,<br/>search, comparison, CSV export<br/>canonicalModelId() parity-guarded"]
    API --> FE
```

## Invariants

Three behavioral contracts the diagram can't show, but an agent must respect:

1. **Dedup key is `canonicalId(m.id) | normalized_provider`; quantization is
   included.** `dedupKey()` in `scripts/lib.mjs:162` uses `canonicalId()`, which
   preserves quant suffixes (`-fp8`, `-nvfp4`, `-int4`, etc.). So different quants
   of the same model+provider produce **distinct dedup keys** and stay distinct
   rows (`test/canonicalization.test.mjs:88-97`). First-seen / highest-tier wins
   among identical keys only. (Note: `orgLookupKey` strips quant for org
   resolution only — it is NOT the dedup key; see
   `docs/canonicalization-edge-cases.md` §2.)

2. **Text enrichments are non-fatal; image/video have none.** A text sidecar
   failure (models.dev down, Artificial Analysis index stale, ZDR endpoint
   unreachable) must never block the 2-hourly deploy — the pipeline writes what it
   has and ships. Image and video pipelines do not run these enrichments at all;
   they do org extraction and dedup only, then write.

3. **`canonicalId` is the single source of truth.** It lives in
   `shared/normalize.mjs` — pure ESM, no `node:` imports, Worker-bundleable —
   imported by both the Node pipeline (via `scripts/lib.mjs`) and the Cloudflare
   Pages Function. The static frontend's `canonicalModelId()` in `public/app.js`
   is an **intentional parity mirror** (the frontend has no bundler), guarded
   against drift by `test/parity.test.mjs`. It is not the sole implementation
   everywhere, but `shared/normalize.mjs` is the sole *source of truth*. See
   `docs/canonicalization-edge-cases.md` before touching either.

## Three pipelines, not one

- **Text** (`fetch-pricing.mjs`) runs 3-tier: direct `/v1/models` providers →
  OpenRouter de-aggregated `/endpoints` → CSV/hardcoded. Direct wins. After
  dedup, the three non-fatal sidecars (models.dev, benchmarks, ZDR) enrich the
  merged rows. Writes `pricing.json`.
- **Image** (`fetch-images.mjs`) runs 2-tier: fal.ai Tier-1 (prepended) +
  OpenRouter `/api/v1/images/models` + per-model `/endpoints`. Three pricing unit
  types (image / megapixel / token). Org extraction + dedup only — no sidecar
  enrichments. Writes `image-pricing.json`.
- **Video** (`fetch-videos.mjs`) runs 2-tier: fal.ai Tier-1 (prepended) +
  OpenRouter `/api/v1/videos/models` with model-level `pricing_skus` (no
  endpoint fetch). Cent→dollar normalization; non-per-second keys filtered.
  Org extraction + dedup only — no sidecar enrichments. Writes `video-pricing.json`.
- **fal.ai is a Tier-1 source for both image and video**, not a post-dedup
  sidecar on the text pipeline. `falCanonicalId` (in `scripts/lib.mjs`) preserves
  modality suffixes `canonicalId` would strip. fal fetch is non-fatal (returns
  `[]` on failure; image/video continue without it).
- **Performance** (`fetch-performance.mjs`) is a separate fetcher writing its own
  `public/performance.json`; not part of any of the three content pipelines.
