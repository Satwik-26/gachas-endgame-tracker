// Researches the boss lineup of each endgame mode's CURRENT period and saves it to lineups.json.
//
// Rules:
//   - Only the live period (from resets.json) is researched; beta/leak info about future periods is not wanted.
//   - Each lineup is researched twice, independently. It is "confirmed" only if both passes name the
//     same period and the same bosses, backed by at least 2 different websites. Otherwise it is saved
//     as unconfirmed (the page labels it) and a GitHub issue asks you to check it.
//   - Weaknesses are limited to the game's real elements, and only ones both passes agree on are kept.
//   - Confirmed lineups are not researched again until the mode resets. RESEARCH_FORCE=1 redoes all.
//
// Provider: GEMINI_API_KEY (Google Search) or ANTHROPIC_API_KEY (Claude web search). Node 20+.

import { readFile, writeFile } from 'node:fs/promises'
import { ask, usage, domainOf, PROVIDER, MODEL } from './lib/ai.mjs'
import { DAY, toStr, serverNow, currentPeriod } from './lib/schedule.mjs'

const SCHEDULE_FILE = 'resets.json'
const FILE = 'lineups.json'
const MIN_DOMAINS = 2
const NOT_FOUND_GRACE_DAYS = 3        // guides can lag a reset; only flag a missing lineup after this
const FORCE = process.env.RESEARCH_FORCE === '1'

const GAMES = {
  genshin: { name: 'Genshin Impact', elements: ['Pyro', 'Hydro', 'Anemo', 'Electro', 'Dendro', 'Cryo', 'Geo'] },
  hsr: { name: 'Honkai: Star Rail', elements: ['Physical', 'Fire', 'Ice', 'Lightning', 'Wind', 'Quantum', 'Imaginary'] },
  zzz: { name: 'Zenless Zone Zero', elements: ['Physical', 'Fire', 'Ice', 'Electric', 'Ether'] },
  wuwa: { name: 'Wuthering Waves', elements: ['Spectro', 'Havoc', 'Glacio', 'Fusion', 'Electro', 'Aero'] }
}

// Modes the bot researches, and which stage to report. Add a mode here to roll it out.
const MODES = {
  moc: { stage: 'Stage 12, the final stage' },
  pf: { stage: 'Stage 4, the final stage' },
  as: { stage: 'Difficulty 4, the final stage' }
}

if (!PROVIDER) { console.error('Set GEMINI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1) }

const schedule = JSON.parse(await readFile(SCHEDULE_FILE, 'utf8'))
let data = { modes: {} }
try { data = JSON.parse(await readFile(FILE, 'utf8')) } catch {}
data.modes ||= {}
const before = JSON.stringify(data)
const today = new Date().toISOString().slice(0, 10)

// ---------- Research ----------
function prompt(mode, game, cfg, start, end) {
  return `Today is ${today}. Research the CURRENT live period of "${mode.name}" in ${game.name}, which runs from ${start} to ${end} (server time, UTC+8).

Search the web (official HoYoLAB/HoYoverse news, Prydwen, Game8, fandom wikis). Only use information about this live period. Ignore beta or leaked information about future periods.

Report for this period:
- title: the period's name as shown in-game
- buff: the period's special effect, in one or two plain sentences
- stage: the name of ${cfg.stage}
- halves: for that stage, the bosses and elite enemies in each half (skip ordinary mobs), each with its weaknesses, using only these elements: ${game.elements.join(', ')}
- sources: URLs of the pages you used

Reply with ONLY a JSON object, no prose, no code fences:
{"title":"...","buff":"...","stage":"...","halves":[{"name":"First Half","enemies":[{"name":"...","weaknesses":["..."]}]},{"name":"Second Half","enemies":[{"name":"...","weaknesses":["..."]}]}],"sources":["https://..."]}
If you cannot find this period's lineup, reply {"notFound":true}.`
}

// Keep only well-formed fields; the reply is untrusted and ends up on the page
function clean(json, game) {
  if (!json || json.notFound || !Array.isArray(json.halves)) return null
  const allowed = new Map(game.elements.map(e => [e.toLowerCase(), e]))
  const str = v => typeof v === 'string' ? v.trim().slice(0, 300) : ''
  const list = v => Array.isArray(v) ? v : []
  const halves = json.halves.slice(0, 3).map(h => ({
    name: str(h?.name).slice(0, 40) || 'Half',
    enemies: list(h?.enemies).slice(0, 8).map(e => ({
      name: str(e?.name).slice(0, 80),
      weaknesses: [...new Set(list(e?.weaknesses).map(w => allowed.get(String(w).trim().toLowerCase())).filter(Boolean))]
    })).filter(e => e.name)
  })).filter(h => h.enemies.length)
  if (!halves.length) return null
  return {
    title: str(json.title).slice(0, 80), buff: str(json.buff), stage: str(json.stage).slice(0, 60), halves,
    sources: list(json.sources).filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
  }
}

// ---------- Comparing the two passes ----------
const norm = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
// Lenient on naming: "Phantylia" matches "Phantylia the Undying"
const sameName = (a, b) => { const x = norm(a), y = norm(b); return x === y || x.includes(y) || y.includes(x) }
const enemies = l => l.halves.flatMap(h => h.enemies)

function sameBosses(a, b) {
  const A = enemies(a), B = enemies(b)
  return A.length === B.length && A.every(e => B.some(f => sameName(e.name, f.name)))
}

// Pass A's lineup, keeping only the weaknesses pass B also gave for the same enemy
function merge(a, b) {
  return {
    ...a,
    halves: a.halves.map(h => ({
      ...h,
      enemies: h.enemies.map(e => {
        const twin = enemies(b).find(f => sameName(e.name, f.name))
        return { ...e, weaknesses: twin ? e.weaknesses.filter(w => twin.weaknesses.includes(w)) : e.weaknesses }
      })
    }))
  }
}

// Source links, limited to websites the search actually used (the model can invent URLs)
function sourcesFor(urls, domains) {
  return domains.map(d => ({ name: d, url: urls.find(u => domainOf(u) === d || domainOf(u).endsWith('.' + d)) || `https://${d}` }))
}

// ---------- Main ----------
const saved = [], review = [], skipped = []

for (const [id, cfg] of Object.entries(MODES)) {
  const mode = schedule.modes.find(m => m.id === id)
  const game = mode && GAMES[mode.gameId]
  if (!game) { review.push(`**${id}** is in the research list but not in ${SCHEDULE_FILE}.`); continue }

  const { prev, next } = currentPeriod(mode)
  const periodStart = toStr(prev), periodEnd = toStr(next)
  const existing = data.modes[id]
  const samePeriod = existing?.periodStart === periodStart
  if (samePeriod && existing.confirmed && !FORCE) { skipped.push(mode.name); continue }

  const q = prompt(mode, game, cfg, periodStart, periodEnd)
  const [ra, rb] = [await ask(q), await ask(q)]
  if (!ra.searched || !rb.searched) { console.error(`${PROVIDER} did not run any web searches (key may lack search quota). No changes made.`); process.exit(1) }
  const a = clean(ra.json, game), b = clean(rb.json, game)

  if (!a && !b) {
    const days = Math.floor((serverNow() - prev) / DAY)
    if (samePeriod) { console.log(`${mode.name}: still no new lineup found; keeping what is saved.`); continue }
    if (days < NOT_FOUND_GRACE_DAYS) { console.log(`${mode.name}: no lineup found yet.`); continue }
    review.push(`**${mode.name}**: no lineup found for the period that started ${periodStart} (${days} days ago).`)
    data.modes[id] = { periodStart, periodEnd, notFound: true, checkedAt: today }   // remembered so it is flagged once
    continue
  }

  const domains = [...new Set([...ra.domains, ...rb.domains])]
  const bossesAgree = !!(a && b && sameBosses(a, b))
  const titlesAgree = !!(a && b && a.title && b.title && sameName(a.title, b.title))
  const confirmed = bossesAgree && titlesAgree && domains.length >= MIN_DOMAINS
  const lineup = confirmed ? merge(a, b) : (a || b)

  const entry = {
    periodStart, periodEnd, confirmed,
    title: lineup.title, buff: lineup.buff, stage: lineup.stage, halves: lineup.halves,
    sources: sourcesFor([...(a?.sources || []), ...(b?.sources || [])], domains),
    checkedAt: today
  }
  const bossList = l => l ? enemies(l).map(e => e.name).join(', ') : 'nothing'

  if (confirmed) {
    saved.push(`**${mode.name}** — ${entry.title}: confirmed by ${domains.join(', ')}. Bosses: ${bossList(lineup)}.`)
  } else {
    const why = [!(a && b) ? 'only one pass found a lineup' : null, a && b && !titlesAgree ? `titles differ ("${a.title}" vs "${b.title}")` : null,
      a && b && !bossesAgree ? `bosses differ (A: ${bossList(a)} / B: ${bossList(b)})` : null,
      domains.length < MIN_DOMAINS ? `backed by ${domains.length ? domains.join(', ') : 'no sites'} (need ${MIN_DOMAINS}+)` : null].filter(Boolean)
    const unchanged = samePeriod && !existing.confirmed && JSON.stringify(existing.halves) === JSON.stringify(entry.halves)
    if (!unchanged) review.push(`**${mode.name}** — ${entry.title || 'untitled'}: shown as unconfirmed because ${why.join('; ')}. Check it in-game and fix ${FILE} by hand if needed.`)
    else console.log(`${mode.name}: still unconfirmed, same as before.`)
  }
  data.modes[id] = entry
}

if (JSON.stringify(data) !== before) await writeFile(FILE, JSON.stringify(data, null, 2) + '\n')

// ---------- Summary ----------
const lines = [`Lineup research on ${today} (${PROVIDER}: ${MODEL}).`, '']
lines.push(saved.length ? '### Confirmed' : 'No new confirmed lineups.')
saved.forEach(s => lines.push(`- ${s}`))
if (review.length) { lines.push('', '### Needs your review'); review.forEach(r => lines.push(`- ${r}`)) }
if (skipped.length) lines.push('', `Already confirmed for this period: ${skipped.join(', ')}.`)
lines.push('', `Usage: ${usage.calls} requests, ${usage.searches} searches.`)

await writeFile('lineups-summary.md', lines.join('\n') + '\n')
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' })
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `needs_review=${review.length > 0}\n`, { flag: 'a' })
