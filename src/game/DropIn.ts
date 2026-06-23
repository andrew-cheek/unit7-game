import * as THREE from 'three'
import { clamp } from './utils'
import { createRobot, type RobotModel } from './procedural'
import type { Input } from './Input'

/** Live readout for the drop HUD: altimeter, speed, phase + contextual hint. */
export interface DropHud {
  alt: number
  speed: number
  phase: 'dive' | 'canopy' | 'land' | 'crash'
  hint: string | null
  canDeploy: boolean // the chute can be popped now (drives the DEPLOY button)
  result: string | null
}

// You start very high and fall the whole way down, steering the dive (tuck to
// plunge, flare to slow + hang) toward a beacon-marked destination, optionally
// clipping floating target orbs on the way. Pop the canopy in time and glide it
// down; leave it too late and you smash into pieces - then a helper bot zips in
// and reassembles you on the spot.
const START_Y = 920 // begin far above the city
const TERM_DIVE = -88
const TERM_FLARE = -30
const TERM_NEUTRAL = -58
const DEPLOY_REF_ALT = 260 // reference height for canopy-quality scaling (not a cap - deploy anytime)

/**
 * The playable opening: a high-altitude dive. You spawn nearly a kilometre up
 * and fall the whole way, steering the freefall (hold Space / drag forward to
 * tuck into a fast plunge; pull back to flare and hang) toward a beacon over the
 * destination, with optional target orbs to thread for a bonus. Pop the canopy
 * while you still have altitude and glide it down - you take control on foot
 * exactly where you touch down. Hit the ground without a chute and you shatter,
 * then a repair drone reassembles you. Reads as gameplay, not a cutscene.
 */
export class DropIn {
  readonly group = new THREE.Group()
  done = false
  fade = 0
  /** 0..1 how much altitude you had on canopy deploy (drives the reward). */
  chuteQuality = 0
  /** Optional target orbs threaded on the way down (small bonus). */
  bonusTargets = 0
  /** True if you hit the ground without a chute (crash + repair). */
  crashed = false
  /** Where you ended up - the handoff places the player here. */
  readonly landingPos = new THREE.Vector3()
  hud: DropHud = { alt: START_Y, speed: 0, phase: 'dive', hint: null, canDeploy: false, result: null }

  /** Fired on a target-orb pass, the canopy pop, and touchdown/crash, for SFX. */
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
  private vy = -24
  private hVel = new THREE.Vector3()
  private camHeading = 0
  private pitch = 0.5

  private phase: DropHud['phase'] = 'dive'
  private quality = 0
  private pendingDeploy = false
  private wantCut = false // cut the canopy back to free-fall
  private resultT = 0
  private totalT = 0 // total opening time, for a safety timeout (never soft-lock)

  // Destination beacon + optional target orbs.
  private orbs: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; pos: THREE.Vector3; hit: boolean }[] = []
  // Crash + repair.
  private crashT = 0
  private fragGeo!: THREE.BoxGeometry
  private fragMat!: THREE.MeshStandardMaterial
  private frags: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3 }[] = []
  private helper: RobotModel | null = null
  private repairBeam!: THREE.Mesh
  private impact = new THREE.Vector3()

  private ai: { g: THREE.Group; cx: number; cz: number; r: number; ang: number; spd: number; y: number; vy: number }[] = []
  private chute!: THREE.Mesh
  private streaks!: THREE.Points
  private streakVel!: Float32Array
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  private camPos = new THREE.Vector3()
  private camLook = new THREE.Vector3()
  private fwd = new THREE.Vector3()

  private static readonly STEER = 60 // strong horizontal control over the long fall
  private static readonly H_DAMP = 1.4
  private static readonly H_MAX = 68

  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera, input: Input, target: THREE.Vector3, getGround: (x: number, z: number) => number) {
    this.scene = scene
    this.cam = cam
    this.input = input
    this.target = target.clone()
    this.getGround = getGround
    this.start = new THREE.Vector3(target.x + 30, START_Y, target.z - 300)
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

    // Destination beacon: a tall fog-immune pillar of light over where to land,
    // plus a ground ring, so the goal is unmistakable from altitude.
    const beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9dff5a, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const beam = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(2.2, 2.2, START_Y, 12, 1, true)), beamMat)
    beam.position.set(this.target.x, this.target.y + START_Y / 2, this.target.z)
    this.group.add(beam)
    const ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9dff5a, transparent: true, opacity: 0.8, fog: false }))
    const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(7, 0.5, 10, 36)), ringMat)
    ring.rotation.x = Math.PI / 2
    ring.position.set(this.target.x, this.target.y + 0.6, this.target.z)
    this.group.add(ring)

    // Optional target orbs spaced down the approach line at varying offsets +
    // heights, so there are "things to aim for" without forcing a slalom.
    const orbMatBase = { transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending as THREE.Blending, depthWrite: false, fog: false }
    const orbGeo = this.ownG(new THREE.SphereGeometry(3.2, 16, 12))
    const orbColors = [0x27e7ff, 0xff2bd0, 0xffd24a]
    for (let i = 0; i < 3; i++) {
      const f = (i + 1) / 4
      const y = THREE.MathUtils.lerp(START_Y - 60, this.target.y + 120, f)
      const x = THREE.MathUtils.lerp(this.start.x, this.target.x, f) + (i % 2 === 0 ? 26 : -26)
      const z = THREE.MathUtils.lerp(this.start.z, this.target.z, f)
      const mat = this.own(new THREE.MeshBasicMaterial({ color: orbColors[i], ...orbMatBase }))
      const mesh = new THREE.Mesh(orbGeo, mat)
      mesh.position.set(x, y, z)
      this.group.add(mesh)
      this.orbs.push({ mesh, mat, pos: new THREE.Vector3(x, y, z), hit: false })
    }

    // Crash fragments + repair beam (built once, used only on a crash).
    this.fragGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.5, 0.5))
    this.fragMat = this.own(new THREE.MeshStandardMaterial({ color: 0xc9d4e3, metalness: 0.6, roughness: 0.5, emissive: 0x27e7ff, emissiveIntensity: 0.4 }))
    this.repairBeam = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.25, 0.25, 1, 8, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: 0x9dff5a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    this.repairBeam.visible = false
    this.group.add(this.repairBeam)

    const aiBody = this.own(new THREE.MeshStandardMaterial({ color: 0x223040, metalness: 0.5, roughness: 0.5 }))
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(this.ownG(new THREE.CapsuleGeometry(0.5, 1.1, 4, 8)), aiBody)
      g.add(body)
      const col = [0xff2bd0, 0x8a5cff, 0xff8a1e, 0x9dff5a][i % 4]
      const canopy = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.1)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: false })))
      canopy.position.y = 3.4
      g.add(canopy)
      const cx = this.start.x + (Math.random() - 0.5) * 100
      const cz = this.start.z * 0.5 + (Math.random() - 0.5) * 140
      const y = START_Y - Math.random() * 420
      g.position.set(cx, y, cz)
      this.group.add(g)
      this.ai.push({ g, cx, cz, r: 6 + Math.random() * 14, ang: Math.random() * 6.28, spd: 0.2 + Math.random() * 0.3, y, vy: 28 + Math.random() * 20 })
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
    // Context action: in free-fall it pops the chute (any altitude); under canopy
    // it CUTS the chute and drops you back into the dive.
    if (this.phase === 'dive') this.pendingDeploy = true
    else if (this.phase === 'canopy') this.wantCut = true
  }

  private cutCanopy() {
    this.phase = 'dive'
    this.chute.visible = false
    this.chute.scale.setScalar(0.1)
    this.rb.setFlyPose(1)
    this.hud.result = null
    this.wantCut = false
  }

  skip() {
    if (this.done) return
    this.pos.copy(this.target).setY(this.target.y + 0.4)
    this.vy = -2
    this.hVel.set(0, 0, 0)
    this.landingPos.copy(this.target)
    this.phase = 'land'
  }

  update(dt: number) {
    if (this.done) return
    // Safety: the opening should finish in ~25s; if anything stalls it, force a
    // clean handoff so the player is never trapped in the drop-in forever.
    this.totalT += dt
    if (this.totalT > 55) {
      this.landingPos.set(this.pos.x, this.getGround(this.pos.x, this.pos.z), this.pos.z)
      this.fade = 1
      this.done = true
      return
    }
    if (this.phase === 'crash') { this.updateCrash(dt); return }

    const ground = this.getGround(this.pos.x, this.pos.z)
    const alt = this.pos.y - ground

    const chute = this.input.consumeEdge('chute')
    if (chute) {
      if (this.phase === 'dive') this.pendingDeploy = true // deploy at any altitude
      else if (this.phase === 'canopy') this.wantCut = true // cut back to free-fall
    }
    if (this.wantCut && this.phase === 'canopy') this.cutCanopy()

    // --- horizontal steering (camera-relative) ---
    const yaw = this.input.yaw
    const controlScale = this.phase === 'canopy' ? 0.6 + this.quality * 0.4 : 1
    const ax = (-Math.cos(yaw) * this.input.moveX + Math.sin(yaw) * this.input.moveY) * DropIn.STEER * controlScale
    const az = (Math.sin(yaw) * this.input.moveX + Math.cos(yaw) * this.input.moveY) * DropIn.STEER * controlScale
    this.hVel.x += ax * dt
    this.hVel.z += az * dt

    if (this.phase === 'canopy') {
      // Gentle pull toward the beacon so a flailing drop still ends near the
      // plaza - but light enough that you mostly land where you steer.
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z
      const d = Math.hypot(dx, dz) || 1
      const assist = 5
      this.hVel.x += (dx / d) * assist * dt
      this.hVel.z += (dz / d) * assist * dt
    }
    const damp = Math.exp(-DropIn.H_DAMP * dt)
    this.hVel.x *= damp
    this.hVel.z *= damp
    const hs = Math.hypot(this.hVel.x, this.hVel.z)
    const hMax = this.phase === 'canopy' ? 32 : DropIn.H_MAX
    if (hs > hMax) { this.hVel.x *= hMax / hs; this.hVel.z *= hMax / hs }

    // --- phase machine ---
    if (this.phase === 'dive') {
      let diveAmt = 0.5
      if (this.input.held.jet || this.input.moveY > 0.35) diveAmt = 1
      else if (this.input.moveY < -0.35) diveAmt = 0.08
      this.pitch += (diveAmt - this.pitch) * Math.min(1, dt * 3)
      const term = diveAmt >= 0.99 ? TERM_DIVE : diveAmt <= 0.1 ? TERM_FLARE : TERM_NEUTRAL
      this.vy += (term - this.vy) * Math.min(1, dt * 1.5)

      this.checkOrbs()

      if (this.pendingDeploy) {
        this.quality = clamp((alt - 40) / (DEPLOY_REF_ALT - 40), 0.3, 1)
        this.chuteQuality = this.quality
        this.hud.result = this.quality >= 0.78 ? 'CLEAN CANOPY' : this.quality >= 0.5 ? 'CANOPY OPEN' : 'HARD OPEN'
        this.phase = 'canopy'
        this.chute.visible = true
        this.rb.setFlyPose(0.2)
        this.onSfx?.('deploy')
        this.vy *= 0.5
      } else if (alt <= 2) {
        this.beginCrash(ground)
        return
      }
    } else if (this.phase === 'canopy') {
      const want = -THREE.MathUtils.lerp(16, 9, this.quality)
      this.vy += (want - this.vy) * Math.min(1, dt * 2.5)
      this.chute.scale.setScalar(THREE.MathUtils.damp(this.chute.scale.x, 1, 6, dt))
      this.pitch += (0 - this.pitch) * Math.min(1, dt * 3)
      if (alt <= 1.5) { this.phase = 'land'; this.landingPos.set(this.pos.x, ground, this.pos.z) }
    } else {
      // land: settle straight down where you are - no relocation.
      this.vy += (-2 - this.vy) * Math.min(1, dt * 4)
    }

    // integrate
    this.pos.x += this.hVel.x * dt
    this.pos.z += this.hVel.z * dt
    this.pos.y += this.vy * dt

    this.diver.position.copy(this.pos)
    if (hs > 0.5) this.camHeading = Math.atan2(this.hVel.x, this.hVel.z)
    const diving = this.phase === 'dive'
    const bodyPitch = diving ? THREE.MathUtils.lerp(0.2, 1.25, this.pitch) : 0
    this.diver.rotation.set(bodyPitch, this.camHeading, clamp(-this.hVel.x * 0.02, -0.5, 0.5))
    this.rb.setThrust(0)
    this.rb.update(dt, diving ? 0.4 : 0.15, false)

    this.updateAi(dt)
    this.updateStreaks(dt, diving)
    this.placeCamera(false)

    this.hud.alt = Math.max(0, alt)
    this.hud.speed = Math.hypot(hs, this.vy)
    this.hud.phase = this.phase
    this.hud.canDeploy = this.phase === 'dive'
    this.hud.hint = this.phase === 'canopy' ? 'STEER TO THE BEACON'
      : this.phase === 'land' ? 'TOUCHDOWN'
      : 'STEER · DEPLOY THE CHUTE ANYTIME'
    if (this.hud.result) { this.resultT += dt; if (this.resultT > 2.2) this.hud.result = null }

    if (this.phase === 'land' && alt <= 0.6) {
      if (this.fade === 0) { this.onSfx?.('land'); this.landingPos.set(this.pos.x, this.getGround(this.pos.x, this.pos.z), this.pos.z) }
      this.fade = clamp(this.fade + dt * 2.2, 0, 1)
      if (this.fade >= 1) this.done = true
    }
  }

  /** Optional target orbs: clipping one pops it, plays a chime, banks a bonus. */
  private checkOrbs() {
    for (const o of this.orbs) {
      if (o.hit) continue
      o.mesh.rotation.y += 0.02
      if (Math.abs(this.pos.y - o.pos.y) < 6) {
        const d = Math.hypot(this.pos.x - o.pos.x, this.pos.z - o.pos.z)
        if (d < 6) {
          o.hit = true
          o.mesh.visible = false
          this.bonusTargets++
          this.onSfx?.('ring')
        }
      }
    }
  }

  // --- crash + repair -------------------------------------------------------

  private beginCrash(ground: number) {
    this.crashed = true
    this.phase = 'crash'
    this.crashT = 0
    this.impact.set(this.pos.x, ground, this.pos.z)
    this.landingPos.copy(this.impact)
    this.diver.visible = false
    this.onSfx?.('land')
    this.hud.phase = 'crash'
    this.hud.result = 'SMASHED!'
    this.hud.hint = 'REASSEMBLING…'
    this.hud.canDeploy = false
    // Scatter fragments from the impact.
    for (let i = 0; i < 14; i++) {
      const mesh = new THREE.Mesh(this.fragGeo, this.fragMat)
      mesh.position.set(this.impact.x, this.impact.y + 1, this.impact.z)
      mesh.scale.setScalar(0.6 + Math.random())
      const a = Math.random() * 6.28
      const sp = 4 + Math.random() * 7
      this.frags.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * sp, 6 + Math.random() * 6, Math.sin(a) * sp),
        spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      })
      this.group.add(mesh)
    }
    // A repair drone (small robot) drops in from above-beside the wreck.
    this.helper = createRobot({ trim: 0x9dff5a, accent: 0x9dff5a })
    this.helper.group.scale.setScalar(0.5)
    this.helper.group.position.set(this.impact.x + 8, this.impact.y + 34, this.impact.z - 8)
    this.helper.setFlyPose(1)
    this.group.add(this.helper.group)
    this.repairBeam.visible = false
  }

  private updateCrash(dt: number) {
    this.crashT += dt
    const t = this.crashT

    // Fragments fly out + fall, then converge back and shrink as you're rebuilt.
    for (const f of this.frags) {
      if (t < 1.1) {
        f.vel.y -= 26 * dt
        f.mesh.position.addScaledVector(f.vel, dt)
        if (f.mesh.position.y < this.impact.y + 0.25) { f.mesh.position.y = this.impact.y + 0.25; f.vel.y *= -0.35; f.vel.x *= 0.6; f.vel.z *= 0.6 }
        f.mesh.rotation.x += f.spin.x * dt; f.mesh.rotation.y += f.spin.y * dt
      } else {
        const k = Math.min(1, (t - 1.1) / 1.0)
        f.mesh.position.lerp(this.impact, k * 0.2)
        f.mesh.scale.multiplyScalar(Math.max(0.0001, 1 - dt * 2.2))
        f.mesh.rotation.y += f.spin.y * dt * 0.5
      }
    }

    // Helper descends to hover over the wreck, then beams a repair.
    if (this.helper) {
      const h = this.helper.group
      const hoverY = this.impact.y + 5
      h.position.x = THREE.MathUtils.damp(h.position.x, this.impact.x + 2.2, 4, dt)
      h.position.z = THREE.MathUtils.damp(h.position.z, this.impact.z - 2.2, 4, dt)
      h.position.y = THREE.MathUtils.damp(h.position.y, t > 2.4 ? this.impact.y + 34 : hoverY, 3, dt)
      h.lookAt(this.impact.x, this.impact.y + 1, this.impact.z)
      this.helper.setThrust(0.6)
      this.helper.update(dt, 0.2, false)
      const bm = this.repairBeam.material as THREE.MeshBasicMaterial
      if (t > 0.9 && t < 2.3) {
        this.repairBeam.visible = true
        const from = h.position, to = this.impact
        const mid = this.camPos.copy(from).lerp(to, 0.5)
        const len = from.distanceTo(to)
        this.repairBeam.position.copy(mid)
        this.repairBeam.scale.set(1, len, 1)
        this.repairBeam.lookAt(to)
        this.repairBeam.rotateX(Math.PI / 2)
        bm.opacity = 0.4 + Math.sin(t * 30) * 0.25
      } else {
        this.repairBeam.visible = false
      }
    }

    // Rebuilt: the diver pops back, standing, then we hand off.
    if (t > 2.0 && !this.diver.visible) {
      this.diver.visible = true
      this.diver.position.copy(this.impact)
      this.diver.rotation.set(0, this.camHeading, 0)
      this.rb.setFlyPose(0)
      this.diver.scale.setScalar(0.2)
    }
    if (this.diver.visible) {
      const s = THREE.MathUtils.damp(this.diver.scale.x, 1, 8, dt)
      this.diver.scale.setScalar(s)
      this.rb.update(dt, 0, true)
    }

    this.hud.alt = 0
    this.hud.speed = 0
    this.placeCamera(false)

    if (t > 2.7) {
      this.fade = clamp(this.fade + dt * 2.4, 0, 1)
      if (this.fade >= 1) this.done = true
    }
  }

  private updateAi(dt: number) {
    for (const a of this.ai) {
      a.ang += a.spd * dt
      a.y -= a.vy * dt
      if (a.y < 6) { a.y = START_Y - Math.random() * 80; a.vy = 28 + Math.random() * 20 }
      a.g.position.set(a.cx + Math.cos(a.ang) * a.r, a.y, a.cz + Math.sin(a.ang) * a.r)
      a.g.rotation.y = -a.ang
    }
  }

  private updateStreaks(dt: number, fast: boolean) {
    const m = this.streaks.material as THREE.PointsMaterial
    m.opacity = THREE.MathUtils.damp(m.opacity, fast ? 0.85 : 0.3, 5, dt)
    this.streaks.position.copy(this.pos)
    const fp = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    const rise = fast ? 54 : 20
    for (let i = 0; i < this.streakVel.length; i++) {
      const j = i * 3 + 1
      fp[j] += (this.streakVel[i] + rise) * dt
      if (fp[j] > 14) fp[j] = -14
    }
    ;(this.streaks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  private placeCamera(snap: boolean) {
    if (this.phase === 'crash') {
      // Pull out and frame the wreck + the repair drone.
      const want = this.camPos.set(this.impact.x + 10, this.impact.y + 7, this.impact.z - 12)
      this.cam.position.lerp(want, 0.06)
      this.cam.lookAt(this.impact.x, this.impact.y + 1.5, this.impact.z)
      return
    }
    this.fwd.set(Math.sin(this.camHeading), 0, Math.cos(this.camHeading))
    let want: THREE.Vector3
    let lookWant: THREE.Vector3
    if (this.phase === 'canopy') {
      // Under canopy: drop back + lower and look UP toward the diver so the open
      // chute above is clearly in frame (the dive framing looked down past it).
      want = this.camPos.copy(this.pos).addScaledVector(this.fwd, -11).add(new THREE.Vector3(0, 1.5, 0))
      lookWant = this.camLook.copy(this.pos).addScaledVector(this.fwd, 4).add(new THREE.Vector3(0, 4.5, 0))
    } else {
      // Dive: chase from above-behind, angled down so the city rushes up at you.
      want = this.camPos.copy(this.pos).addScaledVector(this.fwd, -7.5).add(new THREE.Vector3(0, 4.6, 0))
      lookWant = this.camLook.copy(this.pos).addScaledVector(this.fwd, 7).add(new THREE.Vector3(0, -6.5, 0))
    }
    if (snap) this.cam.position.copy(want)
    else this.cam.position.lerp(want, 0.09)
    this.cam.lookAt(lookWant)
  }

  dispose() {
    this.scene.remove(this.group)
    this.rb.dispose()
    this.helper?.dispose()
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
  }
}
