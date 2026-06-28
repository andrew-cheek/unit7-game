// Netlify chat client: a tiny poll-based transport for the kid-safe typed chat.
//
// The realtime story here is deliberately humble — a setInterval that GETs new
// messages from the same-origin `chat` Netlify Function. No socket lifecycle, no
// reconnection logic; chat is a low-frequency, parent-gated feature, so a poll is
// plenty and costs nothing when idle. The SERVER is authoritative on filtering
// (Game.ts already pre-filters before calling send), so this client just shuttles
// bytes and de-duplicates what it sees.
//
// Wire shape (the server endpoint already exists):
//   POST /.netlify/functions/chat  body={ room, id, name, text }
//        -> { ok: true } | { ok: false, reason }
//   GET  /.netlify/functions/chat?room=<room>&since=<ts>
//        -> { messages: ChatMessage[] }

import type { ChatMessage } from './kidShared'

/** A minimal start/stop chat transport. `selfId` is exposed (readonly) so the UI
 *  can right-align the local player's own lines without a name-match heuristic. */
export interface ChatClient {
  /** This client's stable per-session id (the ChatMessage `id` it sends under). */
  readonly selfId: string
  /** Best-effort send of a filtered line. Never throws; fire-and-forget. */
  send(name: string, text: string): void
  /** Begin polling; `onMessage` fires once per newly-seen message. */
  start(onMessage: (m: ChatMessage) => void): void
  /** Stop polling. Safe to call repeatedly; a later start() resumes cleanly. */
  stop(): void
}

const DEFAULT_ROOM = 'global'
const DEFAULT_POLL_MS = 1500

/** Generate a stable-per-session id: 'c' + 12 base36 chars. Not an identity —
 *  just enough to dedupe and to tag the sender's own messages for the UI. */
function makeSelfId(): string {
  let s = ''
  while (s.length < 12) s += Math.random().toString(36).slice(2)
  return 'c' + s.slice(0, 12)
}

/**
 * Build a poll-based ChatClient against the same-origin Netlify `chat` function.
 *
 * @param opts.room    chat room key (default 'global').
 * @param opts.pollMs  poll interval in ms (default 1500).
 * @param opts.selfId  override the generated session id (e.g. reuse the anon id).
 *
 * Design notes:
 *  - since-tracking: each poll GETs `?since=<lastTs>` and `lastTs` advances to the
 *    max `t` seen, so subsequent polls only ask for strictly-newer messages.
 *  - join-seed: `lastTs` is seeded to Date.now() at start(), so a joiner only sees
 *    messages posted AFTER they opened chat. This intentionally avoids replaying
 *    old logs (no flood, no stale context) at the cost of not back-filling history.
 *  - dedupe: even with since-tracking, a message with t === lastTs could be
 *    re-fetched at a boundary, so every delivered message is recorded by
 *    `id + ':' + t` and never delivered twice.
 *  - overlap guard: if a poll's fetch is still in flight when the next tick fires,
 *    that tick is skipped (no piling up requests on a slow network).
 *  - SSR-safe: no-ops where `fetch` / `setInterval` are unavailable.
 */
export function netlifyChatClient(opts?: { room?: string; pollMs?: number; selfId?: string }): ChatClient {
  const room = opts?.room ?? DEFAULT_ROOM
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS
  const selfId = opts?.selfId ?? makeSelfId()

  let timer: ReturnType<typeof setInterval> | null = null
  let lastTs = 0 // highest message `t` seen so far (the GET `since` cursor)
  let fetching = false // overlap guard: a poll request is on the wire
  const seen = new Set<string>() // dedupe keys: `${id}:${t}`
  let handler: ((m: ChatMessage) => void) | null = null

  const poll = async (): Promise<void> => {
    if (fetching) return // skip — previous poll hasn't resolved yet
    fetching = true
    try {
      const res = await fetch(`/.netlify/functions/chat?room=${encodeURIComponent(room)}&since=${lastTs}`, {
        method: 'GET',
      })
      if (!res.ok) return
      const json = (await res.json()) as { messages?: ChatMessage[] } | null
      const messages = json?.messages
      if (!messages || messages.length === 0) return
      for (const m of messages) {
        if (!m || typeof m.t !== 'number') continue
        const key = `${m.id}:${m.t}`
        if (seen.has(key)) continue // already delivered this exact line
        seen.add(key)
        if (m.t > lastTs) lastTs = m.t // advance the cursor
        handler?.(m)
      }
    } catch {
      // Network blip — the next tick retries from the same cursor. Chat is
      // best-effort; a dropped poll is harmless.
    } finally {
      fetching = false
    }
  }

  return {
    selfId,

    send(name: string, text: string): void {
      if (typeof fetch === 'undefined') return
      // Fire-and-forget: the server re-filters and is authoritative, so we ignore
      // the response body. Swallow any error — send must never throw at the caller.
      void fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room, id: selfId, name, text }),
      }).catch(() => {})
    },

    start(onMessage: (m: ChatMessage) => void): void {
      if (typeof setInterval === 'undefined' || typeof fetch === 'undefined') return
      this.stop() // idempotent: re-starting replaces any existing poll
      handler = onMessage
      // Join-seed: only deliver messages from when chat was opened (no log replay).
      lastTs = Date.now()
      timer = setInterval(() => void poll(), pollMs)
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      handler = null
    },
  }
}
