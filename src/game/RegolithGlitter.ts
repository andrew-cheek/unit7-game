import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Zone read each update so the field hard-hides off the Moon. */
  zone: () => Zone
  /** Sampled ground height at an XZ, so sparkles + ice decals sit on the surface. */
  groundY: (x: number, z: number) => number
  /** Optional focus (player) position; the glitter group re-centers near it so
   *  density stays around the camera. Only XZ is used; cheap group-level move. */
  focus?: () => THREE.Vector3
}

/** Deterministic PRNG so the glitter field is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * MOON-only ambient sparkle for the lunar surface, which otherwise reads as flat
 * grey. Two cheap additive draws, ~2 total:
 *   1. A single THREE.Points cloud of tiny size-attenuated pale-cyan sparkle
 *      points scattered across the regolith, snapped to the surface height.
 *   2. One additive InstancedMesh of flat ice/frost decals (circles laid flat,
 *      cool blue) sitting on a few seeded spots.
 *
 * Render-only set dressing: it never touches the simulation, has no colliders and
 * no rewards. update() only nudges a couple of SHARED material opacities (a global
 * twinkle on the points, a slow shimmer on the ice) - no per-point work, zero
 * per-frame heap allocation. Under config.reducedMotion (read live each update)
 * the twinkle/shimmer flatten to a steady low opacity.
 *
 * Moon-gated + tier-gated. Tier counts (config.tier.name):
 *   sparkles: high 2500, medium 1200, low 400
 *   ice decals: high 14,  medium 8,    low 4
 * Disposed together (points geo+mat, ice geo+mat, instanced mesh).
 */
export class RegolithGlitter implements GameSystem {
  private group = new THREE.Group()
  private zone: Zone = 'earth'
  private t = 0

  private pointsGeo!: THREE.BufferGeometry
  private pointsMat!: THREE.PointsMaterial
  private iceGeo!: THREE.CircleGeometry
  private iceMat!: THREE.MeshBasicMaterial
  private iceMesh!: THREE.InstancedMesh

  // Per-build scratch (matrices written once at construction, not per frame).
  private readonly mPos = new THREE.Vector3()
  private readonly mQuat = new THREE.Quaternion()
  private readonly mScale = new THREE.Vector3()
  private readonly mEuler = new THREE.Euler()
  private readonly mMat = new THREE.Matrix4()

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const sparkleCount = tier === 'high' ? 2500 : tier === 'medium' ? 1200 : 400
    const iceCount = tier === 'high' ? 14 : tier === 'medium' ? 8 : 4

    const rnd = mulberry32(330017)
    const reach = config.world.half * 0.85

    // --- 1. sparkle point cloud --------------------------------------------
    const positions = new Float32Array(sparkleCount * 3)
    for (let i = 0; i < sparkleCount; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      // Snap to the regolith surface plus a tiny offset so dots ride just above it.
      const y = this.deps.groundY(x, z) + 0.04 + rnd() * 0.12
      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z
    }
    this.pointsGeo = new THREE.BufferGeometry()
    this.pointsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    // Wide bounding sphere so the whole field is never frustum-culled wrongly.
    this.pointsGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), reach * 2)

    // Cool white / pale-cyan, size-attenuated additive points.
    this.pointsMat = new THREE.PointsMaterial({
      color: 0xcfeaff,
      size: 0.5,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    })
    const points = new THREE.Points(this.pointsGeo, this.pointsMat)
    points.frustumCulled = false
    this.group.add(points)

    // --- 2. flat ice / frost decals ----------------------------------------
    // A single circle laid flat (default CircleGeometry faces +Z; rotate to y-up).
    this.iceGeo = new THREE.CircleGeometry(1, 16)
    this.iceMat = new THREE.MeshBasicMaterial({
      color: 0x8fd0ff,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    })
    this.iceMesh = new THREE.InstancedMesh(this.iceGeo, this.iceMat, iceCount)
    this.iceMesh.frustumCulled = false

    this.mEuler.set(-Math.PI / 2, 0, 0) // face up
    for (let i = 0; i < iceCount; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const gy = this.deps.groundY(x, z)
      const r = 1.6 + rnd() * 3.4
      // Slight per-decal spin around up plus the lay-flat tilt.
      this.mEuler.set(-Math.PI / 2, 0, rnd() * 6.28)
      this.mQuat.setFromEuler(this.mEuler)
      this.mPos.set(x, gy + 0.03, z)
      this.mScale.set(r, r * (0.7 + rnd() * 0.5), 1)
      this.mMat.compose(this.mPos, this.mQuat, this.mScale)
      this.iceMesh.setMatrixAt(i, this.mMat)
    }
    this.iceMesh.instanceMatrix.needsUpdate = true
    this.group.add(this.iceMesh)

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'moon'
  }

  update(dt: number) {
    const active = this.deps.zone() === 'moon'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return
    this.t += dt

    // Keep the glitter centered near the player (XZ only) so density follows them.
    // Cheap: just moves the group, no per-point work. y stays at 0.
    if (this.deps.focus) {
      const f = this.deps.focus()
      this.group.position.x = f.x
      this.group.position.z = f.z
    }

    // Live reducedMotion read: hold a steady low opacity instead of twinkling.
    if (config.reducedMotion) {
      this.pointsMat.opacity = 0.5
      this.iceMat.opacity = 0.22
      return
    }

    // Gentle GLOBAL twinkle - one shared opacity value, not per-point.
    const twinkle = 0.5 + 0.5 * Math.sin(this.t * 1.4)
    this.pointsMat.opacity = 0.45 + twinkle * 0.4
    // Very slow shared shimmer on the ice decals, offset from the twinkle.
    const shimmer = 0.5 + 0.5 * Math.sin(this.t * 0.45 + 1.1)
    this.iceMat.opacity = 0.18 + shimmer * 0.22
  }

  dispose() {
    this.iceMesh.dispose()
    this.pointsGeo.dispose()
    this.pointsMat.dispose()
    this.iceGeo.dispose()
    this.iceMat.dispose()
  }
}
