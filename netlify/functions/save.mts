// Anonymous game-save backend on Netlify Blobs.
//
// Replaces the PartyKit save party so saves ride the existing git -> Netlify
// pipeline (no separate deploy). Netlify Functions v2 signature:
//   export default async (req, context) => Response
//
// Endpoint contract (the client transport in src/game matches this):
//   GET  ?id=<anonId>            -> 200 { data: SaveBlob } if a save exists,
//                                       else 200 {} (empty object = no save)
//   POST ?id=<anonId> + SaveBlob -> 200 { rev: <newRev> } (server-side merge,
//                                       rev bumped, blob stored)
//   any other method             -> 405
// All responses are JSON (content-type: application/json), same-origin.

import { getStore } from '@netlify/blobs'

// Replicated inline from src/game/kidShared.ts (no cross-boundary import).
interface SaveBlob {
  v: 1
  rev: number
  updatedAt: number
  data: Record<string, unknown>
}

const STORE_NAME = 'unit7-saves'
const ID_RE = /^[a-z0-9]{16,40}$/i
const MAX_BODY_BYTES = 64 * 1024
const MAX_MERGED_BYTES = 64 * 1024 // reject a merged blob larger than this
const MAX_ARRAY_UNION = 500 // cap array-union length to bound growth
const MAX_MERGE_DEPTH = 12 // cap recursion depth to prevent stack blowups

// Prototype-pollution sentinels: never copy/merge/store these keys.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Origins allowed to issue cross-site POSTs. Same-origin / no-Origin / localhost
// are also allowed (handled in originAllowed).
const ALLOWED_ORIGINS = new Set([
  'https://unit7.humanoidrobots.com',
  'https://humanoidrobots.com',
])

const JSON_HEADERS = { 'content-type': 'application/json' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// CSRF/origin guard for state-changing POSTs. Reject only when an Origin header
// is present AND not allowlisted. Missing Origin (same-origin fetches, server
// callers) and localhost (dev) are allowed.
function originAllowed(origin: string | null): boolean {
  if (!origin) return true
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    const host = new URL(origin).hostname
    if (host === 'localhost' || host === '127.0.0.1') return true
  } catch {
    return false
  }
  return false
}

// Deep merge of two save payloads so two devices converge to the same state.
// Mirrors the client merge rules:
//   numeric scalars -> MAX
//   booleans        -> OR
//   arrays          -> union, deduped by JSON.stringify
//   plain-object maps (games/highScores/bestTimes) -> per-key recursive merge
//   type mismatch / "current-selection" string fields -> newer updatedAt wins
function mergeValue(a: unknown, b: unknown, aNewer: boolean, depth: number): unknown {
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b)
  if (typeof a === 'boolean' && typeof b === 'boolean') return a || b
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const item of [...a, ...b]) {
      // Cap union length to bound runaway growth from a hostile client.
      if (out.length >= MAX_ARRAY_UNION) break
      const k = JSON.stringify(item)
      if (!seen.has(k)) {
        seen.add(k)
        out.push(item)
      }
    }
    return out
  }
  // Beyond the depth cap, stop recursing: take the incoming/newer value as-is.
  if (depth >= MAX_MERGE_DEPTH) return aNewer ? a : b
  if (isPlainObject(a) && isPlainObject(b)) return mergeMap(a, b, aNewer, depth + 1)
  // Type mismatch, or a string "current-selection" field: newer side wins.
  return aNewer ? a : b
}

function mergeMap(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  aNewer: boolean,
  depth: number
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // Prototype-pollution strip: never copy/merge these keys.
    if (FORBIDDEN_KEYS.has(key)) continue
    const hasA = key in a
    const hasB = key in b
    if (hasA && hasB) out[key] = mergeValue(a[key], b[key], aNewer, depth)
    else out[key] = hasA ? a[key] : b[key]
  }
  return out
}

function mergeBlobs(stored: SaveBlob, incoming: SaveBlob): SaveBlob {
  const now = Date.now()
  // Server-authoritative "newer wins": compare the STORED updatedAt against the
  // server clock, NOT the client-supplied incoming.updatedAt. A client cannot
  // poison the comparison by sending a far-future timestamp.
  const storedNewer = (stored.updatedAt ?? 0) >= now
  const data = mergeMap(stored.data ?? {}, incoming.data ?? {}, storedNewer, 0)
  // Clamp incoming rev so a client can't jump it to MAX_SAFE_INTEGER: it may at
  // most advance one past stored before the +1 below.
  const storedRev = stored.rev ?? 0
  const incomingRev = Math.min(incoming.rev ?? 0, storedRev + 1)
  return {
    v: 1,
    rev: Math.max(storedRev, incomingRev) + 1,
    updatedAt: now,
    data,
  }
}

// Recursively strip prototype-pollution keys from any plain-object/array so they
// are never stored or round-tripped back to a client.
function stripForbidden(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripForbidden)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) continue
      out[k] = stripForbidden(val)
    }
    return out
  }
  return v
}

function coerceBlob(raw: unknown): SaveBlob {
  // Normalize an incoming/stored payload into a SaveBlob, tolerating junk.
  const o = isPlainObject(raw) ? raw : {}
  const data = isPlainObject(o.data) ? o.data : {}
  return {
    v: 1,
    rev: typeof o.rev === 'number' ? o.rev : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    data: stripForbidden(data) as Record<string, unknown>,
  }
}

export default async (req: Request, _context: unknown): Promise<Response> => {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get('id') ?? ''
    if (!ID_RE.test(id)) return json({ error: 'invalid id' }, 400)

    const store = getStore(STORE_NAME)

    if (req.method === 'GET') {
      let stored: unknown = null
      try {
        stored = await store.get(id, { type: 'json' })
      } catch {
        // Missing or corrupt entry -> treat as no save.
        stored = null
      }
      if (!isPlainObject(stored)) return json({})
      return json({ data: coerceBlob(stored) })
    }

    if (req.method === 'POST') {
      // CSRF/origin guard: block drive-by cross-site writes.
      if (!originAllowed(req.headers.get('origin'))) {
        return json({ error: 'forbidden origin' }, 403)
      }

      const text = await req.text()
      // Byte length, not char length, so multi-byte payloads can't slip past.
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
        return json({ error: 'payload too large' }, 413)
      }

      let incoming: SaveBlob
      try {
        incoming = coerceBlob(JSON.parse(text))
      } catch {
        return json({ error: 'invalid JSON' }, 400)
      }

      let storedRaw: unknown = null
      try {
        storedRaw = await store.get(id, { type: 'json' })
      } catch {
        storedRaw = null
      }

      // Read-modify-write: concurrent saves to the same id can race and the
      // last writer wins; acceptable at this scale (one kid, a few devices).
      // No stored blob: clamp rev to 1 and stamp the server clock (don't trust
      // the client's rev/updatedAt).
      const merged = isPlainObject(storedRaw)
        ? mergeBlobs(coerceBlob(storedRaw), incoming)
        : { v: 1 as const, rev: 1, updatedAt: Date.now(), data: incoming.data }

      // Bound the stored blob: reject (don't store) a merged blob over the cap.
      if (JSON.stringify(merged).length > MAX_MERGED_BYTES) {
        return json({ error: 'payload too large' }, 413)
      }

      await store.setJSON(id, merged)
      return json({ rev: merged.rev })
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    // Log server-side only; never leak internal detail to the client.
    console.error('save function error:', err)
    return json({ error: 'internal error' }, 500)
  }
}
