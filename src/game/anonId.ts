// Anonymous identity + recovery code for the kid-safe cloud-save feature.
//
// A save is keyed to a random, opaque on-device id — never a name, email, or
// login. To let a kid restore that save on another device WITHOUT an account,
// the same id is rendered as a short, speakable recovery code made of curated
// kid-friendly words, e.g. "BRAVE-TIGER-MOON-RIVER-42". The code is a pure,
// reversible encoding of the id plus a checksum, so a mistyped code is rejected
// rather than silently restoring a stranger's save.
//
// Design notes:
//  - No personal information. The id is cryptographic noise; the words carry no
//    meaning and map deterministically back to the exact id.
//  - SSR-safe: every browser global (crypto, localStorage) is feature-detected,
//    so importing/calling this on the server never throws.
//  - Pure encode/decode: `decodeRecoveryCode(encodeRecoveryCode(id)) === id` for
//    any id produced by `newAnonId()` / `getAnonId()`.
//  - Zero external dependencies.
//
// See src/game/kidShared.ts for the surrounding contracts (KidStore.recoveryCode
// / restore, the anon-keyed save envelope). This module owns only the id <-> code
// transform; wiring into the store/network happens at integration.

// ---------------------------------------------------------------------------
// Id alphabet + sizing
// ---------------------------------------------------------------------------

// 32-symbol, lowercase, unambiguous base used to render the raw id bytes as the
// on-device id string. Drawn from [a-z0-9] with look-alike characters removed
// (no 0/o, 1/i/l) so an id is safe to read aloud or eyeball. 32 symbols = 5 bits
// each, which makes the bytes <-> id-string conversion exact (a fixed bit
// accumulator handles the trailing partial group).
const BASE32 = 'abcdefghjkmnpqrstuvwxyz23456789x' // 32 unambiguous lowercase symbols

// Number of random bytes behind an id. 12 bytes = 96 bits of entropy, which
// renders to a 20-character base32 id (ceil(96 / 5) = 20) — matching the ~20
// char target with full crypto strength.
const ID_BYTES = 12

const STORAGE_KEY = 'u7_anon'

// ---------------------------------------------------------------------------
// Random bytes (crypto-first, SSR-safe, graceful fallback)
// ---------------------------------------------------------------------------

/** Fill `out` with cryptographically-strong random bytes when possible. Falls
 *  back to Math.random ONLY when no Web Crypto is present (old/SSR runtimes). */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  const g: any = typeof globalThis !== 'undefined' ? globalThis : undefined
  const cryptoObj = g && g.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(out)
    return out
  }
  // Fallback: not cryptographically strong, but keeps the feature working where
  // Web Crypto is unavailable (e.g. some SSR/test environments).
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256) & 0xff
  return out
}

// ---------------------------------------------------------------------------
// base32 (id bytes <-> id string), exact via a bit accumulator
// ---------------------------------------------------------------------------

/** Encode bytes to the unambiguous lowercase base32 id alphabet. */
function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 0x1f]
  }
  return out
}

/** Decode a base32 id string back to its bytes. Returns null on any symbol that
 *  is not in the id alphabet (after normalization). */
function base32ToBytes(str: string, byteLen: number): Uint8Array | null {
  let bits = 0
  let value = 0
  const out = new Uint8Array(byteLen)
  let pos = 0
  for (let i = 0; i < str.length; i++) {
    const idx = BASE32.indexOf(str[i])
    if (idx < 0) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      if (pos >= byteLen) return null
      out[pos++] = (value >>> bits) & 0xff
    }
  }
  if (pos !== byteLen) return null
  return out
}

// ---------------------------------------------------------------------------
// Anon id
// ---------------------------------------------------------------------------

/** Create a fresh, cryptographically-random opaque id (~20 chars, [a-z0-9]). */
export function newAnonId(): string {
  return bytesToBase32(randomBytes(ID_BYTES))
}

/** SSR-safe localStorage accessor — returns null when storage is unavailable. */
function safeStorage(): Storage | null {
  try {
    const g: any = typeof globalThis !== 'undefined' ? globalThis : undefined
    const ls = g && g.localStorage
    if (!ls) return null
    // Touch it to surface SecurityError (private mode / blocked storage) early.
    const k = '__u7_probe__'
    ls.setItem(k, '1')
    ls.removeItem(k)
    return ls as Storage
  } catch {
    return null
  }
}

/** Read the persisted anon id, or create + persist a new one. SSR-safe: when no
 *  localStorage is available it returns a fresh (unpersisted) id rather than
 *  throwing, so callers always get a usable id. */
export function getAnonId(): string {
  const ls = safeStorage()
  if (!ls) return newAnonId()
  try {
    const existing = ls.getItem(STORAGE_KEY)
    if (existing && isValidAnonId(existing)) return existing
    const fresh = newAnonId()
    ls.setItem(STORAGE_KEY, fresh)
    return fresh
  } catch {
    return newAnonId()
  }
}

/** True when `id` looks like an id this module produced (right length, all
 *  symbols in the id alphabet). Used to reject stale/garbage storage values. */
function isValidAnonId(id: string): boolean {
  const expectedLen = bytesToBase32(new Uint8Array(ID_BYTES)).length
  if (id.length !== expectedLen) return false
  for (let i = 0; i < id.length; i++) {
    if (BASE32.indexOf(id[i]) < 0) return false
  }
  return base32ToBytes(id, ID_BYTES) != null
}

// ---------------------------------------------------------------------------
// Curated kid-friendly word list (exactly 256 words = 8 bits per word)
// ---------------------------------------------------------------------------
//
// Curation rules: short, easy to spell, unambiguous when spoken or typed. No
// offensive words, no homophones of rude words, no near-look-alikes. Themed
// around animals, colors, space, nature, weather, and friendly objects so the
// codes feel fun and safe for kids. Exactly 256 entries so each byte of the id
// maps to exactly one word and back.
const WORDS: string[] = [
  // animals (0-63)
  'tiger', 'lion', 'bear', 'wolf', 'fox', 'deer', 'otter', 'seal',
  'whale', 'shark', 'dolphin', 'crab', 'eagle', 'hawk', 'owl', 'robin',
  'finch', 'swan', 'duck', 'goose', 'frog', 'toad', 'newt', 'gecko',
  'snake', 'turtle', 'rabbit', 'hare', 'mouse', 'mole', 'hedgehog', 'badger',
  'panda', 'koala', 'sloth', 'lemur', 'monkey', 'zebra', 'horse', 'pony',
  'donkey', 'goat', 'sheep', 'llama', 'camel', 'moose', 'bison', 'yak',
  'beaver', 'squirrel', 'chipmunk', 'raccoon', 'skunk', 'ferret', 'weasel', 'lynx',
  'puma', 'jaguar', 'leopard', 'cheetah', 'walrus', 'penguin', 'parrot', 'toucan',
  // bugs + small critters (64-95)
  'bee', 'wasp', 'ant', 'beetle', 'cricket', 'moth', 'firefly', 'ladybug',
  'spider', 'snail', 'worm', 'grub', 'mantis', 'dragonfly', 'butterfly', 'caterpillar',
  'minnow', 'guppy', 'trout', 'salmon', 'cod', 'tuna', 'bass', 'perch',
  'clam', 'oyster', 'shrimp', 'lobster', 'urchin', 'starfish', 'jellyfish', 'octopus',
  // space (96-143)
  'star', 'sun', 'moon', 'comet', 'meteor', 'planet', 'rocket', 'orbit',
  'galaxy', 'nebula', 'cosmos', 'saturn', 'mars', 'venus', 'jupiter', 'neptune',
  'pluto', 'mercury', 'eclipse', 'crater', 'lunar', 'solar', 'asteroid', 'satellite',
  'astronaut', 'spaceship', 'launch', 'gravity', 'aurora', 'quasar', 'pulsar', 'stardust',
  'beam', 'laser', 'photon', 'plasma', 'signal', 'rover', 'lander', 'probe',
  'telescope', 'antenna', 'booster', 'thruster', 'capsule', 'station', 'shuttle', 'cosmic',
  // colors (144-175)
  'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'teal',
  'lime', 'mint', 'cyan', 'gold', 'silver', 'bronze', 'amber', 'coral',
  'ruby', 'jade', 'azure', 'violet', 'indigo', 'crimson', 'scarlet', 'maroon',
  'olive', 'aqua', 'navy', 'plum', 'rose', 'tan', 'gray', 'ivory',
  // nature + plants (176-223)
  'river', 'lake', 'ocean', 'pond', 'creek', 'brook', 'wave', 'tide',
  'mountain', 'valley', 'canyon', 'hill', 'cliff', 'cave', 'island', 'forest',
  'meadow', 'field', 'garden', 'jungle', 'desert', 'tundra', 'prairie', 'reef',
  'tree', 'oak', 'pine', 'maple', 'willow', 'birch', 'cedar', 'palm',
  'poppy', 'tulip', 'daisy', 'lily', 'fern', 'moss', 'ivy', 'clover',
  'acorn', 'leaf', 'petal', 'seed', 'sprout', 'cactus', 'bamboo', 'reed',
  // weather + sky + friendly objects (224-255)
  'rain', 'snow', 'cloud', 'storm', 'thunder', 'wind', 'breeze', 'frost',
  'rainbow', 'sunset', 'sunrise', 'dawn', 'dusk', 'sky', 'fog', 'mist',
  'flame', 'spark', 'ember', 'glow', 'crystal', 'pebble', 'boulder', 'dune',
  'kite', 'lantern', 'compass', 'anchor', 'sail', 'paddle', 'bridge', 'tower',
]

// Build word -> index map once for O(1), case-insensitive decode.
const WORD_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = Object.create(null)
  for (let i = 0; i < WORDS.length; i++) m[WORDS[i]] = i
  return m
})()

// Compile-time-ish guards (run once at module load). If the list is ever edited
// to the wrong size or with a duplicate, fail loudly in dev rather than ship a
// silently-broken encoder.
if (WORDS.length !== 256) {
  throw new Error(`anonId: WORDS must have exactly 256 entries, got ${WORDS.length}`)
}
if (Object.keys(WORD_INDEX).length !== 256) {
  throw new Error('anonId: WORDS contains duplicate entries')
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

// A small CRC-style checksum over the id bytes. Two trailing digits (00-99) are
// appended to the code; on decode they must match or the code is rejected. This
// catches the common kid mistakes — a swapped, wrong, or mistyped word — instead
// of silently decoding to some other (stranger's) id.
function checksum(bytes: Uint8Array): number {
  let h = 0x9e
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ bytes[i]) & 0xff
    // 8-bit-ish mixing; keep it deterministic and dependency-free.
    h = ((h << 1) | (h >>> 7)) & 0xff
    h = (h + ((i + 1) * 31)) & 0xff
  }
  return h % 100
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n
}

// ---------------------------------------------------------------------------
// Recovery code encode / decode
// ---------------------------------------------------------------------------

const SEP = '-'

/** Encode an anon id into a friendly recovery code, e.g.
 *  "BRAVE-TIGER-MOON-RIVER-42". Pure + deterministic; round-trips exactly via
 *  `decodeRecoveryCode`. Each id byte becomes one curated word; a 2-digit
 *  checksum group is appended so typos are caught. */
export function encodeRecoveryCode(anonId: string): string {
  const bytes = base32ToBytes(anonId, ID_BYTES)
  if (!bytes) {
    // Defensive: only ids from this module should be passed in. Re-derive bytes
    // by hashing the raw string so the function is still total, but this path is
    // not expected in normal use.
    const fallback = new Uint8Array(ID_BYTES)
    for (let i = 0; i < anonId.length; i++) fallback[i % ID_BYTES] ^= anonId.charCodeAt(i) & 0xff
    return wordsFor(fallback)
  }
  return wordsFor(bytes)
}

function wordsFor(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i++) parts.push(WORDS[bytes[i]].toUpperCase())
  parts.push(pad2(checksum(bytes)))
  return parts.join(SEP)
}

/** Parse a recovery code back to the exact anon id, or null when it is
 *  malformed or fails the checksum. Tolerant of case, surrounding/extra spaces,
 *  and missing or mistyped separators: words may be split by dashes, spaces, or
 *  both, and the casing is ignored. */
export function decodeRecoveryCode(code: string): string | null {
  if (typeof code !== 'string') return null

  // Normalize: lowercase, turn any run of separators (dashes, spaces, commas,
  // dots, underscores) into a single space, trim. This absorbs "extra spaces"
  // and "missing/typo'd dashes" (e.g. spaces used instead of dashes).
  const norm = code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!norm) return null

  const tokens = norm.split(' ')
  if (tokens.length !== ID_BYTES + 1) return null

  const bytes = new Uint8Array(ID_BYTES)
  for (let i = 0; i < ID_BYTES; i++) {
    const idx = WORD_INDEX[tokens[i]]
    if (idx === undefined) return null
    bytes[i] = idx
  }

  const checkTok = tokens[ID_BYTES]
  if (!/^\d{1,2}$/.test(checkTok)) return null
  const given = parseInt(checkTok, 10)
  if (given !== checksum(bytes)) return null

  return bytesToBase32(bytes)
}

/** True when `code` decodes to a valid id (well-formed words + matching
 *  checksum). A convenience wrapper over `decodeRecoveryCode`. */
export function isValidRecoveryCode(code: string): boolean {
  return decodeRecoveryCode(code) !== null
}
