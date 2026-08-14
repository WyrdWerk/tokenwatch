import { blendedRate, AGENTIC_MIX } from '../shared/cost.mjs';
import { canonicalId } from '../shared/normalize.mjs';
import { API_ENDPOINTS } from '../shared/api-meta.mjs';

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

function renderTextRows(priced) {
  return priced.map(({ m, eff }) => {
    const pricing = m.pricing || {};
    return `      <tr><td>${esc(m.org || m.provider)}</td><td>${esc(m.provider)}</td><td>${esc(displayName(m))}</td><td class="num">${fmtPrice(pricing.input)}</td><td class="num">${fmtPrice(pricing.output)}</td><td class="num">${fmtPrice(pricing.cache_read)}</td><td class="num">${fmtPrice(eff)}</td></tr>`;
  }).join('\n');
}

export function renderSeoTable(priced, lastmod, options = {}) {
  const id = options.id || 'cheapest';
  const title = options.title || 'Cheapest LLM API models right now';
  const intro = options.intro || 'Ranked by effective cost at a typical agentic mix (2.5% input, 97% cached input, 0.5% output). Prices are USD per million tokens. Use the calculator above to compute your exact workload cost.';
  return `    <section class="seo-models" id="${esc(id)}" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>
      <p>${esc(intro)}</p>
      <div class="table-wrap"><table>
        <caption>${esc(title)}</caption>
        <thead><tr><th scope="col">Org</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col" class="num">Input $/M</th><th scope="col" class="num">Output $/M</th><th scope="col" class="num">Cache $/M</th><th scope="col" class="num">Blended $/M</th></tr></thead>
        <tbody>${renderTextRows(priced)}</tbody>
      </table></div>
      <p class="seo-note">Pricing refreshed ${esc(lastmod)} from public provider APIs. Verify prices on the provider's official pricing page before committing spend.</p>
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
    ['What is Blended $/M?', 'Blended $/M combines input, cached-input, and output prices using the selected workload percentages. It is a comparison rate, so it excludes the monthly multiplier and one-time cache-write amortization.'],
    ['How does prompt caching reduce LLM API cost?', 'A provider can charge a lower cache-read rate when repeated prompt content is reused. TokenWatch applies that rate only to the cached-input share you enter.'],
    ['What happens when a provider has no cache-read price?', 'A missing cache-read price is not free usage. TokenWatch falls back to the provider’s normal input rate for the cached-input share unless the source publishes a separate cache price.'],
    ['What is cache-write amortization?', 'Some providers charge once when prompt content enters the cache. Enter the cache-write token amount and spread that charge across the number of requests expected to reuse it.'],
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
  return `    <section class="seo-faq" id="faq" aria-label="Frequently asked questions"><h2>Frequently asked questions</h2><details open><summary>Where are the full FAQ lists?</summary><p>All questions — text/token pricing, image and video generation pricing, and plain-language benchmark explainers — live on the consolidated <a href="/faq/">FAQ page</a>.</p></details></section>`;
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
    : [{ name: 'Text pricing', path: '/' }, { name: `${page[0].toUpperCase()}${page.slice(1)} pricing`, path }];
  const graph = [
    {
      '@type': page === 'text' ? 'WebSite' : 'CollectionPage',
      '@id': SITE + path + '#page',
      url: SITE + path,
      name: title,
      description,
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
      description: 'Interactive LLM API pricing calculator for text, image, and video models.',
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
  const title = `LLM API Pricing Comparison — Compare ${modelCount} Models Across ${providerCount} Providers | TokenWatch`;
  const description = `Know what your AI actually costs before the bill arrives. Compare pay-as-you-go LLM API pricing across ${providerCount} providers and ${modelCount} models — text, image, and video. Enter your token mix or budget and find the cheapest option for your agentic workload.`;
  const subtitle = `Compare pay-as-you-go LLM API pricing across ${providerCount} providers and ${modelCount} models. Enter your token mix or set a budget — see exactly what your agents cost before you commit.`;
  let out = markup.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  out = replaceMetaContent(out, 'name', 'description', description);
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

export function collectProviderPages({ pricing, imagePricing, videoPricing }, minModels = PROVIDER_MIN_MODELS) {
  const providers = new Map();
  const names = new Map((pricing.providers || []).map((provider) => [provider.key, provider.name]));
  const get = (key) => {
    if (!providers.has(key)) providers.set(key, { key, text: [], image: [], video: [] });
    return providers.get(key);
  };
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
    if (identities.size < minModels) continue;
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

function pageNav() {
  return '<nav class="tab-nav" aria-label="TokenWatch sections"><a class="tab-link" href="/">Text</a><a class="tab-link" href="/image">Image</a><a class="tab-link" href="/video">Video</a><a class="tab-link" href="/benchmarks">Benchmarks</a><a class="tab-link" href="/providers/">Providers</a><a class="tab-link" href="/docs/methodology/">Methodology</a><a class="tab-link" href="/docs/api/">API</a><a class="tab-link" href="/faq/">FAQ</a></nav>';
}

function visibleBreadcrumbs(items) {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${items.map((item, index) => `${index ? '<span aria-hidden="true">/</span>' : ''}<a href="${esc(item.path)}">${esc(item.name)}</a>`).join('')}</nav>`;
}

export function renderStaticPage({ title, description, canonicalPath, heading, subtitle, breadcrumbs, body, structuredData }) {
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
  <meta property="og:image" content="${SITE}/og/og-image.svg" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${SITE}/og/og-image.svg" />
  <link rel="preload" href="/fonts/inter-400.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/fonts/space-grotesk-600.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/styles.css?v=dev" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  ${renderJsonLd(structuredData)}
</head>
<body>
  <header><div class="header-row"><a class="brand-link site-brand" href="/" aria-label="TokenWatch home">💰 TokenWatch</a><a class="repo-link" href="https://wyrdwerk.com" target="_blank" rel="noopener">WyrdWerk</a><a class="repo-link" href="https://github.com/WyrdWerk/tokenwatch" target="_blank" rel="noopener">GitHub</a><a class="repo-link" href="https://www.linkedin.com/in/yash-jain-65295511b/" target="_blank" rel="noopener">LinkedIn</a><button id="themeToggle" class="theme-toggle" aria-label="Toggle theme" title="Toggle dark/light mode"></button></div><h1 class="tagline">${esc(heading)}</h1><p class="subtitle">${esc(subtitle)}</p>${pageNav()}</header>
  <main class="seo-page-main">
    ${visibleBreadcrumbs(breadcrumbs)}
${body}
  </main>
  <footer><p>Pricing changes. Verify rates and policy details with the provider before committing spend.</p><p class="footer-links"><a href="/providers/">Providers</a> · <a href="/docs/methodology/">Methodology</a> · <a href="/docs/api/">API docs</a> · <a href="https://github.com/WyrdWerk/tokenwatch">Source</a></p></footer>
  <script src="/shared-ui.js?v=dev" defer></script>
</body>
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

function providerTextSection(provider, lastmod) {
  if (!provider.text.length) return '';
  return renderSeoTable(cheapestModels(provider.text, 25), lastmod, {
    id: 'text-pricing',
    title: `${provider.name} text-model pricing`,
    intro: 'Text offerings ranked by the Agentic workload mix. Change the calculator mix for a workload-specific result.',
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

export function renderProviderPage(provider, dates) {
  const path = `/providers/${provider.slug}/`;
  const description = `Compare ${provider.name} API pricing across ${provider.modelCount} tracked text, image, and video model identities. Review current rates, variants, and available policy links.`;
  const zdr = provider.meta.retains_prompts === false ? 'Reviewed metadata says prompts are not retained.' : 'TokenWatch does not have a provider-wide zero-retention verdict for this page.';
  const body = `    <section class="seo-prose"><h2>${esc(provider.name)} pricing overview</h2><p>TokenWatch tracks ${provider.text.length} text, ${provider.image.length} image, and ${provider.video.length} video model records for this provider. ${esc(zdr)}</p><p>${policyLinks(provider.meta)}</p><p><a href="/#provider=${encodeURIComponent(provider.key)}">Open the text calculator filtered to ${esc(provider.name)}</a></p></section>
${providerTextSection(provider, dates.text)}
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
    title: `${provider.name} API Pricing — Text, Image & Video | TokenWatch`,
    description,
    canonicalPath: path,
    heading: `${provider.name} API pricing`,
    subtitle: `${provider.modelCount} tracked model identities with provider-specific prices`,
    breadcrumbs: [{ name: 'Text pricing', path: '/' }, { name: 'Providers', path: '/providers/' }, { name: provider.name, path }],
    body,
    structuredData,
  });
}

export function renderProviderDirectoryPage(providers) {
  const path = '/providers/';
  const rows = providers.map((provider) => `<tr><td><a href="/providers/${esc(provider.slug)}/">${esc(provider.name)}</a></td><td class="num">${provider.text.length}</td><td class="num">${provider.image.length}</td><td class="num">${provider.video.length}</td><td class="num">${provider.modelCount}</td><td>${provider.meta.retains_prompts === false ? 'Reviewed ZDR' : 'Not confirmed provider-wide'}</td></tr>`).join('\n');
  const body = `    <section class="seo-prose"><h2>Browse inference providers</h2><p>These pages are generated only for providers with at least ${PROVIDER_MIN_MODELS} distinct priced model identities. Counts combine the text, image, and video catalogs without merging unlike pricing variants.</p></section>
    <section class="seo-models" id="provider-directory"><div class="table-wrap"><table><caption>TokenWatch provider directory</caption><thead><tr><th scope="col">Provider</th><th scope="col" class="num">Text records</th><th scope="col" class="num">Image records</th><th scope="col" class="num">Video records</th><th scope="col" class="num">Distinct models</th><th scope="col">Retention metadata</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  const description = `Browse ${providers.length} inference providers with substantive pricing coverage across TokenWatch's text, image, and video catalogs.`;
  return renderStaticPage({
    title: `LLM, Image & Video API Provider Directory | TokenWatch`,
    description,
    canonicalPath: path,
    heading: 'Inference provider directory',
    subtitle: `${providers.length} providers with substantive, current pricing coverage`,
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

export function renderFaqPage({ modelCount, providerCount }) {
  const path = '/faq/';
  const description = 'Answers about LLM API pricing, cost calculation, image and video generation pricing, and what each benchmark actually measures — in plain language.';
  const groups = [
    { id: 'text-pricing', title: 'Text & token pricing questions', items: homeFaqItems(modelCount, providerCount) },
    { id: 'image-pricing', title: 'Image generation pricing questions', items: imageFaqItems() },
    { id: 'video-pricing', title: 'Video generation pricing questions', items: videoFaqItems() },
    { id: 'benchmarks', title: 'Benchmarks — what the numbers mean', items: benchFaqItems() },
  ];
  const body = groups.map((g) => renderFaqSection(g.title, g.items).replace('id="faq"', `id="${g.id}"`)).join('\n');
  const allItems = groups.flatMap((g) => g.items);
  return renderStaticPage({
    title: `LLM API Pricing & Benchmark FAQs | TokenWatch`,
    description,
    canonicalPath: path,
    heading: 'Frequently asked questions',
    subtitle: 'Pricing, cost calculation, image and video generation, and what the benchmarks measure',
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

> Pay-as-you-go LLM API pricing and practical benchmarks: ${modelCount} text offerings across ${providerCount} providers, ${imageCount} image models, ${videoCount} video models. Data generated ${generatedAt}.

## Pages

- [Text pricing calculator](https://tokenwatch.wyrdwerk.com/): compare per-token prices across providers; enter a token mix or budget to compute costs
- [Image generation pricing](https://tokenwatch.wyrdwerk.com/image): per-image, per-megapixel, and image-token units kept separate
- [Video generation pricing](https://tokenwatch.wyrdwerk.com/video): per-second rates by resolution and audio mode
- [Benchmarks by use case](https://tokenwatch.wyrdwerk.com/benchmarks): agentic coding, reasoning, knowledge work, and UI quality scores joined to cheapest-provider blended pricing
- [Provider directory](https://tokenwatch.wyrdwerk.com/providers/): policy links, HQ, datacenters, and per-provider model catalogs
- [Methodology](https://tokenwatch.wyrdwerk.com/docs/methodology/): sourcing, normalization, dedup, and cost-calculation rules
- [API docs](https://tokenwatch.wyrdwerk.com/docs/api/): queryable JSON endpoints for all catalogs
- [FAQ](https://tokenwatch.wyrdwerk.com/faq/): pricing, image/video billing, and plain-language benchmark explainers

## API

- JSON endpoints under https://tokenwatch.wyrdwerk.com/api/v1/ — models, providers, orgs, stats, images, videos (no auth, CORS enabled)

## Data notes

- Prices are USD per million tokens (images/video use native units). Direct-provider APIs take precedence, then OpenRouter de-aggregated, then maintained fallbacks.
- Benchmark scores come from Artificial Analysis, LiveBench, and Design Arena; they measure models, not providers. "From $/M" on the benchmarks page is the cheapest provider's blended rate at a cached-heavy workload mix.
`;
}

export function renderMethodologyPage({ modelCount, providerCount, generatedAt }) {
  const path = '/docs/methodology/';
  const description = 'How TokenWatch sources, normalizes, deduplicates, enriches, and compares pay-as-you-go AI inference pricing.';
  const body = `    <article class="seo-prose">
      <h2>How TokenWatch builds a comparable catalog</h2>
      <p>The current text catalog contains ${modelCount} provider-specific offerings across ${providerCount} inference providers. Its source timestamp is <time datetime="${esc(generatedAt)}">${esc(generatedAt)}</time>.</p>
      <h2>Source order</h2>
      <p>Direct provider APIs are the first source because a provider is authoritative for its own prices. OpenRouter endpoint data comes next and is split into provider-specific rows. CSV and maintained fallback records fill gaps after live sources.</p>
      <h2>Price normalization</h2>
      <p>Text prices are stored as US dollars per million tokens. Sources quoted per token are multiplied by one million; Wafer cents-per-million values are divided by 100. Image prices keep their native flat-image, megapixel, or image-token units. Video prices are normalized to dollars per second.</p>
      <h2>Model identity and provider precedence</h2>
      <p>The deduplication key combines a canonical model ID with a normalized provider. Provider prefixes, dated aliases, and selected routing suffixes can normalize to one identity. Quantization suffixes remain part of the key, so FP8, NVFP4, and INT4 rows stay separate.</p>
      <h2>Cost calculations</h2>
      <p>Blended $/M applies the selected input, cached-input, and output percentages. If a provider does not publish a cache-read price, cached input falls back to the normal input rate. Cache-write charges stay separate because they are one-time costs amortized across reuse.</p>
      <h2>Privacy and policy data</h2>
      <p>ZDR tags come from endpoint-level OpenRouter data or reviewed provider metadata. Missing metadata does not become a positive or negative privacy claim. Provider pages link to reviewed policies when TokenWatch has them.</p>
      <h2>Benchmarks and performance</h2>
      <p>Quality indices and design-arena scores are sidecar enrichment, not prices. Variant matching is conservative to reduce false attribution. Throughput is displayed separately because speed, quality, context limits, and cost answer different questions.</p>
      <h2>Known limits</h2>
      <p>Provider catalogs can change between refreshes. Promotions may expire, regional prices may differ, and unpublished cache prices are unknown rather than zero. Treat TokenWatch as a comparison and estimation tool, then confirm a shortlisted provider's current terms.</p>
    </article>`;
  return renderStaticPage({
    title: 'LLM API Pricing Methodology & Data Sources | TokenWatch',
    description,
    canonicalPath: path,
    heading: 'Pricing methodology and data sources',
    subtitle: 'How provider-specific prices become comparable TokenWatch records',
    breadcrumbs: [{ name: 'Text pricing', path: '/' }, { name: 'Methodology', path }],
    body,
    structuredData: { '@context': 'https://schema.org', '@graph': [{ '@type': 'TechArticle', url: SITE + path, headline: 'TokenWatch pricing methodology and data sources', description }, breadcrumbSchema([{ name: 'Text pricing', path: '/' }, { name: 'Methodology', path }])] },
  });
}

export function renderApiDocsPage() {
  const path = '/docs/api/';
  const description = 'Query TokenWatch text, image, video, provider, organization, and catalog statistics through the public JSON API.';
  const rows = API_ENDPOINTS.map((endpoint) => `<tr><td><code>${esc(endpoint.path)}</code></td><td>${esc(endpoint.summary)}</td><td>${endpoint.params.length ? endpoint.params.map((param) => `<code>${esc(param)}</code>`).join(', ') : '—'}</td><td>${endpoint.sort.length ? endpoint.sort.map((sort) => `<code>${esc(sort)}</code>`).join(', ') : '—'}</td></tr>`).join('\n');
  const body = `    <article class="seo-prose">
      <h2>Public JSON API</h2>
      <p>All endpoints accept GET requests and return JSON with permissive CORS headers. List endpoints paginate with <code>limit</code> and <code>offset</code>; the limit is clamped to 1–500 and defaults to 100.</p>
      <div class="table-wrap"><table><caption>TokenWatch API endpoints</caption><thead><tr><th scope="col">Endpoint</th><th scope="col">Response</th><th scope="col">Query parameters</th><th scope="col">Sort values</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h2>Examples</h2>
      <pre><code>curl '${SITE}/api/v1/models?provider=aster&amp;sort=input&amp;limit=20'
curl '${SITE}/api/v1/models/glm-5.2/providers?tokens=1000000&amp;mix=30,50,20'
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
    subtitle: 'Public JSON endpoints for model, provider, image, and video pricing',
    breadcrumbs: [{ name: 'Text pricing', path: '/' }, { name: 'API documentation', path }],
    body,
    structuredData: { '@context': 'https://schema.org', '@graph': [{ '@type': 'TechArticle', url: SITE + path, headline: 'TokenWatch API documentation', description }, breadcrumbSchema([{ name: 'Text pricing', path: '/' }, { name: 'API documentation', path }])] },
  });
}

export function renderExploreLinks() {
  return `    <section class="seo-links" aria-label="Explore TokenWatch"><h2>Explore TokenWatch data</h2><p><a href="/benchmarks">Compare benchmarks by use case</a> · <a href="/providers/">Browse inference providers</a> · <a href="/docs/methodology/">Read the pricing methodology</a> · <a href="/docs/api/">Use the pricing API</a> · <a href="/faq/">Read the FAQ</a></p></section>`;
}

// Crawlable top-models table for /benchmarks — the page's interactive table is
// client-rendered, so crawlers (and no-JS visitors) need a static snapshot.
// Ranked by AA intelligence (fallback: LiveBench reasoning), with scores from
// every source and the cheapest-provider blended price at the default mix.
export function renderBenchmarksSeoSection(bench) {
  const ranked = [...bench.models]
    .filter((m) => m.scores.aa_intelligence != null || m.scores.livebench_reasoning != null)
    .sort((a, b) =>
      (b.scores.aa_intelligence ?? b.scores.livebench_reasoning ?? -1) -
      (a.scores.aa_intelligence ?? a.scores.livebench_reasoning ?? -1))
    .slice(0, 25);
  const fmt = (v) => (v == null ? '—' : String(Math.round(v * 10) / 10));
  const rows = ranked.map((m) => `          <tr><td>${esc(m.name)}</td><td>${esc(m.org || '—')}</td><td>${fmt(m.scores.aa_intelligence)}</td><td>${fmt(m.scores.aa_agentic)}</td><td>${fmt(m.scores.aa_coding)}</td><td>${fmt(m.scores.livebench_reasoning)}</td><td>${fmt(m.scores.design_arena_elo)}</td><td>$${m.from.blended_per_m}</td></tr>`).join('\n');
  return `    <section class="seo-models" id="crawlable-benchmarks" aria-label="Top benchmarked models">
      <h2>Top benchmarked models and their cheapest blended price</h2>
      <p>Snapshot of the 25 highest-ranked models (Artificial Analysis Intelligence Index, ${bench.model_count} benchmarked models total). The interactive table above adds use-case tabs, live token-mix pricing, and capability-per-dollar value ranking.</p>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">Model</th><th scope="col">Creator</th><th scope="col" class="num">AA Intelligence</th><th scope="col" class="num">AA Agentic</th><th scope="col" class="num">AA Coding</th><th scope="col" class="num">LiveBench Reasoning</th><th scope="col" class="num">Design Arena Elo</th><th scope="col" class="num">From $/M</th></tr></thead>
        <tbody>
${rows}
        </tbody></table></div>
      <p class="seo-note">Scores from <a href="https://artificialanalysis.ai/" rel="noopener">Artificial Analysis</a>, <a href="https://livebench.ai/" rel="noopener">LiveBench</a> and <a href="https://www.designarena.ai/" rel="noopener">Design Arena</a>. "From $/M" is the cheapest provider's blended rate at a cached-heavy workload mix. See the <a href="/faq/#benchmarks">benchmark FAQ</a> for what each score measures.</p>
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
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`;
}
