import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ROOT, '.agents', 'skills', 'operating-tokenwatch-webmcp', 'SKILL.md');

const TEXT_TOOLS = [
  'get_view', 'get_model', 'set_sort', 'explain_ranking', 'list_presets',
  'get_share_url', 'get_catalog_info', 'set_workload', 'apply_preset',
  'set_cache_write', 'set_filters', 'clear_filters', 'compare_models',
  'open_detail', 'highlight_tradeoff', 'export_csv', 'snapshot_compare',
  'download_cost_card', 'switch_catalog',
];

test('TokenWatch WebMCP skill documents tool contracts and human-readable reporting', async () => {
  const skill = await readFile(SKILL, 'utf8');
  assert.match(skill, /^---\nname: operating-tokenwatch-webmcp\n/);
  assert.ok(skill.split('\n').length < 500, 'skill should remain progressively loadable');
  assert.match(skill, /## Page capability map/);
  assert.match(skill, /## Proactive workflows/);
  assert.match(skill, /## Translating tool results into human-readable explanations/);
  assert.match(skill, /## Image-page contracts/);
  assert.match(skill, /## Video-page contracts/);
  for (const tool of TEXT_TOOLS) {
    assert.match(skill, new RegExp(`\\b${tool.replace('_', '_')}\\b`), `skill must document ${tool}`);
  }
  assert.match(skill, /Do not maintain a static list of\s+models/);
  assert.match(skill, /cost_per_unit/);
  assert.match(skill, /cost_per_second/);
  assert.match(skill, /`get_catalog_info\(\)` is also available on this page/);
  assert.match(skill, /excludedForUnsupportedMix/);
});
