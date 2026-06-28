// Shared contracts for the kid-safe Save + Chat feature.
//
// Pure types + small constants, zero runtime dependencies, so every module
// (client save store, UI panels, parental controls, chat-safety filter, and the
// PartyKit save party) compiles against ONE stable shape. The actual wiring into
// Net.ts / party/server.ts / Game.ts / Unit7Game.tsx is done at integration.
//
// Design goals:
//  - Anonymous by default: a save is keyed to a random on-device id, never to a
//    name, email, or third-party login. No personal information is collected, so
//    the feature can ship publicly without the COPPA/identity burden.
//  - Recoverable: a human-friendly recovery code lets a kid restore their save on
//    another device, with no account/login.
//  - Chat OFF by default: typed chat between players exists only when a parent
//    explicitly enables it behind a parental gate, and every message is filtered
//    so no contact/personal info or profanity can be shared.

/** Versioned save envelope. `data` holds the existing localStorage blobs keyed by
 *  their store name, so the cloud save is a superset wrapper over today's local
 *  persistence — not a rewrite. */
export interface SaveBlob {
  v: 1
  rev: number // server-bumped monotonic revision (for conflict resolution)
  updatedAt: number // server epoch ms
  data: Record<string, unknown> // keys from SAVE_KEYS below
}

/** The localStorage blobs folded into a cloud save (see src/game/storage.ts +
 *  progression.ts for their shapes). The save layer treats each as opaque JSON. */
export const SAVE_KEYS = [
  'profile', // unit7.profile.v1
  'progression', // unit7.progress.v1
  'stats', // unit7.stats.v1
  'missions', // unit7.missions.v1
  'callsign', // unit7.callsign
  'highScores', // unit7.hs.*
  'bestTimes', // unit7.bt.*
] as const
export type SaveKey = (typeof SAVE_KEYS)[number]

/** The Store the game reads/writes progress through. LocalStore (offline / signed
 *  out) and CloudStore (anonymous cloud save) both implement it; the game never
 *  touches localStorage or the network directly. */
export interface KidStore {
  /** Current full save (read from the in-memory cache; synchronous). */
  getBlob(): SaveBlob
  /** Merge a partial update into the save and schedule a debounced cloud flush. */
  patch(data: Record<string, unknown>): void
  /** Human-friendly recovery code, e.g. "BRAVE-TIGER-MOON-42". Encodes the anon id
   *  so the same save can be pulled on another device. */
  recoveryCode(): string
  /** Restore an account from a recovery code (merges into local, never wipes). */
  restore(code: string): Promise<{ ok: boolean; error?: string }>
  /** Force a flush of pending local changes to the cloud. */
  sync(): Promise<void>
  /** True once a cloud round-trip has succeeded at least once this session. */
  readonly online: boolean
}

/** One typed chat line on the wire. `text` is ALWAYS post-filter (already cleaned
 *  and safe); raw user input never reaches another player. */
export interface ChatMessage {
  id: string // sender's anon/connection id (never a real identity)
  name: string // sanitized callsign
  text: string // filtered, safe text
  t: number // server epoch ms
}

/** Result of running candidate text through the kid-safety filter. */
export interface FilterVerdict {
  allowed: boolean
  /** Cleaned text to send when allowed (may be masked where a token was redacted). */
  text: string
  /** Why it was blocked/cleaned (for a gentle "let's keep it friendly" hint). */
  reason: 'ok' | 'contact' | 'profanity' | 'link' | 'number' | 'empty' | 'toolong' | 'spam' | 'gibberish'
}

/** Local parental-control state. Stored on-device (and optionally inside the
 *  cloud save) — the PIN is only ever persisted as a hash, never in clear text. */
export interface ParentalState {
  pinHash: string | null // hash of the parent PIN; null = no PIN set yet
  chatEnabled: boolean // OFF by default; only a verified parent can flip it on
  updatedAt: number
}

/** Hard limits enforced on both client and server. */
export const CHAT_MAX_LEN = 120
export const CHAT_MIN_INTERVAL_MS = 800 // anti-spam: min gap between a player's messages
export const PIN_LENGTH = 4

// --- Net wire additions (implemented in Net.ts + party/server.ts) ---------------
// client -> server:
//   { t: 'save', blob: SaveBlob }      persist the anon save (server bumps rev)
//   { t: 'load', anonId: string }      fetch a save by recovery id (restore flow)
//   { t: 'chat', text: string }        send a chat line (server re-filters + relays;
//                                       dropped unless the room has chat enabled)
// server -> client:
//   { t: 'saved', rev: number }        ack a save
//   { t: 'loaded', blob: SaveBlob|null } restore payload (null = unknown code)
//   { t: 'chat', ...ChatMessage }      a relayed, filtered line
//   { t: 'chatBlocked', reason: FilterVerdict['reason'] }  your line was filtered out
