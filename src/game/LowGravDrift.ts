import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the drift field always surrounds wherever you are. */
  focus: () => THREE.Vector3
}

/** Deterministic PRNG so the field is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const HALF = 40 // half-extent of the field box around the player (XZ + Y)
const WRAP = 40 // distance from player at which a piece wraps to the far side
const SPAN = WRAP * 2

interface Piece {
  mesh: THREE.Mesh
  vx: number; vy: number; vz: number // drift velocity (units/sec)
  sx: number; sy: number; sz: number // tumble rates (rad/sec)
  ice: boolean // ice/ore shard (twinkles) vs grey rock chunk
}

/**
 * Lunar low-gravity drift: a pool of regolith chunks, ice crystals and glinting
 * ore that hang and slowly tumble around the player, half-floating with a slight
 * upward bias to sell the Moon's weightlessness. The field wraps to stay centred
 * on you. MOON only, pure ambience, no colliders. Disposed together.
 */
export class LowGravDrift implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private pieces: Piece[] = []
  private zone: Zone = 'earth'
  private t = 0
  private needsReseed = false
  // Scratch centre, reused each frame so we never allocate in update().
  private center = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 24 : 44
    const rnd = mulberry32(305517)

    // --- shared geometry/materials ---
    const rockGeoA = this.ownG(new THREE.IcosahedronGeometry(0.5, 0))
    const rockGeoB = this.ownG(new THREE.IcosahedronGeometry(0.8, 0))
    const shardGeo = this.ownG(new THREE.OctahedronGeometry(0.45, 0))
    const rockMat = this.own(new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.95, metalness: 0.05, flatShading: true, fog: true }))
    const iceMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbff4ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))

    for (let i = 0; i < n; i++) {
      // ~1 in 3 pieces is a glinty ice/ore shard; the rest are grey rock chunks.
      const ice = rnd() < 0.34
      const geo = ice ? shardGeo : (rnd() < 0.5 ? rockGeoA : rockGeoB)
      const mesh = new THREE.Mesh(geo, ice ? iceMat : rockMat)
      const s = ice ? 0.5 + rnd() * 0.7 : 0.5 + rnd() * 1.1
      mesh.scale.setScalar(s)
      mesh.frustumCulled = false
      this.group.add(mesh)
      const p: Piece = {
        mesh,
        // Slow drift, slight upward bias so debris seems to half-float.
        vx: (rnd() * 2 - 1) * 0.45,
        vy: (rnd() * 2 - 1) * 0.35 + 0.12,
        vz: (rnd() * 2 - 1) * 0.45,
        // Slow tumble.
        sx: (rnd() * 2 - 1) * 0.5,
        sy: (rnd() * 2 - 1) * 0.5,
        sz: (rnd() * 2 - 1) * 0.5,
        ice,
      }
      mesh.rotation.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28)
      this.pieces.push(p)
    }

    // Seed positions around the initial focus (re-seeded on the first moon frame).
    this.reseed()

    this.group.visible = false
    scene.add(this.group)
  }

  /** Scatter every piece into the box centred on the current focus. */
  private reseed() {
    const f = this.deps.focus()
    const rnd = mulberry32(908231)
    for (const p of this.pieces) {
      // Lower-band pieces hover near the ground, others ride higher in the box.
      const lowBand = rnd() < 0.45
      const y = lowBand ? rnd() * (HALF * 0.4) : (HALF * 0.4) + rnd() * (HALF * 1.2)
      p.mesh.position.set(
        f.x + (rnd() * 2 - 1) * HALF,
        f.y + y - HALF * 0.3,
        f.z + (rnd() * 2 - 1) * HALF,
      )
    }
  }

  setZone(zone: Zone) {
    const wasMoon = this.zone === 'moon'
    this.zone = zone
    // Re-centre on the player the first active frame after arriving on the Moon.
    if (zone === 'moon' && !wasMoon) this.needsReseed = true
  }

  update(dt: number) {
    const active = this.zone === 'moon'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return
    if (this.needsReseed) { this.reseed(); this.needsReseed = false }

    this.t += dt
    const f = this.deps.focus()
    this.center.copy(f)

    for (const p of this.pieces) {
      const m = p.mesh
      // Drift.
      m.position.x += p.vx * dt
      m.position.y += p.vy * dt
      m.position.z += p.vz * dt
      // Slow tumble.
      m.rotation.x += p.sx * dt
      m.rotation.y += p.sy * dt
      m.rotation.z += p.sz * dt

      // Wrap on all three axes to keep the field centred on the player.
      let d = m.position.x - this.center.x
      if (d > WRAP) m.position.x -= SPAN; else if (d < -WRAP) m.position.x += SPAN
      d = m.position.y - this.center.y
      if (d > WRAP) m.position.y -= SPAN; else if (d < -WRAP) m.position.y += SPAN
      d = m.position.z - this.center.z
      if (d > WRAP) m.position.z -= SPAN; else if (d < -WRAP) m.position.z += SPAN
    }

    // Subtle twinkle on the ice shards via the shared additive material's opacity.
    this.iceMatOpacity()
  }

  /** Pulse the shared ice material opacity for a global glint. */
  private iceMatOpacity() {
    const ice = this.mats[1] as THREE.MeshBasicMaterial
    ice.opacity = 0.6 + 0.3 * (0.5 + 0.5 * Math.sin(this.t * 2.1))
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
