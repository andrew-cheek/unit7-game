import * as THREE from 'three'
import { config } from './config'
import { createRobot, type RobotModel } from './procedural'

/**
 * Factory escalators: a walkable, properly-built escalator running from each
 * HUMANOID ROBOTS tower down to the deck, with a loop of real Unit-7 robots riding
 * DOWN it and then either walking to the nearest sky elevator and riding it UP, or
 * walking to the rim and PARACHUTING off the side.
 *
 * The player can WALK UP it too: the incline + top landing register as ground
 * surfaces (groundMeshes) and the launch pad's step-off test exempts the walkway
 * (onWalkway), so you climb up onto the factory floor instead of falling.
 *
 * Lifetime: owned by the launch pad (built when the pad builds, disposed with it).
 * Everything is LOCAL to the passed-in `parent` (the pad group) — deck at y≈0,
 * centred at the origin, deck radius `opts.radius`. The pad has no yaw, so local
 * XZ equals world-minus-centre (the step-off test relies on that).
 */

const PALETTE = [0x49e0ff, 0x9bff6a, 0xffd24a, 0xff5ad0, 0xb07cff, 0xff8a4a]
const PER_ESCALATOR = { high: 3, medium: 2, low: 2 } as const

const DECK_Y = 0.6         // deck standing height
const TOP_Y = 10           // factory-floor landing height
const WALK_SPEED = 3.4
const HALF_W = 2.4         // escalator / landing half width
const STEPS = 16           // visual tread count

type WalkState = 'ride' | 'walk' | 'ascend' | 'chute'

interface Esc {
  dx: number; dz: number        // radial unit vector toward the tower
  px: number; pz: number        // horizontal perpendicular (across the steps)
  rampR0: number; rampR1: number; landR1: number // radial extents
}

interface Walker {
  model: RobotModel
  group: THREE.Group
  canopy: THREE.Object3D
  esc: number
  state: WalkState
  s: number
  x: number; y: number; z: number
  tx: number; tz: number
  swayPhase: number
}

export class FactoryEscalator {
  private root = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private escs: Esc[] = []
  private walkers: Walker[] = []
  private rails: { mat: THREE.MeshBasicMaterial; ph: number }[] = []
  private radius: number
  private elevators: { x: number; z: number }[]
  private t = 0
  /** Slope + landing surfaces the player can stand on (registered as ground meshes). */
  readonly groundMeshes: THREE.Mesh[] = []

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(parent: THREE.Group, opts: { radius: number; towers: [number, number][]; elevators: { x: number; z: number }[] }) {
    this.radius = opts.radius
    this.elevators = opts.elevators
    const tier = config.tier.name

    const stepMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2740, metalness: 0.6, roughness: 0.45, emissive: 0x0c2236, emissiveIntensity: 0.4 }))
    const edgeMat = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, fog: false })) // glowing step nosings
    const sideMat = this.own(new THREE.MeshStandardMaterial({ color: 0x121a2c, metalness: 0.7, roughness: 0.4, emissive: 0x0a1830, emissiveIntensity: 0.4 }))
    const glassMat = this.own(new THREE.MeshStandardMaterial({ color: 0x8fd6ff, metalness: 0.2, roughness: 0.1, transparent: true, opacity: 0.18, side: THREE.DoubleSide, emissive: 0x2a6ea0, emissiveIntensity: 0.25 }))
    const landMat = this.own(new THREE.MeshStandardMaterial({ color: 0x16203a, metalness: 0.55, roughness: 0.5, emissive: 0x0c2236, emissiveIntensity: 0.5 }))
    const trimMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd24a, fog: false }))
    const invis = this.own(new THREE.MeshBasicMaterial({ visible: false }))

    for (let e = 0; e < opts.towers.length; e++) {
      const [tx, tz] = opts.towers[e]
      const len = Math.hypot(tx, tz) || 1
      const dx = tx / len, dz = tz / len
      const px = -dz, pz = dx
      const rampR0 = this.radius - 4   // bottom, on the deck
      const rampR1 = this.radius + 9   // top of the incline
      const landR1 = this.radius + 19  // outer edge of the factory-floor landing
      this.escs.push({ dx, dz, px, pz, rampR0, rampR1, landR1 })
      this.buildEscalator(e, { dx, dz, px, pz, rampR0, rampR1, landR1 }, stepMat, edgeMat, sideMat, glassMat, landMat, trimMat, invis)

      const n = PER_ESCALATOR[tier]
      for (let i = 0; i < n; i++) {
        const w = this.makeWalker(PALETTE[(e * n + i) % PALETTE.length])
        w.esc = e
        this.walkers.push(w)
        this.respawn(w, i / n)
      }
    }

    parent.add(this.root)
  }

  /** Build one escalator: a smooth ground ramp (collider) under stepped treads,
   *  glass balustrades with glowing handrails, and a factory-floor landing. */
  private buildEscalator(e: number, esc: Esc, stepMat: THREE.Material, edgeMat: THREE.Material, sideMat: THREE.Material, glassMat: THREE.Material, landMat: THREE.Material, trimMat: THREE.Material, invis: THREE.Material) {
    const { dx, dz, px, pz, rampR0, rampR1, landR1 } = esc
    const a = new THREE.Vector3(dx * rampR0, DECK_Y, dz * rampR0)        // ramp bottom (deck)
    const b = new THREE.Vector3(dx * rampR1, TOP_Y, dz * rampR1)         // ramp top
    const slope = new THREE.Vector3().subVectors(b, a)
    const len3 = slope.length()
    const zAxis = slope.clone().normalize()
    const xAxis = new THREE.Vector3(px, 0, pz)
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize()
    const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)
    const q = new THREE.Quaternion().setFromRotationMatrix(basis)
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)

    // Smooth incline COLLIDER (top face is the walkable slope). Visible but dark.
    const ramp = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(HALF_W * 2, 0.5, len3)), stepMat)
    ramp.quaternion.copy(q); ramp.position.copy(mid).addScaledVector(yAxis, -0.25)
    this.root.add(ramp); this.groundMeshes.push(ramp)

    // Stepped treads riding the slope (glowing front nosings) for the escalator look.
    const treadGeo = this.ownG(new THREE.BoxGeometry(HALF_W * 2 - 0.2, 0.16, len3 / STEPS * 0.92))
    const noseGeo = this.ownG(new THREE.BoxGeometry(HALF_W * 2 - 0.2, 0.06, 0.08))
    for (let i = 0; i < STEPS; i++) {
      const f = (i + 0.5) / STEPS
      const p = new THREE.Vector3().lerpVectors(a, b, f).addScaledVector(yAxis, 0.28)
      const tread = new THREE.Mesh(treadGeo, sideMat); tread.quaternion.copy(q); tread.position.copy(p); this.root.add(tread)
      const nose = new THREE.Mesh(noseGeo, edgeMat); nose.quaternion.copy(q)
      nose.position.copy(p).addScaledVector(zAxis, -len3 / STEPS * 0.46).addScaledVector(yAxis, 0.08); this.root.add(nose)
    }

    // Glass balustrades with a bright handrail running up each side.
    const railGeo = this.ownG(new THREE.BoxGeometry(0.16, 0.16, len3 + 1.2))
    const panelGeo = this.ownG(new THREE.BoxGeometry(0.12, 1.5, len3))
    for (const s of [-1, 1]) {
      const off = new THREE.Vector3(px * (HALF_W - 0.1) * s, 0, pz * (HALF_W - 0.1) * s)
      const panel = new THREE.Mesh(panelGeo, glassMat); panel.quaternion.copy(q)
      panel.position.copy(mid).add(off).addScaledVector(yAxis, 0.75); this.root.add(panel)
      const railMat = this.own(new THREE.MeshBasicMaterial({ color: PALETTE[e % PALETTE.length], fog: false }))
      const rail = new THREE.Mesh(railGeo, railMat); rail.quaternion.copy(q)
      rail.position.copy(mid).add(off).addScaledVector(yAxis, 1.5); this.root.add(rail)
      this.rails.push({ mat: railMat, ph: e * 1.7 + (s > 0 ? 1 : 0) })
    }

    // Bottom landing pad (flush with the deck) so stepping on/off reads cleanly.
    const botGeo = this.ownG(new THREE.BoxGeometry(HALF_W * 2 + 1.5, 0.3, 3))
    const bot = new THREE.Mesh(botGeo, landMat)
    bot.position.set(dx * (rampR0 - 1), DECK_Y - 0.15, dz * (rampR0 - 1))
    bot.rotation.y = Math.atan2(dx, dz); this.root.add(bot)

    // Factory-floor LANDING at the top: a walkable platform (collider) with a
    // glowing rim + a doorway frame reading as the way into the glass plant.
    const landLen = landR1 - rampR1 + 3
    const landMidR = (rampR1 + landR1) / 2
    const landing = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(HALF_W * 2 + 4, 0.5, landLen)), landMat)
    landing.position.set(dx * landMidR, TOP_Y - 0.25, dz * landMidR)
    landing.rotation.y = Math.atan2(dx, dz)
    this.root.add(landing); this.groundMeshes.push(landing)
    // Glowing landing rim.
    const rim = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(HALF_W * 2 + 4, 0.1, 0.2)), trimMat)
    rim.position.set(dx * rampR1, TOP_Y + 0.05, dz * rampR1); rim.rotation.y = Math.atan2(dx, dz); this.root.add(rim)
    // Doorway frame at the far edge (into the tower).
    const doorR = landR1 + 0.5
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 5, 0.4)), sideMat)
      post.position.set(dx * doorR + px * (HALF_W + 1.4) * s, TOP_Y + 2.5, dz * doorR + pz * (HALF_W + 1.4) * s); this.root.add(post)
    }
    const lintel = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(HALF_W * 2 + 3.2, 0.5, 0.5)), trimMat)
    lintel.position.set(dx * doorR, TOP_Y + 5, dz * doorR); lintel.rotation.y = Math.atan2(dx, dz); this.root.add(lintel)
    // Side guard panels along the landing so you don't stroll off the edges.
    for (const s of [-1, 1]) {
      const guard = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.2, 1.4, landLen)), invis)
      guard.position.set(dx * landMidR + px * (HALF_W + 1.9) * s, TOP_Y + 0.7, dz * landMidR + pz * (HALF_W + 1.9) * s)
      guard.rotation.y = Math.atan2(dx, dz); this.root.add(guard)
    }
  }

  private makeWalker(tint: number): Walker {
    const model = createRobot({ trim: tint, accent: tint })
    const g = new THREE.Group()
    g.add(model.group)
    // Cut-away chute (shown only when they step off the rim).
    const canopy = new THREE.Group()
    const dome = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(2.0, 1.0, 12, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    dome.position.y = 3.2; canopy.add(dome)
    for (const s of [-1, 1]) {
      const riser = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.05, 1.6, 0.05)), this.own(new THREE.MeshBasicMaterial({ color: 0x9fb0c8, transparent: true, opacity: 0.5, fog: false })))
      riser.position.set(s * 0.4, 1.9, 0); riser.rotation.z = s * 0.16; canopy.add(riser)
    }
    canopy.visible = false
    g.add(canopy)
    this.root.add(g)
    return { model, group: g, canopy, esc: 0, state: 'ride', s: 0, x: 0, y: 0, z: 0, tx: 0, tz: 0, swayPhase: Math.random() * 6.28 }
  }

  private respawn(w: Walker, startS = 0) {
    w.state = 'ride'
    w.s = startS
    w.canopy.visible = false
    w.model.setFlyPose(0); w.model.setWings(0)
  }

  private nearestElevator(x: number, z: number): { x: number; z: number } {
    let best = this.elevators[0], bd = Infinity
    for (const el of this.elevators) { const d = (el.x - x) ** 2 + (el.z - z) ** 2; if (d < bd) { bd = d; best = el } }
    return best
  }

  /** Is local (x,z) over a walkable escalator surface (ramp or landing)? Used by the
   *  launch pad to exempt the walkway from the off-the-edge fall test. */
  onWalkway(x: number, z: number): boolean {
    for (const e of this.escs) {
      const along = x * e.dx + z * e.dz          // radial coordinate toward the tower
      const perp = Math.abs(x * e.px + z * e.pz) // across the steps
      if (along > e.rampR0 - 1.5 && along < e.landR1 + 1 && perp < HALF_W + 0.6) return true
    }
    return false
  }

  update(dt: number) {
    this.t += dt
    // Pulse the handrail glow.
    for (let i = 0; i < this.rails.length; i++) {
      const r = this.rails[i]
      const k = 0.55 + 0.45 * Math.sin(this.t * 2 + r.ph)
      r.mat.color.setHex(PALETTE[Math.floor(i / 2) % PALETTE.length]).multiplyScalar(k)
    }

    for (const w of this.walkers) {
      const e = this.escs[w.esc]

      if (w.state === 'ride') {
        w.s += 0.16 * dt
        const r = THREE.MathUtils.lerp(e.rampR1, e.rampR0, w.s)
        w.x = e.dx * r; w.z = e.dz * r
        w.y = THREE.MathUtils.lerp(TOP_Y, DECK_Y, w.s) + 0.05
        w.group.position.set(w.x, w.y, w.z)
        w.group.rotation.y = Math.atan2(-e.dx, -e.dz) // face down the slope (toward the deck centre)
        w.model.update(dt, 0.45, true)
        if (w.s >= 1) {
          if (Math.random() < 0.5) { const el = this.nearestElevator(w.x, w.z); w.tx = el.x; w.tz = el.z }
          else { const len = Math.hypot(w.x, w.z) || 1; w.tx = (w.x / len) * (this.radius + 12); w.tz = (w.z / len) * (this.radius + 12) }
          w.state = 'walk'
        }
        continue
      }

      if (w.state === 'walk') {
        const dx = w.tx - w.x, dz = w.tz - w.z
        const d = Math.hypot(dx, dz)
        if (d > 0.01) { const step = Math.min(d, WALK_SPEED * dt); w.x += (dx / d) * step; w.z += (dz / d) * step; w.group.rotation.y = Math.atan2(dx, dz) }
        w.y = DECK_Y
        w.group.position.set(w.x, w.y, w.z)
        w.model.update(dt, 0.6, true)
        const toElevator = Math.hypot(w.tx, w.tz) < this.radius
        if (toElevator && d < 1.6) w.state = 'ascend'
        else if (!toElevator && Math.hypot(w.x, w.z) > this.radius) { w.state = 'chute'; w.canopy.visible = true; w.model.setFlyPose(1); w.model.setWings(1) }
        continue
      }

      if (w.state === 'ascend') {
        w.y += 6 * dt
        w.group.position.set(w.x, w.y, w.z)
        w.model.update(dt, 0, true)
        if (w.y > TOP_Y + 12) this.respawn(w)
        continue
      }

      // chute off the rim
      w.y -= 3.6 * dt
      const sway = Math.sin(this.t * 1.2 + w.swayPhase) * (config.reducedMotion ? 0.4 : 1.1)
      const len = Math.hypot(w.x, w.z) || 1
      const px = -w.z / len, pz = w.x / len
      w.group.position.set(w.x + px * sway, w.y, w.z + pz * sway)
      w.group.rotation.z = config.reducedMotion ? 0 : Math.sin(this.t * 1.2 + w.swayPhase) * 0.1
      w.model.update(dt, 0, false)
      if (w.y < -28) { w.group.rotation.z = 0; this.respawn(w) }
    }
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root)
    for (const w of this.walkers) w.model.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.geos.length = 0; this.mats.length = 0
    this.walkers.length = 0; this.escs.length = 0; this.rails.length = 0
    this.groundMeshes.length = 0
  }
}
