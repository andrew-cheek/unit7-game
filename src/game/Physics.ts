import * as THREE from 'three'

export interface GroundHit {
  y: number
  normal: THREE.Vector3
}

/**
 * Collision + terrain following. Two responsibilities:
 *  - resolveHorizontal: push a capsule (treated as a vertical circle) out of the
 *    world's AABB colliders and cancel the velocity component into the wall, so
 *    nothing passes through buildings (and entities slide along them).
 *  - sampleGround: a downward raycast against terrain + ramp + platform meshes,
 *    returning the surface height and world normal so entities can climb slopes
 *    and vehicles can align their pitch. This is what makes ramps drivable -
 *    Y follows the hit point every frame instead of being pinned at 0.
 */
export class Physics {
  private ray = new THREE.Raycaster()
  private readonly down = new THREE.Vector3(0, -1, 0)
  private normalMat = new THREE.Matrix3()
  // Scratch reused by sampleGround() so it allocates nothing per call (it runs
  // for every NPC/vehicle/player every frame). The returned normal points at
  // hitNormal; copy it if you need it past the next sampleGround() call.
  private readonly rayOrigin = new THREE.Vector3()
  private readonly hitNormal = new THREE.Vector3()
  private groundMeshes: THREE.Mesh[]
  colliders: THREE.Box3[]

  constructor(groundMeshes: THREE.Mesh[], colliders: THREE.Box3[]) {
    this.groundMeshes = groundMeshes
    this.colliders = colliders
  }

  /** Swap the active collision/ground surfaces (on zone change). */
  setSurfaces(groundMeshes: THREE.Mesh[], colliders: THREE.Box3[]) {
    this.groundMeshes = groundMeshes
    this.colliders = colliders
  }

  /** Highest ground surface directly below (x, z), searched from `fromY` down. */
  sampleGround(x: number, z: number, fromY: number): GroundHit | null {
    this.rayOrigin.set(x, fromY, z)
    this.ray.set(this.rayOrigin, this.down)
    this.ray.far = fromY + 200
    const hits = this.ray.intersectObjects(this.groundMeshes, false)
    if (hits.length === 0) return null
    const hit = hits[0] // nearest from above = topmost surface
    if (hit.face) {
      this.normalMat.getNormalMatrix(hit.object.matrixWorld)
      this.hitNormal.copy(hit.face.normal).applyMatrix3(this.normalMat).normalize()
      if (this.hitNormal.y < 0) this.hitNormal.negate()
    } else {
      this.hitNormal.set(0, 1, 0)
    }
    return { y: hit.point.y, normal: this.hitNormal }
  }

  /** Highest collider TOP directly under (x,z) that sits at or just below the
   *  feet — i.e. a building roof you can stand on. Returns null if none. Lets the
   *  player land on and walk across rooftops (building colliders aren't in the
   *  ground-mesh raycast, so without this you'd sink/eject on a roof). */
  topSupport(x: number, z: number, feetY: number, tol = 0.6): number | null {
    let best: number | null = null
    for (const box of this.colliders) {
      if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
      const top = box.max.y
      if (top > feetY + tol) continue // top is above the feet → it's a wall here, not a floor
      if (best === null || top > best) best = top
    }
    return best
  }

  /**
   * Segment-vs-collider test for the grapple tendril: does the segment from→to
   * cross any building AABB? Writes the nearest entry point to `out` and returns
   * true. Slab method per box; cheap enough to run while the tendril extends.
   */
  raySegmentHit(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Vector3): boolean {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z
    let best = Infinity
    for (const box of this.colliders) {
      let tmin = 0, tmax = 1
      let ok = true
      // x slab
      if (Math.abs(dx) < 1e-9) { if (from.x < box.min.x || from.x > box.max.x) ok = false }
      else { let t1 = (box.min.x - from.x) / dx, t2 = (box.max.x - from.x) / dx; if (t1 > t2) { const s = t1; t1 = t2; t2 = s } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2) }
      if (ok && Math.abs(dy) < 1e-9) { if (from.y < box.min.y || from.y > box.max.y) ok = false }
      else if (ok) { let t1 = (box.min.y - from.y) / dy, t2 = (box.max.y - from.y) / dy; if (t1 > t2) { const s = t1; t1 = t2; t2 = s } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2) }
      if (ok && Math.abs(dz) < 1e-9) { if (from.z < box.min.z || from.z > box.max.z) ok = false }
      else if (ok) { let t1 = (box.min.z - from.z) / dz, t2 = (box.max.z - from.z) / dz; if (t1 > t2) { const s = t1; t1 = t2; t2 = s } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2) }
      if (ok && tmin <= tmax && tmin < best) best = tmin
    }
    if (best === Infinity) return false
    out.set(from.x + dx * best, from.y + dy * best, from.z + dz * best)
    return true
  }

  /**
   * Push a capsule (feet at pos.y, of given radius/height) out of any AABB it
   * overlaps in XZ, and remove the velocity component driving it into the wall.
   */
  resolveHorizontal(pos: THREE.Vector3, vel: THREE.Vector3, radius: number, height: number) {
    const r2 = radius * radius
    for (const box of this.colliders) {
      // Skip boxes the capsule doesn't vertically overlap. The top margin lets you
      // rest ON a roof without being shoved sideways (topSupport snaps Y there).
      if (pos.y >= box.max.y - 0.35 || pos.y + height <= box.min.y) continue

      const cx = Math.min(Math.max(pos.x, box.min.x), box.max.x)
      const cz = Math.min(Math.max(pos.z, box.min.z), box.max.z)
      const dx = pos.x - cx
      const dz = pos.z - cz
      const d2 = dx * dx + dz * dz

      if (d2 >= r2) continue

      if (d2 > 1e-8) {
        const d = Math.sqrt(d2)
        const nx = dx / d
        const nz = dz / d
        const pen = radius - d
        pos.x += nx * pen
        pos.z += nz * pen
        const vdot = vel.x * nx + vel.z * nz
        if (vdot < 0) {
          vel.x -= vdot * nx
          vel.z -= vdot * nz
        }
      } else {
        // Center is inside the footprint: eject along the nearest face.
        const toMinX = pos.x - box.min.x
        const toMaxX = box.max.x - pos.x
        const toMinZ = pos.z - box.min.z
        const toMaxZ = box.max.z - pos.z
        const minPen = Math.min(toMinX, toMaxX, toMinZ, toMaxZ)
        if (minPen === toMinX) {
          pos.x = box.min.x - radius
          if (vel.x > 0) vel.x = 0
        } else if (minPen === toMaxX) {
          pos.x = box.max.x + radius
          if (vel.x < 0) vel.x = 0
        } else if (minPen === toMinZ) {
          pos.z = box.min.z - radius
          if (vel.z > 0) vel.z = 0
        } else {
          pos.z = box.max.z + radius
          if (vel.z < 0) vel.z = 0
        }
      }
    }
  }
}
