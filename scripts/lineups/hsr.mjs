// Honkai: Star Rail lineups, read from the HSR Fandom wiki.
//
// The wiki keeps each version's endgame on pages like "Pure Fiction/Stages/4.6". Each period on a page
// has exact start/end times. The final stage has "Normal" and "Starward" tabs; for each Node the bot reads
// the recommended types (rtypeN), the boss (the single enemy in the last wave, or enemies_N), traits and
// Corruption Level.

import { createWiki, allTemplates, topTemplates, sections, stripComments, plain, wikiTime, list } from '../lib/wiki.mjs'
import { nearTime } from '../lib/schedule.mjs'

const wiki = createWiki('honkai-star-rail.fandom.com')
const ELEMENTS = ['Physical', 'Fire', 'Ice', 'Lightning', 'Wind', 'Quantum', 'Imaginary']
const PAGES_TO_CHECK = 3              // newest version pages to look through

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

async function findPeriod(pagePrefix, periodStart) {
  const pages = (await wiki.listPages(pagePrefix)).filter(t => /\/\d+(\.\d+)?$/.test(t)).sort(newestFirst).slice(0, PAGES_TO_CHECK)
  for (const title of pages) {
    const text = stripComments(await wiki.wikitext(title))
    const period = periodsOn(text).find(p => nearTime(p.start, periodStart))
    if (period) return { ...period, page: title }
  }
  return null
}

// ---------- Reading the lineup ----------
function readParts(stage, corruption) {
  const n = stage.named, allowed = new Map(ELEMENTS.map(e => [e.toLowerCase(), e]))
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

function readLineup(period, finalStage) {
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
    const parts = readParts(stage, corruption)
    const level = stage.named.enemylv || list(stage.named.levels, ';').pop()
    return {
      key,
      name: key === 'starward' ? 'Starward Mode' : `Normal Mode · ${stageHeading || finalStage}`,
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

const mode = (pagePrefix, finalStage) => ({
  find: periodStart => findPeriod(pagePrefix, periodStart),
  read: period => readLineup(period, finalStage)
})

export default {
  wiki,
  wikiName: 'Honkai: Star Rail Wiki',
  modes: {
    moc: mode('Forgotten Hall/Stages/', 'Stage 12'),
    pf: mode('Pure Fiction/Stages/', 'Stage 4'),
    as: mode('Apocalyptic Shadow/Stages/', 'Difficulty 4')
  }
}
