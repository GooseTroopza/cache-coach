// Pure rules, from a token-usage analysis of ~169k Claude Code requests:
// cache reads cost 0.1x, a 1h cache write 2x, so a compaction (~0.4M at 900k)
// pays back in ~5 turns at 900k and ~18 at 300k; keep-warm pings beat a
// re-cache only for breaks under ~16h.

export type Config = {
  ttlMs: number
  leadMs: number
  warnAt: number
  compactAt: number
  maxPings: number
}

export type Advice = { icon: string; text: string }

export type Action = 'compact' | 'ping' | 'none'

export type Situation = {
  tokens: number
  lastAt: number
  now: number
  busy: boolean
  keepWarm: boolean
  autoCompact: boolean
  pings: number
  actedFor: number
}

export const k = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`

const ago = (ms: number): string =>
  ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h idle` : `${Math.floor(ms / 60_000)}m idle`

export function advise(tokens: number, window: number, lastAt: number, now: number, cfg: Config): Advice {
  const size = `${k(tokens)}/${k(window)}`
  const idle = now - lastAt
  const isWarm = lastAt > 0 && idle < cfg.ttlMs

  if (!isWarm) {
    const when = lastAt > 0 ? `cache cold (${ago(idle)})` : 'cache not warm'
    if (tokens >= cfg.warnAt) {
      return { icon: '🔵', text: `${size} · ${when} · next message re-caches it at 2× · new task? /clear` }
    }
    return { icon: '🟢', text: `${size} · ${when} · next message caches it` }
  }

  const left = Math.max(0, Math.ceil((cfg.ttlMs - idle) / 60_000))
  const cache = `cache warm ${left}m`
  if (tokens >= cfg.compactAt) {
    return { icon: '🔴', text: `${size} · ${cache} · /compact at this pause, or /clear if the task is done` }
  }
  if (tokens >= cfg.warnAt) {
    const tip = left <= 15 ? 'compact before you step away' : 'compact at the next pause'
    return { icon: '🟡', text: `${size} · ${cache} · ${tip}` }
  }
  return { icon: '🟢', text: `${size} · ${cache} · fine` }
}

// What to do in the last `leadMs` before the cache expires: compact a big
// context first (its new prefix caches on the next real message), otherwise
// ping to keep it warm. Once per warm window (`actedFor` holds its `lastAt`).
export function nextAction(s: Situation, cfg: Config): Action {
  if (s.busy || s.lastAt === 0 || s.actedFor === s.lastAt) return 'none'
  const idle = s.now - s.lastAt
  if (idle < cfg.ttlMs - cfg.leadMs || idle >= cfg.ttlMs) return 'none'
  if (s.autoCompact && s.tokens >= cfg.compactAt) return 'compact'
  if (s.keepWarm && s.pings < cfg.maxPings) return 'ping'
  return 'none'
}
