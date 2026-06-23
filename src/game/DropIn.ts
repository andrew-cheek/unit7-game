import * as THREE from 'three'
import { clamp } from './utils'
import { createRobot, type RobotModel } from './procedural'
import type { Input } from './Input'

/** Live readout for the drop HUD: altimeter, speed, phase + contextual hint. */
export interface DropHud {
  alt: number
  speed: number
  phase: 'dive' | 'canopy' | 'land'
  hint: string | null
  canDeploy: boolean // the chute can be popped now (drives the DEPLOY button)
  result: string | null // 'CLEAN CANOPY' / 'CANOPY OPEN' / 'HARD OPEN' after deploy
}

// Drop staging. You start very high and nose-dive a long way, steering your fall
// (tuck to plunge, flare to slow + hang) to line up the arcade, then pop the
// canopy and glide it down into the plaza. No rings, no timing minigame - it is
// the falling itself that you control.
const START_Y = 760 // begin far above the city
const TERM_DIVE = -84 // tucked nose-dive terminal speed (fast)
const TERM_FLARE = -30 // flared/air-braked descent (slow, lots of hang time)
const TERM_NEUTRAL = -56 // hands-off fall
const DEPLOY_MAX_ALT = 240 // above this the chute would just drift forever - locked out
const DEPLOY_FLOOR = 52 // auto (hard) deploy if you plummet past this

/**
 * The playable opening: an interactive high-altitude dive. You spawn hundreds of
 * metres up and fall the whole way down, steering the freefall - tuck (hold
 * Space / drag forward) to plunge fast, flare (pull back) to flatten and hang -
 * to track toward the arcade. When you're low enough, pop the canopy and steer
 * the glide into the plaza, which is exactly where you take control on foot. It
 * reads as gameplay that happens to start very high, not a cutscene.
 *
 * Self-contained: owns a group + the camera while `done` is false, exposes
 * `fade` for the handoff, and disposes everything on exit.
 */
export class DropIn {
  readonly group = new THREE.Group()
  done = false
  fade = 0 // no opening black: you're in the bright sky immediately
  /** Set on canopy deploy: 0..1 how much altitude you had (drives the reward). */
  chuteQuality = 0
  hud: DropHud = { alt: START_Y, speed: 0, phase: 'dive', hint: null, canDeploy: false, result: null }

  /** Fired on the canopy pop and touchdown, for SFX. */
  onSfx: ((kind: 'ring' | 'deploy' | 'land') => void) | null = null

  private scene: THREE.Scene
  private cam: THREE.PerspectiveCamera
  private input: Input
  private getGround: (x: number, z: number) => number
  private target: THREE.Vector3
  private start: THREE.Vector3

  private rb: RobotModel
  private diver = new THREE.Group()
  private pos: THREE.Vector3
  private vy = -22
  private hVel = new THREE.Vector3()
  private camHeading = 0
  private pitch = 0.5 // 0 flat (flare) .. 1 steep (tuck), smoothed for the body pose

  private phase: DropHud['phase'] = 'dive'
  private quality = 0
  private pendingDeploy = false
  private prevChute = false
  private resultT = 0

  private ai: { g: THREE.Group; cx: number; cz: number; r: number; ang: number; spd: number; y: number; vy: number }[] = []
  private chute!: THREE.Mesh
  private streaks!: THREE.Points
  private streakVel!: Float32Array
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  private camPos = new THREE.Vector3()
  private camLook = new THREE.Vector3()
  private fwd = new THREE.Vector3()

  // tuning
  private static readonly STEER = 42 // horizontal steering authority (strong - it's a long fall to aim)
  private static readonly H_DAMP = 1.5
  private static readonly H_MAX = 48

  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera, input: Input, target: THREE.Vector3, getGround: (x: number, z: number) => number) {
    this.scene = scene
    this.cam = cam
    this.input = input
    this.target = target.clone()
    this.getGround = getGround
    // Spawn high and back from the target so the whole descent tracks toward the
    // arcade with the city laid out ahead and below.
    this.start = new THREE.Vector3(target.x + 24, START_Y, target.z - 270)
    this.pos = this.start.clone()
    this.rb = createRobot()
    this.camHeading = Math.atan2(this.target.x - this.start.x, this.target.z - this.start.z)
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

    // A few AI divers scattered down the long fall for a sense of a mass drop.
    const aiBody = this.own(new THREE.MeshStandardMaterial({ color: 0x223040, metalness: 0.5, roughness: 0.5 }))
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(this.ownG(new THREE.CapsuleGeometry(0.5, 1.1, 4, 8)), aiBody)
      g.add(body)
      const col = [0xff2bd0, 0x8a5cff, 0xff8a1e, 0x9dff5a][i % 4]
      const canopy = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.1)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: false })))
      canopy.position.y = 3.4
      g.add(canopy)
      const cx = this.start.x + (Math.random() - 0.5) * 90
      const cz = this.start.z * 0.5 + (Math.random() - 0.5) * 120
      const y = START_Y - Math.random() * 360
      g.position.set(cx, y, cz)
      this.group.add(g)
      this.ai.push({ g, cx, cz, r: 6 + Math.random() * 14, ang: Math.random() * 6.28, spd: 0.2 + Math.random() * 0.3, y, vy: 24 + Math.random() * 18 })
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

  /** Called by the DEPLOY button / a screen tap. Only arms once low enough. */
  deploy() {
    if (this.phase === 'dive' && this.pos.y - this.getGround(this.pos.x, this.pos.z) <= DEPLOY_MAX_ALT) this.pendingDeploy = true
  }

  skip() {
    if (this.done) return
    this.pos.copy(this.target).setY(this.target.y + 0.4)
    this.vy = -2
    this.hVel.set(0, 0, 0)
    this.phase = 'land'
  }

  update(dt: number) {
    if (this.done) return
    const alt = this.pos.y - this.getGround(this.pos.x, this.pos.z)

    // Deploy intent: the chute key (rising edge) or the DEPLOY button.
    const chute = this.input.consumeEdge('chute')
    if (chute && this.phase === 'dive' && alt <= DEPLOY_MAX_ALT) this.pendingDeploy = true

    // --- horizontal steering (camera-relative, matches gameplay convention) ---
    const yaw = this.input.yaw
    const control = this.phase === 'canopy' ? 0.55 + this.quality * 0.45 : 1
    const ax = (-Math.cos(yaw) * this.input.moveX + Math.sin(yaw) * this.input.moveY) * DropIn.STEER * control
    const az = (Math.sin(yaw) * this.input.moveX + Math.cos(yaw) * this.input.moveY) * DropIn.STEER * control
    this.hVel.x += ax * dt
    this.hVel.z += az * dt

    if (this.phase === 'canopy') {
      // Glide assist nudges you toward the plaza so the landing always lands.
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z
      const d = Math.hypot(dx, dz) || 1
      const assist = 11
      this.hVel.x += (dx / d) * assist * dt
      this.hVel.z += (dz / d) * assist * dt
    }
    const damp = Math.exp(-DropIn.H_DAMP * dt)
    this.hVel.x *= damp
    this.hVel.z *= damp
    const hs = Math.hypot(this.hVel.x, this.hVel.z)
    const hMax = this.phase === 'canopy' ? 24 : DropIn.H_MAX
    if (hs > hMax) { this.hVel.x *= hMax / hs; this.hVel.z *= hMax / hs }

    // --- phase machine ---
    if (this.phase === 'dive') {
      // Control the fall: tuck to plunge, flare to flatten + hang. Hold Space or
      // drag forward to tuck; pull back to flare.
      let diveAmt = 0.5
      if (this.input.held.jet || this.input.moveY > 0.35) diveAmt = 1
      else if (this.input.moveY < -0.35) diveAmt = 0.08
      this.pitch += (diveAmt - this.pitch) * Math.min(1, dt * 3)
      const term = diveAmt >= 0.99 ? TERM_DIVE : diveAmt <= 0.1 ? TERM_FLARE : TERM_NEUTRAL
      this.vy += (term - this.vy) * Math.min(1, dt * 1.5)

      if (this.pendingDeploy || alt <= DEPLOY_FLOOR) {
        const forced = !this.pendingDeploy
        // Quality from how much altitude you had: an early, high pop is a clean,
        // slow, steerable canopy; a last-second pop is a hard, fast opening.
        this.quality = forced ? 0.25 : clamp((alt - DEPLOY_FLOOR) / (DEPLOY_MAX_ALT - DEPLOY_FLOOR), 0.3, 1)
        this.chuteQuality = this.quality
        this.hud.result = this.quality >= 0.78 ? 'CLEAN CANOPY' : this.quality >= 0.5 ? 'CANOPY OPEN' : 'HARD OPEN'
        this.phase = 'canopy'
        this.chute.visible = true
        this.rb.setFlyPose(0.2)
        this.onSfx?.('deploy')
        if (!forced) this.vy *= 0.5 // a clean pop bleeds speed; a forced one barely does
      }
    } else if (this.phase === 'canopy') {
      const want = -THREE.MathUtils.lerp(16, 9, this.quality)
      this.vy += (want - this.vy) * Math.min(1, dt * 2.5)
      this.chute.scale.setScalar(THREE.MathUtils.damp(this.chute.scale.x, 1, 6, dt))
      this.pitch += (0 - this.pitch) * Math.min(1, dt * 3)
      if (this.pos.y <= this.target.y + 1.5) this.phase = 'land'
    } else {
      // land: ease exactly onto the plaza point
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
    const diving = this.phase === 'dive'
    // Steeper body pitch the harder you tuck; level out under canopy.
    const bodyPitch = diving ? THREE.MathUtils.lerp(0.2, 1.25, this.pitch) : 0
    this.diver.rotation.set(bodyPitch, this.camHeading, clamp(-this.hVel.x * 0.02, -0.5, 0.5))
    this.rb.setThrust(0)
    this.rb.update(dt, diving ? 0.4 : 0.15, false)

    this.updateAi(dt)
    this.updateStreaks(dt, diving)
    this.placeCamera(false)

    // HUD
    this.hud.alt = Math.max(0, alt)
    this.hud.speed = Math.hypot(hs, this.vy)
    this.hud.phase = this.phase
    this.hud.canDeploy = this.phase === 'dive' && alt <= DEPLOY_MAX_ALT
    this.hud.hint = this.phase === 'canopy' ? 'GUIDE TO THE ARCADE'
      : this.phase === 'land' ? 'TOUCHDOWN'
      : this.hud.canDeploy ? 'STEER · DEPLOY THE CHUTE' : 'NOSE-DIVE · STEER TOWARD THE CITY'
    if (this.hud.result) { this.resultT += dt; if (this.resultT > 2.2) this.hud.result = null }

    // touchdown -> brief fade + handoff
    if (this.phase === 'land' && this.pos.y <= this.target.y + 0.6) {
      if (this.fade === 0) this.onSfx?.('land')
      this.fade = clamp(this.fade + dt * 2.2, 0, 1)
      if (this.fade >= 1) this.done = true
    }
  }

  private updateAi(dt: number) {
    for (const a of this.ai) {
      a.ang += a.spd * dt
      a.y -= a.vy * dt
      if (a.y < 6) { a.y = START_Y - Math.random() * 60; a.vy = 24 + Math.random() * 18 }
      a.g.position.set(a.cx + Math.cos(a.ang) * a.r, a.y, a.cz + Math.sin(a.ang) * a.r)
      a.g.rotation.y = -a.ang
    }
  }

  private updateStreaks(dt: number, fast: boolean) {
    const m = this.streaks.material as THREE.PointsMaterial
    m.opacity = THREE.MathUtils.damp(m.opacity, fast ? 0.85 : 0.3, 5, dt)
    this.streaks.position.copy(this.pos)
    const fp = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    const rise = fast ? 52 : 20
    for (let i = 0; i < this.streakVel.length; i++) {
      const j = i * 3 + 1
      fp[j] += (this.streakVel[i] + rise) * dt
      if (fp[j] > 14) fp[j] = -14
    }
    ;(this.streaks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  private placeCamera(snap: boolean) {
    this.fwd.set(Math.sin(this.camHeading), 0, Math.cos(this.camHeading))
    // Chase from above-behind, angled down the dive so the city rushes up at you.
    const want = this.camPos.copy(this.pos).addScaledVector(this.fwd, -7.5).add(new THREE.Vector3(0, 4.6, 0))
    const lookWant = this.camLook.copy(this.pos).addScaledVector(this.fwd, 7).add(new THREE.Vector3(0, -6.5, 0))
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
