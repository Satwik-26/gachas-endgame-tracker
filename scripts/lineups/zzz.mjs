// Zenless Zone Zero lineups, read from the ZZZ Fandom wiki.
//
// Each period has its own page named after its start date, with exact times in {{Event Infobox}}:
//   Shiyu Defense:  "Shiyu Defense/Critical Node/2026-10-16". The hardest part is the Fifth Frontier:
//                   3 rooms, each a {{Challenge Stage Table}} (eLev, eWeak, eRes, det = room buffs, w1..w4 = waves).
//   Deadly Assault: "Deadly Assault/2026-10-09". 3 Trial Mode bosses plus Adversity Mode, each a
//                   {{Deadly Assault Stage}} (enemy, enemylv, weakness, resistance, mechanicsN, suggspec).
//                   Buff descriptions live in the Lua module "Module:Special Effect/data".

import { createWiki, allTemplates, sections, stripComments, plain, wikiTime, list, luaEntry } from '../lib/wiki.mjs'
import { nearTime } from '../lib/schedule.mjs'

const wiki = createWiki('zenless-zone-zero.fandom.com')
const ATTRIBUTES = ['Physical', 'Fire', 'Ice', 'Electric', 'Ether', 'Wind']
const PAGES_TO_CHECK = 3

const attributes = s => { const allowed = new Map(ATTRIBUTES.map(a => [a.toLowerCase(), a])); return [...new Set(list(plain(s)).map(a => allowed.get(a.toLowerCase())).filter(Boolean))] }

// Newest dated pages under a prefix; the one whose {{Event Infobox}} starts with our period
async function findPeriod(prefix, periodStart) {
  const pages = (await wiki.listPages(prefix)).filter(t => /\/\d{4}-\d{2}-\d{2}$/.test(t)).sort().reverse().slice(0, PAGES_TO_CHECK)
  for (const page of pages) {
    const text = stripComments(await wiki.wikitext(page))
    const box = allTemplates(text).find(t => t.name === 'Event Infobox')
    const start = wikiTime(box?.named.time_start)
    if (nearTime(start, periodStart)) return { page, text, title: plain(box.named.name), start, end: wikiTime(box.named.time_end) }
  }
  return null
}

// Which of these enemies the wiki files under its boss categories
async function bossesAmong(names) {
  const want = [...new Set(names)].slice(0, 50)
  if (!want.length) return new Set()
  const d = await wiki.query({ titles: want.join('|'), prop: 'categories', clcategories: 'Category:Boss Enemies|Category:Notorious Boss Enemies', cllimit: '500', redirects: '1' })
  const back = new Map(want.map(n => [n, n]))
  for (const r of [...(d.query?.normalized || []), ...(d.query?.redirects || [])]) if (back.has(r.from)) back.set(r.to, back.get(r.from))
  return new Set((d.query?.pages || []).filter(p => p.categories?.length && back.has(p.title)).map(p => back.get(p.title)))
}

// "* effect one\n* effect two" -> ['effect one', 'effect two'], minus the scoring rules every room repeats
const bullets = s => (s || '').split('\n').filter(l => /^\*/.test(l)).map(l => plain(l.replace(/^\*+\s*/, ''))).filter(Boolean)
const isScoringRule = b => /DMG Score|Elimination Score|multiplier bonus|Performance Points/i.test(b)

// ---------- Shiyu Defense ----------
const shiyu = {
  find: periodStart => findPeriod('Shiyu Defense/Critical Node/', periodStart),
  async prepare(period) {
    // Bosses are told apart from regular enemies by their wiki category, so look those up first
    const rooms = allTemplates(period.text).filter(t => t.name === 'Challenge Stage Table')
    const names = rooms.flatMap(r => Object.keys(r.named).filter(k => /^w\d+$/.test(k)).flatMap(k => list(r.named[k], r.named.delim || ',').map(plain)))
    period.bosses = await bossesAmong(names)
  },
  read(period) {
    const fifth = sections(period.text).find(s => /fifth frontier/i.test(s.title))
    const rooms = allTemplates(fifth?.body || '').filter(t => t.name === 'Challenge Stage Table')
    const parts = rooms.map((room, i) => {
      const n = room.named, delim = n.delim || ','
      const waves = Object.keys(n).filter(k => /^w\d+$/.test(k)).sort((a, b) => +a.slice(1) - +b.slice(1)).map(k => list(n[k], delim).map(plain)).filter(w => w.length)
      const all = waves.flat()
      // The boss-category enemy (last one, as bosses come last), else the last wave
      const bosses = [...new Set(all.filter(e => period.bosses?.has(e)))]
      const boss = bosses.length ? bosses[bosses.length - 1] : [...new Set(waves[waves.length - 1] || [])].join(' + ')
      const roomBuffs = bullets(n.det).filter(b => !isScoringRule(b))
      return {
        label: plain(n.node) || `Room ${i + 1}`,
        boss,
        types: attributes(n.eWeak),
        resist: attributes(n.eRes),
        ...(n.eLev ? { level: +n.eLev } : {}),
        ...(roomBuffs.length ? { traits: roomBuffs.map(desc => ({ name: '', desc })), traitsLabel: 'Room buffs' } : {}),
        others: [...new Set(all.filter(e => e !== boss))]
      }
    })
    const frontierInfo = sections(period.text, 3).find(s => /frontier info/i.test(s.title))
    const level = Math.max(0, ...parts.map(p => p.level || 0))
    return {
      title: (period.title || '').replace(/^Shiyu Defense:\s*/i, '') || 'Critical Node',
      typesLabel: 'Weak to',
      effects: bullets(frontierInfo?.body).map((desc, i) => ({ name: `Frontier buff ${i + 1}`, desc })),
      choices: [],
      difficulties: parts.length ? [{ key: 'fifth', name: 'Fifth Frontier', ...(level ? { level } : {}), confirmed: parts.every(p => p.boss && p.types.length), parts }] : []
    }
  }
}

// ---------- Deadly Assault ----------
let specialEffects = null    // Module:Special Effect/data, fetched once per run

const assault = {
  find: periodStart => findPeriod('Deadly Assault/', periodStart),
  async prepare() {
    specialEffects ??= await wiki.wikitext('Module:Special Effect/data').catch(() => '')
  },
  read(period) {
    const stages = sections(period.text, 3).map(s => ({ title: s.title, stage: allTemplates(s.body).find(t => t.name === 'Deadly Assault Stage') })).filter(s => s.stage)
    const toPart = ({ title, stage }) => {
      const n = stage.named
      const mechanics = Object.keys(n).filter(k => /^mechanics\d+$/.test(k)).sort().map(k => plain(n[k])).filter(Boolean)
      return {
        label: title.replace(/^Trial Mode:\s*/i, ''),
        boss: plain(n.enemy),
        types: attributes(n.weakness),
        resist: attributes(n.resistance),
        ...(n.enemylv ? { level: +n.enemylv } : {}),
        ...(n.suggspec ? { note: plain(n.suggspec) } : {}),
        ...(mechanics.length ? { traits: mechanics.map(desc => ({ name: '', desc })), traitsLabel: 'Mechanics' } : {})
      }
    }
    const trial = stages.filter(s => /^trial mode/i.test(s.title)).map(toPart)
    const adversity = stages.filter(s => /adversity/i.test(s.title)).map(toPart)
    const difficulty = (key, name, parts) => {
      const level = Math.max(0, ...parts.map(p => p.level || 0))
      return { key, name, ...(level ? { level } : {}), confirmed: parts.every(p => p.boss && p.types.length), parts }
    }
    const buffs = sections(period.text).find(s => /^buffs$/i.test(s.title))
    const effects = [...(buffs?.body || '').matchAll(/\{\{Special Effect\|([^}|]+)\}\}/g)].map(m => {
      const name = m[1].trim(), e = luaEntry(specialEffects || '', name)
      return { name, desc: e ? [e.eff_1, e.eff_2, e.eff_3].filter(Boolean).map(plain).join('\n') : '' }
    })
    return {
      title: period.title || 'Deadly Assault',
      typesLabel: 'Weak to',
      effects,
      choices: [],
      difficulties: [trial.length && difficulty('trial', 'Trial Mode', trial), adversity.length && difficulty('adversity', 'Adversity Mode', adversity)].filter(Boolean)
    }
  }
}

export default {
  wiki,
  wikiName: 'Zenless Zone Zero Wiki',
  images: { files: ['Enemy {name}.png'], pageImages: true },
  modes: { sd: shiyu, da: assault }
}
