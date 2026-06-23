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
  warpSpeedMul = 1 // movement multiplier from the current warp form (1 = robot)
  shield = false // shield powerup
  dancing = false // robot-dance emote (set by Game from the dance floor / key)
  private danceT = 0
  boarding = false // riding the summonable hover skateboard
  private board: THREE.Group
  private boardLean = 0

  private model: RobotModel
  private moveDir = new THREE.Vector3()
  private prevJet = false
  // Grapple-arm state: a zip toward an anchor point on a building.
  grappling = false
  private grappleAnchor = new THREE.Vector3()
  private grappleT = 0
  private scene: THREE.Scene
  private grappleBeam!: THREE.Mesh
  private gbFrom = new THREE.Vector3()
  private gbMid = new THREE.Vector3()
  private planeTarget = 0 // 0 robot, 1 plane
  private morphT = 0
  private chuteT = 0
  private airTime = 0
  private canopy: THREE.Group
  private canopyMat: THREE.MeshStandardMaterial

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.object.rotation.order = 'YXZ' // yaw, then pitch/roll for plane banking
    this.model = createRobot()
    this.object.add(this.model.group)

    // Grapple cable: a thick emissive beam (a thin line is near-invisible). A unit
    // cylinder along Y, stretched/oriented from hand to anchor each frame.
    this.grappleBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 1, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    )
    this.grappleBeam.frustumCulled = false
    this.grappleBeam.visible = false
    scene.add(this.grappleBeam)

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

    this.board = this.buildBoard()
    this.board.visible = false
    this.object.add(this.board)

    scene.add(this.object)
  }

  private buildBoard(): THREE.Group {
    const g = new THREE.Group()
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.12, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x12151f, metalness: 0.7, roughness: 0.4 }),
    )
    deck.position.y = 0.14
    g.add(deck)
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.06, 2.7),
      new THREE.MeshBasicMaterial({ color: config.palette.cyan }),
    )
    edge.position.y = 0.08
    g.add(edge)
    // Twin thruster glows under the deck.
    for (const sz of [-0.8, 0.8]) {
      const jet = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 0.7, 10, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }),
      )
      jet.rotation.x = Math.PI
      jet.position.set(0, -0.1, sz)
      g.add(jet)
    }
    return g
  }

  /** Summon / stow the hover skateboard (the robot rides it visibly). */
  setBoard(v: boolean) {
    if (v === this.boarding) return
    this.boarding = v
    this.board.visible = v
    if (!v) {
      this.boardLean = 0
      this.object.rotation.z = 0
    }
  }

  get position() {
    return this.object.position
  }
  setVisible(v: boolean) {
    this.object.visible = v
  }
  /** Hide just the robot mesh (used while warped into another form), keeping the
   *  controller + collision active. */
  setModelVisible(v: boolean) {
    this.model.group.visible = v
  }
  /** Recolor the robot's accent/trim to an equipped cosmetic color. */
  setAccent(color: number) {
    this.model.setAccent(color)
  }
  /** Fling the player upward (trampoline / bounce pad). */
  launch(strength: number) {
    this.velocity.y = strength
    this.grounded = false
    this.airTime = 0
  }
  /** Fling along a launch vector (cannon / slingshot). */
  launchVec(vx: number, vy: number, vz: number) {
    this.velocity.set(vx, vy, vz)
    this.grounded = false
    this.airTime = 0
  }
  /** Sustained lift from an updraft column (adds to rise, capped). */
  rideUpdraft(dv: number) {
    this.velocity.y = Math.min(this.velocity.y + dv, config.jetpack.maxAscend + 5)
    if (this.grounded && this.velocity.y > 0) { this.grounded = false; this.airTime = 0 }
  }
  setDancing(v: boolean) {
    this.dancing = v
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
  /** Cut the canopy: drop straight back into free-fall (jetpack + re-deploy available). */
  cutChute(): boolean {
    if (this.mode !== 'parachute') return false
    this.mode = 'robot'
    this.planeTarget = 0
    this.airTime = config.parachute.deployMinAir // allow an immediate re-deploy
    return true
  }
  /** Begin a grapple zip toward a world-space anchor (robot mode only). */
  startGrapple(anchor: THREE.Vector3) {
    if (this.mode === 'vehicle') return
    this.mode = 'robot'
    this.planeTarget = 0
    this.grappling = true
    this.grappleT = 0
    this.grappleAnchor.copy(anchor)
  }
  /** Release the grapple, keeping momentum so you fling/hop off it. */
  endGrapple() {
    this.grappling = false
    this.grappleBeam.visible = false
  }
  enterVehicle() {
    this.endGrapple() // never carry a live grapple into a vehicle (would soft-lock on exit)
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

    const dancing = this.dancing && this.grounded && this.mode === 'robot'
    if (this.grappling) this.updateGrapple(dt, input, gravity)
    else if (dancing) this.updateDance(dt, gravity)
    else if (this.mode === 'parachute') this.updateParachute(dt, input, gravity)
    else if (this.mode === 'plane') this.updatePlane(dt, input, gravity)
    else this.updateRobot(dt, input, gravity)

    this.integrateAndCollide(dt, physics)
    this.updateGrappleLine()

    // Face + animate.
    const moving = this.moveDir.lengthSq() > 1e-4
    if (dancing) {
      this.object.rotation.set(0, this.danceT * 4.5, 0) // spin
    } else if (this.mode === 'plane') {
      const targetYaw = moving ? Math.atan2(this.moveDir.x, this.moveDir.z) : this.yaw
      this.yaw = dampAngle(this.yaw, targetYaw, 5, dt)
      this.object.rotation.y = this.yaw
      this.object.rotation.z = damp(this.object.rotation.z, -input.moveX * config.plane.bank, 6, dt)
      this.object.rotation.x = damp(this.object.rotation.x, clamp(-this.velocity.y * 0.03, -0.5, 0.5), 6, dt)
    } else if (moving && this.mode === 'robot') {
      const targetYaw = Math.atan2(this.moveDir.x, this.moveDir.z)
      const prevYaw = this.yaw
      const lerp = this.boarding ? config.hoverboard.turnLerp : config.player.turnLerp
      this.yaw = dampAngle(this.yaw, targetYaw, lerp, dt)
      if (this.boarding) {
        // Lean into the turn based on how hard we're carving.
        const want = clamp((-(this.yaw - prevYaw) / Math.max(dt, 1e-3)) * 0.12, -config.hoverboard.lean, config.hoverboard.lean)
        this.boardLean = damp(this.boardLean, want, 8, dt)
      }
      this.object.rotation.set(0, this.yaw, this.boarding ? this.boardLean : 0)
    } else if (this.boarding && this.mode === 'robot') {
      // Standing still on the board: ease the lean back to flat.
      this.boardLean = damp(this.boardLean, 0, 8, dt)
      this.object.rotation.set(0, this.yaw, this.boardLean)
    } else if (this.mode === 'parachute') {
      this.object.rotation.set(0, this.yaw, 0)
    }

    this.speed = Math.hypot(this.velocity.x, this.velocity.z)
    if (dancing) {
      this.model.group.position.y = Math.abs(Math.sin(this.danceT * 7)) * 0.35 // bob
      this.model.update(dt, 0.6, true)
    } else {
      this.model.group.position.y = 0
      this.model.update(dt, this.speed / config.player.runSpeed, this.grounded)
    }
    this.updateCanopy(dt)
  }

  /** Zip toward the grapple anchor; light camera-relative steering lets you aim
   *  the arc. Releases on arrival (with a small upward pop to crest ledges) or a
   *  timeout, keeping velocity so you fling off it. */
  private updateGrapple(dt: number, input: Input, _gravity: number) {
    const g = config.grapple
    const pos = this.object.position
    const dx = this.grappleAnchor.x - pos.x
    const dy = this.grappleAnchor.y - pos.y
    const dz = this.grappleAnchor.z - pos.z
    const dist = Math.hypot(dx, dy, dz)
    this.grappleT += dt
    if (dist < g.arriveDist || this.grappleT > g.maxTime) {
      if (dist < g.arriveDist + 2 && this.velocity.y < 6) this.velocity.y = 6 // pop up to land on top
      this.endGrapple()
      return
    }
    const inv = 1 / Math.max(dist, 1e-3)
    this.velocity.x += dx * inv * g.pull * dt
    this.velocity.y += dy * inv * g.pull * dt
    this.velocity.z += dz * inv * g.pull * dt
    // A little camera-relative steering to shape the swing.
    const intent = this.camRelative(input, this.moveDir)
    if (intent > 0.1) {
      this.velocity.x += this.moveDir.x * 22 * intent * dt
      this.velocity.z += this.moveDir.z * 22 * intent * dt
    }
    const sp = this.velocity.length()
    if (sp > g.maxSpeed) this.velocity.multiplyScalar(g.maxSpeed / sp)
    this.model.setFlyPose(0.85)
    this.model.setThrust(0.4)
    // Face the anchor.
    this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), 8, dt)
    this.object.rotation.set(0, this.yaw, 0)
  }

  /** Keep the grapple beam stretched from the hand to the anchor while zipping. */
  private updateGrappleLine() {
    if (!this.grappling) { if (this.grappleBeam.visible) this.grappleBeam.visible = false; return }
    const p = this.object.position
    this.gbFrom.set(p.x, p.y + 1.3, p.z)
    const len = this.gbFrom.distanceTo(this.grappleAnchor)
    this.gbMid.copy(this.gbFrom).lerp(this.grappleAnchor, 0.5)
    this.grappleBeam.position.copy(this.gbMid)
    this.grappleBeam.scale.set(1, Math.max(0.1, len), 1)
    this.grappleBeam.lookAt(this.grappleAnchor)
    this.grappleBeam.rotateX(Math.PI / 2) // cylinder is along Y; aim it down the look axis
    this.grappleBeam.visible = true
  }

  private updateDance(dt: number, gravity: number) {
    this.moveDir.set(0, 0, 0)
    this.velocity.x = approach(this.velocity.x, 0, 40 * dt)
    this.velocity.z = approach(this.velocity.z, 0, 40 * dt)
    this.velocity.y += gravity * dt // stay planted on the floor
    this.danceT += dt
  }

  private camRelative(input: Input, out: THREE.Vector3) {
    const yaw = input.yaw
    // Forward (+moveY) follows the camera heading; strafe (+moveX) is camera-right.
    // Camera-right is -cross(up, forward), hence the signs on the moveX terms -
    // getting these wrong is what made "left" steer right.
    out.set(
      -Math.cos(yaw) * input.moveX + Math.sin(yaw) * input.moveY,
      0,
      Math.sin(yaw) * input.moveX + Math.cos(yaw) * input.moveY,
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
    const board = this.boarding
    const maxSpeed = (board ? config.player.runSpeed * config.hoverboard.speedMul : wantSprint ? config.player.runSpeed : config.player.walkSpeed) * this.speedMul * this.warpSpeedMul
    const accelV = board ? config.hoverboard.accel : config.player.accel
    const decelV = board ? config.hoverboard.decel : config.player.decel
    const jetting = input.held.jet
    // Sub-frame tap recovery: consume the one-shot jet edge latched in Input so a
    // tap whose press+release fell entirely between fixed steps still hops.
    const jetEdge = input.consumeEdge('jet')
    // Air control is weak in an unpowered fall (deliberately weighty) but snappier
    // while the jetpack is actively thrusting, since flight is a primary traversal.
    const air = jetting ? config.player.airControlJet : config.player.airControl
    const rate = (intent > 0.1 ? accelV : decelV) * (this.grounded ? 1 : air)
    this.velocity.x = approach(this.velocity.x, this.moveDir.x * maxSpeed * intent, rate * dt)
    this.velocity.z = approach(this.velocity.z, this.moveDir.z * maxSpeed * intent, rate * dt)

    // Jetpack: hold to fly. Unlimited — it never runs out and always gives full
    // lift; the fuel meter stays topped up. Re-pressing in mid-air fires a pulse
    // boost that climbs PAST the steady cruise cap, so tapping repeatedly lets
    // you stack height (a key vertical-traversal move).
    const canHop = this.grounded || this.airTime < config.player.coyoteTime
    if (jetting) {
      const risingEdge = !this.prevJet
      if (risingEdge && canHop && this.velocity.y <= 0.1) {
        this.velocity.y = config.player.jumpSpeed // ground / coyote launch hop
      } else if (risingEdge && !this.grounded) {
        // Mid-air re-press: an upward burst on top of current rise (can exceed cap).
        this.velocity.y = Math.max(this.velocity.y, 0) + config.jetpack.pulseBoost
      }
      // Steady cruise ramps toward the cap, but never drags a higher pulse down.
      if (this.velocity.y < config.jetpack.maxAscend) {
        this.velocity.y = Math.min(this.velocity.y + config.jetpack.thrust * dt, config.jetpack.maxAscend)
      }
      this.model.setThrust(1)
    } else {
      // Held already released this frame, but a latched tap still owes one hop.
      if (jetEdge && canHop && this.velocity.y <= 0.1) this.velocity.y = config.player.jumpSpeed
      this.model.setThrust(0)
    }
    this.fuel = config.jetpack.fuelMax
    this.prevJet = input.held.jet
    this.model.setFlyPose(this.grounded ? 0 : 0.7)

    // Heavier gravity on the way down (and when not thrusting up) kills the
    // floaty hang-time so jumps land with weight.
    const falling = this.velocity.y < 0 || !jetting
    this.velocity.y += gravity * (falling ? config.player.fallGravityMult : 1) * dt
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
    const prevY = pos.y // height before this step (for swept rooftop landing)
    pos.x += this.velocity.x * dt
    pos.y += this.velocity.y * dt
    pos.z += this.velocity.z * dt

    physics.resolveHorizontal(pos, this.velocity, config.player.radius, config.player.height)
    // Landing surface = the higher of the terrain below and any building roof
    // whose footprint we're over. Use the PRE-step height so a fast fall that
    // crosses a whole roof in one frame still catches it (no tunnelling through).
    const ground = physics.sampleGround(pos.x, pos.z, pos.y + 2.5)
    const roof = physics.topSupport(pos.x, pos.z, Math.max(prevY, pos.y))
    let surfaceY = ground ? ground.y : -Infinity
    if (roof !== null && roof > surfaceY) surfaceY = roof
    const hasSurface = surfaceY > -Infinity
    const wasGrounded = this.grounded
    if (hasSurface && pos.y <= surfaceY) {
      pos.y = surfaceY
      if (this.velocity.y < 0) this.velocity.y = 0
      this.grounded = true
    } else if (hasSurface && wasGrounded && pos.y <= surfaceY + config.player.stepDown && this.velocity.y <= 0) {
      pos.y = surfaceY
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
    this.scene.remove(this.grappleBeam)
    this.grappleBeam.geometry.dispose()
    ;(this.grappleBeam.material as THREE.Material).dispose()
    this.model.dispose()
    this.canopy.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    this.canopyMat.dispose()
    ;(this.canopyMat.userData.cordMat as THREE.Material)?.dispose()
  }
}
