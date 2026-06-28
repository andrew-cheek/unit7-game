import * as THREE from 'three'
import { config } from './config'

/**
 * Factory escalators: launch-pad-only set dressing that links each HUMANOID ROBOTS
 * glass tower to the deck with a lit, tread-scrolling escalator, and runs a loop of
 * little Unit-7-style robots riding DOWN it and then either:
 *   - walking to the nearest sky elevator and riding it back UP (delivered to orbit), or
 *   - walking to the rim and PARACHUTING off the side.
 * ...then re-spawning at the top of the escalator to ride down again. Pure visual
 * flavour: it never touches gameplay, physics or the fixed-timestep sim, so motion
 * uses Math.random / Math.sin freely and is fully dt-driven. Nothing feeds
 * determinism.
 *
 * Lifetime: owned by the launch pad (constructed when the pad builds, disposed when
 * it tears down). Everything attaches to the passed-in `parent` (the pad group) in
 * LOCAL deck space — deck at y≈0, centred at the origin, deck radius `opts.radius`.
 */

const PALETTE = [0x49e0ff, 0x9bff6a, 0xffd24a, 0xff5ad0, 0xb07cff, 0xff8a4a]
const PER_ESCALATOR = { high: 3, medium: 2, low: 2 } as const

const STAND_Y = 0.6        // deck standing height (feet on the deck)
const TOP_Y = 12           // escalator top (at the tower base, elevated)
const RIDE_RATE = 0.16     // escalator descent rate (fraction of the ramp per second)
const WALK_SPEED = 3.4     // deck walk speed (local m/s)
const TREADS = 10          // scrolling tread stripes per escalator
const TREAD_SCROLL = 0.16  // tread scroll speed (fraction/sec, downward to match riders)

type WalkState = 'ride' | 'walk' | 'ascend' | 'chute'

interface Esc {
  topX: number; topZ: number   // top of the ramp (tower end)
  botX: number; botZ: number   // bottom of the ramp (on the deck)
  yaw: number                  // facing down-slope (toward the deck centre)
}

interface Walker {
  group: THREE.Group
  canopy: THREE.Object3D
  legL: THREE.Object3D
  legR: THREE.Object3D
  esc: number
  state: WalkState
  s: number        // 0..1 along the escalator (0 top, 1 bottom)
  x: number; y: number; z: number
  tx: number; tz: number
  swayPhase: number
  bob: number
}

export class FactoryEscalator {
  private root = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private escs: Esc[] = []
  private walkers: Walker[] = []
  private treads: { mesh: THREE.Mesh; esc: number; u: number }[] = []
  private radius: number
  private elevators: { x: number; z: number }[]
  private t = 0

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(parent: THREE.Group, opts: { radius: number; towers: [number, number][]; elevators: { x: number; z: number }[] }) {
    this.radius = opts.radius
    this.elevators = opts.elevators
    const tier = config.tier.name

    // Shared geometry for the riders (a simple blocky Unit-7 robot + a small chute).
    const bodyGeo = this.ownG(new THREE.BoxGeometry(0.8, 1.1, 0.5))
    const headGeo = this.ownG(new THREE.BoxGeometry(0.55, 0.5, 0.55))
    const visorGeo = this.ownG(new THREE.BoxGeometry(0.4, 0.12, 0.05))
    const legGeo = this.ownG(new THREE.BoxGeometry(0.2, 0.6, 0.24))
    const canopyGeo = this.ownG(new THREE.ConeGeometry(2.0, 1.0, 12, 1, true))
    const riserGeo = this.ownG(new THREE.BoxGeometry(0.05, 1.5, 0.05))

    const darkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x10151f, metalness: 0.6, roughness: 0.5 }))
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x9fb0c0, metalness: 0.45, roughness: 0.5 }))
    const riserMat = this.own(new THREE.MeshBasicMaterial({ color: 0x33424f, fog: true }))
    // Per-tint emissive head + canopy so the stream reads as a few distinct robots.
    const headMats = PALETTE.map((c) => this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: c, emissiveIntensity: 2.2, roughness: 0.4 })))
    const canopyMats = PALETTE.map((c) => this.own(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))

    // Build one escalator per tower, plus its rider loop.
    const treadMat = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const rampMat = this.own(new THREE.MeshStandardMaterial({ color: 0x141d30, metalness: 0.7, roughness: 0.4, emissive: 0x0a2236, emissiveIntensity: 0.5 }))
    const railMat = this.own(new THREE.MeshStandardMaterial({ color: 0xe6ebf4, metalness: 0.6, roughness: 0.4 }))

    const treadGeo = this.ownG(new THREE.BoxGeometry(3.0, 0.1, 0.55))
    for (let e = 0; e < opts.towers.length; e++) {
      const [tx, tz] = opts.towers[e]
      const len = Math.hypot(tx, tz) || 1
      const dx = tx / len, dz = tz / len           // radial unit vector toward the tower
      // Top sits short of the tower (elevated); bottom lands on the deck inside the rim.
      const top = { x: dx * (this.radius + 8), z: dz * (this.radius + 8) }
      const bot = { x: dx * (this.radius - 7), z: dz * (this.radius - 7) }
      const yaw = Math.atan2(bot.x - top.x, bot.z - top.z) // face down-slope (inward)
      this.escs.push({ topX: top.x, topZ: top.z, botX: bot.x, botZ: bot.z, yaw })
      this.buildRamp(e, top, bot, dx, dz, rampMat, railMat, treadMat, treadGeo)

      const n = PER_ESCALATOR[tier]
      for (let i = 0; i < n; i++) {
        const tint = (e * n + i) % PALETTE.length
        const w = this.makeWalker(bodyGeo, headGeo, visorGeo, legGeo, canopyGeo, riserGeo, bodyMat, darkMat, headMats[tint], canopyMats[tint], riserMat)
        w.esc = e
        this.walkers.push(w)
        this.respawn(w, i / n) // stagger down the ramp so the escalator is already busy
      }
    }

    parent.add(this.root)
  }

  /** The sloped ramp + side rails + scrolling tread stripes for one escalator. */
  private buildRamp(e: number, top: { x: number; z: number }, bot: { x: number; z: number }, dx: number, dz: number, rampMat: THREE.Material, railMat: THREE.Material, treadMat: THREE.Material, treadGeo: THREE.BufferGeometry) {
    const a = new THREE.Vector3(bot.x, STAND_Y, bot.z)
    const b = new THREE.Vector3(top.x, TOP_Y, top.z)
    const slope = new THREE.Vector3().subVectors(b, a)
    const len3 = slope.length()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), slope.clone().normalize())
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
    const perpX = -dz, perpZ = dx // horizontal perpendicular to the radial

    // Incline deck.
    const deck = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(3.2, len3, 0.4)), rampMat)
    deck.quaternion.copy(q); deck.position.copy(mid); this.root.add(deck)
    // Two side rails running up the slope.
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.18, len3, 0.18)), railMat)
      rail.quaternion.copy(q)
      rail.position.set(mid.x + perpX * 1.7 * s, mid.y + 0.5, mid.z + perpZ * 1.7 * s)
      this.root.add(rail)
    }
    // Scrolling tread stripes (animated in update()).
    for (let i = 0; i < TREADS; i++) {
      const tread = new THREE.Mesh(treadGeo, treadMat)
      tread.quaternion.copy(q)
      this.root.add(tread)
      this.treads.push({ mesh: tread, esc: e, u: i / TREADS })
    }
  }

  private makeWalker(bodyGeo: THREE.BufferGeometry, headGeo: THREE.BufferGeometry, visorGeo: THREE.BufferGeometry, legGeo: THREE.BufferGeometry, canopyGeo: THREE.BufferGeometry, riserGeo: THREE.BufferGeometry, bodyMat: THREE.Material, darkMat: THREE.Material, headMat: THREE.Material, canopyMat: THREE.Material, riserMat: THREE.Material): Walker {
    const g = new THREE.Group()
    const body = new THREE.Mesh(bodyGeo, bodyMat); body.position.y = 0.55; g.add(body)
    const head = new THREE.Mesh(headGeo, headMat); head.position.y = 1.35; g.add(head)
    const visor = new THREE.Mesh(visorGeo, headMat); visor.position.set(0, 1.36, 0.28); g.add(visor)
    const legL = new THREE.Mesh(legGeo, darkMat); legL.position.set(-0.2, 0.0, 0); g.add(legL)
    const legR = new THREE.Mesh(legGeo, darkMat); legR.position.set(0.2, 0.0, 0); g.add(legR)
    // Chute (hidden until they step off the rim): a canopy + two risers.
    const canopy = new THREE.Group()
    const dome = new THREE.Mesh(canopyGeo, canopyMat); dome.position.y = 3.0; canopy.add(dome)
    for (const s of [-1, 1]) {
      const riser = new THREE.Mesh(riserGeo, riserMat); riser.position.set(s * 0.35, 1.7, 0); riser.rotation.z = s * 0.16; canopy.add(riser)
    }
    canopy.visible = false
    g.add(canopy)
    this.root.add(g)
    return { group: g, canopy, legL, legR, esc: 0, state: 'ride', s: 0, x: 0, y: 0, z: 0, tx: 0, tz: 0, swayPhase: Math.random() * 6.28, bob: Math.random() * 6.28 }
  }

  /** Send a rider back to the top of its escalator to ride down again. */
  private respawn(w: Walker, startS = 0) {
    w.state = 'ride'
    w.s = startS
    w.canopy.visible = false
    w.group.rotation.set(0, this.escs[w.esc].yaw, 0)
  }

  private nearestElevator(x: number, z: number): { x: number; z: number } {
    let best = this.elevators[0], bd = Infinity
    for (const el of this.elevators) {
      const d = (el.x - x) ** 2 + (el.z - z) ** 2
      if (d < bd) { bd = d; best = el }
    }
    return best
  }

  update(dt: number) {
    this.t += dt
    // Scroll the tread stripes down each ramp.
    for (const tr of this.treads) {
      tr.u = (tr.u - TREAD_SCROLL * dt + 1) % 1
      const e = this.escs[tr.esc]
      const x = THREE.MathUtils.lerp(e.topX, e.botX, tr.u)
      const z = THREE.MathUtils.lerp(e.topZ, e.botZ, tr.u)
      const y = THREE.MathUtils.lerp(TOP_Y, STAND_Y, tr.u) + 0.22
      tr.mesh.position.set(x, y, z)
    }

    for (const w of this.walkers) {
      const e = this.escs[w.esc]
      w.bob += dt * 9

      if (w.state === 'ride') {
        w.s += RIDE_RATE * dt
        w.x = THREE.MathUtils.lerp(e.topX, e.botX, w.s)
        w.z = THREE.MathUtils.lerp(e.topZ, e.botZ, w.s)
        w.y = THREE.MathUtils.lerp(TOP_Y, STAND_Y, w.s)
        w.group.position.set(w.x, w.y, w.z)
        w.group.rotation.set(0, e.yaw, 0)
        this.swingLegs(w, 0.4)
        if (w.s >= 1) {
          // Reached the deck: pick a fate.
          if (Math.random() < 0.5) {
            const el = this.nearestElevator(w.x, w.z)
            w.tx = el.x; w.tz = el.z
            w.state = 'walk'
          } else {
            // Head for the nearest rim point (straight out from here) and step off.
            const len = Math.hypot(w.x, w.z) || 1
            w.tx = (w.x / len) * (this.radius + 12)
            w.tz = (w.z / len) * (this.radius + 12)
            w.state = 'walk'
          }
        }
        continue
      }

      if (w.state === 'walk') {
        const dx = w.tx - w.x, dz = w.tz - w.z
        const d = Math.hypot(dx, dz)
        if (d > 0.01) {
          const step = Math.min(d, WALK_SPEED * dt)
          w.x += (dx / d) * step
          w.z += (dz / d) * step
          w.group.rotation.y = Math.atan2(dx, dz)
        }
        w.y = STAND_Y + Math.abs(Math.sin(w.bob)) * 0.1
        w.group.position.set(w.x, w.y, w.z)
        this.swingLegs(w, 0.6)
        const toElevator = Math.hypot(w.tx, w.tz) < this.radius // elevator targets are inside the rim
        if (toElevator && d < 1.6) { w.state = 'ascend' }
        else if (!toElevator && Math.hypot(w.x, w.z) > this.radius) { w.state = 'chute'; w.canopy.visible = true }
        continue
      }

      if (w.state === 'ascend') {
        // Stepped into the lift: rise straight up, then loop back to the escalator.
        w.y += 6 * dt
        w.group.position.set(w.x, w.y, w.z)
        if (w.y > TOP_Y + 12) this.respawn(w)
        continue
      }

      // chute: drift down past the deck edge under the canopy, then re-drop.
      w.y -= 3.6 * dt
      const sway = Math.sin(this.t * 1.2 + w.swayPhase) * (config.reducedMotion ? 0.4 : 1.1)
      const len = Math.hypot(w.x, w.z) || 1
      const px = -w.z / len, pz = w.x / len // tangent for a gentle sway as they fall
      w.group.position.set(w.x + px * sway, w.y, w.z + pz * sway)
      w.group.rotation.z = config.reducedMotion ? 0 : Math.sin(this.t * 1.2 + w.swayPhase) * 0.1
      if (w.y < -28) { w.group.rotation.z = 0; this.respawn(w) }
    }
  }

  /** Alternate leg swing to sell the walk/ride without a full rig. */
  private swingLegs(w: Walker, amp: number) {
    const s = Math.sin(w.bob) * amp
    w.legL.rotation.x = s
    w.legR.rotation.x = -s
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root)
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.geos.length = 0; this.mats.length = 0
    this.walkers.length = 0; this.treads.length = 0; this.escs.length = 0
  }
}
