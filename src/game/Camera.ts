import * as THREE from 'three'
import { config } from './config'
import { damp, dampVec3 } from './utils'
import type { Input } from './Input'

/**
 * Third-person follow camera. Orbit yaw/pitch come straight from Input (so
 * mouse-look stays 1:1 responsive); the target position is spring-damped so the
 * camera glides behind the player. A ray from the player to the desired camera
 * spot pulls the camera in when a wall is in the way - it snaps in instantly to
 * avoid clipping and eases back out when the wall clears.
 */
export class CameraController {
  private cam: THREE.PerspectiveCamera
  private solids: THREE.Object3D[]
  private raycaster = new THREE.Raycaster()

  private currentTarget = new THREE.Vector3()
  private dist = config.camera.distance
  private offsetDir = new THREE.Vector3()
  private desiredTarget = new THREE.Vector3()
  private camPos = new THREE.Vector3()
  private initialized = false

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
    this.update(0, { yaw: 0, pitch: -0.18 } as Input, focus)
  }

  update(dt: number, input: Pick<Input, 'yaw' | 'pitch'>, focus: THREE.Vector3, distanceScale = 1) {
    const yaw = input.yaw
    const pitch = input.pitch
    const cosP = Math.cos(pitch)
    // Unit vector pointing from the target back to the camera.
    this.offsetDir.set(-Math.sin(yaw) * cosP, Math.sin(pitch), -Math.cos(yaw) * cosP)

    this.desiredTarget.set(focus.x, focus.y + config.camera.targetHeight, focus.z)
    if (!this.initialized) {
      this.currentTarget.copy(this.desiredTarget)
      this.initialized = true
    } else {
      dampVec3(this.currentTarget, this.desiredTarget, config.camera.followLambda, dt)
    }

    // Wall-aware distance.
    let want = config.camera.distance * distanceScale
    this.raycaster.set(this.currentTarget, this.offsetDir)
    this.raycaster.far = want + config.camera.collisionPadding
    const hits = this.raycaster.intersectObjects(this.solids, false)
    if (hits.length > 0) {
      want = Math.max(config.camera.minDistance, hits[0].distance - config.camera.collisionPadding)
    }
    // Snap in toward walls, ease back out.
    this.dist = want < this.dist ? want : damp(this.dist, want, 7, dt)

    this.camPos.copy(this.currentTarget).addScaledVector(this.offsetDir, this.dist)
    this.cam.position.copy(this.camPos)
    this.cam.lookAt(this.currentTarget)
  }
}
