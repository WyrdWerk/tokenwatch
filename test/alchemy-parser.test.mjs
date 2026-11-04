import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAlchemy, dedupKey, normalizeProvider } from '../scripts/lib.mjs';

// Live snapshot of https://inference.alchemy.com/docs/models.md (2026-11-03).
const MARKDOWN = await readFile(new URL('./fixtures/alchemy-models.md', import.meta.url), 'utf8');
// Live /v1/models response for an org without credit (2026-11-03).
const API_402 = JSON.parse(
  await readFile(new URL('./fixtures/alchemy-v1-models-402.json', import.meta.url), 'utf8')
);

test('parseAlchemy reads the serverless models price table', () => {
  const rows = parseAlchemy({ markdown: MARKDOWN });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((m) => m.provider === 'alchemy'));
  const kimi = rows.find((m) => m.id === 'Kimi-K3');
  assert.equal(kimi.org, 'moonshot');
  assert.equal(kimi.name, 'Kimi K3');
  assert.deepEqual(kimi.pricing, { input: 2.5, output: 12.82, cache_read: 0.252, cache_write: null });
  assert.equal(kimi.context_length, 1048576);
  assert.equal(kimi.max_completion_tokens, 131072);
  assert.deepEqual(kimi.input_modalities, ['text', 'image']);
  const glm = rows.find((m) => m.id === 'GLM-5.3');
  assert.deepEqual(glm.input_modalities, ['text']);
  assert.equal(glm.pricing.cache_read, 0.162);
});

test('parseAlchemy resolves aliased ids onto existing catalog rows', () => {
  const keys = parseAlchemy({ markdown: MARKDOWN }).map(dedupKey).sort();
  assert.deepEqual(keys, [
    'deepseek-v4.1-flash-1017|alchemy',
    'glm-5.3-flash|alchemy',
    'glm-5.3|alchemy',
    'kimi-k3|alchemy',
  ]);
  // Display ids keep Alchemy's casing (as Wafer's rows do); dedup is case-insensitive.
  const ds = parseAlchemy({ markdown: MARKDOWN }).find((m) => m.id === 'DeepSeek-V4.1-Flash-1017');
  assert.deepEqual(ds.pricing, { input: 0.22, output: 0.89, cache_read: 0.006, cache_write: null });
  assert.equal(normalizeProvider('Alchemy Inference'), 'alchemy');
});

test('parseAlchemy lets /v1/models narrow the list and set limits', () => {
  // Shape from https://inference.alchemy.com/docs/api-reference/list-models.
  const catalog = {
    object: 'list',
    data: [
      { id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', object: 'model', created: 0, owned_by: 'alchemy', max_context: 1048576, max_output: 65536 },
      { id: 'example/Unpriced-Model', object: 'model', created: 0, owned_by: 'alchemy', max_context: 8192, max_output: 4096 },
    ],
  };
  const rows = parseAlchemy({ markdown: MARKDOWN, catalog });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'DeepSeek-V4.1-Flash-1017');
  assert.equal(rows[0].max_completion_tokens, 65536);
});

test('parseAlchemy ignores an error body in place of the catalog', () => {
  assert.equal(parseAlchemy({ markdown: MARKDOWN, catalog: API_402 }).length, 4);
});

test('parseAlchemy throws when the docs table changes shape', () => {
  assert.throws(() => parseAlchemy({ markdown: '# Models\n\nNothing here.' }), /Serverless models/);
  const noCached = MARKDOWN.replace('| Cached input price ', '| Cache ');
  assert.throws(() => parseAlchemy({ markdown: noCached }), /cached input price/);
});
