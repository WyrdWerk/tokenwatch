# Recommender data contract

This document records the data contract used by the model/provider recommender. Field names are consumed by the scoring engine; do not rename them without coordinating that consumer.

## Resolved open-weight status

Every offering in `public/pricing.json` has these top-level fields:

- `open_weights`: `true`, `false`, or `null` when unknown.
- `open_weights_source`: `override`, `modelsdev`, `org_prior`, or `null`.
- `license`: the most common non-empty models.dev license string for the canonical model, or `null`.

`shared/open-weights.mjs` resolves once per `canonicalId`, in this order:

1. `data/open-weights-overrides.json`, with a source URL and review note on every entry.
2. Strict majority of known models.dev booleans. A tie is not a majority.
3. Creator-org prior: `anthropic`, `xai`, `amazon`, and `perplexity` resolve false; `moonshot`, `z-ai`, `mistral`, `nvidia`, and `deepseek` resolve true. Other orgs, or multiple distinct orgs for one canonical ID, resolve unknown.
4. `null` when no source resolves the value.

The status describes model weight availability, not the license's permissions. Preserve license text as a separate field; do not infer `open_weights` from a license name.

## Endpoint capabilities

OpenRouter `/endpoints` offerings expose these top-level values:

| Field | Type | Source |
|---|---|---|
| `supported_parameters` | string array or `null` | Endpoint `supported_parameters` |
| `supports_tool_choice` | boolean or `null` | Endpoint flag; when OpenRouter reports per-choice booleans, true means at least one choice is supported, false means all reported choices are false |
| `supports_implicit_caching` | boolean or `null` | Endpoint flag |
| `max_prompt_tokens` | integer or `null` | Endpoint limit |
| `uptime_1d` | number or `null` | Endpoint `uptime_last_1d` |

Direct-provider offerings use `null` for these endpoint-specific fields unless the provider API supplies an equivalent. Unknown is not false.

## API and benchmark surfaces

- `GET /api/v1/models?open_weights=true` and `?open_weights=false` filter by resolved boolean status; unknown values are excluded from either filter.
- `GET /api/v1/models/:canonicalId/providers` includes the resolved open-weight fields, `license`, and endpoint capability fields on each provider offering.
- `public/benchmarks.json` includes `open_weights` and `license` at model level. Each offering carries `quantization`, `zdr`, `context_length`, `uptime_30m`, `open_weights`, `tool_call`, `throughput_p50`, and `latency_p50`. Performance values join from `performance.json` by `canonicalModelId|provider`; unavailable values stay `null`.

## Coverage guardrails

`test/parity.test.mjs` enforces at least 55% non-null open-weight coverage across canonical IDs and at least 80% populated `supported_parameters` coverage across OpenRouter endpoint offerings after a live catalog refresh. The default committed-snapshot test run skips generated-data mix floors unless `TW_PARITY_LIVE=1` is set.
