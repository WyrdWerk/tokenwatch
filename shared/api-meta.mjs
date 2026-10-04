// Worker-safe API metadata shared by the Pages Function and static documentation generator.

export const API_ENDPOINTS = [
  {
    path: '/api/v1/',
    summary: 'API metadata and endpoint directory',
    params: [],
    sort: [],
  },
  {
    path: '/api/v1/use-cases',
    summary: 'List workload recommendation presets and their assumed mixes, weights, requirements, and quality floors',
    description: 'Returns the nine use-case presets used by /choose/ and the recommend endpoints. Every mix is flagged assumed: true; weights and floors are documented judgments, not measurements.',
    params: [],
    sort: [],
  },
  {
    path: '/api/v1/recommend',
    summary: 'Recommend models for a workload; chat and creative-writing also return an Arena preference favorite with source metadata',
    description: 'Open-weight model shortlist for one use case: picks.bestQuality, picks.bestValue (quality/price Pareto frontier) and picks.cheapestAboveFloor, each with a recommended provider, explanation, and confidence (stable, moderately_stable, close_call). Also returns alsoConsidered, partiallyBenchmarked, unbenchmarked, and unverified groups. Arena ratings in preference are from the LMArena leaderboard dataset (CC BY 4.0); display the attribution in preference.source.',
    params: ['use_case', 'priority', 'zdr', 'exclude_hq', 'include_proprietary', 'detail', 'limit', 'pretty'],
    requiredParams: ['use_case'],
    parameterLimits: { limit: 100 },
    sort: [],
  },
  {
    path: '/api/v1/recommend/providers',
    summary: 'Rank providers for one model with full explanations for the top three and compact remaining rows',
    description: 'Ranks eligible providers for one canonical model at the use case assumed mix on blended price, TTFT p50, throughput p50, and uptime, weighted by priority. Providers missing required capability or context metadata are returned in unverified, never ranked.',
    params: ['use_case', 'model', 'priority', 'zdr', 'exclude_hq', 'include_proprietary', 'detail', 'limit', 'pretty'],
    requiredParams: ['use_case', 'model'],
    parameterLimits: { limit: 100 },
    sort: [],
  },
  {
    path: '/api/v1/models',
    summary: 'List text-generation model offerings',
    params: ['org', 'provider', 'min_context', 'min_output', 'min_intelligence', 'quantization', 'open_weights', 'cache_read', 'cache_write', 'promo', 'zdr', 'sub', 'benchmarked', 'search', 'sort', 'order', 'limit', 'offset'],
    sort: ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'],
  },
  {
    path: '/api/v1/models/:canonicalId/providers',
    summary: 'List providers for one canonical model, ordered by cost',
    params: ['tokens', 'mix'],
    sort: [],
  },
  {
    path: '/api/v1/models/:canonicalId/history',
    summary: 'Daily cheapest-provider price history, blended at read time',
    params: ['days', 'mix'],
    sort: [],
  },
  {
    path: '/api/v1/stats',
    summary: 'Return catalog, provider, organization, privacy, cache, and quantization counts',
    params: [],
    sort: [],
  },
  {
    path: '/api/v1/orgs',
    summary: 'List model organizations with offering counts',
    params: [],
    sort: [],
  },
  {
    path: '/api/v1/providers',
    summary: 'List provider metadata and policy fields',
    params: ['zdr'],
    sort: [],
  },
  {
    path: '/api/v1/images',
    summary: 'List image-generation models',
    params: ['org', 'provider', 'search', 'sort', 'order', 'limit', 'offset'],
    sort: ['id', 'org', 'provider'],
  },
  {
    path: '/api/v1/images/:id',
    summary: 'Return one image model with its pricing variants',
    params: [],
    sort: [],
  },
  {
    path: '/api/v1/videos',
    summary: 'List video-generation models',
    params: ['org', 'provider', 'search', 'sort', 'order', 'limit', 'offset'],
    sort: ['id', 'org', 'provider'],
  },
  {
    path: '/api/v1/videos/:id',
    summary: 'Return one video model with its pricing variants',
    params: [],
    sort: [],
  },
];

export function endpointDirectory() {
  return API_ENDPOINTS
    .filter((endpoint) => endpoint.path !== '/api/v1/')
    .map((endpoint) => {
      const params = endpoint.params.length ? ` (params: ${endpoint.params.join(', ')})` : '';
      return `${endpoint.path} — ${endpoint.summary}${params}`;
    });
}
