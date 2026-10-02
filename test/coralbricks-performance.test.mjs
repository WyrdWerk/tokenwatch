import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as performance from '../shared/performance.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/coralbricks-auth-models.json', import.meta.url), 'utf8'));

test('CoralBricks performance uses 30m measurements, seconds-to-ms TTFT, and reported speed rather than p50', () => {
  const data = performance.parseCoralbricksPerformance(fixture);
  const deepseek = data['deepseek-v4.1-flash-fast-fp4|coralbricks'];
  assert.equal(deepseek.source, 'coralbricks');
  assert.deepEqual(deepseek.throughput, {reported: 529.5, window: '30m'});
  assert.deepEqual(deepseek.latency, {p50: 570, window: '30m'});
  assert.deepEqual(deepseek.cache_hit_rate, {percent: 94.6, window: '30m'});
  assert.equal(deepseek.throughput.p50, undefined);
  assert.equal(data['glm-5.3-fp4|coralbricks'].throughput.reported, 317.5);
  assert.equal(data['glm-5.3-fp4|coralbricks'].latency.p50, 450);
});

test('CoralBricks performance keeps one-day fallback labelled and never borrows another SKU', () => {
  const data = performance.parseCoralbricksPerformance(fixture);
  const flash = data['glm-5.3-flash-fp4|coralbricks'];
  assert.deepEqual(flash.throughput, {reported: 291.7, window: '1d'});
  assert.deepEqual(flash.latency, {p50: 350, window: '1d'});
  assert.deepEqual(flash.cache_hit_rate, {percent: 96, window: '1d'});
  assert.equal(data['glm-5.3-flash|coralbricks'], undefined);
});

test('CoralBricks partial metrics keep zero measurements, reject invalid values, and omit unmeasured models', () => {
  const data = performance.parseCoralbricksPerformance({data: [
    {id: 'only-latency-fp4', latency_last_30m: 0, decode_speed_last_30m: -1, cache_hit_rate_last_30m: 101},
    {id: 'mixed-windows-fp4', decode_speed_last_30m: '123', decode_speed_last_1d: 87.2, cache_hit_rate_last_30m: 0, latency_last_30m: Infinity},
    {id: 'no-measurements-fp4'}, null,
  ]});
  assert.deepEqual(data['only-latency-fp4|coralbricks'], {
    source: 'coralbricks', latency: {p50: 0, window: '30m'}, throughput: null, cache_hit_rate: null,
  });
  assert.deepEqual(data['mixed-windows-fp4|coralbricks'].throughput, {reported: 87.2, window: '1d'});
  assert.deepEqual(data['mixed-windows-fp4|coralbricks'].cache_hit_rate, {percent: 0, window: '30m'});
  assert.equal(data['no-measurements-fp4|coralbricks'], undefined);
  assert.deepEqual(performance.parseCoralbricksPerformance({models: [{slug: 'glm-5.3-fp4'}]}), {});
});

test('frontend displays reported speed and its window without relabelling it as p50', async () => {
  const src = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const getterStart = src.indexOf('function speedFor(');
  assert.ok(getterStart >= 0, 'shared displayed/sorted speed getter exists');
  const getter = src.slice(getterStart, src.indexOf('\nfunction isBatchOrFreeId(', getterStart));
  const cells = src.slice(src.indexOf('function renderSpeedCell('), src.indexOf('\nfunction globalBestValue('));
  const run = new Function('perf', `const getPerfData = () => perf; const esc = String;
    ${getter}\n${cells}\n${src.slice(src.indexOf('function fmtTtftSeconds('), src.indexOf('\nfunction ttftP50Seconds('))}
    return {speed: speedFor({}), html: renderSpeedCell({}), ttft: renderTtftCell({})};`);
  const reported = run({source: 'coralbricks', throughput: {reported: 291.7, window: '1d'}, latency: {p50: 350, window: '1d'}});
  assert.equal(reported.speed, 291.7);
  assert.match(reported.html, /291.7/);
  assert.match(reported.html, /reported/i);
  assert.match(reported.html, /1d/);
  assert.doesNotMatch(reported.html, /p50/);
  assert.match(reported.ttft, /0.35/);
  assert.match(reported.ttft, /CoralBricks.*1d/);
  const median = run({throughput: {p50: 47.8}, latency: {p50: 1200}});
  assert.equal(median.speed, 47.8);
  assert.match(median.html, /p50/);
  assert.doesNotMatch(median.html, /reported/i);
  assert.equal(run(null).speed, null);
});

test('all pricing and performance refresh steps receive CORAL_API_KEY', async () => {
  for (const [file, step] of [
    ['refresh-pricing.yml', 'Fetch & normalize text pricing'],
    ['refresh-pricing.yml', 'Fetch performance data (latency/tput every 2h)'],
    ['refresh-aa.yml', 'Re-fetch pricing with updated AA cache'],
    ['refresh-performance.yml', 'Fetch performance data'],
  ]) {
    const src = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    const block = src.split(`- name: ${step}\n`)[1]?.split('\n      - ')[0];
    assert.ok(block, `${file}: ${step} exists`);
    assert.match(block, /CORAL_API_KEY: \$\{\{ secrets.CORAL_API_KEY \}\}/, `${file}: ${step} injects the GitHub secret`);
  }
});
