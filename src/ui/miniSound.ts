import { loadHighScore } from '../game/storage'

/**
 * Minimal shared WebAudio blips for the arcade minigames. Self-contained (its
 * own lazily-created AudioContext, unlocked by the player tapping START), and it
 * respects the same persisted mute flag the main game uses ('muted' high-score
 * slot). All calls are guarded no-ops where WebAudio is missing or muted.
 */
export type MiniSfx = 'start' | 'score' | 'hit' | 'shoot' | 'lap' | 'boost' | 'gameover'

let ctx: AudioContext | null = null
let master: GainNode | null = null

function ensure(): boolean {
  if (loadHighScore('muted') === 1) return false
  if (ctx) { ctx.resume?.().catch(() => {}); return true }
  const AC = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  const Ctor = AC.AudioContext || AC.webkitAudioContext
  if (!Ctor) return false
  try {
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
    return true
  } catch {
    return false
  }
}

function tone(freq: number, dur: number, type: OscillatorType, gain: number, sweepTo?: number) {
  if (!ctx || !master) return
  const t = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g); g.connect(master)
  o.start(t); o.stop(t + dur + 0.02)
}

export function miniSfx(name: MiniSfx) {
  if (!ensure() || !ctx) return
  switch (name) {
    case 'start': tone(330, 0.1, 'square', 0.2); setTimeout(() => tone(523, 0.14, 'square', 0.2), 90); break
    case 'score': tone(660, 0.09, 'square', 0.2, 990); break
    case 'shoot': tone(880, 0.05, 'square', 0.12, 600); break
    case 'hit': tone(180, 0.12, 'sawtooth', 0.2, 70); break
    case 'lap': tone(523, 0.1, 'square', 0.22); setTimeout(() => tone(784, 0.16, 'square', 0.22), 100); break
    case 'boost': tone(220, 0.2, 'sawtooth', 0.18, 660); break
    case 'gameover': tone(330, 0.18, 'sawtooth', 0.22, 110); setTimeout(() => tone(160, 0.32, 'sawtooth', 0.22, 70), 150); break
  }
}
