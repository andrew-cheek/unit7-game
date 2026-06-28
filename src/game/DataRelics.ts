import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ, so relics float a fixed height above it. */
  groundY: (x: number, z: number) => number
  /** Per-relic scan: small reward + progress popup at the relic. */
  onScan: (got: number, total: number, x: number, y: number, z: number) => void
  /** Big bonus once the whole set is found. */
  onComplete: (credits: number, xp: number) => void
  /** Show a HUD banner line. */
  banner: (text: string) => void
}

interface Relic {
  group: THREE.Group
  core: THREE.Mesh
  cage: THREE.LineSegments
  ring: THREE.Mesh
  haloMat: THREE.MeshBasicMaterial
  x: number
  y: number
  z: number
  phase: number
  spin: number
  collected: boolean
  vanish: number // 0..1 collect animation progress (scale-up + fade)
}

/** Deterministic PRNG so the relic layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Data-relics: a curated "collect-them-all" set of glowing holographic artifacts
 * perched in interesting spots across the neon city (high ledges, rooftops). Get
 * close and a relic auto-scans for a small reward + progress banner; finishing the
 * whole set pays a big completion bonus. Earth-gated, pooled geometry, disposed
 * together. Payouts run through Game callbacks; a fresh set spawns each load.
 */
export class DataRelics implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private relics: Relic[] = []
  private zone: Zone = 'earth'
  private t = 0
  private collected = 0
  private total = 0
  private done = false
  private readonly reach = 3.5 // scan radius
  private readonly scratch = new THREE.Color()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 8 : 12
    this.total = n
    const rnd = mulberry32(31337)
    const reach = config.world.half * 0.8

    // Shared geometry across all relics (pooled, disposed once).
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(0.55, 0))
    const cageGeo = this.ownG(new THREE.WireframeGeometry(new THREE.OctahedronGeometry(1.05, 0)))
    const ringGeo = this.ownG(new THREE.TorusGeometry(1.25, 0.05, 6, 24))
    const haloGeo = this.ownG(new THREE.SphereGeometry(1.4, 12, 10))
    const beamGeo = this.ownG(new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1, true))
    // Cyan/violet palette.
    const tints = [0x49e0ff, 0x9bd4ff, 0x8a6bff, 0xb07cff]

    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      // Vary height: some easy, some perched high (reward jetpack/lifts).
      const gy = this.deps.groundY(x, z)
      const y = gy + 3 + rnd() * 15
      const tint = tints[(rnd() * tints.length) | 0]

      const group = new THREE.Group()
      group.position.set(x, y, z)

      const coreMat = this.own(new THREE.MeshBasicMaterial({ color: tint, fog: false }))
      const core = new THREE.Mesh(coreGeo, coreMat)
      group.add(core)

      const cageMat = this.own(new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: 0.7, fog: false }))
      const cage = new THREE.LineSegments(cageGeo, cageMat)
      group.add(cage)

      const ringMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const ring = new THREE.Mesh(ringGeo, ringMat)
      ring.rotation.x = Math.PI / 2
      group.add(ring)

      const haloMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const halo = new THREE.Mesh(haloGeo, haloMat)
      group.add(halo)

      // Subtle vertical locator beam under the relic so it can be spotted from afar.
      const beamH = y - gy
      const beamMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true }))
      const beam = new THREE.Mesh(beamGeo, beamMat)
      beam.scale.set(1, beamH, 1)
      beam.position.y = -beamH * 0.5
      group.add(beam)

      this.group.add(group)
      this.relics.push({ group, core, cage, ring, haloMat, x, y, z, phase: rnd() * 6.28, spin: 0.4 + rnd() * 0.6, collected: false, vanish: 0 })
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

    for (const r of this.relics) {
      if (r.collected) {
        // Quick scale-up + fade-out, then hide.
        if (r.vanish < 1) {
          r.vanish = Math.min(1, r.vanish + dt * 2.5)
          const s = 1 + r.vanish * 1.2
          r.group.scale.setScalar(s)
          const o = 1 - r.vanish
          r.haloMat.opacity = 0.3 * o
          r.group.visible = o > 0.01
          if (r.vanish >= 1) r.group.visible = false
        }
        continue
      }

      // Spin core (one axis), counter-rotate cage, bob, pulse halo, spin ring.
      const bob = Math.sin(this.t * 1.2 + r.phase) * 0.4
      r.group.position.y = r.y + bob
      r.core.rotation.y += r.spin * dt
      r.core.rotation.x += r.spin * 0.45 * dt
      r.cage.rotation.y -= r.spin * 0.6 * dt
      r.cage.rotation.x += r.spin * 0.25 * dt
      r.ring.rotation.z += r.spin * 0.5 * dt
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.6 + r.phase)
      r.haloMat.opacity = 0.22 + pulse * 0.16

      // Scan when the player is close in 3D (you must reach it).
      const dx = r.x - f.x, dy = (r.y + bob) - f.y, dz = r.z - f.z
      if (dx * dx + dy * dy + dz * dz < this.reach * this.reach) {
        r.collected = true
        this.collected++
        this.deps.onScan(this.collected, this.total, r.x, r.y + bob, r.z)
        // Flash white at the moment of pickup for a crisp pop.
        this.scratch.set(0xffffff)
        ;(r.core.material as THREE.MeshBasicMaterial).color.copy(this.scratch)
        if (this.collected >= this.total && !this.done) {
          this.done = true
          this.deps.onComplete(800, 500)
          this.deps.banner('ALL DATA RELICS FOUND!')
        }
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
