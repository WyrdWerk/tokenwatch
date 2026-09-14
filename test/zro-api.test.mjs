import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Acceptance: the existing Cloudflare Pages Function routes must expose the
// Zro offering without any new API route. Uses a Zro-augmented copy of the
// shared API fixture so the existing suite's exact-count assertions are
// unaffected.
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

const api = await import('../functions/api/v1/[[route]].js');
const { onRequestGet } = api;

function makeAssets() {
  return {
    async fetch(url) {
      const u = new URL(url);
      let filePath;
      if (u.pathname === '/pricing.json') filePath = join(FIXTURES, 'pricing-zro.json');
      else if (u.pathname === '/image-pricing.json') filePath = join(FIXTURES, 'image-pricing.json');
      else if (u.pathname === '/video-pricing.json') filePath = join(FIXTURES, 'video-pricing.json');
      else return new Response('Not found', { status: 404 });
      try {
        return new Response(await readFile(filePath, 'utf-8'), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    },
  };
}

function makeContext(pathname, search = '') {
  return {
    request: new Request(`https://tokenwatch.test${pathname}${search}`),
    env: { ASSETS: makeAssets() },
  };
}

async function getJson(pathname, search = '') {
  const res = await onRequestGet(makeContext(pathname, search));
  return { status: res.status, body: await res.json() };
}

test('/api/v1/models?provider=zro returns the Zro offerings through the existing list route', async () => {
  const { status, body } = await getJson('/api/v1/models', '?provider=zro');
  assert.equal(status, 200);
  assert.equal(body.total, 3);
  const ids = body.models.map((m) => m.id).sort();
  assert.deepEqual(ids, ['anthropic/claude-sonnet-5', 'deepseek-v4.1-flash', 'google/gemini-3.1-pro']);
  for (const model of body.models) assert.equal(model.provider, 'zro');
});

test('/api/v1/models?provider=zro normalizes USD/M input, output, and cache_read prices', async () => {
  const { body } = await getJson('/api/v1/models', '?provider=zro');
  const flash = body.models.find((m) => m.id === 'deepseek-v4.1-flash');
  assert.ok(flash, 'deepseek-v4.1-flash offering present');
  assert.equal(flash.pricing.input, 0.15);
  assert.equal(flash.pricing.output, 0.6);
  assert.equal(flash.pricing.cache_read, 0.003);
  assert.equal(flash.pricing.cache_write, null);
  assert.equal(flash.discount, 0.5, 'promotion fraction preserved');
});

test('/api/v1/models/:canonicalId/providers returns the Zro offering for a shared canonical model', async () => {
  const { status, body } = await getJson('/api/v1/models/gemini-3.1-pro/providers');
  assert.equal(status, 200);
  const providers = body.providers.map((p) => p.provider);
  assert.ok(providers.includes('zro'), `zro must appear among ${providers.join(', ')}`);
  const zro = body.providers.find((p) => p.provider === 'zro');
  assert.equal(zro.pricing.input, 1.1);
  assert.equal(zro.pricing.output, 4.4);
  assert.equal(zro.uptime_30m, 99.7);
});

test('/api/v1/models/:canonicalId/providers mix-aware sort includes the Zro offering', async () => {
  const { body } = await getJson('/api/v1/models/claude-sonnet-5/providers', '?tokens=1000&mix=30,50,20');
  assert.ok(body.providers.some((p) => p.provider === 'zro'));
});

test('/api/v1/stats counts the Zro provider without a dedicated route', async () => {
  const { body } = await getJson('/api/v1/stats');
  assert.ok(body.providers.zro >= 1, 'stats.providers must include zro');
  assert.ok(body.source_providers.some((p) => p.key === 'zro'), 'source_providers must list zro');
});

test('/api/v1/providers exposes the Zro policy metadata entry', async () => {
  const { body } = await getJson('/api/v1/providers');
  assert.ok(body.providers_meta.zro, 'zro meta present');
  assert.equal(body.providers_meta.zro.privacy_policy_url, 'https://zro.moonmath.ai/privacy');
});

test('/api/v1/models?promo=true surfaces the discounted Zro offering', async () => {
  const { body } = await getJson('/api/v1/models', '?provider=zro&promo=true');
  assert.equal(body.total, 1);
  assert.equal(body.models[0].id, 'deepseek-v4.1-flash');
  assert.ok(body.models[0].discount > 0);
});