// Parental controls: a PIN-gated permission system for the kid-safe chat feature.
//
// CORE RULE: chat is OFF by default and stays off until a *verified parent*
// turns it on. Turning chat OFF is always frictionless (no PIN) — we never want
// to trap a kid in an unsafe state. Only `enableChatWithPin` can flip it ON.
//
// THREAT MODEL — read this honestly:
//   This is client-side state in localStorage. The PIN is stored ONLY as a
//   SHA-256 hash (salted), never in clear text, so a casual snoop can't read it.
//   But a *determined adult* with devtools can edit localStorage directly, clear
//   the hash, or set chatEnabled=true by hand. That is ACCEPTABLE and by design:
//   the goal is to stop a young KID from trivially flipping chat on, not to
//   defend against the device's own owner. There is no server-enforced secret
//   here, so do not treat this as real cryptographic access control. The PIN
//   hash is anti-casual-tampering, not Fort Knox.
//
//   The arithmetic gate (`makeGateChallenge`) is even softer: it's a one-time
//   "ask a grown-up" speed bump shown BEFORE any PIN exists, so a 6-year-old
//   can't reach the setup screen by mashing buttons. The PIN is the real lock.

import type { ParentalState } from './kidShared'
import { PIN_LENGTH } from './kidShared'

const STORAGE_KEY = 'u7_parental.v1'

// Fixed app salt mixed into every PIN hash. This is NOT secret (it ships in the
// bundle); it only ensures our hashes aren't trivially comparable to generic
// SHA-256(pin) rainbow tables. Real security would need a server secret.
const APP_SALT = 'unit7::parental::v1::a7f3'

function defaultState(): ParentalState {
  return { pinHash: null, chatEnabled: false, updatedAt: 0 }
}

// --- SSR-safe storage helpers ---------------------------------------------------

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null
  } catch {
    // Accessing localStorage can throw (e.g. blocked cookies / sandboxed iframe).
    return false
  }
}

export function loadParental(): ParentalState {
  if (!hasLocalStorage()) return defaultState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw) as Partial<ParentalState> | null
    if (!parsed || typeof parsed !== 'object') return defaultState()
    return {
      pinHash: typeof parsed.pinHash === 'string' ? parsed.pinHash : null,
      chatEnabled: parsed.chatEnabled === true, // any non-true value => OFF
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }
  } catch {
    return defaultState()
  }
}

function saveParental(state: ParentalState): void {
  if (!hasLocalStorage()) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Quota / privacy-mode failures: nothing we can do, fail closed (no persist).
  }
}

// --- Hashing --------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

// Graceful, dependency-free fallback when SubtleCrypto is unavailable (old
// browsers, insecure http context, or SSR). This is a weak non-cryptographic
// digest — fine here, since the whole scheme is anti-casual-tampering only, and
// it's still consistent enough for verify/compare on the same device.
function fallbackHash(input: string): string {
  // FNV-1a (32-bit) folded into two passes for a longer, less-collidey output.
  function fnv1a(s: string, seed: number): number {
    let h = seed >>> 0
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h >>> 0
  }
  const a = fnv1a(input, 0x811c9dc5)
  const b = fnv1a(input.split('').reverse().join('') + '|' + input.length, 0xdeadbeef)
  return 'fb_' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

async function hashPin(pin: string): Promise<string> {
  const message = APP_SALT + ':' + pin
  try {
    const subtle =
      typeof globalThis !== 'undefined' &&
      globalThis.crypto &&
      globalThis.crypto.subtle
        ? globalThis.crypto.subtle
        : null
    if (subtle) {
      const data = new TextEncoder().encode(message)
      const digest = await subtle.digest('SHA-256', data)
      return toHex(new Uint8Array(digest))
    }
  } catch {
    // fall through to fallback
  }
  return fallbackHash(message)
}

function isValidPin(pin: string): boolean {
  return typeof pin === 'string' && new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)
}

// Length-independent-ish constant-time compare. Not a real timing defense (this
// is localStorage, not a network secret), but it avoids early-exit on the first
// differing char as a matter of habit/hygiene.
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0
    const cb = i < b.length ? b.charCodeAt(i) : 0
    diff |= ca ^ cb
  }
  return diff === 0
}

// --- Public API -----------------------------------------------------------------

export function hasPin(): boolean {
  return loadParental().pinHash !== null
}

export async function setPin(pin: string): Promise<void> {
  if (!isValidPin(pin)) {
    throw new Error(`PIN must be exactly ${PIN_LENGTH} digits`)
  }
  const pinHash = await hashPin(pin)
  const prev = loadParental()
  // Only ever persist the hash — never the clear PIN.
  saveParental({ pinHash, chatEnabled: prev.chatEnabled, updatedAt: Date.now() })
}

export async function verifyPin(pin: string): Promise<boolean> {
  const state = loadParental()
  if (state.pinHash === null) return false
  if (!isValidPin(pin)) return false
  const candidate = await hashPin(pin)
  return safeEqual(candidate, state.pinHash)
}

export async function changePin(oldPin: string, newPin: string): Promise<boolean> {
  if (!(await verifyPin(oldPin))) return false
  if (!isValidPin(newPin)) return false
  await setPin(newPin)
  return true
}

/** Persist the chat flag. NOTE: this is the raw setter — callers MUST gate the
 *  ON case behind a verified PIN (or just use `enableChatWithPin`, which does the
 *  gating for you). Turning OFF is always safe. */
export function setChatEnabled(on: boolean): void {
  const prev = loadParental()
  saveParental({ pinHash: prev.pinHash, chatEnabled: on === true, updatedAt: Date.now() })
}

/** The ONLY guarded path that turns chat ON. Verifies the PIN; on success sets
 *  chatEnabled=true and returns true. On a bad/missing PIN, chat is left OFF. */
export async function enableChatWithPin(pin: string): Promise<boolean> {
  const ok = await verifyPin(pin)
  if (!ok) return false
  setChatEnabled(true)
  return true
}

/** Turning chat OFF needs no PIN — never trap a kid in an enabled state. */
export function disableChat(): void {
  setChatEnabled(false)
}

export function isChatEnabled(): boolean {
  return loadParental().chatEnabled === true
}

/** A soft "ask a grown-up" arithmetic gate, shown the FIRST time (before any PIN
 *  exists) so a young kid can't trivially reach the setup screen. The returned
 *  `answer` is the expected input as a string; compare the kid/parent's typed
 *  response against it. This is friction, not security — the PIN is the real lock. */
export function makeGateChallenge(): { question: string; answer: string } {
  // Keep operands small-but-not-trivial: two-digit sums a grown-up does instantly
  // but that gate a button-masher. Avoid carrying being required to read aloud.
  const a = 2 + Math.floor(Math.random() * 8) // 2..9
  const b = 2 + Math.floor(Math.random() * 8) // 2..9
  return { question: `What is ${a} + ${b}?`, answer: String(a + b) }
}
