// Cloudflare Pages Function: /api/advisor
// TokenWatch AI Advisor powered by Laggingway / InferX (Nemotron 3.5 Lightning)
// Plain-text conversational output, website-aware, IP/Cookie rate-limited (4 queries / 24h).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Advisor-Session',
  'Content-Type': 'application/json',
};

// In-memory rate map per edge isolate
const ipRateMap = new Map();
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_QUERIES_PER_WINDOW = 4;

function cleanOldRateEntries() {
  const now = Date.now();
  for (const [ip, data] of ipRateMap.entries()) {
    if (now - data.firstSeen > RATE_LIMIT_WINDOW_MS) {
      ipRateMap.delete(ip);
    }
  }
}

function checkRateLimit(ip) {
  cleanOldRateEntries();
  const now = Date.now();
  const data = ipRateMap.get(ip) || { count: 0, firstSeen: now };

  if (now - data.firstSeen > RATE_LIMIT_WINDOW_MS) {
    data.count = 1;
    data.firstSeen = now;
    ipRateMap.set(ip, data);
    return { allowed: true, remaining: MAX_QUERIES_PER_WINDOW - 1, resetMs: RATE_LIMIT_WINDOW_MS };
  }

  if (data.count >= MAX_QUERIES_PER_WINDOW) {
    const resetMs = RATE_LIMIT_WINDOW_MS - (now - data.firstSeen);
    return { allowed: false, remaining: 0, resetMs };
  }

  data.count += 1;
  ipRateMap.set(ip, data);
  return { allowed: true, remaining: MAX_QUERIES_PER_WINDOW - data.count, resetMs: RATE_LIMIT_WINDOW_MS - (now - data.firstSeen) };
}

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

  // 1. Check Rate Limit
  const rate = checkRateLimit(clientIp);
  if (!rate.allowed) {
    const hoursLeft = Math.ceil(rate.resetMs / (1000 * 60 * 60));
    return new Response(
      JSON.stringify({
        error: `Daily query quota reached (4/4). Please try again in ${hoursLeft} hours or explore the interactive tables above.`,
        rateLimit: { remaining: 0, resetHours: hoursLeft },
      }),
      { status: 429, headers: CORS_HEADERS }
    );
  }

  // 2. Validate environment configuration
  const INFERX_BASE_URL = env?.INFERX_BASE_URL;
  const INFERX_API_KEY = env?.INFERX_API_KEY;
  const MODEL_ID = env?.INFERX_MODEL || 'Inferx-Main/nemotron-35-lightning';

  if (!INFERX_BASE_URL || !INFERX_API_KEY) {
    console.error('Advisor error: INFERX_BASE_URL or INFERX_API_KEY environment variable is not configured.');
    return new Response(
      JSON.stringify({ error: 'Advisor service configuration missing on server.' }),
      { status: 500, headers: CORS_HEADERS }
    );
  }

  // 3. Parse request
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON request body' }), { status: 400, headers: CORS_HEADERS });
  }

  const userMessages = body.messages || [];
  if (!Array.isArray(userMessages) || userMessages.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing or invalid messages array' }), { status: 400, headers: CORS_HEADERS });
  }

  // 4. Load live knowledge base from static asset
  let knowledgeSnippet = '';
  try {
    const knowledgeRes = await env.ASSETS.fetch(new URL('/advisor-knowledge.json', request.url));
    if (knowledgeRes.ok) {
      const kData = await knowledgeRes.json();
      
      const zdrTopList = (kData.top_zdr_models || []).slice(0, 25).map(m => {
        const intel = m.scores?.intelligence ? `Intel:${m.scores.intelligence}` : 'Intel:58+';
        const coding = m.scores?.coding ? `Coding:${m.scores.coding}` : 'Coding:75+';
        return `- ${m.name || m.id} via ${m.provider} (${m.org}): $${m.blended}/M blended [ZDR:Yes, ${intel}, ${coding}]`;
      }).join('\n');

      const providerPolicies = (kData.providers || []).slice(0, 30).map(p => {
        return `- ${p.id} (HQ:${p.headquarters}): Privacy: ${p.privacy || 'N/A'}, ToS: ${p.tos || 'N/A'}, ZDR:${p.zdr ? 'Yes' : 'No'}`;
      }).join('\n');

      knowledgeSnippet = `LIVE DATASET EVIDENCE (TokenWatch Knowledge Base):
- Total Live Models: ${kData.stats?.total_text_models} (${kData.stats?.total_zdr_models} with Zero Data Retention).
- Total Providers Tracked: ${kData.stats?.total_providers}.

TOP CHEAPEST ZERO DATA RETENTION (ZDR) MODELS:
${zdrTopList}

PROVIDER POLICY & PRIVACY URLS:
${providerPolicies}
`;
    }
  } catch (e) {
    console.warn('Could not load advisor-knowledge.json asset:', e);
  }

  // 5. Conversational, Expert System Prompt (Plain Text Only)
  const systemPrompt = `You are the official conversational TokenWatch AI Advisor on https://tokenwatch.wyrdwerk.com.
Created by Yash Jain (Founder & Principal at WyrdWerk LLP, https://wyrdwerk.com, X: https://x.com/thelaggingway, LinkedIn: https://www.linkedin.com/in/yash-jain-65295511b/).

YOUR MISSION:
- You are a friendly, conversational AI consultant helping visitors compare LLM inference costs, benchmark quality (LiveBench / Artificial Analysis), Zero Data Retention (ZDR) privacy compliance, and provider policy URLs.
- Always answer conversationally and directly. Do not state you lack data—rely on the LIVE DATASET EVIDENCE below.

${knowledgeSnippet}

CRITICAL FORMATTING INSTRUCTIONS:
- DO NOT USE ANY MARKDOWN FORMATTING.
- No asterisks (**bold** or *italic*), no markdown headers (###), no markdown tables (|---|), and no backticks.
- Use plain, clean text with simple numbered lists (1., 2., 3.) or simple dashes (-) and clean paragraphs.
- Keep the tone friendly, conversational, concise, and easy to read.
- Never output internal thinking tags (<think>...</think>).`;

  try {
    const upstreamRes = await fetch(`${INFERX_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INFERX_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [
          { role: 'system', content: systemPrompt },
          ...userMessages.slice(-6),
        ],
        // Increased token budget to 15,000 as requested
        max_tokens: 15000,
        temperature: 0.3,
        stream: false,
      }),
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      console.error('Upstream model error:', upstreamRes.status, errText);
      return new Response(
        JSON.stringify({ error: 'Advisor service is temporarily unavailable. Please explore the interactive tables above.' }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    const completion = await upstreamRes.json();
    const rawContent = completion.choices?.[0]?.message?.content;

    let cleanReply = '';
    if (typeof rawContent === 'string' && rawContent.trim()) {
      cleanReply = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    }

    if (!cleanReply) {
      cleanReply = 'I am unable to generate an answer right now. Please explore the interactive pricing tables above!';
    }

    return new Response(
      JSON.stringify({
        reply: cleanReply,
        rateLimit: { remaining: rate.remaining, max: MAX_QUERIES_PER_WINDOW },
      }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('Advisor error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal error communicating with the model endpoint.' }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
