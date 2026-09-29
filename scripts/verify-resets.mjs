// Verifies resets.json against the web using an AI model with web search.
//
// Hard rules (the AI can never break these):
//   - Cycle lengths are locked. The AI can only move a mode's next reset date.
//   - A moved date must keep the same weekday and time as the current schedule.
//   - An auto-applied change needs 3 separate "true" verdicts AND at least 2 different
//     websites backing it (GitHub is ignored so the bot can't cite its own issues).
//   - New modes and anything else uncertain go to a GitHub issue for you to decide.
//
// Provider: GEMINI_API_KEY (Google Search) or ANTHROPIC_API_KEY (Claude web search). Node 20+.

import { readFile, writeFile } from 'node:fs/promises'

const GEMINI_KEY = process.env.GEMINI_API_KEY
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY
const PROVIDER = GEMINI_KEY ? 'gemini' : CLAUDE_KEY ? 'claude' : null
const MODEL = process.env.AI_MODEL || (PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'claude-haiku-4-5')
const FILE = 'resets.json'
const CONFIRM_RUNS = 3
const MIN_DOMAINS = 2
const IGNORED_DOMAINS = ['github.com', 'github.io', 'youtube.com', 'reddit.com']
const HOUR = 3600000, DAY = 24 * HOUR

if (!PROVIDER) { console.error('Set GEMINI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1) }

const data = JSON.parse(await readFile(FILE, 'utf8'))
const today = new Date().toISOString().slice(0, 10)
const usage = { calls: 0, searches: 0 }

// ---------- AI calls (both return text + the websites actually used) ----------
const domainOf = s => { try { return new URL(s.startsWith('http') ? s : 'https://' + s).hostname.replace(/^www\./, '') } catch { return (s || '').toLowerCase() } }

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

async function ask(prompt) {
  const r = PROVIDER === 'gemini' ? await askGemini(prompt) : await askClaude(prompt)
  usage.calls++; usage.searches += r.searches
  const match = r.text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/)
  let json = null
  try { json = match ? JSON.parse(match[0]) : null } catch {}
  const domains = [...new Set(r.domains.filter(d => d && !IGNORED_DOMAINS.some(x => d.endsWith(x))))]
  return { json, searched: r.searches > 0, domains, raw: r.text }
}

// ---------- Schedule math ----------
const toMs = s => Date.parse(s + ':00Z')              // server-local string -> comparable ms
const toStr = ms => new Date(ms).toISOString().slice(0, 16)
function nextOnSchedule(mode) {
  const start = toMs(mode.anchor), now = Date.now() + 8 * HOUR, cycle = mode.days * DAY
  if (now < start) return start
  return start + (Math.floor((now - start) / cycle) + 1) * cycle
}

// ---------- Pass 1: look for anything that differs from the schedule ----------
const cycleModes = data.modes.filter(m => m.type === 'cycle')
const expected = cycleModes.map(m => ({ id: m.id, game: m.gameId, name: m.name, expectedNextReset: toStr(nextOnSchedule(m)) }))

const pass1 = await ask(`Today is ${today}. You check the reset schedule for a gacha endgame countdown site.

These are the NEXT reset dates the site expects (server-local time, YYYY-MM-DDTHH:MM):
${JSON.stringify(expected, null, 2)}

Search the web (official HoYoverse/Kuro news, HoYoLAB, Game8, Prydwen, fandom wikis) and report ONLY modes whose next reset is explicitly stated by a source as a DIFFERENT date. Also list any recurring endgame mode for these games that is missing (skip permanent modes with no reset timer).

Reply with ONLY a JSON object, no prose, no code fences:
{"differences":[{"id":"...","statedNextReset":"YYYY-MM-DDTHH:MM","source":"https://...","quote":"the sentence that states the date"}],
 "newModes":[{"name":"...","gameId":"...","note":"..."}]}
Use empty arrays if everything matches.`)

if (!pass1.searched) { console.error(`${PROVIDER} did not run any web searches (key may lack search quota). No changes made.`); process.exit(1) }
if (!pass1.json) { console.error('No JSON in reply:\n', pass1.raw); process.exit(1) }

// ---------- Pass 2: several independent fact-checks of one simple claim ----------
async function confirmDate(mode, date) {
  const verdicts = [], domains = new Set()
  for (let i = 0; i < CONFIRM_RUNS; i++) {
    const r = await ask(`Fact-check with web search. Be skeptical; answer "true" only if a source explicitly states this exact date.

Claim: In ${mode.gameId}, the next "${mode.name}" reset is on ${date.slice(0, 10)}.

Reply with ONLY a JSON object: {"verdict":"true"|"false"|"unsure","statedDate":"YYYY-MM-DD or null","evidence":"one sentence"}`)
    verdicts.push(r.searched ? (r.json?.verdict || 'no answer') : 'no search')
    if (r.json?.verdict === 'true') r.domains.forEach(d => domains.add(d))
  }
  return { allTrue: verdicts.every(v => v === 'true'), verdicts, domains: [...domains] }
}

const applied = [], review = []

for (const d of pass1.json.differences || []) {
  const mode = cycleModes.find(m => m.id === d.id)
  if (!mode) { review.push(`**${d.id}**: not a cycle mode the bot may edit. Claimed: ${JSON.stringify(d)}`); continue }
  const current = nextOnSchedule(mode)
  const proposed = toMs(d.statedNextReset || '')
  const label = `**${mode.name}**: site expects ${toStr(current)}, source says ${d.statedNextReset}`

  if (isNaN(proposed)) { review.push(`${label} (unreadable date)`); continue }
  if (proposed === current) continue
  if (new Date(proposed).getUTCDay() !== new Date(current).getUTCDay() || toStr(proposed).slice(11) !== toStr(current).slice(11)) {
    review.push(`${label}. Rejected: different weekday or time than this mode ever uses.`); continue
  }
  if (Math.abs(proposed - current) > mode.days * DAY) { review.push(`${label}. Rejected: shift is bigger than one whole cycle.`); continue }

  const check = await confirmDate(mode, d.statedNextReset)
  const enoughSites = check.domains.length >= MIN_DOMAINS
  if (!check.allTrue || !enoughSites) {
    review.push(`${label}. Not applied: fact-checks said [${check.verdicts.join(', ')}], backed by ${check.domains.length ? check.domains.join(', ') : 'no sites'} (need ${CONFIRM_RUNS}× true and ${MIN_DOMAINS}+ sites). Source: ${d.source}${d.quote ? ` — "${d.quote}"` : ''}`)
    continue
  }

  applied.push(`${label}. Confirmed ${CONFIRM_RUNS}× by ${check.domains.join(', ')}. Cycle stays ${mode.days} days.`)
  mode.anchor = d.statedNextReset          // cycle length is never touched
}

for (const n of pass1.json.newModes || []) {
  if (data.modes.some(m => m.name.toLowerCase() === (n.name || '').toLowerCase())) continue
  review.push(`Possible new mode **${n.name}** (${n.gameId}): ${n.note || ''} — add by hand if it has a regular reset.`)
}

data.lastVerified = today
await writeFile(FILE, JSON.stringify(data, null, 2) + '\n')

// ---------- Summary ----------
const lines = [`Automated schedule check on ${today} (${PROVIDER}: ${MODEL}).`, '']
lines.push(applied.length ? '### Applied automatically' : 'No confirmed changes.')
applied.forEach(a => lines.push(`- ${a}`))
if (review.length) { lines.push('', '### Needs your review'); review.forEach(r => lines.push(`- ${r}`)) }
lines.push('', `Usage: ${usage.calls} requests, ${usage.searches} searches.`)

await writeFile('verify-summary.md', lines.join('\n') + '\n')
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' })
if (process.
