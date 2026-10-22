// What the band draws from: the main thread's context size and when its
// prompt cache was last written or read (0 = not known to be warm).
export type CoachSnap = { tokens: number; window: number; lastAt: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-coach': {
      snap: CoachSnap | null
      now: number
      busy: boolean
      keepWarm: boolean
      autoCompact: boolean
      pings: number
      actedFor: number
      note: string
    }
  }
}
