import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseConcentrate,
  reconcileConcentrate,
  concentrateJoin,
  CONCENTRATE_PROVIDER_MAP,
  CONCENTRATE_PROVIDER_DISPLAY,
} from '../scripts/lib.mjs';

const FIXTURE = JSON.parse(
  await readFile(new URL('./fixtures/concentrate-models.json', import.meta.url), 'utf8')
);

const usd = (amount, units = 1000000) => ({ price: { USD: amount }, units });
const simple = (input, output, condition) => ({
  tokens: { input: usd(input), output: usd(output) },
  ...(condition ? { condition } : {}),
});
const hostOf = (pricing, extra = {}) => ({
  pricing,
  context_window: 128000,
  max_output_tokens: 8192,
  zdr: false,
  ...extra,
});
const modelOf = (slug, providers, extra = {}) => ({
  slug,
  aliases: [],
  name: slug,
  author: { slug: 'test-org' },
  max_input_tokens: 128000,
  providers,
  ...extra,
});
const parseOne = (model) => parseConcentrate({ object: 'list', data: [model] });
const find = (offerings, provider, variant = null) => offerings.find((o) => o.provider === provider && o.variant === variant);

test('parseConcentrate converts every price to USD per 1M tokens', () => {
  const { offerings } = parseOne(modelOf('tiny', {
    host: hostOf([{
      tokens: {
        input: usd(0.004, 1000),
        output: usd(12, 1000000),
        cache: { read: usd(0.5, 1000000), write: { cache_write_tokens: usd(1.5, 1000000) } },
      },
    }]),
  }));
  assert.equal(offerings.length, 1);
  assert.deepEqual(offerings[0].pricing, {
    input: 4,
    output: 12,
    cache_read: 0.5,
    cache_write: 1.5,
  });
});

test('parseConcentrate reads the trimmed live catalog: base rows, service tiers, hosts', () => {
  const { offerings, skipped } = parseConcentrate(FIXTURE);
  assert.equal(offerings.length, 55);
  assert.equal(skipped.length, 7);

  const opus = offerings.filter((o) => o.slug === 'claude-opus-5-5');
  const anthropicBase = find(opus, 'anthropic');
  assert.equal(anthropicBase.slug, 'claude-opus-5-5');
  assert.equal(anthropicBase.pricing.input, 4);
  assert.equal(anthropicBase.pricing.output, 20);
  assert.equal(anthropicBase.pricing.cache_read, 0.2);
  // The 5-minute write is TokenWatch's convention; the 1-hour write ($8) is ignored.
  assert.equal(anthropicBase.pricing.cache_write, 5);

  const anthropicFast = find(opus, 'anthropic', 'fast');
  assert.equal(anthropicFast.pricing.input, 8);
  assert.equal(anthropicFast.pricing.cache_write, 10);

  // `zdr` is an evidence object on Anthropic's panel, not a boolean → unknown.
  assert.equal(anthropicBase.zdr, null);
  const vertex = offerings.find((o) => o.slug === 'claude-opus-5-5' && o.provider === 'google');
  assert.equal(vertex.zdr, false);
  assert.equal(vertex.concentrateProvider, 'vertex');

  assert.equal(opus.filter((o) => o.provider === 'amazon').length, 1);
});

test('input_gte entries become context_price_tiers on the base and matching tier', () => {
  const { offerings } = parseConcentrate(FIXTURE);
  const sonnet = find(offerings.filter((o) => o.slug === 'claude-sonnet-4-5'), 'anthropic');
  assert.deepEqual(sonnet.context_price_tiers, [
    { above_tokens: 199999, input: 6, output: 22.5, cache_read: 0.6, cache_write: 7.5 },
  ]);

  const astraBase = offerings.find((o) => o.slug === 'gpt-6-astra' && o.provider === 'openai' && o.variant === null);
  assert.deepEqual(astraBase.context_price_tiers, [
    { above_tokens: 271999, input: 20, output: 75, cache_read: 2, cache_write: 25 },
  ]);
  const astraFast = find(offerings.filter((o) => o.slug === 'gpt-6-astra'), 'openai', 'fast');
  assert.deepEqual(astraFast.context_price_tiers, [
    { above_tokens: 271999, input: 40, output: 150, cache_read: 4, cache_write: 50 },
  ]);

  // A tier with no long-context entry of its own keeps none.
  const synthetic = parseOne(modelOf('tiered', {
    host: hostOf([
      simple(2, 8),
      simple(3, 12, { service_tier: 'priority' }),
      simple(4, 16, { input_gte: 100000 }),
    ]),
  })).offerings;
  assert.equal(find(synthetic, 'host').context_price_tiers[0].above_tokens, 99999);
  assert.equal(find(synthetic, 'host', 'priority').context_price_tiers, null);
});

test('dates and schedules are skipped and reported with their description', () => {
  const { offerings, skipped } = parseConcentrate(FIXTURE);
  const promos = skipped.filter((s) => s.reason === 'promo-condition');
  assert.ok(promos.some((s) => s.slug === 'gemini-4-argon' && /Post-promotional/.test(s.detail)));
  assert.ok(promos.some((s) => s.slug === 'deepseek-v4-1-flash-1017' && /peak:/.test(s.detail)));
  // The base rate still becomes a row; only the dated/scheduled entries vanish.
  const gemini = find(offerings.filter((o) => o.slug === 'gemini-4-argon'), 'google');
  assert.equal(gemini.pricing.input, 2);
  assert.equal(gemini.context_price_tiers, null);
});

test('cache writes prefer the generic key, then the 5-minute write, never the 1-hour write', () => {
  const { offerings } = parseOne(modelOf('writes', {
    generic: hostOf([{ tokens: { input: usd(1), output: usd(2), cache: { write: { cache_write_tokens: usd(3) } } } }]),
    both: hostOf([{ tokens: { input: usd(1), output: usd(2), cache: { write: { ephemeral_5m_input_tokens: usd(2), ephemeral_1h_input_tokens: usd(9) } } } }]),
    preferred: hostOf([{
      tokens: {
        input: usd(1),
        output: usd(2),
        cache: { write: { cache_write_tokens: usd(4), ephemeral_5m_input_tokens: usd(2) } },
      },
    }]),
    none: hostOf([{ tokens: { input: usd(1), output: usd(2), cache: { read: usd(0.5) } } }]),
  }));
  assert.equal(find(offerings, 'generic').pricing.cache_write, 3);
  assert.equal(find(offerings, 'both').pricing.cache_write, 2);
  assert.equal(find(offerings, 'preferred').pricing.cache_write, 4);
  assert.equal(find(offerings, 'none').pricing.cache_write, null);
});

test('missing fields stay null and zero prices are never published as free', () => {
  const { offerings, skipped } = parseOne(modelOf('sparse', {
    partial: hostOf([{ tokens: { input: usd(5), output: usd(0) } }], { context_window: undefined, max_output_tokens: null }),
    free: hostOf([simple(0, 0)]),
    nouns: hostOf([{ tokens: { input: { price: { USD: 1 } }, output: usd(2) } }]),
  }));
  const partial = find(offerings, 'partial');
  assert.equal(partial.pricing.output, null);
  assert.equal(partial.pricing.cache_read, null);
  assert.equal(partial.pricing.cache_write, null);
  assert.equal(partial.context_length, null);
  assert.equal(partial.max_completion_tokens, null);
  assert.equal(find(offerings, 'nouns').pricing.input, null);

  assert.equal(find(offerings, 'free'), undefined);
  assert.ok(skipped.some((s) => s.reason === 'no-price' && s.provider === 'free'));
});

test('unknown hosts pass through, the three new hosts are named, and concentrate is skipped', () => {
  const { offerings } = parseOne(modelOf('multi', {
    anthropic: hostOf([simple(1, 2)]),
    bedrock: hostOf([simple(1, 2)]),
    'ai-studio': hostOf([simple(1, 2)]),
    zai: hostOf([simple(1, 2)]),
    'azure-fw': hostOf([simple(1, 2)]),
    concentrate: hostOf([simple(1, 2)]),
    'new-host': hostOf([simple(1, 2)]),
  }));
  assert.deepEqual([...new Set(offerings.map((o) => o.provider))].sort(),
    ['amazon', 'anthropic', 'azure-fw', 'google', 'new-host', 'z-ai']);
  assert.equal(CONCENTRATE_PROVIDER_MAP.zai, 'z-ai');
  assert.equal(CONCENTRATE_PROVIDER_DISPLAY['azure-fw'], 'Azure (Fireworks)');
  assert.equal(CONCENTRATE_PROVIDER_DISPLAY.typesafe, 'Typesafe');
  assert.equal(CONCENTRATE_PROVIDER_DISPLAY.bluelobster, 'Blue Lobster');
  assert.equal(offerings.some((o) => o.provider === 'concentrate'), false);
});

test('vertex and ai-studio collapse onto google, keeping ai-studio', () => {
  const { offerings, skipped } = parseConcentrate(FIXTURE);
  const gemini = offerings.filter((o) => o.slug === 'gemini-4-argon');
  assert.deepEqual([...new Set(gemini.map((o) => o.provider))], ['google']);
  assert.deepEqual([...new Set(gemini.map((o) => o.concentrateProvider))], ['ai-studio']);
  const duplicate = skipped.find((s) => s.reason === 'duplicate-host');
  assert.equal(duplicate.slug, 'gemini-4-argon');
  assert.equal(duplicate.provider, 'google');
  assert.match(duplicate.detail, /vertex \(kept ai-studio\)/);
  assert.doesNotMatch(duplicate.detail, /base prices differ/);
});

test('a duplicate host with a different base price reports the disagreement', () => {
  const { skipped } = parseOne(modelOf('split', {
    vertex: hostOf([simple(2, 10)]),
    'ai-studio': hostOf([simple(3, 10)]),
  }));
  const duplicate = skipped.find((s) => s.reason === 'duplicate-host');
  assert.match(duplicate.detail, /base prices differ/);
  assert.match(duplicate.detail, /vertex \$2\/\$10 vs ai-studio \$3\/\$10/);
});

// ── reconciliation ──────────────────────────────────────────────────────────

test('reconcileConcentrate resolves dotted, dashed and alias spellings', () => {
  const { offerings } = parseOne(modelOf('x-y-9', {
    hosta: hostOf([simple(2, 6)]),
  }, { aliases: ['x.y.9'] }));
  const rows = [
    { id: 'org/x-y-9', name: 'X Y 9', org: 'x', provider: 'hosta', quantization: null, discount: 0, pricing: { input: 2, output: 6 } },
  ];
  const dottedRow = reconcileConcentrate(offerings, [
    { id: 'other/x.y.9', name: 'X Y 9', org: 'x', provider: 'hosta', quantization: null, discount: 0, pricing: { input: 2, output: 6 } },
  ]);
  assert.equal(dottedRow.shared.length, 1);
  assert.equal(dottedRow.rows.length, 0);

  // The dashed id matches an alias written with dots (loose key).
  const { offerings: aliasOfferings } = parseOne(modelOf('plain-1', {
    hosta: hostOf([simple(2, 6)]),
  }, { aliases: ['plain.1'] }));
  const loose = reconcileConcentrate(aliasOfferings, rows.map((r) => ({ ...r, id: 'org/plain-1' })));
  assert.equal(loose.shared.length, 1);
});

test('unmatched models never emit rows', () => {
  const { offerings } = parseOne(modelOf('mystery-model', { hosta: hostOf([simple(2, 6)]) }));
  const result = reconcileConcentrate(offerings, [
    { id: 'org/other-model', name: 'Other', org: 'o', provider: 'hosta', quantization: null, discount: 0, pricing: { input: 1, output: 1 } },
  ]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.shared.length, 0);
  assert.deepEqual(result.unmatchedModels, [{ slug: 'mystery-model', name: 'mystery-model', author: 'test-org' }]);
});

test('a model matching two canonical ids is ambiguous and skipped', () => {
  const { offerings } = parseOne(modelOf('model-x', { hosta: hostOf([simple(2, 6)]) }));
  const result = reconcileConcentrate(offerings, [
    { id: 'a/model-x', provider: 'a', quantization: null, discount: 0, pricing: { input: 1, output: 2 } },
    { id: 'b/model.x', provider: 'b', quantization: null, discount: 0, pricing: { input: 1, output: 2 } },
  ]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped[0].reason, 'ambiguous-model');
  assert.match(result.skipped[0].detail, /model-x/);
  assert.match(result.skipped[0].detail, /model\.x/);
});

test('a model that exists only as quantized ids is skipped as quant-only', () => {
  const { offerings } = parseOne(modelOf('glm-9', { novita: hostOf([simple(2, 6)]) }));
  const result = reconcileConcentrate(offerings, [
    { id: 'z-ai/glm-9-fp8', provider: 'novita', quantization: 'fp8', discount: 0, pricing: { input: 2, output: 6 } },
    { id: 'z-ai/glm-9-int4', provider: 'novita', quantization: 'int4', discount: 0, pricing: { input: 2, output: 6 } },
  ]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.skipped[0].reason, 'quant-only');
});

test('the quantization guard blocks a pair that already has a quant row at that host', () => {
  const { offerings } = parseOne(modelOf('glm-9', {
    novita: hostOf([simple(2, 6)]),
    deepinfra: hostOf([simple(2, 6)]),
    fireworks: hostOf([simple(2, 6)]),
  }));
  const existing = [
    { id: 'z-ai/glm-9', name: 'GLM 9', org: 'z-ai', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 2, output: 6 } },
    { id: 'z-ai/glm-9-fp8', name: 'GLM 9', org: 'z-ai', provider: 'novita', quantization: 'fp8', discount: 0, pricing: { input: 2, output: 6 } },
    { id: 'z-ai/glm-9-int4', name: 'GLM 9', org: 'z-ai', provider: 'novita', quantization: 'int4', discount: 0, pricing: { input: 2, output: 6 } },
  ];
  const result = reconcileConcentrate(offerings, existing);

  const quantSkip = result.skipped.find((s) => s.reason === 'quant-variant');
  assert.equal(quantSkip.provider, 'novita');
  assert.match(quantSkip.detail, /z-ai\/glm-9-fp8 \(fp8\)/);
  assert.match(quantSkip.detail, /z-ai\/glm-9-int4 \(int4\)/);
  assert.equal(result.rows.some((r) => r.provider === 'novita'), false);

  // A quant row at another provider does not block this one.
  assert.ok(result.rows.some((r) => r.provider === 'fireworks' && r.id === 'z-ai/glm-9'));
  // The plain row at deepinfra is shared, never re-emitted.
  assert.ok(result.shared.some((pair) => pair.row.provider === 'deepinfra'));
  assert.equal(result.rows.some((r) => r.provider === 'deepinfra'), false);
  // The emitted id reuses the quant-free row's id, preferring the namespaced one.
  assert.ok(result.rows.some((r) => r.id === 'z-ai/glm-9' && r.name === 'GLM 9' && r.org === 'z-ai'));
});

test('a quant row whose id lost its quantization tag still blocks the pair', () => {
  const { offerings } = parseOne(modelOf('glm-9', { novita: hostOf([simple(2, 6)]) }));
  const result = reconcileConcentrate(offerings, [
    { id: 'z-ai/glm-9', provider: 'deepinfra', quantization: null, discount: 0, pricing: { input: 2, output: 6 } },
    { id: 'z-ai/glm-9-fp8', provider: 'novita', quantization: null, discount: 0, pricing: { input: 2, output: 6 } },
  ]);
  assert.equal(result.skipped[0].reason, 'quant-variant');
  assert.match(result.skipped[0].detail, /z-ai\/glm-9-fp8/);
});

test('reconcileConcentrate emits the house row shape', () => {
  const { offerings } = parseOne(modelOf('jev-1.13.0', {
    typesafe: hostOf([simple(1, 2)], { zdr: true }),
  }));
  const result = reconcileConcentrate(offerings, [
    { id: 'other/jev-1.13.0', name: 'Jev', org: 'typesafe', provider: 'other', quantization: null, discount: 0, pricing: { input: 1, output: 2 } },
  ]);
  assert.equal(result.rows.length, 1);
  const [row] = result.rows;
  assert.equal(row.id, 'other/jev-1.13.0');
  assert.equal(row.name, 'Jev');
  assert.equal(row.org, 'typesafe');
  assert.equal(row.provider, 'typesafe');
  assert.equal(row.provider_display, 'Typesafe');
  assert.equal(row.quantization, null);
  assert.equal(row.discount, 0);
  assert.equal(row.zdr, true);
  assert.equal(row.pricing.input, 1);

  const quiet = reconcileConcentrate(parseOne(modelOf('jev-2', { typesafe: hostOf([simple(1, 2)]) })).offerings, [
    { id: 'other/jev-2', provider: 'other', quantization: null, discount: 0, pricing: { input: 1, output: 2 } },
  ]).rows[0];
  assert.equal(Object.hasOwn(quiet, 'zdr'), false);
  // Only the three hosts TokenWatch has no other source for carry a display name.
  const amazon = reconcileConcentrate(parseOne(modelOf('m-1', { bedrock: hostOf([simple(1, 2)]) })).offerings, [
    { id: 'openai/m-1', provider: 'openai', quantization: null, discount: 0, pricing: { input: 1, output: 2 } },
  ]).rows[0];
  assert.equal(amazon.provider, 'amazon');
  assert.equal(Object.hasOwn(amazon, 'provider_display'), false);
});

test('tier variants reuse the covered model id with a :tier suffix', () => {
  const { offerings } = parseConcentrate(FIXTURE);
  const existing = [{
    id: 'openai/gpt-6-astra',
    name: 'OpenAI: GPT-6 Astra',
    org: 'openai',
    provider: 'openai',
    quantization: 'unknown',
    discount: 0,
    pricing: { input: 10, output: 50 },
  }];
  const result = reconcileConcentrate(offerings, existing);
  const ids = result.rows.filter((r) => r.provider === 'openai').map((r) => r.id).sort();
  assert.deepEqual(ids, [
    'openai/gpt-6-astra:fast',
    'openai/gpt-6-astra:flex',
    'openai/gpt-6-astra:priority',
  ]);
  assert.ok(result.shared.some((pair) => pair.row.id === 'openai/gpt-6-astra'));
});

// ── join + drift ────────────────────────────────────────────────────────────

test('concentrateJoin fills only nulls and never overwrites', () => {
  const row = {
    id: 'org/model',
    provider: 'hosta',
    context_length: null,
    max_prompt_tokens: 1000,
    max_completion_tokens: null,
    zdr: true,
    discount: 0,
    pricing: { input: 2, output: 6, cache_read: null },
  };
  const offering = {
    context_length: 5555,
    max_prompt_tokens: 2000,
    max_completion_tokens: 777,
    zdr: false,
    pricing: { input: 2, output: 6, cache_read: 0.5 },
  };
  const { filled, drift } = concentrateJoin([{ row, offering }]);
  assert.deepEqual(filled, { context_length: 1, max_prompt_tokens: 0, max_completion_tokens: 1 });
  assert.equal(row.context_length, 5555);
  assert.equal(row.max_prompt_tokens, 1000);
  assert.equal(row.max_completion_tokens, 777);
  assert.equal(row.zdr, true);
  assert.equal(row.pricing.cache_read, null);
  assert.equal(drift.mismatch, 0);
  assert.equal(drift.agreeing, 1);
  assert.equal(drift.zdr.twOnly.count, 1);
  assert.equal(drift.zdr.concentrateOnly.count, 0);
  assert.deepEqual(drift.zdr.twOnly.examples, [{ id: 'org/model', provider: 'hosta' }]);
});

test('drift flags gaps over 1%, skips promo rows and sorts by gap', () => {
  const pairFor = (id, tw, offering, discount = 0) => ({
    row: { id, provider: 'hosta', discount, pricing: tw },
    offering: { pricing: offering },
  });
  const { drift } = concentrateJoin([
    pairFor('close', { input: 1, output: 2 }, { input: 1.005, output: 2 }),
    pairFor('big', { input: 1, output: 3 }, { input: 1, output: 2 }),
    pairFor('promo', { input: 1, output: 1 }, { input: 2, output: 2 }, 0.25),
    pairFor('cache', { input: 1, output: 1, cache_read: null }, { input: 1, output: 1, cache_read: 0.4 }),
  ]);
  assert.equal(drift.total, 4);
  assert.equal(drift.promo, 1);
  assert.equal(drift.compared, 3);
  assert.equal(drift.agreeing, 2);
  assert.equal(drift.mismatch, 1);
  assert.equal(drift.rows[0].id, 'big');
  assert.equal(drift.rows[0].field, 'output');
  assert.ok(Math.abs(drift.rows[0].gap - 1 / 3) < 1e-9);
});

test('drift reports context-length and ZDR disagreements in both directions', () => {
  const { drift } = concentrateJoin([
    {
      row: { id: 'a/model', provider: 'hosta', context_length: 128000, zdr: true, discount: 0, pricing: { input: 1, output: 2 } },
      offering: { context_length: 200000, zdr: false, pricing: { input: 1, output: 2 } },
    },
    {
      row: { id: 'b/model', provider: 'hostb', context_length: 64000, discount: 0, pricing: { input: 1, output: 2 } },
      offering: { context_length: 64000, zdr: true, pricing: { input: 1, output: 2 } },
    },
    {
      row: { id: 'c/model', provider: 'hostc', context_length: 32000, discount: 0, pricing: { input: 1, output: 2 } },
      offering: { context_length: 32000, zdr: null, pricing: { input: 1, output: 2 } },
    },
  ]);
  assert.equal(drift.context_length.length, 1);
  assert.equal(drift.context_length[0].tw, 128000);
  assert.equal(drift.context_length[0].concentrate, 200000);
  assert.equal(drift.zdr.twOnly.count, 1);
  assert.equal(drift.zdr.concentrateOnly.count, 1);
  assert.deepEqual(drift.zdr.concentrateOnly.examples, [{ id: 'b/model', provider: 'hostb' }]);
});

test('the pipeline wires Concentrate last and never needs an API key', async () => {
  const pricing = await readFile(new URL('../scripts/fetch-pricing.mjs', import.meta.url), 'utf8');
  const lib = await readFile(new URL('../scripts/lib.mjs', import.meta.url), 'utf8');
  assert.match(pricing, /key: 'concentrate'/);
  assert.match(pricing, /parseConcentrate\(data\)/);
  assert.match(pricing, /reconcileConcentrate\(parsed\.offerings, tieredModels\)/);
  assert.match(pricing, /concentrateJoin\(shared\)/);
  assert.match(pricing, /CONCENTRATE_MODELS_URL/);
  assert.equal(/CONCENTRATE_API_KEY/.test(pricing + lib), false);
  // The fetch happens after the Refuseless block, so every other tier wins.
  assert.ok(pricing.indexOf('Concentrate (aggregator catalog, last tier)') > pricing.indexOf("console.error(`✗ Refuseless: ${err.message}`)"));
});
