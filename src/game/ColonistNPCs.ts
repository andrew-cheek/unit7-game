import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so colonists keep milling about wherever you wander off-world. */
  focus: () => THREE.Vector3
  /** Ground height under a point in the current zone, so figures stay on terrain. */
  groundY: (x: number, z: number) => number
}

interface Colonist {
  group: THREE.Group
  pos: THREE.Vector3
  target: THREE.Vector3
  heading: number // current facing yaw (eased toward travel direction)
  speed: number
  phase: number // bob/waddle walk-cycle phase
  dwell: number // >0 = pausing at a waypoint, counting down
}

const NEAR = 110 // colonists wander within this radius of the player
const FAR = 130 // beyond this, respawn closer in

/**
 * Spacesuited colonists wandering the Moon and Mars surface near you, so the
 * off-world zones feel inhabited rather than empty. Pure character: chunky
 * low-poly figures with glowing additive visors that slow-walk between random
 * waypoints, waddling and turning toward travel. No colliders, no gameplay.
 * Pooled + shared geos/mats, zone-gated to off-world (hidden on Earth's crowd).
 */
export class ColonistNPCs implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private colonists: Colonist[] = []
  private zone: Zone = 'earth'
  private suitMats: THREE.MeshStandardMaterial[] = []
  // Pre-allocated scratch reused every frame (no per-frame heap allocation).
  private dir = new THREE.Vector3()
  private fp = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const count = low ? 5 : 9

    // Shared geometry reused across every colonist.
    const bodyGeo = this.ownG(new THREE.CapsuleGeometry(0.42, 0.7, 4, 10))
    const helmetGeo = this.ownG(new THREE.SphereGeometry(0.4, 12, 10))
    const visorGeo = this.ownG(new THREE.SphereGeometry(0.31, 12, 8, -Math.PI * 0.55, Math.PI * 1.1, Math.PI * 0.32, Math.PI * 0.42))
    const packGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.6, 0.28))
    const limbGeo = this.ownG(new THREE.CapsuleGeometry(0.14, 0.42, 3, 6))

    // Shared suit materials with a couple of tint variations (white/orange suits).
    this.suitMats = [
      this.own(new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.65, metalness: 0.1 })),
      this.own(new THREE.MeshStandardMaterial({ color: 0xe9eef4, roughness: 0.7, metalness: 0.1 })),
      this.own(new THREE.MeshStandardMaterial({ color: 0xff8a3c, roughness: 0.6, metalness: 0.12 })),
    ]
    // Helmet shell + glowing additive visor (kept bright on both worlds).
    const helmetMat = this.own(new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.4, metalness: 0.2 }))
    const visorMat = this.own(new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const packMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.6, metalness: 0.4 }))

    for (let i = 0; i < count; i++) {
      const suitMat = this.suitMats[i % this.suitMats.length]
      const g = new THREE.Group()

      const body = new THREE.Mesh(bodyGeo, suitMat); body.position.y = 0.95; g.add(body)
      const helmet = new THREE.Mesh(helmetGeo, helmetMat); helmet.position.y = 1.7; g.add(helmet)
      const visor = new THREE.Mesh(visorGeo, visorMat); visor.position.set(0, 1.7, 0.06); g.add(visor)
      const pack = new THREE.Mesh(packGeo, packMat); pack.position.set(0, 1.0, -0.42); g.add(pack)

      // Stubby arms + legs; arms swing, legs stride in the waddle cycle.
      const armL = new THREE.Mesh(limbGeo, suitMat); armL.name = 'armL'; armL.position.set(-0.52, 1.0, 0); g.add(armL)
      const armR = new THREE.Mesh(limbGeo, suitMat); armR.name = 'armR'; armR.position.set(0.52, 1.0, 0); g.add(armR)
      const legL = new THREE.Mesh(limbGeo, suitMat); legL.name = 'legL'; legL.position.set(-0.22, 0.35, 0); g.add(legL)
      const legR = new THREE.Mesh(limbGeo, suitMat); legR.name = 'legR'; legR.position.set(0.22, 0.35, 0); g.add(legR)

      const pos = new THREE.Vector3()
      const target = new THREE.Vector3()
      this.group.add(g)
      const c: Colonist = {
        group: g, pos, target,
        heading: Math.random() * Math.PI * 2,
        speed: 1.4 + Math.random() * 0.9,
        phase: Math.random() * Math.PI * 2,
        dwell: 0,
      }
      this.scatter(c, true)
      this.colonists.push(c)
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Place a colonist (or just its next target) at a fresh point near the player. */
  private scatter(c: Colonist, placeNow: boolean) {
    const f = this.deps.focus()
    const a = Math.random() * Math.PI * 2
    const r = 18 + Math.random() * (NEAR - 18)
    const x = f.x + Math.cos(a) * r
    const z = f.z + Math.sin(a) * r
    c.target.set(x, this.deps.groundY(x, z), z)
    if (placeNow) {
      c.pos.set(x, c.target.y, z)
      c.group.position.copy(c.pos)
      // Steer it toward a second nearby waypoint so it starts walking, not idle.
      this.scatter(c, false)
    }
  }

  /** Theme the shared suit tints per world: cool grey on the Moon, dusty orange on Mars. */
  setZone(zone: Zone) {
    this.zone = zone
    const active = zone === 'moon' || zone === 'mars'
    this.group.visible = active
    if (!active) return
    if (zone === 'moon') {
      this.suitMats[0].color.setHex(0xf2f4f8)
      this.suitMats[1].color.setHex(0xcfd8e2)
      this.suitMats[2].color.setHex(0xeef2f6)
    } else {
      this.suitMats[0].color.setHex(0xe8d2bf)
      this.suitMats[1].color.setHex(0xd9a07a)
      this.suitMats[2].color.setHex(0xff8a3c)
    }
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const active = this.zone === 'moon' || this.zone === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return

    const moon = this.zone === 'moon'
    this.fp.copy(this.deps.focus())

    for (const c of this.colonists) {
      // Respawn nearer if the player has wandered far from this colonist.
      this.dir.subVectors(c.pos, this.fp)
      if (Math.hypot(this.dir.x, this.dir.z) > FAR) { this.scatter(c, true); continue }

      let moving = false
      if (c.dwell > 0) {
        c.dwell -= dt
        if (c.dwell <= 0) this.scatter(c, false)
      } else {
        this.dir.subVectors(c.target, c.pos)
        this.dir.y = 0
        const dist = Math.hypot(this.dir.x, this.dir.z)
        if (dist < 1.0) {
          c.dwell = 0.6 + Math.random() * 2.2
        } else {
          moving = true
          this.dir.multiplyScalar(1 / dist) // normalize without allocating
          const step = Math.min(dist, c.speed * dt)
          c.pos.x += this.dir.x * step
          c.pos.z += this.dir.z * step
          // Ease facing toward travel direction.
          let turn = Math.atan2(this.dir.x, this.dir.z) - c.heading
          while (turn > Math.PI) turn -= Math.PI * 2
          while (turn < -Math.PI) turn += Math.PI * 2
          c.heading += turn * Math.min(1, dt * 5)
        }
      }

      // Bob/waddle walk cycle; bouncier in the Moon's low gravity.
      if (moving) c.phase += dt * c.speed * 4
      const gy = this.deps.groundY(c.pos.x, c.pos.z)
      const bobAmp = moon ? 0.18 : 0.08
      const bob = moving ? Math.abs(Math.sin(c.phase)) * bobAmp : 0
      c.pos.y = gy
      c.group.position.set(c.pos.x, gy + bob, c.pos.z)
      c.group.rotation.y = c.heading
      c.group.rotation.z = moving ? Math.sin(c.phase) * 0.05 : 0

      // Swing arms/legs in opposition for a readable stride.
      const swing = moving ? Math.sin(c.phase) * 0.6 : 0
      for (const limb of c.group.children) {
        if (limb.name === 'armL' || limb.name === 'legR') limb.rotation.x = swing
        else if (limb.name === 'armR' || limb.name === 'legL') limb.rotation.x = -swing
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
