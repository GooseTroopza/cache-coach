# cache-coach

A Claude Code mod that helps you spend fewer tokens. It adds a band above the prompt showing how big your context is, how long the prompt cache has left, and what to do about it.

```
🟡 350k/1M · cache warm 12m · compact before you step away
☐ keep warm   ☑ auto-compact ≥400k before expiry   [ Compact now ]
```

## Why

Most of a long session's cost is re-reading its context. Every request reads the whole context again, from the prompt cache at a tenth of the price. Two things make that expensive:

- **Big contexts.** A session that grows to ~1M tokens re-reads ~1M on every turn. Compacting takes it to ~100k. At 900k that pays for itself in about 5 turns; at 300k, in about 18.
- **Cold caches.** The main thread's cache lives for an hour. Come back later and the next message re-writes the whole context at twice the input price. Pinging every hour costs a tenth per ping, so keeping a cache warm is cheaper only for breaks under about 16 hours.

## What it does

| Part | What it does |
|---|---|
| Advice line | Context size, minutes of cache left, and the move: 🟢 fine · 🟡 compact at the next pause · 🔴 `/compact` now, or `/clear` if the task is done · 🔵 cache already cold |
| ☐ keep warm | Sends a tiny "reply ok" prompt 5 minutes before the cache expires. At most 8 per break, then it stops. Any prompt of yours resets the count |
| ☑ auto-compact | When the context is at least 400k and the cache is about to expire, it compacts while the cache is still warm. The summary keeps the task, decisions, open questions, files touched and exact figures |
| Compact now | Shows from 300k when no turn is running |

## Install

At the prompt of a terminal session:

```
/plugin install cache-coach --marketplace GooseTroopza/cache-coach
```

From a shell:

```bash
claude plugin install cache-coach --marketplace GooseTroopza/cache-coach
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `GooseTroopza/cache-coach`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Settings

Each is a row in `/config` once installed.

| Setting | Default | |
|---|---|---|
| `ttlMinutes` | 60 | How long the main thread's cache lives |
| `leadMinutes` | 5 | How long before expiry keep-warm and auto-compact act |
| `warnAtTokens` | 300000 | From here it suggests compacting |
| `compactAtTokens` | 400000 | From here auto-compact acts |
| `keepAliveMaxHours` | 8 | Keep-warm pings per break before it stops |
| `autoCompactDefault` | true | Whether auto-compact starts ticked |

## Good to know

- Timers stop while the computer sleeps, so nothing fires then. The cache expires anyway.
- Keep-warm pings show in the transcript as short turns.
- The band appears after a session's first reply, once there is a usage reading.
- Auto-compaction runs while you are away and is lossy: leave it unticked in sessions where exact earlier detail matters.

## Develop

```bash
claude plugin validate .
claude plugin test .
```
