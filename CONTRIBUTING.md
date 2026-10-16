# Contributing to TokenWatch

## Adding or updating an inference provider

**Open an issue with the [provider request form](https://github.com/WyrdWerk/tokenwatch/issues/new?template=provider-request.yml).** Please don't open a pull request that adds prices, CSV rows or hardcoded tables: TokenWatch fetches every price from the provider's own published source on each refresh, and maintainers write and maintain that integration.

What we need from you is in the form: where the machine-readable prices live, the pricing page, privacy policy, terms, and what the policy says about retention and training. An optional contact lets us reach you if your pricing source breaks.

### How a request is handled (maintainers and agents)

1. **Pick the source, in this order:** a public machine-readable endpoint (`/v1/models` with pricing, `pricing.json`) → an authenticated endpoint (key stored as a GitHub secret) → scraping the provider's own pricing page. A CSV or hardcoded list is a last resort and needs a written reason in the PR.
2. **Verify against the primary source.** Every price, context length, retention and training claim must trace to a URL; cite it in a code comment next to the value.
3. **Normalize:** store USD per 1M tokens. Leave cache prices `null` unless the provider sells one — never copy the input price. Never publish a zero or missing price as free. Batch-only models carry `:batch`; service tiers carry `:<tier>` (see [docs/recommender-data-contract.md](docs/recommender-data-contract.md) §Delivery variants).
4. **Provider metadata:** add a `MANUAL_PROVIDER_META` entry (privacy, terms, status, HQ, datacenters, `retains_prompts`, `may_train`, `retention_days`, optional `retention_note`). Unknown stays `null`; ZDR only when the policy says prompts are not retained.
5. **Tests:** a parser test with a saved copy of the provider's real response, then `npm test` and a full `node scripts/fetch-pricing.mjs --dry-run` showing the provider's rows.
6. **After merge:** run a refresh and check the rows on the live site before closing the issue.

[scripts/lib.mjs](scripts/lib.mjs) `parseBatchrate()` / `parseAvian()` are small examples of a direct-provider parser.

## Other changes

Bug fixes and improvements are welcome as pull requests. Run `npm test` before opening one; CI runs the same suite plus the SEO checks. For larger changes, open an issue first.
