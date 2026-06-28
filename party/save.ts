/**
 * Unit 7 — anonymous kid-save server (PartyKit).
 *
 * This is a SECOND, separate PartyKit party from the realtime world server in
 * `party/server.ts`. It does one job: durably persist anonymous, account-less
 * kid saves over plain HTTP. It deploys separately (`npx partykit deploy`) and
 * is registered in the partykit config by hand.
 *
 * DESIGN: "room id = anon save id". PartyKit gives each room its own
 * Durable-Object-backed `room.storage` KV. We address a save by routing to the
 * room whose id IS the on-device anonymous save id (see `SaveBlob` /
 * `recoveryCode()` in `src/game/kidShared.ts`). So one room == one save, and the
 * room id is the only "credential" — it's a long random id the kid keeps on
 * their device (and can re-derive from their recovery code). There is no login.
 *
 * NO AUTH, but DEFENDED: because anyone who guesses a room id could write to it,
 * and because there's no account to attach abuse to, we validate aggressively so
 * this can't be turned into free arbitrary storage:
 *   - hard 64KB body cap (reject bigger with 400),
 *   - the body must look like a SaveBlob (an object with a `data` object),
 *   - the server owns `rev` and `updatedAt` (clients can't forge them),
 *   - writes MERGE (max/union) instead of overwrite, so two devices syncing the
 *     same save can't clobber each other's progress.
 *
 * Never throws on bad input: every parse/validation failure returns a 4xx.
 */
import type * as Party from 'partykit/server'

/**
 * Minimal local copy of the `SaveBlob` shape from `src/game/kidShared.ts`.
 *
 * It is REDEFINED here rather than imported: the existing `party/server.ts`
 * keeps the party build self-contained (no imports out of `party/`), and the
 * root tsconfig excludes `party/` from `npm run typecheck`, so reaching into
 * `../src/game/kidShared` would only be validated by partykit's own bundler at
 * deploy time. Keeping a local copy avoids a cross-tree import that may or may
 * not resolve there. Keep this in sync with kidShared.ts's `SaveBlob`.
 */
interface SaveBlob {
  v: 1
  rev: number // server-bumped monotonic revision (for conflict resolution)
  updatedAt: number // server epoch ms
  data: Record<string, unknown> // opaque per-store localStorage blobs
}

/** Fixed storage key: exactly one SaveBlob per room, the room being the save. */
const BLOB_KEY = 'blob'

/** Hard cap on an inbound body. 64KB is generous for a wrapped localStorage
 *  save and small enough that the party can't be abused as a file host. */
const MAX_BODY_BYTES = 64 * 1024

export default class SaveServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onRequest(req: Party.Request): Promise<Response> {
    const cors = corsHeaders(req.headers.get('Origin'))

    // CORS preflight: the browser game on unit7.humanoidrobots.com fetches this
    // cross-origin, so answer OPTIONS with the allow-list and no body.
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    if (req.method === 'GET') {
      const stored = await this.read()
      // No save yet for this id → empty object (the client treats it as "fresh").
      return json(stored ?? {}, 200, cors)
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      return this.handleWrite(req, cors)
    }

    return json({ error: 'method not allowed' }, 405, cors)
  }

  /** PUT/POST: validate the incoming blob, server-stamp rev/updatedAt, merge it
   *  with any stored blob, persist, and ack with the new rev. */
  private async handleWrite(req: Party.Request, cors: Record<string, string>): Promise<Response> {
    // Cheap pre-check: reject obviously oversized bodies by Content-Length before
    // we even read them. (The post-read length check below is the real guard,
    // since Content-Length can be absent or lied about.)
    const declared = Number(req.headers.get('Content-Length'))
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return json({ error: 'too large' }, 400, cors)
    }

    let text: string
    try {
      text = await req.text()
    } catch {
      return json({ error: 'unreadable body' }, 400, cors)
    }

    // Real size cap (byte length, not char length — multi-byte chars count).
    if (byteLength(text) > MAX_BODY_BYTES) {
      return json({ error: 'too large' }, 400, cors)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return json({ error: 'malformed json' }, 400, cors)
    }

    // Shape gate: must be an object carrying a `data` object. Anything else is
    // not a SaveBlob and gets rejected so this can't be used as a JSON dump.
    const incoming = asSaveBlobLike(parsed)
    if (!incoming) {
      return json({ error: 'not a save blob' }, 400, cors)
    }

    const stored = await this.read()

    // Server-authoritative revision: never trust the client's rev for ordering.
    // Take the max of what the client claims and what we have, then bump — so a
    // stale device can't push an old rev that looks "newer", and concurrent
    // writers keep climbing instead of fighting over a fixed number.
    const baseRev = Math.max(toFiniteInt(incoming.rev, 0), stored ? stored.rev : 0)
    const nextRev = baseRev + 1

    // Conflict-free merge: union the incoming save with whatever is stored so two
    // devices syncing the same anon id can't clobber each other.
    //   - numeric scalars   → max (XP, credits, best scores only go up)
    //   - arrays            → union of elements (badges, unlocks, captured ids…)
    //   - nested maps        → recurse, per-key max/union
    //   - everything else (current-state fields: callsign, position, flags) →
    //     incoming wins (the writer's latest value)
    const mergedData = stored
      ? (mergeValue(stored.data, incoming.data) as Record<string, unknown>)
      : incoming.data

    const blob: SaveBlob = {
      v: 1,
      rev: nextRev,
      updatedAt: Date.now(), // server clock, not the client's
      data: mergedData,
    }

    // Persist exactly one blob under the fixed key for this room/save.
    await this.room.storage.put(BLOB_KEY, blob)

    return json({ ok: true, rev: nextRev }, 200, cors)
  }

  /** Read the single stored blob for this room, or null if none/corrupt. */
  private async read(): Promise<SaveBlob | null> {
    const raw = await this.room.storage.get<unknown>(BLOB_KEY)
    return asSaveBlobLike(raw)
  }
}

// --- validation --------------------------------------------------------------

/** Accept a value only if it looks like a SaveBlob: an object with a `data`
 *  object. Normalizes the envelope fields to safe defaults; returns null for
 *  anything that isn't shaped like a save. Never throws. */
function asSaveBlobLike(v: unknown): SaveBlob | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const data = o.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  return {
    v: 1,
    rev: toFiniteInt(o.rev, 0),
    updatedAt: toFiniteInt(o.updatedAt, 0),
    data: data as Record<string, unknown>,
  }
}

/** Coerce to a finite non-negative integer, else the fallback. */
function toFiniteInt(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

// --- merge -------------------------------------------------------------------

/**
 * Max/union merge of two arbitrary JSON values (stored `prev` vs `next`).
 *
 * Rules (chosen so a merge is commutative-ish and never loses progress):
 *   - both numbers          → Math.max (monotonic stats only climb)
 *   - both arrays           → union (dedup of JSON-equal elements)
 *   - both plain objects    → recurse per key, union of keys
 *   - mismatched / scalars  → `next` wins (current-state fields take the latest)
 *
 * `undefined` on either side falls back to the other, so a key present in only
 * one blob survives.
 */
function mergeValue(prev: unknown, next: unknown): unknown {
  if (next === undefined) return prev
  if (prev === undefined) return next

  if (typeof prev === 'number' && typeof next === 'number') {
    return Math.max(prev, next)
  }

  if (Array.isArray(prev) && Array.isArray(next)) {
    return unionArrays(prev, next)
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const out: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
    for (const k of keys) {
      // Skip prototype-pollution vectors entirely.
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      out[k] = mergeValue(prev[k], next[k])
    }
    return out
  }

  // Type mismatch or scalar (string/boolean/null): the writer's latest wins.
  return next
}

/** Union two arrays, de-duplicating by JSON-equality so unlock/badge lists grow
 *  without piling up duplicates. Falls back gracefully on non-serializable items. */
function unionArrays(a: unknown[], b: unknown[]): unknown[] {
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const item of [...a, ...b]) {
    let key: string
    try {
      key = JSON.stringify(item)
    } catch {
      out.push(item)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// --- http helpers ------------------------------------------------------------

/** Permissive CORS for an anonymous public save endpoint. Echo the request
 *  Origin when present (so credentialed-style fetches still work), else `*`. */
function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

/** JSON response with status + CORS headers folded in. */
function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

/** UTF-8 byte length of a string (TextEncoder is available in the Workers/PartyKit
 *  runtime), so the size cap counts bytes, not code units. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}
