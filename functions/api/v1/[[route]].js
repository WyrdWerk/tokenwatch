// Cloudflare Pages Functions — catch-all API route
// Serves pricing data with query filtering and sorting.

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

  // Route: /api/v1/ (empty path) → stats
  if (!path || path === '') {
    return json({
      generated_at: pricing.generated_at,
      model_count: pricing.models.length,
      provider_count: [...new Set(pricing.models.map(m => m.provider))].length,
      source_count: pricing.providers.length,
      endpoints: [
        '/api/v1/models — list all models (with filters)',
        '/api/v1/models/:canonicalId/providers — all providers for a model',
        '/api/v1/stats — summary statistics',
        '/api/v1/providers — provider metadata',
      ],
    });
  }

  // Route: /api/v1/stats
  if (path === 'stats') {
    const providers = {};
    for (const m of pricing.models) {
      providers[m.provider] = (providers[m.provider] || 0) + 1;
    }
    return json({
      generated_at: pricing.generated_at,
      model_count: pricing.models.length,
      provider_count: Object.keys(providers).length,
      providers,
      source_providers: pricing.providers,
    });
  }

  // Route: /api/v1/providers
  if (path === 'providers') {
    return json({
      generated_at: pricing.generated_at,
      providers_meta: pricing.providers_meta || {},
    });
  }

  // Route: /api/v1/models[/:canonicalId/providers]
  if (path === 'models' || path.startsWith('models/')) {
    const subPath = path.replace(/^models\//, '');

    // /api/v1/models/:canonicalId/providers
    if (subPath.includes('/providers')) {
      const canonicalId = decodeURIComponent(subPath.replace(/\/providers$/, ''));
      // Match by canonical ID (strip org prefix, lowercase, remove suffixes)
      const normalize = (id) => {
        let k = id.includes('/') ? id.split('/').slice(-1)[0] : id;
        k = k.replace(/:free$/, '')
             .replace(/:thinking$/, '')
             .replace(/-(\d{4})-(\d{2})-(\d{2})$/, '')
             .replace(/-preview-.*$/, '')
             .replace(/-preview$/, '')
             .replace(/-(\d{8})$/, '')
             .replace(/-(\d{6})$/, '')
             .toLowerCase().trim();
        return k;
      };
      const target = normalize(canonicalId);
      const matches = pricing.models.filter(m => normalize(m.id) === target);

      if (matches.length === 0) {
        return json({ error: 'Model not found', canonical_id: canonicalId }, 404);
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

    const promo = params.get('promo');
    if (promo === 'true') models = models.filter(m => m.discount > 0);
    const zdr = params.get('zdr');
    if (zdr === 'true') models = models.filter(m => m.zdr === true);

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
    const validSorts = ['id', 'input', 'output', 'cache_read', 'context', 'discount'];
    const sortKey = validSorts.includes(sort) ? sort : 'id';
    const order = params.get('order') === 'desc' ? -1 : 1;
    models = [...models].sort((a, b) => {
      let va, vb;
      if (sortKey === 'id') { va = a.id.toLowerCase(); vb = b.id.toLowerCase(); }
      else if (sortKey === 'context') { va = a.context_length; vb = b.context_length; }
      else { va = a.pricing[sortKey]; vb = b.pricing[sortKey]; }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (va < vb) return -1 * order;
      if (va > vb) return 1 * order;
      return 0;
    });

    // Pagination
    const limit = Math.min(parseInt(params.get('limit'), 10) || 100, 500);
    const offset = parseInt(params.get('offset'), 10) || 0;
    const total = models.length;
    const paged = models.slice(offset, offset + limit);

    return json({
      generated_at: pricing.generated_at,
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
