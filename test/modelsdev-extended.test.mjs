import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEnrichment,
  findEnrichment,
  modelsDevPriceDrift,
  normalizeContextTiers,
  MODELSDEV_PROVIDER_TARGETS,
  PROVIDER_MAP,
  EXTRA_PROVIDER_ALIASES,
} from '../shared/modelsdev.mjs';
import { buildIndexFromApi, buildProviderSetupIndex, formatPriceDriftReport } from '../scripts/fetch-modelsdev.mjs';

const TIERED_COST = {
  input: 2.5,
  output: 7.5,
  cache_read: 0.5,
  tiers: [
    { input: 6.25, output: 18.5, cache_read: 1.25, tier: { type: 'context', size: 128000 } },
    { input: 5, output: 15, cache_read: 1, tier: { type: 'context', size: 32000 } },
    { input: 9, output: 9, tier: { type: 'requests', size: 10 } },
  ],
};

function apiFixture() {
  return {
    deepinfra: {
      api: 'https://api.deepinfra.com/v1/openai',
      env: ['DEEPINFRA_API_KEY'],
      npm: '@ai-sdk/deepinfra',
      models: {
        'Qwen/Qwen3.7-Max': {
          cost: TIERED_COST,
          limit: { context: 256000, input: 224000, output: 32000 },
          status: 'deprecated',
          reasoning_options: [{ type: 'effort', values: ['low', 'high', 42] }, { nope: true }],
          interleaved: { field: 'reasoning_content' },
        },
        'Qwen/Qwen3-Plain': { cost: { input: 1, output: 2 }, limit: { context: 1000, output: 100 }, status: 'retired-ish' },
      },
    },
    xiaomi: {
      env: ['XIAOMI_API_KEY', 'bad name'],
      npm: 'not a package!',
      models: { 'mimo-v2.6-pro': { cost: { input: 1, output: 3 }, limit: { context: 1000, output: 100 } } },
    },
  };
}

test('normalizeContextTiers keeps context tiers only, sorted, and drops malformed rows', () => {
  assert.deepEqual(normalizeContextTiers(TIERED_COST), [
    { above_tokens: 32000, input: 5, output: 15, cache_read: 1, cache_write: null },
    { above_tokens: 128000, input: 6.25, output: 18.5, cache_read: 1.25, cache_write: null },
  ]);
  assert.deepEqual(normalizeContextTiers({ context_over_200k: { input: 4, output: 18 } }), [
    { above_tokens: 200000, input: 4, output: 18, cache_read: null, cache_write: null },
  ]);
  assert.equal(normalizeContextTiers({ input: 1, output: 2 }), null);
  assert.equal(normalizeContextTiers({ tiers: [{ input: -1, output: 2, tier: { type: 'context', size: 1000 } }] }), null);
});

test('buildIndexFromApi captures tier, lifecycle, reasoning and input-limit fields', () => {
  const rec = buildIndexFromApi(apiFixture()).get('deepinfra').get('qwen3.7-max');
  assert.equal(rec.cost_input, 2.5);
  assert.equal(rec.max_input, 224000);
  assert.equal(rec.status, 'deprecated');
  assert.deepEqual(rec.reasoning_options, [{ type: 'effort', values: ['low', 'high'] }]);
  assert.equal(rec.interleaved_reasoning, true);
  assert.equal(rec.context_tiers.length, 2);
  const plain = buildIndexFromApi(apiFixture()).get('deepinfra').get('qwen3-plain');
  assert.equal(plain.status, null, 'unknown status values are dropped');
  assert.equal(plain.reasoning_options, null);
});

test('one models.dev provider can feed several TokenWatch providers', () => {
  assert.deepEqual(MODELSDEV_PROVIDER_TARGETS.xiaomi.sort(), ['xiaomi', 'xiaomimimo']);
  for (const [tw, md] of Object.entries(EXTRA_PROVIDER_ALIASES)) {
    assert.equal(PROVIDER_MAP[tw], undefined, `${tw} must not also be in the 1:1 PROVIDER_MAP`);
    assert.ok(MODELSDEV_PROVIDER_TARGETS[md].includes(tw));
  }
  const idx = buildIndexFromApi(apiFixture());
  assert.ok(idx.get('xiaomi').has('mimo-v2.6-pro'));
  assert.ok(idx.get('xiaomimimo').has('mimo-v2.6-pro'));
});

test('buildProviderSetupIndex keeps only shell-safe env names and valid npm names', () => {
  const setup = buildProviderSetupIndex(apiFixture());
  assert.deepEqual(setup.get('deepinfra'), { setup_env: ['DEEPINFRA_API_KEY'], ai_sdk_package: '@ai-sdk/deepinfra' });
  assert.deepEqual(setup.get('xiaomimimo'), { setup_env: ['XIAOMI_API_KEY'], ai_sdk_package: null });
});

test('findEnrichment reports how a record matched', () => {
  const idx = buildIndexFromApi(apiFixture());
  assert.equal(findEnrichment('deepinfra', 'Qwen/Qwen3.7-Max', idx).match, 'exact');
  assert.equal(findEnrichment('deepinfra', 'Qwen/Qwen3.7-Max:batch', idx).match, 'batch-base');
});

test('applyEnrichment attaches tiers only to the matching tariff and lifecycle never via fuzzy match', () => {
  const idx = buildIndexFromApi(apiFixture());
  const models = [
    { id: 'Qwen/Qwen3.7-Max', provider: 'deepinfra', max_prompt_tokens: null, pricing: { input: 2.5, output: 7.5, cache_read: null, cache_write: null } },
    // Same model on a promo price: tiers describe a different tariff.
    { id: 'Qwen/Qwen3.7-Max-promo-row', provider: 'other', pricing: { input: 1, output: 3 } },
    { id: 'Qwen/Qwen3.7-Max:batch', provider: 'deepinfra', pricing: { input: 2.5, output: 7.5 } },
  ];
  const promoIdx = new Map([['other', new Map([['qwen3.7-max-promo-row', { ...idx.get('deepinfra').get('qwen3.7-max') }]])]]);
  const log = [];
  applyEnrichment(models.slice(0, 1).concat(models[2]), idx, log);
  applyEnrichment([models[1]], promoIdx, log);
  assert.equal(models[0].max_prompt_tokens, 224000, 'limit.input fills a null max_prompt_tokens');
  assert.equal(models[0].lifecycle_status, 'deprecated');
  assert.equal(models[0].context_price_tiers[0].above_tokens, 32000);
  assert.deepEqual(models[0].modelsdev.reasoning_options, [{ type: 'effort', values: ['low', 'high'] }]);
  assert.equal(models[0].modelsdev.interleaved_reasoning, true);
  assert.equal(models[1].context_price_tiers, undefined, 'different price → no tiers');
  assert.equal(models[2].context_price_tiers, undefined, ':batch borrows metadata, not tariffs');
  assert.equal(models[2].lifecycle_status, 'deprecated', ':batch shares its base lifecycle');

  const fuzzyIdx = new Map([['p', new Map([['foo-bar-fast', { status: 'deprecated', cost_input: 1, cost_output: 1 }]])]]);
  const fuzzy = [{ id: 'foo-bar', provider: 'p', pricing: { input: 1, output: 1 } }];
  applyEnrichment(fuzzy, fuzzyIdx, []);
  assert.equal(fuzzy[0].modelsdev.confidence, 'medium');
  assert.equal(fuzzy[0].lifecycle_status, undefined, 'fuzzy SKU match never marks a row deprecated');
});

test('applyEnrichment keeps an existing max_prompt_tokens and logs the disagreement', () => {
  const idx = buildIndexFromApi(apiFixture());
  const models = [{ id: 'Qwen/Qwen3.7-Max', provider: 'deepinfra', max_prompt_tokens: 200000, pricing: { input: 2.5, output: 7.5 } }];
  const log = [];
  applyEnrichment(models, idx, log);
  assert.equal(models[0].max_prompt_tokens, 200000);
  assert.ok(log.some((line) => line.includes('max_prompt_tokens disagreement')));
});

test('modelsDevPriceDrift compares the same provider + model and explains promos and tiers', () => {
  const rec = (input, output, extra = {}) => ({ cost_input: input, cost_output: output, context_tiers: null, ...extra });
  const idx = new Map([
    ['alpha', new Map([
      ['same', rec(1, 2)],
      ['promo', rec(1, 2)],
      ['promo-off', rec(1, 2)],
      ['tiered', rec(1, 2, { context_tiers: [{ above_tokens: 1000, input: 3, output: 6 }] })],
      ['drift', rec(1, 2)],
      ['free', rec(0, 0)],
    ])],
    ['beta', new Map([['same', rec(9, 9)]])],
  ]);
  const models = [
    { id: 'same', provider: 'alpha', discount: 0, pricing: { input: 1.005, output: 2 } },
    { id: 'same', provider: 'beta', discount: 0, pricing: { input: 1, output: 2 } }, // cheaper host: own provider listing differs
    { id: 'promo', provider: 'alpha', discount: 0.5, pricing: { input: 0.5, output: 1 } },
    { id: 'promo-off', provider: 'alpha', discount: 0.5, pricing: { input: 0.2, output: 1 } },
    { id: 'tiered', provider: 'alpha', discount: 0, pricing: { input: 3, output: 6 } },
    { id: 'drift', provider: 'alpha', discount: 0, pricing: { input: 2, output: 2 } },
    { id: 'drift:batch', provider: 'alpha', discount: 0, pricing: { input: 0.5, output: 1 } },
    { id: 'free', provider: 'alpha', discount: 0, pricing: { input: 1, output: 1 } },
    { id: 'unlisted', provider: 'alpha', discount: 0, pricing: { input: 1, output: 1 } },
  ];
  const before = JSON.stringify(models);
  const report = modelsDevPriceDrift(models, idx, { sourceOf: (m) => (m.provider === 'alpha' ? 'openrouter' : 'direct') });
  assert.equal(JSON.stringify(models), before, 'report never mutates rows');
  assert.deepEqual(report.counts, { match: 1, promo_explained: 1, promo_unexplained: 1, tier_explained: 1, mismatch: 2, fuzzy_mismatch: 0 });
  assert.equal(report.checked, 6, ':batch, md-free and unlisted rows are skipped');
  const beta = report.rows.find((r) => r.provider === 'beta');
  assert.equal(beta.class, 'mismatch');
  assert.equal(beta.source, 'direct');
  const drift = report.rows.find((r) => r.id === 'drift');
  assert.equal(drift.ratio, 2);
  assert.equal(report.rows[0].provider, 'beta', 'largest gap first');

  const { consoleLines, markdown } = formatPriceDriftReport(report);
  assert.match(consoleLines[0], /6 compared — match 1, promo explained 1, tier explained 1, promo unexplained 1, mismatch 2, fuzzy-match mismatch 0/);

  const fuzzyIdx = new Map([['p', new Map([['foo-bar-fast', rec(5, 5)]])]]);
  const fuzzy = modelsDevPriceDrift([{ id: 'foo-bar', provider: 'p', discount: 0, pricing: { input: 1, output: 1 } }], fuzzyIdx);
  assert.equal(fuzzy.counts.fuzzy_mismatch, 1, 'a fuzzy SKU match is reported apart from real mismatches');
  assert.match(markdown, /\| beta \| same \| direct \|/);
  assert.match(markdown, /same provider and model/);
});

test('collapsed models.dev ids: the raw-id twin wins, otherwise SKU facts are not borrowed', () => {
  // canonicalId strips -preview and dates, so these md ids share one key.
  const api = {
    google: {
      models: {
        'gemini-9-lite-preview': { cost: { input: 0.1, output: 0.4 }, limit: { context: 1000, output: 100 }, status: 'deprecated' },
        'gemini-9-lite': { cost: { input: 0.125, output: 0.75 }, limit: { context: 1000, output: 100 } },
      },
    },
    openai: {
      models: {
        'gpt-9o-2024-05-13': { cost: { input: 5, output: 15 }, limit: { context: 1000, output: 100 }, status: 'deprecated' },
        'gpt-9o-2024-08-06': { cost: { input: 2.5, output: 10 }, limit: { context: 1000, output: 100 } },
      },
    },
  };
  const idx = buildIndexFromApi(api);
  const models = [
    { id: 'google/gemini-9-lite', provider: 'google', discount: 0, pricing: { input: 0.125, output: 0.75 } },
    { id: 'openai/gpt-9o-2024-11-20', provider: 'openai', discount: 0, pricing: { input: 2.5, output: 10 } },
  ];
  applyEnrichment(models, idx, []);
  assert.equal(models[0].modelsdev.model_id, 'gemini-9-lite', 'raw-id twin preferred over the -preview SKU');
  assert.equal(models[0].lifecycle_status, undefined, 'the GA SKU is not marked deprecated');
  assert.equal(models[1].modelsdev.model_id, 'gpt-9o-2024-05-13', 'no twin: primary record kept for descriptive metadata');
  assert.equal(models[1].lifecycle_status, undefined, 'no twin and candidates disagree: lifecycle not borrowed');
  const drift = modelsDevPriceDrift(models, idx);
  assert.equal(drift.checked, 1, 'ambiguous collapsed record is left out of the price check');
  assert.equal(drift.counts.match, 1);
});

test('price check reports a zero on one side as the largest gap, not ×1', () => {
  const idx = new Map([['p', new Map([
    ['zero-in', { cost_input: 1, cost_output: 2, context_tiers: null }],
    ['small', { cost_input: 1, cost_output: 2, context_tiers: null }],
  ])]]);
  const report = modelsDevPriceDrift([
    { id: 'small', provider: 'p', discount: 0, pricing: { input: 1.5, output: 2 } },
    { id: 'zero-in', provider: 'p', discount: 0, pricing: { input: 0, output: 2 } },
  ], idx);
  assert.equal(report.rows[0].id, 'zero-in');
  assert.equal(report.rows[0].ratio, 0);
});

test('context tiers are never attached through a fuzzy SKU match', () => {
  const tiers = [{ above_tokens: 1000, input: 2, output: 2, cache_read: null, cache_write: null }];
  const idx = new Map([['p', new Map([['foo-bar-0309', { cost_input: 1, cost_output: 1, context_tiers: tiers }]])]]);
  const models = [{ id: 'foo-bar', provider: 'p', pricing: { input: 1, output: 1 } }];
  applyEnrichment(models, idx, []);
  assert.equal(models[0].modelsdev.confidence, 'medium');
  assert.equal(models[0].context_price_tiers, undefined);
});

test('cache-write-billed rows never borrow a cache tariff from models.dev', () => {
  const idx = new Map([['coralbricks', new Map([['new-sku', { cost_input: 1, cost_output: 2, cache_read: 0.1, cache_write: 1.5, max_output: 4096 }]])]]);
  const models = [{ id: 'new-sku', provider: 'coralbricks', pricing: { input: 1, output: 2, cache_read: null, cache_write: null, input_billing: 'cache_write' } }];
  applyEnrichment(models, idx, []);
  assert.equal(models[0].pricing.cache_write, null, 'unknown write tariff stays unknown (fresh input stays unpriceable)');
  assert.equal(models[0].pricing.cache_read, null);
  assert.equal(models[0].max_completion_tokens, 4096, 'non-price metadata is still filled');
  assert.equal(models[0].modelsdev.confidence, 'high');
});
