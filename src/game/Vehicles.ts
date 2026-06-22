import * as THREE from 'three'
import { config } from './config'
import { createHovercar, createSpaceship, createRocket, createSpeederBike, createMechSuit, createBus, type VehicleModel } from './procedural'
import { damp } from './utils'
import type { Input } from './Input'
import type { Physics } from './Physics'
import type { Zone } from './types'

export type VehicleKind = 'hovercar' | 'speeder' | 'spaceship' | 'rocket' | 'mechM' | 'mechL' | 'mechXL' | 'titan' | 'tram'
type DriveMode = 'hover' | 'fly' | 'rocket' | 'rail'

export interface Vehicle {
  kind: VehicleKind
  name: string
  model: VehicleModel
  position: THREE.Vector3
  velocity: THREE.Vector3
  yaw: number
  radius: number
  hoverHeight: number
  drive: DriveMode
  bob: number
  size: number // model scale (1 for non-mechs); used for camera + muzzle height
  morph: number // mech transform 0=robot .. 1=jet form (eased)
  morphTarget: number
  home: THREE.Vector3 // Earth parking spot (restored on return)
  wander: boolean // titans that roam the outskirts when not piloted
  wanderTurn: number // current idle turn timer
  path?: THREE.Vector3[] // waypoint loop for rail vehicles (the tram)
  pathIdx: number
  railStop: number // dwell timer at the current stop
}

// Where the mechs line up relative to spawn when taken to another world.
const OFFWORLD_MECH_OFFSET: Record<string, THREE.Vector3> = {
  mechM: new THREE.Vector3(-14, 0, 8),
  mechL: new THREE.Vector3(8, 0, 16),
  mechXL: new THREE.Vector3(48, 0, 48),
}

export const isMech = (k: VehicleKind) => k === 'mechM' || k === 'mechL' || k === 'mechXL'
// Walkers stand on the ground, board from a wide radius and drive like mechs.
// Titans are walkers but free to pilot (no unlock) and roam on their own.
const isWalker = (k: VehicleKind) => isMech(k) || k === 'titan'

const approach = (c: number, t: number, m: number) => (c < t ? Math.min(c + m, t) : Math.max(c - m, t))
const UP = new THREE.Vector3(0, 1, 0)

/**
 * Owns the three distinct vehicles, proximity entry, and driving. The hovercar
 * (drive: 'hover') follows the ground raycast and aligns its pitch to the slope
 * normal, so it climbs ramps just like the player. The spaceship (drive: 'fly')
 * ignores terrain and controls altitude directly. The rocket is enter-to-launch
 * (wired to zone travel in Stage 6).
 */
export class Vehicles {
  readonly list: Vehicle[] = []
  current: Vehicle | null = null
  onEnterRocket: ((rocket: Vehicle) => void) | null = null

  private scene: THREE.Scene
  private physics: Physics
  private speed01 = 0
  // scratch
  private fwd = new THREE.Vector3()
  private right = new THREE.Vector3()
  private mat = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private rollQ = new THREE.Quaternion()

  constructor(scene: THREE.Scene, physics: Physics) {
    this.scene = scene
    this.physics = physics
    // Parked right by the player spawn so there's an obvious car to hop into
    // straight after the intro.
    this.spawn('hovercar', createHovercar(), new THREE.Vector3(6, 0, 8), config.vehicle.hovercar.hoverHeight, 1.7, 'hover')
    // A speeder bike parked just the other side of the spawn for fast travel.
    this.spawn('speeder', createSpeederBike(), new THREE.Vector3(-6, 0, 8), config.vehicle.speeder.hoverHeight, 1.1, 'hover')
    this.spawn('spaceship', createSpaceship(), new THREE.Vector3(-22, 0, 20), config.vehicle.spaceship.hoverHeight, 2.8, 'fly')
    // A little spaceport: three rideable rockets of different size + shape lined
    // up behind spawn. Board any one (G) to ride it to the next world; on arrival
    // it self-lands SpaceX-style on the pad. They're present on every world.
    this.spawn('rocket', createRocket({ scale: 2.4, flaps: true, hull: 0xd8dee8, accent: 0x27e7ff }), new THREE.Vector3(-14, 0, -24), 0, 3.0, 'rocket', 1.2)
    this.spawn('rocket', createRocket({ scale: 3.0, hull: 0xb8c0cc, accent: config.palette.orange }), new THREE.Vector3(2, 0, -26), 0, 3.6, 'rocket', 1.5)
    this.spawn('rocket', createRocket({ scale: 1.7, hull: 0xc8ccd6, accent: 0xff4d6d }), new THREE.Vector3(16, 0, -24), 0, 2.4, 'rocket', 0.9)
    // Extra rides scattered across the (now much larger) city so exploring always
    // turns up something to hop into. Earth-only, like the other cars.
    const hh = config.vehicle.hovercar.hoverHeight, sh = config.vehicle.speeder.hoverHeight
    const extras: Array<['hovercar' | 'speeder', number, number]> = [
      ['hovercar', -118, 64], ['speeder', 96, -92], ['hovercar', 150, 118],
      ['speeder', -150, -44], ['hovercar', -64, -150], ['speeder', 132, 34],
    ]
    for (const [kind, x, z] of extras) {
      const model = kind === 'speeder' ? createSpeederBike() : createHovercar()
      this.spawn(kind, model, new THREE.Vector3(x, 0, z), kind === 'speeder' ? sh : hh, kind === 'speeder' ? 1.1 : 1.7, 'hover')
    }
    // A rideable transit tram that auto-loops the avenues and pauses at stops.
    // Board it (G) to ride hands-free around the city; hop off (G) anywhere.
    const loop = [
      new THREE.Vector3(72, 0, 36), new THREE.Vector3(72, 0, -36), new THREE.Vector3(36, 0, -72),
      new THREE.Vector3(-36, 0, -72), new THREE.Vector3(-72, 0, -36), new THREE.Vector3(-72, 0, 36),
      new THREE.Vector3(-36, 0, 72), new THREE.Vector3(36, 0, 72),
    ]
    const tram = this.spawn('tram', createBus(), loop[0].clone(), 1.4, 3.0, 'rail')
    tram.path = loop
    tram.home.copy(loop[0])
    // Drivable cars sitting up on the elevated highway (deck at z=-36, y~9).
    // sampleGround in spawn() lands them on the deck surface.
    this.spawn('hovercar', createHovercar(), new THREE.Vector3(-20, 0, -36), config.vehicle.hovercar.hoverHeight, 1.7, 'hover')
    this.spawn('hovercar', createHovercar(), new THREE.Vector3(20, 0, -36), config.vehicle.hovercar.hoverHeight, 1.7, 'hover')
    // Three battle-mechs lined up by the arcade portals so they're obvious at
    // spawn: medium (blue), large (crimson), extra-large building-sized (green).
    const mm = config.vehicle.mechM
    const ml = config.vehicle.mechL
    const mx = config.vehicle.mechXL
    this.spawn('mechM', createMechSuit({ scale: mm.size, armor: 0x2348c8, trim: config.palette.cyan, core: 0x6fd8ff }), new THREE.Vector3(-16, 0, 18), mm.hoverHeight, 2.0 * mm.size, 'fly', mm.size)
    this.spawn('mechL', createMechSuit({ scale: ml.size, armor: 0xb01f3a, trim: config.palette.orange, core: 0xffae5c }), new THREE.Vector3(4, 0, 24), ml.hoverHeight, 2.0 * ml.size, 'fly', ml.size)
    // The colossus stands further out (it's ~50m wide at the feet) but towers
    // over the skyline so it's unmistakable from the portals.
    this.spawn('mechXL', createMechSuit({ scale: mx.size, armor: 0x1f6e3a, trim: config.palette.lime, core: 0x9bff4d }), new THREE.Vector3(60, 0, 60), mx.hoverHeight, 2.0 * mx.size, 'fly', mx.size)
    // Pilotable titans. The arcade guardian stands at the back of the cabinet row
    // facing the player; two more roam the outskirts and can be boarded on sight.
    const tt = config.vehicle.titan
    const arcade = this.spawn('titan', createMechSuit({ scale: tt.size, armor: 0x1b2336, trim: config.palette.cyan, core: 0x6fd8ff }), new THREE.Vector3(0, 0, 44), tt.hoverHeight, 2.0 * tt.size, 'fly', tt.size)
    arcade.yaw = Math.PI // face -Z, toward the player / cabinets
    const roam1 = this.spawn('titan', createMechSuit({ scale: tt.size, armor: 0x394b2a, trim: config.palette.lime, core: 0x9bff4d }), new THREE.Vector3(-95, 0, -78), tt.hoverHeight, 2.0 * tt.size, 'fly', tt.size)
    const roam2 = this.spawn('titan', createMechSuit({ scale: tt.size, armor: 0x4a2330, trim: config.palette.orange, core: 0xffae5c }), new THREE.Vector3(100, 0, 86), tt.hoverHeight, 2.0 * tt.size, 'fly', tt.size)
    roam1.wander = true
    roam2.wander = true
  }

  private spawn(kind: VehicleKind, model: VehicleModel, at: THREE.Vector3, hoverHeight: number, radius: number, drive: DriveMode, size = 1): Vehicle {
    const gy = this.physics.sampleGround(at.x, at.z, 40)?.y ?? 0
    // Walkers (mechs / titans) stand parked on the ground; everything else rests at its hover height.
    const position = new THREE.Vector3(at.x, gy + (isWalker(kind) ? 0 : hoverHeight), at.z)
    model.group.position.copy(position)
    this.scene.add(model.group)
    const name =
      kind === 'hovercar' ? 'HOVERCAR'
      : kind === 'speeder' ? 'SPEEDER'
      : kind === 'spaceship' ? 'SHUTTLE'
      : kind === 'mechM' ? 'MECH-M'
      : kind === 'mechL' ? 'MECH-L'
      : kind === 'mechXL' ? 'MECH-XL'
      : kind === 'titan' ? 'TITAN'
      : kind === 'tram' ? 'TRAM'
      : 'ROCKET'
    const v: Vehicle = {
      kind,
      name,
      model,
      position,
      velocity: new THREE.Vector3(),
      yaw: 0,
      radius,
      hoverHeight,
      drive,
      bob: kind === 'spaceship' ? 1.7 : 0,
      size,
      morph: 0,
      morphTarget: 0,
      home: position.clone(),
      wander: false,
      wanderTurn: Math.random() * 4,
      pathIdx: 0,
      railStop: 0,
    }
    this.list.push(v)
    return v
  }

  /**
   * Move vehicles for a zone change. On Earth everything returns to its parking
   * spot; off-world the cars/shuttle/rocket are hidden and the three mechs are
   * lined up near the spawn so you can pilot your giant robot on Mars/the Moon.
   */
  setZone(zone: Zone, spawn: THREE.Vector3) {
    const earth = zone === 'earth'
    this.current = null
    // Off-world rocket pad: rockets line up just in front of the spawn so you can
    // always find a ride onward. Spread by rocket index.
    const ROCKET_OFF = [new THREE.Vector3(-14, 0, 18), new THREE.Vector3(2, 0, 22), new THREE.Vector3(16, 0, 18)]
    let rocketIdx = 0
    for (const v of this.list) {
      // Mechs follow you off-world; rockets are everywhere (the spaceport); the
      // rest stay parked on Earth.
      const isRocket = v.kind === 'rocket'
      const visible = earth || isMech(v.kind) || isRocket
      v.model.group.visible = visible
      if (!visible) continue
      if (earth) {
        v.position.copy(v.home)
      } else if (isRocket) {
        const off = ROCKET_OFF[rocketIdx % ROCKET_OFF.length]
        v.position.set(spawn.x + off.x, 0, spawn.z + off.z)
      } else {
        const off = OFFWORLD_MECH_OFFSET[v.kind] ?? new THREE.Vector3()
        v.position.set(spawn.x + off.x, 0, spawn.z + off.z)
      }
      if (isRocket) rocketIdx++
      const gy = this.physics.sampleGround(v.position.x, v.position.z, 200)?.y ?? 0
      v.position.y = gy + (isWalker(v.kind) ? 0 : v.hoverHeight)
      v.yaw = 0
      v.morph = 0
      v.morphTarget = 0
      v.velocity.set(0, 0, 0)
      v.model.group.position.copy(v.position)
      v.model.group.rotation.set(0, 0, 0)
    }
  }

  /** Toggle the piloted mech between robot and jet form. Returns the new state. */
  toggleTransform(): 'robot' | 'jet' | null {
    const v = this.current
    if (!v || !isMech(v.kind)) return null
    v.morphTarget = v.morphTarget > 0.5 ? 0 : 1
    return v.morphTarget > 0.5 ? 'jet' : 'robot'
  }

  get currentName() {
    return this.current?.name ?? null
  }

  /** Nearest enterable vehicle within range of a point (or null). */
  nearest(pos: THREE.Vector3): Vehicle | null {
    let best: Vehicle | null = null
    let bestScore = Infinity
    for (const v of this.list) {
      if (!v.model.group.visible) continue // hidden off-world (cars stay on Earth)
      // Tall walkers (mechs / titans) get a larger boarding radius - you stand at
      // their feet, far from the model centre. Compare against each one's range.
      const range = config.vehicle.enterRange + (isWalker(v.kind) ? v.size * 1.8 : 0)
      const d = Math.hypot(v.position.x - pos.x, v.position.z - pos.z)
      if (d < range && d < bestScore) {
        bestScore = d
        best = v
      }
    }
    return best
  }

  enter(v: Vehicle) {
    this.current = v
    this.speed01 = 0
    if (v.drive === 'rocket') this.onEnterRocket?.(v)
  }

  /** Exit the current vehicle; returns a ground-snapped spot beside it. */
  exit(): THREE.Vector3 {
    const v = this.current
    this.current = null
    const out = new THREE.Vector3(0, 0, 0)
    if (!v) return out
    const side = this.right.set(Math.cos(v.yaw), 0, -Math.sin(v.yaw))
    out.copy(v.position).addScaledVector(side, v.radius + 1.8)
    const gy = this.physics.sampleGround(out.x, out.z, out.y + 6)?.y ?? 0
    out.y = gy
    return out
  }

  /** The piloted vehicle's world position (camera focus). */
  get focus(): THREE.Vector3 | null {
    return this.current?.position ?? null
  }
  get speedFraction() {
    return this.speed01
  }
  get currentSpeed() {
    return this.current ? this.current.velocity.length() : 0
  }
  /** Earth-only vehicles: hide when off-world. */
  setVisible(v: boolean) {
    for (const veh of this.list) veh.model.group.visible = v
  }

  update(dt: number, input: Input) {
    for (const v of this.list) {
      // Ease the mech transform and drive the model's morph pose.
      if (v.morph !== v.morphTarget) {
        v.morph += (v.morphTarget - v.morph) * Math.min(1, dt * 6)
        if (Math.abs(v.morph - v.morphTarget) < 0.01) v.morph = v.morphTarget
      }
      v.model.setMorph?.(v.morph)
      v.model.update(dt, v === this.current ? this.speed01 : 0)
      if (v.drive === 'rail') {
        this.driveRail(v, dt) // the tram loops its route whether or not you're aboard
      } else if (v === this.current) {
        if (v.drive === 'hover') this.driveHover(v, dt, input)
        else if (v.drive === 'fly') this.driveFly(v, dt, input)
      } else {
        this.idle(v, dt)
      }
      v.model.group.position.copy(v.position)
    }
  }

  /** Auto-pilot the tram around its waypoint loop, pausing briefly at each stop
   *  so you can board. Carries the player when it's the current vehicle. */
  private driveRail(v: Vehicle, dt: number) {
    if (!v.path || v.path.length === 0) return
    const target = v.path[v.pathIdx % v.path.length]
    const dx = target.x - v.position.x, dz = target.z - v.position.z
    const d = Math.hypot(dx, dz)
    if (v.railStop > 0) {
      v.railStop -= dt
    } else if (d < 2) {
      v.pathIdx = (v.pathIdx + 1) % v.path.length
      v.railStop = 2.4 // dwell at the stop
    } else {
      const speed = 17
      const step = Math.min(d, speed * dt)
      v.position.x += (dx / d) * step
      v.position.z += (dz / d) * step
      v.yaw = Math.atan2(dx, dz)
    }
    const gy = this.physics.sampleGround(v.position.x, v.position.z, v.position.y + 6)?.y ?? 0
    v.bob += dt
    v.position.y = gy + v.hoverHeight + Math.sin(v.bob * 1.6) * 0.08
    v.model.group.rotation.set(0, v.yaw, 0)
    this.speed01 = v === this.current ? (v.railStop > 0 ? 0 : 0.6) : 0
  }

  private idle(v: Vehicle, dt: number) {
    if (v.drive === 'rocket') return
    // Roaming titans plod around the outskirts on their own until boarded.
    if (v.wander) {
      this.wanderTitan(v, dt)
      return
    }
    const gy = this.physics.sampleGround(v.position.x, v.position.z, v.position.y + 6)?.y ?? 0
    v.bob += dt
    // Walkers park standing on the ground (feet at gy); others hover.
    const rest = isWalker(v.kind) ? 0 : v.hoverHeight
    v.position.y = gy + rest + Math.sin(v.bob * 1.4) * 0.12
    v.model.group.rotation.set(0, v.yaw, 0)
  }

  /** Slow autonomous plod for an unpiloted titan: walk forward, turn now and
   *  then, and steer back toward the map when it nears the edge. */
  private wanderTitan(v: Vehicle, dt: number) {
    const half = config.world.half - 20
    v.wanderTurn -= dt
    // Turn toward the centre near the edge, otherwise drift occasionally.
    if (Math.abs(v.position.x) > half || Math.abs(v.position.z) > half) {
      const toCentre = Math.atan2(-v.position.x, -v.position.z)
      let d = toCentre - v.yaw
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      v.yaw += d * Math.min(1, dt * 1.5)
    } else if (v.wanderTurn <= 0) {
      v.yaw += (Math.random() - 0.5) * 0.9
      v.wanderTurn = 3 + Math.random() * 4
    }
    this.fwd.set(Math.sin(v.yaw), 0, Math.cos(v.yaw))
    const speed = 6
    v.velocity.copy(this.fwd).multiplyScalar(speed)
    v.position.x += v.velocity.x * dt
    v.position.z += v.velocity.z * dt
    this.physics.resolveHorizontal(v.position, v.velocity, v.radius, 2)
    const gy = this.physics.sampleGround(v.position.x, v.position.z, v.position.y + 8)?.y ?? 0
    v.bob += dt
    v.position.y = gy + Math.sin(v.bob * 1.4) * 0.1
    v.model.group.rotation.set(0, v.yaw, 0)
  }

  private driveHover(v: Vehicle, dt: number, input: Input) {
    const cfg = v.kind === 'speeder' ? config.vehicle.speeder : config.vehicle.hovercar
    const boost = input.held.boost ? 1.4 : 1
    const maxSpeed = cfg.maxSpeed * boost

    this.fwd.set(Math.sin(v.yaw), 0, Math.cos(v.yaw))
    this.right.set(Math.cos(v.yaw), 0, -Math.sin(v.yaw))
    let fs = v.velocity.dot(this.fwd)
    let ls = v.velocity.dot(this.right)
    // Turn rate scales with speed so it doesn't spin on the spot.
    v.yaw -= input.moveX * cfg.turn * dt * (0.35 + 0.65 * Math.min(1, Math.abs(fs) / 10))
    const targetFs = input.moveY >= 0 ? input.moveY * maxSpeed : input.moveY * cfg.reverse
    fs = approach(fs, targetFs, cfg.accel * boost * dt)
    ls = approach(ls, 0, 50 * dt) // lateral grip

    this.fwd.set(Math.sin(v.yaw), 0, Math.cos(v.yaw))
    this.right.set(Math.cos(v.yaw), 0, -Math.sin(v.yaw))
    v.velocity.copy(this.fwd).multiplyScalar(fs).addScaledVector(this.right, ls)
    v.position.x += v.velocity.x * dt
    v.position.z += v.velocity.z * dt
    this.physics.resolveHorizontal(v.position, v.velocity, v.radius, 2)

    const g = this.physics.sampleGround(v.position.x, v.position.z, v.position.y + 6)
    const gy = g ? g.y : 0
    v.bob += dt
    const targetY = gy + v.hoverHeight + Math.sin(v.bob * 2) * 0.06
    // Crisper vertical tracking so the car stays planted on ramps/loops instead
    // of floating up behind the terrain.
    v.position.y = damp(v.position.y, targetY, 14, dt)

    this.orient(v, g ? g.normal : UP, -input.moveX * 0.25 * Math.min(1, Math.abs(fs) / 12), dt, 12)
    this.speed01 = Math.min(1, Math.abs(fs) / maxSpeed)
  }

  private driveFly(v: Vehicle, dt: number, input: Input) {
    const cfg =
      v.kind === 'mechM' ? config.vehicle.mechM
      : v.kind === 'mechL' ? config.vehicle.mechL
      : v.kind === 'mechXL' ? config.vehicle.mechXL
      : v.kind === 'titan' ? config.vehicle.titan
      : config.vehicle.spaceship
    const boost = input.held.boost ? 1.4 : 1
    // Jet (transformed) form flies a lot faster and turns tighter.
    const jet = 1 + v.morph * 1.4
    const maxSpeed = cfg.maxSpeed * boost * jet

    v.yaw -= input.moveX * cfg.turn * (1 + v.morph * 0.5) * dt
    this.fwd.set(Math.sin(v.yaw), 0, Math.cos(v.yaw))
    let fs = v.velocity.dot(this.fwd)
    fs = approach(fs, input.moveY * maxSpeed, cfg.accel * boost * jet * dt)

    // Altitude: jet = up, sprint = down, otherwise hold.
    let vy = v.velocity.y
    if (input.held.jet) vy = approach(vy, 14, 30 * dt)
    else if (input.held.sprint) vy = approach(vy, -14, 30 * dt)
    else vy = approach(vy, 0, 20 * dt)

    v.velocity.copy(this.fwd).multiplyScalar(fs)
    v.velocity.y = vy
    v.position.addScaledVector(v.velocity, dt)
    this.physics.resolveHorizontal(v.position, v.velocity, v.radius, 2)

    const gy = this.physics.sampleGround(v.position.x, v.position.z, v.position.y + 8)?.y ?? 0
    const minY = gy + cfg.hoverHeight
    if (v.position.y < minY) {
      v.position.y = minY
      if (v.velocity.y < 0) v.velocity.y = 0
    }
    this.orient(v, UP, -input.moveX * 0.4, dt, 8)
    this.speed01 = Math.min(1, Math.abs(fs) / maxSpeed)
  }

  /** Align local +Y to `up`, face yaw, and roll by `bank`. Slerped for smoothness. */
  private orient(v: Vehicle, up: THREE.Vector3, bank: number, dt: number, lambda: number) {
    this.fwd.set(Math.sin(v.yaw), 0, Math.cos(v.yaw))
    this.fwd.addScaledVector(up, -this.fwd.dot(up)).normalize()
    this.right.crossVectors(up, this.fwd).normalize()
    const realUp = new THREE.Vector3().crossVectors(this.fwd, this.right).normalize()
    this.mat.makeBasis(this.right, realUp, this.fwd)
    this.q.setFromRotationMatrix(this.mat)
    this.rollQ.setFromAxisAngle(this.fwd, bank)
    this.q.premultiply(this.rollQ)
    v.model.group.quaternion.slerp(this.q, 1 - Math.exp(-lambda * dt))
  }

  dispose() {
    for (const v of this.list) {
      this.scene.remove(v.model.group)
      v.model.dispose()
    }
    this.list.length = 0
  }
}
