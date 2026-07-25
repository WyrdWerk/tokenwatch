# ADR 0007 — fal.ai Tier-1 precedence merge

**Status:** Accepted

## Context

Image and video generation models come from OpenRouter and fal.ai. fal.ai
exposes its own `/v1/models` with per-endpoint pricing and modality identity that
OpenRouter's aggregate rows lack. Without precedence, the same image/video model
could appear twice with conflicting pricing.

## Decision

fal.ai is a **Tier-1 source** for image/video, prepended to OpenRouter image/video
rows, then deduped with fal.ai winning. `falCanonicalId()` (in `scripts/fetch-fal.mjs`)
preserves nested endpoint/modality suffixes that `canonicalId` would strip,
because fal's image/video endpoints are distinct despite sharing a base model.
Fetch is non-fatal. (Source: `docs/superpowers/specs/2026-07-09-fal-ai-integration-design.md`,
DD-1 through DD-6.)

## Consequences

- **Enables:** one authoritative price per image/video model+provider; modality
  identity preserved.
- **Costs:** a separate `falCanonicalId` diverges from `canonicalId` — an extra
  canonicalization surface to maintain.
- **Forbids:** routing fal.ai through `canonicalId` (would collapse distinct
  image/video endpoints onto their base model) or treating fal.ai as a sidecar
  on the text pipeline (it is a Tier-1 source for the image/video pipeline).
