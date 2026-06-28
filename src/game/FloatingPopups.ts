import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'

interface Popup {
  sprite: THREE.Sprite
  mat: THREE.SpriteMaterial
  tex: THREE.CanvasTexture
  canvas: HTMLCanvasElement
  ring: THREE.Sprite | null
  ringMat: THREE.SpriteMaterial | null
  t: number
  life: number
  active: boolean
  vy: number
  scaleX: number // settled target width
  scaleY: number // settled target height
  cur: number // current overshoot multiplier, eased toward 1
  ringScale: number // settled ring diameter (world units)
}

// Scratch color reused when tinting the ring from the popup's CSS color string;
// nothing allocates in the update loop or per pop.
const _col = new THREE.Color()

/**
 * Pooled world-space reward popups - a bright "+50" (or any short label) that
 * pops where you capture an alien or grab a shard, overshoots then settles,
 * floats up and fades, with a brief expanding glow ring behind it so rewards
 * read as celebratory. Cheap juice that makes the core loop feel good. Canvas
 * text is only redrawn on a pop (never per frame); nothing allocates in the
 * update loop.
 */
export class FloatingPopups implements GameSystem {
  private group = new THREE.Group()
  private pool: Popup[] = []
  private ringTex: THREE.CanvasTexture | null = null

  constructor(scene: THREE.Scene) {
    // Pool size scales with tier: medium gets a trimmed count between low and high.
    const tier = config.tier.name
    const n = tier === 'low' ? 8 : tier === 'medium' ? 12 : 16
    // The celebratory glow ring is desktop/iPad juice; skip it on low to keep
    // fill-rate and draw calls down on weak GPUs.
    const wantRing = tier !== 'low'
    if (wantRing) this.ringTex = this.makeRingTexture()
    for (let i = 0; i < n; i++) {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
      const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false })
      const sprite = new THREE.Sprite(mat); sprite.scale.set(6, 3, 1); sprite.visible = false

      let ring: THREE.Sprite | null = null
      let ringMat: THREE.SpriteMaterial | null = null
      if (this.ringTex) {
        ringMat = new THREE.SpriteMaterial({ map: this.ringTex, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false, blending: THREE.AdditiveBlending })
        ring = new THREE.Sprite(ringMat); ring.scale.set(6, 6, 1); ring.visible = false
        // Add the ring first so it sits visually behind the text sprite.
        this.group.add(ring)
      }
      this.group.add(sprite)
      this.pool.push({ sprite, mat, tex, canvas, ring, ringMat, t: 0, life: 1, active: false, vy: 0, scaleX: 6, scaleY: 3, cur: 1, ringScale: 6 })
    }
    scene.add(this.group)
  }

  // Soft radial glow ring drawn once to a canvas and shared across all ring
  // slots (only the per-slot material is unique, for independent tint/opacity).
  private makeRingTexture(): THREE.CanvasTexture {
    const s = 128
    const canvas = document.createElement('canvas'); canvas.width = s; canvas.height = s
    const ctx = canvas.getContext('2d')!
    const cx = s / 2
    // Bright thin annulus that fades both inward and outward.
    const g = ctx.createRadialGradient(cx, cx, s * 0.12, cx, cx, s * 0.5)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.55, 'rgba(255,255,255,0.05)')
    g.addColorStop(0.78, 'rgba(255,255,255,0.9)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, s, s)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  /** Pop a short label at a world point. `color` is a CSS color string. */
  pop(x: number, y: number, z: number, text: string, color = '#9bff6a') {
    const p = this.pool.find((q) => !q.active)
    if (!p) return
    const ctx = p.canvas.getContext('2d')!
    ctx.clearRect(0, 0, 256, 128)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.font = '900 76px ui-monospace, Menlo, monospace'
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(text, 128, 64)
    ctx.shadowColor = color; ctx.shadowBlur = 22; ctx.fillStyle = color; ctx.fillText(text, 128, 64)
    p.tex.needsUpdate = true
    p.sprite.position.set(x, y, z)
    p.scaleX = Math.min(9, 4 + text.length * 0.7)
    p.scaleY = Math.min(4.5, 2 + text.length * 0.35)
    // Start small and overshoot: begin under the target, the update loop eases
    // `cur` toward 1 with a brief overshoot for a punchy pop-in.
    p.cur = 0.45
    p.sprite.scale.set(p.scaleX * p.cur, p.scaleY * p.cur, 1)
    p.t = 0; p.life = 1.1; p.vy = 4.2; p.active = true; p.sprite.visible = true
    p.mat.opacity = 1

    if (p.ring && p.ringMat) {
      // Tint the ring from the CSS color, brightened so additive blending reads
      // as a glow rather than a dim wash.
      _col.set(color)
      p.ringMat.color.copy(_col)
      // Ring spans a bit wider than the text and expands outward over its life.
      p.ringScale = Math.max(p.scaleX, p.scaleY) * 1.6
      p.ring.position.set(x, y, z)
      p.ring.scale.set(p.ringScale * 0.5, p.ringScale * 0.5, 1)
      p.ring.visible = true
      p.ringMat.opacity = 0.9
    }
  }

  update(dt: number) {
    // Frame-rate-independent overshoot settle. A spring-like ease that pulls the
    // scale multiplier toward 1, with a transient overshoot driven off life time.
    for (const p of this.pool) {
      if (!p.active) continue
      p.t += dt
      const k = p.t / p.life

      // Ease the overshoot multiplier toward 1 with exponential damping, then add
      // a quick decaying overshoot bump early in the life so it punches past 1.
      p.cur += (1 - p.cur) * (1 - Math.exp(-16 * dt))
      const overshoot = p.t < 0.32 ? Math.sin((p.t / 0.32) * Math.PI) * 0.18 * Math.exp(-p.t * 6) : 0
      const m = p.cur + overshoot
      p.sprite.scale.set(p.scaleX * m, p.scaleY * m, 1)

      // Stronger upward ease-out drift: fast at birth, decaying toward a gentle float.
      p.vy = Math.max(0.5, p.vy - dt * 4.2)
      p.sprite.position.y += p.vy * dt

      // Brighten then fade: snap bright on entry, hold, then ease out.
      p.mat.opacity = k < 0.12 ? k / 0.12 : Math.max(0, 1 - (k - 0.12) / 0.88)

      // Expanding glow ring: scales out and fades fast over the first ~40% of life.
      if (p.ring && p.ringMat) {
        if (p.ringMat.opacity > 0.001) {
          const rk = Math.min(1, p.t / (p.life * 0.45))
          const ease = 1 - (1 - rk) * (1 - rk) // ease-out
          const rs = p.ringScale * (0.5 + ease * 1.1)
          p.ring.scale.set(rs, rs, 1)
          p.ring.position.copy(p.sprite.position)
          p.ringMat.opacity = 0.9 * (1 - rk) * (1 - rk)
          if (rk >= 1) { p.ringMat.opacity = 0; p.ring.visible = false }
        } else if (p.ring.visible) {
          p.ring.visible = false
        }
      }

      if (p.t >= p.life) {
        p.active = false
        p.sprite.visible = false
        if (p.ring) p.ring.visible = false
      }
    }
  }

  dispose() {
    for (const p of this.pool) {
      p.tex.dispose(); p.mat.dispose()
      if (p.ringMat) p.ringMat.dispose()
    }
    if (this.ringTex) { this.ringTex.dispose(); this.ringTex = null }
  }
}
