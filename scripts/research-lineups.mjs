// Reads the boss lineup of each endgame mode's CURRENT period from the game's Fandom wiki
// and saves it to lineups.json. No AI is involved, so there is no quota to run out of.
//
// How it finds the data:
//   - The wiki keeps each version's endgame on pages like "Pure Fiction/Stages/4.6".
//   - Each period on a page has exact start/end times; the bot picks the one matching resets.json.
//   - The final stage has "Normal" and "Starward" tabs. For each Node it reads the recommended types
//     (rtypeN), the boss (the single enemy in the last wave, or enemies_N), traits and Corruption Level.
//
// Rules:
//   - Runs daily and refreshes every mode, so wiki fixes show up; lineups.json only changes when the data does.
//   - A lineup marked "locked": true (fixed by hand) is left alone until the next reset.
//   - A GitHub issue is opened, once per problem, if a period is still missing from the wiki after a few
//     days, a difficulty is incomplete, or the wiki's period dates disagree with resets.json.
//
// Node 20+. No API keys needed.

import { readFile, writeFile } from 'node:fs/promises'
import { createWiki, allTemplates, topTemplates, sections, stripComments, plain, wikiTime } from './lib/wiki.mjs'
import { DAY, HOUR, toMs, toStr, serverNow, currentPeriod } from './lib/schedule.mjs'

const SCHEDULE_FILE = 'resets.json'
const FILE = 'lineups.json'
const NOT_FOUND_GRACE_DAYS = 3        // the wiki can lag a reset; only flag a missing lineup after this
const DATE_TOLERANCE = 36 * HOUR      // wiki times can differ by a few hours (e.g. 06:00 on patch day)
const PAGES_TO_CHECK = 3              // newest version pages to look through

const GAMES = {
  hsr: {
    wiki: createWiki('honkai-star-rail.fandom.com'),
    wikiName: 'Honkai: Star Rail Wiki',
    elements: ['Physical', 'Fire', 'Ice', 'Lightning', 'Wind', 'Quantum', 'Imaginary']
  }
}

// Modes the bot reads, with their wiki page family. Add a mode here to roll it out.
const MODES = {
  moc: { pages: 'Forgotten Hall/Stages/', finalStage: 'Stage 12' },
  pf: { pages: 'Pure Fiction/Stages/', finalStage: 'Stage 4' },
  as: { pages: 'Apocalyptic Shadow/Stages/', finalStage: 'Difficulty 4' }
}

const schedule = JSON.parse(await readFile(SCHEDULE_FILE, 'utf8'))
let data = { modes: {} }
try { data = JSON.parse(await readFile(FILE, 'utf8')) } catch {}
data.modes ||= {}
data.tracked = Object.keys(MODES)        // lets the page tell "not found yet" apart from "not tracked"
const before = JSON.stringify(data)
const today = new Date().toISOString().slice(0, 10)

// ---------- Finding the period ----------
const versionOf = title => title.split('/').pop().split('.').map(Number)
const newestFirst = (a, b) => { const x = versionOf(a), y = versionOf(b); return (y[0] - x[0]) || ((y[1] || 0) - (x[1] || 0)) }

// Every period on a page: { title, start, end, section, effect? }
function periodsOn(text) {
  const secs = sections(text), out = []
  for (const sec of secs) {
    for (const t of allTemplates(sec.body)) {
      const n = t.named
      if (n.time_start && n.time_end) out.push({ title: sec.title, start: wikiTime(n.time_start), end: wikiTime(n.time_end), section: sec })
      // Memory of Chaos lists its periods in one {{Memory Turbulence|name1=|time_start1=|effect1=...}}
      for (let k = 1; n[`name${k}`] || n[`time_start${k}`]; k++) {
        const title = plain(n[`name${k}`] || '')
        const section = secs.find(s => s.title === title)
        if (title && section && n[`time_start${k}`]) out.push({ title, start: wikiTime(n[`time_start${k}`]), end: wikiTime(n[`time_end${k}`]), section, effect: n[`effect${k}`] })
      }
    }
  }
  return out.filter(p => p.start)
}

const near = (a, b) => a && b && Math.abs(toMs(a) - toMs(b)) <= DATE_TOLERANCE

async function findPeriod(game, cfg, periodStart, periodEnd) {
  const pages = (await game.wiki.listPages(cfg.pages)).filter(t => /\/\d+(\.\d+)?$/.test(t)).sort(newestFirst).slice(0, PAGES_TO_CHECK)
  for (const title of pages) {
    const text = stripComments(await game.wiki.wikitext(title))
    const period = periodsOn(text).find(p => near(p.start, periodStart))
    if (period) return { ...period, page: title }
  }
  return null
}

// ---------- Reading the lineup ----------
const list = (s, sep = ',') => (s || '').split(sep).map(x => x.trim()).filter(Boolean)

function readParts(stage, game, corruption) {
  const n = stage.named, allowed = new Map(game.elements.map(e => [e.toLowerCase(), e]))
  const count = Math.max(0, ...Object.keys(n).map(k => +(k.match(/^rtype(\d+)$/)?.[1] || 0)))
  const delim = n.delim || ','
  const parts = []
  for (let i = 1; i <= count; i++) {
    let bosses = list(n[`enemies_${i}`], ';').map(plain)
    if (!bosses.length) {
      // Last non-empty wave; its boss is the enemy that appears once ("{ text = 1 }"), or the whole wave
      for (let w = 9; w >= 1 && !bosses.length; w--) {
        const wave = list(n[`t${i}w${w}`], delim).map(e => ({ name: plain(e.replace(/\{[^{}]*\}/g, '')), count: +(e.match(/text\s*=\s*(\d+)/)?.[1] ?? NaN) })).filter(e => e.name)
        if (wave.length) bosses = (wave.some(e => e.count === 1) ? wave.filter(e => e.count === 1) : wave).map(e => e.name)
      }
    }
    const traits = []
    for (let k = 1; n[`trait_${i}_${k}`]; k++) traits.push({ name: plain(n[`trait_${i}_${k}`]), desc: plain(n[`trait_${i}_${k}_desc`]) })
    parts.push({
      label: `Node ${i}`,
      boss: bosses.join(' + '),
      types: [...new Set(list(n[`rtype${i}`]).map(t => allowed.get(t.toLowerCase())).filter(Boolean))],
      ...(corruption[i] ? { corruption: corruption[i] } : {}),
      ...(traits.length ? { traits } : {})
    })
  }
  return parts
}

// "Node 2 is affected by [[Voracity Corrosion]] ('''Corruption Level 3''')" -> { 2: 'Corruption Level 3 (Voracity Corrosion)' }
// "In Difficulty 3/4, ... Corruption Level 2/3" -> the last value, for the final difficulty
function readCorruption(text) {
  const out = {}
  for (const m of text.matchAll(/Node (\d+) is affected by \[\[([^\]|]+)[^\]]*\]\] \('''Corruption Level ([\d/]+)'''\)/g)) {
    out[m[1]] = `Corruption Level ${m[3].split('/').pop()} (${m[2]})`
  }
  return out
}

function readLineup(period, game, cfg) {
  const body = period.section.body
  // The final stage is the last Normal/Starward tab set
  const tabbers = topTemplates(body).filter(t => t.name === 'Tabber' && t.positional.some(p => /^starward$/i.test(p)))
  const tabber = tabbers[tabbers.length - 1]
  const stageHeading = tabber && [...body.slice(0, body.indexOf(tabber.raw)).matchAll(/====\s*(Stage \d+)\s*====/g)].pop()?.[1]
  const corruption = readCorruption(tabber ? tabber.raw : body)

  const stages = []
  if (tabber) {
    for (let i = 0; i < tabber.positional.length - 1; i += 2) {
      const label = tabber.positional[i], stage = topTemplates(tabber.positional[i + 1])[0]
      if (stage && /^(normal|starward)$/i.test(label)) stages.push({ key: label.toLowerCase(), stage })
    }
  } else {
    // Older pages without Starward: just the last stage
    const last = topTemplates(body).filter(t => /Stage$|^Apocalyptic Shadow$/.test(t.name)).pop()
    if (last) stages.push({ key: 'normal', stage: last })
  }

  const difficulties = stages.map(({ key, stage }) => {
    const parts = readParts(stage, game, corruption)
    const level = stage.named.enemylv || list(stage.named.levels, ';').pop()
    return {
      key,
      name: key === 'starward' ? 'Starward Mode' : `Normal Mode · ${stageHeading || cfg.finalStage}`,
      ...(level ? { level: +level } : {}),
      confirmed: parts.length > 0 && parts.every(p => p.boss && p.types.length),
      parts
    }
  }).sort((a, b) => (a.key === 'starward' ? 0 : 1) - (b.key === 'starward' ? 0 : 1))

  // Period-wide effects, and buffs the player picks from; Starward's templates are a superset, so dedupe by name
  const effects = [], choices = []
  const addEffect = (name, desc) => { name = plain(name); if (name && !effects.some(e => e.name === name)) effects.push({ name, desc: plain(desc) }) }
  const addChoice = (label, name, desc) => {
    name = plain(name)
    if (!name) return
    let group = choices.find(c => c.label === label)
    if (!group) choices.push(group = { label, options: [] })
    if (!group.options.some(o => o.name === name)) group.options.push({ name, desc: plain(desc) })
  }
  if (period.effect) addEffect('Memory Turbulence', period.effect)
  for (const t of allTemplates(body)) {
    const n = t.named
    if (n.main_buff) addEffect(n.main_buff, n.main_buff_desc)
    for (let k = 1; n[`whim_name${k === 1 ? '' : k}`]; k++) addEffect(n[`whim_name${k === 1 ? '' : k}`], n[`whim_eff${k === 1 ? '' : k}`])
    for (let k = 1; n[`caco_name${k}`]; k++) addChoice('Cacophony', n[`caco_name${k}`], n[`caco_eff${k}`])
    for (const key of Object.keys(n)) {
      const m = key.match(/^sub_buff_(\d+)_(\d+)$/)
      if (m) addChoice(`Node ${m[1]} buff`, n[key], n[`${key}_desc`])
    }
  }

  return { title: period.title, effects, choices, difficulties }
}

// ---------- Main ----------
const saved = [], review = [], skipped = [], failed = []
let attempted = 0
const bossList = d => d.parts.map(p => p.boss || '?').join(', ')
// Flag each problem once: remember what was already reported for this period
const flagOnce = (entry, existing, samePeriod, problem) => {
  entry.flagged = [...new Set([...(samePeriod ? existing?.flagged || [] : []), problem])]
  if (!(samePeriod && existing?.flagged?.includes(problem))) review.push(problem)
}

for (const [id, cfg] of Object.entries(MODES)) {
  const mode = schedule.modes.find(m => m.id === id)
  const game = mode && GAMES[mode.gameId]
  if (!game) { review.push(`**${id}** is in the lineup list but not in ${SCHEDULE_FILE} (or its game has no wiki set up).`); continue }

  const { prev, next } = currentPeriod(mode)
  const periodStart = toStr(prev), periodEnd = toStr(next)
  const existing = data.modes[id]
  const samePeriod = existing?.periodStart === periodStart
  if (samePeriod && existing.locked) { skipped.push(`${mode.name} (locked)`); continue }

  attempted++
  let period
  try {
    period = await findPeriod(game, cfg, periodStart, periodEnd)
  } catch (e) {
    console.error(`${mode.name}: ${e.message}`)
    failed.push(mode.name)
    continue
  }

  if (!period) {
    const days = Math.floor((serverNow() - prev) / DAY)
    if (days < NOT_FOUND_GRACE_DAYS) { console.log(`${mode.name}: the wiki doesn't have the period starting ${periodStart} yet.`); continue }
    const entry = samePeriod ? { ...existing } : { periodStart, periodEnd, notFound: true }
    flagOnce(entry, existing, samePeriod, `**${mode.name}**: the wiki still has no page for the period that started ${periodStart} (${days} days ago).`)
    data.modes[id] = entry
    continue
  }

  const lineup = readLineup(period, game, cfg)
  const pageUrl = game.wiki.pageUrl(period.page)
  // Boss pictures are a nice extra: if looking them up fails, the lineup is still saved without them
  try {
    const parts = lineup.difficulties.flatMap(d => d.parts)
    const images = await game.wiki.enemyImages(parts.map(p => p.boss.split(' + ')[0]))
    for (const p of parts) { const url = images.get(p.boss.split(' + ')[0]); if (url) p.image = url }
  } catch (e) {
    console.warn(`${mode.name}: couldn't look up boss pictures (${e.message}); keeping the saved ones`)
    const saved = new Map((existing?.difficulties || []).flatMap(d => d.parts || []).filter(p => p.image).map(p => [p.boss, p.image]))
    for (const p of lineup.difficulties.flatMap(d => d.parts)) if (saved.has(p.boss)) p.image = saved.get(p.boss)
  }
  const entry = {
    periodStart, periodEnd,
    ...lineup,
    source: { name: game.wikiName, page: period.page, url: pageUrl },
    updatedAt: samePeriod ? existing.updatedAt : today
  }
  // Same content as before? Keep the old date so lineups.json doesn't change every day
  const content = e => JSON.stringify({ ...e, updatedAt: undefined, flagged: undefined })
  if (!samePeriod || content(existing) !== content(entry)) entry.updatedAt = today

  if (!lineup.difficulties.length) flagOnce(entry, existing, samePeriod, `**${mode.name}** — ${lineup.title}: found the period on [${period.page}](${pageUrl}) but couldn't read its final stage.`)
  for (const d of lineup.difficulties.filter(d => !d.confirmed)) {
    flagOnce(entry, existing, samePeriod, `**${mode.name}** — ${d.name}: the wiki's data is incomplete so far (${bossList(d)}). It is shown as unconfirmed and will update when the wiki does.`)
  }
  if (period.end && !near(period.end, periodEnd)) {
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
