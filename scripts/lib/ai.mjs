// Shared AI access for the bots. ask() works with Gemini (Google Search) or Claude (web search)
// and returns the parsed JSON reply plus the websites the model actually used.
//
// Provider: GEMINI_API_KEY or ANTHROPIC_API_KEY. Model override: AI_MODEL.

const GEMINI_KEY = process.env.GEMINI_API_KEY
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY
export const PROVIDER = GEMINI_KEY ? 'gemini' : CLAUDE_KEY ? 'claude' : null
export const MODEL = process.env.AI_MODEL || (PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'claude-haiku-4-5')
// GitHub is ignored so the bot can't cite its own issues
const IGNORED_DOMAINS = ['github.com', 'github.io', 'youtube.com', 'reddit.com']

export const usage = { calls: 0, searches: 0 }

export const domainOf = s => { try { return new URL(s.startsWith('http') ? s : 'https://' + s).hostname.replace(/^www\./, '') } catch { return (s || '').toLowerCase() } }

async function askGemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const cand = (await res.json()).candidates?.[0]
  const meta = cand?.groundingMetadata
  return {
    text: (cand?.content?.parts || []).map(p => p.text || '').join('\n'),
    searches: meta?.webSearchQueries?.length || 0,
    // Gemini hides real URLs behind redirects; the chunk title is the site's domain
    domains: (meta?.groundingChunks || []).map(c => domainOf(c.web?.title || ''))
  }
}

async function askClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      messages: [{ role: 'user', content: prompt }]
    })
  })
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`)
  const body = await res.json()
  const cited = body.content.flatMap(b => (b.citations || []).map(c => domainOf(c.url || '')))
  return {
    text: body.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    searches: body.usage?.server_tool_use?.web_search_requests || 0,
    domains: cited
  }
}

// Overload and rate-limit errors are usually gone within a minute, so wait and try again
const RETRY_DELAYS_MS = (process.env.AI_RETRY_DELAYS_MS || '5000,20000,60000').split(',').map(Number)
const RETRYABLE = /^(Gemini|Claude) (429|500|502|503|504|529):/
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function withRetry(call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (e) {
      const retryable = RETRYABLE.test(e.message) || e.name === 'TypeError'   // TypeError = network failure in fetch
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw e
      console.warn(`${e.message.split('\n')[0].slice(0, 120)} — retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`)
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
}

export async function ask(prompt) {
  const r = await withRetry(() => PROVIDER === 'gemini' ? askGemini(prompt) : askClaude(prompt))
  usage.calls++; usage.searches += r.searches
  const match = r.text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/)
  let json = null
  try { json = match ? JSON.parse(match[0]) : null } catch {}
  const domains = [...new Set(r.domains.filter(d => d && !IGNORED_DOMAINS.some(x => d.endsWith(x))))]
  return { json, searched: r.searches > 0, domains, raw: r.text }
}
