// Polling-based chat relay on Netlify Blobs, with the kid-safety filter applied
// SERVER-SIDE. Replaces the PartyKit WebSocket chat path: clients POST a message
// and GET recent ones every ~1.5s.
//
// Netlify Functions v2 signature:
//   export default async (req, context) => Response
//
// Endpoint contract:
//   POST /.netlify/functions/chat   body { room, id, name, text }
//     - validate room (/^[a-z0-9]{1,24}$/i, default "main"), id (/^[a-z0-9]{6,40}$/i),
//       text (non-empty string). Bad input -> 400.
//     - run filterChat(text); if blocked -> 200 { ok:false, reason } (NOT stored).
//     - sanitize name server-side (see cleanName).
//     - per-id rate limit (>=800ms between accepted msgs) -> 200 { ok:false, reason:'spam' }.
//     - else append to the room ring buffer (keep last 60), store -> 200 { ok:true }.
//   GET  ?room=<room>&since=<ts>    -> 200 { messages } with t > since (since=0 default),
//                                       oldest-first, capped at 60. Unknown room -> { messages: [] }.
//   any other method                -> 405.
// All responses are JSON, same-origin.

import { getStore } from '@netlify/blobs'
// Reuse the hardened, audited kid-safety filter. It only imports a TYPE from
// kidShared (plus CHAT_MAX_LEN), so it bundles cleanly into the function (the
// esbuild check in the task brief proves this). If it ever fails to bundle, the
// fallback is to inline a minimal copy here.
import { filterChat } from '../../src/game/chatSafety'

// ChatMessage shape, replicated inline (no cross-boundary import of values).
interface ChatMessage {
  id: string
  name: string
  text: string
  t: number
}

// Per-room stored value: the ring buffer plus last-accepted timestamps per id
// (used for rate limiting). lastAt is pruned of stale entries on every write so
// it can't grow unbounded.
interface RoomBlob {
  msgs: ChatMessage[]
  lastAt: Record<string, number>
}

const STORE_NAME = 'unit7-chat'
const ROOM_RE = /^[a-z0-9]{1,24}$/i
const ID_RE = /^[a-z0-9]{6,40}$/i
const MAX_MSGS = 60
const MIN_INTERVAL_MS = 800 // anti-spam: min gap between a player's accepted messages
const LAST_AT_TTL_MS = 60_000 // prune rate-limit entries older than this
const NAME_MAX_LEN = 16

const JSON_HEADERS = { 'content-type': 'application/json' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function keyFor(room: string): string {
  return `room:${room.toLowerCase()}`
}

// Normalize a room param: default to "main" when missing/invalid.
function resolveRoom(raw: string | null): string {
  const r = (raw ?? '').trim()
  return ROOM_RE.test(r) ? r : 'main'
}

// Coerce a stored/missing/corrupt blob into a well-formed RoomBlob.
function coerceBlob(raw: unknown): RoomBlob {
  if (!isPlainObject(raw)) return { msgs: [], lastAt: {} }
  const msgsRaw = Array.isArray(raw.msgs) ? raw.msgs : []
  const msgs: ChatMessage[] = []
  for (const m of msgsRaw) {
    if (
      isPlainObject(m) &&
      typeof m.id === 'string' &&
      typeof m.name === 'string' &&
      typeof m.text === 'string' &&
      typeof m.t === 'number'
    ) {
      msgs.push({ id: m.id, name: m.name, text: m.text, t: m.t })
    }
  }
  const lastAt: Record<string, number> = {}
  if (isPlainObject(raw.lastAt)) {
    for (const [k, v] of Object.entries(raw.lastAt)) {
      if (typeof v === 'number') lastAt[k] = v
    }
  }
  return { msgs, lastAt }
}

// SANITIZE the display name server-side so a kid can't smuggle contact info via
// the name field: trim to 16 chars, and if it contains 4+ consecutive digits OR
// the kid-safety filter rejects it, fall back to a neutral "PILOT".
function cleanName(raw: unknown): string {
  const name = (typeof raw === 'string' ? raw : '').trim().slice(0, NAME_MAX_LEN)
  if (name.length === 0) return 'PILOT'
  if (/\d{4,}/.test(name)) return 'PILOT'
  if (!filterChat(name).allowed) return 'PILOT'
  return name
}

export default async (req: Request, _context: unknown): Promise<Response> => {
  try {
    const url = new URL(req.url)
    const store = getStore(STORE_NAME)

    // --- GET: poll recent messages ------------------------------------------
    if (req.method === 'GET') {
      const room = resolveRoom(url.searchParams.get('room'))
      const sinceRaw = Number(url.searchParams.get('since'))
      const since = Number.isFinite(sinceRaw) ? sinceRaw : 0

      let stored: unknown = null
      try {
        stored = await store.get(keyFor(room), { type: 'json' })
      } catch {
        stored = null
      }
      const blob = coerceBlob(stored)
      // Oldest-first, only newer than `since`, capped at the buffer size.
      const messages = blob.msgs.filter((m) => m.t > since).slice(-MAX_MSGS)
      return json({ messages })
    }

    // --- POST: submit a message ---------------------------------------------
    if (req.method === 'POST') {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return json({ error: 'invalid JSON' }, 400)
      }
      if (!isPlainObject(body)) return json({ error: 'invalid body' }, 400)

      const room = resolveRoom(typeof body.room === 'string' ? body.room : null)
      const id = typeof body.id === 'string' ? body.id : ''
      const text = body.text

      if (!ID_RE.test(id)) return json({ error: 'invalid id' }, 400)
      if (typeof text !== 'string' || text.trim().length === 0) {
        return json({ error: 'invalid text' }, 400)
      }

      // Server-side kid-safety filter. Blocked text is NEVER stored.
      const v = filterChat(text)
      if (!v.allowed) return json({ ok: false, reason: v.reason })

      const name = cleanName(body.name)

      const key = keyFor(room)
      let stored: unknown = null
      try {
        stored = await store.get(key, { type: 'json' })
      } catch {
        stored = null
      }
      const blob = coerceBlob(stored)

      const now = Date.now()

      // Per-id rate limit: reject if the last accepted message was too recent.
      const last = blob.lastAt[id]
      if (typeof last === 'number' && now - last < MIN_INTERVAL_MS) {
        return json({ ok: false, reason: 'spam' })
      }

      // Append the cleaned line and trim to the most recent 60.
      blob.msgs.push({ id, name, text: v.text, t: now })
      if (blob.msgs.length > MAX_MSGS) {
        blob.msgs = blob.msgs.slice(-MAX_MSGS)
      }

      // Record this id's accept time, then prune stale lastAt entries so the map
      // can't grow unbounded as players come and go.
      blob.lastAt[id] = now
      for (const [k, ts] of Object.entries(blob.lastAt)) {
        if (now - ts > LAST_AT_TTL_MS) delete blob.lastAt[k]
      }

      // Read-modify-write: two concurrent POSTs to the same room can race and one
      // append may be lost (last writer wins). Acceptable at this scale — a 60-line
      // chat buffer polled every ~1.5s. No locking primitive on Blobs to avoid it.
      await store.setJSON(key, blob)
      return json({ ok: true })
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  }
}
