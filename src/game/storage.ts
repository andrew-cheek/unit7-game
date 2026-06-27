/**
 * Tiny localStorage-backed profile so progress survives reloads: best score,
 * lifetime captures, and credits earned (for future unlocks). All access is
 * guarded - private-mode / disabled storage just degrades to in-memory.
 */
export interface Profile {
  best: number
  lifetimeCaptured: number
  credits: number
  unlocks: string[] // unlocked vehicle kinds (mechM is free by default)
  shardsFound: number // lifetime data shards collected (discovery layer)
  motherships: number // raid motherships destroyed (lifetime)
  zonesArchived: string[] // zones whose shard field has been 100% collected
}

const KEY = 'unit7.profile.v1'
const DEFAULT: Profile = { best: 0, lifetimeCaptured: 0, credits: 0, unlocks: ['mechM'], shardsFound: 0, motherships: 0, zonesArchived: [] }

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT, unlocks: [...DEFAULT.unlocks] }
    const p = JSON.parse(raw) as Partial<Profile>
    const unlocks = Array.isArray(p.unlocks) ? p.unlocks.map(String) : []
    if (!unlocks.includes('mechM')) unlocks.push('mechM')
    return {
      best: Number(p.best) || 0,
      lifetimeCaptured: Number(p.lifetimeCaptured) || 0,
      credits: Number(p.credits) || 0,
      unlocks,
      shardsFound: Number(p.shardsFound) || 0,
      motherships: Number(p.motherships) || 0,
      zonesArchived: Array.isArray(p.zonesArchived) ? p.zonesArchived.map(String) : [],
    }
  } catch {
    return { ...DEFAULT, unlocks: [...DEFAULT.unlocks] }
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable - keep going in-memory */
  }
}

// --- objective chain progress -----------------------------------------------
//
// How far through the guided objective chain (config.missions) the player has
// gotten, so the onboarding doesn't restart at "reach Portal Plaza" on every
// reload. Only the chain index and the minigame latch are stored; the capture
// objective's running base is deliberately NOT persisted (hud.captured resets
// each session) - see MissionSystem.restore.
export interface MissionProgress {
  idx: number
  minigamePlayed: boolean
}

const MISSION_KEY = 'unit7.missions.v1'

export function loadMissionProgress(): MissionProgress {
  try {
    const raw = localStorage.getItem(MISSION_KEY)
    if (!raw) return { idx: 0, minigamePlayed: false }
    const p = JSON.parse(raw) as Partial<MissionProgress>
    return { idx: Number(p.idx) || 0, minigamePlayed: !!p.minigamePlayed }
  } catch {
    return { idx: 0, minigamePlayed: false }
  }
}

export function saveMissionProgress(p: MissionProgress) {
  try {
    localStorage.setItem(MISSION_KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable - keep going in-memory */
  }
}

// --- player stats + identity ------------------------------------------------
//
// A persistent win/loss record per competitive minigame, plus the callsign you
// last joined the shared world under. Powers the profile card and the stats
// other pilots can view in multiplayer. Works fully offline (solo) too.

/** Win/loss tally for one game. */
export interface GameRecord {
  played: number
  won: number
  lost: number
  best: number // best score/level seen for this game
}

export interface PlayerStats {
  callsign: string
  games: Record<string, GameRecord>
}

const STATS_KEY = 'unit7.stats.v1'
const CALLSIGN_KEY = 'unit7.callsign'

function emptyRecord(): GameRecord {
  return { played: 0, won: 0, lost: 0, best: 0 }
}

export function loadStats(): PlayerStats {
  try {
    const raw = localStorage.getItem(STATS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<PlayerStats>) : null
    const games: Record<string, GameRecord> = {}
    if (parsed && parsed.games && typeof parsed.games === 'object') {
      for (const [k, v] of Object.entries(parsed.games)) {
        const r = v as Partial<GameRecord>
        games[k] = {
          played: Number(r.played) || 0,
          won: Number(r.won) || 0,
          lost: Number(r.lost) || 0,
          best: Number(r.best) || 0,
        }
      }
    }
    return { callsign: loadCallsign(), games }
  } catch {
    return { callsign: '', games: {} }
  }
}

/**
 * Record the outcome of one competitive game. `outcome` is 'win' or 'loss';
 * `score` updates that game's best when higher. Returns the updated stats.
 */
export function recordGameResult(game: string, outcome: 'win' | 'loss', score = 0): PlayerStats {
  const stats = loadStats()
  const rec = stats.games[game] ?? emptyRecord()
  rec.played += 1
  if (outcome === 'win') rec.won += 1
  else rec.lost += 1
  if (score > rec.best) rec.best = Math.floor(score)
  stats.games[game] = rec
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify({ games: stats.games }))
  } catch {
    /* storage unavailable - keep going in-memory */
  }
  return stats
}

export function loadCallsign(): string {
  try {
    return localStorage.getItem(CALLSIGN_KEY) || ''
  } catch {
    return ''
  }
}

export function saveCallsign(name: string) {
  try {
    localStorage.setItem(CALLSIGN_KEY, name.slice(0, 16))
  } catch {
    /* ignore */
  }
}

// Per-minigame high scores, keyed by a short id (e.g. 'snake', '2048').
export function loadHighScore(key: string): number {
  try {
    return Number(localStorage.getItem('unit7.hs.' + key)) || 0
  } catch {
    return 0
  }
}

export function saveHighScore(key: string, value: number) {
  try {
    if (value > loadHighScore(key)) localStorage.setItem('unit7.hs.' + key, String(Math.floor(value)))
  } catch {
    /* ignore */
  }
}

// Best *time* records, where lower is better (e.g. a race lap). Stored as
// integer tenths of a second so the saved value and the in-memory value agree
// to one decimal place on reload. Returns seconds (0 = no record yet).
export function loadBestTime(key: string): number {
  try {
    const t = Number(localStorage.getItem('unit7.bt.' + key))
    return Number.isFinite(t) && t > 0 ? t / 10 : 0
  } catch {
    return 0
  }
}

export function saveBestTime(key: string, seconds: number) {
  try {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    const tenths = Math.round(seconds * 10)
    const prev = Number(localStorage.getItem('unit7.bt.' + key))
    if (!Number.isFinite(prev) || prev <= 0 || tenths < prev) {
      localStorage.setItem('unit7.bt.' + key, String(tenths))
    }
  } catch {
    /* ignore */
  }
}
