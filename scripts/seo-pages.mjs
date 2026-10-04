import { blendedRate, AGENTIC_MIX } from '../shared/cost.mjs';
import { canonicalId } from '../shared/normalize.mjs';
import { API_ENDPOINTS } from '../shared/api-meta.mjs';
import { PRIORITY_PROVIDER_WEIGHTS, USE_CASES } from '../shared/use-cases.mjs';
import { MIN_BENCHMARK_COVERAGE } from '../shared/recommend.mjs';
import { modelDisplayName } from '../shared/choose-page.mjs';

export const SITE = 'https://tokenwatch.wyrdwerk.com';
export const TOP_N = 25;
export const PROVIDER_MIN_MODELS = 3;

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escXml(value) {
  return esc(value).replace(/'/g, '&apos;');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Search-snippet title budget: Google shows roughly 60–65 characters. */
export const SNIPPET_TITLE_MAX = 65;

/** "Oct 2026" from a catalog generated_at timestamp or YYYY-MM-DD date (UTC); null when unparseable. */
export function catalogMonth(value) {
  const match = /^(\d{4})-(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : null;
}

/** Compact USD price for titles and snippets: $0.05, $1.50, $0.0044. */
export function snippetPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 0.01) return `$${Number(value.toPrecision(2))}`;
  return `$${value.toFixed(2)}`;
}

/** First candidate that fits the snippet title budget; the last candidate is the fallback. */
export function fitTitle(candidates, max = SNIPPET_TITLE_MAX) {
  const list = candidates.filter(Boolean);
  return list.find((title) => title.length <= max) || list[list.length - 1];
}

function plural(count, word) {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

/** Catalog model name without an "Org: " prefix (`Z.ai: GLM 5.3` → `GLM 5.3`). */
function shortModelName(model) {
  const name = String(model?.name || model?.id || '');
  return /^[^/:]+: \S/.test(name) ? name.slice(name.indexOf(': ') + 2).trim() : name;
}

export function fmtPrice(value) {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return '$' + value.toFixed(4);
  if (value < 1) return '$' + value.toFixed(3);
  return '$' + value.toFixed(2);
}

function isPositive(value) {
  return Number.isFinite(value) && value > 0;
}

function displayName(model) {
  return model.name || model.id;
}

export function cheapestModels(models, topN = TOP_N) {
  return models
    .filter((model) => model.pricing && (model.pricing.input > 0 || model.pricing.output > 0))
    .map((model) => ({ m: model, eff: blendedRate(model.pricing, AGENTIC_MIX) }))
    .filter((row) => row.eff != null && row.eff > 0)
    .sort((a, b) => a.eff - b.eff)
    .slice(0, topN);
}

function renderTextRows(priced, { linkedModelPages = new Map(), linkedProviderSlugs = new Set() } = {}) {
  return priced.map(({ m, eff }) => {
    const pricing = m.pricing || {};
    const modelSlug = linkedModelPages.get(canonicalId(m.id));
    const model = modelSlug ? `<a href="/models/${esc(modelSlug)}/">${esc(displayName(m))}</a>` : esc(displayName(m));
    const slug = providerSlug(m.provider);
    const provider = linkedProviderSlugs.has(slug) ? `<a href="/providers/${esc(slug)}/">${esc(m.provider)}</a>` : esc(m.provider);
    return `      <tr><td>${esc(m.org || m.provider)}</td><td>${provider}</td><td>${model}</td><td class="num">${fmtPrice(pricing.input)}</td><td class="num">${fmtPrice(pricing.output)}</td><td class="num">${fmtPrice(pricing.cache_read)}</td><td class="num">${fmtPrice(eff)}</td></tr>`;
  }).join('\n');
}

export function renderSeoTable(priced, lastmod, options = {}) {
  const id = options.id || 'cheapest';
  const title = options.title || 'Cheapest LLM API models right now';
  const intro = options.intro || 'Ranked by effective cost at a typical agentic mix (2.5% input, 97% cached input, 0.5% output). Prices are USD per million tokens. Use the calculator above to estimate your workload cost.';
  return `    <section class="seo-models" id="${esc(id)}" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>
      <p>${esc(intro)}</p>
      <div class="table-wrap"><table>
        <caption>${esc(title)}</caption>
        <thead><tr><th scope="col">Org</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col" class="num">Input $/M</th><th scope="col" class="num">Output $/M</th><th scope="col" class="num">Cache $/M</th><th scope="col" class="num">Blended $/M</th></tr></thead>
        <tbody>${renderTextRows(priced, options)}</tbody>
      </table></div>
      <p class="seo-note">Catalog snapshot ${esc(lastmod)} from direct-provider APIs, OpenRouter endpoint data, and maintained fallbacks. See the <a href="/docs/methodology/">sources and calculation rules</a>; verify rates on the provider's official pricing page before committing spend.</p>
    </section>`;
}

export function cheapestImageModels(models, unit, topN = 15) {
  return models
    .flatMap((model) => {
      const candidates = (model.pricing || [])
        .filter((pricing) => pricing.unit === unit)
        .map((pricing) => ({
          pricing,
          rate: unit === 'token' ? pricing.cost_per_million : pricing.cost_per_unit,
        }))
        .filter((row) => isPositive(row.rate))
        .sort((a, b) => a.rate - b.rate);
      return candidates.length ? [{ m: model, p: candidates[0].pricing, rate: candidates[0].rate }] : [];
    })
    .sort((a, b) => a.rate - b.rate)
    .slice(0, topN);
}

function imageUnitLabel(unit) {
  if (unit === 'image') return { heading: 'Lowest listed flat per-image prices', rate: 'Price per image' };
  if (unit === 'megapixel') return { heading: 'Lowest listed per-megapixel prices', rate: 'Price per megapixel' };
  return { heading: 'Lowest listed image-token prices', rate: 'Price per million image tokens' };
}

function renderImageTable(rows, unit, id) {
  const label = imageUnitLabel(unit);
  const body = rows.map(({ m, p, rate }) => `        <tr><td>${esc(m.provider)}</td><td>${esc(displayName(m))}</td><td>${esc(p.variant || 'Standard')}</td><td>${esc(unit)}</td><td class="num">${fmtPrice(rate)}</td></tr>`).join('\n');
  return `      <div class="seo-price-group" id="${esc(id)}">
        <h3>${esc(label.heading)}</h3>
        <div class="table-wrap"><table>
          <caption>${esc(label.heading)}</caption>
          <thead><tr><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Variant</th><th scope="col">Unit</th><th scope="col" class="num">${esc(label.rate)}</th></tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>`;
}

export function renderImageSeoSection(groups, lastmod) {
  const sections = [
    ['image', 'cheapest-image-flat'],
    ['megapixel', 'cheapest-image-megapixel'],
    ['token', 'cheapest-image-token'],
  ].filter(([unit]) => groups[unit]?.length)
    .map(([unit, id]) => renderImageTable(groups[unit], unit, id))
    .join('\n');
  return `    <section class="seo-models" id="image-pricing-guide" aria-label="Cheapest image generation API models">
      <h2>Cheapest image generation API prices</h2>
      <p>Image APIs use three incompatible billing units. The tables keep flat per-image, per-megapixel, and image-token prices separate so unlike rates are never ranked against each other.</p>
${sections}
      <p class="seo-note">Pricing refreshed ${esc(lastmod)}. A listed rate may cover only one size, quality, or endpoint variant; confirm the selected variant before buying.</p>
    </section>`;
}

export function cheapestVideoModels(models, topN = TOP_N) {
  return models
    .flatMap((model) => {
      const candidates = (model.pricing || [])
        .filter((pricing) => isPositive(pricing.cost_per_second))
        .sort((a, b) => a.cost_per_second - b.cost_per_second);
      return candidates.length ? [{ m: model, p: candidates[0], rate: candidates[0].cost_per_second }] : [];
    })
    .sort((a, b) => a.rate - b.rate)
    .slice(0, topN);
}

export function renderVideoSeoSection(rows, lastmod) {
  const body = rows.map(({ m, p, rate }) => `      <tr><td>${esc(m.provider)}</td><td>${esc(displayName(m))}</td><td>${esc(p.resolution || 'Unspecified')}</td><td>${p.audio === true ? 'Included' : p.audio === false ? 'No audio' : 'Unspecified'}</td><td class="num">${fmtPrice(rate)}</td><td class="num">${fmtPrice(rate * 30)}</td></tr>`).join('\n');
  return `    <section class="seo-models" id="video-pricing-guide" aria-label="Cheapest video generation API models">
      <h2>Cheapest video generation API prices</h2>
      <p>Each model appears once at its lowest listed positive per-second rate. Resolution and audio describe that selected variant; another variant of the same model can cost more.</p>
      <div class="table-wrap"><table>
        <caption>Lowest listed video generation prices per second</caption>
        <thead><tr><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Resolution</th><th scope="col">Audio</th><th scope="col" class="num">Price per second</th><th scope="col" class="num">Example 30-second cost</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
      <p class="seo-note">Pricing refreshed ${esc(lastmod)}. Duration limits, aspect ratios, and feature availability vary by endpoint.</p>
    </section>`;
}

export function homeFaqItems(modelCount, providerCount) {
  return [
    ['What can I do with a $10 LLM API budget?', 'Switch the calculator to Budget → Tokens, enter $10, and choose a workload mix. TokenWatch shows how many tokens each priced offering can serve. A cheap rate does not guarantee the model has the quality, context window, or capabilities your task needs.'],
    ['How do I estimate the cost of a specific model and provider combination?', 'Search for the provider and model, enter your token volume, then set the input, cached-input, and output percentages. The result uses that provider offering’s current rates rather than a model-wide average.'],
    ['Which provider is cheapest for a particular model?', 'Search for the model and compare every matching provider row. The cheapest provider can change with your token mix because input, output, cache-read, and cache-write rates differ.'],
    ['Why does the same model appear more than once?', 'The same underlying model can be hosted by several inference providers. Quantization, batch, fast, preview, and endpoint variants can also remain separate when they have different identities or prices.'],
    ['How do I estimate an AI agent’s monthly cost?', 'Choose Monthly Volume, enter daily token usage, and select a workload preset or your own mix. TokenWatch multiplies the daily result by 30; retries, tool calls, and context growth still need to be represented in the volume you enter.'],
    ['What is Blended $/M?', 'Blended $/M combines fresh-input, cached-input, and output prices using the selected workload percentages and the same cache-write assumption as total cost. It is a rate per million tokens, so it excludes token volume and the monthly multiplier.'],
    ['How does prompt caching reduce LLM API cost?', 'A provider can charge a lower cache-read rate when repeated prompt content is reused. TokenWatch applies that rate only to the cached-input share you enter.'],
    ['What happens when a provider has no cache-read price?', 'A missing cache-read price is not free usage. TokenWatch falls back to the provider’s normal input rate for the cached-input share unless the source publishes a separate cache price.'],
    ['How does TokenWatch estimate cache writes?', 'When a provider explicitly bills fresh input at the cache-write tariff by default, TokenWatch uses that rate even when it is lower than normal input pricing. Otherwise it assumes fresh input is written to cache when a finite positive cache-write rate is higher than input; if not, normal input applies. A missing explicit default tariff makes fresh-input workloads unpriceable. Cached reads use the published cache-read rate or original input price. There is no separate write charge, and additional cache-storage charges are excluded; this is a simplified estimate, not an exact bill.'],
    ['What is Zero Data Retention?', 'ZDR means the provider says request content is not retained beyond processing. It is a data-retention property, not a general security or compliance certification; review the linked provider policy before sending sensitive data.'],
    ['Can I compare, share, or export results?', 'You can compare up to six offerings, copy a comparison card as an image, export the current result set as CSV, or share the URL hash that stores the calculator state.'],
    ['How fresh and accurate is TokenWatch pricing?', `The current catalog contains ${modelCount} text offerings across ${providerCount} providers and records a generation timestamp. Direct-provider data takes precedence over OpenRouter, then maintained fallback sources. Promotions and provider pages can change between refreshes, so verify prices before a purchasing decision.`],
  ];
}

export function imageFaqItems() {
  return [
    ['How many images can I generate for $10?', 'Choose Budget → Count, enter $10, and filter to a model or provider. Flat per-image offerings return a direct count; megapixel and image-token offerings need workload details before a final image count is meaningful.'],
    ['What is the difference between per-image, per-megapixel, and image-token pricing?', 'Per-image pricing charges a flat amount for one generated image. Per-megapixel pricing scales with output area. Image-token pricing depends on the provider’s image-token calculation. The three units are not interchangeable.'],
    ['Why can’t every image model be compared using one price?', 'A flat image rate, a megapixel rate, and an image-token rate measure different work. TokenWatch separates them rather than inventing assumptions about resolution or token use.'],
    ['Why does the same image model have multiple variants?', 'Providers may price sizes, quality tiers, aspect ratios, edit modes, or endpoint versions separately. The calculator keeps those variants visible so a cheaper option is not mistaken for an equivalent configuration.'],
    ['Can I compare image-generation providers?', 'Yes. Search or filter by model and provider, then compare rows that use the same billing unit and a comparable output configuration.'],
    ['How does resolution affect image cost?', 'Resolution can raise cost directly under per-megapixel pricing and can select a more expensive variant under flat pricing. Use the variant filter and confirm the provider’s size limits.'],
  ];
}

export function videoFaqItems() {
  return [
    ['How much does a 30-second AI-generated video cost?', 'Multiply the selected per-second rate by 30. The crawlable table shows that example for each model’s cheapest listed variant, while the calculator lets you change duration and filters.'],
    ['How many seconds of video can I generate for $10?', 'Choose Budget → Seconds and enter $10. TokenWatch divides the budget by each selected variant’s per-second price.'],
    ['How does resolution affect video pricing?', 'Higher-resolution variants often have a higher per-second rate. TokenWatch shows the resolution attached to each price so a 720p rate is not presented as a 1080p or 4K rate.'],
    ['How does generated audio affect video pricing?', 'Some endpoints include generated audio, some exclude it, and some do not state the audio mode. Use the audio filter and compare like-for-like variants.'],
    ['Why does one video model have several per-second prices?', 'A provider can publish separate prices for resolution, audio, generation mode, or endpoint variants. TokenWatch preserves those records and selects only the cheapest one for the crawlable summary table.'],
    ['Can I compare video-generation providers?', 'Yes. Filter by model, resolution, and audio, then compare the per-second and total-duration costs of the remaining rows.'],
  ];
}

// Pointer section used on calculator pages — full FAQ lists live on /faq/.
// Unlike renderFaqSection, answers are NOT escaped (contains a real anchor).
export function renderFaqPointerSection() {
  return `    <section class="seo-faq" id="faq" aria-label="Frequently asked questions"><h2>Frequently asked questions</h2><details open><summary>Where are the full FAQ lists?</summary><p>All questions — choosing a model and provider, text/token pricing, image and video generation pricing, and plain-language benchmark explainers — live on the consolidated <a href="/faq/">FAQ page</a>.</p></details></section>`;
}

export function renderFaqSection(title, items) {
  const details = items.map(([question, answer]) => `<details><summary>${esc(question)}</summary><p>${esc(answer)}</p></details>`).join('');
  return `    <section class="seo-faq" id="faq" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${details}</section>`;
}

function faqSchema(items) {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map(([question, answer]) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}

function breadcrumbSchema(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: SITE + item.path,
    })),
  };
}

function itemListSchema(name, rows, path) {
  return {
    '@type': 'ItemList',
    name,
    numberOfItems: rows.length,
    itemListElement: rows.map((row, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: displayName(row.m),
      url: SITE + path + '#provider=' + encodeURIComponent(row.m.provider) + '&model=' + encodeURIComponent(canonicalId(row.m.id)),
    })),
  };
}

export function calculatorStructuredData({ page, title, description, faq, rows }) {
  const path = page === 'text' ? '/' : `/${page}`;
  const breadcrumbs = page === 'text'
    ? [{ name: 'Text pricing', path: '/' }]
    : [{ name: 'Text pricing', path: '/' }, { name: page === 'benchmarks' ? 'Benchmarks' : `${page[0].toUpperCase()}${page.slice(1)} pricing`, path }];
  const graph = [
    {
      '@type': page === 'text' ? 'WebSite' : 'CollectionPage',
      '@id': SITE + path + '#page',
      url: SITE + path,
      name: page === 'text' ? 'TokenWatch' : title,
      description,
      publisher: { '@type': 'Organization', name: 'WyrdWerk', url: 'https://wyrdwerk.com' },
    },
    breadcrumbSchema(breadcrumbs),
  ];
  if (faq?.length) graph.push(faqSchema(faq)); // calculator pages pass none — FAQPage lives on /faq/
  if (rows?.length) graph.push(itemListSchema(`${title} price list`, rows, path));
  if (page === 'text') {
    graph.splice(1, 0, {
      '@type': 'SoftwareApplication',
      name: 'TokenWatch',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      url: SITE + '/',
      description: 'Interactive LLM API pricing calculator for text, image, and video models, with a use-case finder that recommends open-weight models and inference providers.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

export function renderJsonLd(data) {
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<script id="seo-structured-data" type="application/ld+json">${safeJson}</script>`;
}

export function replaceStructuredData(markup, data) {
  const script = renderJsonLd(data);
  const marked = /<script id="seo-structured-data" type="application\/ld\+json">[\s\S]*?<\/script>/;
  if (marked.test(markup)) return markup.replace(marked, script);
  const legacy = /<script type="application\/ld\+json">[\s\S]*?<\/script>/;
  if (legacy.test(markup)) return markup.replace(legacy, script);
  return markup.replace('</head>', `  ${script}\n</head>`);
}

export function replaceSection(markup, className, section) {
  const escapedClass = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMarker = `<!-- TW:SEO:${className}:START -->`;
  const endMarker = `<!-- TW:SEO:${className}:END -->`;
  const wrapped = `${startMarker}\n${section}\n${endMarker}`;
  const markerPattern = new RegExp(`<!-- TW:SEO:${escapedClass}:START -->[\\s\\S]*?<!-- TW:SEO:${escapedClass}:END -->`);
  if (markerPattern.test(markup)) return markup.replace(markerPattern, wrapped);

  const opener = new RegExp(`<section[^>]*class="${escapedClass}"[^>]*>`);
  const match = opener.exec(markup);
  if (match && className === 'seo-models') {
    const nextSection = /<section[^>]*class="seo-faq"[^>]*>/g;
    nextSection.lastIndex = match.index + match[0].length;
    const next = nextSection.exec(markup);
    if (next) return markup.slice(0, match.index) + wrapped + '\n    ' + markup.slice(next.index);
  }
  const legacyPattern = new RegExp(`<section[^>]*class="${escapedClass}"[^>]*>[\\s\\S]*?<\\/section>`);
  if (legacyPattern.test(markup)) return markup.replace(legacyPattern, wrapped);
  return markup.replace('</main>', `\n${wrapped}\n  </main>`);
}

function replaceMetaContent(markup, attribute, value, content) {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<meta([^>]*${escapedAttribute}="${escapedValue}"[^>]*)content="[^"]*"([^>]*)>`);
  return markup.replace(pattern, `<meta$1content="${esc(content)}"$2>`);
}

function replaceSubtitle(markup, subtitle) {
  const pattern = /<p([^>]*class="[^"]*\bsubtitle\b[^"]*"[^>]*)>[\s\S]*?<\/p>/;
  return markup.replace(pattern, (_, attrs) => `<p${attrs}>${esc(subtitle)}</p>`);
}

export function renderModalityMeta(markup, modality, modelCount) {
  const isImage = modality === 'image';
  const label = isImage ? 'Image Generation' : 'Video Generation';
  const title = `${label} API Pricing — Compare ${modelCount} Models | TokenWatch`;
  const description = isImage
    ? `Compare image generation API pricing across ${modelCount} models. Keep flat per-image, per-megapixel, and image-token rates separate, then calculate your workload cost.`
    : `Compare video generation API pricing across ${modelCount} models. Filter per-second rates by resolution and audio, then calculate the cost for your duration.`;
  let out = markup.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  out = replaceMetaContent(out, 'name', 'description', description);
  out = replaceMetaContent(out, 'property', 'og:title', title);
  out = replaceMetaContent(out, 'property', 'og:description', description);
  out = replaceMetaContent(out, 'name', 'twitter:title', title);
  out = replaceMetaContent(out, 'name', 'twitter:description', description);
  return out;
}

export function renderHomepageMeta(markup, modelCount, providerCount) {
  const title = 'LLM API Pricing Comparison & Open Model Finder | TokenWatch';
  const description = `Compare ${modelCount.toLocaleString('en-US')} LLM API prices across ${providerCount} providers, updated every 2 hours. Find the cheapest provider for your workload with cache pricing, ZDR filters, and a cost calculator.`;
  const subtitle = `Compare pay-as-you-go LLM API pricing across ${providerCount} providers and ${modelCount} text-model offerings. Enter your token mix or set a budget to estimate your agents' costs.`;
  let out = markup.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  out = replaceMetaContent(out, 'name', 'description', description);
  out = replaceMetaContent(out, 'property', 'og:title', title);
  out = replaceMetaContent(out, 'property', 'og:description', description);
  out = replaceMetaContent(out, 'name', 'twitter:title', title);
  out = replaceMetaContent(out, 'name', 'twitter:description', description);
  out = replaceSubtitle(out, subtitle);
  return out;
}

export function renderCounts(markup, modelCount, providerCount) {
  const out = markup
    .replaceAll('{{modelCount}}', String(modelCount))
    .replaceAll('{{providerCount}}', String(providerCount));
  if (out.includes('{{')) {
    throw new Error(`generate-seo: unreplaced count placeholder remains (model=${modelCount}, provider=${providerCount})`);
  }
  return out;
}

export function providerSlug(provider) {
  const slug = String(provider || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`generate-seo: unsafe empty provider slug for ${provider}`);
  return slug;
}

function prettyProvider(provider) {
  const special = {
    'z-ai': 'Z.ai',
    xai: 'xAI',
    gmicloud: 'GMI Cloud',
    deepinfra: 'DeepInfra',
    sambanova: 'SambaNova',
    siliconflow: 'SiliconFlow',
    opencode: 'OpenCode',
    neuralwatt: 'Neuralwatt',
    aster: 'Aster Labs',
    zro: 'Zro',
  };
  if (special[provider]) return special[provider];
  return provider.split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ');
}

function hasTextPrice(model) {
  return isPositive(model.pricing?.input) || isPositive(model.pricing?.output);
}

function hasImagePrice(model) {
  return (model.pricing || []).some((pricing) => isPositive(pricing.cost_per_unit) || isPositive(pricing.cost_per_million));
}

function hasVideoPrice(model) {
  return (model.pricing || []).some((pricing) => isPositive(pricing.cost_per_second));
}

// A published set retains established URLs regardless of coverage and prevents
// new landing pages. Without it, use the original minimum-coverage threshold.
export function collectProviderPages({ pricing, imagePricing, videoPricing, publishedProviders = null }, minModels = PROVIDER_MIN_MODELS) {
  const providers = new Map();
  const names = new Map((pricing.providers || []).map((provider) => [provider.key, provider.name]));
  const get = (key) => {
    if (!providers.has(key)) providers.set(key, { key, text: [], image: [], video: [] });
    return providers.get(key);
  };
  for (const key of publishedProviders || []) get(key);
  for (const model of pricing.models || []) if (model.provider && hasTextPrice(model)) get(model.provider).text.push(model);
  for (const model of imagePricing.models || []) if (model.provider && hasImagePrice(model)) get(model.provider).image.push(model);
  for (const model of videoPricing.models || []) if (model.provider && hasVideoPrice(model)) get(model.provider).video.push(model);

  const slugOwners = new Map();
  const pages = [];
  for (const provider of providers.values()) {
    const identities = new Set([
      ...provider.text.map((model) => `text:${canonicalId(model.id)}`),
      ...provider.image.map((model) => `image:${canonicalId(model.id)}`),
      ...provider.video.map((model) => `video:${canonicalId(model.id)}`),
    ]);
    if (publishedProviders ? !publishedProviders.has(provider.key) : identities.size < minModels) continue;
    const slug = providerSlug(provider.key);
    const owner = slugOwners.get(slug);
    if (owner && owner !== provider.key) throw new Error(`generate-seo: provider slug collision: ${owner} and ${provider.key} → ${slug}`);
    slugOwners.set(slug, provider.key);
    pages.push({
      ...provider,
      slug,
      name: names.get(provider.key) || prettyProvider(provider.key),
      modelCount: identities.size,
      meta: pricing.providers_meta?.[provider.key] || {},
    });
  }
  return pages.sort((a, b) => a.name.localeCompare(b.name));
}

const NAV_LINKS = [
  ['/', 'Text'], ['/image', 'Image'], ['/video', 'Video'], ['/benchmarks', 'Benchmarks'], ['/choose/', 'Choose'],
  ['/models/', 'Models'], ['/providers/', 'Providers'], ['/docs/methodology/', 'Methodology'], ['/docs/api/', 'API'], ['/faq/', 'FAQ'],
];

// Generated pages mark their section tab; the section index itself is the current page.
export function pageNav(currentPath = '') {
  const links = NAV_LINKS.map(([href, label]) => {
    const inSection = href.endsWith('/') && href !== '/' && currentPath.startsWith(href);
    if (!inSection) return `<a class="tab-link" href="${href}">${label}</a>`;
    const current = currentPath === href ? ' aria-current="page"' : '';
    return `<a class="tab-link active"${current} href="${href}">${label}</a>`;
  }).join('');
  return `<nav class="tab-nav" aria-label="TokenWatch sections">${links}</nav>`;
}

function visibleBreadcrumbs(items) {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${items.map((item, index) => `${index ? '<span aria-hidden="true">/</span>' : ''}<a href="${esc(item.path)}">${esc(item.name)}</a>`).join('')}</nav>`;
}

export function renderStaticPage({ title, description, canonicalPath, heading, subtitle, breadcrumbs, body, structuredData, scripts }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#F8F5F0" />
  <script>(function(){try{var t=localStorage.getItem('tw-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',t==='dark'?'#1a1612':'#F8F5F0')}catch(e){}})();</script>
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="canonical" href="${SITE}${esc(canonicalPath)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="TokenWatch" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${SITE}${esc(canonicalPath)}" />
  <meta property="og:image" content="${SITE}/og/og-image.png" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="TokenWatch — compare text, image, and video API pricing for your workload" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${SITE}/og/og-image.png" />
  <meta name="twitter:image:alt" content="TokenWatch — compare text, image, and video API pricing for your workload" />
  <link rel="preload" href="/fonts/inter-400.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/fonts/space-grotesk-600.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/styles.css?v=dev" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  ${renderJsonLd(structuredData)}
</head>
<body>
  <header><div class="header-row"><a class="brand-link site-brand" href="/" aria-label="TokenWatch home">💰 TokenWatch</a><a class="repo-link" href="https://wyrdwerk.com" target="_blank" rel="noopener">WyrdWerk</a><a class="repo-link" href="https://github.com/WyrdWerk/tokenwatch" target="_blank" rel="noopener">GitHub</a><a class="repo-link" href="https://www.linkedin.com/in/yash-jain-65295511b/" target="_blank" rel="noopener">LinkedIn</a><a class="repo-link" href="https://x.com/thelaggingway" target="_blank" rel="noopener">X</a><button id="themeToggle" class="theme-toggle" aria-label="Toggle theme" title="Toggle dark/light mode"></button></div><h1 class="tagline">${esc(heading)}</h1><p class="subtitle">${esc(subtitle)}</p>${pageNav(canonicalPath)}</header>
  <main class="seo-page-main">
    ${visibleBreadcrumbs(breadcrumbs)}
${body}
  </main>
  <footer><p>Pricing changes. Verify rates and policy details with the provider before committing spend.</p><p class="footer-links"><a href="/models/">Models</a> · <a href="/providers/">Providers</a> · <a href="/docs/methodology/">Methodology</a> · <a href="/docs/api/">API docs</a> · <a href="https://github.com/WyrdWerk/tokenwatch">Source</a></p></footer>
  <script src="/shared-ui.js?v=dev" defer></script>
${scripts || ''}</body>
</html>
`;
}

function policyLinks(meta) {
  const links = [
    ['Privacy policy', meta.privacy_policy_url],
    ['Terms', meta.terms_of_service_url],
    ['Status', meta.status_page_url],
  ].filter(([, url]) => typeof url === 'string' && /^https:\/\//.test(url));
  return links.length ? links.map(([label, url]) => `<a href="${esc(url)}" rel="noopener">${esc(label)}</a>`).join(' · ') : 'No reviewed policy links are currently listed.';
}

function providerTextSection(provider, lastmod, links) {
  if (!provider.text.length) return '';
  return renderSeoTable(cheapestModels(provider.text, 25), lastmod, {
    ...links,
    id: 'text-pricing',
    title: `${provider.name} text-model pricing`,
    intro: 'Text offerings ranked by the Agentic workload mix (2.5% input, 97% cached input, 0.5% output). Change the calculator mix for a workload-specific estimate.',
  });
}

function providerImageSection(provider, lastmod) {
  if (!provider.image.length) return '';
  const groups = Object.fromEntries(['image', 'megapixel', 'token'].map((unit) => [unit, cheapestImageModels(provider.image, unit, 10)]));
  return renderImageSeoSection(groups, lastmod).replace('id="image-pricing-guide"', 'id="image-pricing"');
}

function providerVideoSection(provider, lastmod) {
  if (!provider.video.length) return '';
  return renderVideoSeoSection(cheapestVideoModels(provider.video, 15), lastmod).replace('id="video-pricing-guide"', 'id="video-pricing"');
}

/**
 * Concrete, page-consistent facts for a provider's search snippet. Every
 * number comes from `provider.text` — the same records the page's overview
 * and pricing table render.
 */
export function providerSnippetFacts(provider) {
  const priced = (provider.text || []).filter((model) => isPositive(model.pricing?.input));
  const cheapest = [...priced].sort((a, b) => a.pricing.input - b.pricing.input
    || (a.pricing.output ?? Infinity) - (b.pricing.output ?? Infinity)
    || String(a.id).localeCompare(String(b.id)))[0] || null;
  const textCount = (provider.text || []).length;
  return {
    cheapest,
    cheapestName: cheapest ? shortModelName(cheapest) : null,
    cheapestInput: cheapest?.pricing.input ?? null,
    cheapestOutput: isPositive(cheapest?.pricing.output) ? cheapest.pricing.output : null,
    textCount,
    cacheCount: (provider.text || []).filter((model) => isPositive(model.pricing?.cache_read)).length,
    zdrCount: (provider.text || []).filter((model) => model.zdr === true).length,
    reviewedZdr: provider.meta?.retains_prompts === false,
  };
}

export function providerPageTitle(provider, month) {
  const facts = providerSnippetFacts(provider);
  const name = provider.name;
  const models = provider.modelCount ? plural(provider.modelCount, 'Model') : null;
  const from = snippetPrice(facts.cheapestInput);
  const when = month ? ` (${month})` : '';
  if (!models) return fitTitle([`${name} API Pricing${when} | TokenWatch`, `${name} API Pricing`]);
  return fitTitle([
    from && `${name} API Pricing${when}: ${models} from ${from}/M | TokenWatch`,
    from && `${name} API Pricing${when}: ${models} from ${from}/M`,
    from && `${name} API Pricing: ${models} from ${from}/M`,
    `${name} API Pricing${when}: ${models} | TokenWatch`,
    `${name} API Pricing${when}: ${models}`,
    `${name} API Pricing`,
  ]);
}

export function providerPageDescription(provider, month) {
  if (!provider.modelCount) {
    return `Current pricing for ${provider.name} is unavailable in this TokenWatch catalog snapshot. Review available provider policy links and other providers.`;
  }
  const facts = providerSnippetFacts(provider);
  const parts = [`${provider.name} API pricing${month ? ` (${month})` : ''}: ${plural(provider.modelCount, 'model')} tracked.`];
  if (facts.cheapest) {
    parts.push(`Cheapest: ${facts.cheapestName} at ${snippetPrice(facts.cheapestInput)}/M input${facts.cheapestOutput ? `, ${snippetPrice(facts.cheapestOutput)}/M output` : ''}.`);
  }
  if (facts.textCount) parts.push(`Cache-read pricing on ${facts.cacheCount} of ${facts.textCount} text models.`);
  if (facts.reviewedZdr) parts.push('Zero data retention.');
  else if (facts.zdrCount) parts.push(`${facts.zdrCount} ZDR endpoint${facts.zdrCount === 1 ? '' : 's'}.`);
  parts.push('Compare every rate and estimate your workload cost.');
  return parts.join(' ');
}

function providerFactsProse(provider) {
  const facts = providerSnippetFacts(provider);
  if (!facts.cheapest) return '';
  const output = facts.cheapestOutput ? ` and ${fmtPrice(facts.cheapestOutput)} per million output tokens` : '';
  return `<p data-snippet-facts>Cheapest input price: ${esc(facts.cheapestName)} at ${fmtPrice(facts.cheapestInput)} per million input tokens${output}. ${facts.cacheCount} of ${facts.textCount} text models publish a cache-read price; ${facts.zdrCount} carry a zero-data-retention tag.</p>`;
}

export function renderProviderPage(provider, dates, links = {}) {
  const path = `/providers/${provider.slug}/`;
  const month = catalogMonth(dates?.text);
  const description = providerPageDescription(provider, month);
  const zdr = provider.meta.retains_prompts === false ? 'Reviewed metadata says prompts are not retained.' : 'TokenWatch does not have a provider-wide zero-retention verdict for this page.';
  const body = `    <section class="seo-prose"><h2>${esc(provider.name)} pricing overview</h2>${provider.modelCount ? '' : `<p data-catalog-unavailable>No current priced offerings are available in the catalog snapshot ${esc(dates.text)}. Missing catalog coverage is not a zero price or proof that this provider has closed. This established URL is retained for existing links. <a href="/providers/">Browse other providers</a>.</p>`}<p>TokenWatch tracks ${provider.text.length} text, ${provider.image.length} image, and ${provider.video.length} video model records for this provider. ${esc(zdr)}</p>${providerFactsProse(provider)}<p>${policyLinks(provider.meta)}</p><p><a href="/#provider=${encodeURIComponent(provider.key)}">Open the text calculator filtered to ${esc(provider.name)}</a></p></section>
${providerTextSection(provider, dates.text, links)}
${providerImageSection(provider, dates.image)}
${providerVideoSection(provider, dates.video)}`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', url: SITE + path, name: `${provider.name} API pricing`, description },
      breadcrumbSchema([{ name: 'Text pricing', path: '/' }, { name: 'Providers', path: '/providers/' }, { name: provider.name, path }]),
      { '@type': 'ItemList', name: `${provider.name} tracked models`, numberOfItems: provider.modelCount },
    ],
  };
  return renderStaticPage({
    title: providerPageTitle(provider, month),
    description,
    canonicalPath: path,
    heading: `${provider.name} API pricing`,
    subtitle: `${provider.modelCount} tracked model identities with provider-specific prices`,
    breadcrumbs: [{ name: 'Text pricing', path: '/' }, { name: 'Providers', path: '/providers/' }, { name: provider.name, path }],
    body,
    structuredData,
  });
}

export function renderProviderDirectoryPage(providers, dates = {}) {
  const path = '/providers/';
  const rows = providers.map((provider) => `<tr><td><a href="/providers/${esc(provider.slug)}/">${esc(provider.name)}</a></td><td class="num">${provider.text.length}</td><td class="num">${provider.image.length}</td><td class="num">${provider.video.length}</td><td class="num">${provider.modelCount}</td><td>${provider.meta.retains_prompts === false ? 'Reviewed ZDR' : 'Not confirmed provider-wide'}</td></tr>`).join('\n');
  const body = `    <section class="seo-prose"><h2>Browse inference providers</h2><p>This directory lists established provider pages. Pages remain available when coverage drops. Counts combine the text, image, and video catalogs without merging unlike pricing variants; zero records means unavailable catalog coverage, not free pricing.</p></section>
    <section class="seo-models" id="provider-directory"><div class="table-wrap"><table><caption>TokenWatch provider directory</caption><thead><tr><th scope="col">Provider</th><th scope="col" class="num">Text records</th><th scope="col" class="num">Image records</th><th scope="col" class="num">Video records</th><th scope="col" class="num">Distinct models</th><th scope="col">Retention metadata</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  const month = catalogMonth(dates.text);
  const reviewedZdr = providers.filter((provider) => provider.meta?.retains_prompts === false).length;
  const pricedCount = providers.filter((provider) => provider.modelCount > 0).length;
  const description = `Compare API pricing from ${plural(providers.length, 'inference provider')}${month ? ` (${month})` : ''}: ${pricedCount} with current text, image, or video prices, ${reviewedZdr} with reviewed zero data retention. Model counts, policies, and links per provider.`;
  return renderStaticPage({
    title: fitTitle([
      `LLM API Pricing by Provider${month ? ` (${month})` : ''}: ${providers.length} Providers | TokenWatch`,
      `LLM API Pricing by Provider: ${providers.length} Providers | TokenWatch`,
      `LLM API Pricing by Provider | TokenWatch`,
    ]),
    description,
    canonicalPath: path,
    heading: 'Inference provider directory',
    subtitle: `${providers.length} established provider pages; catalog coverage can change`,
    breadcrumbs: [{ name: 'Text pricing', path: '/' }, { name: 'Providers', path }],
    body,
    structuredData: {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'CollectionPage', url: SITE + path, name: 'TokenWatch provider directory', description },
        breadcrumbSchema([{ name: 'Text pricing', path: '/' }, { name: 'Providers', path }]),
        { '@type': 'ItemList', name: 'Inference providers', numberOfItems: providers.length, itemListElement: providers.map((provider, index) => ({ '@type': 'ListItem', position: index + 1, name: provider.name, url: `${SITE}/providers/${provider.slug}/` })) },
      ],
    },
  });
}

/** Minimum distinct priced providers for a model landing page to be built. */
export const MODEL_MIN_PROVIDERS = 3;

/** The exact set of provider slugs that have a generated page. */
export function providerPageSlugs(providers) {
  return new Set((providers || []).map((provider) => provider.slug));
}

/**
 * The price-history panel for a model page.
 *
 * The chart markup is emitted here as an EMPTY container plus a note; it is
 * hydrated client-side by public/model-history.js against
 * GET /api/v1/models/:canonicalId/history. History lives in D1, which is not
 * available at build time, so the loading/empty/error states must be real
 * client states — which is why the component defines them.
 */
export function renderPriceHistorySection(page) {
  return `    <section class="price-history" id="price-history" data-price-history="${esc(page.canonical)}" aria-labelledby="price-history-heading">
      <h2 id="price-history-heading">Daily price history</h2>
      <p class="price-history-note" data-price-history-note>Loading price history…</p>
      <div class="price-history-chart" data-price-history-chart></div>
      <p class="price-history-note">Daily snapshots are retained for up to 90 days; history begins with the first recorded snapshot.</p>
      <noscript><p class="price-history-note">Price history needs JavaScript. The current per-provider rates are listed below.</p></noscript>
    </section>`;
}

/**
 * Sanitize a canonical model id into a URL-safe slug. Dots and hyphens are
 * preserved because canonical IDs use them (glm-5.2-fp8); everything else is
 * collapsed to a hyphen. Quantized canonical ids stay distinct — this never
 * collapses variants.
 */
export function modelPageSlug(canonical) {
  const slug = String(canonical || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`generate-seo: unsafe empty model slug for ${canonical}`);
  return slug;
}

/**
 * Group text-catalog offerings by canonical model id and keep only canonical
 * models with substantive multi-provider coverage, or retain the exact
 * published set even when coverage drops. `:batch` canonicals are excluded by
 * default; quantized canonical ids remain separate pages.
 *
 * @param {{pricing: object}} catalogs
 * @param {{minProviders?: number, excludeBatch?: boolean, publishedModels?: Set<string>}} [options]
 */
export function collectModelPages({ pricing }, { minProviders = MODEL_MIN_PROVIDERS, excludeBatch = true, publishedModels = null } = {}) {
  const groups = new Map();
  for (const canonical of publishedModels || []) {
    if (!excludeBatch || !/:batch$/i.test(canonical)) groups.set(canonical, []);
  }
  for (const model of pricing.models || []) {
    if (!model.provider || !hasTextPrice(model)) continue;
    const canonical = canonicalId(model.id);
    if (!canonical) continue;
    if (excludeBatch && /:batch$/i.test(canonical)) continue;
    if (publishedModels && !publishedModels.has(canonical)) continue;
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical).push(model);
  }

  const slugOwners = new Map();
  const pages = [];
  for (const [canonical, offerings] of groups) {
    const providers = new Set(offerings.map((m) => m.provider));
    if (!publishedModels && providers.size < minProviders) continue;
    const slug = modelPageSlug(canonical);
    const owner = slugOwners.get(slug);
    if (owner && owner !== canonical) throw new Error(`generate-seo: model slug collision: ${owner} and ${canonical} → ${slug}`);
    slugOwners.set(slug, canonical);

    // Provider-offering ranges — NOT an intrinsic model price. Cache-read
    // coverage counts offerings that publish a cache price.
    const inputs = offerings.map((m) => m.pricing?.input).filter((v) => Number.isFinite(v) && v > 0);
    const outputs = offerings.map((m) => m.pricing?.output).filter((v) => Number.isFinite(v) && v > 0);
    const cacheCoverage = offerings.filter((m) => m.pricing?.cache_read != null).length;
    const withPerf = offerings.filter((m) => Number.isFinite(m.uptime_30m));
    const contextLengths = offerings.map((m) => m.context_length).filter((v) => Number.isFinite(v) && v > 0);
    const ranked = offerings
      .map((m) => ({ m, eff: blendedRate(m.pricing, AGENTIC_MIX) }))
      .filter((row) => row.eff != null && row.eff > 0)
      .sort((a, b) => a.eff - b.eff);

    pages.push({
      canonical,
      slug,
      name: offerings.length ? modelDisplayName({ id: canonical, providers: offerings.map((offering) => ({ offering })) }) : canonical,
      org: offerings.find((m) => m.org)?.org || offerings[0]?.provider || '—',
      offerings,
      ranked,
      providerCount: providers.size,
      inputRange: inputs.length ? { min: Math.min(...inputs), max: Math.max(...inputs) } : null,
      outputRange: outputs.length ? { min: Math.min(...outputs), max: Math.max(...outputs) } : null,
      cacheCoverage,
      uptimeCoverage: withPerf.length,
      maxContext: contextLengths.length ? Math.max(...contextLengths) : null,
      cheapest: ranked[0]?.m || null,
      cheapestEff: ranked[0]?.eff ?? null,
    });
  }
  // Readable names can collide (a quantized canonical often shares its base
  // model's catalog name); fall back to the canonical id so titles stay unique.
  const nameCounts = new Map();
  for (const page of pages) nameCounts.set(page.name.toLowerCase(), (nameCounts.get(page.name.toLowerCase()) || 0) + 1);
  for (const page of pages) if (nameCounts.get(page.name.toLowerCase()) > 1) page.name = page.canonical;
  return pages.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Provider rows for a model page.
 *
 * `linkedProviderSlugs` is the exact set of providers that have a generated
 * /providers/<slug>/ page. A provider without one renders as plain text —
 * linking it would 404. The row itself is never dropped.
 */
function renderModelProviderRows(page, linkedProviderSlugs = new Set()) {
  return page.ranked.map(({ m, eff }) => {
    const pricing = m.pricing || {};
    const promo = m.discount > 0 ? ' <span class="promo-badge" title="' + (m.discount * 100).toFixed(0) + '% off">promo</span>' : '';
    const uptime = Number.isFinite(m.uptime_30m) ? `${m.uptime_30m.toFixed(2)}%` : '—';
    const quant = m.quantization ? esc(m.quantization) : '—';
    const label = esc(prettyProvider(m.provider));
    const slug = providerSlug(m.provider);
    const providerCell = linkedProviderSlugs.has(slug)
      ? `<a href="/providers/${esc(slug)}/">${label}</a>`
      : label;
    return `      <tr><td>${providerCell}${promo}</td><td>${quant}</td><td class="num">${fmtPrice(pricing.input)}</td><td class="num">${fmtPrice(pricing.output)}</td><td class="num">${fmtPrice(pricing.cache_read)}</td><td class="num">${fmtPrice(eff)}</td><td class="num">${uptime}</td></tr>`;
  }).join('\n');
}

/**
 * Server-render a canonical-model comparison page at /models/<slug>/.
 * Includes the provider table, a calculator deep link, canonical URL,
 * breadcrumbs, and JSON-LD. Labels are deliberately source-accurate: the
 * price range is a provider-offering range, and uptime is the 30-minute
 * endpoint metric (never a one-day claim).
 */
function providerLabel(model) {
  const display = model?.provider_display;
  return typeof display === 'string' && display.trim() ? display.trim() : prettyProvider(model?.provider || '');
}

export function modelPageTitle(page, month) {
  const providers = plural(page.providerCount, 'Provider');
  const from = snippetPrice(page.inputRange?.min);
  const when = month ? ` (${month})` : '';
  return fitTitle([
    from && `${page.name} API Pricing: ${providers} from ${from}/M${when} | TokenWatch`,
    from && `${page.name} API Pricing: ${providers} from ${from}/M${when}`,
    from && `${page.name} API Pricing: ${providers} from ${from}/M`,
    `${page.name} API Pricing Across ${providers}${when} | TokenWatch`,
    `${page.name} API Pricing Across ${providers}`,
    `${page.name} API Pricing`,
  ]);
}

export function modelPageDescription(page, month, historyEnabled = true) {
  if (!page.offerings.length) {
    return `Current provider pricing for ${page.name} is unavailable in this TokenWatch catalog snapshot. Browse other models or check the calculator for updated coverage.`;
  }
  const parts = [`${page.name} API pricing${month ? ` (${month})` : ''} across ${plural(page.providerCount, 'provider')}.`];
  if (page.inputRange && page.outputRange) {
    parts.push(`Input ${snippetPrice(page.inputRange.min)}–${snippetPrice(page.inputRange.max)}/M, output ${snippetPrice(page.outputRange.min)}–${snippetPrice(page.outputRange.max)}/M.`);
  }
  if (page.cheapest) parts.push(`Cheapest for cached agent workloads: ${providerLabel(page.cheapest)} at ${snippetPrice(page.cheapestEff)}/M blended.`);
  parts.push(`Cache-read pricing on ${page.cacheCoverage} of ${page.offerings.length} offerings.`);
  parts.push(historyEnabled ? 'Compare providers and daily price history.' : 'Compare every provider side by side.');
  return parts.join(' ');
}

export function renderModelPage(page, { lastmod, historyEnabled = true, linkedProviderSlugs = new Set() } = {}) {
  const path = `/models/${page.slug}/`;
  const month = catalogMonth(lastmod);
  const providerSuffix = page.providerCount === 1 ? '' : 's';
  const rangeText = page.inputRange && page.outputRange
    ? `Across tracked provider offerings, input runs ${fmtPrice(page.inputRange.min)}–${fmtPrice(page.inputRange.max)} per million tokens and output ${fmtPrice(page.outputRange.min)}–${fmtPrice(page.outputRange.max)} per million tokens.`
    : "Tracked provider offerings do not currently publish a complete input/output range.";
  const cheapestText = page.cheapest
    ? `The cheapest tracked provider offering for a typical agentic mix (2.5% input, 97% cached input, 0.5% output) is ${providerLabel(page.cheapest)} at ${fmtPrice(page.cheapestEff)} per million tokens.`
    : "No provider offering can be priced at the default agentic mix yet.";
  const description = modelPageDescription(page, month, historyEnabled);
  const history = historyEnabled ? `\n${renderPriceHistorySection(page)}` : '';

  const body = `    <section class="seo-prose"><h2>${esc(page.name)} pricing across providers</h2>${page.offerings.length ? '' : '<p data-catalog-unavailable>No current priced offerings are available in this catalog snapshot. Missing coverage is not a zero price or proof that this model has been retired. This established URL is retained for existing links. <a href="/models/">Browse other models</a>.</p>'}<p>${esc(rangeText)} ${esc(cheapestText)}</p><p>Prices are USD per million tokens and reflect each provider offering — they are not a single intrinsic model price. ${page.cacheCoverage} of ${page.offerings.length} offerings publish a cache-read rate; ${page.uptimeCoverage} of ${page.offerings.length} publish a 30-minute endpoint uptime figure.</p><p><a href="/#model=${encodeURIComponent(page.canonical)}">Open the calculator filtered to ${esc(page.name)}</a></p><p class="seo-choose-link">Is this the right model for your workload? <a href="/choose/">Compare open-weight picks and providers for your use case →</a></p></section>${history}
    <section class="seo-models" id="model-providers" aria-label="${esc(page.name)} provider pricing">
      <h2>Provider offerings for ${esc(page.name)}</h2>
      <p>Ranked by effective cost at a typical agentic mix. Quantized and tier variants stay separate rows.</p>
      <div class="table-wrap"><table>
        <caption>${esc(page.name)} provider offerings</caption>
        <thead><tr><th scope="col">Provider</th><th scope="col">Quant</th><th scope="col" class="num">Input $/M</th><th scope="col" class="num">Output $/M</th><th scope="col" class="num">Cache $/M</th><th scope="col" class="num">Blended $/M</th><th scope="col" class="num">Uptime (30m)</th></tr></thead>
        <tbody>${renderModelProviderRows(page, linkedProviderSlugs)}</tbody>
      </table></div>
      <p class="seo-note">Provider-offering pricing refreshed ${esc(lastmod || "")}. Uptime is the 30-minute endpoint metric where a provider publishes it. Verify rates on the provider's official pricing page before committing spend.</p>
    </section>`;

  const breadcrumbs = [
    { name: "Text pricing", path: "/" },
    { name: "Models", path: "/models/" },
    { name: page.name, path },
  ];
  const structuredData = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', url: SITE + path, name: `${page.name} API pricing`, description },
      breadcrumbSchema(breadcrumbs),
      { '@type': 'ItemList', name: `${page.name} provider offerings`, numberOfItems: page.providerCount },
    ],
  };
  return renderStaticPage({
    title: modelPageTitle(page, month),
    description,
    canonicalPath: path,
    heading: `${page.name} API pricing`,
    subtitle: `${page.providerCount} tracked provider${providerSuffix}; ${page.offerings.length} priced offering${page.offerings.length === 1 ? '' : 's'} with offering-level rates`,
    breadcrumbs,
    body,
    structuredData,
    // The chart is hydrated client-side; both files are fingerprinted by
    // bust-cache.mjs so the deployed paths stay cache-safe.
    scripts: historyEnabled
      ? '  <script src="/price-sparkline.js?v=dev" defer></script>\n  <script src="/model-history.js?v=dev" defer></script>\n'
      : '',
  });
}

export function renderModelDirectoryPage(pages, dates = {}) {
  const path = "/models/";
  const rows = pages.map((page) => `      <tr><td><a href="/models/${esc(page.slug)}/">${esc(page.name)}</a></td><td>${esc(page.org)}</td><td class="num">${page.providerCount}</td><td class="num">${fmtPrice(page.cheapestEff)}</td></tr>`).join('\n');
  const month = catalogMonth(dates.text);
  const priced = pages.filter((page) => Number.isFinite(page.cheapestEff) && page.cheapestEff > 0);
  const cheapest = [...priced].sort((a, b) => a.cheapestEff - b.cheapestEff)[0] || null;
  const description = `Compare API prices for ${plural(pages.length, 'LLM')} across providers${month ? ` (${month})` : ''}: input, output, and cache-read rates per provider${cheapest ? `, from ${snippetPrice(cheapest.cheapestEff)}/M blended (${cheapest.name})` : ''}. Find the cheapest host for each model.`;
  const body = `    <section class="seo-prose"><h2>Browse models by provider coverage</h2><p>This directory lists established model comparisons. Pages remain available when coverage drops; missing pricing is unknown, not zero. Quantized variants are kept as separate canonical models; <code>:batch</code> variants are excluded.</p></section>
    <section class="seo-models" id="model-directory"><div class="table-wrap"><table><caption>TokenWatch model directory</caption><thead><tr><th scope="col">Model</th><th scope="col">Org</th><th scope="col" class="num">Providers</th><th scope="col" class="num">Cheapest $/M</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  return renderStaticPage({
    title: fitTitle([
      `LLM API Pricing by Model${month ? ` (${month})` : ''}: ${pages.length} Models Compared | TokenWatch`,
      `LLM API Pricing by Model: ${pages.length} Models Compared | TokenWatch`,
      'LLM API Pricing by Model | TokenWatch',
    ]),
    description,
    canonicalPath: path,
    heading: "Model pricing directory",
    subtitle: `${pages.length} established model pages; provider coverage can change`,
    breadcrumbs: [{ name: "Text pricing", path: "/" }, { name: "Models", path }],
    body,
    structuredData: {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'CollectionPage', url: SITE + path, name: 'TokenWatch model directory', description },
        breadcrumbSchema([{ name: "Text pricing", path: "/" }, { name: "Models", path }]),
        { '@type': 'ItemList', name: 'Canonical models', numberOfItems: pages.length, itemListElement: pages.map((page, index) => ({ '@type': 'ListItem', position: index + 1, name: page.name, url: `${SITE}/models/${page.slug}/` })) },
      ],
    },
  });
}

export function benchFaqItems() {
  return [
    // ── Score sources, one entry per benchmark shown on the page ──
    ['What is the AA (Artificial Analysis) Intelligence Index?', 'A single 0-100 score from Artificial Analysis, an independent lab that runs the same evaluations on every model. It blends nine practical tests: real-world work tasks, terminal-based coding, tool use, scientific reasoning, knowledge, and long-context reasoning. Think of it as a general capability rating measured identically for everyone. A 60 is genuinely strong; solid workhorse models land in the mid-40s. It anchors the Reasoning & Knowledge and Chat & UI Quality tabs.'],
    ['What is the AA Agentic Index?', 'A 0-100 zoom-in on autonomous multi-step work: using tools, navigating a terminal, recovering from errors without a human in the loop. It is the primary metric of the Agentic Coding tab because it measures the exact skill bots and automation need. A model can chat beautifully and still score poorly here.'],
    ['What is the AA Coding Index?', 'A 0-100 measure of writing and fixing real code, from AA\'s own coding evaluations. Distinct from the Agentic Index: coding is "can it produce correct code", agentic is "can it complete a whole task on its own". Shown together on the Agentic Coding tab because real coding bots need both.'],
    ['What is LiveBench?', 'A benchmark suite from an academic consortium that refreshes its questions every six months, so models cannot have memorized the answers from training data ("contamination") — a real problem for older benchmarks. Scores are objective right/wrong results, not opinions, and every model runs the same release. We publish the release date we use.'],
    ['What is LiveBench Agentic Coding?', 'LiveBench\'s test of producing working code in JavaScript, TypeScript, and Python inside an agent harness — the model must iterate, run, and fix its own code. It anchors the Agentic Coding tab alongside the AA indices because it measures execution, not just code writing.'],
    ['What is LiveBench Reasoning?', 'Theory-of-mind, spatial, logic-puzzle, and navigation-logic tasks — multi-step "think it through" problems with verifiable answers. Shown on the Reasoning & Knowledge tab; a good proxy for analysis and problem-solving workloads.'],
    ['What is LiveBench Math?', 'Competition and olympiad mathematics plus integral solving. It stresses precise symbolic reasoning where a near-miss is still wrong. Useful when your workload cannot tolerate plausible-but-wrong derivations (financial models, scientific code).'],
    ['What is LiveBench Data Analysis?', 'Joining tables, reformatting tabular data, and tracking events across records — the spreadsheet-and-database skills behind most knowledge-work automation. It anchors the Knowledge Work tab.'],
    ['What is LiveBench Instruction Following?', 'Whether the model does exactly what was asked — paraphrasing under constraints, simplifying without losing meaning, hitting story and summary requirements. The difference between "a good answer" and "the answer you specified"; critical for repeatable workflows.'],
    ['What is LiveBench Language?', 'Wordplay, connections, plot reconstruction, and typo detection — precision with language itself rather than world knowledge. Complements instruction following on the Knowledge Work tab.'],
    ['What is Design Arena?', 'A head-to-head vote: two models build a website or UI from the same prompt, humans pick the better result, and Elo scores accumulate like chess ratings. Around 1300 is decent; 1450+ is excellent. It anchors the Chat & UI Quality tab and appears on Agentic Coding because frontend output quality is part of shipping. The model detail view also shows each model\'s best category (website, 3D, dataviz, and so on).'],
    // ── Reading the page ──
    ['What does "From $/M" mean on the benchmarks page?', 'The cheapest price for that model across tracked providers, as a blended rate per million tokens at the token mix from the Text calculator (cached-heavy by default). The benchmarks page recomputes this live from the mix you last used on the Text tab, since the cheapest provider can change with the mix.'],
    ['What is the Value column?', 'Capability per dollar: the tab\'s primary score divided by the blended price, scaled so the best model in the current view equals 100. It answers "if I do not need the absolute best, what gives me the most capability per cent?" It is a relative ranking within the current tab and filters, not an absolute measure, and it is never compared across tabs.'],
    ['Why do some models show "—" in certain columns?', 'No one has published that benchmark for that model yet, or the evaluation is newer than our data. New models typically receive scores within days to weeks of release. Only models purchasable through a tracked provider are listed — a score without a price cannot be comparison-shopped.'],
    ['Which benchmark should I look at?', 'Pick the tab closest to your workload: agents or coding bots — Agentic Coding; analysis, research, or reasoning — Reasoning & Knowledge; documents, summaries, spreadsheets — Knowledge Work; anything visual — Chat & UI Quality. When two models are within a few points, treat them as tied; price and speed usually decide it.'],
  ];
}

export function chooseFaqItems() {
  return [
    ['How does TokenWatch recommend a model for my use case?', 'Pick one of nine workloads on the Choose page, such as agentic coding, long-context RAG, structured extraction, chat, creative writing, or UI work. Each workload preset sets an assumed token mix, hard requirements (tool calling, structured output, minimum context), benchmark weights, and an absolute quality floor. Models that pass those gates and have at least one confirmed, priced provider receive a benchmark composite score. TokenWatch then shows three picks: best quality (highest composite), best value (a balanced point on the quality-versus-price Pareto frontier, not a score-per-dollar ratio), and cheapest good-enough (the cheapest model whose primary benchmark clears the floor).'],
    ['Why does the model finder recommend open-weight models by default?', 'Open-weight models can be hosted by several competing inference providers, so the same model can be compared on price, speed, uptime, and data policy across hosts. Open-weight status comes from reviewed overrides, then a strict majority of models.dev provider records, then known-closed creator priors; a model with unknown status is excluded rather than guessed. Turn on “Include proprietary models”, or pass include_proprietary=true to the API, to widen the list.'],
    ['How does TokenWatch choose the provider for a recommended model?', 'Providers must first pass the workload gates: required capabilities, minimum context, any ZDR or headquarters constraint you set, known-issue checks, and a computable price at the assumed mix. Eligible providers are then scored on blended price, time to first token (p50), throughput (p50), and uptime, preferring the 30-minute uptime window. Missing measurements are left out and the remaining weights renormalized. Providers whose capability or context metadata is missing are listed as unverified, never ranked. The priority control (balanced, cheapest, fastest, most reliable) changes those provider weights.'],
    ['What does “close call” mean on a recommendation?', 'Every pick and provider rank carries a confidence label from its margin over the runner-up on a 0–100 scale: 10 points or more is stable, 3 to 10 points is moderately stable, and under 3 points is a close call. Treat a close call as a tie and decide on price, speed, policy, or your own evaluation.'],
    ['Why is a model listed under “Not enough benchmark data”?', 'A model must have at least half of its workload’s benchmark weight observed to compete for best quality or best value. Scores from partial evidence are shrunk toward the cohort median, and models below that coverage, or with no scores at all, are listed separately. Missing benchmarks are unknown, not a sign the model is poor.'],
    ['Where does the people’s preference data come from?', 'Creative-writing and chat preference ratings come from the official LMArena leaderboard dataset on Hugging Face (Text Arena overall and creative-writing categories), licensed CC BY 4.0 and refreshed weekly. Creative writing is preference-led: 75% Arena Creative Writing rating plus 25% Artificial Analysis intelligence. Chat picks stay capability-ranked, and the Arena Text favourite is shown separately as the people’s favourite. Ratings are unchanged and matched conservatively to TokenWatch model IDs.'],
    ['Are the workload token mixes based on my traffic?', 'No. Each workload uses an assumed input, cached-input, and output mix so that providers can be priced consistently; the mixes are listed on the methodology page and at /api/v1/use-cases. Weights and floors are documented judgments, not measured truths. Open the calculator with your own mix before committing spend, and verify provider prices and policies.'],
  ];
}

export function renderFaqPage({ modelCount, providerCount }) {
  const path = '/faq/';
  const description = 'Answers about LLM API pricing, cost calculation, choosing an open-weight model and provider for a use case, image and video generation pricing, and what each benchmark actually measures — in plain language.';
  const groups = [
    { id: 'choosing-a-model', title: 'Choosing a model and provider', items: chooseFaqItems() },
    { id: 'text-pricing', title: 'Text & token pricing questions', items: homeFaqItems(modelCount, providerCount) },
    { id: 'image-pricing', title: 'Image generation pricing questions', items: imageFaqItems() },
    { id: 'video-pricing', title: 'Video generation pricing questions', items: videoFaqItems() },
    { id: 'benchmarks', title: 'Benchmarks — what the numbers mean', items: benchFaqItems() },
  ];
  const intro = '    <section class="seo-prose"><p>Looking for a model rather than a price? The <a href="/choose/">open model finder</a> recommends an open-weight model and inference provider for nine workloads; the <a href="/docs/methodology/#recommendations">methodology</a> explains the scoring.</p></section>';
  const body = [intro, ...groups.map((g) => renderFaqSection(g.title, g.items).replace('id="faq"', `id="${g.id}"`))].join('\n');
  const allItems = groups.flatMap((g) => g.items);
  return renderStaticPage({
    title: `LLM API Pricing & Benchmark FAQs | TokenWatch`,
    description,
    canonicalPath: path,
    heading: 'Frequently asked questions',
    subtitle: 'Choosing a model, pricing and cost calculation, image and video generation, and what the benchmarks measure',
    breadcrumbs: [{ name: 'Text pricing', path: '/' }, { name: 'FAQ', path }],
    body,
    structuredData: { '@context': 'https://schema.org', '@graph': [
      faqSchema(allItems),
      breadcrumbSchema([{ name: 'Text pricing', path: '/' }, { name: 'FAQ', path }]),
    ] },
  });
}

// llms.txt — markdown manifest for LLM/agent crawlers (llmstxt.org convention).
export function buildLlmsTxt({ modelCount, providerCount, imageCount, videoCount, generatedAt }) {
  return `# TokenWatch

> Pay-as-you-go LLM API pricing, practical benchmarks, and a use-case model finder that recommends an open-weight model and inference provider for nine workloads: ${modelCount} provider-specific text offerings across ${providerCount} inference providers, ${imageCount} image models, ${videoCount} video models. Text catalog generated ${generatedAt}.

TokenWatch compares published provider prices, not a single intrinsic price for each model. One model can have multiple provider, quantization, and endpoint offerings. Each catalog has its own generated_at timestamp; the text timestamp above does not establish image, video, or benchmark freshness.

## Choose a model and provider for a use case

Use this when the question is "which open model should I use for X, and which provider should run it?" rather than "what does model Y cost?".

- [Open model finder](https://tokenwatch.wyrdwerk.com/choose/): pick a workload; get three open-weight picks (best quality, best value on the quality/price Pareto frontier, cheapest model above an absolute quality floor) plus a provider ranking with reasons, caveats, and confidence (stable / moderately stable / close call). A priority control re-weights providers for balanced, cheapest, fastest, or most-reliable.
- Deep links preselect a workload with \`?useCase=<id>\`:
${Object.values(USE_CASES).map((useCase) => `  - ${useCase.label}: https://tokenwatch.wyrdwerk.com/choose/?useCase=${useCase.id}`).join('\n')}
- Creative writing is led by LMArena Creative Writing preference ratings; chat keeps capability-ranked picks and shows a separate people's favourite from Arena Text. Arena data: LMArena leaderboard dataset (https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), CC BY 4.0 — attribute ratings when you repeat them.
- API: [use-case presets](https://tokenwatch.wyrdwerk.com/api/v1/use-cases) (assumed mixes, weights, requirements, floors); [model recommendations](https://tokenwatch.wyrdwerk.com/api/v1/recommend?use_case=agentic-coding&pretty=1) (\`use_case\` required; optional \`priority\`, \`zdr\`, \`exclude_hq\`, \`include_proprietary\`, \`detail\`, \`limit\`, \`pretty\`); [provider ranking for one model](https://tokenwatch.wyrdwerk.com/api/v1/recommend/providers?use_case=agentic-coding&model=glm-5.3&pretty=1) (adds required \`model\`, a canonical ID).
- WebMCP: on the text calculator page, \`recommend_model\` and \`recommend_provider\` call the same engine without changing the table. See the [operating skill](https://tokenwatch.wyrdwerk.com/skill.md).
- Limits: token mixes are assumed per workload, not measured from your traffic; benchmark and provider weights are documented judgments; provider headquarters, telemetry, and capability metadata are incomplete, so unknowns stay unknown and unverified providers are never ranked. See the [methodology](https://tokenwatch.wyrdwerk.com/docs/methodology/#recommendations).

## Pages

- [Open model finder](https://tokenwatch.wyrdwerk.com/choose/): open-weight model and provider recommendations for nine workloads
- [Text pricing calculator](https://tokenwatch.wyrdwerk.com/): compare per-token prices across providers; enter a token mix or budget to compute costs
- [Image generation pricing](https://tokenwatch.wyrdwerk.com/image): per-image, per-megapixel, and image-token units kept separate
- [Video generation pricing](https://tokenwatch.wyrdwerk.com/video): per-second rates by resolution and audio mode
- [Benchmarks by use case](https://tokenwatch.wyrdwerk.com/benchmarks): agentic coding, reasoning, knowledge work, and UI quality scores joined to cheapest-provider blended pricing
- [Model comparison directory](https://tokenwatch.wyrdwerk.com/models/): established canonical model comparisons with current catalog coverage; batch variants are excluded and quantized IDs remain distinct
- [Provider directory](https://tokenwatch.wyrdwerk.com/providers/): reviewed policy links and per-provider text, image, and video catalogs
- [Methodology](https://tokenwatch.wyrdwerk.com/docs/methodology/): sourcing, normalization, dedup, and cost-calculation rules
- [API docs](https://tokenwatch.wyrdwerk.com/docs/api/): queryable JSON endpoints for all catalogs
- [FAQ](https://tokenwatch.wyrdwerk.com/faq/): choosing a model, pricing, image/video billing, and plain-language benchmark explainers
- [WebMCP operating skill](https://tokenwatch.wyrdwerk.com/skill.md): how agents should operate the in-page catalog tools

## API

- [API endpoint directory](https://tokenwatch.wyrdwerk.com/api/v1/): models, providers, orgs, stats, images, videos, use cases, and recommendations (no auth, CORS enabled)
- [OpenAPI specification](https://tokenwatch.wyrdwerk.com/openapi.json): endpoint paths, query parameters, response schemas, and error responses
- For a model's provider comparison, use /api/v1/models/:canonicalId/providers. Use canonical IDs from the catalog, not display names. Send a mix explicitly when comparing a non-default workload; the API docs describe tokens and mix units.
- Price history is optional. A history endpoint can return 503 when storage is not enabled; missing history is not a zero price.

## Data notes

- Text prices are USD per million tokens. Image prices use per-image, per-megapixel, or image-token units; video prices use USD per output second. Do not rank incompatible units or resolutions as equivalent.
- Direct-provider APIs take precedence, then OpenRouter de-aggregated endpoint data, then maintained fallbacks. Verify current rates and billing conditions with the provider before committing spend.
- Established comparison URLs remain available when provider/model coverage drops. Pages without current priced offerings say so explicitly. Missing coverage is not a zero price or proof of retirement; use the current catalog and provider sources, not old quotes.
- Static text comparisons use 2.5% input, 97% cached input, 0.5% output. The interactive calculator and benchmarks can use the visitor's saved mix, so the cheapest provider can change. Cite the workload and data date with a price comparison.
- Fresh-input estimates honor an explicit pricing.input_billing='cache_write' rule, even when the write rate is lower than input. A missing explicit write rate makes fresh-input workloads unpriceable. Otherwise a higher finite positive write rate is used, or normal input applies. Cached reads use cache_read or the original input rate. No separate write charge is added; cache-storage charges are excluded. This is an estimate, not an exact invoice.
- Benchmark scores come from Artificial Analysis, LiveBench, and Design Arena; they measure models, not providers. "From $/M" is workload-specific blended pricing, not the raw input tariff. Missing benchmark or performance measurements are unknown, not zero.
- ZDR and other policy fields reflect endpoint data or reviewed provider metadata. Missing fields do not establish a privacy guarantee; consult the provider's current policy and the methodology.
`;
}

/** Principles the catalog and calculator never break. Rendered on the homepage
 *  strip and the methodology page; each line must stay true to the pipeline. */
export const RULES = [
  ['Unknown stays unknown', 'An unpublished price shows as “—”, never as $0. Missing privacy metadata is not a privacy claim.'],
  ['Zero is not free', 'Zero-priced placeholders and :free routes are dropped, never shown as a free offering.'],
  ['Promos are labelled', 'Discounted prices always carry a promo badge, so a sale is never mistaken for the regular rate.'],
  ['Published rates stay raw', 'We normalize units to $/M but never edit a provider’s rate; estimates are computed on top.'],
  ['The provider’s own price wins', 'A direct provider API outranks aggregators and resellers for the same offering.'],
  ['Estimates, not invoices', 'Costs use your stated token mix; cache-storage charges and taxes are excluded.'],
];

export function renderRulesList(tag = 'ul') {
  return `<${tag} class="tw-rules-list">\n${RULES.map(([title, body]) => `        <li><strong>${esc(title)}.</strong> ${esc(body)}</li>`).join('\n')}\n      </${tag}>`;
}

/** Homepage "Rules we don't bend" strip. */
export function renderRulesStrip() {
  return `<section class="tw-rules" aria-labelledby="rules-title">
      <h2 id="rules-title">Rules we don’t bend</h2>
      ${renderRulesList()}
      <p class="tw-rules-more"><a href="/docs/methodology/#rules">How these rules shape the data</a></p>
    </section>`;
}

const BENCHMARK_LABELS = {
  intelligence_index: 'AA intelligence', coding_index: 'AA coding', agentic_index: 'AA agentic',
  design_arena_best: 'Design Arena', arena_text: 'Arena Text', arena_creative_writing: 'Arena Creative Writing',
  livebench_math: 'LiveBench math', livebench_coding: 'LiveBench coding', livebench_language: 'LiveBench language',
  livebench_data_analysis: 'LiveBench data analysis', livebench_agentic_coding: 'LiveBench agentic coding',
  livebench_reasoning: 'LiveBench reasoning', livebench_instruction_following: 'LiveBench instruction following',
};

function percentLabel(weight) {
  return `${Math.round(weight * 100)}%`;
}

function recommendationPresetRows() {
  return Object.values(USE_CASES).map((useCase) => {
    const { mix, hardRequirements: req, benchmarkWeights, qualityFloor } = useCase;
    const requirements = [
      req.needsToolCalling ? 'tool calling' : null,
      req.needsStructuredOutput ? 'structured output' : null,
      req.minContext ? `≥${Math.round(req.minContext / 1024)}K context` : null,
    ].filter(Boolean).join(', ');
    const weights = Object.entries(benchmarkWeights)
      .map(([field, weight]) => `${BENCHMARK_LABELS[field] || field} ${percentLabel(weight)}`).join(', ');
    const floor = `${BENCHMARK_LABELS[qualityFloor.field] || qualityFloor.field} ≥ ${qualityFloor.min}`;
    const pw = useCase.providerWeights;
    const providerWeights = [pw.price, pw.ttft, pw.throughput, pw.uptime].map(percentLabel).join(' / ');
    return `<tr><td><a href="/choose/?useCase=${esc(useCase.id)}">${esc(useCase.label)}</a></td><td>${mix.inputPct}% / ${mix.cacheReadPct}% / ${mix.outputPct}%</td><td>${esc(requirements)}</td><td>${esc(weights)}</td><td>${esc(providerWeights)}</td><td>${esc(floor)}</td></tr>`;
  }).join('');
}

function priorityPresetRows() {
  return Object.entries(PRIORITY_PROVIDER_WEIGHTS).map(([priority, weights]) => weights
    ? `<tr><td>${esc(priority)}</td><td class="num">${percentLabel(weights.price)}</td><td class="num">${percentLabel(weights.ttft)}</td><td class="num">${percentLabel(weights.throughput)}</td><td class="num">${percentLabel(weights.uptime)}</td></tr>`
    : `<tr><td>${esc(priority)}</td><td colspan="4">Workload’s own provider weights</td></tr>`).join('');
}

export function renderMethodologyPage({ modelCount, providerCount, generatedAt, models = [], linkedModelPages = new Map(), arenaSource = {} }) {
  const path = '/docs/methodology/';
  const description = 'How TokenWatch sources, normalizes, deduplicates, enriches, and compares pay-as-you-go AI inference pricing, and how it recommends open-weight models and providers for a workload.';
  const workloadRows = [
    ['Cache-heavy agents', AGENTIC_MIX],
    ['Uncached retrieval/RAG', { inputPct: 80, cacheReadPct: 0, outputPct: 20 }],
    ['Balanced uncached', { inputPct: 50, cacheReadPct: 0, outputPct: 50 }],
    ['Output-heavy generation', { inputPct: 10, cacheReadPct: 0, outputPct: 90 }],
  ].map(([name, mix]) => {
    const cheapest = models.filter((m) => m.pricing && (m.pricing.input > 0 || m.pricing.output > 0))
      .map((m) => ({ m, eff: blendedRate(m.pricing, mix) }))
      .filter(({ eff }) => Number.isFinite(eff) && eff > 0)
      .sort((a, b) => a.eff - b.eff)[0];
    if (!cheapest) return '';
    const slug = linkedModelPages.get(canonicalId(cheapest.m.id));
    const label = esc(displayName(cheapest.m));
    const model = slug ? `<a href="/models/${esc(slug)}/">${label}</a>` : label;
    return `<tr><td>${esc(name)}</td><td>${mix.inputPct}% / ${mix.cacheReadPct}% / ${mix.outputPct}%</td><td>${model}</td><td>${esc(cheapest.m.provider)}</td><td class="num">${fmtPrice(cheapest.eff)}</td></tr>`;
  }).join('\n');
  const arenaUrl = arenaSource.url || 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset';
  const arenaLicenseUrl = arenaSource.license_url || 'https://creativecommons.org/licenses/by/4.0/';
  const arenaLicense = arenaSource.license || 'CC-BY-4.0';
  const arenaAttribution = arenaSource.attribution
    || 'Arena (LMArena), Leaderboard Dataset; ratings are unchanged and matched conservatively to TokenWatch canonical IDs.';
  const arenaTextDate = arenaSource.rating_dates?.arena_text || 'not reported';
  const arenaCreativeDate = arenaSource.rating_dates?.arena_creative_writing || 'not reported';
  const body = `    <article class="seo-prose">
      <h2 id="rules">Rules we don’t bend</h2>
      ${renderRulesList()}
      <h2>How TokenWatch builds a comparable catalog</h2>
      <p>The current text catalog contains ${modelCount} provider-specific offerings across ${providerCount} inference providers. Its source timestamp is <time datetime="${esc(generatedAt)}">${esc(generatedAt)}</time>.</p>
      <p>An offering is a model-and-provider combination, not a unique model. Quantization and endpoint variants remain distinct. See the <a href="/models/">model directory</a> for comparisons across providers.</p>
      <h2>Source order</h2>
      <p>Direct provider APIs are the first source because a provider is authoritative for its own prices. OpenRouter endpoint data comes next and is split into provider-specific rows. CSV and maintained fallback records fill gaps after live sources.</p>
      <p>Inspect the <a href="/pricing.json">text catalog</a>, <a href="/image-pricing.json">image catalog</a>, and <a href="/video-pricing.json">video catalog</a> for published rates and each catalog's own generation timestamp. The <a href="https://github.com/WyrdWerk/tokenwatch/blob/main/scripts/fetch-pricing.mjs">text fetcher</a> and <a href="https://github.com/WyrdWerk/tokenwatch/blob/main/scripts/fetch-fal.mjs">fal.ai fetcher</a> document the provider source URLs and fallback records. Image/video coverage also uses <a href="https://openrouter.ai/">OpenRouter</a> and <a href="https://fal.ai/models">fal.ai</a>.</p>
      <h2>Price normalization</h2>
      <p>Text prices are stored as US dollars per million tokens. Sources quoted per token are multiplied by one million; Wafer cents-per-million values are divided by 100. Image prices keep their native flat-image, megapixel, or image-token units. Video prices are normalized to dollars per second.</p>
      <h2>Model identity and provider precedence</h2>
      <p>The deduplication key combines a canonical model ID with a normalized provider. Provider prefixes, dated aliases, and selected routing suffixes can normalize to one identity. Quantization suffixes remain part of the key, so FP8, NVFP4, and INT4 rows stay separate.</p>
      <h2>Cost calculations</h2>
      <p>Blended $/M and total cost use the same input, cached-input, and output percentages. A provider's explicit default cache-write billing rule takes precedence, even when its write tariff is lower than input; a missing explicit tariff makes fresh-input workloads unpriceable. Without that rule, fresh input uses a finite positive cache-write rate only when higher than normal input pricing; otherwise normal input applies. Cached reads use the published cache-read price or the original input rate. There is no separate write charge. Additional cache-storage charges are excluded, so this simplified estimate is not an exact bill.</p>
      <h2>Why the cheapest offering depends on the workload</h2>
      <p>These illustrative token mixes are not measured averages or quality recommendations. Retrieval-augmented generation (RAG) supplies retrieved context as input; caching that context can change the ranking. Each row below selects the lowest positive computable blended rate in this text snapshot, not necessarily a model capable of your task. Free/unpriced offerings are excluded. Promotions can affect the result.</p>
      ${workloadRows ? `<div class="table-wrap"><table><caption>Illustrative workload costs — USD per million total tokens, snapshot ${esc(generatedAt)}</caption><thead><tr><th scope="col">Example workload</th><th scope="col">Input / cached / output</th><th scope="col">Lowest-cost offering</th><th scope="col">Provider</th><th scope="col">Blended $/M</th></tr></thead><tbody>${workloadRows}</tbody></table></div>` : ''}
      <p>For one million total tokens, cost is input rate × input share + cache-read rate × cached share + output rate × output share, using the fresh-input rule above. Monthly Volume multiplies an entered daily volume by 30. Retries, tool calls, storage, tax, and other charges need separate consideration. Use the <a href="/">calculator</a> to compare suitable models at your own mix; a 97% cached mix is inappropriate when you cannot reuse most input.</p>
      <h2 id="recommendations">How recommendations work</h2>
      <p>The <a href="/choose/">open model finder</a>, the <a href="/docs/api/">recommendation API</a>, and the WebMCP <code>recommend_model</code>/<code>recommend_provider</code> tools share one engine. It answers “which open-weight model suits this workload, and which provider should run it?” for nine workload presets. It ranks candidates from this catalog snapshot; it is not a universal best-model score.</p>
      <h3>Workload presets</h3>
      <p>Each preset defines an assumed token mix, hard requirements, benchmark weights, provider weights, a quantization policy, and an absolute quality floor on its primary benchmark. The mixes price providers consistently; they are not measurements of your traffic. Weights and floors are documented judgments, calibrated against the 2026-10-04 catalog snapshot.</p>
      <div class="table-wrap"><table><caption>Recommendation workload presets</caption><thead><tr><th scope="col">Workload</th><th scope="col">Assumed input / cached / output</th><th scope="col">Requirements</th><th scope="col">Benchmark weights</th><th scope="col">Provider weights (price / TTFT / throughput / uptime)</th><th scope="col">Quality floor</th></tr></thead><tbody>${recommendationPresetRows()}</tbody></table></div>
      <h3>Eligibility gates</h3>
      <p>By default only offerings with resolved open weights are considered. Open-weight status comes from reviewed overrides, then a strict majority of models.dev provider records, then known-closed creator priors; unknown status is excluded, not guessed. Subscription offerings are excluded, and <code>:batch</code> variants are excluded except for high-volume work. A provider must pass the workload’s tool-calling, structured-output, and minimum-context requirements, any ZDR or headquarters constraint the visitor sets, and known-issue checks (<em>broken</em> or <em>unavailable</em> blocks; <em>degraded</em> warns), and it must have a computable price at the assumed mix. An endpoint’s published parameter list is authoritative for capabilities; models.dev flags are used only when it is absent. Providers missing required capability or context metadata are listed as unverified and never enter the ranking. Low-bit quantizations (fp4, nvfp4, mxfp4, int4) are rejected for demanding workloads when a higher-precision provider qualifies, and the fallback is stated when none does.</p>
      <h3>Quality score and coverage rule</h3>
      <p>Each benchmark is converted to a percentile among eligible canonical models, and the available weighted percentiles are averaged on a 0–100 scale. The composite is then shrunk toward the cohort median in proportion to the benchmark weight that is missing. A model needs at least ${Math.round(MIN_BENCHMARK_COVERAGE * 100)}% of its workload’s benchmark weight observed to compete for best quality or best value; models below that coverage, or with no scores, are shown separately as not having enough benchmark data. Benchmark scores are relative within a workload; only the floor is absolute.</p>
      <h3>The three picks</h3>
      <ul>
        <li><strong>Best quality</strong> — the highest composite score among coverage-eligible models.</li>
        <li><strong>Best value</strong> — chosen from the non-dominated frontier of quality versus cheapest blended price, as the point closest to the ideal after normalizing both axes. It is never a raw score-per-dollar ratio, which would let cheap weak models win.</li>
        <li><strong>Cheapest good-enough</strong> — the cheapest priced model whose primary benchmark reaches the workload’s absolute floor. It is flagged when it costs more than the best-value pick.</li>
      </ul>
      <h3>Provider ranking and priority presets</h3>
      <p>Eligible providers for a model are scored on blended price at the assumed mix, time to first token (p50), throughput (p50), and uptime (the 30-minute window is preferred to the one-day window). Each metric is scaled against the other eligible providers; missing measurements are omitted and the remaining weights renormalized, so a missing metric is never treated as zero. <em>Balanced</em> uses the workload’s own provider weights; the other priority presets replace them:</p>
      <div class="table-wrap"><table><caption>Provider priority presets</caption><thead><tr><th scope="col">Priority</th><th scope="col" class="num">Price</th><th scope="col" class="num">TTFT</th><th scope="col" class="num">Throughput</th><th scope="col" class="num">Uptime</th></tr></thead><tbody>${priorityPresetRows()}</tbody></table></div>
      <h3>Confidence</h3>
      <p>Every pick and provider rank reports its margin over the runner-up on a 0–100 scale: at least 10 points is <em>stable</em>, 3 to 10 points is <em>moderately stable</em>, and under 3 points is a <em>close call</em>. Best quality compares quality scores; best value compares distance to the Pareto ideal; cheapest good-enough compares relative blended cost. A close call should be read as a tie. A local sensitivity script perturbs one weight, floor, or mix at a time to check how often each default pick changes; it is a robustness screen, not a probability.</p>
      <h3>Arena preference ratings</h3>
      <p>Creative-writing recommendations use Arena Creative Writing ratings as their primary preference signal (75%), with Artificial Analysis intelligence as a secondary capability signal (25%). Chat recommendations keep benchmark capability as the pick ranking and expose Arena Text overall as a separate people’s preference ranking. Ratings come from the <a href="${esc(arenaUrl)}">LMArena leaderboard dataset</a>; ${esc(arenaAttribution)} Licensed under <a href="${esc(arenaLicenseUrl)}">${esc(arenaLicense.replaceAll('-', ' '))}</a>. Text overall ratings are dated ${esc(arenaTextDate)}; Creative Writing ratings are dated ${esc(arenaCreativeDate)}. Ratings are a snapshot of pairwise preference, not a universal measure of model quality.</p>
      <h3>Known limitations</h3>
      <p>Token mixes are assumed per workload. Benchmark and provider weights are judgment-based, and percentiles shift as the catalog changes. Some benchmark sets are thin (several LiveBench categories cover only a handful of open models), and Arena ratings match only part of the open-weight catalog. Provider headquarters, latency, throughput, uptime, and capability metadata are incomplete: excluding a country removes only providers whose headquarters is known, and unverified providers are not ranked. Recommendations exclude subscription plans, cache-storage charges, and taxes. The design is recorded in <a href="https://github.com/WyrdWerk/tokenwatch/blob/main/docs/adr/0012-recommender-scoring.md">ADR 0012</a>, with a dated comparison against outside leaderboards in the <a href="https://github.com/WyrdWerk/tokenwatch/blob/main/docs/research/recommender-validation.md">validation notes</a>.</p>
      <h2>Privacy and policy data</h2>
      <p>ZDR tags come from endpoint-level OpenRouter data or reviewed provider metadata. Missing metadata does not become a positive or negative privacy claim. Provider pages link to reviewed policies when TokenWatch has them.</p>
      <h2>Benchmarks and performance</h2>
      <p>Quality indices and design-arena scores are sidecar enrichment, not prices. Variant matching is conservative to reduce false attribution. Throughput is displayed separately because speed, quality, context limits, and cost answer different questions.</p>
      <h2>Known limits</h2>
      <p>Provider catalogs can change between refreshes. Promotions may expire, regional prices may differ, and unpublished cache prices are unknown rather than zero. Treat TokenWatch as a comparison and estimation tool, then confirm a shortlisted provider's current terms.</p>
      <h2>Maintainer and corrections</h2>
      <p>TokenWatch is an open-source project by <a href="https://wyrdwerk.com">WyrdWerk</a>, maintained by <a href="https://www.linkedin.com/in/yash-jain-65295511b/">Yash Jain</a>. Pricing tables rank by published rates and the stated workload, not by subscription badges. Report stale prices, incorrect model identities, or policy corrections through <a href="https://github.com/WyrdWerk/tokenwatch/issues">GitHub issues</a>, with the affected offering, source URL, and observation date. Do not include API keys or private prompts.</p>
    </article>`;
  return renderStaticPage({
    title: 'LLM API Pricing Methodology & Data Sources | TokenWatch',
    description,
    canonicalPath: path,
    heading: 'Pricing methodology and data sources',
    subtitle: 'How provider-specific prices become comparable TokenWatch records',
    breadcrumbs: [{ name: 'Text pricing', path: '/' }, { name: 'Methodology', path }],
    body,
    structuredData: { '@context': 'https://schema.org', '@graph': [{ '@type': 'TechArticle', url: SITE + path, headline: 'TokenWatch pricing methodology and data sources', description, author: { '@type': 'Person', name: 'Yash Jain', url: 'https://www.linkedin.com/in/yash-jain-65295511b/' }, publisher: { '@type': 'Organization', name: 'WyrdWerk', url: 'https://wyrdwerk.com' } }, breadcrumbSchema([{ name: 'Text pricing', path: '/' }, { name: 'Methodology', path }])] },
  });
}

export function renderApiDocsPage() {
  const path = '/docs/api/';
  const description = 'Query TokenWatch text, image, video, provider, organization, catalog statistics, and workload-aware model recommendations through the public JSON API.';
  const rows = API_ENDPOINTS.map((endpoint) => `<tr><td><code>${esc(endpoint.path)}</code></td><td>${esc(endpoint.summary)}</td><td>${endpoint.params.length ? endpoint.params.map((param) => `<code>${esc(param)}</code>`).join(', ') : '—'}</td><td>${endpoint.sort.length ? endpoint.sort.map((sort) => `<code>${esc(sort)}</code>`).join(', ') : '—'}</td></tr>`).join('\n');
  const body = `    <article class="seo-prose">
      <h2>Public JSON API</h2>
      <p>All endpoints accept GET requests and return JSON with permissive CORS headers. List endpoints paginate with <code>limit</code> and <code>offset</code>; the limit is clamped to 1–500 and defaults to 100. A machine-readable <a href="/openapi.json">OpenAPI 3.1 description</a> is also available.</p>
      <p>Recommendation mixes are assumed workload defaults, not claims about your traffic. Model picks include best quality, best value, and the cheapest model above an absolute quality floor; explanations label benchmark coverage, provider ranking, missing signals, and confidence. Provider ranking requires confirmed capability and context metadata and keeps unverified options separate.</p>
      <p>For <code>chat-assistant</code> and <code>creative-writing</code>, <code>/api/v1/recommend</code> also returns <code>preference</code> separately from model picks: the Arena favorite, board, rating, eligible providers, and <code>source</code> metadata with linked dataset, rating date, attribution, and CC BY 4.0 license. Creative writing is preference-led; chat picks remain capability-ranked. The source metadata lets API consumers display the required attribution alongside Arena ratings.</p>
      <p>Recommendation responses default to compact candidate groups (up to 10 rows each, with total counts) and full explanations on the three model picks. Provider results keep full explanations on the top three. Add <code>detail=full</code> to expand explanations for returned rows, or set <code>limit=1..100</code> to change each group cap. Recommendation JSON is compact (no indentation); add <code>pretty=1</code> for indented output.</p>
      <h2 id="recommendation-parameters">Recommendation parameters</h2>
      <p>The recommendation endpoints power the <a href="/choose/">open model finder</a>. Unknown values return HTTP 400 naming the rejected <code>parameter</code>; an unknown <code>model</code> returns 404.</p>
      <ul>
        <li><code>use_case</code> (required): ${Object.keys(USE_CASES).map((id) => `<code>${esc(id)}</code>`).join(', ')}.</li>
        <li><code>model</code> (required for <code>/api/v1/recommend/providers</code>): a canonical model ID from the catalog.</li>
        <li><code>priority</code>: ${Object.keys(PRIORITY_PROVIDER_WEIGHTS).map((id) => `<code>${esc(id)}</code>`).join(', ')} (default <code>balanced</code>); re-weights provider ranking.</li>
        <li><code>zdr=true</code>: only providers marked zero data retention.</li>
        <li><code>exclude_hq</code>: comma-separated two-letter headquarters country codes to exclude; providers with unknown headquarters are not excluded.</li>
        <li><code>include_proprietary=true</code>: also consider models not confirmed open-weight.</li>
        <li><code>detail</code>: <code>compact</code> (default) or <code>full</code>; <code>limit</code>: rows per group, 1–100 (default 10); <code>pretty=1</code>: indented JSON.</li>
      </ul>
      <div class="table-wrap"><table><caption>TokenWatch API endpoints</caption><thead><tr><th scope="col">Endpoint</th><th scope="col">Response</th><th scope="col">Query parameters</th><th scope="col">Sort values</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h2>Examples</h2>
      <pre><code>curl '${SITE}/api/v1/models?provider=aster&amp;sort=input&amp;limit=20'
curl '${SITE}/api/v1/models?open_weights=true&amp;limit=20'
curl '${SITE}/api/v1/models/glm-5.2/providers?tokens=1000000&amp;mix=30,50,20'
curl '${SITE}/api/v1/use-cases'
curl '${SITE}/api/v1/recommend?use_case=agentic-coding&amp;priority=balanced&amp;zdr=true&amp;exclude_hq=CN&amp;limit=5'
curl '${SITE}/api/v1/recommend/providers?use_case=agentic-coding&amp;model=deepseek-v4-flash&amp;priority=fastest&amp;detail=full'
curl '${SITE}/api/v1/providers?zdr=true'
curl '${SITE}/api/v1/videos?provider=fal&amp;limit=25'</code></pre>
      <h2>Errors and freshness</h2>
      <p>Malformed model-ID encoding returns HTTP 400, unknown routes return 404, and unavailable catalog assets return 503. Every catalog response includes its source generation timestamp. Raw API and JSON files are marked noindex; this page is the crawlable reference.</p>
      <h2>Embeddable pricing cards</h2>
      <p>The <a href="/widget/demo.html">widget demo</a> shows the Shadow DOM pricing card. Add <code>data-tw-model</code> to an element and load <code>${SITE}/widget/embed.js</code>.</p>
    </article>`;
  return renderStaticPage({
    title: 'TokenWatch API Documentation — LLM Pricing JSON API',
    description,
    canonicalPath: path,
    heading: 'TokenWatch API documentation',
    subtitle: 'Public JSON endpoints for pricing catalogs and workload-aware recommendations',
    breadcrumbs: [{ name: 'Text pricing', path: '/' }, { name: 'API documentation', path }],
    body,
    structuredData: { '@context': 'https://schema.org', '@graph': [{ '@type': 'TechArticle', url: SITE + path, headline: 'TokenWatch API documentation', description }, breadcrumbSchema([{ name: 'Text pricing', path: '/' }, { name: 'API documentation', path }])] },
  });
}

const BOOLEAN_API_PARAMS = new Set(['cache_read', 'cache_write', 'promo', 'zdr', 'sub', 'benchmarked', 'open_weights', 'include_proprietary']);
const INTEGER_API_PARAMS = new Set(['limit', 'offset']);
const NUMBER_API_PARAMS = new Set(['min_context', 'min_output', 'min_intelligence', 'tokens']);

function openApiParameter(name, required = false, parameterLimits = {}) {
  let schema = BOOLEAN_API_PARAMS.has(name)
    ? { type: 'boolean' }
    : INTEGER_API_PARAMS.has(name)
      ? { type: 'integer', minimum: name === 'limit' ? 1 : 0, maximum: name === 'limit' ? (parameterLimits.limit ?? 500) : undefined }
      : NUMBER_API_PARAMS.has(name)
        ? { type: 'number', minimum: 0 }
        : { type: 'string' };
  if (name === 'use_case') schema = { type: 'string', enum: Object.keys(USE_CASES) };
  if (name === 'priority') schema = { type: 'string', enum: Object.keys(PRIORITY_PROVIDER_WEIGHTS) };
  if (name === 'exclude_hq') schema = { type: 'string', pattern: '^[A-Za-z]{2}(,[A-Za-z]{2})*$' };
  if (name === 'detail') schema = { type: 'string', enum: ['compact', 'full'], default: 'compact' };
  if (name === 'pretty') schema = { type: 'string', enum: ['1', '0', 'true', 'false'], default: '0' };
  if (name === 'limit' && parameterLimits.limit) schema.default = 10;
  if (schema.maximum === undefined) delete schema.maximum;
  return {
    name,
    in: 'query',
    required,
    description: name === 'mix'
      ? 'Comma-separated input, cached-input, and output percentages.'
      : name === 'open_weights'
        ? 'Filter to models with resolved open_weights=true or false; unknown statuses are excluded.'
        : name === 'use_case'
          ? 'Required workload preset id. See /api/v1/use-cases for assumed mixes, weights, requirements, and quality floors.'
          : name === 'priority'
            ? 'Provider-rank weighting preset; defaults to balanced.'
            : name === 'exclude_hq'
              ? 'Comma-separated two-letter headquarters country codes to exclude; providers with unknown headquarters are not excluded.'
              : name === 'include_proprietary'
                ? 'Include models not confirmed open-weight; defaults to false for model recommendations.'
                : name === 'model'
                  ? 'Required canonical model id. An unknown model returns 404.'
                  : name === 'zdr'
                    ? 'Set to true to keep only offerings or providers marked zero data retention.'
                  : name === 'pretty'
                    ? 'Set to 1 for indented JSON; responses are compact (unindented) by default.'
                  : name === 'detail'
                    ? 'Defaults to compact; full returns explanations for all returned rows.'
                    : name === 'limit'
                      ? parameterLimits.limit
                        ? `Maximum rows per recommendation group; defaults to 10 (range 1–${parameterLimits.limit}).`
                        : 'Page size; defaults to 100 and is clamped to 1–500.'
                  : `Filter or control parameter: ${name}.`,
    schema,
  };
}

/** Build the published API contract from the endpoint metadata that powers the docs and API directory. */
export function buildOpenApiDocument() {
  const paths = {};
  for (const endpoint of API_ENDPOINTS) {
    const path = endpoint.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
    const pathParams = [...endpoint.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      description: `Canonical resource identifier: ${match[1]}.`,
      schema: { type: 'string' },
    }));
    paths[path] = {
      get: {
        summary: endpoint.summary,
        ...(endpoint.description ? { description: endpoint.description } : {}),
        operationId: `get${endpoint.path.split('/').filter(Boolean).map((segment) => segment.replace(/^:/, '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('')).join('') || 'ApiDirectory'}`,
        parameters: [...pathParams, ...endpoint.params.map((name) => openApiParameter(name, endpoint.requiredParams?.includes(name) === true, endpoint.parameterLimits))],
        responses: {
          200: {
            description: endpoint.path === '/api/v1/recommend'
              ? 'Successful JSON response. Chat and creative-writing include Arena preference.favorite and source attribution/date/license metadata in preference.source.'
              : 'Successful JSON response.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          400: { description: 'Invalid request parameter or malformed model ID.', content: { 'application/json': { schema: { type: 'object' } } } },
          404: { description: 'Unknown API route or resource.', content: { 'application/json': { schema: { type: 'object' } } } },
          503: { description: 'A required catalog asset is unavailable.', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'TokenWatch Pricing API',
      version: 'v1',
      description: 'Read-only, public JSON API for TokenWatch text, image, video, provider, organization, pricing catalog data, and workload-aware recommendations.',
    },
    servers: [{ url: SITE }],
    paths,
  };
}

export function renderExploreLinks() {
  return `    <section class="seo-links" aria-label="Explore TokenWatch"><h2>Explore TokenWatch data</h2><p><a href="/choose/">Find an open model for your use case</a> · <a href="/benchmarks">Compare benchmarks by use case</a> · <a href="/models/">Compare models across providers</a> · <a href="/providers/">Browse inference providers</a> · <a href="/docs/methodology/">Read the pricing methodology</a> · <a href="/docs/api/">Use the pricing API</a> · <a href="/faq/">Read the FAQ</a></p></section>`;
}

// Crawlable top-models table for /benchmarks — the page's interactive table is
// client-rendered, so crawlers (and no-JS visitors) need a static snapshot.
// Ranked by AA intelligence (fallback: LiveBench reasoning), with scores from
// every source and the cheapest-provider blended price at the default mix.
export function renderBenchmarksSeoSection(bench, linkedModelPages = new Map()) {
  const ranked = [...bench.models]
    .filter((m) => m.scores.aa_intelligence != null || m.scores.livebench_reasoning != null)
    .sort((a, b) =>
      (b.scores.aa_intelligence ?? b.scores.livebench_reasoning ?? -1) -
      (a.scores.aa_intelligence ?? a.scores.livebench_reasoning ?? -1))
    .slice(0, 25);
  const fmt = (v) => (v == null ? '—' : String(Math.round(v * 10) / 10));
  const rows = ranked.map((m) => {
    const slug = linkedModelPages.get(canonicalId(m.id));
    const model = slug ? `<a href="/models/${esc(slug)}/">${esc(m.name)}</a>` : esc(m.name);
    return `          <tr><td>${model}</td><td>${esc(m.org || '—')}</td><td>${fmt(m.scores.aa_intelligence)}</td><td>${fmt(m.scores.aa_agentic)}</td><td>${fmt(m.scores.aa_coding)}</td><td>${fmt(m.scores.livebench_reasoning)}</td><td>${fmt(m.scores.design_arena_elo)}</td><td>$${m.from.blended_per_m}</td></tr>`;
  }).join('\n');
  return `    <section class="seo-models" id="crawlable-benchmarks" aria-label="Top benchmarked models">
      <h2>Top benchmarked models and their cheapest blended price</h2>
      <p>Snapshot of the 25 highest-ranked models (Artificial Analysis Intelligence Index, ${bench.model_count} benchmarked models total). The interactive table above adds use-case tabs, live token-mix pricing, and capability-per-dollar value ranking.</p>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">Model</th><th scope="col">Creator</th><th scope="col" class="num">AA Intelligence</th><th scope="col" class="num">AA Agentic</th><th scope="col" class="num">AA Coding</th><th scope="col" class="num">LiveBench Reasoning</th><th scope="col" class="num">Design Arena Elo</th><th scope="col" class="num">From $/M</th></tr></thead>
        <tbody>
${rows}
        </tbody></table></div>
      <p class="seo-note">Catalog snapshot <time datetime="${esc(bench.generated_at)}">${esc(bench.generated_at)}</time>. Scores from <a href="https://artificialanalysis.ai/" rel="noopener">Artificial Analysis</a>, <a href="https://livebench.ai/" rel="noopener">LiveBench</a> and <a href="https://www.designarena.ai/" rel="noopener">Design Arena</a>. "From $/M" is the cheapest provider's blended rate at 2.5% input, 97% cached input, 0.5% output. This is a catalog snapshot, not the date every benchmark was measured. See the <a href="/faq/#benchmarks">benchmark FAQ</a> for what each score measures.</p>
    </section>`;
}

export function buildSitemap(entries) {
  const seen = new Set();
  const urls = entries.map((entry) => {
    if (!entry.path?.startsWith('/')) throw new Error(`generate-seo: sitemap path must start with /: ${entry.path}`);
    if (seen.has(entry.path)) throw new Error(`generate-seo: duplicate sitemap path: ${entry.path}`);
    seen.add(entry.path);
    const lastmod = entry.lastmod ? `<lastmod>${escXml(entry.lastmod)}</lastmod>` : '';
    const changefreq = entry.changefreq ? `<changefreq>${escXml(entry.changefreq)}</changefreq>` : '';
    const priority = entry.priority ? `<priority>${escXml(entry.priority)}</priority>` : '';
    return `  <url><loc>${escXml(SITE + entry.path)}</loc>${lastmod}${changefreq}${priority}</url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function buildRobots() {
  // Public data is crawlable so search engines can read response-level noindex.
  // This does not change any crawler-specific AI-training preference.
  return `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;
}
