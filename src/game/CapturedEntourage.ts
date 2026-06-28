import * as THREE from 'three'
import type { GameSystem } from './System'
import { config } from './config'

interface Deps {
  /** Player position to trail. */
  focus: () => THREE.Vector3
  /** Player facing (radians), so the posse trails BEHIND the player. */
  yaw: () => number
  /** How many aliens you've captured this session (sizes the posse). */
  count: () => number
}

/** One pooled captured-alien follower: its meshes plus spring-follow state. */
interface Follower {
  group: THREE.Group
  core: THREE.MeshBasicMaterial
  halo: THREE.MeshBasicMaterial
  pos: THREE.Vector3
  vel: THREE.Vector3
  phase: number
  placed: boolean
}

/**
 * A floating entourage of the aliens you've captured, bobbing along behind the
 * player as a flex/progression display - the more you've caught, the bigger your
 * posse. Cute glowing orbs trail in a loose V with spring-follow lag, bob, spin
 * and pulse. Pure character; no gameplay, no colliders. Shows in every zone.
 */
export class CapturedEntourage implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private followers: Follower[] = []
  private scratch = new THREE.Vector3()
  private t = 0

  // A small neon palette to tint each captured alien from.
  private static readonly PALETTE = [0x49e0ff, 0xff5fd2, 0x7cff5f, 0xffd24a, 0xb37cff, 0xff8a5f]

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const max = config.tier.name === 'low' ? 6 : 10

    // Shared geometry across all followers (one allocation each).
    const bodyGeo = this.ownG(new THREE.SphereGeometry(0.22, 12, 10))
    const coreGeo = this.ownG(new THREE.SphereGeometry(0.1, 10, 8))
    const haloGeo = this.ownG(new THREE.RingGeometry(0.18, 0.28, 16))

    for (let i = 0; i < max; i++) {
      const tint = CapturedEntourage.PALETTE[i % CapturedEntourage.PALETTE.length]
      const bodyMat = this.own(new THREE.MeshStandardMaterial({
        color: tint, metalness: 0.2, roughness: 0.5, emissive: tint, emissiveIntensity: 0.6,
        transparent: true, opacity: 0.85,
      }))
      const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, fog: false }))
      const haloMat = this.own(new THREE.MeshBasicMaterial({
        color: tint, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      }))

      const g = new THREE.Group()
      const body = new THREE.Mesh(bodyGeo, bodyMat); body.scale.set(1, 0.9, 1); g.add(body)
      const core = new THREE.Mesh(coreGeo, coreMat); core.position.set(0, 0.04, 0.16); g.add(core)
      const halo = new THREE.Mesh(haloGeo, haloMat); halo.position.set(0, 0.04, 0.17); g.add(halo)

      g.visible = false
      this.group.add(g)
      this.followers.push({ group: g, core: coreMat, halo: haloMat, pos: new THREE.Vector3(), vel: new THREE.Vector3(), phase: i * 1.7, placed: false })
    }

    scene.add(this.group)
  }

  update(dt: number) {
    this.t += dt
    const p = this.deps.focus()
    const yaw = this.deps.yaw()
    const n = Math.max(0, Math.min(this.followers.length, Math.floor(this.deps.count())))

    // Behind-the-player basis: -forward points back, right spreads the V sideways.
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw)
    const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw)

    for (let i = 0; i < this.followers.length; i++) {
      const f = this.followers[i]
      if (i >= n) {
        if (f.group.visible) { f.group.visible = false; f.placed = false }
        continue
      }
      f.group.visible = true

      // Formation slot: rows fall back in a loose V, alternating left/right.
      const row = Math.floor(i / 2)
      const side = (i % 2 === 0 ? -1 : 1)
      const back = 1.3 + row * 0.85
      const spread = (row * 0.55 + 0.45) * side
      const bob = Math.sin(this.t * 1.8 + f.phase) * 0.12

      const tx = p.x - fwdX * back + rightX * spread
      const tz = p.z - fwdZ * back + rightZ * spread
      const ty = p.y + 1.7 + bob
      this.scratch.set(tx, ty, tz)

      if (!f.placed) { f.pos.copy(this.scratch); f.vel.set(0, 0, 0); f.placed = true }
      else {
        // Critically-damped-ish spring so each one swarms then settles.
        const k = Math.min(1, dt * 6)
        f.vel.x += (this.scratch.x - f.pos.x) * k - f.vel.x * k
        f.vel.y += (this.scratch.y - f.pos.y) * k - f.vel.y * k
        f.vel.z += (this.scratch.z - f.pos.z) * k - f.vel.z * k
        f.pos.addScaledVector(f.vel, Math.min(1, dt * 9))
      }

      f.group.position.copy(f.pos)
      f.group.rotation.y += dt * 0.9 // slow spin
      f.group.rotation.z = Math.sin(this.t * 1.4 + f.phase) * 0.18
      // Gentle pulse on the bright core + halo.
      const pulse = 0.6 + 0.4 * Math.sin(this.t * 3 + f.phase)
      f.core.opacity = 0.7 + pulse * 0.3
      f.core.transparent = true
      f.halo.opacity = 0.3 + pulse * 0.3
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
