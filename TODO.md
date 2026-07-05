# TokenWatch — ToDos

## Critical bugs

### STALE CACHE — column misalignment on returning visitors
**Status**: Code is correct in production. The deployed index.html has 10 `<th>` headers and app.js renderModelRow outputs 10 matching `<td>` cells in the correct order. Verified against live site.

**Real cause**: `<script src="app.js">` and `<link rel="stylesheet" href="styles.css">` have no cache-busting. Returning visitors get the OLD cached 9-cell app.js rendered against the NEW 10-column HTML header — causing data to appear in wrong columns (context in cache/write, total cost in context, total cost empty). This is a stale-browser/CDN cache issue, not a code bug.

**Fix**: Add cache-busting query strings to app.js and styles.css in index.html:
```html
<link rel="stylesheet" href="styles.css?v=20260705" />
<script src="app.js?v=20260705"></script>
```
Or use a content hash. Update the version string on each deploy. A hard-refresh (Ctrl+Shift+R) confirms the fix immediately.

### MOBILE RESPONSIVE LAYOUT
The 10-column table is too wide for mobile screens. Needs work:
- Table is too wide for mobile screens
- Horizontal scroll fallback is functional but not great
- Consider card layout on mobile (≤640px)
- Usage grid stacking needs testing


## Planned features

### ZDR (Zero Data Retention) enhancements
**Status**: Not implemented. No API source available — needs manual data.

The OpenRouter `/api/v1/providers` endpoint provides privacy_policy_url, terms_of_service_url, status_page_url, headquarters, and datacenters — but NO structured ZDR/data-retention field. There is no way to filter or badge providers by ZDR status from any API we're using.

**Implementation plan**:
1. Create `MANUAL_PROVIDER_ZDR` map in `fetch-pricing.mjs` (similar to `MANUAL_PROVIDER_META`) where each provider is flagged with:
   - `zdr_supported`: boolean — does the provider offer Zero Data Retention?
   - `no_training`: boolean — does the provider commit to not training on customer data?
   - `retention_days`: number or null — data retention period (0 = ZDR, 7/30/90 = limited retention)
   - `source`: link to where this info was verified (privacy policy section, ToS clause, etc.)
2. User needs to provide ZDR data for providers — this is manual research, not API-fetchable
3. Add `zdr` field to `providers_meta` in pricing.json (merge with existing metadata)
4. Frontend enhancements:
   - ZDR badge in provider cell (like HQ flag badges) — e.g. 🔒 icon or "ZDR" pill
   - "ZDR only" filter toggle (like "Promos only")
   - Data retention info in comparison modal
   - Tooltip showing retention policy details on hover
5. API support: add `?zdr=true` filter to `/api/v1/models`

**Providers known to offer ZDR** (from user input — verify before committing):
- OpenCode Go: mentions ZDR at https://opencode.ai/go
- Others need research

**Dependencies**: User must provide ZDR status per provider before implementation.

### Auth-gated direct providers (A1 — postponed)
Cerebras, Groq, Together, SiliconFlow, Fireworks, Baseten, Hyperbolic, Replicate, Mistral all have auth-gated `/v1/models` endpoints. All are already covered as OpenRouter backends (Tier 2). Direct fetch would give Tier-1 precedence + fresher data, not new model coverage. Postponed until user has API keys.

### Historical price tracking (A7 — not started)
Store daily pricing.json snapshots to enable price-drop alerts, trend charts, and "cheapest this model has ever been" features. Would require a `pricing-history/` archive or Cloudflare D1/KV storage.

### EmberCloud provider metadata
`MANUAL_PROVIDER_META` for ember has privacy/ToS URLs filled but no HQ/datacenters — update if available.

### Turbo/preview model grouping
Currently turbo and preview variants are kept separate. Could add UI to group them with their base model.

### Cache write in cost computation
Currently display-only. Could add a separate "cache write tokens (one-time)" input with amortization over N requests.
