// Wuthering Waves lineups. The Fandom wiki stopped adding Tower of Adversity rotations in early 2026,
// so this reads two other public sources instead:
//
//   encore.moe (fan database, JSON):  https://api-v2.encore.moe/api/en/toa       season list with start/finish dates
//                                     https://api-v2.encore.moe/api/en/toa/<id>  { <id>: { area: { floor: { cost: [entry] } } } }
//     entry: areaName, floor, difficulty, monsters[{ name, rarity.id (3+ = boss class), icon }], buffs[{ desc (HTML) }]
//   Arikatsu/WutheringWaves_Data (raw game tables on GitHub): BinData/tower/towerconfig.json
//     rows: Season, Difficulty, AreaNum, Floor, RecommendElement (element ids) — the game's own recommended attributes
//
// Neither has enemy levels, which are fixed per tower, so they come from a small table.
// The season's "current" flag on encore.moe isn't reliable, so the season is picked by its dates.
// Whimpering Wastes isn't boss-based, so it's skipped.

import { plain } from '../lib/wiki.mjs'
import { nearTime } from '../lib/schedule.mjs'

const USER_AGENT = 'gachas-endgame-tracker/1.0 (+https://github.com/Satwik-26/gachas-endgame-tracker)'
const ENCORE_HOSTS = ['https://api-v2.encore.moe/api/en', 'https://api.encore.moe/en']
const GAME_TABLE = 'https://raw.githubusercontent.com/Arikatsu/WutheringWaves_Data/master/BinData/tower/towerconfig.json'
const ATTRIBUTES = ['Spectro', 'Havoc', 'Glacio', 'Fusion', 'Electro', 'Aero']
const ELEMENT_IDS = { 1: 'Glacio', 2: 'Fusion', 3: 'Electro', 4: 'Aero', 5: 'Spectro', 6: 'Havoc' }   // checked against the buff texts
const LEVELS = { 'Resonant Tower': [70, 75, 80, 90], 'Echoing Tower': [70, 75, 80, 90], 'Hazard Tower': [100, 100, 100, 100] }
const TOWER_ORDER = ['Hazard Tower', 'Resonant Tower', 'Echoing Tower']    // the hardest tower first

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } })
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`)
  return res.json()
}

// Same path on each encore.moe host until one answers
async function encore(path) {
  let last
  for (const host of ENCORE_HOSTS) {
    try { return await getJson(host + path) } catch (e) { last = e }
  }
  throw last
}

// "Enemy Electro RES and Fusion RES are decreased by 10%", "Grants 30% Electro and Fusion DMG Bonus"
function attributesFromBuffs(buffs) {
  const found = new Set()
  for (const b of buffs) {
    for (const m of b.matchAll(/Enemy ([^.]*?) RES (?:and [^.]*? RES )?(?:are |is )?decrease[sd]?/gi)) ATTRIBUTES.filter(a => m[0].includes(a)).forEach(a => found.add(a))
    for (const m of b.matchAll(/([A-Za-z ,]+?) DMG Bonus/g)) ATTRIBUTES.filter(a => m[1].includes(a)).forEach(a => found.add(a))
  }
  return [...found]
}

const tower = {
  async find(periodStart) {
    const { seasons = [] } = await encore('/toa')
    const season = seasons.find(s => s.start && nearTime(`${s.start}T04:00`, periodStart))
    if (!season) return null
    const detail = (await encore(`/toa/${season.id}`))[season.id]
    // The game's recommended attributes; only a nice extra, so a failure here just means guessing from the buffs
    const recommended = await getJson(GAME_TABLE).then(rows => (Array.isArray(rows) ? rows : Object.values(rows)).filter(r => r.Season === season.id)).catch(() => [])
    return {
      page: season.name, title: 'Hazard Zone', start: `${season.start}T04:00`, end: season.finish ? `${season.finish}T04:00` : null,
      season, detail, recommended,
      source: { name: 'encore.moe', url: 'https://encore.moe/toa' }
    }
  },
  read(period) {
    const towers = new Map()
    for (const [area, floors] of Object.entries(period.detail || {})) {
      for (const [floor, byCost] of Object.entries(floors)) {
        const entries = Object.values(byCost).flat()
        const e = entries.find(x => x.difficulty === 3) || entries[entries.length - 1]
        if (!e) continue
        const monsters = (e.monsters || []).filter(m => m.name)
        // Boss-class enemies (rarity 3+) are the bosses; floors without one show their strongest enemy
        const top = Math.max(0, ...monsters.map(m => m.rarity?.id || 0))
        const bosses = top >= 3 ? monsters.filter(m => m.rarity?.id >= 3) : monsters.filter(m => (m.rarity?.id || 0) === top).slice(-1)
        const buffs = (e.buffs || []).map(b => plain(b.desc)).filter(Boolean)
        const row = period.recommended.find(r => r.Difficulty === e.difficulty && r.AreaNum === +area && r.Floor === +floor)
        const types = row ? (row.RecommendElement || []).map(id => ELEMENT_IDS[id]).filter(Boolean) : attributesFromBuffs(buffs)
        const name = plain(e.areaName) || `Tower ${area}`
        const level = LEVELS[name]?.[+floor - 1]
        if (!towers.has(name)) towers.set(name, [])
        towers.get(name).push({
          label: `Floor ${floor}`,
          boss: bosses.map(m => m.name).join(' + '),
          types,
          ...(level ? { level } : {}),
          ...(/^https:\/\/api(-v2)?\.encore\.moe\//.test(bosses[0]?.icon || '') ? { image: bosses[0].icon } : {}),
          ...(buffs.length ? { traits: buffs.map(desc => ({ name: '', desc })), traitsLabel: 'Floor effects' } : {}),
          ...(monsters.length > bosses.length ? { others: [...new Set(monsters.filter(m => !bosses.includes(m)).map(m => m.name))] } : {})
        })
      }
    }
    const difficulties = [...towers].map(([name, parts]) => {
      parts.sort((a, b) => parseInt(a.label.slice(6)) - parseInt(b.label.slice(6)))
      const level = Math.max(0, ...parts.map(p => p.level || 0))
      return { key: name.toLowerCase().replace(/\W+/g, '-'), name, ...(level ? { level } : {}), confirmed: parts.length === 4 && parts.every(p => p.boss), parts }
    }).sort((a, b) => (TOWER_ORDER.indexOf(a.name) + 1 || 9) - (TOWER_ORDER.indexOf(b.name) + 1 || 9))
    return { title: 'Hazard Zone', typesLabel: 'Recommended', effects: [], choices: [], difficulties }
  }
}

export default {
  wikiName: 'encore.moe',
  images: false,     // pictures come with the data
  modes: { toa: tower }
}
