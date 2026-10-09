# TokenWatch — ToDos

Open items only. The prioritized roadmap is "Next steps" in `AGENTS.md`;
shipped work is recorded in git history, `docs/adr/` and `docs/conversations/`.

## Text catalog

- **Subscription pricing details**: show plan pricing (monthly cost, token quotas) for subscription providers. Needs a data source such as codingplans.cc or a manually maintained CSV.
- **Auth-gated direct providers**: SingularityAPI and RunInfra are wired. Cerebras, Groq, Together, SiliconFlow, Fireworks, Baseten, Hyperbolic, Replicate and Mistral stay postponed because OpenRouter backends already cover them.
- **EmberCloud provider metadata**: `MANUAL_PROVIDER_META` for ember has privacy/ToS URLs but no HQ/datacenters, and its ZDR status is undetermined.
- **ZDR details**: a hover tooltip with retention policy details, and retention days in the comparison modal (only the badge is shown today).
- **Turbo/preview grouping**: turbo and preview variants are separate rows. A UI could group them with their base model.
- **models.dev normalizers**: tune per-provider ID normalizers as miss patterns appear in logs. DeepInfra is absent from models.dev, so it can never match.

## Image and video catalogs

- **Seedance video models**: excluded because they only have per-token pricing and no per-second SKUs.
- **Token-priced image models**: they show $/M image-tokens but cannot be turned into a per-image cost without a tokens-per-image ratio from the provider.
- **Image/video detail cards**: deferred because models.dev has no image/video pricing.

## Price history

- The production rollout shipped on 2026-10-03 (see `docs/adr/0011-price-history-snapshots.md`). Two pieces are still unbuilt: wiring the sparkline into the text-calculator summary, and price-drop alerts.
