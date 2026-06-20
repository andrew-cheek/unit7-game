/**
 * Tiny localStorage-backed profile so progress survives reloads: best score,
 * lifetime captures, and credits earned (for future unlocks). All access is
 * guarded - private-mode / disabled storage just degrades to in-memory.
 */
export interface Profile {
  best: number
  lifetimeCaptured: number
  credits: number
}

const KEY = 'unit7.profile.v1'
const DEFAULT: Profile = { best: 0, lifetimeCaptured: 0, credits: 0 }

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT }
    const p = JSON.parse(raw) as Partial<Profile>
    return {
      best: Number(p.best) || 0,
      lifetimeCaptured: Number(p.lifetimeCaptured) || 0,
      credits: Number(p.credits) || 0,
    }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage unavailable - keep going in-memory */
  }
}
