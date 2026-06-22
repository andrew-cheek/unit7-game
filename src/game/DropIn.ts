import * as THREE from 'three'
import { clamp } from './utils'
import { createRobot, type RobotModel } from './procedural'
import type { Input } from './Input'

/** Live readout for the drop HUD (altimeter + ring counter + speed). */
export interface DropHud {
  alt: number
  rings: number
  total: number
  speed: number
}

// Drop staging. You start high over the south approach and steer a slalom of
// glowing rings down to the spawn plaza. Kept short so it's a punchy 12-15s, not
// a cutscene you wait out.
const START = new THREE.Vector3(0, 240, 92)
const LAND = new THREE.Vector3(0, 0, 0) // hands off at the city spawn
const N_RINGS = 9
const RING_R = 7.5 // xz radius that counts as a clean pass
const N_AI = 5 // background divers for "the sky is full of people" presence
const FLARE_Y = 40 // begin the landing flare below this altitude

const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Interactive orbital drop-in: the opening you *play*, not watch. You spawn in
 * freefall high over the city in a bright dawn sky, steer through a descending
 * slalom of neon rings (each pass scores + nudges you on), with other divers
 * streaking down around you, then flare and land at the spawn plaza - which is
 * exactly where normal play begins. Self-contained like the old cinematic: owns
 * a group + the camera while `done` is false, exposes `fade` for the handoff,
 * and tears everything down on exit. Works identically solo (AI divers) and, once
 * wired, with real players dropping in the same sky.
 */
export class DropIn {
  readonly group = new THREE.Group()
  done = false
  fade = 0 // no opening black: you're in the bright sky immediately
  hud: DropHud = { alt: START.y, rings: 0, total: N_RINGS, speed: 0 }

  /** Fired on a clean ring pass and on touchdown, for SFX. */
  onSfx: ((kind: 'ring' | 'land') => void) | null = null

  private scene: THREE.Scene
  private cam: THREE.PerspectiveCamera
  private input: Input
  private getGround: (x: number, z: number) => number

  private rb: RobotModel
  private diver = new THREE.Group()
  private pos = START.clone()
  private vel = new THREE.Vector3(0, -10, 0)
  private hVel = new THREE.Vector3() // horizontal velocity (xz)
  private camHeading = 0

  private rings: { group: THREE.Group; mat: THREE.MeshBasicMaterial; pos: THREE.Vector3; passed: boolean }[] = []
  private ai: { g: THREE.Group; canopy: THREE.Mesh; cx: number; cz: number; r: number; ang: number; spd: number; y: number; vy: number }[] = []
  private chute!: THREE.Mesh

  private streaks!: THREE.Points
  private streakVel!: Float32Array
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  private t = 0
  private landT = 0
  private camPos = new THREE.Vector3()
  private camLook = new THREE.Vector3()

  // tuning
  private static readonly STEER = 26 // horizontal accel (m/s^2)
  private static readonly H_DAMP = 1.6 // horizontal drag
  private static readonly H_MAX = 34 // horizontal speed cap
  private static readonly TERM = 30 // boosted terminal fall speed
  private static readonly TERM_SLOW = 15 // flared/normal fall speed

  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera, input: Input, getGround: (x: number, z: number) => number) {
    this.scene = scene
    this.cam = cam
    this.input = input
    this.getGround = getGround
    this.rb = createRobot()
    this.build()
    scene.add(this.group)
    // Frame the first shot immediately so there's no settle-in jump.
    this.placeCamera(true)
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  private build() {
    // Hero diver (the polished robot rig), belly-to-earth.
    this.rb.setFlyPose(1)
    this.diver.add(this.rb.group)
    this.diver.position.copy(this.pos)
    this.group.add(this.diver)

    // Stowed canopy, deployed at the flare.
    const chuteMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x27e7ff, emissiveIntensity: 1.4, roughness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }))
    this.chute = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(3.4, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.2)), chuteMat)
    this.chute.position.y = 4.5
    this.chute.visible = false
    this.diver.add(this.chute)

    // Ring slalom from the start down to the plaza.
    for (let i = 0; i < N_RINGS; i++) {
      const f = i / (N_RINGS - 1)
      const y = THREE.MathUtils.lerp(START.y - 28, FLARE_Y + 4, f)
      const x = Math.sin(f * Math.PI * 2.5) * 32 * (1 - f * 0.5)
      const z = THREE.MathUtils.lerp(START.z - 16, LAND.z, f)
      const mat = this.own(new THREE.MeshBasicMaterial({ color: i === 0 ? 0x9dff5a : 0x27e7ff, transparent: true, opacity: 0.9, fog: false }))
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(RING_R, 0.5, 12, 32)), mat)
      const g = new THREE.Group()
      g.add(ring)
      g.position.set(x, y, z)
      g.rotation.x = Math.PI / 2 // lie flat so you fall through it
      this.group.add(g)
      this.rings.push({ group: g, mat, pos: new THREE.Vector3(x, y, z), passed: false })
    }

    // Background AI divers - simple lit figures under canopies, drifting down on
    // noisy circles around the player so the sky reads as populated.
    const aiBody = this.own(new THREE.MeshStandardMaterial({ color: 0x223040, metalness: 0.5, roughness: 0.5 }))
    for (let i = 0; i < N_AI; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(this.ownG(new THREE.CapsuleGeometry(0.5, 1.1, 4, 8)), aiBody)
      g.add(body)
      const col = [0xff2bd0, 0x8a5cff, 0xff8a1e, 0x27e7ff, 0x9dff5a][i % 5]
      const canopy = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.2)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: false })))
      canopy.position.y = 3.4
      g.add(canopy)
      const cx = (Math.random() - 0.5) * 70
      const cz = START.z * 0.5 + (Math.random() - 0.5) * 70
      const y = START.y - Math.random() * 120
      g.position.set(cx, y, cz)
      this.group.add(g)
      this.ai.push({ g, canopy, cx, cz, r: 6 + Math.random() * 14, ang: Math.random() * 6.28, spd: 0.2 + Math.random() * 0.3, y, vy: 12 + Math.random() * 8 })
    }

    // Freefall speed-streaks around the diver.
    const NF = 130
    const fp = new Float32Array(NF * 3)
    this.streakVel = new Float32Array(NF)
    for (let i = 0; i < NF; i++) {
      fp[i * 3] = (Math.random() - 0.5) * 16
      fp[i * 3 + 1] = (Math.random() - 0.5) * 24
      fp[i * 3 + 2] = (Math.random() - 0.5) * 16
      this.streakVel[i] = 18 + Math.random() * 20
    }
    const fg = this.ownG(new THREE.BufferGeometry())
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3))
    this.streaks = new THREE.Points(fg, this.own(new THREE.PointsMaterial({ color: 0xdff1ff, size: 0.09, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })))
    this.streaks.frustumCulled = false
    this.group.add(this.streaks)
  }

  skip() {
    if (this.done) return
    // Snap to touchdown over the plaza; the brief fade handoff runs from there so
    // a player who hits SKIP is in the game in under half a second.
    this.pos.set(LAND.x, LAND.y + 1, LAND.z)
    this.vel.set(0, -2, 0)
    this.hVel.set(0, 0, 0)
    for (const r of this.rings) r.passed = true
  }

  update(dt: number) {
    if (this.done) return
    this.t += dt
    const flaring = this.pos.y <= FLARE_Y

    // --- steering: camera-relative horizontal accel (matches gameplay convention) ---
    const yaw = this.input.yaw
    const mx = this.input.moveX
    const my = this.input.moveY
    const ax = (-Math.cos(yaw) * mx + Math.sin(yaw) * my) * DropIn.STEER
    const az = (Math.sin(yaw) * mx + Math.cos(yaw) * my) * DropIn.STEER
    this.hVel.x += ax * dt
    this.hVel.z += az * dt
    // drag + cap
    const damp = Math.exp(-DropIn.H_DAMP * dt)
    this.hVel.x *= damp
    this.hVel.z *= damp
    const hs = Math.hypot(this.hVel.x, this.hVel.z)
    if (hs > DropIn.H_MAX) { this.hVel.x *= DropIn.H_MAX / hs; this.hVel.z *= DropIn.H_MAX / hs }

    // --- vertical: dive faster on boost/jet, slower otherwise; flare near ground ---
    const boosting = this.input.held.boost || this.input.held.jet
    let term = boosting ? DropIn.TERM : DropIn.TERM_SLOW
    if (flaring) term = THREE.MathUtils.lerp(6, 2, smooth(FLARE_Y, 4, this.pos.y))
    this.vel.y += (-(term) - this.vel.y) * Math.min(1, dt * (flaring ? 3 : 1.6))

    // integrate
    this.pos.x += this.hVel.x * dt
    this.pos.z += this.hVel.z * dt
    this.pos.y += this.vel.y * dt

    if (flaring) {
      // Ease toward the exact spawn xz so touchdown is clean, deploy the canopy.
      this.pos.x = THREE.MathUtils.damp(this.pos.x, LAND.x, 2.2, dt)
      this.pos.z = THREE.MathUtils.damp(this.pos.z, LAND.z, 2.2, dt)
      this.hVel.multiplyScalar(Math.exp(-3 * dt))
      if (!this.chute.visible) this.chute.visible = true
      this.rb.setFlyPose(0.2)
    }

    this.diver.position.copy(this.pos)
    // Face the diver along its horizontal travel, banked into the turn.
    if (hs > 0.5) this.camHeading = Math.atan2(this.hVel.x, this.hVel.z)
    this.diver.rotation.set(flaring ? 0 : 0.5, this.camHeading, clamp(-this.hVel.x * 0.02, -0.5, 0.5))
    this.rb.setThrust(boosting && !flaring ? 1 : 0)
    this.rb.update(dt, flaring ? 0.2 : 0.4, false)

    this.updateRings(dt)
    this.updateAi(dt)
    this.updateStreaks(dt, boosting && !flaring)
    this.placeCamera(false)

    // HUD readout (ground is the plaza at y~0, so altitude ~= pos.y).
    this.hud.alt = Math.max(0, this.pos.y - this.getGround(this.pos.x, this.pos.z))
    this.hud.speed = Math.hypot(hs, this.vel.y)

    // Touchdown -> brief fade and hand off.
    if (this.pos.y <= LAND.y + 1.2) {
      this.landT += dt
      if (this.landT === dt) this.onSfx?.('land')
      this.fade = smooth(0, 0.45, this.landT)
      if (this.landT >= 0.45) this.done = true
    }
  }

  private updateRings(dt: number) {
    for (const r of this.rings) {
      r.group.rotation.z += dt * 0.8
      if (r.passed) continue
      // Passed when we descend through the ring's plane near its center.
      if (this.pos.y <= r.pos.y + 0.6 && this.pos.y >= r.pos.y - 4) {
        const d = Math.hypot(this.pos.x - r.pos.x, this.pos.z - r.pos.z)
        if (d < RING_R) {
          r.passed = true
          r.mat.color.setHex(0x294055)
          r.mat.opacity = 0.3
          this.hud.rings++
          this.onSfx?.('ring')
          // a little forward + down nudge as reward
          this.vel.y -= 6
        }
      } else if (this.pos.y < r.pos.y - 4) {
        r.passed = true // missed; stop testing
      }
      // Brighten the next un-passed ring so the route reads.
      if (!r.passed) {
        const next = this.rings.find((x) => !x.passed) === r
        r.mat.color.setHex(next ? 0x9dff5a : 0x27e7ff)
        r.mat.opacity = next ? 1 : 0.7
        r.group.scale.setScalar(next ? 1.08 : 1)
      }
    }
  }

  private updateAi(dt: number) {
    for (const a of this.ai) {
      a.ang += a.spd * dt
      a.y -= a.vy * dt
      if (a.y < 6) { a.y = START.y + Math.random() * 30; a.vy = 12 + Math.random() * 8 } // recycle to the top
      a.g.position.set(a.cx + Math.cos(a.ang) * a.r, a.y, a.cz + Math.sin(a.ang) * a.r)
      a.g.rotation.y = -a.ang
    }
  }

  private updateStreaks(dt: number, fast: boolean) {
    const m = this.streaks.material as THREE.PointsMaterial
    m.opacity = THREE.MathUtils.damp(m.opacity, fast ? 0.85 : 0.4, 5, dt)
    this.streaks.position.copy(this.pos)
    const fp = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    const rise = (fast ? 40 : 22)
    for (let i = 0; i < this.streakVel.length; i++) {
      const j = i * 3 + 1
      fp[j] += (this.streakVel[i] + rise) * dt
      if (fp[j] > 14) fp[j] = -14
    }
    ;(this.streaks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  private placeCamera(snap: boolean) {
    // Trail above-behind the dive, looking down the route at the city.
    const fwd = new THREE.Vector3(Math.sin(this.camHeading), 0, Math.cos(this.camHeading))
    const want = this.camPos.copy(this.pos).addScaledVector(fwd, -11).add(new THREE.Vector3(0, 6.5, 0))
    const lookWant = this.camLook.copy(this.pos).addScaledVector(fwd, 8).add(new THREE.Vector3(0, -7, 0))
    if (snap) {
      this.cam.position.copy(want)
    } else {
      this.cam.position.lerp(want, 0.08)
    }
    this.cam.lookAt(lookWant)
  }

  dispose() {
    this.scene.remove(this.group)
    this.rb.dispose()
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
  }
}
