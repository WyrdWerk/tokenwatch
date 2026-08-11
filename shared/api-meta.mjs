// Worker-safe API metadata shared by the Pages Function and static documentation generator.

export const API_ENDPOINTS = [
  {
    path: '/api/v1/',
    summary: 'API metadata and endpoint directory',
    params: [],
    sort: [],
  },
  {
    path: '/api/v1/models',
    summary: 'List text-generation model offerings',
    params: ['org', 'provider', 'min_context', 'min_output', 'min_intelligence', 'quantization', 'cache_read', 'cache_write', 'promo', 'zdr', 'sub', 'benchmarked', 'search', 'sort', 'order', 'limit', 'offset'],
    sort: ['id', 'input', 'output', 'cache_read', 'cache_write', 'context', 'max_output', 'uptime', 'discount', 'intelligence', 'coding', 'agentic'],
  },
  {
    path: '/api/v1/models/:canonicalId/providers',
    summary: 'List providers for one canonical model, ordered by cost',
    params: ['tokens', 'mix'],
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
