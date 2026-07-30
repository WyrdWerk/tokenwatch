#!/usr/bin/env node
/**
 * bust-cache.mjs — rewrite asset refs in public/*.html to content-hashed paths.
 *
 * Why path-based (not ?v= query strings)?
 *   Cloudflare's edge cache for the custom domain (tokenwatch.wyrdwerk.com) has
 *   been observed to ignore query strings in the cache key for JS/CSS. Content-
 *   hashed PATHS (h/app.<hash>.js) always miss the stale entry.
 *
 * Repo HTML keeps stable refs like src="app.js?v=dev" (or plain app.js). This
 * script rewrites them for deploy only — hashed files under public/h/ are
 * generated, not committed. CI: run before wrangler pages deploy.
 *
 * DEPLOY GOTCHA (learned 2026-07-30): wrangler pages deploy respects
 * .gitignore. If public/h/ is gitignored, the generated hashed files are NOT
 * uploaded — Cloudflare's SPA fallback serves index.html (text/html) for JS
 * requests, and the _headers immutable rule caches that broken response for
 * 1 year. FIX: public/h/ must NOT be in .gitignore. The files are generated
 * locally/CI before deploy and must be present in the upload set.
 *
 * Idempotent: safe to run twice. Existing h/<name>.<hash>.<ext> refs are
 * normalized back to <name>.<ext> before re-hashing.
 *
 * Zero dependencies. Node >=18.
 */

import { readFile, writeFile, readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const HASH_DIR = join(PUBLIC_DIR, 'h');

const FINGERPRINT = new Set([
  'styles.css',
  'app.js',
  'image-app.js',
  'video-app.js',
  'shared-ui.js',
]);

// href/src="..." capturing the path (with optional ?query)
const REF_REGEX = /((?:href|src)=["'])([^"']+)(["'])/g;

// h/app.476dfb74.js → app.js
const HASHED_PATH_RE = /^h\/(.+)\.([a-f0-9]{8})(\.[a-z0-9]+)$/i;

async function hashFile(filePath) {
  const content = await readFile(filePath);
  return createHash('sha1').update(content).digest('hex').slice(0, 8);
}

function fingerprintedName(assetBase, hash) {
  const ext = extname(assetBase);
  const stem = basename(assetBase, ext);
  return `${stem}.${hash}${ext}`;
}

/** Map any ref path to a bare fingerprintable basename, or null. */
function baseAssetName(refPath) {
  // strip query
  const pathOnly = refPath.split('?')[0];
  const base = basename(pathOnly);

  // Already path-hashed: h/app.476dfb74.js
  const m = pathOnly.replace(/^\.\//, '').match(HASHED_PATH_RE);
  if (m) {
    const name = m[1] + m[3]; // app + .js
    return FINGERPRINT.has(name) ? name : null;
  }

  // Bare or ?v= form: app.js or app.js?v=dev
  if (FINGERPRINT.has(base)) return base;
  return null;
}

async function bustHtml(htmlPath, assetHashes) {
  let html = await readFile(htmlPath, 'utf-8');
  let count = 0;

  html = html.replace(REF_REGEX, (full, prefix, refPath, quote) => {
    const base = baseAssetName(refPath);
    if (!base) return full;
    const hash = assetHashes.get(base);
    if (!hash) return full;
    count++;
    return `${prefix}h/${fingerprintedName(base, hash)}${quote}`;
  });

  if (count > 0) await writeFile(htmlPath, html, 'utf-8');
  return count;
}

async function main() {
  await rm(HASH_DIR, { recursive: true, force: true });
  await mkdir(HASH_DIR, { recursive: true });

  const assetHashes = new Map();
  for (const name of FINGERPRINT) {
    const abs = join(PUBLIC_DIR, name);
    try {
      const hash = await hashFile(abs);
      assetHashes.set(name, hash);
      const outName = fingerprintedName(name, hash);
      await copyFile(abs, join(HASH_DIR, outName));
      console.log(`  hash ${name} → h/${outName}`);
    } catch (err) {
      console.warn(`  skip ${name}: ${err.message}`);
    }
  }

  const htmlFiles = (await readdir(PUBLIC_DIR))
    .filter((f) => f.endsWith('.html'))
    .map((f) => join(PUBLIC_DIR, f));

  try {
    const widgetDemo = join(PUBLIC_DIR, 'widget', 'demo.html');
    await readFile(widgetDemo);
    htmlFiles.push(widgetDemo);
  } catch { /* optional */ }

  let totalBusted = 0;
  for (const htmlFile of htmlFiles) {
    const count = await bustHtml(htmlFile, assetHashes);
    const rel = htmlFile.slice(PUBLIC_DIR.length + 1);
    if (count > 0) {
      console.log(`✓ ${rel}: ${count} ref(s) → path-hashed /h/*`);
      totalBusted += count;
    } else {
      console.log(`· ${rel}: no fingerprintable refs`);
    }
  }
  console.log(`\n→ ${totalBusted} path-hashed ref(s) across ${htmlFiles.length} HTML file(s)`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
