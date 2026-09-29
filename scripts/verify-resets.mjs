// Verifies resets.json against the web using an AI model with web search.
// Provider is picked automatically: GEMINI_API_KEY (Google Search grounding) or ANTHROPIC_API_KEY (Claude web search).
// Only applies changes that pass sanity checks, then writes a summary for the PR body.
// Requires Node 20+. No npm dependencies.

import { readFile, writeFile } from 'node:fs/promises'

const GEMINI_KEY = process.env.GEMINI_API_KEY
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY
const PROVIDER = GEMINI_KEY ? 'gemini' : CLAUDE_KEY ? 'claude' : null
const MODEL = process.env.AI_MODEL || (PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'claude-haiku-4-5')
const FILE = 'resets.json'
const ALLOWED_DAYS = [14, 28, 35, 42, 49]
const DAY = 86400000

if (!PROVIDER) { console.error('Set GEMINI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1) }

const data = JSON.parse(await readFile(FILE, 'utf8'))
const today = new Date().toISOString().slice(0, 10)

const prompt = `Today is ${today}. You maintain the reset schedule for a gacha endgame countdown site.

Current data (anchor = a reset time in SERVER-LOCAL time, repeating every "days" days; "monthly" modes reset on a fixed day of month):
${JSON.stringify(data.modes, null, 2)}

For each mode, search the web (official HoYoverse/Kuro news, HoYoLAB, Game8, Prydwen, fandom wikis) to confirm the NEXT reset date and the cycle length.
Rules:
- Only report a change if you found a source that states the date explicitly. Do not infer from arithmetic alone.
- For cycle modes, give the anchor as the next confirmed reset, formatted "YYYY-MM-DDTHH:MM" in server time.
- Also report any new endgame mode for these four games that is missing from the list (put it in "newModes", do not invent dates).

Reply with ONLY a JSON object, no prose, no code fences:
{"changes":[{"id":"...","anchor":"...","days":42,"reason":"...","source":"https://..."}],
 "newModes":[{"gameId":"...","name":"...","note":"..."}],
 "unconfirmed":[{"id":"...","note":"..."}]}
Use empty arrays if nothing changed.`

async function askGemini() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    })
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const body = await res.json()
  const cand = body.candidates?.[0]
  const meta = cand?.groundingMetadata
  return {
    text: (cand?.content?.parts || []).map(p => p.text || '').join('\n'),
    searched: (meta?.webSearchQueries?.length || 0) > 0 || (meta?.groundingChunks?.length || 0) > 0,
    usage: `${body.usageMetadata?.promptTokenCount ?? '?'} input / ${body.usageMetadata?.candidatesTokenCount ?? '?'} output tokens, ${meta?.webSearchQueries?.length ?? 0} searches`
  }
}

async function askClaude() {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
      messages: [{ role: 'user', content: prompt }]
    })
  })
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`)
  const body = await res.json()
  const searches = body.usage?.server_tool_use?.web_search_requests ?? 0
  return {
    text: body.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    searched: searches > 0,
    usage: `${body.usage?.input_tokens ?? '?'} input / ${body.usage?.output_tokens ?? '?'} output tokens, ${searches} searches`
  }
}

let reply
try { reply = PROVIDER === 'gemini' ? await askGemini() : await askClaude() }
catch (e) { console.error(e.message); process.exit(1) }

// Without real searches the model would just be guessing, so change nothing.
if (!reply.searched) {
  console.error(`${PROVIDER} did not run any web searches (your key may lack search quota). No changes made.`)
  process.exit(1)
}

const match = reply.text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/)
if (!match) { console.error('No JSON in reply:\n', reply.text); process.exit(1) }
let report
try { report = JSON.parse(match[0]) } catch { console.error('Bad JSON:\n', match[0]); process.exit(1) }

// ---- Sanity checks: never trust the model blindly ----
const applied = [], rejected = []
for (const c of report.changes || []) {
  const mode = data.modes.find(m => m.id === c.id)
  const t = Date.parse((c.anchor || '') + ':00Z')
  const days = c.days ?? mode?.days
  const why =
    !mode ? 'unknown id' :
    mode.type !== 'cycle' ? 'monthly modes are edited by hand' :
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(c.anchor || '') ? 'bad anchor format' :
    Math.abs(t - Date.now()) > 70 * DAY ? 'date more than 70 days from today' :
    !ALLOWED_DAYS.includes(days) ? `unusual cycle length ${days}` :
    !c.source?.startsWith('http') ? 'no source link' : null

  if (why) { rejected.push({ ...c, why }); continue }
  if (mode.anchor === c.anchor && mode.days === days) continue
  applied.push({ id: c.id, from: `${mode.anchor} / ${mode.days}d`, to: `${c.anchor} / ${days}d`, reason: c.reason, source: c.source })
  mode.anchor = c.anchor
  mode.days = days
}

data.lastVerified = today
await writeFile(FILE, JSON.stringify(data, null, 2) + '\n')

// ---- Summary for the pull request ----
const lines = [`Automated schedule check on ${today} (${PROVIDER}: ${MODEL}).`, '']
lines.push(applied.length ? '### Applied changes' : 'No schedule changes needed.')
for (const a of applied) lines.push(`- **${a.id}**: ${a.from} → ${a.to}. ${a.reason} ([source](${a.source}))`)
if (rejected.length) { lines.push('', '### Rejected by sanity checks'); for (const r of rejected) lines.push(`- ${r.id}: ${r.why} — ${JSON.stringify(r)}`) }
if (report.unconfirmed?.length) { lines.push('', "### Couldn't confirm"); for (const u of report.unconfirmed) lines.push(`- ${u.id}: ${u.note}`) }
if (report.newModes?.length) { lines.push('', '### Possible new modes (add by hand)'); for (const n of report.newModes) lines.push(`- ${n.gameId}: ${n.name} — ${n.note}`) }
lines.push('', `Usage: ${reply.usage}.`)

await writeFile('verify-summary.md', lines.join('\n') + '\n')
console.log(lines.join('\n'))

const needsReview = applied.length > 0 || rejected.length > 0 || (report.newModes?.length ?? 0) > 0
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `needs_review=${needsReview}\n`, { flag: 'a' })
