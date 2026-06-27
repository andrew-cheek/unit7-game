import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ, so shards float a fixed height above it. */
  groundY: (x: number, z: number) => number
  /** Called when a shard is collected: award credits + XP and pop a label. */
  onCollect: (x: number, y: number, z: number, credits: number) => void
}

interface Shard {
  group: THREE.Group
  core: THREE.Mesh
  halo: THREE.Mesh
  haloMat: THREE.MeshBasicMaterial
  x: number
  y: number
  z: number
  phase: number
  spin: number
  cooldown: number // >0 = collected, counting down to respawn
}

/** Deterministic PRNG so the shard layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Sky-shards: floating reward crystals suspended high over the neon city that
 * give the vertical traversal (jetpack, gravity-lifts) a point - reach one and
 * it pays out credits, then respawns after a cooldown so the loop keeps giving.
 * Each is a spinning octahedron with a soft additive halo. Earth-gated; the
 * payout runs through a Game callback. Shared geometry, pooled, disposed together.
 */
export class SkyShards implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private shards: Shard[] = []
  private zone: Zone = 'earth'
  private t = 0
  private readonly reach = 3.2 // collect radius
  private readonly credits = 40
  private readonly respawn = 12 // seconds before a collected shard returns

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 7 : 14
    const rnd = mulberry32(60606)
    const reach = config.world.half * 0.7

    const coreGeo = this.ownG(new THREE.OctahedronGeometry(0.9, 0))
    const haloGeo = this.ownG(new THREE.SphereGeometry(1.5, 12, 10))
    const tints = [0x49e0ff, 0x9bff6a, 0xffd24a, 0xb07cff]

    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      // Float them at a spread of reachable heights: low ones are jetpack-easy,
      // high ones reward the gravity-lifts. Height above the local ground.
      const y = this.deps.groundY(x, z) + 8 + rnd() * 34
      const tint = tints[(rnd() * tints.length) | 0]

      const group = new THREE.Group()
      group.position.set(x, y, z)
      const coreMat = this.own(new THREE.MeshBasicMaterial({ color: tint, fog: false }))
      const core = new THREE.Mesh(coreGeo, coreMat)
      group.add(core)
      const haloMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const halo = new THREE.Mesh(haloGeo, haloMat)
      group.add(halo)

      this.group.add(group)
      this.shards.push({ group, core, halo, haloMat, x, y, z, phase: rnd() * 6.28, spin: 0.6 + rnd() * 0.8, cooldown: 0 })
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

    for (const s of this.shards) {
      if (s.cooldown > 0) {
        s.cooldown -= dt
        if (s.cooldown <= 0) { s.group.visible = true; s.group.scale.setScalar(0.01) } // pop back in
        else continue
      }
      // Spin + bob + halo pulse.
      const bob = Math.sin(this.t * 1.4 + s.phase) * 0.5
      s.group.position.y = s.y + bob
      s.core.rotation.y += s.spin * dt
      s.core.rotation.x += s.spin * 0.5 * dt
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 3 + s.phase)
      s.haloMat.opacity = 0.25 + pulse * 0.2
      // Grow back to full size after a respawn pop-in.
      if (s.group.scale.x < 1) s.group.scale.setScalar(Math.min(1, s.group.scale.x + dt * 3))

      // Collect when the player is close in 3D (you must actually get up to it).
      const dx = s.x - f.x, dy = (s.y + bob) - f.y, dz = s.z - f.z
      if (dx * dx + dy * dy + dz * dz < this.reach * this.reach) {
        this.deps.onCollect(s.x, s.y + bob, s.z, this.credits)
        s.cooldown = this.respawn
        s.group.visible = false
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
