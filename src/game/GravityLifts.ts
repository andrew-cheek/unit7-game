import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ so each column sits on the floor. */
  groundY: (x: number, z: number) => number
  /** Called each frame the player is inside a column with the desired climb
   *  velocity, so Game can nudge the player upward (a sustained, controllable
   *  rise rather than an instant fling). */
  lift: (vy: number) => void
}

interface Column {
  group: THREE.Group
  beam: THREE.Mesh
  beamMat: THREE.MeshBasicMaterial
  rings: THREE.Mesh[]
  x: number
  z: number
  baseY: number
  height: number
  phase: number
  glow: number // eased 0..1 brightness, brightens while you ride it
}

/** Deterministic PRNG so the lift layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Gravity-lift columns: translucent beams of light standing in the neon city
 * that smoothly carry you skyward when you step inside - a controllable sustained
 * rise to the rooftops and holo-billboards, distinct from the instant fling of a
 * trampoline. Glowing rings rush up the beam, and it brightens while you ride.
 * Earth-gated; the lift impulse is applied through a Game callback.
 */
export class GravityLifts implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private columns: Column[] = []
  private zone: Zone = 'earth'
  private t = 0
  private readonly radius = 2.4 // how close you must be (XZ) to ride
  private readonly climbVy = 15 // sustained upward velocity inside a column

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 3 : 5
    const ringsPer = low ? 4 : 6
    const rnd = mulberry32(43117)
    // Scatter through the inner city so they're easy to discover while roaming.
    const reach = Math.min(150, config.world.half * 0.55)

    const beamGeo = this.ownG(new THREE.CylinderGeometry(this.radius, this.radius * 1.15, 1, 16, 1, true))
    const ringGeo = this.ownG(new THREE.TorusGeometry(this.radius * 0.85, 0.12, 6, 20))
    const padGeo = this.ownG(new THREE.CircleGeometry(this.radius * 1.2, 24))

    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const baseY = this.deps.groundY(x, z)
      const height = 34 + rnd() * 14
      const tint = [0x49e0ff, 0x9bff6a, 0xb07cff][i % 3]

      const group = new THREE.Group()
      group.position.set(x, baseY, z)

      // The translucent beam shell.
      const beamMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
      const beam = new THREE.Mesh(beamGeo, beamMat)
      beam.scale.y = height
      beam.position.y = height * 0.5
      group.add(beam)

      // A bright floor pad so it reads as "step here".
      const padMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
      const pad = new THREE.Mesh(padGeo, padMat)
      pad.rotation.x = -Math.PI / 2
      pad.position.y = 0.08
      group.add(pad)

      // Rings that rush up the beam.
      const ringMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const rings: THREE.Mesh[] = []
      for (let r = 0; r < ringsPer; r++) {
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.rotation.x = Math.PI / 2
        ring.position.y = (r / ringsPer) * height
        group.add(ring)
        rings.push(ring)
      }

      this.group.add(group)
      this.columns.push({ group, beam, beamMat, rings, x, z, baseY, height, phase: rnd() * 6.28, glow: 0 })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()

    for (const c of this.columns) {
      // Inside? within the XZ radius and below the top of the beam.
      const dx = c.x - f.x, dz = c.z - f.z
      const inXZ = dx * dx + dz * dz < this.radius * this.radius
      const inY = f.y >= c.baseY - 1 && f.y < c.baseY + c.height
      const riding = inXZ && inY
      if (riding) this.deps.lift(this.climbVy)

      // Brighten while ridden, ease back when not.
      c.glow += ((riding ? 1 : 0) - c.glow) * Math.min(1, dt * 5)
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 2 + c.phase)
      c.beamMat.opacity = 0.14 + pulse * 0.05 + c.glow * 0.22

      // Rush the rings upward (faster while ridden); wrap at the top.
      const rise = (6 + c.glow * 14) * dt
      for (const ring of c.rings) {
        ring.position.y += rise
        if (ring.position.y > c.height) ring.position.y -= c.height
        const s = 1 + c.glow * 0.12 + 0.04 * Math.sin(this.t * 4 + ring.position.y)
        ring.scale.set(s, s, s)
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
