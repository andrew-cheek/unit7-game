import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Day/night factor: 1 = full day, 0 = night (Earth only). */
  dayFactor: () => number
}

interface Ribbon {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  baseX: number
  baseColor: THREE.Color
  drift: number // horizontal sway speed
  phase: number
  hue: number // base hue, cycled slowly
}

const NIGHT_AT = 0.4 // dayFactor below this starts to reveal the aurora

/**
 * Night aurora over the Earth city: a few large shimmering curtains high in the
 * sky that fade in as the day/night cycle rolls into night and fade back out at
 * dawn. The Earth counterpart to the off-world ambient spectacle - pure set
 * dressing, no colliders. Shares one procedurally-generated gradient texture;
 * everything is disposed together.
 */
export class Aurora implements GameSystem {
  private group = new THREE.Group()
  private ribbons: Ribbon[] = []
  private tex: THREE.Texture
  private gradCanvas: HTMLCanvasElement | null = null // backing store for tex; released in dispose()
  private geo: THREE.PlaneGeometry
  private zone: Zone = 'earth'
  private t = 0
  private scratch = new THREE.Color()

  constructor(scene: THREE.Scene, private deps: Deps) {
    this.tex = this.makeGradient()
    // A wide, tall curtain; waved along its width so overlapping ribbons read as
    // folding sheets of light rather than flat billboards.
    this.geo = new THREE.PlaneGeometry(170, 90, 24, 1)
    const pos = this.geo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      pos.setZ(i, Math.sin(x * 0.06) * 14 + Math.sin(x * 0.13 + 1) * 6)
    }
    this.geo.computeVertexNormals()

    const low = config.tier.name === 'low'
    const n = low ? 2 : 4
    const hues = [0.38, 0.5, 0.78, 0.33] // green, cyan, violet, green
    for (let i = 0; i < n; i++) {
      const hue = hues[i % hues.length]
      const color = new THREE.Color().setHSL(hue, 0.85, 0.55)
      const mat = new THREE.MeshBasicMaterial({ map: this.tex, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(this.geo, mat)
      const baseX = (i - (n - 1) / 2) * 46
      mesh.position.set(baseX, 150 + i * 10, -60 - i * 22)
      mesh.rotation.y = (i - 1.5) * 0.12
      this.group.add(mesh)
      this.ribbons.push({ mesh, mat, baseX, baseColor: color, drift: 0.05 + i * 0.02, phase: i * 1.7, hue })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Vertical alpha gradient: bright near the bottom, fading to nothing on top. */
  private makeGradient(): THREE.Texture {
    const c = document.createElement('canvas')
    c.width = 4; c.height = 128
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 128, 0, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)') // ground edge: soft
    g.addColorStop(0.12, 'rgba(255,255,255,0.95)') // brightest just above the base
    g.addColorStop(0.55, 'rgba(255,255,255,0.35)')
    g.addColorStop(1, 'rgba(255,255,255,0)') // top: gone
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 4, 128)
    this.gradCanvas = c // keep a handle so dispose() can free the backing store
    const tex = new THREE.CanvasTexture(c)
    tex.needsUpdate = true
    return tex
  }

  setZone(zone: Zone) {
    this.zone = zone
    if (zone !== 'earth') this.group.visible = false
  }

  update(dt: number) {
    if (this.zone !== 'earth') return
    const day = this.deps.dayFactor()
    const night = Math.max(0, (NIGHT_AT - day) / NIGHT_AT) // 0..1
    if (night <= 0) { if (this.group.visible) this.group.visible = false; return }
    this.group.visible = true
    this.t += dt
    for (const r of this.ribbons) {
      // Slow sway + a breathing shimmer, brightest deep in the night.
      r.mesh.position.x = r.baseX + Math.sin(this.t * r.drift + r.phase) * 12
      const shimmer = 0.5 + 0.5 * Math.sin(this.t * 0.8 + r.phase)
      r.mat.opacity = night * (0.18 + 0.22 * shimmer)
      // Drift the hue gently so the curtains slide through the spectrum.
      const h = (r.hue + this.t * 0.01) % 1
      r.mat.color.copy(this.scratch.setHSL(h, 0.85, 0.55))
    }
  }

  dispose() {
    this.geo.dispose()
    this.tex.dispose()
    // Shrink the canvas to 0 so its backing store is released sooner, then drop the ref.
    if (this.gradCanvas) {
      this.gradCanvas.width = this.gradCanvas.height = 0
      this.gradCanvas = null
    }
    for (const r of this.ribbons) r.mat.dispose()
  }
}
