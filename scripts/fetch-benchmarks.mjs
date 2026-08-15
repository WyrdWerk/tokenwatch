/**
 * scripts/fetch-benchmarks.mjs — sidecar fetcher for the Benchmarks page.
 *
 * Builds public/benchmarks.json: per-model benchmark scores (use-case tagged)
 * joined to cheapest-provider blended pricing from public/pricing.json.
 *
 * Sources (Phase 1):
 *   - AA indices (intelligence/coding/agentic) + Design Arena — already attached
 *     to pricing.json models by fetch-pricing.mjs enrichment; no extra fetch.
 *   - LiveBench — contamination-free leaderboard, published as per-release CSV
 *     in the LiveBench/livebench.github.io GitHub repo (no API key).
 *
 * Price join: for each canonical model, compute blendedRate() at the agentic
 * mix (2.5/97/0.5 — same math as the Text page's Blended $/M column and the
 * SEO cheapest-models ranking) for EVERY provider offering, keep the cheapest.
 * "From $X" on the Benchmarks page = that blended rate.
 *
 * Zero-dep. Non-fatal per source: LiveBench failure → AA/DesignArena-only page.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalId } from '../shared/normalize.mjs';
import { blendedRate, AGENTIC_MIX } from '../shared/cost.mjs';
import { readArenaIndex } from './fetch-arena.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_JSON = join(__dirname, '..', 'public', 'pricing.json');
const OUT_JSON = join(__dirname, '..', 'public', 'benchmarks.json');

const LIVEBENCH_RELEASE = '2026_06_25';
const LIVEBENCH_CSV_URL = `https://raw.githubusercontent.com/LiveBench/livebench.github.io/main/public/table_${LIVEBENCH_RELEASE}.csv`;

// LiveBench subtask → category (from their categories_*.json, verified 2026-08-14)
const LIVEBENCH_CATEGORIES = {
  reasoning: ['theory_of_mind', 'zebra_puzzle', 'spatial', 'logic_with_navigation'],
  coding: ['code_generation', 'code_completion'],
  agentic_coding: ['javascript', 'typescript', 'python'],
  math: ['AMPS_Hard', 'integrals_with_game', 'math_comp', 'olympiad'],
  data_analysis: ['consecutive_events', 'tablejoin', 'tablereformat'],
  language: ['connections', 'plot_unscrambling', 'typos'],
  instruction_following: ['paraphrase', 'simplify', 'story_generation', 'summarize'],
};

// ── LiveBench model-name → catalog canonicalId matching ───────────────────────
// LiveBench ids are verbose API slugs ("claude-opus-4-5-20251101-thinking-64k-
// high-effort") while our canonical ids are compact ("claude-opus-4.5"). Loose
// best-effort normalization: strip date stamps + reasoning-effort qualifiers,
// drop dots, then exact-match on the normalized key. Unmatched models are
// logged and skipped — never force-matched.

const LB_STRIP = [
  /\b\d{8}\b/g,                                  // date stamps 20251101
  /\b(thinking|high|medium|low)[-_]?(effort)?\b/gi,
  /\b(auto|preview|latest|64k|128k|256k)\b/gi,
  /\b\d+k\b/gi,
];

function lbKey(id) {
  let s = id.toLowerCase();
  for (const re of LB_STRIP) s = s.replace(re, '-');
  return s.replace(/[^a-z0-9]+/g, '').replace(/^-+|-+$/g, '');
}

function catalogKey(canonical) {
  return canonical.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Parse LiveBench CSV → Map<lbKey, {category: avg}> */
export function parseLiveBenchCsv(csvText) {
  const lines = csvText.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return new Map();
  const headers = lines[0].split(',').map((h) => h.trim());
  const catByCol = headers.map((h) => {
    for (const [cat, cols] of Object.entries(LIVEBENCH_CATEGORIES)) {
      if (cols.includes(h)) return cat;
    }
    return null;
  });

  const out = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const model = cells[0];
    if (!model) continue;
    const sums = {};
    const counts = {};
    for (let i = 1; i < headers.length; i++) {
      const cat = catByCol[i];
      const v = parseFloat(cells[i]);
      if (!cat || !Number.isFinite(v)) continue;
      sums[cat] = (sums[cat] || 0) + v;
      counts[cat] = (counts[cat] || 0) + 1;
    }
    const cats = {};
    for (const cat of Object.keys(sums)) cats[cat] = Math.round((sums[cat] / counts[cat]) * 10) / 10;
    out.set(lbKey(model), { lb_name: model, categories: cats });
  }
  return out;
}

async function fetchLiveBench(log) {
  try {
    const resp = await fetch(LIVEBENCH_CSV_URL, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csv = await resp.text();
    const map = parseLiveBenchCsv(csv);
    log.log(`✓ LiveBench (${LIVEBENCH_RELEASE}): ${map.size} models`);
    return map;
  } catch (err) {
    log.warn(`⚠ LiveBench fetch failed: ${err.message} — continuing without it`);
    return new Map();
  }
}

// ── Main build ────────────────────────────────────────────────────────────────

async function main() {
  const pricing = JSON.parse(await readFile(PRICING_JSON, 'utf8'));
  const livebench = await fetchLiveBench(console);
  const arena = await readArenaIndex();
  let arenaMatched = 0;

  // 1. Group provider offerings by canonical model id
  const byCanonical = new Map(); // canonicalId → { name, org, offerings: [model rows] }
  for (const m of pricing.models) {
    const cid = canonicalId(m.id);
    if (!byCanonical.has(cid)) {
      byCanonical.set(cid, { name: m.name || m.id, org: m.org || null, offerings: [] });
    }
    byCanonical.get(cid).offerings.push(m);
  }

  // 2. LiveBench join index: catalogKey → livebench entry
  const lbIndex = new Map();
  for (const [k, v] of livebench) lbIndex.set(k, v);

  // 3. Resolve the model-creator org for the group.
  // Org comes from org extraction on each offering; when extraction fails it
  // falls back to the PROVIDER slug (e.g. "wafer") — that must never surface as
  // the creator. Prefer an offering whose org differs from its provider slug;
  // variants (fast/turbo) inherit the same creator as the base id.
  function resolveOrg(offerings) {
    for (const o of offerings) {
      if (o.org && o.org !== o.provider && o.org !== o.provider_display) return o.org;
    }
    return null;
  }

  // Variant family key: strip variant/quant suffixes so kimi-k3-fast inherits
  // the creator resolved for kimi-k3 (moonshot), glm-5.2-fast -> glm-5.2 (z-ai)...
  // Reseller prefixes (umans-) are stripped too, and the key is dash-insensitive
  // so alternate spellings (glm5.2 vs glm-5.2) share a family.
  const VARIANT_SUFFIX_RE = /(?:[-:](?:fast|turbo|flex|short|batch|preview|low|high|mini|thinking|instant|nvfp4|fp8|int4|int8|awq))+$/;
  function familyKey(cid) {
    return cid.replace(/^umans-/, '').replace(VARIANT_SUFFIX_RE, '').replace(/[^a-z0-9.]/g, '');
  }

  // Global provider blocklist — an org equal to ANY provider slug is an
  // extraction fallback leaking a hosting provider as the creator. Never trust it.
  const providerSlugs = new Set(pricing.providers.map((p) => String(p.key || '').toLowerCase()));
  const cleanOrg = (org) => (org && !providerSlugs.has(org.toLowerCase()) ? org : null);

  // Leading-token creator map for ids whose offerings all failed extraction
  // (canonical ids are bare — lib orgFromId needs an org/ prefix we no longer have).
  const FAMILY_ORG_PREFIX = [
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
  function orgFromPrefix(cid) {
    const first = cid.replace(/^umans-/, '').split(/[-:.]/)[0].toLowerCase();
    const hit = FAMILY_ORG_PREFIX.find(([tok]) => tok === first);
    return hit ? hit[1] : null;
  }

  // Pass 1: resolve orgs that have a clean creator; index by family key
  const familyOrg = new Map();
  for (const [cid, info] of byCanonical) {
    const org = cleanOrg(resolveOrg(info.offerings));
    if (org && !familyOrg.has(familyKey(cid))) familyOrg.set(familyKey(cid), org);
  }

  // Pass 2: every canonical id gets its own org, else family inheritance,
  // else leading-token map. Provider slugs can never surface as creators.
  const orgByCid = new Map();
  for (const [cid] of byCanonical) {
    orgByCid.set(cid, cleanOrg(resolveOrg(byCanonical.get(cid).offerings)) ?? familyOrg.get(familyKey(cid)) ?? orgFromPrefix(cid));
  }

  // 4. Build per-model records: scores + cheapest blended price
  const models = [];
  let lbMatched = 0;
  for (const [cid, info] of byCanonical) {
    const org = orgByCid.get(cid) ?? null;
    const scores = {};

    // AA indices + Design Arena — model-level, take first non-null across offerings
    for (const o of info.offerings) {
      const b = o.benchmarks || {};
      if (scores.aa_intelligence == null && b.intelligence_index != null) scores.aa_intelligence = b.intelligence_index;
      if (scores.aa_coding == null && b.coding_index != null) scores.aa_coding = b.coding_index;
      if (scores.aa_agentic == null && b.agentic_index != null) scores.aa_agentic = b.agentic_index;
      if (scores.design_arena_elo == null && b.design_arena_best?.elo != null) {
        scores.design_arena_elo = b.design_arena_best.elo;
        scores.design_arena_category = b.design_arena_best.category;
      }
    }

    // LiveBench — match on normalized key
    const lb = lbIndex.get(catalogKey(cid));
    if (lb) {
      lbMatched++;
      for (const [cat, val] of Object.entries(lb.categories)) {
        scores[`livebench_${cat}`] = val;
      }
    }

    // Arena AI — human-preference Elo (local-only enrichment; null in CI).
    // Looked up by alphanumeric key (same normalization as LiveBench) so
    // `qwen3.8-max` (dots) and `claude-opus-4.7` (hyphens) both join exact.
    if (arena) {
      const a = arena.get(catalogKey(cid));
      if (a) {
        arenaMatched++;
        scores.arena_elo = a.arena_elo;
        scores.arena_votes = a.arena_votes;
        scores.arena_ci = a.arena_ci;
      }
    }

    const hasScores = Object.keys(scores).some((k) => !k.startsWith('design_arena_category'));
    if (!hasScores) continue;

    // Priceable offerings — the page recomputes blended cost client-side at the
    // visitor's mix (sourced from the Text calculator), so we ship the raw
    // $/M prices per provider. Cheapest-at-default-mix is precomputed for
    // crawlers/no-JS and as a stable sort anchor.
    const offerings = [];
    let best = null;
    for (const o of info.offerings) {
      const rate = blendedRate(o.pricing, AGENTIC_MIX);
      if (rate == null) continue;
      const name = o.provider_display || o.provider;
      offerings.push({
        provider: name,
        input: o.pricing.input,
        output: o.pricing.output,
        cache_read: o.pricing.cache_read,
      });
      if (!best || rate < best.blended_per_m) {
        best = { provider: name, blended_per_m: Math.round(rate * 1000) / 1000 };
      }
    }
    if (!best) continue; // benchmarked but not priceable here — skip

    models.push({
      id: cid,
      name: info.name,
      org,
      providers: offerings.length,
      from: best,
      offerings,
      scores,
    });
  }

  // Sort: AA intelligence desc when present, else livebench reasoning, else name
  models.sort((a, b) =>
    (b.scores.aa_intelligence ?? b.scores.livebench_reasoning ?? -1) -
    (a.scores.aa_intelligence ?? a.scores.livebench_reasoning ?? -1)
  );

  const sources = {
    artificial_analysis: { name: 'Artificial Analysis', url: 'https://artificialanalysis.ai/', fields: ['aa_intelligence', 'aa_coding', 'aa_agentic'], scale: '0–100 index' },
    livebench: { name: 'LiveBench', url: 'https://livebench.ai/', release: LIVEBENCH_RELEASE.replace(/_/g, '-'), prefix: 'livebench_', scale: '0–100, contamination-free' },
    design_arena: { name: 'Design Arena', url: 'https://www.designarena.ai/', fields: ['design_arena_elo'], scale: 'Elo' },
  };
  if (arenaMatched > 0) {
    sources.arena_ai = { name: 'Arena AI (local-only)', url: 'https://arena.ai/leaderboard/text', fields: ['arena_elo', 'arena_votes', 'arena_ci'], scale: 'Elo' };
  }

  const out = {
    generated_at: new Date().toISOString(),
    mix: AGENTIC_MIX,
    model_count: models.length,
    sources,
    models,
  };

  await writeFile(OUT_JSON, JSON.stringify(out, null, 2));
  console.log(`→ Wrote public/benchmarks.json (${models.length} models, LiveBench matched ${lbMatched}/${livebench.size}, Arena matched ${arenaMatched})`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
