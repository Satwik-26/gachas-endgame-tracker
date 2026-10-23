// Schedule math shared by the bots. Works in server-local time on the Asia server clock:
// "2026-09-28T04:00" is parsed as if it were UTC, and "now" is shifted by +8h to match.
// Keep in step with monthlyPeriod/cyclePeriod in index.html.

export const HOUR = 3600000, DAY = 24 * HOUR

export const toMs = s => Date.parse(s + ':00Z')              // server-local string -> comparable ms
export const toStr = ms => new Date(ms).toISOString().slice(0, 16)
export const serverNow = () => Date.now() + 8 * HOUR

// The period a mode is in right now, as { prev, next } (prev = when it started).
// An override replaces the regular reset nearest to it, and the cycle carries on
// from the latest override that has passed.
export function currentPeriod(mode, now = serverNow()) {
  if (mode.type === 'monthly') {
    const d = new Date(now), at = k => Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, mode.day, mode.hour ?? 4)
    return now < at(0) ? { prev: at(-1), next: at(0) } : { prev: at(0), next: at(1) }
  }
  const cycle = mode.days * DAY
  const points = [mode.anchor, ...(mode.overrides || []).map(o => o.date)].map(toMs).sort((a, b) => a - b)
  const past = points.filter(p => p <= now)
  const upcoming = points.find(p => p > now)
  if (!past.length) return { prev: upcoming - cycle, next: upcoming }
  const base = past[past.length - 1]
  const prev = base + Math.floor((now - base) / cycle) * cycle
  if (upcoming !== undefined) {
    const replaced = base + Math.max(1, Math.round((upcoming - base) / cycle)) * cycle
    if (prev + cycle >= replaced) return { prev: replaced - cycle, next: upcoming }
  }
  return { prev, next: prev + cycle }
}

export const nextOnSchedule = mode => currentPeriod(mode).next
