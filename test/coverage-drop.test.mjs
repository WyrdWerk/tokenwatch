import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

// Import the class to verify it's exported and instanceof works
const { CoverageDropError, checkCoverageDrop } = await import(join(REPO, 'scripts', 'lib.mjs'));

/**
 * Verify CoverageDropError is a proper Error subclass with structured fields.
 * This is the type-safety contract: catch handlers use instanceof, not string matching.
 */
test('CoverageDropError is an Error subclass with structured fields', () => {
  const err = new CoverageDropError('test message', { currentCount: 47, prevCount: 93, threshold: 0.15 });
  assert.ok(err instanceof Error, 'CoverageDropError must extend Error');
  assert.ok(err instanceof CoverageDropError, 'instanceof must work on the class itself');
  assert.equal(err.name, 'CoverageDropError');
  assert.equal(err.currentCount, 47);
  assert.equal(err.prevCount, 93);
  assert.equal(err.threshold, 0.15);
  assert.match(err.message, /test message/);
});

/**
 * Verify checkCoverageDrop actually throws CoverageDropError (not generic Error)
 * when the drop exceeds threshold. This is the critical contract: the catch
 * handlers in fetch-images.mjs / fetch-videos.mjs use `instanceof CoverageDropError`.
 */
test('checkCoverageDrop throws CoverageDropError when drop exceeds threshold', async () => {
  const tmpFile = join(__dirname, 'fixtures', 'test-coverage-drop.json');
  await mkdir(join(__dirname, 'fixtures'), { recursive: true });
  await writeFile(tmpFile, JSON.stringify({ models: new Array(100).fill({}) }));

  try {
    await assert.rejects(
      () => checkCoverageDrop(tmpFile, 50, 0.15), // 50% drop
      (err) => {
        assert.ok(err instanceof CoverageDropError, 'must be CoverageDropError, got: ' + err.constructor.name);
        assert.equal(err.currentCount, 50);
        assert.equal(err.prevCount, 100);
        assert.match(err.message, /Coverage drop: 50 models vs previous 100/);
        return true;
      }
    );
  } finally {
    await import('node:fs/promises').then(m => m.unlink(tmpFile).catch(() => {}));
  }
});

/**
 * Verify checkCoverageDrop does NOT throw when within threshold.
 */
test('checkCoverageDrop passes when drop is within threshold', async () => {
  const tmpFile = join(__dirname, 'fixtures', 'test-coverage-ok.json');
  await mkdir(join(__dirname, 'fixtures'), { recursive: true });
  await writeFile(tmpFile, JSON.stringify({ models: new Array(100).fill({}) }));

  try {
    const prevCount = await checkCoverageDrop(tmpFile, 90, 0.15); // 10% drop, under 15%
    assert.equal(prevCount, 100);
  } finally {
    await import('node:fs/promises').then(m => m.unlink(tmpFile).catch(() => {}));
  }
});

/**
 * Verify that CoverageDropError crosses the ESM module boundary correctly:
 * a subprocess importing CoverageDropError from lib.mjs can catch it via
 * `instanceof` — the exact pattern used by fetch-images.mjs and fetch-videos.mjs.
 * This is a subprocess simulation, not a full fetcher integration test;
 * file-preservation behavior is guaranteed by checkCoverageDrop throwing
 * before writeFile is reached, not asserted here.
 */
test('instanceof CoverageDropError works across ESM module boundary in subprocess', { timeout: 30000 }, async () => {
  // Write a catch handler script at repo root so relative imports resolve correctly.
  // Mirrors the exact catch pattern in fetch-videos.mjs.
  const catchScript = `
    import { CoverageDropError } from '${REPO}/scripts/lib.mjs';
    try {
      throw new CoverageDropError('test', { currentCount: 13, prevCount: 93, threshold: 0.15 });
    } catch (err) {
      if (err instanceof CoverageDropError) {
        console.log('caught CoverageDropError: ' + err.message);
        console.log('exiting 0');
        process.exit(0);
      }
      console.log('Fatal: ' + err);
      process.exit(1);
    }
  `;
  const catchFile = join(REPO, 'test-coverage-drop-catch.mjs');
  await writeFile(catchFile, catchScript);

  try {
    const stdout = execFileSync('node', [catchFile], {
      cwd: REPO,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.match(stdout, /caught CoverageDropError/);
    assert.match(stdout, /exiting 0/);
  } catch (err) {
    if (err.status === 1) {
      assert.fail('instanceof CoverageDropError check failed in subprocess — catch handler did not recognize the error. stderr: ' + (err.stderr || ''));
    }
    throw err;
  } finally {
    await import('node:fs/promises').then(m => m.unlink(catchFile).catch(() => {}));
  }
});

/**
 * Verify that text pricing (fetch-pricing.mjs) does NOT catch CoverageDropError
 * — it must remain fatal. Read the source and assert the catch handler is
 * a plain fatal handler without CoverageDropError handling.
 */
test('fetch-pricing.mjs keeps coverage drops fatal (no CoverageDropError catch)', async () => {
  const src = await readFile(join(REPO, 'scripts', 'fetch-pricing.mjs'), 'utf-8');
  const catchBlock = src.slice(src.indexOf('main().catch'));
  assert.doesNotMatch(catchBlock, /CoverageDropError/, 'fetch-pricing.mjs must NOT catch CoverageDropError — text pricing coverage drops must be fatal');
  assert.match(catchBlock, /process\.exit\(1\)/, 'fetch-pricing.mjs must exit 1 on any error');
});
