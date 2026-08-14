import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseOpenCodeGoDocs, openCodeGoIdFromName } from '../scripts/lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'opencode-docs.html');

let fixture;
try {
  fixture = await readFile(fixturePath, 'utf8');
} catch {
  fixture = null;
}
// Fail loudly at setup — the tests below are meaningless without real HTML.
assert.ok(fixture, `opencode-docs.html fixture missing or unreadable at ${fixturePath}`);

// ── id mapping ────────────────────────────────────────────────────────────────

test('openCodeGoIdFromName: plain names lowercase + hyphenate', () => {
  assert.equal(openCodeGoIdFromName('Grok 4.5'), 'grok-4.5');
  assert.equal(openCodeGoIdFromName('DeepSeek V4 Flash'), 'deepseek-v4-flash');
  assert.equal(openCodeGoIdFromName('MiniMax M3'), 'minimax-m3');
  assert.equal(openCodeGoIdFromName('Hy3'), 'hy3');
});

test('openCodeGoIdFromName: ≤ tier is the base id', () => {
  assert.equal(openCodeGoIdFromName('Qwen3.7 Plus (≤ 256K tokens)'), 'qwen3.7-plus');
  assert.equal(openCodeGoIdFromName('GPT 5.6 Luna (≤ 272K tokens)'), 'gpt-5.6-luna');
});

test('openCodeGoIdFromName: > tier gets the -long suffix (matches legacy hardcode ids)', () => {
  assert.equal(openCodeGoIdFromName('Qwen3.7 Plus (> 256K tokens)'), 'qwen3.7-plus-long');
  assert.equal(openCodeGoIdFromName('GPT 5.6 Luna (> 272K tokens)'), 'gpt-5.6-luna-long');
});

test('openCodeGoIdFromName: empty/blank names return null', () => {
  assert.equal(openCodeGoIdFromName(''), null);
  assert.equal(openCodeGoIdFromName('   '), null);
});

// ── table scraping ────────────────────────────────────────────────────────────

test('parseOpenCodeGoDocs finds the pricing table by its "Cached Read" header', () => {
  const rows = parseOpenCodeGoDocs(fixture);
  // Fixture mirrors the live docs structure: a request-estimate table
  // (Model | requests per 5 hour | …) precedes the pricing table.
  assert.ok(rows.length >= 20, `expected >=20 priced rows, got ${rows.length}`);
  const ids = rows.map((r) => r.id);
  for (const expected of [
    'grok-4.5', 'gpt-5.6-luna', 'gpt-5.6-luna-long', 'glm-5.3', 'glm-5.2',
    'kimi-k3', 'mimo-v2.5-pro', 'minimax-m2.5', 'qwen3.8-max',
    'qwen3.6-plus-long', 'deepseek-v4-pro', 'hy3',
  ]) {
    assert.ok(ids.includes(expected), `${expected} should be scraped`);
  }
});

test('parseOpenCodeGoDocs parses $ prices into $/M numbers', () => {
  const rows = parseOpenCodeGoDocs(fixture);
  const glm52 = rows.find((r) => r.id === 'glm-5.2');
  assert.ok(glm52, 'glm-5.2 present');
  assert.equal(glm52.input, 1.4);
  assert.equal(glm52.output, 4.4);
  assert.equal(glm52.cache_read, 0.26);
  assert.equal(glm52.cache_write, null, '"-" cached-write cell → null');
});

test('parseOpenCodeGoDocs captures cache_write where published', () => {
  const rows = parseOpenCodeGoDocs(fixture);
  const qwen38 = rows.find((r) => r.id === 'qwen3.8-max');
  assert.ok(qwen38, 'qwen3.8-max present');
  assert.equal(qwen38.cache_write, 2.5);
});

test('parseOpenCodeGoDocs strips tier suffix from display name', () => {
  const rows = parseOpenCodeGoDocs(fixture);
  const luna = rows.find((r) => r.id === 'gpt-5.6-luna');
  assert.equal(luna.name, 'GPT 5.6 Luna');
});

test('parseOpenCodeGoDocs skips rows with missing input/output prices', () => {
  const rows = parseOpenCodeGoDocs(fixture);
  for (const r of rows) {
    assert.ok(r.input > 0 && r.output > 0, `${r.id} must have positive input+output`);
  }
});

// Regression pin: the legacy hardcode had drifted 4× stale on these models
// (1.74/3.48 vs the docs' real 0.435/0.87). The scraper must reflect the docs.
test('parseOpenCodeGoDocs: MiMo V2.5 Pro + DeepSeek V4 Pro use current docs prices', () => {
  const rows = parseOpenCodeGoDocs(fixture);
  const mimo = rows.find((r) => r.id === 'mimo-v2.5-pro');
  assert.equal(mimo.input, 0.435);
  assert.equal(mimo.output, 0.87);
  const ds = rows.find((r) => r.id === 'deepseek-v4-pro');
  assert.equal(ds.input, 0.435);
  assert.equal(ds.output, 0.87);
});

test('parseOpenCodeGoDocs returns [] when no pricing table exists', () => {
  const html = '<html><body><table><thead><tr><th>Model</th><th>requests per 5 hour</th></tr></thead><tbody></tbody></table></body></html>';
  assert.deepEqual(parseOpenCodeGoDocs(html), []);
});
