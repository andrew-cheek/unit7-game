import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Local player position (for proximity brightening). */
  playerPos: () => THREE.Vector3
  /** Current zone, so we can hard-gate to Mars each update (group.visible). */
  zone: () => Zone
  /** Ground height under a point in the current zone (so pods root to the surface). */
  groundY: (x: number, z: number) => number
}

/** One pod's static local transform within its cluster (pre-sway/pulse). */
interface Pod {
  podMatrix: THREE.Matrix4 // local pod (sphere) transform
  tendrilMatrix: THREE.Matrix4 // local tendril (cone) transform
}

interface Cluster {
  glow: number // eased 0..1 reactive brightness (player proximity)
  phase: number
  x: number
  z: number
  posY: number
  color: THREE.Color // base alien tint (greens / purples)
  first: number // index of this cluster's first pod in the instanced arrays
  count: number // number of pods in this cluster
  pods: Pod[]
}

/** Deterministic PRNG so the field is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Mars-only ambient set dressing: alien bioluminescent pod clusters. Little
 * groves of glowing emissive pods (spheres in alien greens/purples) root to the
 * red-planet surface, each trailing a thin tendril (cone) that gently sways and
 * pulses. They brighten + bloom as the player passes close - a touch of living
 * ground-level glow under the dust-storm sky. Additive, no colliders, pure
 * additive set-dressing; pooled + Mars-gated; disposed together.
 *
 * GPU-instanced like NeonFlora: all pods share one InstancedMesh, all tendrils
 * share another, so the whole field renders in ~2 draw calls instead of one mesh
 * per part. The per-cluster pulse + proximity glow is reproduced via per-instance
 * colour brightness (setColorAt) - additive blending makes brightening the colour
 * visually equivalent to raising opacity. Per-cluster sway/scale is baked into the
 * instance matrices each frame using a single scratch Matrix4 (no per-frame alloc).
 */
export class BiolumiPods implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private clusters: Cluster[] = []
  private zone: Zone = 'earth'
  private t = 0

  // Render-only throttle (never feeds physics): rewrite instances every Nth sim
  // step on low/medium. high = 0 => original every-frame path, unchanged.
  // medium ~1*fixedDelta (every 2nd step), low ~2*fixedDelta (every 3rd step).
  private interval: number
  private acc = 0
  // On low/medium, clusters past this XZ distance from the player are invisible
  // through the Mars dust fog, so we skip rewriting their matrices/colours.
  private cullDist2: number

  private podsMesh!: THREE.InstancedMesh
  private tendrilsMesh!: THREE.InstancedMesh

  // Scratch objects reused every frame - no per-frame heap allocation.
  private mCluster = new THREE.Matrix4()
  private mFinal = new THREE.Matrix4()
  private cScratch = new THREE.Color()
  private pos = new THREE.Vector3()
  private quat = new THREE.Quaternion()
  private scl = new THREE.Vector3()
  private eul = new THREE.Euler()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const name = config.tier.name
    // Tier-gated count: minimal on low, fewer on medium, full on high.
    const n = name === 'low' ? 12 : name === 'medium' ? 28 : 48
    const fd = config.render.fixedDelta
    this.interval = name === 'low' ? fd * 2 : name === 'medium' ? fd * 1 : 0
    // high: no culling (Infinity => every cluster always rewritten); low/medium
    // skip clusters beyond ~60m (lost in the fog) during the throttled rewrite.
    this.cullDist2 = name === 'high' ? Infinity : 60 * 60
    const rnd = mulberry32(540431)
    // Off-world fields are sparser than Earth - scatter over a wide square.
    const reach = 150
    const tints = [0x6bff9a, 0x9bff6a, 0x4affd0, 0xb07cff, 0xd05aff, 0x7affc8]
    // Shared geometry: a small emissive pod sphere and a slim trailing tendril.
    const podGeo = this.ownG(new THREE.SphereGeometry(0.26, 8, 6))
    const tendrilGeo = this.ownG(new THREE.ConeGeometry(0.07, 1.4, 5))

    // First pass: build clusters + pod local transforms, count total pods.
    let total = 0
    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const tint = tints[(rnd() * tints.length) | 0]
      const gy = this.deps.groundY(x, z)
      const podCount = 3 + ((rnd() * 4) | 0) // 3..6 pods per cluster
      const pods: Pod[] = []
      for (let s = 0; s < podCount; s++) {
        const a = (s / podCount) * Math.PI * 2 + rnd()
        const rad = 0.25 + rnd() * 0.5
        const lean = 0.12 + rnd() * 0.25
        const h = 0.6 + rnd() * 0.7 // pod height above ground
        // Pod: small sphere sitting atop a tendril; slight size variation.
        const podScale = 0.7 + rnd() * 0.5
        const podMatrix = new THREE.Matrix4()
        podMatrix.compose(
          this.pos.set(Math.cos(a) * rad, h, Math.sin(a) * rad),
          this.quat.identity(),
          this.scl.setScalar(podScale),
        )
        // Tendril: thin cone rooted near the surface, leaning under the pod.
        const tendrilMatrix = new THREE.Matrix4()
        tendrilMatrix.compose(
          this.pos.set(Math.cos(a) * rad * 0.85, h * 0.5, Math.sin(a) * rad * 0.85),
          this.quat.setFromEuler(this.eul.set(Math.cos(a) * lean, 0, -Math.sin(a) * lean, 'XYZ')),
          this.scl.set(1, h / 0.7, 1),
        )
        pods.push({ podMatrix, tendrilMatrix })
      }
      this.clusters.push({
        glow: 0, phase: rnd() * 6.28, x, z,
        posY: gy + 0.04, color: new THREE.Color(tint),
        first: total, count: podCount, pods,
      })
      total += podCount
    }

    // One shared material per part. Per-cluster brightness comes from instanceColor,
    // not material opacity, so a single material drives the whole field.
    const podMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))
    const tendrilMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))

    this.podsMesh = new THREE.InstancedMesh(podGeo, podMat, total)
    this.tendrilsMesh = new THREE.InstancedMesh(tendrilGeo, tendrilMat, total)
    // One system spanning the whole field - skip culling, still only 2 draws.
    this.podsMesh.frustumCulled = false
    this.tendrilsMesh.frustumCulled = false
    this.podsMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3)
    this.tendrilsMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3)

    // Seed matrices + colours once (update() refreshes them each frame on Mars).
    this.writeInstances(true)
    this.podsMesh.instanceMatrix.needsUpdate = true
    this.tendrilsMesh.instanceMatrix.needsUpdate = true
    this.podsMesh.instanceColor!.needsUpdate = true
    this.tendrilsMesh.instanceColor!.needsUpdate = true

    this.group.add(this.podsMesh, this.tendrilsMesh)
    this.group.visible = false
    scene.add(this.group)
  }

  /**
   * Recompute instance matrices + colours from current cluster glow/sway state.
   * On low/medium, `px`/`pz` are the player position and clusters beyond
   * `cullDist2` are skipped (lost in the fog). Returns true if any cluster was
   * actually rewritten, so callers only flag the GPU uploads when needed.
   * On high `cullDist2` is Infinity, so every cluster is rewritten (unchanged).
   */
  private writeInstances(initial: boolean, px = 0, pz = 0): boolean {
    let wrote = false
    for (const c of this.clusters) {
      // Skip far clusters during the throttled rewrite (high: cullDist2 = Infinity).
      if (!initial) {
        const dx = c.x - px, dz = c.z - pz
        if (dx * dx + dz * dz > this.cullDist2) continue
      }
      wrote = true
      // Per-cluster animated brightness (a pulse) plus reactive proximity glow.
      const pulse = initial ? 0.5 : 0.5 + 0.5 * Math.sin(this.t * 1.7 + c.phase)
      const brightness = 0.4 + pulse * 0.22 + c.glow * 0.7
      // Per-cluster sway + gentle pulse scale, applied as a cluster-space transform.
      const sway = initial ? 0 : Math.sin(this.t * 1.1 + c.phase) * 0.05
      const scl = initial ? 1 : 1 + c.glow * 0.16 + pulse * 0.04
      this.mCluster.compose(
        this.pos.set(c.x, c.posY, c.z),
        this.quat.setFromEuler(this.eul.set(0, 0, sway, 'XYZ')),
        this.scl.set(scl, scl, scl),
      )
      // Brightness scales the base tint (additive blend => brighter == "more opaque").
      this.cScratch.copy(c.color).multiplyScalar(brightness)
      for (let s = 0; s < c.count; s++) {
        const idx = c.first + s
        const p = c.pods[s]
        this.mFinal.multiplyMatrices(this.mCluster, p.podMatrix)
        this.podsMesh.setMatrixAt(idx, this.mFinal)
        this.mFinal.multiplyMatrices(this.mCluster, p.tendrilMatrix)
        this.tendrilsMesh.setMatrixAt(idx, this.mFinal)
        this.podsMesh.setColorAt(idx, this.cScratch)
        this.tendrilsMesh.setColorAt(idx, this.cScratch)
      }
    }
    return wrote
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'mars'
  }

  update(dt: number) {
    // Hard zone gate each update, mirroring DustDevils: Mars-only.
    const onMars = this.deps.zone() === 'mars'
    if (this.group.visible !== onMars) this.group.visible = onMars
    if (!onMars) return

    if (this.interval === 0) {
      // high: original every-frame path, unchanged.
      this.t += dt
      const f = this.deps.playerPos()
      this.advanceGlow(dt, f.x, f.z)
      this.writeInstances(false)
      this.podsMesh.instanceMatrix.needsUpdate = true
      this.tendrilsMesh.instanceMatrix.needsUpdate = true
      this.podsMesh.instanceColor!.needsUpdate = true
      this.tendrilsMesh.instanceColor!.needsUpdate = true
      return
    }

    // low/medium: keep time + glow advancing every step (continuous motion), but
    // only rewrite instances on throttled steps, integrating with the accumulated
    // sub-dt so the pulse/sway/glow rates are unchanged.
    this.acc += dt
    if (this.acc < this.interval) return
    const sub = this.acc
    this.acc = 0
    this.t += sub
    const f = this.deps.playerPos()
    this.advanceGlow(sub, f.x, f.z)
    // Skip far clusters; only flag the GPU uploads if at least one was rewritten.
    if (this.writeInstances(false, f.x, f.z)) {
      this.podsMesh.instanceMatrix.needsUpdate = true
      this.tendrilsMesh.instanceMatrix.needsUpdate = true
      this.podsMesh.instanceColor!.needsUpdate = true
      this.tendrilsMesh.instanceColor!.needsUpdate = true
    }
  }

  /** Ease each cluster's proximity glow toward its target over `dt` seconds. */
  private advanceGlow(dt: number, px: number, pz: number) {
    for (const c of this.clusters) {
      // Reactive: brighten + bloom when the player is close, ease back when not.
      const dx = c.x - px, dz = c.z - pz
      const near = dx * dx + dz * dz < 12 * 12 ? 1 : 0
      // Frame-rate-independent exponential approach toward the target glow.
      c.glow += (near - c.glow) * Math.min(1, dt * 4)
    }
  }

  dispose() {
    this.podsMesh.dispose()
    this.tendrilsMesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
