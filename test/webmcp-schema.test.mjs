import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function extractJsonParseBlob(src, constName) {
  const needle = `const ${constName} = JSON.parse(\``;
  const start = src.indexOf(needle);
  assert.notEqual(start, -1, `${constName} JSON.parse blob not found`);
  const jsonStart = start + needle.length;
  const end = src.indexOf('`)', jsonStart);
  assert.notEqual(end, -1, `${constName} JSON.parse blob terminator not found`);
  return JSON.parse(src.slice(jsonStart, end));
}

const STARRED = ['get_view', 'set_workload', 'set_filters', 'compare_models', 'explain_ranking', 'get_share_url'];
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

test('text WebMCP tool defs: 20 tools, valid names, additionalProperties false', async () => {
  const src = await readFile(join(ROOT, 'public/webmcp.js'), 'utf8');
  const defs = extractJsonParseBlob(src, 'TEXT_TOOL_DEFS');
  assert.equal(defs.length, 20, 'text page registers 20 tools');

  const names = defs.map((d) => d.name);
  assert.deepEqual(new Set(names).size, names.length, 'tool names must be unique');
  assert.equal([...names].sort()[0], 'about_tokenwatch', 'about_tokenwatch must sort first in Chrome getTools()');
  const oneliner = 'For operational details, call about_tokenwatch.';
  for (const def of defs) {
    if (def.name === 'about_tokenwatch') continue;
    assert.ok(def.description.includes(oneliner), `${def.name} must point at about_tokenwatch`);
  }
  for (const name of STARRED) {
    assert.ok(names.includes(name), `starred contest tool missing: ${name}`);
  }

  for (const def of defs) {
    assert.match(def.name, NAME_RE, `invalid tool name: ${def.name}`);
    assert.equal(typeof def.title, 'string');
    assert.ok(def.title.length > 0, `${def.name} needs a title`);
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 20, `${def.name} description too short`);
    assert.equal(def.inputSchema?.type, 'object', `${def.name} inputSchema.type`);
    assert.equal(def.inputSchema.additionalProperties, false, `${def.name} must set additionalProperties: false`);
    assert.ok(def.annotations && typeof def.annotations.readOnlyHint === 'boolean', `${def.name} annotations.readOnlyHint`);
  }

  const reads = defs.filter((d) => d.annotations.readOnlyHint === true).map((d) => d.name);
  for (const name of ['about_tokenwatch', 'get_view', 'explain_ranking', 'get_share_url', 'get_catalog_info', 'list_presets', 'get_model']) {
    assert.ok(reads.includes(name), `${name} should be readOnlyHint: true`);
  }
  for (const name of ['set_workload', 'set_sort', 'set_filters', 'compare_models', 'export_csv']) {
    const def = defs.find((d) => d.name === name);
    assert.equal(def.annotations.readOnlyHint, false, `${name} mutates the page`);
  }
});

test('set_workload and set_filters schemas use enums; compare uses {provider,id}', async () => {
  const src = await readFile(join(ROOT, 'public/webmcp.js'), 'utf8');
  const defs = extractJsonParseBlob(src, 'TEXT_TOOL_DEFS');
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));

  assert.deepEqual(byName.set_workload.inputSchema.properties.costMode.enum, ['perRequest', 'monthly']);
  assert.deepEqual(byName.set_workload.inputSchema.properties.computeBy.enum, ['tokens', 'budget']);
  assert.deepEqual(byName.set_filters.inputSchema.properties.groupBy.enum, ['none', 'org', 'provider']);
  assert.deepEqual(byName.apply_preset.inputSchema.properties.name.enum, ['agentic', 'balanced', 'heavy-output', 'no-cache']);
  assert.deepEqual(byName.set_sort.inputSchema.properties.by.enum, ['org', 'provider', 'model', 'input', 'output', 'cache_read', 'context', 'speed', 'ttft', 'blended', 'cost']);
  assert.deepEqual(byName.set_sort.inputSchema.properties.dir.enum, ['asc', 'desc']);
  assert.deepEqual(byName.compare_models.inputSchema.properties.action.enum, ['add', 'remove', 'clear', 'set']);
  assert.deepEqual(byName.compare_models.inputSchema.properties.models.items.required, ['provider', 'id']);
  assert.deepEqual(byName.open_detail.inputSchema.required, ['provider', 'id']);

  const filterProps = byName.set_filters.inputSchema.properties;
  assert.equal(filterProps.hideBatch.type, 'boolean');
  assert.equal(filterProps.cacheOnly.type, 'boolean');
  assert.equal(filterProps.maxBlended.type, 'number');
  assert.equal(filterProps.minToks.type, 'number');
  assert.equal(filterProps.hq.type, 'string');
  assert.match(byName.set_filters.description, /hideBatch/);
  assert.match(byName.clear_filters.description, /hide-batch/);
  assert.match(byName.get_view.description, /ttftP50/);
});

test('index.html loads webmcp.js after app.js; bust-cache fingerprints it', async () => {
  const html = await readFile(join(ROOT, 'public/index.html'), 'utf8');
  const appIdx = html.indexOf('src="/app.js');
  const mcpIdx = html.indexOf('src="/webmcp.js');
  assert.ok(appIdx !== -1 && mcpIdx !== -1, 'index.html must reference app.js and webmcp.js');
  assert.ok(mcpIdx > appIdx, 'webmcp.js must load after app.js');

  const bust = await readFile(join(ROOT, 'scripts/bust-cache.mjs'), 'utf8');
  assert.match(bust, /['"]webmcp\.js['"]/, 'bust-cache FINGERPRINT must include webmcp.js');
});

test('image and video pages expose about_tokenwatch plus get_view/set_sort tools', async () => {
  const src = await readFile(join(ROOT, 'public/webmcp.js'), 'utf8');
  const defs = extractJsonParseBlob(src, 'MEDIA_TOOL_DEFS');

  assert.deepEqual(Object.keys(defs).sort(), ['image', 'video']);
  assert.deepEqual(defs.image.map((d) => d.name), ['about_tokenwatch', 'get_view', 'get_catalog_info', 'set_sort']);
  assert.deepEqual(defs.video.map((d) => d.name), ['about_tokenwatch', 'get_view', 'get_catalog_info', 'set_sort']);
  assert.deepEqual(defs.image.find((d) => d.name === 'set_sort').inputSchema.properties.by.enum,
    ['org', 'model', 'cost_per_unit', 'cost']);
  assert.deepEqual(defs.video.find((d) => d.name === 'set_sort').inputSchema.properties.by.enum,
    ['org', 'model', 'resolution', 'audio', 'cost_per_second', 'cost']);

  for (const page of ['image', 'video']) {
    for (const def of defs[page]) {
      assert.equal(def.inputSchema.additionalProperties, false);
      assert.equal(typeof def.annotations.readOnlyHint, 'boolean');
      if (def.name !== 'about_tokenwatch') {
        assert.ok(def.description.includes('For operational details, call about_tokenwatch.'));
      }
    }
    const html = await readFile(join(ROOT, `public/${page}.html`), 'utf8');
    const appIdx = html.indexOf(`src="/${page}-app.js`);
    const mcpIdx = html.indexOf('src="/webmcp.js');
    assert.ok(appIdx !== -1 && mcpIdx !== -1, `${page}.html must load its app and webmcp.js`);
    assert.ok(mcpIdx > appIdx, `${page}.html must load webmcp.js after its app`);

    const app = await readFile(join(ROOT, 'public', `${page}-app.js`), 'utf8');
    assert.match(app, /function getView\(input\)/);
    assert.match(app, /function getCatalogInfo\(\)/);
    assert.match(app, /function setSort\(input\)/);
    assert.match(app, new RegExp(`page: '${page}'`));
    assert.match(app, /getCatalogInfo,/);
    assert.match(app, /computeAndRender\(\);\s*publishTwCatalog\(\);/,
      `${page} init must publish after its first render`);
  }
});
