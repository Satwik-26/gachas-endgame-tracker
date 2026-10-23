// Reads the boss lineup of each endgame mode's CURRENT period from the game's Fandom wiki
// and saves it to lineups.json. No AI is involved, so there is no quota to run out of.
//
// Each game has a reader in scripts/lineups/<game>.mjs that knows its wiki's page layout:
//   export default { wiki, wikiName, images?, modes: { <mode id>: { find(periodStart, periodEnd), prepare?(period), read(period), endsEarly? } } }
//   find() returns the wiki period matching resets.json ({ page, title, start?, end?, ... }) or null;
//   prepare() can do extra async lookups; read() turns the period into { title, effects, choices, difficulties }.
//   images says how the wiki names enemy pictures (see enemyImages in lib/wiki.mjs); false if the reader supplies them.
//   A reader can also return period.source = { name, url } when its data doesn't come from the game's wiki.
//   endsEarly marks modes that close before the next one starts (the wiki's end date is then shown, not flagged).
//   missingNote is shown on the site (and in the issue) when the wiki has no page for the current period.
//
// Rules:
//   - Runs daily and refreshes every mode, so wiki fixes show up; lineups.json only changes when the data does.
//   - A lineup marked "locked": true (fixed by hand) is left alone until the next reset.
//   - A GitHub issue is opened, once per problem, if a period is still missing from the wiki after a few
//     days, a difficulty is incomplete, or the wiki's period dates disagree with resets.json.
//
// Node 20+. No API keys needed.

import { readFile, writeFile } from 'node:fs/promises'
import { DAY, toStr, serverNow, currentPeriod, nearTime } from './lib/schedule.mjs'
import hsr from './lineups/hsr.mjs'
import zzz from './lineups/zzz.mjs'
import genshin from './lineups/genshin.mjs'
import wuwa from './lineups/wuwa.mjs'

const SCHEDULE_FILE = 'resets.json'
const FILE = 'lineups.json'
const NOT_FOUND_GRACE_DAYS = 3        // the wiki can lag a reset; only flag a missing lineup after this

// Games with a wiki reader, keyed by gameId in resets.json. Add a reader here to roll a game out.
const GAMES = { genshin, hsr, zzz, wuwa }
const MODES = Object.fromEntries(Object.values(GAMES).flatMap(g => Object.entries(g.modes).map(([id, reader]) => [id, { game: g, reader }])))

const schedule = JSON.parse(await readFile(SCHEDULE_FILE, 'utf8'))
let data = { modes: {} }
try { data = JSON.parse(await readFile(FILE, 'utf8')) } catch {}
data.modes ||= {}
data.tracked = Object.keys(MODES)        // lets the page tell "not found yet" apart from "not tracked"
const before = JSON.stringify(data)
const today = new Date().toISOString().slice(0, 10)

// ---------- Main ----------
const saved = [], review = [], skipped = [], failed = []
let attempted = 0
const bossList = d => d.parts.map(p => p.boss || '?').join(', ')
// Flag each problem once: remember what was already reported for this period
const flagOnce = (entry, existing, samePeriod, problem) => {
  entry.flagged = [...new Set([...(samePeriod ? existing?.flagged || [] : []), problem])]
  if (!(samePeriod && existing?.flagged?.includes(problem))) review.push(problem)
}

for (const [id, { game, reader }] of Object.entries(MODES)) {
  const mode = schedule.modes.find(m => m.id === id)
  if (!mode) { review.push(`**${id}** has a wiki reader but isn't in ${SCHEDULE_FILE}.`); continue }

  const { prev, next } = currentPeriod(mode)
  const periodStart = toStr(prev), periodEnd = toStr(next)
  const existing = data.modes[id]
  const samePeriod = existing?.periodStart === periodStart
  if (samePeriod && existing.locked) { skipped.push(`${mode.name} (locked)`); continue }

  attempted++
  let period
  try {
    period = await reader.find(periodStart, periodEnd)
    if (period && reader.prepare) await reader.prepare(period)
  } catch (e) {
    console.error(`${mode.name}: ${e.message}`)
    failed.push(mode.name)
    continue
  }

  if (!period) {
    const days = Math.floor((serverNow() - prev) / DAY)
    if (days < NOT_FOUND_GRACE_DAYS) { console.log(`${mode.name}: the wiki doesn't have the period starting ${periodStart} yet.`); continue }
    const entry = samePeriod ? { ...existing } : { periodStart, periodEnd, notFound: true, ...(reader.missingNote ? { note: reader.missingNote } : {}) }
    flagOnce(entry, existing, samePeriod, `**${mode.name}**: the wiki still has no page for the period that started ${periodStart} (${days} days ago).${reader.missingNote ? ' ' + reader.missingNote : ''}`)
    data.modes[id] = entry
    continue
  }

  const lineup = reader.read(period)
  const pageUrl = period.source?.url || game.wiki.pageUrl(period.page)
  // A source that suddenly returns nothing shouldn't wipe a lineup already saved for this period
  if (!lineup.difficulties.length && samePeriod && existing.difficulties?.length) {
    console.warn(`${mode.name}: the source returned no lineup this time; keeping the saved one`)
    skipped.push(mode.name)
    continue
  }
  // Boss pictures are a nice extra: if looking them up fails, the lineup is still saved without them
  if (game.images !== false) try {
    const parts = lineup.difficulties.flatMap(d => d.parts)
    const images = await game.wiki.enemyImages(parts.map(p => p.boss.split(' + ')[0]), game.images)
    for (const p of parts) { const url = images.get(p.boss.split(' + ')[0]); if (url) p.image = url }
  } catch (e) {
    console.warn(`${mode.name}: couldn't look up boss pictures (${e.message}); keeping the saved ones`)
    const saved = new Map((existing?.difficulties || []).flatMap(d => d.parts || []).filter(p => p.image).map(p => [p.boss, p.image]))
    for (const p of lineup.difficulties.flatMap(d => d.parts)) if (saved.has(p.boss)) p.image = saved.get(p.boss)
  }
  const entry = {
    periodStart, periodEnd,
    ...lineup,
    ...(reader.endsEarly && period.end ? { closesAt: period.end } : {}),
    source: { name: period.source?.name || game.wikiName, page: period.page, url: pageUrl },
    updatedAt: samePeriod ? existing.updatedAt : today
  }
  // Same content as before? Keep the old date so lineups.json doesn't change every day
  const content = e => JSON.stringify({ ...e, updatedAt: undefined, flagged: undefined })
  if (!samePeriod || content(existing) !== content(entry)) entry.updatedAt = today

  if (!lineup.difficulties.length) flagOnce(entry, existing, samePeriod, `**${mode.name}** — ${lineup.title}: found the period on [${period.page}](${pageUrl}) but couldn't read its final stage.`)
  for (const d of lineup.difficulties.filter(d => !d.confirmed)) {
    flagOnce(entry, existing, samePeriod, `**${mode.name}** — ${d.name}: the wiki's data is incomplete so far (${bossList(d)}). It is shown as unconfirmed and will update when the wiki does.`)
  }
  if (period.end && !reader.endsEarly && !nearTime(period.end, periodEnd)) {
    flagOnce(entry, existing, samePeriod, `**${mode.name}**: the wiki says this period ends ${period.end}, but ${SCHEDULE_FILE} expects ${periodEnd}. Check the in-game timer and fix ${SCHEDULE_FILE} if the wiki is right.`)
  }
  if (!entry.flagged) delete entry.flagged

  if (entry.updatedAt === today && content(existing || {}) !== content(entry)) {
    saved.push(`**${mode.name}** — ${lineup.title}: ${lineup.difficulties.map(d => `${d.name} (${bossList(d)})`).join('; ')}. From [${period.page}](${pageUrl}).`)
  } else {
    skipped.push(mode.name)
  }
  data.modes[id] = entry
}

if (JSON.stringify(data) !== before) await writeFile(FILE, JSON.stringify(data, null, 2) + '\n')

// ---------- Summary ----------
const lines = [`Lineup update on ${today} (from the wiki).`, '']
lines.push(saved.length ? '### Updated' : 'No lineup changes.')
saved.forEach(s => lines.push(`- ${s}`))
if (review.length) { lines.push('', '### Needs your review'); review.forEach(r => lines.push(`- ${r}`)) }
if (skipped.length) lines.push('', `Unchanged: ${skipped.join(', ')}.`)
if (failed.length) lines.push('', `Couldn't reach the wiki for: ${failed.join(', ')}. The next run tries again.`)

await writeFile('lineups-summary.md', lines.join('\n') + '\n')
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' })
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `needs_review=${review.length > 0}\n`, { flag: 'a' })
// Fail the run only if the wiki couldn't be reached at all, so an outage still shows up red in Actions
if (failed.length && failed.length === attempted) process.exit(1)
