import * as THREE from 'three'
import { config } from './config'
import { createRobot, type RobotModel } from './procedural'
import { clamp, damp, dampAngle } from './utils'
import type { Input } from './Input'
import type { Physics } from './Physics'
import type { PlayerMode } from './types'

function approach(current: number, target: number, maxDelta: number) {
  return current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target)
}

// Max height drop the player will "stick" to when walking down a slope/step.
const STEP_DOWN = 0.55

/**
 * Player avatar + controller as a small state machine:
 *   robot      - grounded locomotion (accel/decel, sprint+stamina) + jetpack
 *   plane      - animated morph to a winged flight form, fast gliding flight
 *   parachute  - deployed canopy, gravity-damped slow descent with drift
 *   vehicle    - hidden; the Vehicles system drives and syncs position
 * Gravity is applied per-mode; a shared integrate+collide step then resolves
 * building collisions and snaps Y onto the terrain/ramp below.
 */
export class Player {
  readonly object = new THREE.Group()
  readonly velocity = new THREE.Vector3()
  yaw = 0
  speed = 0
  grounded = true
  mode: PlayerMode = 'robot'
  stamina = config.player.staminaMax
  fuel = config.jetpack.fuelMax
  speedMul = 1 // speed powerup
  shield = false // shield powerup

  private model: RobotModel
  private moveDir = new THREE.Vector3()
  private prevJet = false
  private planeTarget = 0 // 0 robot, 1 plane
  private morphT = 0
  private chuteT = 0
  private airTime = 0
  private canopy: THREE.Group
  private canopyMat: THREE.MeshStandardMaterial

  constructor(scene: THREE.Scene) {
    this.object.rotation.order = 'YXZ' // yaw, then pitch/roll for plane banking
    this.model = createRobot()
    this.object.add(this.model.group)

    this.canopyMat = new THREE.MeshStandardMaterial({
      color: 0xff5db0,
      emissive: 0x401024,
      emissiveIntensity: 0.6,
      roughness: 0.7,
      side: THREE.DoubleSide,
    })
    this.canopy = this.buildCanopy()
    this.canopy.visible = false
    this.object.add(this.canopy)

    scene.add(this.object)
  }

  get position() {
    return this.object.position
  }
  setVisible(v: boolean) {
    this.object.visible = v
  }

  private buildCanopy(): THREE.Group {
    const g = new THREE.Group()
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1.7, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.52),
      this.canopyMat,
    )
    dome.position.y = 3.6
    dome.castShadow = true
    g.add(dome)
    const cordMat = new THREE.MeshStandardMaterial({ color: 0x223, roughness: 0.9 })
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 2.6, 5), cordMat)
      cord.position.set(Math.cos(a) * 0.7, 2.3, Math.sin(a) * 0.7)
      cord.rotation.set(Math.cos(a) * 0.35, 0, -Math.sin(a) * 0.35)
      g.add(cord)
    }
    this.canopyMat.userData.cordMat = cordMat
    return g
  }

  // --- mode transitions ----------------------------------------------------
  toggleMorph() {
    if (this.mode === 'vehicle' || this.mode === 'parachute') return
    this.planeTarget = this.planeTarget === 1 ? 0 : 1
  }
  deployChute(): boolean {
    if (this.mode === 'vehicle' || this.mode === 'parachute') return false
    if (this.grounded || this.airTime < config.parachute.deployMinAir) return false
    this.mode = 'parachute'
    this.planeTarget = 0
    if (this.velocity.y < 0) this.velocity.y *= 0.3
    return true
  }
  enterVehicle() {
    this.mode = 'vehicle'
    this.planeTarget = 0
    this.morphT = 0
    this.model.setPlanePose(0)
    this.model.setThrust(0)
    this.setVisible(false)
  }
  exitVehicle(at: THREE.Vector3) {
    this.mode = 'robot'
    this.object.position.copy(at)
    this.velocity.set(0, 0, 0)
    this.object.rotation.set(0, this.yaw, 0)
    this.setVisible(true)
  }

  // --- per-frame -----------------------------------------------------------
  update(dt: number, input: Input, physics: Physics, gravity: number) {
    if (this.mode === 'vehicle') {
      this.model.update(dt, 0, true)
      return
    }

    // Animate morph and resolve active mode.
    this.morphT = damp(this.morphT, this.planeTarget, config.plane.morphLambda, dt)
    this.model.setPlanePose(this.morphT)
    if (this.mode !== 'parachute') this.mode = this.planeTarget === 1 ? 'plane' : 'robot'

    if (this.mode === 'parachute') this.updateParachute(dt, input, gravity)
    else if (this.mode === 'plane') this.updatePlane(dt, input, gravity)
    else this.updateRobot(dt, input, gravity)

    this.integrateAndCollide(dt, physics)

    // Face + animate.
    const moving = this.moveDir.lengthSq() > 1e-4
    if (this.mode === 'plane') {
      const targetYaw = moving ? Math.atan2(this.moveDir.x, this.moveDir.z) : this.yaw
      this.yaw = dampAngle(this.yaw, targetYaw, 5, dt)
      this.object.rotation.y = this.yaw
      this.object.rotation.z = damp(this.object.rotation.z, -input.moveX * config.plane.bank, 6, dt)
      this.object.rotation.x = damp(this.object.rotation.x, clamp(-this.velocity.y * 0.03, -0.5, 0.5), 6, dt)
    } else if (moving && this.mode === 'robot') {
      const targetYaw = Math.atan2(this.moveDir.x, this.moveDir.z)
      this.yaw = dampAngle(this.yaw, targetYaw, config.player.turnLerp, dt)
      this.object.rotation.set(0, this.yaw, 0)
    } else if (this.mode === 'parachute') {
      this.object.rotation.set(0, this.yaw, 0)
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z)
    this.model.update(dt, this.speed / config.player.runSpeed, this.grounded)
    this.updateCanopy(dt)
  }

  private camRelative(input: Input, out: THREE.Vector3) {
    const yaw = input.yaw
    out.set(
      Math.cos(yaw) * input.moveX + Math.sin(yaw) * input.moveY,
      0,
      -Math.sin(yaw) * input.moveX + Math.cos(yaw) * input.moveY,
    )
    const len = out.length()
    if (len > 1e-3) out.multiplyScalar(1 / len)
    return Math.min(1, Math.hypot(input.moveX, input.moveY))
  }

  private updateRobot(dt: number, input: Input, gravity: number) {
    const intent = this.camRelative(input, this.moveDir)
    const wantSprint = input.held.sprint && intent > 0.1 && this.stamina > config.player.staminaMinToSprint
    this.stamina = clamp(
      this.stamina + (wantSprint ? -config.player.staminaDrain : config.player.staminaRegen) * dt,
      0,
      config.player.staminaMax,
    )
    const maxSpeed = (wantSprint ? config.player.runSpeed : config.player.walkSpeed) * this.speedMul
    const rate = (intent > 0.1 ? config.player.accel : config.player.decel) * (this.grounded ? 1 : config.player.airControl)
    this.velocity.x = approach(this.velocity.x, this.moveDir.x * maxSpeed * intent, rate * dt)
    this.velocity.z = approach(this.velocity.z, this.moveDir.z * maxSpeed * intent, rate * dt)

    // Jetpack: hold to fly, with an initial hop and a regenerating fuel meter.
    const jetting = input.held.jet && this.fuel > config.jetpack.fuelMinToFly
    if (jetting) {
      if (!this.prevJet && this.grounded) this.velocity.y = config.player.jumpSpeed
      this.velocity.y = Math.min(this.velocity.y + config.jetpack.thrust * dt, config.jetpack.maxAscend)
      this.fuel = Math.max(0, this.fuel - config.jetpack.fuelDrain * dt)
      this.model.setThrust(1)
    } else {
      this.fuel = Math.min(config.jetpack.fuelMax, this.fuel + config.jetpack.fuelRegen * dt)
      this.model.setThrust(0)
    }
    this.prevJet = input.held.jet
    this.model.setFlyPose(this.grounded ? 0 : 0.7)

    this.velocity.y += gravity * dt
  }

  private updatePlane(dt: number, input: Input, gravity: number) {
    const intent = this.camRelative(input, this.moveDir)
    const boosting = input.held.boost
    const maxSpeed = boosting ? config.plane.boostSpeed : config.plane.speed
    // Glide forward in the steered direction.
    const tvx = this.moveDir.x * maxSpeed * Math.max(intent, 0.55)
    const tvz = this.moveDir.z * maxSpeed * Math.max(intent, 0.55)
    this.velocity.x = approach(this.velocity.x, tvx, 30 * dt)
    this.velocity.z = approach(this.velocity.z, tvz, 30 * dt)

    if (input.held.jet) this.velocity.y = Math.min(this.velocity.y + config.plane.lift * dt, config.plane.lift)
    this.velocity.y += gravity * config.plane.gravityScale * dt
    this.fuel = Math.min(config.jetpack.fuelMax, this.fuel + config.jetpack.fuelRegen * 0.5 * dt)
    this.model.setThrust(intent > 0.2 || input.held.jet ? 1 : 0.3)
    this.prevJet = input.held.jet
  }

  private updateParachute(dt: number, input: Input, gravity: number) {
    this.chuteT = Math.min(1, this.chuteT + dt * 3)
    const intent = this.camRelative(input, this.moveDir)
    const drift = config.parachute.horizontalDrift
    this.velocity.x = approach(this.velocity.x, this.moveDir.x * drift * intent, 8 * dt)
    this.velocity.z = approach(this.velocity.z, this.moveDir.z * drift * intent, 8 * dt)
    // Gravity-damped descent, clamped to terminal velocity.
    this.velocity.y += gravity * 0.25 * dt
    if (this.velocity.y < config.parachute.terminalVelocity) this.velocity.y = config.parachute.terminalVelocity
    this.model.setFlyPose(1)
    this.model.setThrust(0)
  }

  private integrateAndCollide(dt: number, physics: Physics) {
    const pos = this.object.position
    pos.x += this.velocity.x * dt
    pos.y += this.velocity.y * dt
    pos.z += this.velocity.z * dt

    physics.resolveHorizontal(pos, this.velocity, config.player.radius, config.player.height)
    const ground = physics.sampleGround(pos.x, pos.z, pos.y + 2.5)
    const wasGrounded = this.grounded
    if (ground && pos.y <= ground.y) {
      pos.y = ground.y
      if (this.velocity.y < 0) this.velocity.y = 0
      this.grounded = true
    } else if (ground && wasGrounded && pos.y <= ground.y + STEP_DOWN && this.velocity.y <= 0) {
      pos.y = ground.y
      this.velocity.y = 0
      this.grounded = true
    } else {
      this.grounded = false
    }

    this.airTime = this.grounded ? 0 : this.airTime + dt

    // Landing with the chute out retracts it and returns to robot.
    if (this.grounded && this.mode === 'parachute') {
      this.mode = 'robot'
    }
  }

  private updateCanopy(dt: number) {
    const target = this.mode === 'parachute' ? 1 : 0
    this.chuteT = damp(this.chuteT, target, 6, dt)
    if (this.chuteT < 0.02) {
      this.canopy.visible = false
    } else {
      this.canopy.visible = true
      const s = 0.05 + this.chuteT * 0.95
      this.canopy.scale.set(s, s, s)
    }
  }

  dispose() {
    this.model.dispose()
    this.canopy.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    this.canopyMat.dispose()
    ;(this.canopyMat.userData.cordMat as THREE.Material)?.dispose()
  }
}
