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
const ID_RE = /^[a-z0-9]{8,40}$/i
const MAX_BODY_BYTES = 64 * 1024

const JSON_HEADERS = { 'content-type': 'application/json' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Deep merge of two save payloads so two devices converge to the same state.
// Mirrors the client merge rules:
//   numeric scalars -> MAX
//   booleans        -> OR
//   arrays          -> union, deduped by JSON.stringify
//   plain-object maps (games/highScores/bestTimes) -> per-key recursive merge
//   type mismatch / "current-selection" string fields -> newer updatedAt wins
function mergeValue(a: unknown, b: unknown, aNewer: boolean): unknown {
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b)
  if (typeof a === 'boolean' && typeof b === 'boolean') return a || b
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const item of [...a, ...b]) {
      const k = JSON.stringify(item)
      if (!seen.has(k)) {
        seen.add(k)
        out.push(item)
      }
    }
    return out
  }
  if (isPlainObject(a) && isPlainObject(b)) return mergeMap(a, b, aNewer)
  // Type mismatch, or a string "current-selection" field: newer side wins.
  return aNewer ? a : b
}

function mergeMap(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  aNewer: boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const hasA = key in a
    const hasB = key in b
    if (hasA && hasB) out[key] = mergeValue(a[key], b[key], aNewer)
    else out[key] = hasA ? a[key] : b[key]
  }
  return out
}

function mergeBlobs(stored: SaveBlob, incoming: SaveBlob): SaveBlob {
  const storedNewer = (stored.updatedAt ?? 0) >= (incoming.updatedAt ?? 0)
  const data = mergeMap(stored.data ?? {}, incoming.data ?? {}, storedNewer)
  return {
    v: 1,
    rev: Math.max(stored.rev ?? 0, incoming.rev ?? 0) + 1,
    updatedAt: Math.max(stored.updatedAt ?? 0, incoming.updatedAt ?? 0, Date.now()),
    data,
  }
}

function coerceBlob(raw: unknown): SaveBlob {
  // Normalize an incoming/stored payload into a SaveBlob, tolerating junk.
  const o = isPlainObject(raw) ? raw : {}
  return {
    v: 1,
    rev: typeof o.rev === 'number' ? o.rev : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    data: isPlainObject(o.data) ? o.data : {},
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
      const merged = isPlainObject(storedRaw)
        ? mergeBlobs(coerceBlob(storedRaw), incoming)
        : { ...incoming, rev: (incoming.rev ?? 0) + 1, updatedAt: Math.max(incoming.updatedAt ?? 0, Date.now()) }

      await store.setJSON(id, merged)
      return json({ rev: merged.rev })
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  }
}
