import * as THREE from 'three'
import { config } from './config'
import { createBigShip, createSmallShip, type VehicleModel } from './procedural'
import { randRange } from './utils'

interface SmallShip {
  model: VehicleModel
  cx: number
  cz: number
  rx: number
  rz: number
  y: number
  theta: number
  speed: number
}

/**
 * Sky traffic: a handful of small ships flying steady loops weaving between the
 * towers, each trailing a glowing engine plume, plus an occasional big capital
 * ship that crosses the whole skyline. Parametric paths (no physics) so it's
 * cheap and never collides. Runs on Earth and Mars; counts from `config.city`.
 */
export class Sky {
  private scene: THREE.Scene
  private group = new THREE.Group()
  private ships: SmallShip[] = []
  private big: VehicleModel
  private bigTrailMat: THREE.MeshBasicMaterial
  private bigActive = false
  private bigTimer = config.city.bigShipInterval
  private bigFrom = new THREE.Vector3()
  private bigTo = new THREE.Vector3()
  private bigT = 0

  // Elevated winding "cyber highway" + the cars racing along it.
  private hwSamples: { p: THREE.Vector3; tan: THREE.Vector3 }[] = []
  // Cars are GPU-instanced: per-car motion state is plain data; each frame we
  // build the car's world matrix and write the 4 parts via setMatrixAt.
  private hwCars: { t: number; speed: number; lane: number }[] = []
  private carBody!: THREE.InstancedMesh
  private carCabin!: THREE.InstancedMesh
  private carHead!: THREE.InstancedMesh
  private carTail!: THREE.InstancedMesh
  // Local part offsets relative to the car origin (body sits at origin).
  private readonly carPartOffset = {
    body: new THREE.Vector3(0, 0, 0),
    cabin: new THREE.Vector3(0, 0.5, -0.2),
    head: new THREE.Vector3(0, 0, 1.75),
    tail: new THREE.Vector3(0, 0, -1.75),
  }
  private hwRight = new THREE.Vector3() // per-frame scratch, hoisted out of updateHighway
  private readonly hwUp = new THREE.Vector3(0, 1, 0)
  // Per-frame scratch for instanced-car matrix composition (no allocation in update).
  private carMat = new THREE.Matrix4()
  private partMat = new THREE.Matrix4()
  private carQuat = new THREE.Quaternion()
  private carPos = new THREE.Vector3()
  private carScale = new THREE.Vector3(1, 1, 1)
  private carLook = new THREE.Vector3()
  private extraMats: THREE.Material[] = []
  private extraGeos: THREE.BufferGeometry[] = []

  constructor(scene: THREE.Scene, densityScale: number) {
    this.scene = scene
    scene.add(this.group)

    const n = Math.round(config.city.smallShips * densityScale)
    const accents = [config.palette.cyan, config.palette.magenta, config.palette.orange, config.palette.lime]
    for (let i = 0; i < n; i++) {
      const model = createSmallShip(accents[i % accents.length])
      // A glowing engine trail streaming behind (additive, static to the ship).
      const trailMat = new THREE.MeshBasicMaterial({ color: accents[i % accents.length], transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      const trail = new THREE.Mesh(new THREE.ConeGeometry(0.4, 4.5, 10, 1, true), trailMat)
      trail.rotation.x = -Math.PI / 2 // taper backward along -Z
      trail.position.z = -3.5
      model.group.add(trail)
      this.group.add(model.group)
      this.ships.push({
        model,
        cx: randRange(-120, 120),
        cz: randRange(-120, 120),
        rx: randRange(40, 110),
        rz: randRange(40, 110),
        y: randRange(24, 64),
        theta: randRange(0, Math.PI * 2),
        speed: randRange(0.12, 0.3) * (i % 2 ? 1 : -1),
      })
    }

    this.big = createBigShip()
    this.big.group.visible = false
    this.bigTrailMat = new THREE.MeshBasicMaterial({ color: config.palette.cyan, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const bigTrail = new THREE.Mesh(new THREE.ConeGeometry(2.2, 30, 14, 1, true), this.bigTrailMat)
    bigTrail.rotation.x = -Math.PI / 2
    bigTrail.position.z = -26
    this.big.group.add(bigTrail)
    this.group.add(this.big.group)

    this.buildHighway(densityScale)
  }

  /**
   * A winding elevated highway high over the city with cars racing along it.
   * The deck is translucent neon so you can see the bright cars zipping through
   * it. A closed Catmull-Rom loop is pre-sampled once; cars just index along the
   * sample table each frame (cheap - no per-frame curve math).
   */
  private buildHighway(densityScale: number) {
    const ownM = <T extends THREE.Material>(m: T) => { this.extraMats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(g: T) => { this.extraGeos.push(g); return g }

    // Winding control loop, high in the sky, with rolling height for a "cool"
    // undulating road.
    const ctrl: THREE.Vector3[] = []
    const N = 9
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2
      const r = 140 + Math.sin(a * 3) * 50 // weaves in and out
      const y = 24 + Math.sin(a * 2) * 8 // lower, near the rooftops so it reads clearly
      ctrl.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r))
    }
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'catmullrom', 0.5)

    // Pre-sample positions + tangents.
    const S = 360
    for (let i = 0; i < S; i++) {
      const t = i / S
      this.hwSamples.push({ p: curve.getPointAt(t), tan: curve.getTangentAt(t) })
    }

    // Wider, more solid deck so the road is unmistakable.
    const deck = new THREE.Mesh(
      ownG(new THREE.TubeGeometry(curve, S, 4.5, 4, true)),
      ownM(new THREE.MeshBasicMaterial({ color: 0x1a2c4e, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, fog: false })),
    )
    this.group.add(deck)
    // Brighter, thicker glowing edge rails.
    for (const off of [-4.4, 4.4]) {
      const railPts = this.hwSamples.map((s) => {
        const right = new THREE.Vector3().crossVectors(s.tan, new THREE.Vector3(0, 1, 0)).normalize()
        return s.p.clone().addScaledVector(right, off)
      })
      const rail = new THREE.Mesh(
        ownG(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts, true), S, 0.6, 6, true)),
        ownM(new THREE.MeshBasicMaterial({ color: off < 0 ? 0x27e7ff : 0xff2bd0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })),
      )
      this.group.add(rail)
    }
    // A faint centre line for the "two-lane road" read.
    const centrePts = this.hwSamples.map((s) => s.p.clone().setY(s.p.y + 0.2))
    const centre = new THREE.Mesh(
      ownG(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(centrePts, true), S, 0.12, 5, true)),
      ownM(new THREE.MeshBasicMaterial({ color: 0xffe79a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })),
    )
    this.group.add(centre)

    // Shared car geometries so all cars are cheap to build.
    const bodyGeo = ownG(new THREE.BoxGeometry(1.7, 0.55, 3.4))
    const cabinGeo = ownG(new THREE.BoxGeometry(1.3, 0.5, 1.6))
    const lightGeo = ownG(new THREE.BoxGeometry(1.5, 0.18, 0.18))
    const bodyColors = [0x9bff4d, 0xffffff, 0xffd27f, 0x7fd8ff, 0xff7fb0, 0xb89bff]
    const count = Math.round(30 * densityScale)

    // GPU-instanced car fleet: one InstancedMesh per part (body/cabin/head/tail),
    // each with `count` instances. Body color varies per-instance via setColorAt;
    // cabin/head/tail share a single material color. All additive/fog-free so
    // they glow through the translucent deck, exactly as the per-mesh cars did.
    const bodyMat = ownM(new THREE.MeshBasicMaterial({ fog: false }))
    const cabinMat = ownM(new THREE.MeshBasicMaterial({ color: 0x0c1830, transparent: true, opacity: 0.85, fog: false }))
    const headMat = ownM(new THREE.MeshBasicMaterial({ color: 0xffffe0, blending: THREE.AdditiveBlending, fog: false, transparent: true }))
    const tailMat = ownM(new THREE.MeshBasicMaterial({ color: 0xff3030, blending: THREE.AdditiveBlending, fog: false, transparent: true }))

    this.carBody = new THREE.InstancedMesh(bodyGeo, bodyMat, count)
    this.carCabin = new THREE.InstancedMesh(cabinGeo, cabinMat, count)
    this.carHead = new THREE.InstancedMesh(lightGeo, headMat, count)
    this.carTail = new THREE.InstancedMesh(lightGeo, tailMat, count)

    // The highway is a bounded elevated ring generally in view; disabling
    // frustum culling avoids per-instance bounds popping the whole fleet.
    for (const im of [this.carBody, this.carCabin, this.carHead, this.carTail]) {
      im.frustumCulled = false
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(im)
    }

    const tmpColor = new THREE.Color()
    for (let i = 0; i < count; i++) {
      // Per-instance body color (cabin/head/tail share their material color).
      this.carBody.setColorAt(i, tmpColor.setHex(bodyColors[i % bodyColors.length]))
      // Spread across both lanes; same motion state as before, now plain data.
      this.hwCars.push({ t: i / count, speed: 0.05 + Math.random() * 0.05, lane: (i % 2 ? 1 : -1) * 2.0 })
    }
    if (this.carBody.instanceColor) this.carBody.instanceColor.needsUpdate = true
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  update(dt: number) {
    if (!this.group.visible) return
    for (const s of this.ships) {
      s.theta += s.speed * dt
      const x = s.cx + Math.cos(s.theta) * s.rx
      const z = s.cz + Math.sin(s.theta) * s.rz
      const y = s.y + Math.sin(s.theta * 2) * 4
      s.model.group.position.set(x, y, z)
      // Face along the path tangent, with a little bank into the turn.
      const dx = -Math.sin(s.theta) * s.rx * s.speed
      const dz = Math.cos(s.theta) * s.rz * s.speed
      s.model.group.rotation.set(0, Math.atan2(dx, dz), Math.sign(s.speed) * 0.3)
      s.model.update(dt, 1)
    }
    this.updateBig(dt)
    this.updateHighway(dt)
  }

  private updateHighway(dt: number) {
    const S = this.hwSamples.length
    if (S === 0) return
    const right = this.hwRight
    const offs = this.carPartOffset
    let i = 0
    for (const c of this.hwCars) {
      c.t = (c.t + c.speed * dt) % 1
      const s = this.hwSamples[Math.floor(c.t * S) % S]
      // Car origin: highway point + lane offset, riding on top of the deck.
      right.crossVectors(s.tan, this.hwUp).normalize()
      this.carPos.copy(s.p).addScaledVector(right, c.lane)
      this.carPos.y += 0.55
      // Heading: replicate the old `lookAt(pos + tan)` exactly. Object3D.lookAt
      // builds Matrix4.lookAt(eye, target, up) (eye=pos, up=+Y) then derives the
      // quaternion from it, orienting the car's +Z along the tangent.
      this.carLook.copy(this.carPos).add(s.tan)
      this.carMat.lookAt(this.carPos, this.carLook, this.hwUp)
      this.carQuat.setFromRotationMatrix(this.carMat)
      this.carMat.compose(this.carPos, this.carQuat, this.carScale)
      // Write each part: partWorld = carMatrix x translate(partLocalOffset).
      // `partMat` is a scratch translation matrix reused for every part.
      this.carBody.setMatrixAt(i, this.composePart(offs.body))
      this.carCabin.setMatrixAt(i, this.composePart(offs.cabin))
      this.carHead.setMatrixAt(i, this.composePart(offs.head))
      this.carTail.setMatrixAt(i, this.composePart(offs.tail))
      i++
    }
    this.carBody.instanceMatrix.needsUpdate = true
    this.carCabin.instanceMatrix.needsUpdate = true
    this.carHead.instanceMatrix.needsUpdate = true
    this.carTail.instanceMatrix.needsUpdate = true
  }

  /**
   * Compose a single car-part world matrix = carMat x translate(offset), using
   * only hoisted scratch (`partMat`) so no allocation happens per frame.
   * Returns the shared `partMat`; consume it (setMatrixAt) before the next call.
   */
  private composePart(offset: THREE.Vector3): THREE.Matrix4 {
    this.partMat.identity().setPosition(offset)
    return this.partMat.premultiply(this.carMat)
  }

  private updateBig(dt: number) {
    if (!this.bigActive) {
      this.bigTimer -= dt
      if (this.bigTimer <= 0) {
        // Cross the sky from one edge to the other, high overhead.
        const y = randRange(120, 165)
        const side = Math.random() < 0.5
        const off = randRange(-120, 120)
        this.bigFrom.set(side ? -340 : off, y, side ? off : -340)
        this.bigTo.set(side ? 340 : off, y, side ? off : 340)
        this.big.group.position.copy(this.bigFrom)
        this.big.group.lookAt(this.bigTo)
        this.big.group.visible = true
        this.bigActive = true
        this.bigT = 0
      }
      return
    }
    this.bigT += dt * 0.05 // slow, majestic pass
    this.big.group.position.lerpVectors(this.bigFrom, this.bigTo, this.bigT)
    // reducedMotion: slow the 20 rad/s trail pulse to a gentle 2.5 rad/s, lower amplitude.
    this.bigTrailMat.opacity = config.reducedMotion
      ? 0.25 + Math.sin(this.bigT * 2.5) * 0.03
      : 0.25 + Math.sin(this.bigT * 20) * 0.06
    if (this.bigT >= 1) {
      this.big.group.visible = false
      this.bigActive = false
      this.bigTimer = config.city.bigShipInterval
    }
  }

  /** Small-ship + active big-ship positions for the radar. */
  forEach(fn: (x: number, z: number) => void) {
    for (const s of this.ships) fn(s.model.group.position.x, s.model.group.position.z)
    if (this.bigActive) fn(this.big.group.position.x, this.big.group.position.z)
  }

  dispose() {
    for (const s of this.ships) s.model.dispose()
    this.big.dispose()
    this.bigTrailMat.dispose()
    // Instanced car parts: geometries/materials are owned via extraGeos/extraMats
    // below; here we free each InstancedMesh's instance buffers.
    this.carBody.dispose()
    this.carCabin.dispose()
    this.carHead.dispose()
    this.carTail.dispose()
    this.extraMats.forEach((m) => m.dispose())
    this.extraGeos.forEach((g) => g.dispose())
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      // Dispose every traversed geometry, not just transparent-material meshes:
      // opaque parts (e.g. the highway deck/rails) were leaking their geometry.
      // BufferGeometry.dispose() is idempotent, so geometries already freed via
      // extraGeos above are safely re-disposed here without harm.
      if (m.geometry) m.geometry.dispose()
    })
    this.scene.remove(this.group)
  }
}
