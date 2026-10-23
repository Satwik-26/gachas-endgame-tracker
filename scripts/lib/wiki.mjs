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
    pageUrl: title => `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`,
    // Subpage titles under a prefix, e.g. "Pure Fiction/Stages/"
    async listPages(prefix) {
      const d = await call({ action: 'query', list: 'allpages', apprefix: prefix, aplimit: '500' })
      return (d.query?.allpages || []).map(p => p.title)
    },
    async wikitext(title) {
      const d = await call({ action: 'parse', page: title, prop: 'wikitext' })
      return d.parse?.wikitext || ''
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

// Level-2 sections ("==Title==") with their text
export function sections(text) {
  const out = [], re = /^==([^=].*?)==\s*$/gm
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
  for (let k = 0; k < 5 && /\{\{/.test(t); k++) {
    t = t.replace(/\{\{(?:Color|Enemy|Item|Character)\|(?:[^|{}]*\|)?([^|{}]*)\}\}/gi, '$1').replace(/\{\{[^{}]*\}\}/g, '')
  }
  return t.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'{2,}/g, '').replace(/<[^>]+>/g, '')
    .replace(/\\\s*$/, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim()
}

// "2026/09/28 06:00:00 GMT+8" -> "2026-09-28T06:00" (server-local, like resets.json)
export function wikiTime(s = '') {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : null
}
