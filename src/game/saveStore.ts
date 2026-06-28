// Client save store: LocalStore (offline) + CloudStore (anonymous cloud save).
//
// Both implement the KidStore contract from kidShared so the game reads/writes
// progress through one stable interface and never touches localStorage or the
// network directly.
//
//  - LocalStore: localStorage only. No cloud round-trips; restore/sync are
//    no-ops. Used when no SaveTransport is wired (solo / signed-out play).
//  - CloudStore: an in-memory SaveBlob cache hydrated from localStorage, written
//    through to localStorage on every patch (so offline play never loses data),
//    debounced-synced to the cloud via an injected SaveTransport, and reconciled
//    with the server using a never-lose-progress merge.
//
// The network is INJECTED as a SaveTransport, so this file has no direct WS/fetch
// dependency; the real transport is wired in Net.ts at integration.

import { SaveBlob, SAVE_KEYS, KidStore } from './kidShared'
import { getAnonId, encodeRecoveryCode, decodeRecoveryCode } from './anonId'

/** The network surface the CloudStore needs, injected at integration so this
 *  module stays free of any WS/fetch dependency. */
export interface SaveTransport {
  /** Persist a blob for an anon id; resolves with the new server revision. */
  save(anonId: string, blob: SaveBlob): Promise<number>
  /** Fetch a blob by anon id (restore flow); null when the id is unknown. */
  load(anonId: string): Promise<SaveBlob | null>
}

// --- persistence key + debounce timing --------------------------------------

/** Where the folded cloud-save envelope is mirrored on-device. The per-store
 *  blobs in `data` keep using their own existing keys at integration; this is
 *  the wrapper envelope so a full save survives a reload before any sync. */
const SAVE_BLOB_KEY = 'unit7.save.v1'

/** Debounce window for cloud writes: coalesce a burst of patches into one save. */
const SYNC_DEBOUNCE_MS = 3000

// --- SSR-safe localStorage helpers ------------------------------------------

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function readRaw(key: string): string | null {
  if (!hasStorage()) return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  if (!hasStorage()) return
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private-mode / quota — degrade to in-memory, keep playing */
  }
}

// --- blob construction + validation -----------------------------------------

function emptyBlob(): SaveBlob {
  return { v: 1, rev: 0, updatedAt: 0, data: {} }
}

/** Coerce arbitrary parsed JSON into a well-formed SaveBlob. Robust to malformed
 *  cached JSON: anything off-shape falls back to a fresh empty blob/data map. */
function coerceBlob(value: unknown): SaveBlob {
  if (!value || typeof value !== 'object') return emptyBlob()
  const v = value as Record<string, unknown>
  const data =
    v.data && typeof v.data === 'object' && !Array.isArray(v.data) ? (v.data as Record<string, unknown>) : {}
  return {
    v: 1,
    rev: Number.isFinite(v.rev as number) ? Number(v.rev) : 0,
    updatedAt: Number.isFinite(v.updatedAt as number) ? Number(v.updatedAt) : 0,
    data: { ...data },
  }
}

/** Read the mirrored envelope from localStorage, tolerating malformed JSON. */
function loadBlobFromStorage(): SaveBlob {
  const raw = readRaw(SAVE_BLOB_KEY)
  if (!raw) return emptyBlob()
  try {
    return coerceBlob(JSON.parse(raw))
  } catch {
    return emptyBlob()
  }
}

function saveBlobToStorage(blob: SaveBlob): void {
  try {
    writeRaw(SAVE_BLOB_KEY, JSON.stringify(blob))
  } catch {
    /* non-serializable data — should not happen for plain JSON saves */
  }
}

// --- merge rule (never lose a kid's progress) -------------------------------
//
// When reconciling two SaveBlobs (cloud vs local, or restore vs current) the
// guiding rule is: progress only ever goes UP.
//
//  - rev:            take the higher of the two.
//  - numeric scalars (xp, credits, captured, ratings, counts): take the MAX.
//  - arrays (unlocks, owned cosmetics, achievements): take the UNION (deduped).
//  - per-key maps (games / highScores / bestTimes): merge per key, recursing,
//    so each individual high score / best time takes its own max.
//  - genuinely-current fields (equipped cosmetic, callsign, mission idx,
//    spendable credit balance): take the side from the most-recently-updated
//    blob (higher updatedAt). These are "what is the kid using / has right now",
//    not "how much have they earned". Critically this includes the spendable
//    `credits` balance: MAX-merging it would silently refund any spend on the
//    next reconcile (spend 400 -> reload -> credits restored), an exploit. The
//    newer side must win so a spend sticks.

/** Exact data PATHS whose VALUE is the player's current state / spendable
 *  balance rather than accumulated progress. For these we prefer the
 *  most-recently-updated side wholesale instead of max/union merging, so e.g.
 *  re-equipping a cosmetic or spending credits actually sticks.
 *
 *  Matched by FULL PATH (dot-joined from the `data` root), NOT by leaf key name
 *  at any depth — a path match can't be triggered by an unrelated nested object
 *  that happens to reuse one of these key names (which would otherwise drop data
 *  by resolving the whole sub-tree "newer wins" instead of merging it).
 *
 *  Paths confirmed against the real shapes in storage.ts / progression.ts:
 *   - `callsign`                     top-level sanitized callsign (string)
 *   - `profile.credits`             spendable credit balance (Profile.credits)
 *   - `missions.idx`                guided objective-chain position (MissionProgress.idx)
 *   - `progression.cosmetics.trail` equipped trail color (Progression.cosmetics.trail)
 *   - `progression.cosmetics.accent` equipped accent color (Progression.cosmetics.accent)
 */
const CURRENT_FIELD_PATHS = new Set<string>([
  'callsign',
  'profile.credits',
  'missions.idx',
  'progression.cosmetics.trail',
  'progression.cosmetics.accent',
])

/** True when `path` (dot-joined from the data root) names a current-state /
 *  spendable field that should resolve newer-wins instead of max/union. */
function isCurrentFieldPath(path: string): boolean {
  return CURRENT_FIELD_PATHS.has(path)
}

/** Extend a parent path with a child key (root keys have no leading dot). */
function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Union two arrays, de-duplicating by JSON identity so primitives and simple
 *  objects (achievements, owned cosmetics) don't pile up duplicates. */
function unionArrays(a: unknown[], b: unknown[]): unknown[] {
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const item of [...a, ...b]) {
    const key = typeof item === 'object' && item !== null ? JSON.stringify(item) : `${typeof item}:${String(item)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Deep-merge two save-data values with the never-lose rule. `aNewer` says which
 * side is the more-recently-updated blob, used only to resolve current-state
 * fields. `path` is the full dot-joined path (from the data root) this value
 * sits at, used for current-field detection by exact path.
 */
function mergeValue(a: unknown, b: unknown, aNewer: boolean, path: string): unknown {
  // One side missing — take whatever exists.
  if (a === undefined) return b
  if (b === undefined) return a

  // Current-state / spendable field at a known path: take the newer side
  // wholesale (don't max/union), so a spend or a re-equip sticks. Matched by
  // exact path, so an unrelated nested object reusing one of these key names
  // elsewhere in the tree is unaffected and still merges normally.
  if (isCurrentFieldPath(path)) {
    return aNewer ? a : b
  }

  // Numbers: progress goes up — take the max.
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.max(a, b)
  }

  // Booleans: an unlock/flag, once true, stays true.
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a || b
  }

  // Arrays (unlocks, owned cosmetics, achievements): union.
  if (Array.isArray(a) && Array.isArray(b)) {
    return unionArrays(a, b)
  }

  // Maps (games / highScores / bestTimes, or any nested object): merge per key.
  if (isPlainObject(a) && isPlainObject(b)) {
    return mergeRecords(a, b, aNewer, path)
  }

  // Type mismatch or strings: take the newer side (most-recently-updated wins).
  return aNewer ? a : b
}

function mergeRecords(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  aNewer: boolean,
  path = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    out[k] = mergeValue(a[k], b[k], aNewer, joinPath(path, k))
  }
  return out
}

/**
 * Merge two whole SaveBlobs. Takes the higher `rev`, the later `updatedAt`, and
 * deep-merges `data` per the never-lose rule above. Pure — returns a new blob,
 * mutates neither input.
 */
export function mergeBlobs(a: SaveBlob, b: SaveBlob): SaveBlob {
  const aNewer = (a.updatedAt || 0) >= (b.updatedAt || 0)
  return {
    v: 1,
    rev: Math.max(a.rev || 0, b.rev || 0),
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    data: mergeRecords(a.data || {}, b.data || {}, aNewer),
  }
}

/** Shallow-merge a partial data patch into a blob's data, deep-merging nested
 *  objects so a patch to one sub-key doesn't blow away siblings. The patch is the
 *  "newer" side for current-field resolution (it's what the game just changed). */
function applyPatch(blob: SaveBlob, patch: Record<string, unknown>): SaveBlob {
  const data = { ...blob.data }
  for (const k of Object.keys(patch)) {
    const incoming = patch[k]
    const existing = data[k]
    if (isPlainObject(incoming) && isPlainObject(existing)) {
      // Deep-merge sub-trees; the patch wins ties (it's the live change). Pass
      // the top-level key as the path root so current-field paths (e.g.
      // profile.credits) resolve newer-wins from the patch rather than max-merge.
      data[k] = mergeRecords(existing, incoming, false, k)
    } else {
      data[k] = incoming
    }
  }
  return { ...blob, data, updatedAt: Date.now() }
}

// --- LocalStore -------------------------------------------------------------

/**
 * Offline / signed-out store. Backed by localStorage only — no transport, no
 * cloud round-trips. `recoveryCode()` still works (it just encodes the anon id,
 * so a kid can later move to a device with a transport and restore). `restore`
 * and `sync` are no-ops (restore resolves ok=false; sync resolves immediately).
 * `online` is always false.
 */
export class LocalStore implements KidStore {
  readonly online = false
  private cache: SaveBlob

  constructor() {
    this.cache = loadBlobFromStorage()
  }

  getBlob(): SaveBlob {
    return this.cache
  }

  patch(data: Record<string, unknown>): void {
    this.cache = applyPatch(this.cache, data)
    saveBlobToStorage(this.cache)
  }

  recoveryCode(): string {
    return encodeRecoveryCode(getAnonId())
  }

  async restore(_code: string): Promise<{ ok: boolean; error?: string }> {
    // No cloud here — nothing to pull from. Surface a clear, non-fatal reason.
    return { ok: false, error: 'offline' }
  }

  async sync(): Promise<void> {
    // Nothing to flush to; localStorage write-through already happened in patch.
  }
}

// --- CloudStore -------------------------------------------------------------

/**
 * Anonymous cloud save. Holds an in-memory SaveBlob cache hydrated from
 * localStorage at construction, then reconciled with the cloud on the first
 * `sync`. Every `patch` deep-merges into the cache, writes through to
 * localStorage immediately (so nothing is ever lost offline), and schedules a
 * debounced `transport.save`. `sync()` forces a flush. `online` flips true after
 * the first successful save or load round-trip.
 */
export class CloudStore implements KidStore {
  private cache: SaveBlob
  private transport: SaveTransport
  private anonId: string
  private _online = false

  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pendingDirty = false // un-flushed local changes exist
  private reconciled = false // first sync (cloud reconcile) has happened
  private inFlight: Promise<void> | null = null // a save currently on the wire

  constructor(transport: SaveTransport) {
    this.transport = transport
    this.anonId = getAnonId()
    this.cache = loadBlobFromStorage()
  }

  get online(): boolean {
    return this._online
  }

  getBlob(): SaveBlob {
    return this.cache
  }

  patch(data: Record<string, unknown>): void {
    this.cache = applyPatch(this.cache, data)
    // Write-through FIRST: offline play must never lose data even if the cloud
    // save never lands.
    saveBlobToStorage(this.cache)
    this.pendingDirty = true
    this.scheduleFlush()
  }

  recoveryCode(): string {
    return encodeRecoveryCode(this.anonId)
  }

  async restore(code: string): Promise<{ ok: boolean; error?: string }> {
    const id = decodeRecoveryCode(code)
    if (!id) return { ok: false, error: 'badcode' }
    let remote: SaveBlob | null
    try {
      remote = await this.transport.load(id)
    } catch {
      return { ok: false, error: 'network' }
    }
    this._online = true
    if (!remote) return { ok: false, error: 'notfound' }
    // MERGE into local — never wipe. The restored save and the current device's
    // progress both survive (max/union), so restoring on a device that already
    // has play time can't erase either side.
    this.cache = mergeBlobs(this.cache, coerceBlob(remote))
    saveBlobToStorage(this.cache)
    this.pendingDirty = true
    // Persist the merged result back under THIS device's id so both stay in sync.
    await this.flush()
    return { ok: true }
  }

  async sync(): Promise<void> {
    // First sync reconciles with whatever the cloud already holds for this id,
    // then flushes the merged result.
    if (!this.reconciled) {
      this.reconciled = true
      try {
        const remote = await this.transport.load(this.anonId)
        this._online = true
        if (remote) {
          this.cache = mergeBlobs(this.cache, coerceBlob(remote))
          saveBlobToStorage(this.cache)
          this.pendingDirty = true
        }
      } catch {
        // Cloud unreachable — keep the local cache; we'll reconcile next sync.
        this.reconciled = false
      }
    }
    await this.flush()
  }

  // --- internals ------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    if (typeof setTimeout === 'undefined') return // SSR — no timers
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, SYNC_DEBOUNCE_MS)
  }

  private clearTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** Push the current cache to the cloud now. Coalesces with an in-flight save
   *  so a forced sync during a debounced save doesn't double-write. */
  private async flush(): Promise<void> {
    this.clearTimer()
    if (this.inFlight) {
      // A save is already on the wire; wait for it, then re-check dirtiness so
      // changes made during the round-trip still get persisted.
      await this.inFlight
    }
    if (!this.pendingDirty) return
    this.pendingDirty = false
    const blobToSave = this.cache
    const op = this.doSave(blobToSave)
    this.inFlight = op
    try {
      await op
    } finally {
      if (this.inFlight === op) this.inFlight = null
    }
    // If more patches landed mid-flight, persist them too.
    if (this.pendingDirty) await this.flush()
  }

  private async doSave(blob: SaveBlob): Promise<void> {
    try {
      const newRev = await this.transport.save(this.anonId, blob)
      this._online = true
      // Adopt the server revision if it advanced; don't clobber newer local data
      // the player produced while the save was in flight — only bump rev.
      if (Number.isFinite(newRev) && newRev > this.cache.rev) {
        this.cache = { ...this.cache, rev: newRev }
        saveBlobToStorage(this.cache)
      }
    } catch {
      // Save failed — mark dirty again so a later flush retries. localStorage
      // already holds the data, so nothing is lost in the meantime.
      this.pendingDirty = true
    }
  }
}

// --- factory ----------------------------------------------------------------

/**
 * Returns a CloudStore when a transport is injected, else a LocalStore. The game
 * keeps working with no network: pass nothing and you get a pure-local store.
 */
export function createStore(transport?: SaveTransport): KidStore {
  return transport ? new CloudStore(transport) : new LocalStore()
}

// Touch SAVE_KEYS so the import is retained as documentation of the data shape
// the merge operates over (the per-store blobs folded into `data`). It is the
// canonical list of top-level keys patch()/mergeBlobs() reconcile.
void SAVE_KEYS
