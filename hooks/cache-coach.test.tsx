import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { advise, nextAction, type Config } from './advice'

const MIN = 60_000
const CFG: Config = { ttlMs: 60 * MIN, leadMs: 5 * MIN, warnAt: 300_000, compactAt: 400_000, maxPings: 8 }

const BAND = {
  plugin: 'cache-coach',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

// The engine beneath the mod: a context of `tokens`, compactions and prompts recorded.
function engine(on: On, tokens: { now: number }) {
  const compacted: string[] = []
  const submitted: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: tokens.now, window: 1_000_000 }, rateLimits: [] },
  }))
  on('session.compact', (_, e) => {
    compacted.push(e.instructions ?? '')
    const summary: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }
    return { messages: [summary], tokensBefore: tokens.now, tokensAfter: 110_000 }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { compacted, submitted }
}

async function oneTurn($: Parameters<TestBody>[0], id: string) {
  await $.turn.start({ text: 'hi', turnId: id })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: id, reason: 'answer' })
}

test('advice follows the payback rules', () => {
  expect(advise(150_000, 1e6, 1, 1 + 10 * MIN, CFG).icon).toBe('🟢')
  expect(advise(350_000, 1e6, 1, 1 + 10 * MIN, CFG).text).toContain('compact at the next pause')
  expect(advise(350_000, 1e6, 1, 1 + 50 * MIN, CFG).text).toContain('compact before you step away')
  expect(advise(812_000, 1e6, 1, 1 + 10 * MIN, CFG).text).toContain('cache warm 50m')
  expect(advise(812_000, 1e6, 1, 1 + 3 * 60 * MIN, CFG).text).toContain('cache cold (3h idle)')

  const base = { tokens: 500_000, lastAt: 1, now: 1 + 56 * MIN, busy: false, keepWarm: false, autoCompact: true, pings: 0, actedFor: 0 }
  expect(nextAction(base, CFG)).toBe('compact')
  expect(nextAction({ ...base, now: 1 + 30 * MIN }, CFG)).toBe('none')
  expect(nextAction({ ...base, now: 1 + 61 * MIN }, CFG)).toBe('none')
  expect(nextAction({ ...base, busy: true }, CFG)).toBe('none')
  expect(nextAction({ ...base, actedFor: 1 }, CFG)).toBe('none')
  expect(nextAction({ ...base, tokens: 200_000 }, CFG)).toBe('none')
  expect(nextAction({ ...base, tokens: 200_000, keepWarm: true }, CFG)).toBe('ping')
  expect(nextAction({ ...base, tokens: 200_000, keepWarm: true, pings: 8 }, CFG)).toBe('none')
})

test('a big idle context is compacted just before the cache expires', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const seen = engine(on, { now: 500_000 })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($, 't1')

  await clock.advance(50 * MIN)
  expect(seen.compacted.length).toBe(0)
  await clock.advance(6 * MIN)
  expect(seen.compacted.length).toBe(1)
  expect(seen.compacted[0]).toContain('decisions made')

  // Once per warm window, and nothing more while the compacted context is not yet cached.
  await clock.advance(120 * MIN)
  expect(seen.compacted.length).toBe(1)
  expect(seen.submitted.length).toBe(0)
})

test('keep warm pings before expiry, once per window, until the cap', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const seen = engine(on, { now: 200_000 })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($, 't1')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /200k\/1M/ }))?.text).toContain('fine')
  await ui.press({ key: 'keep-warm' })
  await ui.unmount()

  await clock.advance(56 * MIN)
  expect(seen.submitted.length).toBe(1)
  expect(seen.submitted[0]).toContain('keep-warm')
  expect(seen.compacted.length).toBe(0)

  // The ping's own turn warms the cache again; the next ping comes ~55 min later.
  await oneTurn($, 't2')
  await clock.advance(30 * MIN)
  expect(seen.submitted.length).toBe(1)
  await clock.advance(26 * MIN)
  expect(seen.submitted.length).toBe(2)
})

test('the band draws on every surface and offers Compact now when big', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, { now: 812_000 })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await oneTurn($, 't1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = await ui.find({ type: 'Text', text: /812k\/1M/ })
    expect(line?.text).toContain('/compact at this pause')
    expect(await ui.find({ key: 'compact-now' })).toBeDefined()
    expect(await ui.find({ key: 'auto-compact' })).toBeDefined()
    await ui.unmount()
  }
})
