// NeonManager — keeps the city's decorative neon (roofline trim, spines, light
// bands, signs) under control for both *look* and *performance*:
//  - density: a live 0..1 dial. Each neon piece has a stable "keep" threshold;
//    lowering density hides the pieces above it, thinning the neon evenly so the
//    city reads calmer and draws fewer transparent/emissive meshes.
//  - distance culling: neon beyond a radius of the player is hidden (throttled),
//    a cheap LOD so the far field isn't rendering hundreds of glow meshes.
//
// The meshes themselves are created + disposed by World; this only toggles their
// visibility, so it adds no allocation.

import * as THREE from 'three'

interface NeonItem {
  mesh: THREE.Object3D
  keep: number // 0..1; hidden when density < keep
}

export class NeonManager {
  private items: NeonItem[] = []
  private density = 1
  private cullDist2: number
  private cullTimer = 0

  constructor(cullDistance = 210) {
    this.cullDist2 = cullDistance * cullDistance
  }

  /** Register a decorative neon mesh. `keep` (0..1) sets when density hides it. */
  add(mesh: THREE.Object3D, keep: number) {
    this.items.push({ mesh, keep })
  }

  /** Live neon density 0..1 (lower = calmer + fewer draws). */
  setDensity(d: number) {
    this.density = d
    for (const it of this.items) it.mesh.visible = it.keep <= d
  }

  /** Throttled distance LOD: hide neon far from the focus point. */
  update(dt: number, focusX: number, focusZ: number) {
    this.cullTimer -= dt
    if (this.cullTimer > 0) return
    this.cullTimer = 0.4
    for (const it of this.items) {
      if (it.keep > this.density) {
        it.mesh.visible = false
        continue
      }
      const dx = it.mesh.position.x - focusX
      const dz = it.mesh.position.z - focusZ
      it.mesh.visible = dx * dx + dz * dz <= this.cullDist2
    }
  }
}
