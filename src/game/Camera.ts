import * as THREE from 'three'
import { config } from './config'
import { damp, dampAngle, dampVec3 } from './utils'
import type { Input } from './Input'

/** Optional per-frame follow hints from gameplay (robot heading, vehicle yaw). */
export interface FollowState {
  /** Distance multiplier (vehicles sit further back). */
  distanceScale?: number
  /** Heading the camera should trail behind when auto-following (radians). */
  followYaw?: number
  /** Normalized horizontal move direction, for look-ahead. */
  moveX?: number
  moveZ?: number
  /** 0..1 speed, drives look-ahead amount and speed pull-back. */
  speed01?: number
  /** Whether auto-follow is allowed this frame (grounded + actually moving). */
  canAutoFollow?: boolean
}

/**
 * Third-person follow camera tuned to feel like a modern action game.
 *
 * - Orbit yaw/pitch come from Input so mouse / touch look stays 1:1 responsive.
 * - When the look input has been idle and the subject is moving, the camera
 *   eases its yaw to trail *behind* the subject's heading (robot facing or
 *   vehicle yaw). Any manual look instantly reclaims control - auto-follow only
 *   nudges `input.yaw` while the player isn't looking around.
 * - The look target leads slightly ahead along movement so you see where you go.
 * - The camera pulls back a touch at speed.
 * - Collision: a short sphere-ish sweep (center + corner rays) from the subject
 *   to the desired camera spot pulls the camera in past walls; it snaps in
 *   instantly and eases back out. A final ground-clearance clamp stops it
 *   dipping under terrain on steep downward pitch.
 */
export class CameraController {
  private cam: THREE.PerspectiveCamera
  private solids: THREE.Object3D[]
  private raycaster = new THREE.Raycaster()

  private currentTarget = new THREE.Vector3()
  private dist = config.camera.distance
  private offsetDir = new THREE.Vector3()
  private desiredTarget = new THREE.Vector3()
  private lookAhead = new THREE.Vector3()
  private camPos = new THREE.Vector3()
  private probeOrigin = new THREE.Vector3()
  private side = new THREE.Vector3()
  private up = new THREE.Vector3()
  private initialized = false
  private shakeAmt = 0

  /** Kick a quick camera shake (e.g. mech boot-up, heavy landing). 0..1-ish. */
  shake(amount: number) {
    this.shakeAmt = Math.min(1.5, this.shakeAmt + amount)
  }

  constructor(cam: THREE.PerspectiveCamera, solids: THREE.Object3D[]) {
    this.cam = cam
    this.solids = solids
  }

  setSolids(solids: THREE.Object3D[]) {
    this.solids = solids
  }

  /** Snap directly behind a focus point (used after teleports / zone changes). */
  snap(focus: THREE.Vector3) {
    this.initialized = false
    this.lookAhead.set(0, 0, 0)
    this.update(0, { yaw: 0, pitch: config.camera.startPitch } as Input, focus)
  }

  update(dt: number, input: Pick<Input, 'yaw' | 'pitch'>, focus: THREE.Vector3, follow: FollowState | number = {}) {
    // Back-compat: a bare number is the old distanceScale arg.
    const f: FollowState = typeof follow === 'number' ? { distanceScale: follow } : follow
    const distanceScale = f.distanceScale ?? 1

    // --- auto-follow: ease yaw to trail the subject when the look is idle ---
    if (dt > 0 && f.canAutoFollow && f.followYaw !== undefined) {
      input.yaw = dampAngle(input.yaw, f.followYaw, config.camera.autoFollowLambda, dt)
    }

    const yaw = input.yaw
    const pitch = input.pitch
    const cosP = Math.cos(pitch)
    // Unit vector pointing from the target back to the camera.
    this.offsetDir.set(-Math.sin(yaw) * cosP, Math.sin(pitch), -Math.cos(yaw) * cosP)

    // --- look-ahead: lead the target along movement so more of the path shows ---
    const speed01 = f.speed01 ?? 0
    const aheadX = (f.moveX ?? 0) * config.camera.lookAhead * speed01
    const aheadZ = (f.moveZ ?? 0) * config.camera.lookAhead * speed01
    if (dt > 0) {
      this.lookAhead.x = damp(this.lookAhead.x, aheadX, config.camera.lookAheadLambda, dt)
      this.lookAhead.z = damp(this.lookAhead.z, aheadZ, config.camera.lookAheadLambda, dt)
    } else {
      this.lookAhead.set(aheadX, 0, aheadZ)
    }

    this.desiredTarget.set(
      focus.x + this.lookAhead.x,
      focus.y + config.camera.targetHeight,
      focus.z + this.lookAhead.z,
    )
    if (!this.initialized) {
      this.currentTarget.copy(this.desiredTarget)
      this.initialized = true
    } else {
      dampVec3(this.currentTarget, this.desiredTarget, config.camera.followLambda, dt)
    }

    // Desired distance, extended a bit at speed. minDistance is the *manual*
    // zoom floor and is applied to the desired distance only - a collision hit
    // below is allowed to tuck the camera closer than this so it never sits
    // inside a wall.
    let want = config.camera.distance * distanceScale * (1 + (config.camera.speedPullback - 1) * speed01)
    want = Math.max(config.camera.minDistance, want)

    // --- collision: center + 4 offset probes, take the nearest blocker ---
    this.side.set(Math.cos(yaw), 0, -Math.sin(yaw)) // camera-right on the ground
    this.up.set(0, 1, 0)
    const pad = config.camera.collisionPadding
    let nearest = want
    // Desktop sweeps a full cross; other tiers use a 3-probe horizontal cross
    // (center + left/right) so the camera stops clipping through building edges
    // on mobile. The two extra rays are cheap next to a visible wall break.
    const probes = config.tier.name === 'high'
      ? [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad]]
      : [[0, 0], [pad, 0], [-pad, 0]]
    for (const [s, u] of probes) {
      this.probeOrigin.copy(this.currentTarget).addScaledVector(this.side, s).addScaledVector(this.up, u)
      this.raycaster.set(this.probeOrigin, this.offsetDir)
      this.raycaster.far = want + pad
      const hits = this.raycaster.intersectObjects(this.solids, false)
      if (hits.length > 0) {
        const d = hits[0].distance - pad
        if (d < nearest) nearest = d
      }
    }
    // A wall can pull the camera closer than minDistance; only a small hard floor
    // keeps it off the subject. Clamping back up to minDistance here is what used
    // to shove the camera through the wall and black out the screen.
    want = Math.max(config.camera.collisionMinDistance, nearest)

    // Snap in toward walls immediately, ease back out when clear.
    this.dist = want < this.dist ? want : damp(this.dist, want, config.camera.returnLambda, dt)

    this.camPos.copy(this.currentTarget).addScaledVector(this.offsetDir, this.dist)

    // Ground-clearance clamp: never let the camera dip under the terrain below it.
    this.raycaster.set(this.probeOrigin.set(this.camPos.x, this.camPos.y + 50, this.camPos.z), this.up.set(0, -1, 0))
    this.raycaster.far = 200
    const down = this.raycaster.intersectObjects(this.solids, false)
    if (down.length > 0) {
      const minY = down[0].point.y + config.camera.minGroundClearance
      if (this.camPos.y < minY) this.camPos.y = minY
    }

    // Transient shake: decaying random jitter on the final camera position.
    if (this.shakeAmt > 0.001) {
      const j = this.shakeAmt
      this.camPos.x += (Math.random() - 0.5) * j
      this.camPos.y += (Math.random() - 0.5) * j
      this.camPos.z += (Math.random() - 0.5) * j
      this.shakeAmt = dt > 0 ? Math.max(0, this.shakeAmt - dt * 3) : this.shakeAmt
    }

    this.cam.position.copy(this.camPos)
    this.cam.lookAt(this.currentTarget)
  }
}
