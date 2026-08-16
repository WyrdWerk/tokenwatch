/**
 * shared/benchmark-org.mjs — pure model-creator (org) resolution for the Benchmarks page.
 *
 * Extracted verbatim from scripts/fetch-benchmarks.mjs so the 4-layer org-resolution
 * logic can be unit-tested hermetically instead of only through the committed
 * public/benchmarks.json artifact (which made the test fragile to upstream slugs
 * being renamed/removed — e.g. Wafer renaming "glm5.2-fast" took the regression
 * pin with it in 2026-08).
 *
 * Layer 1: resolveOrg() — prefer an offering whose org differs from its provider
 *           slug/name (an org equal to the host is an extraction fallback leak).
 * Layer 2: cleanOrg()   — an org equal to ANY provider slug is never trusted.
 * Layer 3: familyOrg    — variants inherit the base model's resolved creator via
 *           familyKey() (dash-insensitive, variant/quant/reseller-stripped).
 * Layer 4: orgFromPrefix() — leading-token creator map for ids whose offerings all
 *           failed extraction (canonical ids are bare — no org/ prefix left).
 *
 * No node: imports — Worker-safe, same convention as shared/normalize.mjs and
 * shared/cost.mjs.
 */

// Variant family key: strip variant/quant suffixes so kimi-k3-fast inherits the
// creator resolved for kimi-k3 (moonshot), glm-5.2-fast -> glm-5.2 (z-ai)...
// Reseller prefixes (umans-) are stripped too, and the key is dash-insensitive
// so alternate spellings (glm5.2 vs glm-5.2) share a family.
export const VARIANT_SUFFIX_RE = /(?:[-:](?:fast|turbo|flex|short|batch|preview|low|high|mini|thinking|instant|nvfp4|fp8|int4|int8|awq))+$/;

export function familyKey(cid) {
  return cid.replace(/^umans-/, '').replace(VARIANT_SUFFIX_RE, '').replace(/[^a-z0-9.]/g, '');
}

// Leading-token creator map for ids whose offerings all failed extraction.
export const FAMILY_ORG_PREFIX = [
  ['claude', 'anthropic'], ['sonnet', 'anthropic'], ['opus', 'anthropic'], ['haiku', 'anthropic'],
  ['gpt', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['o4', 'openai'], ['codex', 'openai'],
  ['gemini', 'google'], ['gemma', 'google'], ['palm', 'google'],
  ['grok', 'x-ai'], ['glm', 'z-ai'], ['kimi', 'moonshot'], ['qwen', 'alibaba'],
  ['deepseek', 'deepseek'], ['minimax', 'minimax'], ['llama', 'meta'], ['mistral', 'mistral'],
  ['magistral', 'mistral'], ['devstral', 'mistral'], ['nova', 'amazon'], ['command', 'cohere'],
  ['phi', 'microsoft'], ['ernie', 'baidu'], ['hunyuan', 'tencent'], ['doubao', 'bytedance'],
  ['seed', 'bytedance'], ['solar', 'upstage'], ['mimo', 'xiaomi'], ['hy3', 'minimax'],
  ['sonar', 'perplexity'], ['ministral', 'mistral'], ['codestral', 'mistral'], ['mercury', 'inception'], ['r1', 'deepseek'],
];

export function orgFromPrefix(cid) {
  const first = cid.replace(/^umans-/, '').split(/[-:.]/)[0].toLowerCase();
  const hit = FAMILY_ORG_PREFIX.find(([tok]) => tok === first);
  return hit ? hit[1] : null;
}

/**
 * Layer 1 — resolve the creator from a group's offerings.
 * Prefer an offering whose org differs from its provider slug/name; an org that
 * equals the host provider is an extraction fallback leaking a hosting provider
 * as the creator, and must never surface.
 *
 * @param {Array<{org:any, provider:any, provider_display?:any}>} offerings
 * @returns {string|null}
 */
export function resolveOrg(offerings) {
  for (const o of offerings) {
    if (o.org && o.org !== o.provider && o.org !== o.provider_display) return o.org;
  }
  return null;
}

/**
 * Layer 2 — returns a cleaner that nulls any org colliding with a provider
 * slug/name. A global blocklist: an org equal to ANY provider slug is an
 * extraction fallback leaking a hosting provider as the creator. Never trust it.
 *
 * @param {Iterable<string>} providerSlugs lowercased provider keys/names
 * @returns {(org:any) => string|null}
 */
export function makeCleanOrg(providerSlugs) {
  const set = new Set([...providerSlugs].map((s) => s.toLowerCase()));
  return (org) => (org && !set.has(String(org).toLowerCase()) ? org : null);
}

/**
 * Layers 3+4 and the two-pass assembly — resolve every canonical id to its
 * creator: its own clean org, else family inheritance, else the leading-token
 * map. Provider slugs can never surface as creators.
 *
 * @param {Map<string, Array<{org:any, provider:any, provider_display?:any}>>} groups
 *   canonicalId → that group's model rows (offerings)
 * @param {Iterable<string>} providerSlugs lowercased provider keys/names
 * @returns {Map<string, string|null>} canonicalId → creator org
 */
export function buildOrgIndex(groups, providerSlugs) {
  const clean = makeCleanOrg(providerSlugs);

  // Pass 1: resolve orgs that have a clean creator; index by family key
  const familyOrg = new Map();
  for (const [cid, offerings] of groups) {
    const org = clean(resolveOrg(offerings));
    if (org && !familyOrg.has(familyKey(cid))) familyOrg.set(familyKey(cid), org);
  }

  // Pass 2: every canonical id gets its own org, else family inheritance,
  // else leading-token map. Provider slugs can never surface as creators.
  const orgByCid = new Map();
  for (const [cid, offerings] of groups) {
    orgByCid.set(cid, clean(resolveOrg(offerings)) ?? familyOrg.get(familyKey(cid)) ?? orgFromPrefix(cid));
  }
  return orgByCid;
}
