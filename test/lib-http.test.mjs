import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fetchJsonWithRetry } from '../scripts/lib.mjs';

const URL = 'https://example.invalid/catalog';
const catalog = { data: [{ id: 'video-model', pricing_skus: { duration_seconds_720p: '0.08' } }] };
const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

function mockFetch(t, outcomes) {
  const waits = [];
  const warnings = [];
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    waits.push(ms);
    queueMicrotask(callback);
  });
  t.mock.method(console, 'warn', message => warnings.push(message));
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    const outcome = outcomes.shift();
    assert.ok(outcome, 'unexpected extra request');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { fetch, waits, warnings };
}

test('default GET recovers after two connection resets, with bounded backoff and fresh timeouts', async t => {
  const { fetch, waits, warnings } = mockFetch(t, [reset(), reset(), Response.json(catalog)]);
  const timeouts = t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  const actual = await fetchJsonWithRetry(URL, undefined, undefined, {
    apiKey: 'test-only-token', headers: { 'X-Catalog': 'video' },
  });
  assert.deepEqual(actual, catalog);
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(waits, [2000, 4000]);
  assert.deepEqual(timeouts.mock.calls.map(call => call.arguments), [[45000], [45000], [45000]]);
  const signals = new Set();
  for (const { arguments: [url, options] } of fetch.mock.calls) {
    assert.equal(url, URL);
    assert.deepEqual(options.headers, {
      Accept: 'application/json', 'X-Catalog': 'video', Authorization: 'Bearer test-only-token',
    });
    signals.add(options.signal);
  }
  assert.equal(signals.size, 3);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /ECONNRESET/);
  assert.doesNotMatch(warnings.join('\n'), /test-only-token/);
});

test('body transport errors share the retry budget with HTTP 429/5xx', async t => {
  const bodyError = new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } });
  const { fetch, waits } = mockFetch(t, [
    new Response('', { status: 429 }), new Response('', { status: 503 }),
    { ok: true, json: async () => { throw bodyError; } }, Response.json(catalog),
  ]);
  assert.deepEqual(await fetchJsonWithRetry(URL, 3, 7), catalog);
  assert.equal(fetch.mock.callCount(), 4);
  assert.deepEqual(waits, [7, 14, 28]);
});

for (const retries of [0, 1, 2]) {
  test(`persistent connection resets exhaust exactly ${retries + 1} attempts and preserve the last error`, async t => {
    const failures = Array.from({ length: retries + 1 }, reset);
    const finalError = failures.at(-1);
    const { fetch, waits } = mockFetch(t, failures);
    await assert.rejects(fetchJsonWithRetry(URL, retries, 5), error => error === finalError);
    assert.equal(fetch.mock.callCount(), retries + 1);
    assert.deepEqual(waits, [5, 10].slice(0, retries));
  });
}

for (const status of [401, 404, 429, 503]) {
  test(`HTTP ${status} ${status < 429 ? 'fails immediately' : 'fails after the retry budget'}`, async t => {
    const count = status === 429 || status >= 500 ? 3 : 1;
    const { fetch, waits } = mockFetch(t, Array.from({ length: 3 }, () => new Response('', { status })));
    await assert.rejects(fetchJsonWithRetry(URL), new RegExp(`HTTP ${status}`));
    assert.equal(fetch.mock.callCount(), count);
    assert.deepEqual(waits, count === 1 ? [] : [2000, 4000]);
  });
}

test('malformed JSON is fatal without another request', async t => {
  const { fetch, waits } = mockFetch(t, [new Response('{broken')]);
  await assert.rejects(fetchJsonWithRetry(URL), SyntaxError);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(waits, []);
});

test('explicit cancellation is fatal, including during body consumption', async t => {
  const abort = new DOMException('Cancelled', 'AbortError');
  for (const outcome of [abort, { ok: true, json: async () => { throw abort; } }]) {
    const { fetch, waits } = mockFetch(t, [outcome]);
    await assert.rejects(fetchJsonWithRetry(URL), error => error === abort);
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(waits, []);
    t.mock.restoreAll();
  }
});

test('request timeouts retry with the same bounded policy', async t => {
  const { waits } = mockFetch(t, [new DOMException('Timed out', 'TimeoutError'), Response.json(catalog)]);
  assert.deepEqual(await fetchJsonWithRetry(URL), catalog);
  assert.deepEqual(waits, [2000]);
});

test('a real socket closing after response headers retries the complete JSON GET', async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('Content-Type', 'application/json');
    if (requests === 1) {
      response.writeHead(200, { 'Content-Length': 1000 });
      response.write('{"data":');
      setTimeout(() => response.destroy(), 20);
    } else {
      response.end(JSON.stringify(catalog));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  assert.deepEqual(await fetchJsonWithRetry(`http://127.0.0.1:${server.address().port}/catalog`, 1, 0), catalog);
  assert.equal(requests, 2);
});
