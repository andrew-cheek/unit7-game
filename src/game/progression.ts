/**
 * Progression + gamification: the loops that make a session feel like it counts
 * and give you a reason to come back. All persisted per device in localStorage,
 * guarded so private mode just degrades to in-memory. Credits live in the
 * separate Profile (storage.ts); this module never touches them directly - the
 * game deducts credits when a cosmetic is bought and tells us to mark it owned.
 *
 * Four loops:
 *  - Pilot Level + XP: one ever-growing number fed by everything you do.
 *  - Daily streak + objective: a rotating goal and a "don't break the chain".
 *  - Duel ladder: a rating + rank tier + win streak from Beam Wars duels.
 *  - Cosmetics: owned/equipped trail + accent colors, bought with credits.
 */

export type DailyKind = 'capture' | 'play' | 'duelWins'

export interface DailyObjective {
  day: string // YYYY-MM-DD this objective belongs to
  kind: DailyKind
  target: number
  progress: number
  claimed: boolean // reward already granted
}

export interface Progression {
  xp: number // lifetime XP (level is derived from it)
  streak: number // consecutive days played
  lastDay: string // YYYY-MM-DD of the last session
  daily: DailyObjective
  duelRating: number // duel rank points (starts at 1000)
  duelStreak: number // current consecutive duel wins
  bestDuelStreak: number
  duelWins: number
  duelLosses: number
  cosmetics: { trail: string; accent: string; owned: string[] }
}

const KEY = 'unit7.progress.v1'
const START_RATING = 1000

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function yesterdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1)
  dt.setDate(dt.getDate() - 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

// Deterministic per-day RNG so the daily objective is stable across reloads
// (and identical for everyone on the same calendar day).
function seedFromDay(day: string): number {
  let h = 2166136261
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function makeDaily(day: string): DailyObjective {
  let s = seedFromDay(day)
  const rng = () => ((s = Math.imul(s ^ (s >>> 15), 1 | s)), ((s ^= s + Math.imul(s ^ (s >>> 7), 61 | s)), ((s ^ (s >>> 14)) >>> 0) / 4294967296))
  // Bias toward solo-doable goals; duel goals show up less often.
  const pool: DailyKind[] = ['capture', 'play', 'capture', 'play', 'duelWins']
  const kind = pool[Math.floor(rng() * pool.length)]
  const target = kind === 'capture' ? 12 + Math.floor(rng() * 9) : kind === 'play' ? 3 + Math.floor(rng() * 2) : 2 + Math.floor(rng() * 2)
  return { day, kind, target, progress: 0, claimed: false }
}

function defaults(): Progression {
  const day = today()
  return {
    xp: 0,
    streak: 0,
    lastDay: '',
    daily: makeDaily(day),
    duelRating: START_RATING,
    duelStreak: 0,
    bestDuelStreak: 0,
    duelWins: 0,
    duelLosses: 0,
    cosmetics: { trail: 'cyan', accent: 'cyan', owned: ['cyan'] },
  }
}

export function loadProgression(): Progression {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaults()
    const p = JSON.parse(raw) as Partial<Progression>
    const base = defaults()
    const cos = p.cosmetics ?? base.cosmetics
    const owned = Array.isArray(cos.owned) ? cos.owned.map(String) : ['cyan']
    if (!owned.includes('cyan')) owned.push('cyan')
    const daily = p.daily && p.daily.day ? { ...base.daily, ...p.daily } : base.daily
    return {
      xp: Number(p.xp) || 0,
      streak: Number(p.streak) || 0,
      lastDay: typeof p.lastDay === 'string' ? p.lastDay : '',
      daily,
      duelRating: Number(p.duelRating) || START_RATING,
      duelStreak: Number(p.duelStreak) || 0,
      bestDuelStreak: Number(p.bestDuelStreak) || 0,
      duelWins: Number(p.duelWins) || 0,
      duelLosses: Number(p.duelLosses) || 0,
      cosmetics: { trail: String(cos.trail || 'cyan'), accent: String(cos.accent || 'cyan'), owned },
    }
  } catch {
    return defaults()
  }
}

function save(p: Progression) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable - keep going in-memory */
  }
}

// --- level math --------------------------------------------------------------
// Cumulative XP to reach level L is 50*(L-1)*L, a gentle quadratic curve.

export function levelForXp(xp: number): number {
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + Math.max(0, xp) / 12.5)) / 2))
}

export function xpForLevel(level: number): number {
  return 50 * (level - 1) * level
}

/** Level + progress within the current level (0..1), for the HUD bar. */
export function levelInfo(xp: number): { level: number; into: number; span: number; frac: number } {
  const level = levelForXp(xp)
  const base = xpForLevel(level)
  const next = xpForLevel(level + 1)
  const span = next - base
  const into = xp - base
  return { level, into, span, frac: span > 0 ? into / span : 0 }
}

// --- mutations ---------------------------------------------------------------

/** Grant XP. Returns the new total + whether a level boundary was crossed. */
export function addXp(amount: number): { xp: number; level: number; leveledUp: boolean } {
  const p = loadProgression()
  const before = levelForXp(p.xp)
  p.xp += Math.max(0, Math.round(amount))
  const after = levelForXp(p.xp)
  save(p)
  return { xp: p.xp, level: after, leveledUp: after > before }
}

/**
 * Note a session start: roll the daily objective over if the calendar day
 * changed, and update the login streak. Returns the fresh progression plus
 * whether this is a new day (so the UI can celebrate the streak).
 */
export function noteLogin(): { progression: Progression; isNewDay: boolean } {
  const p = loadProgression()
  const day = today()
  let isNewDay = false
  if (p.daily.day !== day) p.daily = makeDaily(day)
  if (p.lastDay !== day) {
    isNewDay = true
    p.streak = p.lastDay && yesterdayOf(day) === p.lastDay ? p.streak + 1 : 1
    p.lastDay = day
  }
  save(p)
  return { progression: p, isNewDay }
}

/**
 * Advance the daily objective. When it crosses the target for the first time,
 * marks it claimed and returns a reward (credits + XP) for the game to grant.
 */
export function noteDaily(kind: DailyKind, amount = 1): { completed: boolean; reward: { credits: number; xp: number } | null; daily: DailyObjective } {
  const p = loadProgression()
  if (p.daily.day !== today()) p.daily = makeDaily(today())
  let reward: { credits: number; xp: number } | null = null
  if (p.daily.kind === kind && !p.daily.claimed) {
    p.daily.progress = Math.min(p.daily.target, p.daily.progress + amount)
    if (p.daily.progress >= p.daily.target) {
      p.daily.claimed = true
      reward = { credits: 150, xp: 200 }
      if (reward.xp) p.xp += reward.xp
    }
  }
  save(p)
  return { completed: !!reward, reward, daily: p.daily }
}

// --- duel ladder -------------------------------------------------------------

export const DUEL_TIERS: { min: number; name: string; color: string }[] = [
  { min: 1800, name: 'CLASS S', color: '#ffd24a' },
  { min: 1500, name: 'CLASS A', color: '#ff2bd0' },
  { min: 1300, name: 'CLASS B', color: '#8a5cff' },
  { min: 1100, name: 'CLASS C', color: '#27e7ff' },
  { min: 0, name: 'CLASS D', color: '#9bff4d' },
]

export function tierForRating(rating: number): { name: string; color: string } {
  return DUEL_TIERS.find((t) => rating >= t.min) ?? DUEL_TIERS[DUEL_TIERS.length - 1]
}

/**
 * Record a duel result. Win climbs the ladder (more for a hot streak), loss
 * drops it (floored). Returns the rating delta + new tier so the result screen
 * can show "+28 RP, CLASS C".
 */
export function recordDuel(won: boolean): { rating: number; delta: number; streak: number; tier: { name: string; color: string } } {
  const p = loadProgression()
  let delta: number
  if (won) {
    p.duelWins += 1
    p.duelStreak += 1
    p.bestDuelStreak = Math.max(p.bestDuelStreak, p.duelStreak)
    delta = 28 + Math.min(20, (p.duelStreak - 1) * 4) // streak bonus, capped
  } else {
    p.duelLosses += 1
    p.duelStreak = 0
    delta = -16
  }
  p.duelRating = Math.max(0, p.duelRating + delta)
  save(p)
  return { rating: p.duelRating, delta, streak: p.duelStreak, tier: tierForRating(p.duelRating) }
}

// --- cosmetics ---------------------------------------------------------------

export interface Cosmetic {
  id: string
  name: string
  color: number // three.js / hex int
  css: string // css color for UI + trail
  cost: number // credits (0 = free starter)
}

// A small, low-fiction palette of trail / accent colors.
export const COSMETICS: Cosmetic[] = [
  { id: 'cyan', name: 'Cyan', color: 0x27e7ff, css: '#27e7ff', cost: 0 },
  { id: 'lime', name: 'Lime', color: 0x9bff4d, css: '#9bff4d', cost: 300 },
  { id: 'magenta', name: 'Magenta', color: 0xff2bd0, css: '#ff2bd0', cost: 300 },
  { id: 'orange', name: 'Ember', color: 0xff8a1e, css: '#ff8a1e', cost: 500 },
  { id: 'purple', name: 'Violet', color: 0x8a5cff, css: '#8a5cff', cost: 500 },
  { id: 'gold', name: 'Gold', color: 0xffd24a, css: '#ffd24a', cost: 900 },
  { id: 'white', name: 'Pure', color: 0xffffff, css: '#ffffff', cost: 1200 },
  { id: 'red', name: 'Crimson', color: 0xff5c5c, css: '#ff5c5c', cost: 1500 },
]

export function cosmeticById(id: string): Cosmetic {
  return COSMETICS.find((c) => c.id === id) ?? COSMETICS[0]
}

export function ownCosmetic(id: string) {
  const p = loadProgression()
  if (!p.cosmetics.owned.includes(id)) {
    p.cosmetics.owned.push(id)
    save(p)
  }
}

/** Equip an owned cosmetic in a slot. No-op if not owned. */
export function equipCosmetic(slot: 'trail' | 'accent', id: string) {
  const p = loadProgression()
  if (!p.cosmetics.owned.includes(id)) return
  p.cosmetics[slot] = id
  save(p)
}
