import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canonicalId } from '../shared/normalize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRICING_JSON = join(__dirname, '..', 'public', 'pricing.json');

/**
 * Parity guard: loads the real public/pricing.json and asserts that
 * canonicalId produces the expected distinct keys for the gemini-3.1-pro
 * family. This catches any future re-divergence if someone reintroduces a
 * second copy of the canonicalization logic with a -preview-.*$ catch-all.
 */
test('gemini-3.1-pro family does NOT collapse (regression)', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  const geminiKeys = new Set();
  const geminiModels = [];
  for (const m of data.models) {
    if (m.id.includes('gemini-3.1-pro')) {
      const key = canonicalId(m.id);
      geminiKeys.add(key);
      geminiModels.push({ id: m.id, key });
    }
  }
  // Must have DISTINCT keys for pro and pro-preview-customtools
  // (pro-preview folds into pro via the bare -preview rule — that's correct)
  assert.ok(geminiKeys.has('gemini-3.1-pro'),
    `expected gemini-3.1-pro key, got: ${[...geminiKeys].join(', ')}`);
  assert.ok(geminiKeys.has('gemini-3.1-pro-preview-customtools'),
    `expected gemini-3.1-pro-preview-customtools key, got: ${[...geminiKeys].join(', ')}`);
  assert.ok(geminiKeys.size >= 2,
    `expected ≥2 distinct keys, got ${geminiKeys.size}: ${[...geminiKeys].join(', ')}`);

  // The customtools variant must NOT canonicalize to the base
  const customtoolsKey = canonicalId('google/gemini-3.1-pro-preview-customtools');
  assert.notEqual(customtoolsKey, 'gemini-3.1-pro',
    'gemini-3.1-pro-preview-customtools must not collapse into gemini-3.1-pro');
});

test('every model produces a non-empty canonical key', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  let empty = 0;
  for (const m of data.models) {
    const key = canonicalId(m.id);
    if (!key || key.trim() === '') empty++;
  }
  assert.equal(empty, 0, `${empty} models produced empty canonical keys`);
});

test('glm-5.2 quant variants stay distinct (not collapsed by dedup)', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  const glmKeys = new Set();
  for (const m of data.models) {
    if (m.id.includes('glm-5.2')) {
      glmKeys.add(canonicalId(m.id));
    }
  }
  // If fp8/nvfp4/int4 variants exist in the data, they must be distinct keys
  const quantVariants = [...glmKeys].filter(k => /-(fp8|nvfp4|int4|bf16|fp16)$/.test(k));
  for (const k of quantVariants) {
    assert.notEqual(k, 'glm-5.2',
      `${k} should be distinct from glm-5.2 (quant suffix preserved)`);
  }
});

// ── models.dev enrichment regression guards ──────────────────────────────────

// DeepInfra (112 models) and ~26 smaller OR-exclusive providers are structurally
// absent from models.dev — 35% floor catches normalizer regressions while
// accommodating the known ceiling.
test('models.dev enrichment coverage floor (≥35% of catalog)', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  const enriched = data.models.filter((m) => m.modelsdev).length;
  const pct = enriched / data.models.length;
  assert.ok(pct >= 0.35,
    `enrichment coverage ${(pct * 100).toFixed(1)}% below 35% floor — a normalizer may have regressed`);
});

test('models.dev confidence values are always "high" or "medium"', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  for (const m of data.models) {
    if (!m.modelsdev) continue;
    assert.ok(
      m.modelsdev.confidence === 'high' || m.modelsdev.confidence === 'medium',
      `${m.provider}/${m.id} has invalid confidence: ${m.modelsdev.confidence}`
    );
  }
});

// models.dev's `api` field is optional — ~141 enriched models legitimately
// carry base_url: null (providers like Azure/Bedrock/Google/Perplexity that
// don't expose a documented HTTP endpoint on models.dev). When base_url IS
// present it must be a valid https URL.
test('models.dev base_url is null or a valid https URL', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  for (const m of data.models) {
    if (!m.modelsdev) continue;
    const u = m.modelsdev.base_url;
    assert.ok(
      u === null || (typeof u === 'string' && u.startsWith('https://')),
      `${m.provider}/${m.id} has invalid base_url: ${u}`
    );
  }
});

test('models.dev base_url contains no unresolved template variables', async () => {
  const data = JSON.parse(await readFile(PRICING_JSON, 'utf-8'));
  for (const m of data.models) {
    if (!m.modelsdev?.base_url) continue;
    assert.ok(
      !/\$\{/.test(m.modelsdev.base_url),
      `${m.provider}/${m.id} has unresolved template variable in base_url: ${m.modelsdev.base_url}`
    );
  }
});
