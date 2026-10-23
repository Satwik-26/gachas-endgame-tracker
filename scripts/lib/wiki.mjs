// Reads endgame pages from a Fandom wiki through its MediaWiki API and parses their templates.
// The HSR wiki keeps each version's endgame on pages like "Pure Fiction/Stages/4.6", written as
// templates ({{Pure Fiction Stage|rtype1=Ice,Imaginary|t1w3=...}}), so no AI is needed to read them.

const USER_AGENT = 'gachas-endgame-tracker/1.0 (+https://github.com/Satwik-26/gachas-endgame-tracker)'

export function createWiki(host) {
  const api = `https://${host}/api.php`
  async function call(params) {
    const url = `${api}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
        if (!res.ok) throw new Error(`Wiki ${res.status} for ${params.action}`)
        return await res.json()
      } catch (e) {
        if (attempt >= 2) throw e
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)))
      }
    }
  }
  return {
    query: params => call({ action: 'query', ...params }),
    pageUrl: title => `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`,
    // Subpage titles under a prefix, e.g. "Pure Fiction/Stages/"
    async listPages(prefix) {
      const d = await call({ action: 'query', list: 'allpages', apprefix: prefix, aplimit: '500' })
      return (d.query?.allpages || []).map(p => p.title)
    },
    async wikitext(title) {
      const d = await call({ action: 'parse', page: title, prop: 'wikitext' })
      return d.parse?.wikitext || ''
    },
    // Picture for each enemy name. Tries each file name pattern in order ("{name}" is replaced), following
    // redirects, then optionally the picture on the enemy's own wiki page. Wikis name their icons differently:
    // HSR/ZZZ "Enemy {name}.png", Genshin/WuWa "{name} Icon.png".
    async enemyImages(names, { files = ['Enemy {name}.png'], pageImages = true, size = 240 } = {}) {
      const out = new Map(), want = [...new Set(names.filter(Boolean))].slice(0, 50)
      // Query some titles and map the results back to the names asked for, through normalising and redirects
      async function lookup(titleOf, params, pick) {
        const todo = want.filter(n => !out.has(n))
        if (!todo.length) return
        const asked = new Map(todo.map(n => [titleOf(n), n]))
        const d = await call({ action: 'query', titles: [...asked.keys()].join('|'), redirects: '1', ...params })
        const back = new Map(asked)
        for (const r of [...(d.query?.normalized || []), ...(d.query?.redirects || [])]) if (back.has(r.from)) back.set(r.to, back.get(r.from))
        for (const page of d.query?.pages || []) { const url = pick(page); if (url && back.has(page.title)) out.set(back.get(page.title), url) }
      }
      for (const pattern of files) {
        await lookup(n => `File:${pattern.replace('{name}', n)}`, { prop: 'imageinfo', iiprop: 'url', iiurlwidth: String(size) },
          page => page.imageinfo?.[0]?.thumburl || page.imageinfo?.[0]?.url)
      }
      if (pageImages) await lookup(n => n, { prop: 'pageimages', piprop: 'thumbnail', pithumbsize: String(size) }, page => page.thumbnail?.source)
      return out
    }
  }
}

// ---------- Template parsing ----------
// Index just past the "}}" that closes the template opening at i
function closeOf(text, i) {
  let depth = 0
  for (let j = i; j < text.length - 1; j++) {
    if (text.startsWith('{{', j)) { depth++; j++ }
    else if (text.startsWith('}}', j)) { depth--; j++; if (depth === 0) return j + 1 }
  }
  return -1
}

// "{{Name|a=1|b|c=[[x|y]]}}" -> { name, named: {a, c}, positional: [b], raw }
function parseTemplate(raw) {
  const inner = raw.slice(2, -2), parts = []
  let depth = 0, link = 0, cur = ''
  for (let j = 0; j < inner.length; j++) {
    const two = inner.slice(j, j + 2)
    if (two === '{{' || two === '[[' || two === '}}' || two === ']]') {
      if (two === '{{') depth++; else if (two === '}}') depth--; else if (two === '[[') link++; else link--
      cur += two; j++; continue
    }
    if (inner[j] === '|' && depth === 0 && link === 0) { parts.push(cur); cur = ''; continue }
    cur += inner[j]
  }
  parts.push(cur)
  const name = parts.shift().trim(), named = {}, positional = []
  for (const p of parts) {
    const m = !p.trim().startsWith('{{') && p.match(/^\s*([\w ]+?)\s*=([\s\S]*)$/)
    if (m) named[m[1]] = m[2].trim(); else positional.push(p.trim())
  }
  return { name, named, positional, raw }
}

// Templates at the top level of some text, in order
export function topTemplates(text) {
  const out = []
  for (let i = text.indexOf('{{'); i !== -1;) {
    const end = closeOf(text, i)
    if (end === -1) break
    out.push(parseTemplate(text.slice(i, end)))
    i = text.indexOf('{{', end)
  }
  return out
}

// Every template, including ones nested inside other templates' values
export function allTemplates(text) {
  return topTemplates(text).flatMap(t => [t, ...[...t.positional, ...Object.values(t.named)].flatMap(v => v.includes('{{') ? allTemplates(v) : [])])
}

export const stripComments = text => text.replace(/<!--[\s\S]*?-->/g, '')

// Sections at one heading level ("==Title==" for 2, "===Title===" for 3) with their text
export function sections(text, level = 2) {
  const eq = '='.repeat(level), out = [], re = new RegExp(`^${eq}([^=].*?)${eq}\\s*$`, 'gm')
  let m, last = null
  while ((m = re.exec(text))) {
    if (last) last.body = text.slice(last.start, m.index)
    last = { title: m[1].trim(), start: re.lastIndex }
    out.push(last)
  }
  if (last) last.body = text.slice(last.start)
  return out
}

// Wiki markup -> plain text
export function plain(s = '') {
  let t = s.replace(/<ref[^>]*\/>/g, '').replace(/<ref[\s\S]*?<\/ref>/g, '').replace(/<br\s*\/?>/gi, '\n')
    .replace(/\{\{Colon\}\}/gi, ':').replace(/\{\{!\}\}/g, '|')
  for (let k = 0; k < 5 && /\{\{/.test(t); k++) {
    t = t.replace(/(\{\{[^{}]*?)\|\s*\w+\s*=[^|{}]*(?=[|}])/g, '$1')       // drop named args like |nobold=1
      .replace(/\{\{(?:Color|Enemy|Item|Character|Element|Elements)\|(?:[^|{}]*\|)?([^|{}]*)\}\}/gi, '$1')
      .replace(/\{\{[^{}]*\}\}/g, '')
  }
  return t.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'{2,}/g, '').replace(/<[^>]+>/g, '')
    .replace(/\\\s*$/, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim()
}

// String values from a Lua data module: ['Frigidity'] = { eff_1 = "...", eff_2 = "..." } -> { eff_1, eff_2 }
export function luaEntry(source, key) {
  const start = source.indexOf(`['${key.replace(/'/g, "\\'")}']`)
  if (start === -1) return null
  // The entry's closing brace, skipping braces inside strings (descriptions contain "{{Color|...}}")
  let end = source.indexOf('{', start), inString = false
  for (; end !== -1 && end < source.length; end++) {
    const c = source[end]
    if (inString) { if (c === '\\') end++; else if (c === '"') inString = false }
    else if (c === '"') inString = true
    else if (c === '}') break
  }
  const body = source.slice(start, end)
  return Object.fromEntries([...body.matchAll(/(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map(m => [m[1], m[2].replace(/\\(.)/g, '$1')]))
}

// "a; b;; c" -> ['a', 'b', 'c']
export const list = (s, sep = ',') => (s || '').split(sep).map(x => x.trim()).filter(Boolean)

// "2026/09/28 06:00:00 GMT+8" or "2026-09-28 06:00:00" -> "2026-09-28T06:00" (server-local, like resets.json).
// Date-only values ("2026-10-16") get the usual 04:00 reset time.
export function wikiTime(s = '') {
  const m = s.match(/(\d{4})[/-](\d{2})[/-](\d{2})(?:[\sT]+(\d{2}):(\d{2}))?/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4] || '04'}:${m[5] || '00'}` : null
}
