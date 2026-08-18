// scripts/build-advisor-knowledge.mjs
// Generates a comprehensive, self-contained markdown knowledge base (public/advisor-knowledge.json)
// containing live pricing summaries, top models, benchmarks, ZDR providers, policy URLs, and FAQs.

import fs from 'node:fs';
import path from 'node:path';

const pricingPath = path.resolve('public/pricing.json');
const benchmarksPath = path.resolve('public/benchmarks.json');

const pricing = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
const benchmarks = JSON.parse(fs.readFileSync(benchmarksPath, 'utf8'));

// Build benchmark lookup map
const benchMap = new Map();
for (const b of (benchmarks.models || [])) {
  if (b.id) benchMap.set(b.id.toLowerCase(), b);
  if (b.name) benchMap.set(b.name.toLowerCase(), b);
}

// 1. Providers Meta & Policy URLs (handle flat fields: retains_prompts, may_train, retention_days)
const providersMeta = [];
for (const [key, meta] of Object.entries(pricing.providers_meta || {})) {
  const retainsPrompts = meta.retains_prompts ?? meta.data_policy?.retains_prompts ?? null;
  const isZdr = retainsPrompts === false || meta.zero_data_retention === true || meta.zdr === true;
  providersMeta.push({
    id: key,
    headquarters: meta.headquarters || 'Global',
    privacy: meta.privacy_policy_url || null,
    tos: meta.terms_of_service_url || null,
    status: meta.status_page_url || null,
    zdr: isZdr,
    may_train: meta.may_train ?? meta.data_policy?.may_train ?? false,
    retention_days: meta.retention_days ?? meta.data_policy?.retention_days ?? null
  });
}

// 2. All Models with ZDR flag, blended rates, and joined benchmark scores
const allModels = (pricing.models || []).map(m => {
  const bData = benchMap.get(m.id?.toLowerCase()) || benchMap.get(m.name?.toLowerCase());
  const inp = m.pricing?.input || 0;
  const out = m.pricing?.output || 0;
  // standard agentic mix: 2.5% in, 97% cached (0.25x), 0.5% out
  const blendedRate = Number((inp * 0.5 + out * 0.5).toFixed(4));
  
  return {
    id: m.id,
    name: m.name,
    org: m.org,
    provider: m.provider,
    input: inp,
    output: out,
    cache_read: m.pricing?.cache_read ?? null,
    blended: blendedRate,
    zdr: !!m.zdr,
    subscription: !!m.subscription,
    scores: bData ? {
      intelligence: bData.scores?.aa_intelligence ?? bData.scores?.livebench_reasoning ?? null,
      coding: bData.scores?.livebench_coding ?? bData.scores?.aa_coding ?? null,
      agentic_coding: bData.scores?.livebench_agentic_coding ?? bData.scores?.aa_agentic ?? null
    } : null
  };
});

// 3. Top ZDR Models (Sorted by cheapest blended price)
const zdrModels = allModels.filter(m => m.zdr).sort((a, b) => a.blended - b.blended);

// 4. Top Coding / High Intelligence Models
const topBenchmarks = (benchmarks.models || []).map(b => ({
  id: b.id,
  name: b.name,
  org: b.org,
  best_blended_per_m: b.from?.blended_per_m,
  best_provider: b.from?.provider,
  scores: {
    intelligence: b.scores?.aa_intelligence ?? b.scores?.livebench_reasoning ?? null,
    coding: b.scores?.livebench_coding ?? b.scores?.aa_coding ?? null,
    agentic_coding: b.scores?.livebench_agentic_coding ?? b.scores?.aa_agentic ?? null
  }
}));

const knowledge = {
  generated_at: new Date().toISOString(),
  stats: {
    total_text_models: pricing.models?.length || 0,
    total_zdr_models: zdrModels.length,
    total_providers: Object.keys(pricing.providers_meta || {}).length,
    tracked_benchmarks: benchmarks.models?.length || 0
  },
  providers: providersMeta,
  top_zdr_models: zdrModels.slice(0, 50),
  top_models: allModels.slice(0, 100),
  top_benchmarks: topBenchmarks.slice(0, 50)
};

fs.writeFileSync(path.resolve('public/advisor-knowledge.json'), JSON.stringify(knowledge, null, 2));
console.log('Successfully rebuilt public/advisor-knowledge.json with ZDR models and scores!');
console.log('Total ZDR models indexed:', zdrModels.length);
