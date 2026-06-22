import * as THREE from 'three'
import { clamp } from './utils'
import { createRobot, type RobotModel } from './procedural'
import type { Input } from './Input'

/** Live readout for the drop HUD: altimeter, ring count, the deploy gauge. */
export interface DropHud {
  alt: number
  rings: number
  total: number
  speed: number
  phase: 'fall' | 'window' | 'canopy' | 'land'
  gauge: number | null // 0..1 sweeping marker while the deploy window is open
  sweetLo: number
  sweetHi: number
  result: string | null // 'PERFECT CHUTE' / 'GOOD' / 'HARD OPEN' after deploy
}

// Drop staging. Start high, fall fast, then time a tap to pop the canopy in the
// sweet spot and glide into the factory's rooftop pad. Tuned short and punchy.
const START = new THREE.Vector3(0, 205, 120)
const N_RINGS = 6
const RING_R = 8
const N_AI = 4
const DEPLOY_TOP = 100 // gauge opens at this altitude
const DEPLOY_FLOOR = 44 // forced (poor) deploy if you wait past this
const SWEET_LO = 0.42
const SWEET_HI = 0.6

/**
 * Interactive orbital drop-in: the opening you play. Freefall fast through a
 * bright dawn sky steering a short slalom of rings, time a tap to deploy the
 * canopy as a sweeping gauge crosses its sweet spot (clean pop = slow, steerable
 * descent + bonus; mistimed = a hard, fast opening), then glide down into the
 * robot factory's rooftop intake pad - which is exactly where you take control,
 * standing on the factory floor among the robots building robots.
 *
 * Self-contained: owns a group + the camera while `done` is false, exposes
 * `fade` for the handoff, and disposes everything on exit. Identical solo (AI
 * divers fill the sky) and, once wired, with real players dropping alongside.
 */
export class DropIn {
  readonly group = new THREE.Group()
  done = false
  fade = 0 // no opening black: you're in the bright sky immediately
  /** Set on canopy deploy: 0..1 how clean the timing was (drives the reward). */
  chuteQuality = 0
  hud: DropHud = { alt: START.y, rings: 0, total: N_RINGS, speed: 0, phase: 'fall', gauge: null, sweetLo: SWEET_LO, sweetHi: SWEET_HI, result: null }

  /** Fired on a clean ring pass, the canopy pop, and touchdown, for SFX. */
  onSfx: ((kind: 'ring' | 'deploy' | 'land') => void) | null = null

  private scene: THREE.Scene
  private cam: THREE.PerspectiveCamera
  private input: Input
  private getGround: (x: number, z: number) => number
  private target: THREE.Vector3

  private rb: RobotModel
  private diver = new THREE.Group()
  private pos = START.clone()
  private vy = -14
  private hVel = new THREE.Vector3()
  private camHeading = 0

  private phase: DropHud['phase'] = 'fall'
  private gaugeT = 0
  private quality = 0
  private pendingDeploy = false
  private prevJet = false
  private resultT = 0

  private rings: { group: THREE.Group; mat: THREE.MeshBasicMaterial; pos: THREE.Vector3; passed: boolean }[] = []
  private ai: { g: THREE.Group; cx: number; cz: number; r: number; ang: number; spd: number; y: number; vy: number }[] = []
  private chute!: THREE.Mesh
  private streaks!: THREE.Points
  private streakVel!: Float32Array
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  private camPos = new THREE.Vector3()
  private camLook = new THREE.Vector3()

  // tuning
  private static readonly STEER = 32
  private static readonly H_DAMP = 1.7
  private static readonly H_MAX = 40
  private static readonly TERM = 60 // freefall terminal speed (fast)

  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera, input: Input, target: THREE.Vector3, getGround: (x: number, z: number) => number) {
    this.scene = scene
    this.cam = cam
    this.input = input
    this.target = target.clone()
    this.getGround = getGround
    this.rb = createRobot()
    // Face down the route toward the target from the first frame so the opening
    // frames the city and the factory, not empty sky behind you.
    this.camHeading = Math.atan2(this.target.x - START.x, this.target.z - START.z)
    this.build()
    scene.add(this.group)
    this.placeCamera(true)
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  private build() {
    this.rb.setFlyPose(1)
    this.diver.add(this.rb.group)
    this.diver.position.copy(this.pos)
    this.group.add(this.diver)

    const chuteMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x27e7ff, emissiveIntensity: 1.4, roughness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.82 }))
    this.chute = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.9, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.2)), chuteMat)
    this.chute.position.y = 6.5
    this.chute.scale.setScalar(0.1)
    this.chute.visible = false
    this.diver.add(this.chute)

    // Ring slalom leading from the start down toward the target, ending above
    // the deploy window so the rings guide you onto the approach line.
    for (let i = 0; i < N_RINGS; i++) {
      const f = i / (N_RINGS - 1)
      const y = THREE.MathUtils.lerp(START.y - 24, DEPLOY_TOP + 14, f)
      const x = THREE.MathUtils.lerp(START.x, this.target.x, f) + Math.sin(f * Math.PI * 2.2) * 26 * (1 - f * 0.6)
      const z = THREE.MathUtils.lerp(START.z - 14, this.target.z, f)
      const mat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.85, fog: false }))
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(RING_R, 0.5, 12, 30)), mat)
      const g = new THREE.Group()
      g.add(ring)
      g.position.set(x, y, z)
      g.rotation.x = Math.PI / 2
      this.group.add(g)
      this.rings.push({ group: g, mat, pos: new THREE.Vector3(x, y, z), passed: false })
    }

    const aiBody = this.own(new THREE.MeshStandardMaterial({ color: 0x223040, metalness: 0.5, roughness: 0.5 }))
    for (let i = 0; i < N_AI; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(this.ownG(new THREE.CapsuleGeometry(0.5, 1.1, 4, 8)), aiBody)
      g.add(body)
      const col = [0xff2bd0, 0x8a5cff, 0xff8a1e, 0x9dff5a][i % 4]
      const canopy = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.1)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: false })))
      canopy.position.y = 3.4
      g.add(canopy)
      const cx = (Math.random() - 0.5) * 80
      const cz = START.z * 0.4 + (Math.random() - 0.5) * 80
      const y = START.y - Math.random() * 120
      g.position.set(cx, y, cz)
      this.group.add(g)
      this.ai.push({ g, cx, cz, r: 6 + Math.random() * 14, ang: Math.random() * 6.28, spd: 0.2 + Math.random() * 0.3, y, vy: 10 + Math.random() * 8 })
    }

    const NF = 130
    const fp = new Float32Array(NF * 3)
    this.streakVel = new Float32Array(NF)
    for (let i = 0; i < NF; i++) {
      fp[i * 3] = (Math.random() - 0.5) * 16
      fp[i * 3 + 1] = (Math.random() - 0.5) * 24
      fp[i * 3 + 2] = (Math.random() - 0.5) * 16
      this.streakVel[i] = 20 + Math.random() * 22
    }
    const fg = this.ownG(new THREE.BufferGeometry())
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3))
    this.streaks = new THREE.Points(fg, this.own(new THREE.PointsMaterial({ color: 0xdff1ff, size: 0.1, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })))
    this.streaks.frustumCulled = false
    this.group.add(this.streaks)
  }

  /** Called by the DEPLOY button / a screen tap. Desktop also taps via Space.
   *  Only registers once the deploy window is open, so an eager early tap can't
   *  force a hard opening the instant the gauge appears. */
  deploy() { if (this.phase === 'window') this.pendingDeploy = true }

  skip() {
    if (this.done) return
    // Snap onto the rooftop pad so the handoff position is always correct and
    // touchdown fires on the next frame.
    this.pos.copy(this.target).setY(this.target.y + 0.4)
    this.vy = -2
    this.hVel.set(0, 0, 0)
    this.phase = 'land'
    for (const r of this.rings) r.passed = true
  }

  update(dt: number) {
    if (this.done) return

    // deploy intent from a Space tap (rising edge), only during the window
    const jet = this.input.held.jet
    if (jet && !this.prevJet && this.phase === 'window') this.pendingDeploy = true
    this.prevJet = jet

    // --- steering (camera-relative; matches gameplay convention) ---
    const yaw = this.input.yaw
    const control = this.phase === 'canopy' ? 0.5 + this.quality * 0.5 : 1
    const ax = (-Math.cos(yaw) * this.input.moveX + Math.sin(yaw) * this.input.moveY) * DropIn.STEER * control
    const az = (Math.sin(yaw) * this.input.moveX + Math.cos(yaw) * this.input.moveY) * DropIn.STEER * control
    this.hVel.x += ax * dt
    this.hVel.z += az * dt

    // gentle glide assist toward the pad once the canopy is open
    if (this.phase === 'canopy') {
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z
      const d = Math.hypot(dx, dz) || 1
      const assist = 10
      this.hVel.x += (dx / d) * assist * dt
      this.hVel.z += (dz / d) * assist * dt
    }
    const damp = Math.exp(-DropIn.H_DAMP * dt)
    this.hVel.x *= damp
    this.hVel.z *= damp
    const hs = Math.hypot(this.hVel.x, this.hVel.z)
    const hMax = this.phase === 'canopy' ? 22 : DropIn.H_MAX
    if (hs > hMax) { this.hVel.x *= hMax / hs; this.hVel.z *= hMax / hs }

    // --- phase machine ---
    if (this.phase === 'fall') {
      this.vy += (-DropIn.TERM - this.vy) * Math.min(1, dt * 1.8)
      if (this.pos.y <= DEPLOY_TOP) { this.phase = 'window'; this.hud.phase = 'window'; this.pendingDeploy = false }
    } else if (this.phase === 'window') {
      this.gaugeT += dt
      this.vy += (-DropIn.TERM - this.vy) * Math.min(1, dt * 1.8)
      const marker = this.pingpong(this.gaugeT * 0.9)
      this.hud.gauge = marker
      if (this.pendingDeploy || this.pos.y <= DEPLOY_FLOOR) {
        const forced = !this.pendingDeploy
        const center = (SWEET_LO + SWEET_HI) / 2
        const half = (SWEET_HI - SWEET_LO) / 2
        const dist = Math.abs(marker - center)
        this.quality = forced ? 0.3 : dist < half ? 1 - (dist / half) * 0.35 : Math.max(0, 0.55 - (dist - half) * 2.2)
        this.chuteQuality = this.quality
        this.hud.result = this.quality >= 0.85 ? 'PERFECT CHUTE' : this.quality >= 0.55 ? 'GOOD CHUTE' : 'HARD OPEN'
        this.hud.gauge = null
        this.phase = 'canopy'; this.hud.phase = 'canopy'
        this.chute.visible = true
        this.rb.setFlyPose(0.2)
        this.onSfx?.('deploy')
        // a clean pop pays bonus "rings"
        if (this.quality >= 0.85) this.hud.rings = Math.min(this.hud.total, this.hud.rings + 1)
      }
    } else if (this.phase === 'canopy') {
      // descent speed from how clean the pop was (good = slow + controllable)
      const want = -THREE.MathUtils.lerp(15, 9, this.quality)
      this.vy += (want - this.vy) * Math.min(1, dt * 2.5)
      this.chute.scale.setScalar(THREE.MathUtils.damp(this.chute.scale.x, 1, 6, dt))
      if (this.pos.y <= this.target.y + 1.5) { this.phase = 'land'; this.hud.phase = 'land' }
    } else {
      // land: ease exactly onto the pad
      this.pos.x = THREE.MathUtils.damp(this.pos.x, this.target.x, 4, dt)
      this.pos.z = THREE.MathUtils.damp(this.pos.z, this.target.z, 4, dt)
      this.vy += (-2 - this.vy) * Math.min(1, dt * 4)
    }

    // integrate
    this.pos.x += this.hVel.x * dt
    this.pos.z += this.hVel.z * dt
    this.pos.y += this.vy * dt

    this.diver.position.copy(this.pos)
    if (hs > 0.5) this.camHeading = Math.atan2(this.hVel.x, this.hVel.z)
    const belly = this.phase === 'fall' || this.phase === 'window'
    this.diver.rotation.set(belly ? 0.5 : 0, this.camHeading, clamp(-this.hVel.x * 0.02, -0.5, 0.5))
    this.rb.setThrust(0)
    this.rb.update(dt, belly ? 0.4 : 0.15, false)

    this.updateRings(dt)
    this.updateAi(dt)
    this.updateStreaks(dt, this.phase === 'fall' || this.phase === 'window')
    this.placeCamera(false)

    this.hud.alt = Math.max(0, this.pos.y - this.getGround(this.pos.x, this.pos.z))
    this.hud.speed = Math.hypot(hs, this.vy)
    if (this.hud.result) { this.resultT += dt; if (this.resultT > 2.2) this.hud.result = null }

    // touchdown -> brief fade + handoff
    if (this.phase === 'land' && this.pos.y <= this.target.y + 0.6) {
      if (this.fade === 0) this.onSfx?.('land')
      this.fade = clamp(this.fade + dt * 2.2, 0, 1) // smooth ~0.45s fade to the handoff
      if (this.fade >= 1) this.done = true
    }
  }

  private pingpong(t: number): number {
    const m = t % 2
    return m < 1 ? m : 2 - m
  }

  private updateRings(dt: number) {
    for (const r of this.rings) {
      r.group.rotation.z += dt * 0.8
      if (r.passed) {
        if (this.pos.y < r.pos.y - 4) continue
      } else if (this.pos.y <= r.pos.y + 0.6 && this.pos.y >= r.pos.y - 4) {
        const d = Math.hypot(this.pos.x - r.pos.x, this.pos.z - r.pos.z)
        if (d < RING_R) { r.passed = true; r.mat.color.setHex(0x294055); r.mat.opacity = 0.3; this.hud.rings++; this.onSfx?.('ring'); this.vy -= 5 }
      } else if (this.pos.y < r.pos.y - 4) {
        r.passed = true
      }
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
      if (a.y < 6) { a.y = START.y + Math.random() * 30; a.vy = 10 + Math.random() * 8 }
      a.g.position.set(a.cx + Math.cos(a.ang) * a.r, a.y, a.cz + Math.sin(a.ang) * a.r)
      a.g.rotation.y = -a.ang
    }
  }

  private updateStreaks(dt: number, fast: boolean) {
    const m = this.streaks.material as THREE.PointsMaterial
    m.opacity = THREE.MathUtils.damp(m.opacity, fast ? 0.85 : 0.3, 5, dt)
    this.streaks.position.copy(this.pos)
    const fp = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    const rise = fast ? 48 : 20
    for (let i = 0; i < this.streakVel.length; i++) {
      const j = i * 3 + 1
      fp[j] += (this.streakVel[i] + rise) * dt
      if (fp[j] > 14) fp[j] = -14
    }
    ;(this.streaks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  private placeCamera(snap: boolean) {
    const fwd = new THREE.Vector3(Math.sin(this.camHeading), 0, Math.cos(this.camHeading))
    // Closer chase so the diver reads big (Roblox-ish framing), still angled down
    // the route at the city/factory.
    const want = this.camPos.copy(this.pos).addScaledVector(fwd, -7.5).add(new THREE.Vector3(0, 4.2, 0))
    const lookWant = this.camLook.copy(this.pos).addScaledVector(fwd, 7).add(new THREE.Vector3(0, -5, 0))
    if (snap) this.cam.position.copy(want)
    else this.cam.position.lerp(want, 0.09)
    this.cam.lookAt(lookWant)
  }

  dispose() {
    this.scene.remove(this.group)
    this.rb.dispose()
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
  }
}
