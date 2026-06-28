import * as THREE from 'three'

// Reminder to self and anyone brave enough to refactor this: it is one downward
// raycast and a pile of box checks holding an entire city up. It is not a real
// physics engine. It has never claimed to be. If you change the order of the
// resolve steps, the robot WILL clip through a wall and you WILL deserve it.

export interface GroundHit {
  y: number
  normal: THREE.Vector3
}

/** Out-param for resolveHorizontal so callers can sense a wall hit (for impact
 *  juice) without an extra query. `speed` is the largest closing speed (m/s)
 *  along a push-out normal that was cancelled this call - i.e. how hard the
 *  capsule was driving INTO a wall before resolution. 0 = no contact / sliding
 *  along (no inward component). The caller resets it to 0 before the call. */
export interface ImpactOut {
  speed: number
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

  // Broadphase: colliders are bucketed into a uniform XZ grid so resolveHorizontal
  // (run by every NPC/vehicle/player each step) and topSupport only test the few
  // boxes near the query, not all ~300 of them. A per-query stamp dedupes boxes
  // that span multiple cells without allocating a Set each call. gridCount tracks
  // collider.length so late pushes (landmark towers added after construction) and
  // zone swaps trigger a rebuild lazily.
  private static readonly CELL = 40
  private grid = new Map<number, number[]>()
  private stamp = new Int32Array(0)
  private queryId = 0
  private gridCount = -1

  constructor(groundMeshes: THREE.Mesh[], colliders: THREE.Box3[]) {
    this.groundMeshes = groundMeshes
    this.colliders = colliders
    this.rebuildGrid()
  }

  /** Swap the active collision/ground surfaces (on zone change). */
  setSurfaces(groundMeshes: THREE.Mesh[], colliders: THREE.Box3[]) {
    this.groundMeshes = groundMeshes
    this.colliders = colliders
    this.rebuildGrid()
  }

  /** Temporarily add a walkable surface (e.g. the launch-pad platform) so the
   *  player can stand/walk on it via sampleGround. Paired with removeGroundMesh. */
  addGroundMesh(m: THREE.Mesh) { if (!this.groundMeshes.includes(m)) this.groundMeshes.push(m) }
  removeGroundMesh(m: THREE.Mesh) { const i = this.groundMeshes.indexOf(m); if (i >= 0) this.groundMeshes.splice(i, 1) }

  private cellKey(ix: number, iz: number): number {
    return (ix + 4096) * 8192 + (iz + 4096)
  }

  /** (Re)bucket every collider into the grid. Cheap; runs on zone change or when
   *  the collider count changes (a few landmark boxes are pushed post-construct). */
  private rebuildGrid() {
    this.grid.clear()
    const cs = Physics.CELL
    for (let i = 0; i < this.colliders.length; i++) {
      const b = this.colliders[i]
      const x0 = Math.floor(b.min.x / cs), x1 = Math.floor(b.max.x / cs)
      const z0 = Math.floor(b.min.z / cs), z1 = Math.floor(b.max.z / cs)
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = this.cellKey(ix, iz)
          let arr = this.grid.get(k)
          if (!arr) { arr = []; this.grid.set(k, arr) }
          arr.push(i)
        }
      }
    }
    if (this.stamp.length < this.colliders.length) this.stamp = new Int32Array(this.colliders.length)
    this.gridCount = this.colliders.length
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
    if (this.colliders.length !== this.gridCount) this.rebuildGrid()
    const arr = this.grid.get(this.cellKey(Math.floor(x / Physics.CELL), Math.floor(z / Physics.CELL)))
    if (!arr) return null
    let best: number | null = null
    for (let n = 0; n < arr.length; n++) {
      const box = this.colliders[arr[n]]
      if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue
      const top = box.max.y
      if (top > feetY + tol) continue // top is above the feet → it's a wall here, not a floor
      if (best === null || top > best) best = top
    }
    return best
  }

  /**
   * Pick a grapple target along an aim ray. First tries a direct hit: the nearest
   * building face the ray crosses within `range`. If the ray misses (you rarely
   * aim dead-on in third person), it falls back to generous forward-cone auto-aim:
   * the best-aligned building within reach. Writes the grab point (on the near
   * face) to `out` and returns that building's TOP Y, so the grapple can lift you
   * to the roof edge instead of pinning you flat against the wall. Null if nothing
   * grabbable is in reach. Called once per fire, so a few allocations are fine.
   */
  grappleTarget(from: THREE.Vector3, dir: THREE.Vector3, range: number, out: THREE.Vector3): number | null {
    const inv = new THREE.Vector3(1 / (dir.x || 1e-9), 1 / (dir.y || 1e-9), 1 / (dir.z || 1e-9))
    let bestT = Infinity
    let hitBox: THREE.Box3 | null = null
    for (const box of this.colliders) {
      // slab intersection, entry t (may be negative if origin is inside)
      let t1 = (box.min.x - from.x) * inv.x, t2 = (box.max.x - from.x) * inv.x
      let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2)
      t1 = (box.min.y - from.y) * inv.y; t2 = (box.max.y - from.y) * inv.y
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2))
      t1 = (box.min.z - from.z) * inv.z; t2 = (box.max.z - from.z) * inv.z
      tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2))
      if (tmax < Math.max(tmin, 0)) continue // miss / behind
      const t = tmin >= 0 ? tmin : tmax
      if (t >= 0 && t <= range && t < bestT) { bestT = t; hitBox = box }
    }
    if (hitBox) {
      out.set(from.x + dir.x * bestT, from.y + dir.y * bestT, from.z + dir.z * bestT)
      return hitBox.max.y
    }
    // Cone fallback: closest point on each box, accept if it's roughly in the aim
    // direction (within ~30 deg) and in range; pick the nearest such building.
    let bestDist = Infinity
    for (const box of this.colliders) {
      const cx = Math.min(Math.max(from.x, box.min.x), box.max.x)
      const cy = Math.min(Math.max(from.y, box.min.y), box.max.y)
      const cz = Math.min(Math.max(from.z, box.min.z), box.max.z)
      const vx = cx - from.x, vy = cy - from.y, vz = cz - from.z
      const d = Math.hypot(vx, vy, vz)
      if (d < 2 || d > range) continue
      const align = (vx * dir.x + vy * dir.y + vz * dir.z) / d
      if (align < 0.86) continue // outside the cone
      if (d < bestDist) { bestDist = d; hitBox = box; out.set(cx, cy, cz) }
    }
    return hitBox ? hitBox.max.y : null
  }

  /**
   * Push a capsule (feet at pos.y, of given radius/height) out of any AABB it
   * overlaps in XZ, and remove the velocity component driving it into the wall.
   *
   * If `out` is passed, the largest closing speed cancelled this call is written
   * to out.speed (the velocity component going INTO the wall, pre-cancellation).
   * Callers reset out.speed to 0 first; sliding along a wall (no inward velocity)
   * leaves it 0. Purely additive - the param is optional and unused by existing
   * callers, and writing it costs only a max() per resolved box.
   */
  resolveHorizontal(pos: THREE.Vector3, vel: THREE.Vector3, radius: number, height: number, out?: ImpactOut) {
    if (this.colliders.length !== this.gridCount) this.rebuildGrid()
    const r2 = radius * radius
    const cs = Physics.CELL
    // Only the grid cells the capsule footprint touches; a box within `radius`
    // must overlap one of them, and the stamp keeps a multi-cell box from being
    // resolved twice in one call.
    const x0 = Math.floor((pos.x - radius) / cs), x1 = Math.floor((pos.x + radius) / cs)
    const z0 = Math.floor((pos.z - radius) / cs), z1 = Math.floor((pos.z + radius) / cs)
    const qid = ++this.queryId
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = this.grid.get(this.cellKey(ix, iz))
        if (!arr) continue
        for (let n = 0; n < arr.length; n++) {
          const idx = arr[n]
          if (this.stamp[idx] === qid) continue
          this.stamp[idx] = qid
          const box = this.colliders[idx]
          // Skip boxes the capsule doesn't vertically overlap. The top margin lets
          // you rest ON a roof without being shoved sideways (topSupport snaps Y).
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
              // -vdot is the closing speed into the wall (vdot<0 means heading in).
              if (out && -vdot > out.speed) out.speed = -vdot
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
              if (vel.x > 0) { if (out && vel.x > out.speed) out.speed = vel.x; vel.x = 0 }
            } else if (minPen === toMaxX) {
              pos.x = box.max.x + radius
              if (vel.x < 0) { if (out && -vel.x > out.speed) out.speed = -vel.x; vel.x = 0 }
            } else if (minPen === toMinZ) {
              pos.z = box.min.z - radius
              if (vel.z > 0) { if (out && vel.z > out.speed) out.speed = vel.z; vel.z = 0 }
            } else {
              pos.z = box.max.z + radius
              if (vel.z < 0) { if (out && -vel.z > out.speed) out.speed = -vel.z; vel.z = 0 }
            }
          }
        }
      }
    }
  }
}
