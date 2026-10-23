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
import { ask, usage, PROVIDER, MODEL } from './lib/ai.mjs'
import { DAY, toMs, toStr, nextOnSchedule } from './lib/schedule.mjs'

const FILE = 'resets.json'
const CONFIRM_RUNS = 3
const MIN_DOMAINS = 2

if (!PROVIDER) { console.error('Set GEMINI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1) }

const data = JSON.parse(await readFile(FILE, 'utf8'))
const today = new Date().toISOString().slice(0, 10)

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
  // Recorded as a one-off date so the page can show why; cycle length is never touched
  mode.overrides = [...(mode.overrides || []), { date: d.statedNextReset, reason: d.quote || `Confirmed by ${check.domains.join(', ')}` }]
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
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `needs_review=${review.length > 0}\n`, { flag: 'a' })
