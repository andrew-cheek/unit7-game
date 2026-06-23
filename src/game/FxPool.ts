// Pooled transient particle puffs (steam / energy bursts).
//
// Before this, mech boot-ups allocated a fresh MeshBasicMaterial per puff per
// activation (a GC spike on mobile every time you boarded a giant). This pool
// pre-creates a fixed set of puff meshes with reusable materials and hands them
// out, so spawning a burst allocates nothing. Puffs rise, grow and fade, then
// return to the pool. One shared geometry, one material per slot, reused.

import * as THREE from 'three'
import type { GameSystem } from './System'

interface Puff {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  active: boolean
  t: number
  ttl: number
  vy: number
  baseOpacity: number
  growth: number
}

export interface PuffOptions {
  color?: number
  count?: number
  spread?: number // horizontal scatter radius (m)
  rise?: number // vertical speed (m/s)
  ttl?: number // lifetime (s)
  scale?: number // starting radius
  opacity?: number
  additive?: boolean // additive blend (energy) vs normal (steam)
}

export class FxPool implements GameSystem {
  private scene: THREE.Scene
  private geo = new THREE.SphereGeometry(1, 10, 8)
  private pool: Puff[] = []
  private readonly cap: number

  constructor(scene: THREE.Scene, capacity = 48) {
    this.scene = scene
    this.cap = capacity
  }

  private acquire(): Puff | null {
    for (const p of this.pool) if (!p.active) return p
    if (this.pool.length >= this.cap) return null // pool full: drop the spawn rather than allocate
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false })
    const mesh = new THREE.Mesh(this.geo, mat)
    mesh.visible = false
    this.scene.add(mesh)
    const p: Puff = { mesh, mat, active: false, t: 0, ttl: 1, vy: 0, baseOpacity: 0.5, growth: 0.9 }
    this.pool.push(p)
    return p
  }

  /** Spawn a burst of rising, fading puffs at a world point. Allocation-free. */
  puff(x: number, y: number, z: number, opts: PuffOptions = {}) {
    const color = opts.color ?? 0xcfe6ff
    const count = opts.count ?? 8
    const spread = opts.spread ?? 3.5
    const rise = opts.rise ?? 2.6
    const ttl = opts.ttl ?? 1.4
    const scale = opts.scale ?? 1.6
    const opacity = opts.opacity ?? 0.5
    const blending = opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending
    for (let i = 0; i < count; i++) {
      const p = this.acquire()
      if (!p) return
      p.active = true
      p.t = 0
      p.ttl = ttl * (0.8 + Math.random() * 0.5)
      p.vy = rise * (0.7 + Math.random() * 0.7)
      p.baseOpacity = opacity
      p.growth = 0.7 + Math.random() * 0.5
      p.mat.color.setHex(color)
      p.mat.opacity = opacity
      p.mat.blending = blending
      p.mat.needsUpdate = true
      p.mesh.position.set(x + (Math.random() * 2 - 1) * spread, y + Math.random() * 1.5, z + (Math.random() * 2 - 1) * spread)
      p.mesh.scale.setScalar(scale * (0.7 + Math.random() * 0.8))
      p.mesh.visible = true
    }
  }

  update(dt: number) {
    for (const p of this.pool) {
      if (!p.active) continue
      p.t += dt
      p.mesh.position.y += p.vy * dt
      p.mesh.scale.multiplyScalar(1 + dt * p.growth)
      p.mat.opacity = p.baseOpacity * Math.max(0, 1 - p.t / p.ttl)
      if (p.t >= p.ttl) {
        p.active = false
        p.mesh.visible = false
      }
    }
  }

  dispose() {
    for (const p of this.pool) {
      this.scene.remove(p.mesh)
      p.mat.dispose()
    }
    this.pool = []
    this.geo.dispose()
  }
}
