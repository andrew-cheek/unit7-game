import * as THREE from 'three'
import { config } from './config'
import { createRobot, type RobotModel } from './procedural'
import { clamp, damp, dampAngle } from './utils'
import type { Input } from './Input'
import type { Physics } from './Physics'
import type { PlayerMode } from './types'
import type { GrindHit } from './GrindRails'

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
  private danceMoveT = 0  // time elapsed within the current move
  private danceMove = 0   // 0-4: spin, moonwalk, flip, pop-lock, raise-the-roof
  boarding = false // riding the summonable hover skateboard
  private static readonly BOARD_LIFT = 0.42 // how far the deck floats off the ground
  private board: THREE.Group
  private boardLean = 0
  // Grind state: locked to a neon rail on the board (see GrindRails). The snap
  // query is injected by Game; null when there are no rails (off-world).
  grinding = false
  private grindAx = 0; private grindAy = 0; private grindAz = 0
  private grindBx = 0; private grindBy = 0; private grindBz = 0
  private grindT = 0
  private grindDir = 1
  private grindSpeed = 0
  private grindSnap: ((x: number, y: number, z: number) => GrindHit | null) | null = null

  private model: RobotModel
  private moveDir = new THREE.Vector3()
  private prevJet = false
  // Render interpolation: the sim steps at a fixed 60Hz, but the display can run
  // faster. rPrev/rTrue bracket the position over the last fixed step so the
  // visual can be lerped between them each render frame (smooth, no stepping).
  private rPrev = new THREE.Vector3()
  private rTrue = new THREE.Vector3()
  private interpInit = false
  // Grapple-arm state: a tendril that extends toward a pre-picked grab point
  // (Game raycasts the aim against buildings) then reels the player up to the
  // roof edge there. grappleHasTarget is false on a miss (the beam just shoots
  // out to max range and retracts) so a wild aim gives clear feedback.
  grappling = false
  private grappleAttached = false
  private grappleHasTarget = false
  private grappleDir = new THREE.Vector3()
  private grappleTip = new THREE.Vector3()
  private grappleTipPrev = new THREE.Vector3()
  private grappleAnchor = new THREE.Vector3()
  private grappleHand = new THREE.Vector3()
  private grappleLen = 0
  private grappleT = 0
  private scene: THREE.Scene
  private grappleBeam!: THREE.Mesh
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
    // Float the board off the ground so it reads as a hoverboard (the robot is
    // lifted onto the deck while boarding; thrusters glow in the gap below). The
    // deck top sits 0.2 above the board's origin, so floating it by LIFT-0.2 puts
    // the deck exactly under the robot's lifted feet (model lift = BOARD_LIFT).
    this.board.position.y = Player.BOARD_LIFT - 0.2
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

  /** Game injects the rail-snap query (GrindRails.querySnap). */
  setGrindSnap(fn: (x: number, y: number, z: number) => GrindHit | null) {
    this.grindSnap = fn
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
    if (!v && this.dancing) { this.danceMove = 0; this.danceMoveT = 0 }
    this.dancing = v
  }
  /** Call when first starting a manual dance to reset to move 0. */
  startDance() {
    this.danceMove = 0
    this.danceMoveT = 0
    this.danceT = 0
  }
  /** Advance to the next combo move (0-4 wrap). */
  advanceDanceMove() {
    this.danceMove = (this.danceMove + 1) % 5
    this.danceMoveT = 0
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
  /** Fire the grapple at a grab point Game picked by raycasting your aim against
   *  the buildings. `top` is that building's roof height: we anchor just above
   *  the roof edge at the grab's XZ so reeling lifts you ONTO the building rather
   *  than pinning you flat against the wall. Re-firing re-aims. */
  fireGrapple(grab: THREE.Vector3, top: number) {
    if (this.mode === 'vehicle') return
    this.mode = 'robot'
    this.planeTarget = 0
    const pos = this.object.position
    this.grappleHand.set(pos.x, pos.y + 1.3, pos.z)
    // Aim for the roof edge above the grab point, but never beyond reach.
    const anchorY = Math.max(grab.y, Math.min(top + 1.4, this.grappleHand.y + config.grapple.range))
    this.grappleAnchor.set(grab.x, anchorY, grab.z)
    this.grappleDir.copy(this.grappleAnchor).sub(this.grappleHand)
    const d = this.grappleDir.length()
    if (d > 1e-3) this.grappleDir.multiplyScalar(1 / d)
    this.grappling = true
    this.grappleAttached = false
    this.grappleHasTarget = true
    this.grappleT = 0
    this.grappleLen = 0
    this.grappleTip.copy(this.grappleHand)
  }
  /** Fire on a miss (nothing grabbable under the aim): the tendril shoots out to
   *  max range along the aim and retracts, so the input still reads as "fired". */
  fireGrappleMiss(dir: THREE.Vector3) {
    if (this.mode === 'vehicle') return
    const pos = this.object.position
    this.grappleHand.set(pos.x, pos.y + 1.3, pos.z)
    this.grappleDir.copy(dir).normalize()
    this.grappleAnchor.copy(this.grappleHand).addScaledVector(this.grappleDir, config.grapple.range)
    this.grappling = true
    this.grappleAttached = false
    this.grappleHasTarget = false
    this.grappleT = 0
    this.grappleLen = 0
    this.grappleTip.copy(this.grappleHand)
  }
  /** Release the grapple, keeping momentum so you fling/hop off it. */
  endGrapple() {
    this.grappling = false
    this.grappleAttached = false
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
    this.resetInterp()
  }

  /** Snap the render-interpolation anchors to the current position (after any
   *  teleport: spawn, portal, zone change, respawn) so the visual doesn't lerp
   *  across the jump. */
  resetInterp() {
    this.rTrue.copy(this.object.position)
    this.rPrev.copy(this.object.position)
    this.interpInit = true
  }

  /** Render the body at the interpolated position between the last two sim steps
   *  (alpha 0..1 from the engine). Called once per rendered frame. */
  interp(alpha: number) {
    if (this.mode === 'vehicle' || !this.interpInit) return
    this.object.position.lerpVectors(this.rPrev, this.rTrue, alpha)
  }

  // --- per-frame -----------------------------------------------------------
  update(dt: number, input: Input, physics: Physics, gravity: number) {
    if (this.mode === 'vehicle') {
      this.model.update(dt, 0, true)
      return
    }

    // Render interpolation: restore the true sim position (the last render frame
    // may have left the body lerped part-way) before stepping, and record the
    // step's start. rTrue is recaptured at the end of the step.
    if (!this.interpInit) { this.rTrue.copy(this.object.position); this.interpInit = true }
    this.object.position.copy(this.rTrue)
    this.rPrev.copy(this.rTrue)

    // Animate morph and resolve active mode.
    this.morphT = damp(this.morphT, this.planeTarget, config.plane.morphLambda, dt)
    this.model.setPlanePose(this.morphT)
    if (this.mode !== 'parachute') this.mode = this.planeTarget === 1 ? 'plane' : 'robot'

    // Latch a grind rail when boarding + moving (Player owns the slide).
    if (!this.grappling && !this.grinding && this.boarding && this.mode === 'robot') this.maybeStartGrind()

    const dancing = this.dancing && this.grounded && this.mode === 'robot'
    if (this.grappling) this.updateGrapple(dt, input, physics, gravity)
    else if (this.grinding) this.updateGrind(dt, input)
    else if (dancing) this.updateDance(dt, gravity)
    else if (this.mode === 'parachute') this.updateParachute(dt, input, gravity)
    else if (this.mode === 'plane') this.updatePlane(dt, input, gravity)
    else this.updateRobot(dt, input, gravity)

    // Grinding sets its own position on the rail; skip the collide/ground-snap.
    if (!this.grinding) this.integrateAndCollide(dt, physics)
    this.updateGrappleLine()

    // Face + animate.
    const moving = this.moveDir.lengthSq() > 1e-4
    if (this.grinding) {
      // updateGrind already set rotation; nothing to do here.
    } else if (dancing) {
      this.danceRotation()
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
      this.danceModel(dt)
    } else {
      // Stand the robot on the deck while boarding so it visibly rides the board;
      // otherwise feet rest on the ground.
      this.model.group.position.y = this.boarding ? Player.BOARD_LIFT : 0
      this.model.update(dt, this.speed / config.player.runSpeed, this.grounded)
    }
    this.updateCanopy(dt)
    // Record the step's end position for render interpolation.
    this.rTrue.copy(this.object.position)
  }

  /** Latch onto a nearby rail if the board is moving fast enough. */
  private maybeStartGrind() {
    if (!this.grindSnap) return
    const pos = this.object.position
    const spd = Math.hypot(this.velocity.x, this.velocity.z)
    if (spd < config.grind.minSpeed * 0.5) return // need some pace to jump on
    const hit = this.grindSnap(pos.x, pos.y, pos.z)
    if (!hit) return
    this.grindAx = hit.ax; this.grindAy = hit.ay; this.grindAz = hit.az
    this.grindBx = hit.bx; this.grindBy = hit.by; this.grindBz = hit.bz
    this.grindT = hit.t
    // Ride toward whichever end our momentum points at.
    const sdx = hit.bx - hit.ax, sdz = hit.bz - hit.az
    this.grindDir = this.velocity.x * sdx + this.velocity.z * sdz >= 0 ? 1 : -1
    this.grindSpeed = Math.max(spd, config.grind.minSpeed)
    this.grinding = true
    this.grounded = false
    this.airTime = 0
  }

  /** Slide along the latched rail; launch off the end or on a jump press. */
  private updateGrind(dt: number, input: Input) {
    const g = config.grind
    const sdx = this.grindBx - this.grindAx
    const sdy = this.grindBy - this.grindAy
    const sdz = this.grindBz - this.grindAz
    const len = Math.hypot(sdx, sdy, sdz) || 1
    const inv = 1 / len
    const tx = sdx * inv * this.grindDir, ty = sdy * inv * this.grindDir, tz = sdz * inv * this.grindDir
    this.grindT += (this.grindDir * this.grindSpeed * dt) * inv

    const jet = input.held.jet
    const jumpEdge = (jet && !this.prevJet) || input.consumeEdge('jet')
    const offEnd = this.grindT <= 0 || this.grindT >= 1
    if (jumpEdge || offEnd || !this.boarding) {
      // Launch: carry the rail speed along the tangent, pop up off the end / jump.
      this.velocity.set(tx * this.grindSpeed, jumpEdge ? config.player.jumpSpeed : ty * this.grindSpeed + 3.5, tz * this.grindSpeed)
      this.grinding = false
      this.grounded = false
      this.airTime = 0
      this.prevJet = jet
      return
    }
    // Ride: lock the board onto the rail line + offset, build a little speed.
    const t = this.grindT
    this.object.position.set(this.grindAx + sdx * t, this.grindAy + sdy * t + g.boardOffset, this.grindAz + sdz * t)
    this.velocity.set(tx * this.grindSpeed, ty * this.grindSpeed, tz * this.grindSpeed)
    this.grounded = false
    this.airTime = 0
    this.grindSpeed = Math.min(this.grindSpeed + g.accel * dt, g.maxSpeed)
    this.yaw = Math.atan2(tx, tz)
    this.boardLean = damp(this.boardLean, 0, 8, dt)
    this.object.rotation.set(0, this.yaw, 0)
    this.model.setFlyPose(0.3)
    this.prevJet = jet
  }

  /** Drive the grapple: extend the tendril along the aim until it hits a surface,
   *  then reel toward the hit point. Releasing (handled by Game) ends it, keeping
   *  momentum so you fling off and can re-aim/re-fire elsewhere. */
  private updateGrapple(dt: number, input: Input, physics: Physics, gravity: number) {
    const g = config.grapple
    const pos = this.object.position
    this.grappleT += dt
    if (this.grappleT > g.maxTime) { this.endGrapple(); return }
    this.grappleHand.set(pos.x, pos.y + 1.3, pos.z)

    if (!this.grappleAttached) {
      // EXTEND: shoot the visible tendril toward the grab point. On a real target
      // it curves to track the anchor (so the beam lands exactly where you'll
      // attach); on a miss it just runs out to max range and retracts.
      if (this.grappleHasTarget) {
        this.grappleDir.copy(this.grappleAnchor).sub(this.grappleHand)
        const d = this.grappleDir.length()
        if (d > 1e-3) this.grappleDir.multiplyScalar(1 / d)
      }
      const reach = this.grappleHasTarget ? this.grappleHand.distanceTo(this.grappleAnchor) : g.range
      this.grappleTipPrev.copy(this.grappleTip)
      this.grappleLen += g.extendSpeed * dt
      this.grappleTip.copy(this.grappleHand).addScaledVector(this.grappleDir, Math.min(this.grappleLen, reach))
      if (this.grappleLen >= reach) {
        if (this.grappleHasTarget) this.grappleAttached = true
        else { this.endGrapple(); return } // miss: retract
      }
      this.velocity.y += gravity * 0.4 * dt // light hang while it flies
      this.model.setFlyPose(0.7)
      this.model.setThrust(0.3)
    } else {
      // REEL: pull up toward the roof-edge anchor. Light steering shapes the
      // swing. Arriving (or reaching the ledge) pops you up + over so you land on
      // top of the building rather than dangling against its face.
      const dx = this.grappleAnchor.x - pos.x, dy = this.grappleAnchor.y - (pos.y + 1.3), dz = this.grappleAnchor.z - pos.z
      const dist = Math.hypot(dx, dy, dz)
      const horiz = Math.hypot(dx, dz)
      if (dist < g.arriveDist || (horiz < 1.4 && dy < 1.6)) {
        this.velocity.y = Math.max(this.velocity.y, 9) // pop to crest the ledge
        this.velocity.x += (dx === 0 ? 0 : Math.sign(dx)) * 2
        this.velocity.z += (dz === 0 ? 0 : Math.sign(dz)) * 2
        this.endGrapple()
        return
      }
      const inv = 1 / Math.max(dist, 1e-3)
      this.velocity.x += dx * inv * g.pull * dt
      this.velocity.y += dy * inv * g.pull * dt
      this.velocity.z += dz * inv * g.pull * dt
      // Pressed against the wall below the edge: climb so you don't stall there.
      if (horiz < config.player.radius + 1 && dy > 0.5) this.velocity.y += g.pull * 0.5 * dt
      const intent = this.camRelative(input, this.moveDir)
      if (intent > 0.1) {
        this.velocity.x += this.moveDir.x * 22 * intent * dt
        this.velocity.z += this.moveDir.z * 22 * intent * dt
      }
      const sp = this.velocity.length()
      if (sp > g.maxSpeed) this.velocity.multiplyScalar(g.maxSpeed / sp)
      this.model.setFlyPose(0.85)
      this.model.setThrust(0.4)
      this.yaw = dampAngle(this.yaw, Math.atan2(dx, dz), 8, dt)
      this.object.rotation.set(0, this.yaw, 0)
    }
  }

  /** Stretch the grapple beam from the hand to the live tip (extending) or the
   *  anchor (attached), so the tendril is clearly visible shooting out + reeling. */
  private updateGrappleLine() {
    if (!this.grappling) { if (this.grappleBeam.visible) this.grappleBeam.visible = false; return }
    const p = this.object.position
    this.grappleHand.set(p.x, p.y + 1.3, p.z)
    const end = this.grappleAttached ? this.grappleAnchor : this.grappleTip
    const len = this.grappleHand.distanceTo(end)
    this.gbMid.copy(this.grappleHand).lerp(end, 0.5)
    this.grappleBeam.position.copy(this.gbMid)
    this.grappleBeam.scale.set(1, Math.max(0.1, len), 1)
    this.grappleBeam.lookAt(end)
    this.grappleBeam.rotateX(Math.PI / 2) // cylinder is along Y; aim it down the look axis
    this.grappleBeam.visible = true
  }

  private updateDance(dt: number, gravity: number) {
    this.moveDir.set(0, 0, 0)
    this.velocity.x = approach(this.velocity.x, 0, 40 * dt)
    this.velocity.z = approach(this.velocity.z, 0, 40 * dt)
    this.velocity.y += gravity * dt
    this.danceT += dt
    this.danceMoveT += dt
    // Move 2 (flip): brief hop at start of each flip cycle.
    if (this.danceMove === 2) {
      const flipPeriod = 2.0
      const ct = this.danceMoveT % flipPeriod
      if (ct < dt * 2 && this.grounded) this.velocity.y = Math.max(this.velocity.y, 5.5)
    }
  }

  private danceRotation() {
    const t = this.danceT, mt = this.danceMoveT
    switch (this.danceMove) {
      case 0: // Spin: continuous Y rotation + body bob
        this.object.rotation.set(0, t * 4.5, 0)
        break
      case 1: // Moonwalk: lean forward, slow turn, side sway
        this.object.rotation.set(0.22, t * 0.7, Math.sin(t * 4) * 0.16)
        break
      case 2: { // Flip: full forward somersault with leg tuck at apex
        const flipPeriod = 2.0, flipDur = 0.72
        const ct = mt % flipPeriod
        const flipping = ct < flipDur
        const flipAngle = flipping ? -(ct / flipDur) * Math.PI * 2 : 0
        this.object.rotation.set(flipAngle, this.yaw + mt * 0.25, 0)
        this.model.setFlyPose(flipping ? Math.sin((ct / flipDur) * Math.PI) * 0.85 : 0)
        break
      }
      case 3: { // Pop-lock: snap to 90° increments, hold with a lean
        const snapInterval = 0.42
        const step = Math.floor(mt / snapInterval)
        const snapAngle = this.yaw + step * (Math.PI / 2)
        const snapProg = (mt % snapInterval) / snapInterval
        this.object.rotation.set(0, snapAngle, snapProg < 0.25 ? snapProg * 1.2 : 0)
        this.model.setFlyPose(snapProg < 0.18 ? snapProg / 0.18 * 0.5 : 0)
        break
      }
      default: // Raise the roof: upright spin, arms pump via flyPose
        this.object.rotation.set(0, t * 0.4, Math.sin(t * 8) * 0.12)
        this.model.setFlyPose(0.5 + Math.sin(t * 6) * 0.28)
        break
    }
  }

  private danceModel(dt: number) {
    const t = this.danceT, mt = this.danceMoveT
    switch (this.danceMove) {
      case 0: // Spin
        this.model.setFlyPose(0)
        this.model.group.position.y = Math.abs(Math.sin(t * 7)) * 0.35
        this.model.update(dt, 0.6, true)
        break
      case 1: // Moonwalk: forward lean with shuffle walk
        this.model.setFlyPose(0)
        this.model.group.position.y = Math.abs(Math.sin(t * 4.5)) * 0.2
        this.model.update(dt, 0.5, true)
        break
      case 2: { // Flip: idle between flips, walk cycle during
        const flipPeriod = 2.0, flipDur = 0.72
        const ct = mt % flipPeriod
        this.model.group.position.y = 0
        this.model.update(dt, ct < flipDur ? 0.4 : 0.1, ct >= flipDur)
        break
      }
      case 3: // Pop-lock: frozen pose (speed 0) with snap arm movement via flyPose above
        this.model.group.position.y = 0
        this.model.update(dt, 0.05, true)
        break
      default: // Raise the roof: fast bob, arms pumping
        this.model.group.position.y = Math.abs(Math.sin(t * 10)) * 0.38
        this.model.update(dt, 0.3, true)
        break
    }
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
    let applyGravity = true
    if (jetting) {
      const risingEdge = !this.prevJet
      if (risingEdge && canHop && this.velocity.y <= 0.1) {
        this.velocity.y = config.player.jumpSpeed // ground / coyote launch hop
      } else if (risingEdge && !this.grounded) {
        // Mid-air re-press: an upward burst on top of current rise (can exceed cap).
        this.velocity.y = Math.max(this.velocity.y, 0) + config.jetpack.pulseBoost
      }
      // Smoothly EASE the climb rate toward the cruise cap instead of clamping it
      // every frame while gravity tugs the other way - that tug-of-war made the
      // ascent feel jerky. A pulse above the cap bleeds back down to it gently,
      // and gravity is skipped while thrusting (the cruise target nets the climb).
      const cap = config.jetpack.maxAscend
      const ease = this.velocity.y > cap ? config.jetpack.thrust * 0.5 : config.jetpack.thrust
      this.velocity.y = approach(this.velocity.y, cap, ease * dt)
      this.model.setThrust(1)
      applyGravity = false
    } else {
      // Held already released this frame, but a latched tap still owes one hop.
      if (jetEdge && canHop && this.velocity.y <= 0.1) this.velocity.y = config.player.jumpSpeed
      this.model.setThrust(0)
    }
    this.fuel = config.jetpack.fuelMax
    this.prevJet = input.held.jet
    this.model.setFlyPose(this.grounded ? 0 : 0.7)

    // Heavier gravity on the way down kills floaty hang-time so jumps land with
    // weight. Skipped while actively thrusting (handled by the eased cruise above).
    if (applyGravity) {
      const falling = this.velocity.y < 0
      this.velocity.y += gravity * (falling ? config.player.fallGravityMult : 1) * dt
    }
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
