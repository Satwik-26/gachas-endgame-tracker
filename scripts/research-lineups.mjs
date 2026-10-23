// Researches the boss lineup of each endgame mode's CURRENT period and saves it to lineups.json.
//
// Each mode has two difficulties: Normal Mode (report its final stage) and Starward Mode (split into
// Nodes, each with one boss and a "Recommended Type(s)" list). Both are researched.
//
// Rules:
//   - Only the live period (from resets.json) is researched; beta/leak info about future periods is not wanted.
//   - Each lineup is researched twice, independently. A difficulty is "confirmed" only if both passes name
//     the same period and the same boss for every part, in order, backed by at least 2 trusted websites.
//     Otherwise it is saved as unconfirmed (the page labels it) and a GitHub issue asks you to check it.
//   - Only trusted guide/wiki sites count as backing or are shown as sources (shops and blogs are ignored).
//   - Types are limited to the game's real elements, and only ones both passes agree on are kept.
//   - Confirmed lineups are not researched again until the mode resets. RESEARCH_FORCE=1 redoes them.
//   - Fixed a lineup by hand? Add "locked": true to it and the bot leaves it alone until the next reset.
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

// Sites that count as backing a lineup (subdomains included, e.g. honkai-star-rail.fandom.com)
const TRUSTED_DOMAINS = ['prydwen.gg', 'game8.co', 'fandom.com', 'hoyolab.com', 'hoyoverse.com', 'hakush.in', 'honeyhunterworld.com',
  'starrailstation.com', 'sportskeeda.com', 'gamerant.com', 'pockettactics.com', 'ign.com', 'dexerto.com', 'thegamer.com',
  'mobalytics.gg', 'gamewith.net', 'polygon.com', 'gamesradar.com', 'yatta.moe']
const isTrusted = d => TRUSTED_DOMAINS.some(t => d === t || d.endsWith('.' + t))

const GAMES = {
  genshin: { name: 'Genshin Impact', elements: ['Pyro', 'Hydro', 'Anemo', 'Electro', 'Dendro', 'Cryo', 'Geo'] },
  hsr: { name: 'Honkai: Star Rail', elements: ['Physical', 'Fire', 'Ice', 'Lightning', 'Wind', 'Quantum', 'Imaginary'] },
  zzz: { name: 'Zenless Zone Zero', elements: ['Physical', 'Fire', 'Ice', 'Electric', 'Ether'] },
  wuwa: { name: 'Wuthering Waves', elements: ['Spectro', 'Havoc', 'Glacio', 'Fusion', 'Electro', 'Aero'] }
}

// Modes the bot researches, and Normal Mode's final stage. Add a mode here to roll it out.
const MODES = {
  moc: { finalStage: 'Stage 12' },
  pf: { finalStage: 'Stage 4' },
  as: { finalStage: 'Stage 4' }
}

if (!PROVIDER) { console.error('Set GEMINI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1) }

const schedule = JSON.parse(await readFile(SCHEDULE_FILE, 'utf8'))
let data = { modes: {} }
try { data = JSON.parse(await readFile(FILE, 'utf8')) } catch {}
data.modes ||= {}
data.tracked = Object.keys(MODES)        // lets the page tell "not found yet" apart from "not tracked"
const before = JSON.stringify(data)
const today = new Date().toISOString().slice(0, 10)

// ---------- Research ----------
function prompt(mode, game, cfg, start, end) {
  return `Today is ${today}. Research the CURRENT live period of "${mode.name}" in ${game.name}, which runs from ${start} to ${end} (server time, UTC+8).

Search the web, preferring: ${TRUSTED_DOMAINS.slice(0, 8).join(', ')}. Only use information about this live period. Ignore beta or leaked information about future periods.

This mode has two difficulties. Report both:
- "Starward Mode": the hardest difficulty. It is split into Nodes (currently 3). For each Node in order, give its boss and the node's "Recommended Type(s)" exactly as the game lists them.
- "Normal Mode": report only its final stage (${cfg.finalStage}). List each part of that stage in order, labelled as the game labels it (for example "First Half" and "Second Half", or "Node 1"), with its boss and recommended types (or the boss's weaknesses if no recommended types are shown).

Boss names must be the enemy's in-game name as the wiki lists it. Never use a social media handle, a username, a team name or a character build name.
Types must come from: ${game.elements.join(', ')}.

Also report:
- title: the period's name as shown in-game
- buff: the period's main special effect, in one or two plain sentences
- sources: URLs of the pages you used

Reply with ONLY a JSON object, no prose, no code fences:
{"title":"...","buff":"...","difficulties":[{"name":"Starward Mode","parts":[{"label":"Node 1","boss":"...","types":["..."]}]},{"name":"Normal Mode","parts":[{"label":"First Half","boss":"...","types":["..."]}]}],"sources":["https://..."]}
Leave a difficulty out if you cannot find it. If you cannot find this period at all, reply {"notFound":true}.`
}

const str = v => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
const list = v => Array.isArray(v) ? v : []
// Cut at the end of a sentence rather than mid-word
const clip = (s, n) => s.length <= n ? s : (s.slice(0, n).match(/^[\s\S]*[.!?](?=\s|$)/)?.[0] || s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…')
// Real enemy names are short and never handles or links
const bossName = v => { const s = str(v); return s.length >= 2 && s.length <= 80 && !/@|https?:|www\.|#/i.test(s) ? s : '' }

// Keep only well-formed fields; the reply is untrusted and ends up on the page
function clean(json, game, cfg) {
  if (!json || json.notFound || !Array.isArray(json.difficulties)) return null
  const allowed = new Map(game.elements.map(e => [e.toLowerCase(), e]))
  const difficulties = []
  for (const d of list(json.difficulties).slice(0, 4)) {
    const key = /starward/i.test(str(d?.name)) ? 'starward' : 'normal'
    if (difficulties.some(x => x.key === key)) continue
    const parts = list(d?.parts).slice(0, 6).map((p, i) => ({
      label: clip(str(p?.label), 30) || `Part ${i + 1}`,
      boss: bossName(p?.boss),
      types: [...new Set(list(p?.types).map(t => allowed.get(str(t).toLowerCase())).filter(Boolean))]
    }))
    // A rejected boss name makes the whole difficulty unusable rather than silently shorter
    if (parts.length && parts.every(p => p.boss)) difficulties.push({ key, name: key === 'starward' ? 'Starward Mode' : `Normal Mode · ${cfg.finalStage}`, parts })
  }
  if (!difficulties.length) return null
  difficulties.sort((a, b) => (a.key === 'starward' ? 0 : 1) - (b.key === 'starward' ? 0 : 1))
  return {
    title: clip(str(json.title), 80), buff: clip(str(json.buff), 700), difficulties,
    sources: list(json.sources).filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
  }
}

// ---------- Comparing the two passes ----------
const norm = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()
// Lenient on naming: "Phantylia" matches "Phantylia the Undying"
const sameName = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)) }
const sameParts = (a, b) => a.parts.length === b.parts.length && a.parts.every((p, i) => sameName(p.boss, b.parts[i].boss))
// Keep only the types both passes gave for the same part
const mergeParts = (a, b) => a.parts.map((p, i) => ({ ...p, types: p.types.filter(t => b.parts[i].types.includes(t)) }))

// Source links, limited to trusted websites the search actually used (the model can invent URLs)
function sourcesFor(urls, domains) {
  return domains.map(d => ({ name: d, url: urls.find(u => domainOf(u) === d || domainOf(u).endsWith('.' + d)) || `https://${d}` }))
}

// ---------- Main ----------
const saved = [], review = [], skipped = [], failed = []
const bossList = d => d.parts.map(p => p.boss).join(', ')

for (const [id, cfg] of Object.entries(MODES)) {
  const mode = schedule.modes.find(m => m.id === id)
  const game = mode && GAMES[mode.gameId]
  if (!game) { review.push(`**${id}** is in the research list but not in ${SCHEDULE_FILE}.`); continue }

  const { prev, next } = currentPeriod(mode)
  const periodStart = toStr(prev), periodEnd = toStr(next)
  const existing = data.modes[id]
  const samePeriod = existing?.periodStart === periodStart
  if (samePeriod && existing.locked) { skipped.push(`${mode.name} (locked)`); continue }
  const complete = samePeriod && list(existing.difficulties).length === 2 && existing.difficulties.every(d => d.confirmed)
  if (complete && !FORCE) { skipped.push(mode.name); continue }

  const q = prompt(mode, game, cfg, periodStart, periodEnd)
  let ra, rb
  try {
    ra = await ask(q)
    rb = await ask(q)
  } catch (e) {
    // Keep going so one unavailable mode doesn't lose the others; tomorrow's run tries again
    console.error(`${mode.name}: ${e.message.split('\n')[0]}`)
    failed.push(mode.name)
    continue
  }
  if (!ra.searched || !rb.searched) { console.error(`${PROVIDER} did not run any web searches (key may lack search quota). No changes made.`); process.exit(1) }
  const a = clean(ra.json, game, cfg), b = clean(rb.json, game, cfg)

  if (!a && !b) {
    const days = Math.floor((serverNow() - prev) / DAY)
    if (samePeriod) { console.log(`${mode.name}: still no new lineup found; keeping what is saved.`); continue }
    if (days < NOT_FOUND_GRACE_DAYS) { console.log(`${mode.name}: no lineup found yet.`); continue }
    review.push(`**${mode.name}**: no lineup found for the period that started ${periodStart} (${days} days ago).`)
    data.modes[id] = { periodStart, periodEnd, notFound: true, checkedAt: today }   // remembered so it is flagged once
    continue
  }

  const domains = [...new Set([...ra.domains, ...rb.domains])].filter(isTrusted)
  const titlesAgree = !!(a && b && a.title && b.title && sameName(a.title, b.title))
  const base = a || b, other = a && b ? b : null
  const problems = []
  if (!other) problems.push('only one pass found a lineup')
  else if (!titlesAgree) problems.push(`titles differ ("${a.title}" vs "${b.title}")`)
  if (domains.length < MIN_DOMAINS) problems.push(`backed by ${domains.length ? domains.join(', ') : 'no trusted sites'} (need ${MIN_DOMAINS}+)`)

  const difficulties = base.difficulties.map(d => {
    const twin = other?.difficulties.find(x => x.key === d.key)
    const agree = !!twin && sameParts(d, twin)
    if (other && !twin) problems.push(`${d.name}: only one pass found it`)
    else if (twin && !agree) problems.push(`${d.name}: bosses differ (A: ${bossList(d)} / B: ${bossList(twin)})`)
    const confirmed = agree && titlesAgree && domains.length >= MIN_DOMAINS
    return { key: d.key, name: d.name, confirmed, parts: confirmed ? mergeParts(d, twin) : d.parts }
  })
  // Difficulties only the second pass found are still worth showing, unconfirmed
  for (const d of other?.difficulties || []) {
    if (!difficulties.some(x => x.key === d.key)) { difficulties.push({ key: d.key, name: d.name, confirmed: false, parts: d.parts }); problems.push(`${d.name}: only one pass found it`) }
  }
  difficulties.sort((x, y) => (x.key === 'starward' ? 0 : 1) - (y.key === 'starward' ? 0 : 1))

  const entry = {
    periodStart, periodEnd,
    title: base.title, buff: base.buff, difficulties,
    sources: sourcesFor([...(a?.sources || []), ...(b?.sources || [])], domains),
    checkedAt: today
  }
  const wasConfirmed = d => samePeriod && list(existing.difficulties).some(x => x.key === d.key && x.confirmed)
  const confirmedNames = difficulties.filter(d => d.confirmed && !wasConfirmed(d)).map(d => `${d.name} (${bossList(d)})`)
  if (confirmedNames.length) saved.push(`**${mode.name}** — ${entry.title}: confirmed ${confirmedNames.join('; ')} via ${domains.join(', ')}.`)
  if (problems.length) {
    const unchanged = samePeriod && JSON.stringify(existing.difficulties) === JSON.stringify(entry.difficulties)
    if (!unchanged) review.push(`**${mode.name}** — ${entry.title || 'untitled'}: some of it is shown as unconfirmed because ${[...new Set(problems)].join('; ')}. Check it in-game; you can fix ${FILE} by hand and add "locked": true so the bot leaves it alone.`)
    else console.log(`${mode.name}: still partly unconfirmed, same as before.`)
  }
  data.modes[id] = entry
}

if (JSON.stringify(data) !== before) await writeFile(FILE, JSON.stringify(data, null, 2) + '\n')

// ---------- Summary ----------
const lines = [`Lineup research on ${today} (${PROVIDER}: ${MODEL}).`, '']
lines.push(saved.length ? '### Confirmed' : 'No new confirmed lineups.')
saved.forEach(s => lines.push(`- ${s}`))
if (review.length) { lines.push('', '### Needs your review'); review.forEach(r => lines.push(`- ${r}`)) }
if (skipped.length) lines.push('', `Already done for this period: ${skipped.join(', ')}.`)
if (failed.length) lines.push('', `Couldn't reach ${PROVIDER} for: ${failed.join(', ')}. The next run tries again.`)
lines.push('', `Usage: ${usage.calls} requests, ${usage.searches} searches.`)

await writeFile('lineups-summary.md', lines.join('\n') + '\n')
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' })
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `needs_review=${review.length > 0}\n`, { flag: 'a' })
// Fail the run only if nothing could be researched, so a total outage still shows up red in Actions
if (failed.length && failed.length === Object.keys(MODES).length - skipped.length) process.exit(1)
