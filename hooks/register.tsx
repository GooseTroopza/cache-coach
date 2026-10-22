import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { advise, k, nextAction, type Config } from './advice'

type $ = EngineInterface

// Refs for $.state calls in the helpers below; atoms for the hooks' read/update.
const SNAP = { plugin: 'cache-coach', key: 'snap' } as const
const NOW = { plugin: 'cache-coach', key: 'now' } as const
const BUSY = { plugin: 'cache-coach', key: 'busy' } as const
const KEEP_WARM = { plugin: 'cache-coach', key: 'keepWarm' } as const
const AUTO_COMPACT = { plugin: 'cache-coach', key: 'autoCompact' } as const
const PINGS = { plugin: 'cache-coach', key: 'pings' } as const
const ACTED_FOR = { plugin: 'cache-coach', key: 'actedFor' } as const
const NOTE = { plugin: 'cache-coach', key: 'note' } as const

const snap = atom(SNAP, null)
const now = atom(NOW, 0)
const busy = atom(BUSY, false)
const keepWarm = atom(KEEP_WARM, false)
const autoCompact = atom(AUTO_COMPACT, true)
const pings = atom(PINGS, 0)
const note = atom(NOTE, '')

const KEEP =
  'Keep: the task in progress and its next step, decisions made, open questions, ' +
  'file paths touched, exact figures and IDs, and anything the user asked to remember.'

const PING =
  '[cache-coach keep-warm] This only keeps the prompt cache warm while you are away. ' +
  'No action needed: reply with just "ok", call no tools, and change nothing.'

const STORE_TTL_MS = 3 * 24 * 3_600_000

const num = (v: PluginOptions[string] | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback

const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function storeKey($: $): Promise<string> {
  return `last:${await $.session.id()}`
}

// Context size from the status line's figures; `lastAt` when given.
async function refresh($: $, lastAt?: number, tokens?: number): Promise<void> {
  const { context } = await $.session.usage()
  const prev = (await $.state.get(SNAP)).value ?? null
  await $.state.set(SNAP, {
    tokens: tokens ?? context.tokens ?? prev?.tokens ?? 0,
    window: context.window,
    lastAt: lastAt ?? prev?.lastAt ?? 0,
  })
}

async function compactNow($: $, why: string): Promise<boolean> {
  const before = (await $.state.get(SNAP)).value?.tokens ?? 0
  try {
    const r = await $.session.compact({ instructions: KEEP })
    if (r.skip !== undefined) {
      await $.state.set(NOTE, `compact skipped: ${r.skip}`)
      return false
    }
    // The compacted prefix is cached by the next real request, so it is not warm yet.
    await refresh($, 0, r.tokensAfter)
    const after = (await $.state.get(SNAP)).value?.tokens ?? 0
    const t = await $.clock.now()
    await $.state.set(NOTE, `${why} ${k(before)} → ${k(after)} at ${hhmm(t)}`)
    return true
  } catch {
    await $.state.set(NOTE, 'compact refused: a turn is running')
    return false
  }
}

async function tick($: $, cfg: Config): Promise<void> {
  const t = await $.clock.now()
  await $.state.set(NOW, t)
  const s = (await $.state.get(SNAP)).value ?? null
  if (s === null) return
  const situation = {
    tokens: s.tokens,
    lastAt: s.lastAt,
    now: t,
    busy: (await $.state.get(BUSY)).value ?? false,
    keepWarm: (await $.state.get(KEEP_WARM)).value ?? false,
    autoCompact: (await $.state.get(AUTO_COMPACT)).value ?? true,
    pings: (await $.state.get(PINGS)).value ?? 0,
    actedFor: (await $.state.get(ACTED_FOR)).value ?? 0,
  }
  const action = nextAction(situation, cfg)
  if (action === 'none') return
  await $.state.set(ACTED_FOR, s.lastAt)

  if (action === 'compact') {
    const isDone = await compactNow($, 'auto-compacted before cache expiry:')
    if (isDone || !situation.keepWarm) return
  }
  const sent = situation.pings + 1
  await $.state.set(PINGS, sent)
  await $.state.set(NOTE, sent >= cfg.maxPings ? `keep-warm ping ${sent} (last one)` : `keep-warm ping ${sent} at ${hhmm(t)}`)
  await $.prompt.submit({ text: PING })
}

async function start($: $, cfg: Config, isAutoByDefault: boolean): Promise<void> {
  const held = await $.state.get(AUTO_COMPACT)
  if (held.version === 0) await $.state.set(AUTO_COMPACT, isAutoByDefault)

  const t = await $.clock.now()
  for (const key of await $.store.keys()) {
    const at = await $.store.get(key)
    if (key.startsWith('last:') && (typeof at !== 'number' || t - at > STORE_TTL_MS)) await $.store.delete(key)
  }
  const saved = await $.store.get(await storeKey($))
  await refresh($, typeof saved === 'number' ? saved : undefined)
  await $.state.set(NOW, t)

  $.clock.every(60_000, () => void tick($, cfg))
}

async function turnEnded($: $): Promise<void> {
  const t = await $.clock.now()
  await $.state.set(BUSY, false)
  await $.state.set(NOW, t)
  await refresh($, t)
  await $.store.set(await storeKey($), t)
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    ttlMs: num(options.ttlMinutes, 60) * 60_000,
    leadMs: num(options.leadMinutes, 5) * 60_000,
    warnAt: num(options.warnAtTokens, 300_000),
    compactAt: num(options.compactAtTokens, 400_000),
    maxPings: num(options.keepAliveMaxHours, 8),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($, cfg, options.autoCompactDefault !== false)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, busy, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) await turnEnded($)
    return done
  })

  // Someone, not this mod, is talking again: the keep-warm budget starts over.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') await update($, pings, () => 0)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A /compact or an auto-compaction of the main thread: new size, not warm yet.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && r.skip === undefined) {
      await refresh($, 0, r.tokensAfter)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined || s === null || s.tokens === 0) {
      return next(e)
    }
    const t = Math.max(await read($, now), s.lastAt)
    const isWarming = await read($, keepWarm)
    const isAuto = await read($, autoCompact)
    const said = await read($, note)
    const a = advise(s.tokens, s.window, s.lastAt, t, cfg)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {a.icon} {a.text}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="keep-warm"
            plain
            label={`${isWarming ? '☑' : '☐'} keep warm`}
            onPress={() => update($, keepWarm, v => !v)}
          />
          <Button
            key="auto-compact"
            plain
            label={`${isAuto ? '☑' : '☐'} auto-compact ≥${k(cfg.compactAt)} before expiry`}
            onPress={() => update($, autoCompact, v => !v)}
          />
          {s.tokens >= cfg.warnAt && !e.props.isWorking && (
            <Button key="compact-now" label="Compact now" onPress={() => compactNow($, 'compacted')} />
          )}
          {said !== '' && <Text dimColor>{said}</Text>}
        </Box>
      </Box>
    )
  })
}
