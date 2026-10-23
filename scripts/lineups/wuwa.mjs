// Wuthering Waves lineups, read from the Wuthering Waves Fandom wiki.
//
//   Tower of Adversity: "Tower of Adversity/Floors/2026-01-05" (one page per Hazard Zone rotation).
//   {{Hazard Zone|start|end}} has the dates (no times). Each ===... Tower=== section holds four
//   {{Tower of Adversity Floor}} blocks: floor, level, recattribute, areaeffectdescN, enemies.
//
// Note: the wiki stopped adding rotations after January 2026, so until editors pick it up again the bot
// finds nothing for the current period and the site says so. Whimpering Wastes isn't boss-based, so it's skipped.

import { createWiki, allTemplates, sections, stripComments, plain, wikiTime, list } from '../lib/wiki.mjs'
import { nearTime } from '../lib/schedule.mjs'

const wiki = createWiki('wutheringwaves.fandom.com')
const ATTRIBUTES = ['Spectro', 'Havoc', 'Glacio', 'Fusion', 'Electro', 'Aero']
const PAGES_TO_CHECK = 3

const tower = {
  missingNote: 'The Wuthering Waves wiki stopped adding Tower of Adversity rotations in early 2026, so there is no lineup to show until its editors catch up.',
  async find(periodStart) {
    const pages = (await wiki.listPages('Tower of Adversity/Floors/')).filter(t => /\/\d{4}-\d{2}-\d{2}$/.test(t)).sort().reverse().slice(0, PAGES_TO_CHECK)
    for (const page of pages) {
      const text = stripComments(await wiki.wikitext(page))
      const zone = allTemplates(text).find(t => t.name === 'Hazard Zone')
      const start = wikiTime(zone?.named.start)
      if (nearTime(start, periodStart)) return { page, text, start, end: wikiTime(zone.named.end) }
    }
    return null
  },
  read(period) {
    const allowed = new Map(ATTRIBUTES.map(a => [a.toLowerCase(), a]))
    const difficulties = sections(period.text, 3).filter(s => /Tower$/i.test(s.title)).map(sec => {
      const parts = allTemplates(sec.body).filter(t => t.name === 'Tower of Adversity Floor').map(t => {
        const n = t.named
        const enemies = list(n.enemies).map(plain)
        // The wiki doesn't mark the boss; it is listed last
        const boss = enemies[enemies.length - 1] || ''
        const effects = Object.keys(n).filter(k => /^areaeffectdesc\d+$/.test(k)).sort().map(k => plain(n[k])).filter(Boolean)
        return {
          label: `Floor ${plain(n.floor)}`,
          boss,
          types: [...new Set(list(n.recattribute).map(a => allowed.get(a.toLowerCase())).filter(Boolean))],
          ...(n.level ? { level: +n.level } : {}),
          ...(effects.length ? { traits: effects.map(desc => ({ name: '', desc })), traitsLabel: 'Floor effects' } : {}),
          ...(enemies.length > 1 ? { others: enemies.slice(0, -1) } : {})
        }
      })
      const level = Math.max(0, ...parts.map(p => p.level || 0))
      return { key: sec.title.toLowerCase().replace(/\W+/g, '-'), name: sec.title, ...(level ? { level } : {}), confirmed: parts.length > 0 && parts.every(p => p.boss), parts }
    }).filter(d => d.parts.length)
      .sort((a, b) => (/hazard/i.test(b.name) ? 1 : 0) - (/hazard/i.test(a.name) ? 1 : 0))   // the hardest tower first
    return { title: 'Hazard Zone', typesLabel: 'Recommended', effects: [], choices: [], difficulties }
  }
}

export default {
  wiki,
  wikiName: 'Wuthering Waves Wiki',
  // "<name> Icon.png"; page images sometimes show the enemy's Echo instead
  images: { files: ['{name} Icon.png'], pageImages: false },
  modes: { toa: tower }
}
