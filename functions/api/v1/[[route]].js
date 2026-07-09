// Cloudflare Pages Functions — catch-all API route
// Serves pricing data with query filtering and sorting.
//
// Endpoints:
//   GET /api/v1/                              — API info + endpoint directory
//   GET /api/v1/stats                         — summary statistics (text models)
//   GET /api/v1/orgs                           — all orgs with model counts
//   GET /api/v1/providers[?zdr=true]          — provider metadata
//   GET /api/v1/models                         — list text models (with filters)
//   GET /api/v1/models/:canonicalId/providers  — all providers for a model, sorted by cost
//   GET /api/v1/images                         — list image models
//   GET /api/v1/images/:id                     — single image model with pricing variants
//   GET /api/v1/videos                         — list video models
//   GET /api/v1/videos/:id                     — single video model with pricing variants
//   OPTIONS *                                  — CORS preflight

import { canonicalId } from '../../../shared/normalize.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS,
  });
}

// ── Canonical ID normalization ────────────────────────────────────────────────
// canonicalId is imported from shared/normalize.mjs — the same source of truth
// the Node pipeline uses. This replaces the former local normalizeId, which had
// a greedy -preview-.*$ catch-all that over-stripped -preview-customtools and
// caused distinct models (e.g. gemini-3.1-pro vs gemini-3.1-pro-preview-customtools)
// to collide in /models/:id/providers.

// ── Pagination helper ─────────────────────────────────────────────────────────

function paginate(arr, params) {
  const limit = Math.min(parseInt(params.get('limit'), 10) || 100, 500);
  const offset = parseInt(params.get('offset'), 10) || 0;
  const total = arr.length;
  const paged = arr.slice(offset, offset + limit);
  return { total, offset, limit, paged };
}

// ── Main router ───────────────────────────────────────────────────────────────

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/v1/, '').replace(/^\//, '');
  const params = url.searchParams;

  // Load pricing.json from static assets
  let pricing;
  try {
    const res = await env.ASSETS.fetch(new URL('/pricing.json', request.url));
    if (!res.ok) throw new Error(`pricing.json not found: ${res.status}`);
    pricing = await res.json();
  } catch (err) {
    return json({ error: 'Failed to load pricing data', detail: err.message }, 503);
  }

  // ── Route: /api/v1/ (empty path) → API info ──
  if (!path || path === '') {
    return json({
      generated_at: pricing.generated_at,
      model_count: pricing.models.length,
      provider_count: [...new Set(pricing.models.map(m => m.provider))].length,
      source_count: pricing.providers.length,
      endpoints: [
        '/api/v1/models — list text models (with filters: org, provider, min_context, min_output, quantization, cache_read, cache_write, promo, zdr, sub, search, sort, order, limit, offset)',
        '/api/v1/models/:canonicalId/providers — all providers for a model, sorted by cost (optional tokens + mix params for mix-aware sorting)',
        '/api/v1/stats — summary statistics (model/provider/org counts, ZDR/subscription counts, quantization breakdown)',
        '/api/v1/orgs — all orgs with model counts',
        '/api/v1/providers — provider metadata (optional ?zdr=true filter)',
        '/api/v1/images — list image models (with filters: org, provider, search, sort, order, limit, offset)',
        '/api/v1/images/:id — single image model with pricing variants',
        '/api/v1/videos — list video models (with filters: org, provider, search, sort, order, limit, offset)',
        '/api/v1/videos/:id — single video model with pricing variants',
      ],
    });
  }

  // ── Route: /api/v1/stats ──
  if (path === 'stats') {
    const providers = {};
    const orgs = {};
    const quantizations = {};
    let zdrCount = 0, subCount = 0;
    let cacheReadCount = 0, cacheWriteCount = 0;
    for (const m of pricing.models) {
      providers[m.provider] = (providers[m.provider] || 0) + 1;
      orgs[m.org] = (orgs[m.org] || 0) + 1;
      if (m.zdr) zdrCount++;
      if (m.subscription) subCount++;
      if (m.pricing?.cache_read != null) cacheReadCount++;
      if (m.pricing?.cache_write != null) cacheWriteCount++;
      const q = m.quantization || 'unknown';
      quantizations[q] = (quantizations[q] || 0) + 1;
    }
    return json({
      generated_at: pricing.generated_at,
      model_count: pricing.models.length,
      provider_count: Object.keys(providers).length,
      org_count: Object.keys(orgs).length,
      zdr_count: zdrCount,
      subscription_count: subCount,
      cache_read_count: cacheReadCount,
      cache_write_count: cacheWriteCount,
      providers,
      orgs,
      quantizations,
      source_providers: pricing.providers,
    });
  }

  // ── Route: /api/v1/orgs ──
  if (path === 'orgs') {
    const orgs = {};
    for (const m of pricing.models) {
      orgs[m.org] = (orgs[m.org] || 0) + 1;
    }
    const sorted = Object.entries(orgs)
      .sort(([, a], [, b]) => b - a)
      .map(([org, count]) => ({ org, model_count: count }));
    return json({
      generated_at: pricing.generated_at,
      org_count: sorted.length,
      orgs: sorted,
    });
  }

  // ── Route: /api/v1/providers[?zdr=true] ──
  if (path === 'providers') {
    let meta = pricing.providers_meta || {};
    const zdrOnly = params.get('zdr') === 'true';
    if (zdrOnly) {
      const filtered = {};
      for (const [key, val] of Object.entries(meta)) {
        if (val.retains_prompts === false) filtered[key] = val;
      }
      meta = filtered;
    }
    return json({
      generated_at: pricing.generated_at,
      provider_count: Object.keys(meta).length,
      providers_meta: meta,
    });
  }

  // ── Route: /api/v1/models[/:canonicalId/providers] ──
  if (path === 'models' || path.startsWith('models/')) {
    const subPath = path.replace(/^models\//, '');

    // /api/v1/models/:canonicalId/providers
    if (subPath.includes('/providers')) {
      const requestedId = decodeURIComponent(subPath.replace(/\/providers$/, ''));
      const target = canonicalId(requestedId);
      const matches = pricing.models.filter(m => canonicalId(m.id) === target);

      if (matches.length === 0) {
        return json({ error: 'Model not found', canonical_id: requestedId }, 404);
      }

      // Sort by cost — use mix-aware cost if params provided, else input+output
      const reqTokens = parseFloat(params.get('tokens'));
      const reqMix = params.get('mix'); // 'inputPct,cachePct,outputPct'
      let sorted;
      if (reqTokens > 0 && reqMix) {
        const parts = reqMix.split(',').map(parseFloat);
        const inputPct = parts[0] || 0, cachePct = parts[1] || 0, outputPct = parts[2] || 0;
        const total = reqTokens * 1e6;
        const costFn = (m) => {
          const p = m.pricing;
          let c = 0, valid = true;
          const iT = total * inputPct / 100;
          const cT = total * cachePct / 100;
          const oT = total * outputPct / 100;
          if (iT > 0) { if (p.input == null) valid = false; else c += (p.input * iT) / 1e6; }
          if (cT > 0) { if (p.cache_read == null) valid = false; else c += (p.cache_read * cT) / 1e6; }
          if (oT > 0) { if (p.output == null) valid = false; else c += (p.output * oT) / 1e6; }
          return valid ? c : Infinity;
        };
        sorted = matches.sort((a, b) => costFn(a) - costFn(b));
      } else {
        sorted = matches.sort((a, b) => {
          const costA = (a.pricing.input || 0) + (a.pricing.output || 0);
          const costB = (b.pricing.input || 0) + (b.pricing.output || 0);
          return costA - costB;
        });
      }

      return json({
        canonical_id: target,
        model_count: sorted.length,
        providers: sorted.map(m => ({
          provider: m.provider,
          provider_display: m.provider_display,
          quantization: m.quantization,
          discount: m.discount,
          zdr: m.zdr || false,
          subscription: m.subscription || false,
          context_length: m.context_length,
          max_completion_tokens: m.max_completion_tokens,
          uptime_30m: m.uptime_30m,
          pricing: m.pricing,
        })),
      });
    }

    // /api/v1/models — list with filters
    let models = pricing.models;

    // Filters
    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    const minContext = parseInt(params.get('min_context'), 10);
    if (minContext) models = models.filter(m => m.context_length && m.context_length >= minContext);

    const minOutput = parseInt(params.get('min_output'), 10);
    if (minOutput) models = models.filter(m => m.max_completion_tokens && m.max_completion_tokens >= minOutput);

    const quantization = params.get('quantization');
    if (quantization) models = models.filter(m => (m.quantization || 'unknown') === quantization.toLowerCase());

    if (params.get('cache_read') === 'true') models = models.filter(m => m.pricing?.cache_read != null);
    if (params.get('cache_write') === 'true') models = models.filter(m => m.pricing?.cache_write != null);

    const promo = params.get('promo');
    if (promo === 'true') models = models.filter(m => m.discount > 0);
    const zdr = params.get('zdr');
    if (zdr === 'true') models = models.filter(m => m.zdr === true);
    const sub = params.get('sub');
    if (sub === 'true') models = models.filter(m => m.subscription === true);
    const benchmarked = params.get('benchmarked');
    if (benchmarked === 'true') models = models.filter(m => !!m.benchmarks);

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const sort = params.get('sort') || 'id';
    const validSorts = ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'];
    const sortKey = validSorts.includes(sort) ? sort : 'id';
    const order = params.get('order') === 'desc' ? -1 : 1;
    models = [...models].sort((a, b) => {
      let va, vb;
      if (sortKey === 'id') { va = a.id.toLowerCase(); vb = b.id.toLowerCase(); }
      else if (sortKey === 'context') { va = a.context_length; vb = b.context_length; }
      else if (sortKey === 'max_output') { va = a.max_completion_tokens; vb = b.max_completion_tokens; }
      else if (sortKey === 'uptime') { va = a.uptime_30m; vb = b.uptime_30m; }
      else if (sortKey === 'intelligence') { va = a.benchmarks?.intelligence_index; vb = b.benchmarks?.intelligence_index; }
      else if (sortKey === 'coding') { va = a.benchmarks?.coding_index; vb = b.benchmarks?.coding_index; }
      else if (sortKey === 'agentic') { va = a.benchmarks?.agentic_index; vb = b.benchmarks?.agentic_index; }
      else { va = a.pricing[sortKey]; vb = b.pricing[sortKey]; }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    // Pagination
    const { total, offset, limit, paged } = paginate(models, params);

    return json({
      generated_at: pricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // ── Route: /api/v1/images[/:id] ──
  if (path === 'images' || path.startsWith('images/')) {
    let imagePricing;
    try {
      const res = await env.ASSETS.fetch(new URL('/image-pricing.json', request.url));
      if (!res.ok) throw new Error(`image-pricing.json not found: ${res.status}`);
      imagePricing = await res.json();
    } catch (err) {
      return json({ error: 'Failed to load image pricing data', detail: err.message }, 503);
    }

    const subPath = path.replace(/^images\//, '');

    // /api/v1/images/:id — single model (accepts org/model or bare canonical id)
    if (path.startsWith('images/') && subPath) {
      const target = canonicalId(decodeURIComponent(subPath));
      const model = imagePricing.models.find(m => canonicalId(m.id) === target);
      if (!model) {
        return json({ error: 'Image model not found', id: subPath }, 404);
      }
      return json({
        generated_at: imagePricing.generated_at,
        model,
      });
    }

    // /api/v1/images — list with filters
    let models = imagePricing.models;

    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const sort = params.get('sort') || 'id';
    const validSorts = ['id', 'org', 'provider'];
    const sortKey = validSorts.includes(sort) ? sort : 'id';
    const order = params.get('order') === 'desc' ? -1 : 1;
    models = [...models].sort((a, b) => {
      const va = (a[sortKey] || '').toLowerCase();
      const vb = (b[sortKey] || '').toLowerCase();
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    const { total, offset, limit, paged } = paginate(models, params);

    return json({
      generated_at: imagePricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // ── Route: /api/v1/videos[/:id] ──
  if (path === 'videos' || path.startsWith('videos/')) {
    let videoPricing;
    try {
      const res = await env.ASSETS.fetch(new URL('/video-pricing.json', request.url));
      if (!res.ok) throw new Error(`video-pricing.json not found: ${res.status}`);
      videoPricing = await res.json();
    } catch (err) {
      return json({ error: 'Failed to load video pricing data', detail: err.message }, 503);
    }

    const subPath = path.replace(/^videos\//, '');

    // /api/v1/videos/:id — single model (accepts org/model or bare canonical id)
    if (path.startsWith('videos/') && subPath) {
      const target = canonicalId(decodeURIComponent(subPath));
      const model = videoPricing.models.find(m => canonicalId(m.id) === target);
      if (!model) {
        return json({ error: 'Video model not found', id: subPath }, 404);
      }
      return json({
        generated_at: videoPricing.generated_at,
        model,
      });
    }

    // /api/v1/videos — list with filters
    let models = videoPricing.models;

    const org = params.get('org');
    if (org) models = models.filter(m => m.org === org.toLowerCase());

    const provider = params.get('provider');
    if (provider) models = models.filter(m => m.provider === provider.toLowerCase());

    const search = params.get('search');
    if (search) {
      const q = search.toLowerCase();
      models = models.filter(m =>
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        m.org.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q)
      );
    }

    // Sorting
    const sort = params.get('sort') || 'id';
    const validSorts = ['id', 'org', 'provider'];
    const sortKey = validSorts.includes(sort) ? sort : 'id';
    const order = params.get('order') === 'desc' ? -1 : 1;
    models = [...models].sort((a, b) => {
      const va = (a[sortKey] || '').toLowerCase();
      const vb = (b[sortKey] || '').toLowerCase();
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    const { total, offset, limit, paged } = paginate(models, params);

    return json({
      generated_at: videoPricing.generated_at,
      total,
      offset,
      limit,
      models: paged,
    });
  }

  // Unknown route
  return json({ error: 'Not found', path }, 404);
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}
