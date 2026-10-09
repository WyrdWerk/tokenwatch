# Recommender data contract

This document records the data contract used by the model/provider recommender. Field names are consumed by the scoring engine; do not rename them without coordinating that consumer.

## Resolved open-weight status

Every offering in `public/pricing.json` has these top-level fields:

- `open_weights`: `true`, `false`, or `null` when unknown.
- `open_weights_source`: `override`, `modelsdev`, `org_prior`, or `null`.
- `license`: source-cited override license when reviewed; otherwise the models.dev `models.json` license or most common provider-catalog license, or `null`.

`shared/open-weights.mjs` resolves each offering in this order:

1. Exact or base-ID entry in `data/open-weights-overrides.json`, with a source URL and review note on every entry. `license` is optional in the file; an omitted value falls back to models.dev.
2. Strict majority of known booleans from all models.dev providers, not just TokenWatch-mapped providers. A provider contributes at most one vote per base model; ties do not resolve.
3. Known-closed creator-org prior: `anthropic`, `xai`, `amazon`, and `perplexity` resolve false. There are no positive org priors; unknown or mixed orgs remain unknown.
4. `null` when no source resolves the value.

For lookup only, terminal `:batch`, `-turbo`, and `-fast` suffixes are stripped; the offering ID itself is not changed. Model-level license strings are fetched from `https://models.dev/models.json`; provider-level data and open-weight votes come from `https://models.dev/api.json`.

The status describes model weight availability, not the license's permissions. Preserve license text as a separate field; do not infer `open_weights` from a license name.

## Endpoint capabilities

OpenRouter `/endpoints` offerings expose these top-level values:

| Field | Type | Source |
|---|---|---|
| `supported_parameters` | string array or `null` | Endpoint `supported_parameters` |
| `supports_tool_choice` | boolean or `null` | Endpoint flag; when OpenRouter reports per-choice booleans, true means at least one choice is supported, false means all reported choices are false |
| `supports_implicit_caching` | boolean or `null` | Endpoint flag |
| `max_prompt_tokens` | integer or `null` | Endpoint limit; when null, filled from the same provider's models.dev `limit.input` |
| `uptime_1d` | number or `null` | Endpoint `uptime_last_1d` |

Direct-provider offerings use `null` for these endpoint-specific fields unless the provider API supplies an equivalent. Unknown is not false.

## models.dev offering facts

Every offering also carries two top-level fields, matched by provider and model (never borrowed from another host):

| Field | Type | Rule |
|---|---|---|
| `lifecycle_status` | `'deprecated'`, `'beta'`, `'alpha'` or `null` | models.dev `status` from an exact match or a `:batch` row's base model. A fuzzy (base id → suffixed SKU) match never sets it. The recommender never ranks a `deprecated` offering and adds a pre-release warning for `beta`/`alpha`. |
| `context_price_tiers` | array or `null` | `[{ above_tokens, input, output, cache_read, cache_write }]`, ascending, $/M for single requests above `above_tokens`. Attached only when the offering's own input and output equal the models.dev base tariff (within 1%), so promo, `:batch` and differently priced rows never inherit tiers. Cost math still uses `pricing`; the recommender adds a long-context price warning. |

Rows billed at the write tariff (`pricing.input_billing: 'cache_write'`, e.g. CoralBricks) never take `cache_read`/`cache_write` from models.dev: an unknown tariff stays unknown.

The `modelsdev` and `modelsdev_model` blocks also carry `reasoning_options` (models.dev `reasoning_options`, sanitized; `[]` means none listed) and `interleaved_reasoning` (`true` or `null`). `providers_meta` entries may carry `setup_env` (every env var the provider needs per models.dev — unordered, shell-safe names only) and `ai_sdk_package`, filled from models.dev only when absent.

## API and benchmark surfaces

- `GET /api/v1/models?open_weights=true` and `?open_weights=false` filter by resolved boolean status; unknown values are excluded from either filter.
- `GET /api/v1/models/:canonicalId/providers` includes the resolved open-weight fields, `license`, endpoint capability fields, `lifecycle_status`, and `context_price_tiers` on each provider offering.
- `public/benchmarks.json` includes `open_weights` and `license` at model level. Each offering carries `quantization`, `zdr`, `context_length`, `uptime_30m`, `open_weights`, `tool_call`, `throughput_p50`, and `latency_p50`. `tool_call` uses OpenRouter `supported_parameters` first (`tools` means true; an available array without it means false), then models.dev. Performance values join from `performance.json` by `canonicalModelId|provider`; unavailable values stay `null`.

## Coverage guardrails

`test/parity.test.mjs` enforces at least 55% non-null open-weight coverage across canonical IDs and at least 80% populated `supported_parameters` coverage across OpenRouter endpoint offerings after a live catalog refresh. The default committed-snapshot test run skips generated-data mix floors unless `TW_PARITY_LIVE=1` is set.
