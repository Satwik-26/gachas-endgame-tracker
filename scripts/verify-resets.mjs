// Verifies resets.json against the web using an AI model with web search.
// Pass 1: find proposed changes. Pass 2: re-check each change in a fresh, independent request.
// Changes confirmed by both passes (and by the sanity checks) are applied automatically.
// Anything else is listed for human review.
// Provider: GEMINI_API_KEY (Google Search grounding) or ANTHROPIC_API_KEY (Claude web search). Node 20+, no dependencies.

import { readFile, writeFile } from 'node:fs/promises'

const GEMINI_KEY = process.env.GEMINI_API_KEY
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY
const PROVIDER = GEMINI_KEY ? 'gemini' : CLAUDE_KEY ? 'claude' : null
const MODEL = process.env.AI_MODEL || (PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'claude-haiku-4-5')
const FILE = 'resets.json'
const GAMES = ['genshin', 'hsr', 'zzz', 'wuwa']
const ALLOWED_DAYS = [14, 28, 35, 42, 49]
const DAY = 86400000

if (!PROVIDER) { console.error('Set GEMINI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1) }

const data = JSON.parse(await readFile(FILE, 'utf8'))
const today = new Date().toISOString().slice(0, 10)

// ---------- AI calls ----------
async function askGemini(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const body = await res.json()
  const cand = body.candidates?.[0]
  const meta = cand?.groundingMetadata
  return {
    text: (cand?.content?.parts || []).map(p => p.text || '').join('\n'),
    searches: meta?.webSearchQueries?.length || (meta?.groundingChunks?.length ? 1 : 0),
    tokensIn: body.usageMetadata?.promptTokenCount || 0,
    tokensOut: body.usageMetadata?.candidatesTokenCount || 0
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
  return {
    text: body.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    searches: body.usage?.server_tool_use?.web_search_requests || 0,
    tokensIn: body.usage?.input_tokens || 0,
    tokensOut: body.usage?.output_tokens || 0
  }
}

const usage = { calls: 0, searches: 0, tokensIn: 0, tokensOut: 0 }
async function ask(prompt) {
  const r = PROVIDER === 'gemini' ? await askGemini(prompt) : await askClaude(prompt)
  usage.calls++; usage.searches += r.searches; usage.tokensIn += r.tokensIn; usage.tokensOut += r.tokensOut
  const match = r.text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/)
  let json = null
  try { json = match ? JSON.parse(match[0]) : null } catch {}
  return { json, searched: r.searches > 0, raw: r.text }
}

// ---------- Pass 1: find changes ----------
const pass1 = await ask(`Today is ${today}. You maintain the reset schedule for a gacha endgame countdown site covering Genshin Impact (genshin), Honkai: Star Rail (hsr), Zenless Zone Zero (zzz) and Wuthering Waves (wuwa).

Current data (anchor = a reset time in SERVER-LOCAL time, repeating every "days" days; "monthly" modes reset on a fixed day of month):
${JSON.stringify(data.modes, null, 2)}

Search the web (official HoYoverse/Kuro news, HoYoLAB, Game8, Prydwen, fandom wikis) to confirm each mode's NEXT reset date and cycle length.
Rules:
- Only report a change if a source states the date explicitly. Do not infer from arithmetic alone.
- Anchors are "YYYY-MM-DDTHH:MM" in server time.
- Report NEW endgame modes that have a recurring, rotating reset (like Spiral Abyss or Memory of Chaos). Skip permanent modes without a reset timer.

Reply with ONLY a JSON object, no prose, no code fences:
{"changes":[{"id":"...","type":"cycle","anchor":"...","days":42,"reason":"...","source":"https://..."}],
 "newModes":[{"id":"short-id","name":"...","gameId":"hsr","type":"cycle","anchor":"...","days":42,"reason":"...","source":"https://..."}]}
Use empty arrays if nothing changed.`)

if (!pass1.searched) { console.error(`${PROVIDER} did not run any web searches (key may lack search quota). No changes made.`); process.exit(1) }
if (!pass1.json) { console.error('No JSON in reply:\n', pass1.raw); process.exit(1) }

// ---------- Sanity checks ----------
function sanity(c, existing) {
  const t = Date.parse((c.anchor || '') + ':00Z')
  if ((c.type || existing?.type) !== 'cycle') return 'switching to or editing a monthly schedule needs a human'
  if (existing && existing.type !== 'cycle') return 'changing a mode type needs a human'
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(c.anchor || '')) return 'bad anchor format'
  if (Math.abs(t - Date.now()) > 70 * DAY) return 'date more than 70 days from today'
  if (!ALLOWED_DAYS.includes(c.days ?? existing?.days)) return `unusual cycle length ${c.days}`
  if (!c.source?.startsWith('http')) return 'no source link'
  return null
}

// ---------- Pass 2: independent confirmation ----------
async function confirm(claim) {
  const r = await ask(`Today is ${today}. Fact-check this claim about a video game schedule using web search. Be skeptical: only answer "true" if a source explicitly supports it.

Claim: ${claim}

Reply with ONLY a JSON object: {"verdict":"true"|"false"|"unsure","evidence":"one sentence","source":"https://..."}`)
  return { ok: r.searched && r.json?.verdict === 'true', verdict: r.searched ? (r.json?.verdict || 'no answer') : 'no search run', evidence: r.json?.evidence || '' }
}

const fmt = s => s.replace('T', ' ') + ' server time'
const applied = [], review = []

for (const c of pass1.json.changes || []) {
  const mode = data.modes.find(m => m.id === c.id)
  if (!mode) { review.push(`**${c.id}**: unknown mode id`); continue }
  const days = c.days ?? mode.days
  if (mode.anchor === c.anchor && mode.days === days) continue
  const why = sanity({ ...c, days }, mode)
  if (why) { review.push(`**${c.id}**: ${why}. Proposed: ${JSON.stringify(c)}`); continue }

  const check = await confirm(`In ${mode.gameId}, the endgame mode "${mode.name}" has a reset on ${fmt(c.anchor)}, and it repeats every ${days} days.`)
  if (!check.ok) { review.push(`**${c.id}**: second check said "${check.verdict}". ${check.evidence} Proposed: ${c.anchor} / ${days}d ([source](${c.source}))`); continue }

  applied.push(`**${mode.name}**: ${mode.anchor} / ${mode.days}d → ${c.anchor} / ${days}d. ${c.reason} ([source](${c.source}))`)
  mode.anchor = c.anchor
  mode.days = days
}

for (const n of pass1.json.newModes || []) {
  const id = (n.id || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  if (!id || !n.name || !GAMES.includes(n.gameId)) { review.push(`New mode "${n.name}": missing id, name or valid game`); continue }
  if (data.modes.some(m => m.id === id || m.name.toLowerCase() === n.name.toLowerCase())) continue
  const why = sanity(n, null)
  if (why) { review.push(`New mode **${n.name}** (${n.gameId}): ${why}. ${n.reason || ''}`); continue }

  const check = await confirm(`In ${n.gameId}, "${n.name}" is a recurring endgame mode that resets on ${fmt(n.anchor)} and repeats every ${n.days} days.`)
  if (!check.ok) { review.push(`New mode **${n.name}** (${n.gameId}): second check said "${check.verdict}". ${check.evidence}`); continue }

  data.modes.push({ id, name: n.name, gameId: n.gameId, type: 'cycle', anchor: n.anchor, days: n.days })
  applied.push(`**Added ${n.name}** (${n.gameId}): ${n.anchor} every ${n.days}d. ${n.reason || ''} ([source](${n.source}))`)
}

data.lastVerified = today
await writeFile(FILE, JSON.stringify(data, null, 2) + '\n')

// ---------- Summary ----------
const lines = [`Automated schedule check on ${today} (${PROVIDER}: ${MODEL}).`, '']
lines.push(applied.length ? '### Applied automatically (confirmed twice)' : 'No confirmed changes.')
applied.forEach(a => lines.push(`- ${a}`))
if (review.length) { lines.push('', '### Needs your review'); review.forEach(r => lines.push(`- ${r}`)) }
lines.push('', `Usage: ${usage.calls} requests, ${usage.searches} searches, ${usage.tokensIn} input / ${usage.tokensOut} output tokens.`)

await writeFile('verify-summary.md', lines.join('\n') + '\n')
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' })
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `needs_review=${review.length > 0}\n`, { flag: 'a' })
