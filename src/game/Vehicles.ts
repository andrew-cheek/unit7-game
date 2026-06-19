import * as THREE from 'three'
import { config } from './config'
import { createHovercar, createSpaceship, createRocket, type VehicleModel } from './procedural'
import { damp } from './utils'
import type { Input } from './Input'
import type { Physics } from './Physics'

export type VehicleKind = 'hovercar' | 'spaceship' | 'rocket'
type DriveMode = 'hover' | 'fly' | 'rocket'

interface Vehicle {
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
}

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
  onEnterRocket: (() => void) | null = null

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
    this.spawn('spaceship', createSpaceship(), new THREE.Vector3(-22, 0, 20), config.vehicle.spaceship.hoverHeight, 2.8, 'fly')
    this.spawn('rocket', createRocket(), new THREE.Vector3(2, 0, -30), 0, 1.4, 'rocket')
  }

  private spawn(kind: VehicleKind, model: VehicleModel, at: THREE.Vector3, hoverHeight: number, radius: number, drive: DriveMode) {
    const gy = this.physics.sampleGround(at.x, at.z, 40)?.y ?? 0
    const position = new THREE.Vector3(at.x, gy + hoverHeight, at.z)
    model.group.position.copy(position)
    this.scene.add(model.group)
    this.list.push({
      kind,
      name: kind === 'hovercar' ? 'HOVERCAR' : kind === 'spaceship' ? 'SHUTTLE' : 'ROCKET',
      model,
      position,
      velocity: new THREE.Vector3(),
      yaw: 0,
      radius,
      hoverHeight,
      drive,
      bob: kind === 'spaceship' ? 1.7 : 0,
    })
  }

  get currentName() {
    return this.current?.name ?? null
  }

  /** Nearest enterable vehicle within range of a point (or null). */
  nearest(pos: THREE.Vector3): Vehicle | null {
    let best: Vehicle | null = null
    let bestD = config.vehicle.enterRange
    for (const v of this.list) {
      const d = Math.hypot(v.position.x - pos.x, v.position.z - pos.z)
      if (d < bestD) {
        bestD = d
        best = v
      }
    }
    return best
  }

  enter(v: Vehicle) {
    this.current = v
    this.speed01 = 0
    if (v.drive === 'rocket') this.onEnterRocket?.()
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
      v.model.update(dt, v === this.current ? this.speed01 : 0)
      if (v === this.current) {
        if (v.drive === 'hover') this.driveHover(v, dt, input)
        else if (v.drive === 'fly') this.driveFly(v, dt, input)
      } else {
        this.idle(v, dt)
      }
      v.model.group.position.copy(v.position)
    }
  }

  private idle(v: Vehicle, dt: number) {
    if (v.drive === 'rocket') return
    const gy = this.physics.sampleGround(v.position.x, v.position.z, v.position.y + 6)?.y ?? 0
    v.bob += dt
    v.position.y = gy + v.hoverHeight + Math.sin(v.bob * 1.4) * 0.12
    v.model.group.rotation.set(0, v.yaw, 0)
  }

  private driveHover(v: Vehicle, dt: number, input: Input) {
    const cfg = config.vehicle.hovercar
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
    const cfg = config.vehicle.spaceship
    const boost = input.held.boost ? 1.4 : 1
    const maxSpeed = cfg.maxSpeed * boost

    v.yaw -= input.moveX * cfg.turn * dt
    this.fwd.set(Math.sin(v.yaw), 0, Math.cos(v.yaw))
    let fs = v.velocity.dot(this.fwd)
    fs = approach(fs, input.moveY * maxSpeed, cfg.accel * boost * dt)

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
