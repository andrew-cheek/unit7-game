import * as THREE from 'three'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'

/**
 * Bounded-volume-hierarchy acceleration for the camera's collision raycasts.
 *
 * The follow camera fires several rays per frame against the merged building
 * shells (whole city blocks fused into a handful of high-poly meshes), and a
 * plain raycast tests every triangle. Attaching a BVH to those geometries makes
 * the same rays log-time instead of linear, with IDENTICAL hit results — so the
 * camera behaves exactly as before, just cheaper (the win lands on the mobile
 * frame-rate floor where the per-frame ray cost bit hardest).
 *
 * `acceleratedRaycast` falls back to Three's default raycast for any mesh whose
 * geometry has no `boundsTree`, so installing it globally changes nothing for the
 * rest of the scene (ground sampling, grapple, etc.) — only meshes we explicitly
 * index get the BVH path.
 */
let registered = false

/** Install the accelerated raycast on the Three prototypes (idempotent). */
export function enableBVH() {
  if (registered) return
  registered = true
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
  THREE.Mesh.prototype.raycast = acceleratedRaycast
}

/** Build a BVH on every mesh in `objects` that doesn't already have one. Cheap to
 *  call repeatedly (indexed meshes are skipped); run it when the camera's solids
 *  change so a freshly-swapped zone's shells get indexed once. */
export function buildBVH(objects: THREE.Object3D[]) {
  for (const o of objects) {
    o.traverse((n) => {
      const m = n as THREE.Mesh
      if (m.isMesh && m.geometry && !m.geometry.boundsTree) m.geometry.computeBoundsTree()
    })
  }
}
