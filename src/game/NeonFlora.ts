import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  groundY: (x: number, z: number) => number
  focus: () => THREE.Vector3
}

interface Cluster {
  group: THREE.Group
  mat: THREE.MeshBasicMaterial
  baseOpacity: number
  glow: number // eased 0..1 reactive brightness
  phase: number
  x: number
  z: number
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
 */
export class NeonFlora implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private clusters: Cluster[] = []
  private zone: Zone = 'earth'
  private t = 0

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
    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const tint = tints[(rnd() * tints.length) | 0]
      const mat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))
      const group = new THREE.Group()
      const gy = this.deps.groundY(x, z)
      group.position.set(x, gy + 0.05, z)
      const spikes = 3 + ((rnd() * 3) | 0)
      for (let s = 0; s < spikes; s++) {
        const a = (s / spikes) * Math.PI * 2 + rnd()
        const lean = 0.15 + rnd() * 0.25
        const h = 0.7 + rnd() * 0.8
        const fr = new THREE.Mesh(frondGeo, mat)
        fr.scale.set(1, h, 1)
        fr.position.set(Math.cos(a) * 0.3, h * 0.9, Math.sin(a) * 0.3)
        fr.rotation.set(Math.cos(a) * lean, 0, -Math.sin(a) * lean)
        group.add(fr)
        const pod = new THREE.Mesh(podGeo, mat); pod.position.set(Math.cos(a) * 0.3, h * 1.7, Math.sin(a) * 0.3); pod.scale.setScalar(0.7); group.add(pod)
      }
      this.group.add(group)
      this.clusters.push({ group, mat, baseOpacity: 0.5, glow: 0, phase: rnd() * 6.28, x, z })
    }

    this.group.visible = false
    scene.add(this.group)
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
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 2 + c.phase)
      c.mat.opacity = c.baseOpacity + pulse * 0.18 + c.glow * 0.7
      const sway = Math.sin(this.t * 1.3 + c.phase) * 0.04
      c.group.rotation.z = sway
      c.group.scale.setScalar(1 + c.glow * 0.18 + pulse * 0.03)
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
