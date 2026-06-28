import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'
import type { Capturable } from './Game'

/**
 * A rare ELITE bounty target that periodically appears in the city: a sleek,
 * flashy gold/magenta drone-creature that wanders, then actively FLEES (juke +
 * boost) when the player closes in, so catching it with the existing net/missiles
 * is a real chase worth a big payout. Announced by a banner + a bright pulsing
 * aura so you can spot it. One alive at a time; escapes if uncaught. Earth only.
 */

interface Deps {
  /** Player position (detection + flee target). */
  focus: () => THREE.Vector3
  /** Ground height under a point (hover height + spawn placement). */
  groundY: (x: number, z: number) => number
  /** Big payout + popup on a successful capture. */
  onCaught: (credits: number, xp: number, x: number, y: number, z: number) => void
  /** Transient center banner ("ELITE BOUNTY SPOTTED" etc.). */
  banner: (text: string) => void
}

type Phase = 'hidden' | 'active'

const AREA = 135 // wanders within a +/-AREA square around origin
const FLEE_RANGE = 22 // player within this range triggers active evasion
const FLEE_SPEED = 15.5 // a touch above sprint, but jetpack/missiles can still catch it
const WANDER_SPEED = 7
const HOVER = 3 // rest height above local ground (head height)
const ESCAPE_AFTER = 35 // seconds active before it gives up and escapes
const BOUNTY_CREDITS = 500
const BOUNTY_XP = 250

export class BountyHunt implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'

  private cap: Capturable
  private pos = new THREE.Vector3()
  private vel = new THREE.Vector3()
  private wp = new THREE.Vector3() // current wander waypoint

  private phase: Phase = 'hidden'
  private cooldown = 12 + Math.random() * 8 // first appearance delay
  private aliveTimer = 0 // seconds spent active (toward ESCAPE_AFTER)
  private bob = Math.random() * Math.PI * 2
  private spin = Math.random() * Math.PI * 2
  private pulse = 0

  // pulsed materials so the aura/body shimmer independently
  private auraMat: THREE.MeshBasicMaterial
  private coreMat: THREE.MeshBasicMaterial
  private trailMat: THREE.MeshBasicMaterial

  // scratch - reused every frame, no per-frame allocation
  private toPlayer = new THREE.Vector3()
  private toWp = new THREE.Vector3()
  private desired = new THREE.Vector3()
  private perp = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, capturables: Capturable[], private deps: Deps) {
    const low = config.tier.name === 'low'

    // --- geometry (simplified segments on low) ---
    const bodyGeo = this.ownG(new THREE.OctahedronGeometry(0.85, 0))
    const ringGeo = this.ownG(new THREE.TorusGeometry(1.0, 0.06, low ? 6 : 8, low ? 16 : 28))
    const coreGeo = this.ownG(new THREE.SphereGeometry(0.34, low ? 8 : 12, low ? 6 : 10))
    const auraGeo = this.ownG(new THREE.SphereGeometry(1.5, low ? 12 : 20, low ? 8 : 14))
    const trailGeo = this.ownG(new THREE.ConeGeometry(0.55, 2.4, low ? 6 : 10, 1, true))
    const finGeo = this.ownG(new THREE.TetrahedronGeometry(0.5, 0))

    // gold/magenta tinting so it reads as "special"
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a1326, metalness: 0.9, roughness: 0.25, emissive: 0xff3aa0, emissiveIntensity: 0.7 }))
    const ringMat = this.own(new THREE.MeshStandardMaterial({ color: 0xffd24a, metalness: 1, roughness: 0.2, emissive: 0xffb020, emissiveIntensity: 0.9 }))
    this.coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffe9a0, fog: false }))
    this.auraMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff7adf, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide, fog: false }))
    this.trailMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffc24a, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const finMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff5ac8, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    const body = new THREE.Mesh(bodyGeo, bodyMat); this.group.add(body)
    const core = new THREE.Mesh(coreGeo, this.coreMat); this.group.add(core)
    const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = Math.PI / 2; this.group.add(ring)
    const ring2 = new THREE.Mesh(ringGeo, ringMat); ring2.rotation.z = Math.PI / 2; this.group.add(ring2)
    const aura = new THREE.Mesh(auraGeo, this.auraMat); this.group.add(aura)
    const trail = new THREE.Mesh(trailGeo, this.trailMat); trail.rotation.x = -Math.PI / 2; trail.position.z = -1.4; this.group.add(trail)
    for (const sx of [-0.7, 0.7]) {
      const fin = new THREE.Mesh(finGeo, finMat); fin.position.set(sx, 0, -0.2); this.group.add(fin)
    }

    this.cap = { position: this.pos, alive: false, capture: () => this.onCaptured() }
    capturables.push(this.cap)

    this.group.visible = false
    scene.add(this.group)
  }

  /** Place the target far from the player and enter the active hunt. */
  private appear() {
    const focus = this.deps.focus()
    let x = 0, z = 0
    for (let i = 0; i < 8; i++) {
      x = (Math.random() * 2 - 1) * AREA
      z = (Math.random() * 2 - 1) * AREA
      const dx = x - focus.x, dz = z - focus.z
      if (dx * dx + dz * dz > 55 * 55) break // comfortably away so the player has to find it
    }
    this.pos.set(x, this.deps.groundY(x, z) + HOVER, z)
    this.vel.set(0, 0, 0)
    this.pickWaypoint()
    this.phase = 'active'
    this.aliveTimer = 0
    this.cap.alive = true
    this.group.visible = true
    this.group.position.copy(this.pos)
    this.deps.banner('⭐ ELITE BOUNTY SPOTTED')
  }

  /** Hide the target and schedule the next appearance. */
  private retire() {
    this.phase = 'hidden'
    this.cap.alive = false
    this.group.visible = false
    this.vel.set(0, 0, 0)
    this.cooldown = 25 + Math.random() * 15
  }

  /** Choose a fresh wander waypoint within the play area. */
  private pickWaypoint() {
    this.wp.set((Math.random() * 2 - 1) * AREA, 0, (Math.random() * 2 - 1) * AREA)
  }

  /** Netted/blasted: pay the big bounty, banner, retire with a cooldown. */
  private onCaptured(): number {
    if (!this.cap.alive) return 0
    // Pay the full bounty through the callback only, then return 0 so the weapon
    // doesn't convert the return value into a SECOND credit+score payout (the
    // multi-hit bosses guard the same way).
    this.deps.onCaught(BOUNTY_CREDITS, BOUNTY_XP, this.pos.x, this.pos.y, this.pos.z)
    this.deps.banner('⭐ BOUNTY CAPTURED')
    this.retire()
    return 0
  }

  setZone(zone: Zone) {
    this.zone = zone
    const on = zone === 'earth' && this.phase === 'active'
    this.group.visible = on
    this.cap.alive = on
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (!onEarth) {
      // Off-Earth: keep hidden and inert so Earth-only weapons ignore it.
      if (this.group.visible) this.group.visible = false
      if (this.cap.alive) this.cap.alive = false
      return
    }

    if (this.phase === 'hidden') {
      this.cooldown -= dt
      if (this.cooldown <= 0) this.appear()
      return
    }

    // --- active hunt ---
    this.aliveTimer += dt
    if (this.aliveTimer >= ESCAPE_AFTER) {
      this.deps.banner('BOUNTY ESCAPED')
      this.retire()
      return
    }

    this.bob += dt
    this.spin += dt * 3
    this.pulse += dt

    const focus = this.deps.focus()
    this.toPlayer.copy(focus).sub(this.pos)
    const distSq = this.toPlayer.x * this.toPlayer.x + this.toPlayer.z * this.toPlayer.z
    const dist = Math.sqrt(distSq)

    if (dist < FLEE_RANGE) {
      // Evade: accelerate directly away, plus a perpendicular juke so it's slippery.
      this.desired.set(this.toPlayer.x, 0, this.toPlayer.z)
      if (dist > 0.001) this.desired.multiplyScalar(-1 / dist)
      // perpendicular (rotate the away-vector 90deg), oscillating sign for the juke
      this.perp.set(-this.desired.z, 0, this.desired.x)
      const juke = Math.sin(this.pulse * 2.6) * 0.7
      this.desired.x += this.perp.x * juke
      this.desired.z += this.perp.z * juke
      const len = Math.hypot(this.desired.x, this.desired.z)
      if (len > 0.001) this.desired.multiplyScalar(FLEE_SPEED / len)
    } else {
      // Wander toward the current waypoint, repick on arrival.
      this.toWp.copy(this.wp).sub(this.pos).setY(0)
      const wd = this.toWp.length()
      if (wd < 4) { this.pickWaypoint(); this.toWp.copy(this.wp).sub(this.pos).setY(0) }
      const len = Math.hypot(this.toWp.x, this.toWp.z)
      if (len > 0.001) this.toWp.multiplyScalar(WANDER_SPEED / len)
      this.desired.set(this.toWp.x, 0, this.toWp.z)
    }

    // Ease velocity toward desired (frame-rate-independent), integrate.
    // Exponential damping so evasion feels identical at 30 vs 60fps (a raw
    // dt-lerp factor would converge faster the more frames you render).
    const lambda = dist < FLEE_RANGE ? 8 : 4
    const k = 1 - Math.exp(-lambda * dt)
    this.vel.x += (this.desired.x - this.vel.x) * k
    this.vel.z += (this.desired.z - this.vel.z) * k
    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt

    // Reflect at the play-area boundary.
    if (Math.abs(this.pos.x) > AREA) { this.pos.x = Math.sign(this.pos.x) * AREA; this.vel.x *= -0.6; this.pickWaypoint() }
    if (Math.abs(this.pos.z) > AREA) { this.pos.z = Math.sign(this.pos.z) * AREA; this.vel.z *= -0.6; this.pickWaypoint() }

    // Hover + bob at head height above the local ground.
    const target = this.deps.groundY(this.pos.x, this.pos.z) + HOVER + Math.sin(this.bob * 2) * 0.25
    this.pos.y += (target - this.pos.y) * Math.min(1, dt * 4)

    this.group.position.copy(this.pos)
    const heading = (this.vel.x * this.vel.x + this.vel.z * this.vel.z) > 0.001
      ? Math.atan2(this.vel.x, this.vel.z)
      : this.group.rotation.y
    this.group.rotation.y = heading
    this.group.rotation.z = this.spin // spinning body/rings

    // Flashy aura/core pulse - brighter & faster while fleeing.
    const fleeing = dist < FLEE_RANGE
    const p = 0.5 + 0.5 * Math.sin(this.pulse * (fleeing ? 7 : 3.5))
    this.auraMat.opacity = (fleeing ? 0.36 : 0.24) + p * 0.22
    this.trailMat.opacity = (fleeing ? 0.55 : 0.3) + p * 0.2
    const c = 0.7 + p * 0.3
    this.coreMat.color.setRGB(1, c, 0.5 + p * 0.4)
    const s = 1 + p * (fleeing ? 0.14 : 0.07)
    this.group.scale.setScalar(s)
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
