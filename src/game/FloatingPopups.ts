import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'

interface Popup {
  sprite: THREE.Sprite
  mat: THREE.SpriteMaterial
  tex: THREE.CanvasTexture
  canvas: HTMLCanvasElement
  t: number
  life: number
  active: boolean
  vy: number
}

/**
 * Pooled world-space reward popups - a bright "+50" (or any short label) that
 * pops where you capture an alien or grab a shard, floats up and fades. Cheap
 * juice that makes the core loop feel good. Canvas text is only redrawn on a pop
 * (never per frame); nothing allocates in the update loop.
 */
export class FloatingPopups implements GameSystem {
  private group = new THREE.Group()
  private pool: Popup[] = []

  constructor(scene: THREE.Scene) {
    // Pool size scales with tier: medium gets a trimmed count between low and high.
    const tier = config.tier.name
    const n = tier === 'low' ? 8 : tier === 'medium' ? 12 : 16
    for (let i = 0; i < n; i++) {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
      const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false })
      const sprite = new THREE.Sprite(mat); sprite.scale.set(6, 3, 1); sprite.visible = false
      this.group.add(sprite)
      this.pool.push({ sprite, mat, tex, canvas, t: 0, life: 1, active: false, vy: 0 })
    }
    scene.add(this.group)
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
    p.sprite.scale.set(Math.min(9, 4 + text.length * 0.7), Math.min(4.5, 2 + text.length * 0.35), 1)
    p.t = 0; p.life = 1.1; p.vy = 3.4; p.active = true; p.sprite.visible = true
    p.mat.opacity = 1
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue
      p.t += dt
      const k = p.t / p.life
      p.vy = Math.max(0.6, p.vy - dt * 3)
      p.sprite.position.y += p.vy * dt
      // Pop in, hold, fade out.
      p.mat.opacity = k < 0.15 ? k / 0.15 : Math.max(0, 1 - (k - 0.15) / 0.85)
      if (p.t >= p.life) { p.active = false; p.sprite.visible = false }
    }
  }

  dispose() {
    for (const p of this.pool) { p.tex.dispose(); p.mat.dispose() }
  }
}
