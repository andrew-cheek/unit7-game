import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Ground height under a point in the current zone (so devils hug the terrain). */
  groundY: (x: number, z: number) => number
}

interface Devil {
  group: THREE.Group
  rings: THREE.Mesh[]
  vel: THREE.Vector3 // wander velocity (XZ)
  heading: number // current drift heading
  spin: number // rad/s base spin
  phase: number
  scale: number
}

const AREA = 150 // devils wander within a +/-AREA square

/**
 * Mars-only ambient spectacle: roaming dust devils. Tapering columns of swirling
 * rust-coloured dust wander the surface, spinning and bobbing, hugging the
 * terrain. Pure set dressing - no colliders - that gives the red planet some
 * ground-level motion under its dust-storm sky. Pooled + Mars-gated; the rings
 * are shared geometry so a devil is cheap.
 */
export class DustDevils implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private devils: Devil[] = []
  private zone: Zone = 'earth'

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const med = config.tier.name === 'medium'
    const n = low ? 2 : med ? 3 : 4
    const layers = low ? 5 : 7

    // One shared ring geo per layer (radii grow up the column), shared across devils.
    const ringGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < layers; i++) {
      const r = 0.8 + i * 0.7
      const g = new THREE.TorusGeometry(r, 0.28 + i * 0.05, 6, 16)
      this.geos.push(g); ringGeos.push(g)
    }
    const mat = new THREE.MeshBasicMaterial({ color: 0xc8743c, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false, fog: true })
    this.mats.push(mat)

    for (let d = 0; d < n; d++) {
      const group = new THREE.Group()
      const rings: THREE.Mesh[] = []
      for (let i = 0; i < layers; i++) {
        const ring = new THREE.Mesh(ringGeos[i], mat)
        ring.rotation.x = Math.PI / 2
        ring.position.y = i * 1.4
        group.add(ring)
        rings.push(ring)
      }
      const scale = 0.8 + Math.random() * 0.9
      group.scale.setScalar(scale)
      const heading = Math.random() * Math.PI * 2
      const dev: Devil = {
        group, rings,
        vel: new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading)).multiplyScalar(3 + Math.random() * 3),
        heading,
        spin: (0.8 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1),
        phase: Math.random() * Math.PI * 2,
        scale,
      }
      // Scatter them across the surface to start.
      const x = (Math.random() * 2 - 1) * AREA, z = (Math.random() * 2 - 1) * AREA
      group.position.set(x, 0, z)
      this.devils.push(dev)
      this.group.add(group)
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'mars'
  }

  /** Rising-air lift (m/s) if the point sits inside a dust devil's column, else 0.
   *  Walk into one on Mars and it flings you up - handy for the high shards. */
  liftAt(x: number, y: number, z: number): number {
    if (this.zone !== 'mars') return 0
    for (const d of this.devils) {
      const p = d.group.position
      const dx = x - p.x, dz = z - p.z
      const rad = 4 * d.scale
      if (dx * dx + dz * dz > rad * rad) continue
      const top = p.y + 13 * d.scale
      if (y >= p.y - 2 && y < top) return 15
    }
    return 0
  }

  update(dt: number) {
    if (this.zone !== 'mars') return
    for (const d of this.devils) {
      // Lazy random-walk: nudge the heading, reflect at the boundary.
      d.heading += (Math.random() - 0.5) * dt * 1.2
      const sp = d.vel.length() || 4
      d.vel.set(Math.cos(d.heading), 0, Math.sin(d.heading)).multiplyScalar(sp)
      const p = d.group.position
      p.x += d.vel.x * dt
      p.z += d.vel.z * dt
      if (Math.abs(p.x) > AREA) { p.x = Math.sign(p.x) * AREA; d.heading = Math.PI - d.heading }
      if (Math.abs(p.z) > AREA) { p.z = Math.sign(p.z) * AREA; d.heading = -d.heading }
      p.y = this.deps.groundY(p.x, p.z)
      // Swirl: each ring spins, faster toward the top, and the column sways.
      d.phase += dt
      for (let i = 0; i < d.rings.length; i++) {
        const ring = d.rings[i]
        ring.rotation.z += d.spin * (1 + i * 0.25) * dt
        const sway = Math.sin(d.phase * 1.6 + i * 0.5) * 0.12 * i
        ring.position.x = sway
        ring.position.z = Math.cos(d.phase * 1.3 + i * 0.5) * 0.1 * i
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
