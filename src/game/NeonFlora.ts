import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  groundY: (x: number, z: number) => number
  focus: () => THREE.Vector3
}

/** One spike's static local transform within its cluster (pre-sway/scale). */
interface Spike {
  frondMatrix: THREE.Matrix4 // local frond transform (offset/rotation/scale)
  podMatrix: THREE.Matrix4 // local pod transform
}

interface Cluster {
  baseOpacity: number
  glow: number // eased 0..1 reactive brightness
  phase: number
  x: number
  z: number
  posY: number
  color: THREE.Color // base tint
  first: number // index of this cluster's first spike in the instanced arrays
  count: number // number of spikes in this cluster
  spikes: Spike[]
}

/** Deterministic PRNG so the field is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Bio-luminescent neon flora scattered across the Earth city: little clusters of
 * glowing crystal-fronds that sway and pulse, and brighten + bloom as you pass
 * close - a touch of reactive, magical ground-level life. Additive, no colliders,
 * pooled + Earth-gated, disposed together.
 *
 * GPU-instanced: all fronds share one InstancedMesh, all pods share another, so
 * the whole field renders in ~2 draw calls instead of one mesh per spike-part.
 * The per-cluster glow pulse (originally a per-cluster material opacity tween)
 * is reproduced via per-instance colour brightness (setColorAt) - additive
 * blending makes brightening the colour visually equivalent to raising opacity.
 * Per-cluster sway/scale is baked into the instance matrices each frame using a
 * single scratch Matrix4 (no per-frame allocation).
 */
export class NeonFlora implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private clusters: Cluster[] = []
  private zone: Zone = 'earth'
  private t = 0

  private fronds!: THREE.InstancedMesh
  private pods!: THREE.InstancedMesh

  // Scratch objects reused every frame - no per-frame heap allocation.
  private mCluster = new THREE.Matrix4()
  private mFinal = new THREE.Matrix4()
  private cScratch = new THREE.Color()
  private pos = new THREE.Vector3()
  private quat = new THREE.Quaternion()
  private scl = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 16 : 38
    const rnd = mulberry32(70077)
    const reach = config.world.half * 0.9
    const tints = [0x49e0ff, 0x9bff6a, 0xff5ad0, 0xb07cff, 0xffd24a]
    // Shared frond geometry (a slim glowing spike).
    const frondGeo = this.ownG(new THREE.ConeGeometry(0.16, 1.8, 5))
    const podGeo = this.ownG(new THREE.SphereGeometry(0.22, 8, 6))

    // First pass: build clusters + spike local transforms, count total spikes.
    let total = 0
    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const tint = tints[(rnd() * tints.length) | 0]
      const gy = this.deps.groundY(x, z)
      const spikeCount = 3 + ((rnd() * 3) | 0)
      const spikes: Spike[] = []
      for (let s = 0; s < spikeCount; s++) {
        const a = (s / spikeCount) * Math.PI * 2 + rnd()
        const lean = 0.15 + rnd() * 0.25
        const h = 0.7 + rnd() * 0.8
        // Frond: scale (1,h,1), position, rotation (Euler XYZ to match Mesh.rotation.set).
        const frondMatrix = new THREE.Matrix4()
        frondMatrix.compose(
          this.pos.set(Math.cos(a) * 0.3, h * 0.9, Math.sin(a) * 0.3),
          this.quat.setFromEuler(new THREE.Euler(Math.cos(a) * lean, 0, -Math.sin(a) * lean, 'XYZ')),
          this.scl.set(1, h, 1),
        )
        // Pod: position, uniform scale 0.7, no rotation.
        const podMatrix = new THREE.Matrix4()
        podMatrix.compose(
          this.pos.set(Math.cos(a) * 0.3, h * 1.7, Math.sin(a) * 0.3),
          this.quat.identity(),
          this.scl.setScalar(0.7),
        )
        spikes.push({ frondMatrix, podMatrix })
      }
      this.clusters.push({
        baseOpacity: 0.5, glow: 0, phase: rnd() * 6.28, x, z,
        posY: gy + 0.05, color: new THREE.Color(tint),
        first: total, count: spikeCount, spikes,
      })
      total += spikeCount
    }

    // One shared material per part. Per-cluster brightness comes from instanceColor,
    // not material opacity, so a single material drives the whole field.
    const frondMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))
    const podMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))

    this.fronds = new THREE.InstancedMesh(frondGeo, frondMat, total)
    this.pods = new THREE.InstancedMesh(podGeo, podMat, total)
    // One system spanning the whole map - skip culling, still only 2 draws.
    this.fronds.frustumCulled = false
    this.pods.frustumCulled = false
    this.fronds.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3)
    this.pods.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3)

    // Seed matrices + colours once (update() refreshes them each frame on Earth).
    this.writeInstances(true)
    this.fronds.instanceMatrix.needsUpdate = true
    this.pods.instanceMatrix.needsUpdate = true
    this.fronds.instanceColor!.needsUpdate = true
    this.pods.instanceColor!.needsUpdate = true

    this.group.add(this.fronds, this.pods)
    this.group.visible = false
    scene.add(this.group)
  }

  /** Recompute instance matrices + colours from current cluster glow/sway state. */
  private writeInstances(initial: boolean) {
    for (const c of this.clusters) {
      // Per-cluster animated brightness (replaces the old material.opacity tween).
      const pulse = initial ? 0.5 : 0.5 + 0.5 * Math.sin(this.t * 2 + c.phase)
      const opacity = c.baseOpacity + pulse * 0.18 + c.glow * 0.7
      // Per-cluster sway + scale, applied as a cluster-space transform.
      const sway = initial ? 0 : Math.sin(this.t * 1.3 + c.phase) * 0.04
      const scl = initial ? 1 : 1 + c.glow * 0.18 + pulse * 0.03
      this.mCluster.compose(
        this.pos.set(c.x, c.posY, c.z),
        this.quat.setFromEuler(new THREE.Euler(0, 0, sway, 'XYZ')),
        this.scl.set(scl, scl, scl),
      )
      // Brightness scales the base tint (additive blend => brighter == "more opaque").
      this.cScratch.copy(c.color).multiplyScalar(opacity)
      for (let s = 0; s < c.count; s++) {
        const idx = c.first + s
        const sp = c.spikes[s]
        this.mFinal.multiplyMatrices(this.mCluster, sp.frondMatrix)
        this.fronds.setMatrixAt(idx, this.mFinal)
        this.mFinal.multiplyMatrices(this.mCluster, sp.podMatrix)
        this.pods.setMatrixAt(idx, this.mFinal)
        this.fronds.setColorAt(idx, this.cScratch)
        this.pods.setColorAt(idx, this.cScratch)
      }
    }
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()
    for (const c of this.clusters) {
      // Reactive: brighten + bloom when the player is close, ease back when not.
      const dx = c.x - f.x, dz = c.z - f.z
      const near = dx * dx + dz * dz < 13 * 13 ? 1 : 0
      c.glow += (near - c.glow) * Math.min(1, dt * 4)
    }
    this.writeInstances(false)
    this.fronds.instanceMatrix.needsUpdate = true
    this.pods.instanceMatrix.needsUpdate = true
    this.fronds.instanceColor!.needsUpdate = true
    this.pods.instanceColor!.needsUpdate = true
  }

  dispose() {
    this.fronds.dispose()
    this.pods.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
