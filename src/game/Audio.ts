import { loadHighScore, saveHighScore } from './storage'

/**
 * Tiny WebAudio sound engine. Everything is synthesized at runtime (oscillators
 * + noise), so there are no audio files to download - mobile-friendly per the
 * brief ("no heavy imported assets"). The context is created lazily and resumed
 * on the first user gesture (required by mobile browsers). A very quiet ambient
 * pad loops under gameplay. Mute state persists. All calls are guarded no-ops if
 * WebAudio is unavailable.
 */
export type Sfx =
  | 'capture' | 'explosion' | 'fire' | 'mechOnline' | 'land' | 'step'
  | 'soak' | 'portal' | 'objective' | 'ui'

export class AudioManager {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private padGain: GainNode | null = null
  private muted: boolean
  private unlocked = false
  private lastStep = 0

  constructor() {
    this.muted = loadHighScore('muted') === 1
  }

  get isMuted() {
    return this.muted
  }

  /** Resume/create the context after a user gesture; start the ambient pad. */
  unlock() {
    if (this.unlocked) return
    const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
    const Ctor = AC.AudioContext || AC.webkitAudioContext
    if (!Ctor) return
    try {
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.muted ? 0 : 0.6
      this.master.connect(this.ctx.destination)
      this.startPad()
      this.unlocked = true
    } catch {
      /* audio unavailable */
    }
    this.ctx?.resume?.().catch(() => {})
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    saveHighScore('muted', this.muted ? 1 : 0) // persisted (re-uses the hs store)
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.05)
    return this.muted
  }

  /** A low, slow ambient pad so the world isn't dead silent. */
  private startPad() {
    if (!this.ctx || !this.master) return
    const pad = this.ctx.createGain()
    pad.gain.value = 0.05
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 520
    pad.connect(filter)
    filter.connect(this.master)
    for (const f of [55, 82.4, 110]) {
      const o = this.ctx.createOscillator()
      o.type = 'triangle'
      o.frequency.value = f
      o.detune.value = (Math.random() - 0.5) * 8
      o.connect(pad)
      o.start()
    }
    // Slow swell on the pad gain via an LFO.
    const lfo = this.ctx.createOscillator()
    const lfoGain = this.ctx.createGain()
    lfo.frequency.value = 0.06
    lfoGain.gain.value = 0.03
    lfo.connect(lfoGain)
    lfoGain.connect(pad.gain)
    lfo.start()
    this.padGain = pad
  }

  // --- one-shot synths -------------------------------------------------------

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, sweepTo?: number) {
    if (!this.ctx || !this.master) return
    const t = this.ctx.currentTime
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g)
    g.connect(this.master)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  private noise(dur: number, gain: number, filterFreq: number, sweepTo?: number) {
    if (!this.ctx || !this.master) return
    const t = this.ctx.currentTime
    const n = Math.floor(this.ctx.sampleRate * dur)
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(filterFreq, t)
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t + dur)
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(gain, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(filter)
    filter.connect(g)
    g.connect(this.master)
    src.start(t)
    src.stop(t + dur + 0.02)
  }

  play(name: Sfx) {
    if (!this.unlocked || this.muted || !this.ctx) return
    switch (name) {
      case 'capture': this.tone(520, 0.18, 'sine', 0.3, 1040); break
      case 'fire': this.noise(0.18, 0.25, 1800, 300); this.tone(220, 0.16, 'sawtooth', 0.15, 90); break
      case 'explosion': this.noise(0.5, 0.5, 1200, 80); this.tone(70, 0.5, 'sine', 0.4, 40); break
      case 'mechOnline': this.tone(60, 0.7, 'sawtooth', 0.35, 180); this.tone(440, 0.5, 'square', 0.12, 660); break
      case 'land': this.tone(64, 0.32, 'sine', 0.45, 36); this.noise(0.22, 0.3, 600, 80); break
      case 'step': {
        const now = this.ctx.currentTime
        if (now - this.lastStep < 0.12) return // rate-limit footstep thuds
        this.lastStep = now
        this.tone(80, 0.12, 'sine', 0.22, 48)
        break
      }
      case 'soak': this.noise(0.3, 0.35, 2400, 400); break
      case 'portal': this.tone(330, 0.5, 'sine', 0.25, 880); this.tone(495, 0.5, 'sine', 0.15, 1320); break
      case 'objective': this.tone(523, 0.12, 'square', 0.22); setTimeout(() => this.tone(784, 0.18, 'square', 0.22), 110); break
      case 'ui': this.tone(880, 0.06, 'square', 0.18); break
    }
  }

  dispose() {
    try { this.ctx?.close() } catch { /* ignore */ }
    this.ctx = null
    this.master = null
    this.padGain = null
  }
}
