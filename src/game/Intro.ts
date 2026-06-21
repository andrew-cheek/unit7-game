import * as THREE from 'three'
import { clamp } from './utils'
import { createRobot, type RobotModel } from './procedural'

/** Smoothstep ramp between two times. */
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
/** Ease-out with a slight snap, for parts locking into place. */
const pop = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3))

// --- staging --------------------------------------------------------------
// The whole cinematic plays in its own pocket of sky/track well clear of the
// city (z far negative), so nothing intrudes and it can be torn down cleanly.
const PLANE = new THREE.Vector3(0, 120, -350)

// Bike track centerline. A vertical loop returns to the same z, so only the
// straight segments advance z - that keeps the whole track inside [-470,-310].
const Z_BASE = -470
const L0 = 120 // approach run
const R = 8.5 // loop radius
const LOOP = 2 * Math.PI * R // arc length of one loop
const L2 = 18 // straight between the two loops
const RUNOFF = 26 // runoff after the second loop
const S_END = L0 + LOOP + L2 + LOOP + RUNOFF
const TRACK_R = 0.7 // deck tube radius; the bike rides on its surface
const SEAT_H = 0.95 // robot sits this far above the bike along the track's "up"

// Beat timeline (seconds). Tightened from ~23s to ~14s on feedback that the
// intro ran long; the beats keep their relative pacing, just compressed.
const T_ASSEMBLE = 3.2
const T_HATCH = 4.2
const T_JUMP = 5.0
const T_CHUTE = 7.4
const T_LAND = 9.4
const T_LOOP1 = 11.2
const T_GAP = 11.9
const T_LOOP2 = 13.6
const DURATION = 14.2
// When the bike starts rolling along the approach (before the robot lands).
const T_BIKE_START = 2.5

interface PathPoint {
  pos: THREE.Vector3
  fwd: THREE.Vector3
  up: THREE.Vector3
}

/**
 * Skippable opening cinematic, sci-fi neon theme, fully self-contained so it
 * drops into the mode-system cleanly: it owns a single group + the camera while
 * `done` is false, exposes `fade` (0..1) for the orchestrator to drive the black
 * overlay, and disposes everything on exit. Beats:
 *
 *   1. Interior of a transport plane in flight; the robot assembles from parts
 *      that fly in and lock together, then a power-on flash reveals it.
 *   2. The rear cargo hatch lowers; the robot moves to the edge.
 *   3. It leaps into open sky; freefall with speed-streaks and the city far below.
 *   4. A neon canopy deploys and steers it toward a moving target.
 *   5. It lands precisely on top of a moving hover-bike.
 *   6. The bike rides up a sci-fi ramp through a full vertical loop, then a
 *      second loop, and rolls out.
 *   7. The camera settles into a third-person trail, matching the gameplay
 *      follow cam, and hands off.
 */
export class Intro {
  readonly group = new THREE.Group()
  done = false
  fade = 1 // start from black; ramps to 0 after the opening, back to 1 at the end

  private t = 0
  private scene: THREE.Scene
  private cam: THREE.PerspectiveCamera
  private mats: THREE.Material[] = []

  // hero robot (polished rig) + the flying assembly proxies
  private rb: RobotModel
  private robot = new THREE.Group()
  private proxies: { mesh: THREE.Mesh; home: THREE.Vector3; from: THREE.Vector3; lock: number; locked: boolean }[] = []

  // plane
  private plane = new THREE.Group()
  private hatch!: THREE.Object3D

  // bike
  private bike = new THREE.Group()

  // fx
  private weldLight!: THREE.PointLight
  private streaks!: THREE.Points
  private streakVel!: Float32Array
  private sparks!: THREE.Points
  private sparkVel!: Float32Array

  // scratch
  private vTmp = new THREE.Vector3()
  private mTmp = new THREE.Matrix4()
  private qTmp = new THREE.Quaternion()
  private right = new THREE.Vector3()
  private camLookAt = new THREE.Vector3()

  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera) {
    this.scene = scene
    this.cam = cam
    this.rb = createRobot()
    this.build()
    scene.add(this.group)
  }

  private own<T extends THREE.Material>(m: T): T {
    this.mats.push(m)
    return m
  }
  private metal(color: number, e = 0, ei = 2.5) {
    return this.own(new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.35, emissive: e, emissiveIntensity: e ? ei : 0 }))
  }
  private glow(color: number, ei = 3) {
    return this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: ei, roughness: 0.4 }))
  }

  // --- build ---------------------------------------------------------------
  private build() {
    this.buildPlane()
    this.buildRobot()
    this.buildTrack()
    this.buildBike()
    this.buildFx()
    this.buildLights()
  }

  private buildPlane() {
    this.plane.position.copy(PLANE)
    // Ribbed fuselage shell (interior visible - BackSide).
    const shellMat = this.own(new THREE.MeshStandardMaterial({ color: 0x12161f, metalness: 0.8, roughness: 0.5, side: THREE.BackSide }))
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 18, 18, 1, true), shellMat)
    shell.rotation.x = Math.PI / 2 // axis along Z
    this.plane.add(shell)
    // Cargo floor.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.3, 17), this.metal(0x171c27))
    floor.position.y = -2.6
    this.plane.add(floor)
    // Glowing rib rings + side strips.
    for (let i = -2; i <= 2; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4.0, 0.06, 8, 28), this.glow(0x27e7ff, 2.4))
      ring.rotation.y = Math.PI / 2
      ring.position.z = i * 3.6
      this.plane.add(ring)
    }
    for (const sx of [-3.6, 3.6]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 15), this.glow(sx < 0 ? 0xff2bd0 : 0x8a5cff, 2.4))
      strip.position.set(sx, -1.4, 0)
      this.plane.add(strip)
    }
    // Rear cargo hatch/ramp at -Z that lowers open. Pivot at its top edge.
    const hatch = new THREE.Group()
    hatch.position.set(0, -2.7, -9)
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.3, 6), this.metal(0x1a2030))
    ramp.position.z = -3
    hatch.add(ramp)
    const lip = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.18, 0.5), this.glow(0xff8a1e, 2.6))
    lip.position.z = -6
    hatch.add(lip)
    this.hatch = hatch
    this.plane.add(hatch)
    this.group.add(this.plane)
  }

  private buildRobot() {
    // Flying assembly proxies (simple slabs that converge to the silhouette).
    const body = this.metal(0xc9d4e3, 0)
    const dark = this.metal(0x2a3140, 0)
    const trim = this.glow(0x27e7ff, 3)
    const part = (geo: THREE.BufferGeometry, mat: THREE.Material, home: THREE.Vector3, dir: THREE.Vector3, lock: number) => {
      const mesh = new THREE.Mesh(geo, mat)
      const from = home.clone().add(dir)
      mesh.position.copy(from)
      mesh.castShadow = true
      this.robot.add(mesh)
      this.proxies.push({ mesh, home: home.clone(), from, lock, locked: false })
    }
    part(new THREE.BoxGeometry(0.55, 0.7, 0.4), body, new THREE.Vector3(0, 1.35, 0), new THREE.Vector3(0, 6, -3), 1.0) // torso
    part(new THREE.BoxGeometry(0.18, 0.7, 0.2), body, new THREE.Vector3(-0.15, 0.65, 0), new THREE.Vector3(-5, -2, 2), 1.7) // legL
    part(new THREE.BoxGeometry(0.18, 0.7, 0.2), body, new THREE.Vector3(0.15, 0.65, 0), new THREE.Vector3(5, -2, 2), 1.9) // legR
    part(new THREE.BoxGeometry(0.14, 0.6, 0.16), body, new THREE.Vector3(-0.36, 1.3, 0), new THREE.Vector3(-6, 1, -2), 2.6) // armL
    part(new THREE.BoxGeometry(0.14, 0.6, 0.16), body, new THREE.Vector3(0.36, 1.3, 0), new THREE.Vector3(6, 1, -2), 2.8) // armR
    part(new THREE.BoxGeometry(0.34, 0.18, 0.18), dark, new THREE.Vector3(0, 1.34, -0.24), new THREE.Vector3(0, 4, 4), 3.4) // pack
    part(new THREE.BoxGeometry(0.34, 0.32, 0.34), body, new THREE.Vector3(0, 1.82, 0), new THREE.Vector3(0, 7, 0), 4.0) // head
    void trim

    // Hero robot starts hidden; revealed at the power-on flash.
    this.rb.group.visible = false
    this.robot.add(this.rb.group)
    this.robot.position.copy(PLANE).add(new THREE.Vector3(0, -2.45, 1.5)) // on the cargo floor
    this.group.add(this.robot)
  }

  // Parametric bike-track path. s in [0, S_END].
  private path(s: number, out: PathPoint) {
    const zc1 = Z_BASE + L0
    const zc2 = zc1 + L2
    if (s < L0) {
      out.pos.set(0, 0, Z_BASE + s)
      out.fwd.set(0, 0, 1)
      out.up.set(0, 1, 0)
    } else if (s < L0 + LOOP) {
      const phi = (s - L0) / R
      out.pos.set(0, R - R * Math.cos(phi), zc1 + R * Math.sin(phi))
      out.fwd.set(0, Math.sin(phi), Math.cos(phi)).normalize()
      out.up.set(0, Math.cos(phi), -Math.sin(phi)).normalize()
    } else if (s < L0 + LOOP + L2) {
      out.pos.set(0, 0, zc1 + (s - (L0 + LOOP)))
      out.fwd.set(0, 0, 1)
      out.up.set(0, 1, 0)
    } else if (s < L0 + LOOP + L2 + LOOP) {
      const phi = (s - (L0 + LOOP + L2)) / R
      out.pos.set(0, R - R * Math.cos(phi), zc2 + R * Math.sin(phi))
      out.fwd.set(0, Math.sin(phi), Math.cos(phi)).normalize()
      out.up.set(0, Math.cos(phi), -Math.sin(phi)).normalize()
    } else {
      out.pos.set(0, 0, zc2 + (s - (L0 + LOOP + L2 + LOOP)))
      out.fwd.set(0, 0, 1)
      out.up.set(0, 1, 0)
    }
  }

  /** Distance travelled along the track at time t (scripted to hit each beat). */
  private bikeS(t: number): number {
    if (t < T_LAND) return L0 * smooth(T_BIKE_START, T_LAND, t) // approach, accelerating in
    if (t < T_LOOP1) return L0 + LOOP * smooth(T_LAND, T_LOOP1, t)
    if (t < T_GAP) return L0 + LOOP + L2 * smooth(T_LOOP1, T_GAP, t)
    if (t < T_LOOP2) return L0 + LOOP + L2 + LOOP * smooth(T_GAP, T_LOOP2, t)
    return L0 + LOOP + L2 + LOOP + RUNOFF * smooth(T_LOOP2, DURATION, t)
  }

  private buildTrack() {
    const pts: THREE.Vector3[] = []
    const railL: THREE.Vector3[] = []
    const railR: THREE.Vector3[] = []
    const p: PathPoint = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(), up: new THREE.Vector3() }
    const N = 220
    for (let i = 0; i <= N; i++) {
      const s = (i / N) * S_END
      this.path(s, p)
      pts.push(p.pos.clone())
      const right = new THREE.Vector3().crossVectors(p.up, p.fwd).normalize()
      railL.push(p.pos.clone().addScaledVector(right, -1.1).addScaledVector(p.up, TRACK_R))
      railR.push(p.pos.clone().addScaledVector(right, 1.1).addScaledVector(p.up, TRACK_R))
    }
    const deck = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 240, TRACK_R, 8, false)
    const deckMesh = new THREE.Mesh(deck, this.metal(0x10141d, 0))
    deckMesh.receiveShadow = true
    this.group.add(deckMesh)
    const rl = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railL), 240, 0.18, 6, false)
    const rr = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railR), 240, 0.18, 6, false)
    this.group.add(new THREE.Mesh(rl, this.glow(0x27e7ff, 3)))
    this.group.add(new THREE.Mesh(rr, this.glow(0xff2bd0, 3)))
    // Support pylons under the loops for a built, engineered look.
    for (const zc of [Z_BASE + L0, Z_BASE + L0 + L2]) {
      const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 2 * R, 10), this.metal(0x1b2230, 0))
      pylon.position.set(0, R, zc)
      this.group.add(pylon)
    }
  }

  private buildBike() {
    const bodyMat = this.metal(0x1b2230, 0)
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 2.4), bodyMat)
    chassis.position.y = 0.1
    this.bike.add(chassis)
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.0, 12), bodyMat)
    nose.rotation.x = Math.PI / 2
    nose.position.set(0, 0.12, 1.5)
    this.bike.add(nose)
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.9), this.metal(0x2a3140, 0))
    seat.position.set(0, 0.34, -0.2)
    this.bike.add(seat)
    const under = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 2.0), this.glow(0x27e7ff, 4))
    under.position.y = -0.16
    this.bike.add(under)
    for (const sx of [-0.42, 0.42]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 0.8), this.glow(0xff2bd0, 2.6))
      fin.position.set(sx, 0.1, -0.7)
      this.bike.add(fin)
    }
    // Wheels as glowing rings (hover-bike).
    for (const z of [1.0, -0.9]) {
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.1, 10, 18), this.glow(0x59d0ff, 3))
      wheel.position.set(0, -0.05, z)
      this.bike.add(wheel)
    }
    this.bike.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.castShadow = true
    })
    this.group.add(this.bike)
  }

  private buildFx() {
    // Assembly sparks.
    const NS = 90
    this.sparkVel = new Float32Array(NS * 3)
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NS * 3), 3))
    const sm = this.own(new THREE.PointsMaterial({ color: 0xffd9a8, size: 0.16, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.sparks = new THREE.Points(sg, sm)
    this.sparks.frustumCulled = false
    this.group.add(this.sparks)

    // Freefall speed streaks (a cloud around the robot, drifting "up" past it).
    const NF = 140
    const fp = new Float32Array(NF * 3)
    this.streakVel = new Float32Array(NF)
    for (let i = 0; i < NF; i++) {
      fp[i * 3] = (Math.random() - 0.5) * 14
      fp[i * 3 + 1] = (Math.random() - 0.5) * 20
      fp[i * 3 + 2] = (Math.random() - 0.5) * 14
      this.streakVel[i] = 14 + Math.random() * 16
    }
    const fg = new THREE.BufferGeometry()
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3))
    const fm = this.own(new THREE.PointsMaterial({ color: 0xbfe7ff, size: 0.07, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.streaks = new THREE.Points(fg, fm)
    this.streaks.frustumCulled = false
    this.group.add(this.streaks)
  }

  private buildLights() {
    const key = new THREE.PointLight(0xbfd2ff, 200, 80, 2)
    key.position.copy(PLANE).add(new THREE.Vector3(3, 4, 3))
    const fill = new THREE.PointLight(0x27e7ff, 90, 70, 2)
    fill.position.copy(PLANE).add(new THREE.Vector3(-4, 1, -3))
    this.group.add(key, fill)
    this.weldLight = new THREE.PointLight(0x9fd8ff, 0, 22, 2)
    this.weldLight.position.copy(PLANE)
    this.group.add(this.weldLight)
  }

  // --- fx helpers ----------------------------------------------------------
  private burstSparks(at: THREE.Vector3) {
    const pos = (this.sparks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = at.x
      pos[i + 1] = at.y
      pos[i + 2] = at.z
      this.sparkVel[i] = (Math.random() - 0.5) * 6
      this.sparkVel[i + 1] = Math.random() * 6 + 2
      this.sparkVel[i + 2] = (Math.random() - 0.5) * 6
    }
    ;(this.sparks.material as THREE.PointsMaterial).opacity = 1
    ;(this.sparks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  skip() {
    if (!this.done) {
      this.t = DURATION
      this.done = true
    }
  }

  // --- per-frame -----------------------------------------------------------
  update(dt: number) {
    if (this.done) return
    this.t += dt
    const t = this.t

    // Opening fade-in from black, closing fade-out to black for the handoff.
    this.fade = Math.max(1 - smooth(0, 0.6, t), smooth(DURATION - 0.7, DURATION, t))

    this.updateAssembly(dt, t)
    this.updatePlane(t)
    this.updateBike(t)
    this.updateRobot(dt, t)
    this.updateSparks(dt)
    this.updateStreaks(dt, t)
    this.updateCamera(t)

    if (t >= DURATION) this.done = true
  }

  private updateAssembly(dt: number, t: number) {
    const assembling = t < T_ASSEMBLE
    for (const pr of this.proxies) {
      const a = pop(smooth(pr.lock - 0.9, pr.lock, t))
      pr.mesh.position.lerpVectors(pr.from, pr.home, a)
      pr.mesh.scale.setScalar(0.02 + a * 0.98)
      pr.mesh.visible = a > 0.01 && t < T_ASSEMBLE + 0.35
      if (!pr.locked && a >= 0.999) {
        pr.locked = true
        this.burstSparks(this.vTmp.copy(pr.home).add(this.robot.position))
        this.weldLight.intensity = 220
        this.weldLight.position.copy(this.robot.position).add(pr.home)
      }
    }
    this.weldLight.intensity *= 0.86

    // Power-on flash reveals the polished rig as the proxies fade.
    if (t > T_ASSEMBLE - 0.15 && !this.rb.group.visible) {
      this.rb.group.visible = true
      this.weldLight.intensity = 320
    }
    if (assembling) this.rb.update(dt, 0, true)
  }

  private updatePlane(t: number) {
    // Plane drifts gently forward; lifts away once the robot has jumped.
    const drift = t * 0.6
    this.plane.position.set(PLANE.x, PLANE.y + smooth(T_JUMP, DURATION, t) * 40, PLANE.z + drift)
    // Rear hatch lowers open between assembly end and the jump.
    this.hatch.rotation.x = -smooth(T_ASSEMBLE, T_HATCH, t) * 1.5
  }

  private updateBike(t: number) {
    const s = this.bikeS(t)
    const pos = new THREE.Vector3()
    const fwd = new THREE.Vector3()
    const up = new THREE.Vector3()
    this.path(s, { pos, fwd, up })
    this.bike.position.copy(pos).addScaledVector(up, TRACK_R)
    const right = this.right.crossVectors(up, fwd).normalize()
    this.mTmp.makeBasis(right, up, fwd)
    this.qTmp.setFromRotationMatrix(this.mTmp)
    this.bike.quaternion.copy(this.qTmp)
  }

  /** World-space seat position + orientation of the bike at time t. */
  private bikeSeat(t: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion) {
    const s = this.bikeS(t)
    const pos = new THREE.Vector3()
    const fwd = new THREE.Vector3()
    const up = new THREE.Vector3()
    this.path(s, { pos, fwd, up })
    const right = new THREE.Vector3().crossVectors(up, fwd).normalize()
    outPos.copy(pos).addScaledVector(up, TRACK_R + SEAT_H)
    outQuat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd))
  }

  private updateRobot(dt: number, t: number) {
    if (t < T_ASSEMBLE) {
      // staged on the cargo floor; upright
      this.robot.quaternion.identity()
      return
    }
    if (t < T_JUMP) {
      // Walk to the hatch edge (toward -Z), facing out.
      const k = smooth(T_HATCH, T_JUMP, t)
      this.robot.position.copy(PLANE).add(new THREE.Vector3(0, -2.45, 1.5 - k * 7))
      this.robot.quaternion.identity()
      this.robot.rotateY(Math.PI) // face -Z (the opening)
      this.rb.update(dt, k, true)
      return
    }

    // Landing target (where the bike seat will be at T_LAND).
    const landPos = new THREE.Vector3()
    const landQuat = new THREE.Quaternion()
    this.bikeSeat(T_LAND, landPos, landQuat)

    if (t < T_CHUTE) {
      // Freefall: accelerate downward from the plane toward the area above target.
      const k = smooth(T_JUMP, T_CHUTE, t)
      const start = PLANE.clone().add(new THREE.Vector3(0, -3, -5.5))
      const apex = landPos.clone().add(new THREE.Vector3(0, 45, 0))
      this.robot.position.lerpVectors(start, apex, k * k)
      // Tumble into a belly-to-earth spread.
      this.robot.quaternion.setFromEuler(new THREE.Euler(-1.1 * smooth(T_JUMP, T_JUMP + 1.2, t), t * 2.2 * (1 - k), 0))
      this.rb.setFlyPose(1)
      this.rb.setThrust(0)
      this.rb.update(dt, 0.4, false)
      return
    }
    if (t < T_LAND) {
      // Canopy descent: ease precisely onto the moving bike seat.
      const k = smooth(T_CHUTE, T_LAND, t)
      const apex = landPos.clone().add(new THREE.Vector3(0, 45, 0))
      const seatNow = new THREE.Vector3()
      const seatQuat = new THREE.Quaternion()
      this.bikeSeat(t, seatNow, seatQuat)
      // Blend from the freefall apex toward the live seat so the contact is exact.
      this.robot.position.lerpVectors(apex, seatNow, pop(k))
      this.robot.quaternion.slerpQuaternions(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0, 0)),
        seatQuat,
        smooth(T_LAND - 1.4, T_LAND, t),
      )
      this.rb.setFlyPose(1)
      this.rb.setThrust(0.2)
      this.rb.update(dt, 0.2, false)
      return
    }

    // Riding: locked to the bike seat through the loops.
    const seatNow = new THREE.Vector3()
    const seatQuat = new THREE.Quaternion()
    this.bikeSeat(t, seatNow, seatQuat)
    this.robot.position.copy(seatNow)
    this.robot.quaternion.copy(seatQuat)
    this.rb.setFlyPose(0.3) // slight tuck/crouch on the bike
    this.rb.setThrust(0)
    this.rb.update(dt, 0.12, true) // minimal leg motion - it's seated, not running
  }

  private updateSparks(dt: number) {
    const sp = (this.sparks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < sp.length; i += 3) {
      this.sparkVel[i + 1] -= 16 * dt
      sp[i] += this.sparkVel[i] * dt
      sp[i + 1] += this.sparkVel[i + 1] * dt
      sp[i + 2] += this.sparkVel[i + 2] * dt
    }
    ;(this.sparks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    const sm = this.sparks.material as THREE.PointsMaterial
    sm.opacity = Math.max(0, sm.opacity - dt * 1.5)
  }

  private updateStreaks(dt: number, t: number) {
    const sm = this.streaks.material as THREE.PointsMaterial
    const active = t > T_JUMP && t < T_LAND
    sm.opacity = active ? Math.min(0.9, sm.opacity + dt * 3) : Math.max(0, sm.opacity - dt * 3)
    this.streaks.position.copy(this.robot.position)
    if (sm.opacity <= 0.001) return
    const fp = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < this.streakVel.length; i++) {
      const j = i * 3 + 1
      fp[j] += this.streakVel[i] * dt // drift upward past the falling robot
      if (fp[j] > 12) fp[j] = -12
    }
    ;(this.streaks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  private updateCamera(t: number) {
    const rb = this.robot.position
    if (t < T_ASSEMBLE) {
      // Slow orbital push inside the plane around the assembling robot.
      const a = t * 0.5 - 0.6
      const focus = this.vTmp.copy(this.robot.position).add(new THREE.Vector3(0, 1.2, 0))
      // Stay inside the fuselage (shell radius ~4.2).
      this.cam.position.set(focus.x + Math.sin(a) * 3.0, focus.y + 1.2 + Math.sin(t * 0.6) * 0.5, focus.z + Math.cos(a) * 3.0)
      this.camLookAt.copy(focus)
    } else if (t < T_JUMP) {
      // Pull back toward the open hatch, framing the robot against the sky.
      const focus = this.vTmp.copy(rb).add(new THREE.Vector3(0, 1.2, 0))
      this.cam.position.lerp(this.camLook(focus, new THREE.Vector3(3.5, 2.0, 6.5)), 0.08)
      this.camLookAt.lerp(focus, 0.12)
    } else if (t < T_LAND) {
      // Chase the freefall from above and behind; keep the target in frame.
      const focus = this.vTmp.copy(rb).add(new THREE.Vector3(0, 0.8, 0))
      const behind = this.camLook(focus, new THREE.Vector3(2.5, 3.0, 8.0))
      this.cam.position.lerp(behind, 0.05)
      this.camLookAt.lerp(focus, 0.1)
    } else if (t < DURATION - 1.0) {
      // Dramatic side-chase of the bike through the loops.
      const focus = this.vTmp.copy(this.bike.position).add(new THREE.Vector3(0, R * 0.6, 0))
      const side = this.camLook(focus, new THREE.Vector3(20, 5, -4))
      this.cam.position.lerp(side, 0.06)
      this.camLookAt.lerp(focus, 0.12)
    } else {
      // Settle into a third-person trail behind the bike for the handoff.
      const fwd = this.right.set(0, 0, 1) // bike runs +Z on the runoff
      const focus = this.vTmp.copy(this.bike.position).add(new THREE.Vector3(0, 1.6, 0))
      const behind = focus.clone().addScaledVector(fwd, -11).add(new THREE.Vector3(0, 2.4, 0))
      this.cam.position.lerp(behind, 0.07)
      this.camLookAt.lerp(focus, 0.12)
    }
    this.cam.lookAt(this.camLookAt)
  }

  /** A world camera spot `offset` away from `focus` (offset.x = side, y = up, z = back). */
  private camLook(focus: THREE.Vector3, offset: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(focus.x + offset.x, focus.y + offset.y, focus.z - offset.z)
  }

  dispose() {
    this.scene.remove(this.group)
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    this.rb.dispose()
    this.mats.forEach((m) => m.dispose())
  }
}
