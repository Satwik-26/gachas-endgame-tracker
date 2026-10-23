// Genshin Impact lineups, read from the Genshin Fandom wiki.
//
//   Spiral Abyss:        "Spiral Abyss/Floors/2026-10-16". {{Abyssal Moon Spire|start|end}} has the dates; Floor 12
//                        is a {{Domain Enemies}} under ===Floor 12=== (levelN, enemiesN_1 / enemiesN_2 = halves).
//   Imaginarium Theater: "Imaginarium Theater/Seasons/2026-10-01". {{Imaginarium Theater Season}} has the dates,
//                        elements, opening and guest characters; boss acts are the "Climactic Showdown" acts.
//   Stygian Onslaught:   "Stygian Onslaught/2026-09-30". {{Event|time_start|time_end}}; the hardest difficulty's
//                        table has one {{Card}} per boss, an advantage line and ";Mechanic" descriptions.
//
// Enemy lists use {{Domain Enemies}} syntax: ";" = together, "//" = next wave, "*N" = count.

import { createWiki, allTemplates, topTemplates, sections, stripComments, plain, wikiTime, list } from '../lib/wiki.mjs'
import { nearTime } from '../lib/schedule.mjs'

const wiki = createWiki('genshin-impact.fandom.com')
const ELEMENTS = ['Pyro', 'Hydro', 'Anemo', 'Electro', 'Dendro', 'Cryo', 'Geo']
const PAGES_TO_CHECK = 3

const elementsIn = s => ELEMENTS.filter(e => new RegExp(`\\b${e}\\b`).test(plain(s)))

// Newest dated pages under a prefix; the first whose dates template starts with our period
async function findPeriod(prefix, template, periodStart, isReady = () => true) {
  const pages = (await wiki.listPages(prefix)).filter(t => /\/\d{4}-\d{2}-\d{2}$/.test(t)).sort().reverse().slice(0, PAGES_TO_CHECK)
  for (const page of pages) {
    const text = stripComments(await wiki.wikitext(page))
    const t = allTemplates(text).find(t => t.name === template)
    const start = wikiTime(t?.named.start || t?.named.time_start)
    if (nearTime(start, periodStart) && isReady(t, text)) return { page, text, info: t.named, start, end: wikiTime(t.named.end || t.named.time_end) }
  }
  return null
}

// "Name*3/{{Aura|Pyro}}", "Name{ text = - $ danger = 1 }", "Name*Lv. 95" -> { name, count }
function enemyEntry(raw) {
  const [name, rest] = raw.replace(/\{\{[^{}]*\}\}/g, '').replace(/\{[^{}]*\}/g, '').split('*')
  const count = rest === undefined || /Lv/.test(rest) ? 1 : /^\s*\d/.test(rest) ? parseInt(rest) : NaN
  return { name: plain(name).replace(/\/\s*$/, '').trim(), count }
}
const waves = s => (s || '').split('//').map(w => list(w, ';').map(enemyEntry).filter(e => e.name)).filter(w => w.length)

// The boss: the single enemy in the smallest wave (bosses usually come alone, e.g. a boss then its adds);
// everyone else is listed as "also appearing"
function bossOf(enemies) {
  const ws = waves(enemies)
  if (!ws.length) return { boss: '', others: [] }
  const smallest = ws.reduce((a, w) => (w.length < a.length ? w : a))
  const singles = smallest.filter(e => e.count === 1)
  const boss = (singles.length ? singles : smallest.slice(0, 1)).map(e => e.name).join(' + ')
  return { boss, others: [...new Set(ws.flat().map(e => e.name))].filter(n => !boss.split(' + ').includes(n)) }
}
const lastNumber = s => { const m = plain(s).match(/\d+(?!.*\d)/s); return m ? +m[0] : undefined }

// ---------- Spiral Abyss ----------
const abyss = {
  find: periodStart => findPeriod('Spiral Abyss/Floors/', 'Abyssal Moon Spire', periodStart),
  read(period) {
    const floor = sections(period.text, 3).find(s => /^Floor 12$/i.test(s.title))
    const box = allTemplates(floor?.body || '').find(t => t.name === 'Domain Enemies')
    const parts = []
    for (let c = 1; box?.named[`enemies${c}_1`] !== undefined || box?.named[`enemies${c}_2`] !== undefined; c++) {
      for (const half of [1, 2]) {
        const { boss, others } = bossOf(box.named[`enemies${c}_${half}`])
        if (boss) parts.push({ label: `Chamber ${c} · ${half === 1 ? 'First' : 'Second'} Half`, boss, types: [], level: lastNumber(box.named[`level${c}`]), ...(others.length ? { others } : {}) })
      }
    }
    // "** First Half: Characters' ... DMG increased by 75%." under '''Ley Line Disorder'''
    const disorder = (floor?.body.split('{{Domain Enemies')[0] || '').split('\n').filter(l => /^\*/.test(l)).map(l => plain(l.replace(/^\*+\s*/, ''))).filter(l => l && !/^Ley Line Disorder$/i.test(l))
    const effects = disorder.map(l => { const m = l.match(/^(First Half|Second Half):\s*([\s\S]*)$/i); return m ? { name: `Ley Line Disorder · ${m[1]}`, desc: m[2] } : { name: 'Ley Line Disorder', desc: l } })
    const level = Math.max(0, ...parts.map(p => p.level || 0))
    return {
      title: 'Floor 12',
      effects, choices: [],
      difficulties: parts.length ? [{ key: 'floor12', name: 'Floor 12', ...(level ? { level } : {}), confirmed: parts.every(p => p.boss), parts }] : []
    }
  }
}

// ---------- Imaginarium Theater ----------
const theater = {
  // The next season's page exists early with commented-out placeholders; only use one with enemies filled in
  find: periodStart => findPeriod('Imaginarium Theater/Seasons/', 'Imaginarium Theater Season', periodStart, t => !!plain(t.named.enemies)),
  read(period) {
    const info = period.info
    const parts = []
    for (const act of sections(period.text, 3).filter(s => /^Act \d+$/i.test(s.title) && /Climactic Showdown/i.test(s.body))) {
      const box = allTemplates(act.body).find(t => t.name === 'Domain Enemies')
      if (!box) continue
      // Acts with several challenges (Hard / Visionary): use the Visionary one, else the last
      const ks = Object.keys(box.named).map(k => k.match(/^enemies(\d+)$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
      const k = ks.find(i => /visionary/i.test(box.named[`name${i}`] || '')) ?? ks[ks.length - 1]
      if (k === undefined) continue
      const { boss, others } = bossOf(box.named[`enemies${k}`])
      const advantage = plain(box.named[`advantage${k}`])
      parts.push({ label: act.title, boss, types: elementsIn(advantage), level: lastNumber(box.named[`level${k}`]), ...(advantage ? { note: advantage } : {}), ...(others.length ? { others } : {}) })
    }
    const names = s => list(s, ';').map(plain).map(name => ({ name, desc: '' }))
    const choices = [
      { label: 'Elements', style: 'elements', options: names(info.elements) },
      { label: 'Opening characters', style: 'chips', options: names(info.characters) },
      { label: 'Guest characters', style: 'chips', options: names(info.guests) }
    ].filter(c => c.options.length)
    const level = Math.max(0, ...parts.map(p => p.level || 0))
    return {
      title: info.season ? `Season ${plain(info.season)}` : 'Imaginarium Theater',
      typesLabel: 'Advantage',
      effects: info.blessing ? [{ name: 'Blessing', desc: plain(info.blessing) }] : [],
      choices,
      difficulties: parts.length ? [{ key: 'visionary', name: 'Visionary Mode', ...(level ? { level } : {}), confirmed: parts.every(p => p.boss), parts }] : []
    }
  }
}

// ---------- Stygian Onslaught ----------
const onslaught = {
  find: periodStart => findPeriod('Stygian Onslaught/', 'Event', periodStart),
  endsEarly: true,     // each run closes about a week before the next one starts
  read(period) {
    const challenges = sections(period.text).find(s => /^Challenges$/i.test(s.title))
    const top = sections(challenges?.body || '', 3).pop()     // the hardest difficulty is listed last (e.g. Dire)
    const body = top?.body || ''
    const disturbance = (body.split(/^;Ley Line Disturbance\s*$/m)[1] || '').split(/^;/m)[0]
    const effects = disturbance ? [{ name: 'Ley Line Disturbance', desc: disturbance.split('\n').filter(l => /^\*/.test(l)).map(l => plain(l.replace(/^\*+\s*/, ''))).join('\n') }] : []
    const parts = []
    for (const row of body.split(/\n\|-/)) {
      const card = topTemplates(row).find(t => t.name === 'Card')
      if (!card) continue
      const name = plain(card.positional[0])
      const variant = plain(card.named.caption || '').replace(name, '').replace(/^\s*[:\-–]\s*/, '')
      const advantageLine = row.split('\n').find(l => /Advantage\.png/.test(l)) || ''
      // "|[[File:...]] Stellar Glimmer characters {{!}} {{Element|Anemo}} characters": the pipes mean "or"
      const advantage = plain(advantageLine.replace(/\[\[File:[^\]]*\]\]/g, '')).replace(/^\|\s*/, '').replace(/\s*\|\s*/g, ' or ')
      // ";Mechanic name" followed by its description
      const lines = row.split('\n'), traits = []
      lines.forEach((l, i) => { if (/^;/.test(l)) traits.push({ name: plain(l.slice(1)), desc: plain(lines.slice(i + 1).find(x => x.trim() && !/^[;*|]/.test(x)) || '') }) })
      parts.push({
        label: `Battlefield ${parts.length + 1}${variant ? ` · ${variant}` : ''}`,
        boss: name,
        types: [...new Set([...advantageLine.matchAll(/\{\{Elements?\|([^}]+)\}\}/g)].flatMap(m => list(m[1]).map(plain)).filter(e => ELEMENTS.includes(e)))],
        level: lastNumber(card.positional[1] || ''),
        ...(advantage ? { note: `Advantage: ${advantage}` } : {}),
        ...(traits.length ? { traits, traitsLabel: 'Mechanics' } : {})
      })
    }
    const level = Math.max(0, ...parts.map(p => p.level || 0))
    return {
      title: plain(period.info.name || '').replace(/^Stygian Onslaught:\s*/i, '') || 'Stygian Onslaught',
      typesLabel: 'Advantage',
      effects, choices: [],
      difficulties: parts.length ? [{ key: 'top', name: top.title, ...(level ? { level } : {}), confirmed: parts.every(p => p.boss), parts }] : []
    }
  }
}

export default {
  wiki,
  wikiName: 'Genshin Impact Wiki',
  // Card List renders "<name> Icon.png"; page images can point at unrelated NPCs, so they aren't used
  images: { files: ['{name} Icon.png'], pageImages: false },
  modes: { sa: abyss, it: theater, so: onslaught }
}
