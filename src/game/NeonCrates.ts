import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position, for smash-contact detection. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ, so crates sit on the floor. */
  groundY: (x: number, z: number) => number
  /** Called on a smash: award credits + pop a floating label at the crate. */
  onSmash: (x: number, y: number, z: number, credits: number) => void
}

/**
 * Smashable neon crates: glowing street containers you burst by running through
 * them. On contact a crate vanishes, fires a pooled additive shard-burst, and
 * pays a few credits via a Game callback, then respawns after a cooldown so the
 * streets stay populated. Earth-gated; shared geo + pooled bursts, disposed together.
 *
 * Every crate is the same two boxes (dark body + neon wireframe edge), so both
 * are drawn as a single InstancedMesh each: ~36 per-crate draws collapse to 2.
 * Crates bob/spin, so per-instance matrices are rebuilt each frame from cheap
 * scratch objects (no per-frame heap allocation). Per-crate edge tint rides on
 * instanceColor; the global neon pulse rides on the (single) edge material's
 * opacity, identical to the old per-child opacity write. Smashed/cooled crates
 * are hidden by writing a zero-scale matrix.
 */

interface Crate {
  x: number
  y: number // ground height the crate sits on
  z: number
  rot: number // current spin angle
  scale: number // current uniform scale (respawn pop-in grow-back)
  visible: boolean // hidden while smashed/cooling
  credits: number
  cooldown: number // >0 = smashed, counting down to respawn
}

interface Burst {
  points: THREE.Points
  pos: Float32Array
  vel: Float32Array
  active: boolean
  life: number
}

/** Deterministic PRNG so the crate layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const SIZE = 1.2 // crate edge length
const REACH = 1.6 // horizontal smash radius
const VBAND = 2.2 // vertical band above the ground the smash is allowed in
const RESPAWN = 12 // seconds before a smashed crate returns
const SHARDS = 14 // shards per burst
const BURST_LIFE = 0.5 // seconds
const GRAVITY = 16 // units/sec^2 pulling shards down

export class NeonCrates implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private crates: Crate[] = []
  private bursts: Burst[] = []
  private zone: Zone = 'earth'
  private t = 0

  private bodyMesh!: THREE.InstancedMesh
  private edgeMesh!: THREE.InstancedMesh
  private edgeMat!: THREE.MeshBasicMaterial
  // Scratch reused every frame to avoid per-frame heap allocation.
  private mtx = new THREE.Matrix4()
  private pos = new THREE.Vector3()
  private quat = new THREE.Quaternion()
  private scl = new THREE.Vector3()
  private up = new THREE.Vector3(0, 1, 0)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 10 : 18
    const rnd = mulberry32(40404)
    const reach = config.world.half * 0.7

    // Shared geometry across every crate: a dark body box + a wireframe edge box.
    const bodyGeo = this.ownG(new THREE.BoxGeometry(SIZE, SIZE, SIZE))
    const edgeGeo = this.ownG(new THREE.BoxGeometry(SIZE * 1.02, SIZE * 1.02, SIZE * 1.02))
    // Shared dark body material; one edge material whose tint varies per instance.
    const bodyMat = this.own(new THREE.MeshBasicMaterial({ color: 0x0a0e1a, fog: true }))
    this.edgeMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const tints = [0x49e0ff, 0x9bff6a, 0xffd24a, 0xb07cff, 0xff5ad0]
    const tintColors = tints.map((t) => new THREE.Color(t))

    // Two InstancedMeshes carry all crates: collapses 2*n per-crate draws to 2.
    this.bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, n)
    this.edgeMesh = new THREE.InstancedMesh(edgeGeo, this.edgeMat, n)
    this.bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.edgeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.group.add(this.bodyMesh)
    this.group.add(this.edgeMesh)

    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const gy = this.deps.groundY(x, z)
      const tint = tintColors[(rnd() * tintColors.length) | 0]

      const rot = rnd() * Math.PI * 2
      this.crates.push({ x, y: gy, z, rot, scale: 1, visible: true, credits: 8 + ((rnd() * 8) | 0) /* 8..15 */, cooldown: 0 })

      // Per-crate edge tint via instanceColor (body stays the shared dark mat).
      this.edgeMesh.setColorAt(i, tint)
    }
    if (this.edgeMesh.instanceColor) this.edgeMesh.instanceColor.needsUpdate = true
    // Seed initial matrices so crates render correctly before the first update.
    this.writeMatrices()

    // Pooled shard bursts: relocated to wherever the latest smash happens. A small
    // pool covers two crates popping close together; never allocate per smash.
    const burstColor = new THREE.Color(0xfff2c0)
    const pool = low ? 2 : 3
    for (let b = 0; b < pool; b++) {
      const pos = new Float32Array(SHARDS * 3)
      const col = new Float32Array(SHARDS * 3)
      const vel = new Float32Array(SHARDS * 3)
      for (let i = 0; i < SHARDS; i++) {
        const i3 = i * 3
        col[i3] = burstColor.r; col[i3 + 1] = burstColor.g; col[i3 + 2] = burstColor.b
      }
      const geo = this.ownG(new THREE.BufferGeometry())
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
      const mat = this.own(new THREE.PointsMaterial({ size: low ? 0.9 : 0.7, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, fog: false }))
      const points = new THREE.Points(geo, mat)
      points.visible = false
      points.frustumCulled = false // bounds change every frame as shards fly out
      this.group.add(points)
      this.bursts.push({ points, pos, vel, active: false, life: 0 })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Rebuild every crate's instance matrix from its current state (scratch-only). */
  private writeMatrices() {
    this.scl.set(1, 1, 1)
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i]
      if (!c.visible || c.scale <= 0) {
        // Hide by collapsing to zero scale; no separate visibility flag on instances.
        this.mtx.makeScale(0, 0, 0)
      } else {
        this.pos.set(c.x, c.y + SIZE * 0.5 + Math.sin(this.t * 1.6 + c.x) * 0.12, c.z)
        this.quat.setFromAxisAngle(this.up, c.rot)
        this.scl.setScalar(c.scale)
        this.mtx.compose(this.pos, this.quat, this.scl)
      }
      this.bodyMesh.setMatrixAt(i, this.mtx)
      this.edgeMesh.setMatrixAt(i, this.mtx)
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true
    this.edgeMesh.instanceMatrix.needsUpdate = true
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
    if (zone !== 'earth') {
      for (const b of this.bursts) { b.active = false; b.life = 0; b.points.visible = false }
    }
  }

  /** Arm a free pooled burst at the crate and seed outward shard velocities. */
  private burst(cx: number, cy: number, cz: number) {
    const b = this.bursts.find((x) => !x.active)
    if (!b) return
    for (let i = 0; i < SHARDS; i++) {
      const i3 = i * 3
      // Random direction on a unit sphere, biased upward + outward.
      const u = Math.random() * 2 - 1
      const a = Math.random() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      const s = 4 + Math.random() * 4
      b.pos[i3] = cx
      b.pos[i3 + 1] = cy
      b.pos[i3 + 2] = cz
      b.vel[i3] = r * Math.cos(a) * s
      b.vel[i3 + 1] = (1 + u) * s * 0.7 + 2
      b.vel[i3 + 2] = r * Math.sin(a) * s
    }
    b.active = true
    b.life = BURST_LIFE
    b.points.visible = true
    ;(b.points.material as THREE.PointsMaterial).opacity = 1
    ;(b.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()
    const pulse = 0.85 + 0.15 * Math.sin(this.t * 3)

    for (const c of this.crates) {
      if (c.cooldown > 0) {
        c.cooldown -= dt
        if (c.cooldown <= 0) { c.visible = true; c.scale = 0.01 } // pop back in
        else continue
      }
      // Grow back to full size after a respawn pop-in.
      if (c.scale < 1) c.scale = Math.min(1, c.scale + dt * 4)
      // Idle spin (hover is folded into the per-frame matrix in writeMatrices).
      c.rot += dt * 0.4

      // Smash on contact: close in XZ and within a vertical band at ground level.
      const dx = c.x - f.x, dz = c.z - f.z
      if (c.visible && dx * dx + dz * dz < REACH * REACH && Math.abs(f.y - c.y) < VBAND) {
        this.burst(c.x, c.y + SIZE * 0.6, c.z)
        this.deps.onSmash(c.x, c.y + SIZE * 0.6, c.z, c.credits)
        c.cooldown = RESPAWN
        c.visible = false
      }
    }

    // Global neon pulse, applied once to the shared edge material.
    this.edgeMat.opacity = pulse
    // Rebuild instance matrices for hover/spin/scale/visibility this frame.
    this.writeMatrices()

    // Animate every live burst: fly out, fall, fade.
    for (const b of this.bursts) {
      if (!b.active) continue
      b.life -= dt
      if (b.life <= 0) { b.active = false; b.points.visible = false; continue }
      for (let i = 0; i < SHARDS; i++) {
        const i3 = i * 3
        b.vel[i3 + 1] -= GRAVITY * dt
        b.pos[i3] += b.vel[i3] * dt
        b.pos[i3 + 1] += b.vel[i3 + 1] * dt
        b.pos[i3 + 2] += b.vel[i3 + 2] * dt
      }
      ;(b.points.material as THREE.PointsMaterial).opacity = b.life / BURST_LIFE
      ;(b.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    }
  }

  dispose() {
    this.bodyMesh.dispose()
    this.edgeMesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
