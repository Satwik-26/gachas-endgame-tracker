// Shared AI access for the bots. ask() works with Gemini (Google Search) or Claude (web search)
// and returns the parsed JSON reply plus the websites the model actually used.
//
// Provider: GEMINI_API_KEY or ANTHROPIC_API_KEY.
// Models: AI_MODELS (comma-separated, tried in order) or AI_MODEL (just one).
//
// Each Gemini model has its own daily limit, so when one is used up the bot moves on to the next.
// Only models that can use Google Search on the free tier are worth listing: in AI Studio that is
// Gemini 2.5 (Gemini 3 and newer show "Search grounding 0 / 0" without billing).

const GEMINI_KEY = process.env.GEMINI_API_KEY
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY
export const PROVIDER = GEMINI_KEY ? 'gemini' : CLAUDE_KEY ? 'claude' : null
const DEFAULT_MODELS = PROVIDER === 'gemini' ? 'gemini-2.5-flash,gemini-2.5-flash-lite' : 'claude-haiku-4-5'
export const MODELS = (process.env.AI_MODELS || process.env.AI_MODEL || DEFAULT_MODELS).split(',').map(s => s.trim()).filter(Boolean)
// GitHub is ignored so the bot can't cite its own issues
const IGNORED_DOMAINS = ['github.com', 'github.io', 'youtube.com', 'reddit.com']

export const usage = { calls: 0, searches: 0, byModel: {} }
// For summaries: which models actually answered, e.g. "gemini-2.5-flash ×4, gemini-2.5-flash-lite ×2"
export const modelsUsed = () => Object.entries(usage.byModel).map(([m, n]) => `${m} ×${n}`).join(', ') || MODELS.join(' → ')

export const domainOf = s => { try { return new URL(s.startsWith('http') ? s : 'https://' + s).hostname.replace(/^www\./, '') } catch { return (s || '').toLowerCase() } }

class ApiError extends Error {
  constructor(provider, status, body) {
    super(`${provider} ${status}: ${body}`)
    this.status = status
    this.body = body
  }
}

async function askGemini(model, prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
  })
  if (!res.ok) throw new ApiError('Gemini', res.status, await res.text())
  const cand = (await res.json()).candidates?.[0]
  const meta = cand?.groundingMetadata
  return {
    text: (cand?.content?.parts || []).map(p => p.text || '').join('\n'),
    searches: meta?.webSearchQueries?.length || 0,
    // Gemini hides real URLs behind redirects; the chunk title is the site's domain
    domains: (meta?.groundingChunks || []).map(c => domainOf(c.web?.title || ''))
  }
}

async function askClaude(model, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      messages: [{ role: 'user', content: prompt }]
    })
  })
  if (!res.ok) throw new ApiError('Claude', res.status, await res.text())
  const body = await res.json()
  const cited = body.content.flatMap(b => (b.citations || []).map(c => domainOf(c.url || '')))
  return {
    text: body.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    searches: body.usage?.server_tool_use?.web_search_requests || 0,
    domains: cited
  }
}

// ---------- Errors: wait, switch model, or give up ----------
const RETRY_DELAYS_MS = (process.env.AI_RETRY_DELAYS_MS || '5000,20000,60000').split(',').map(Number)
const MAX_WAIT_MS = 90000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const googleDetails = e => { try { return JSON.parse(e.body).error?.details || [] } catch { return [] } }

// Gemini says which quota a 429 hit; a per-day one won't clear by waiting, so don't retry it
const isDailyLimit = e => e.status === 429 && googleDetails(e).flatMap(d => d.violations || []).some(v => /PerDay/i.test(v.quotaId || ''))
const isTemporary = e => [429, 500, 502, 503, 504, 529].includes(e.status) || e.name === 'TypeError'   // TypeError = network failure in fetch
// Gemini's suggested wait for per-minute limits, e.g. "retryDelay": "34s"
const suggestedWait = e => { const s = googleDetails(e).find(d => d.retryDelay)?.retryDelay; return s ? Math.min(parseFloat(s) * 1000 + 1000, MAX_WAIT_MS) : 0 }

async function withRetry(call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (e) {
      if (isDailyLimit(e) || !isTemporary(e) || attempt >= RETRY_DELAYS_MS.length) throw e
      const wait = Math.max(RETRY_DELAYS_MS[attempt], suggestedWait(e))
      console.warn(`${e.message.split('\n')[0].slice(0, 120)} — retrying in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
}

// Models that can't be used for the rest of this run (daily limit reached, not found, or still down after retries)
const unavailable = new Map()

export async function ask(prompt) {
  for (const model of MODELS) {
    if (unavailable.has(model)) continue
    let r
    try {
      r = await withRetry(() => PROVIDER === 'gemini' ? askGemini(model, prompt) : askClaude(model, prompt))
    } catch (e) {
      const why = isDailyLimit(e) ? 'daily limit reached' : e.status === 404 ? 'model not found' : isTemporary(e) ? 'still unavailable after retries' : null
      if (!why) throw e
      unavailable.set(model, why)
      console.warn(`${model}: ${why}${MODELS.some(m => !unavailable.has(m)) ? ', switching to the next model' : ''}`)
      continue
    }
    usage.calls++; usage.searches += r.searches
    usage.byModel[model] = (usage.byModel[model] || 0) + 1
    const match = r.text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/)
    let json = null
    try { json = match ? JSON.parse(match[0]) : null } catch {}
    const domains = [...new Set(r.domains.filter(d => d && !IGNORED_DOMAINS.some(x => d.endsWith(x))))]
    return { json, searched: r.searches > 0, domains, raw: r.text, model }
  }
  throw new Error(`No model available (${[...unavailable].map(([m, why]) => `${m}: ${why}`).join('; ')}). The next run tries again.`)
}
