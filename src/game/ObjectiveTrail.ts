import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ so each chevron sits on the floor. */
  groundY: (x: number, z: number) => number
  /** Current objective goal world position, or null when there is none. */
  target: () => THREE.Vector3 | null
}

/**
 * A glowing breadcrumb trail: evenly-spaced flat chevrons laid on the ground from
 * the player toward the active objective beacon, flowing forward and fading with
 * distance, so you always know which way to go. Earth-only, pure guidance: no
 * colliders, no gameplay. A pooled shared geometry + one additive material.
 */
export class ObjectiveTrail implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private chevrons: THREE.Mesh[] = []
  private mat: THREE.MeshBasicMaterial
  private zone: Zone = 'earth'
  private t = 0
  private readonly spacing = 4 // distance between chevrons along the line
  private readonly lead = 6 // how far ahead of the player the trail starts
  private readonly minDist = 14 // hide the trail once you are basically there
  // Scratch vectors reused every frame; no per-frame heap allocation.
  private dir = new THREE.Vector3()
  private pos = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const n = config.tier.name === 'low' ? 14 : 22

    // A flat chevron arrow pointing toward +Z (the direction of travel), baked
    // to lie on the ground. Built from a thin two-pronged shape.
    const shape = new THREE.Shape()
    shape.moveTo(0, 0.9)
    shape.lineTo(0.8, -0.1)
    shape.lineTo(0.45, -0.1)
    shape.lineTo(0, 0.45)
    shape.lineTo(-0.45, -0.1)
    shape.lineTo(-0.8, -0.1)
    shape.lineTo(0, 0.9)
    const geo = this.ownG(new THREE.ShapeGeometry(shape))
    geo.rotateX(-Math.PI / 2) // flat on the ground, point facing +Z

    this.mat = this.own(new THREE.MeshBasicMaterial({
      color: 0x9bff6a, transparent: true, opacity: 0, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))

    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(geo, this.mat)
      mesh.visible = false
      this.group.add(mesh)
      this.chevrons.push(mesh)
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
    const target = onEarth ? this.deps.target() : null
    const f = this.deps.focus()

    // No active objective, off-Earth, or close enough to not need guiding: hide.
    if (!target) {
      if (this.group.visible) this.group.visible = false
      return
    }
    this.dir.set(target.x - f.x, 0, target.z - f.z)
    const dist = this.dir.length()
    if (dist < this.minDist) {
      if (this.group.visible) this.group.visible = false
      return
    }
    if (!this.group.visible) this.group.visible = true

    this.t += dt
    this.dir.multiplyScalar(1 / dist) // normalize in XZ
    const yaw = Math.atan2(this.dir.x, this.dir.z) // mesh points +Z, so x/z
    // Flow offset marches the chevrons toward the goal, wrapping per spacing.
    const flow = (this.t * 3) % this.spacing
    // Leave a small gap before the target so the last chevron does not overlap it.
    const usable = dist - this.minDist * 0.4

    for (let i = 0; i < this.chevrons.length; i++) {
      const mesh = this.chevrons[i]
      const along = this.lead + flow + i * this.spacing
      if (along > usable) { if (mesh.visible) mesh.visible = false; continue }
      if (!mesh.visible) mesh.visible = true
      this.pos.set(f.x + this.dir.x * along, 0, f.z + this.dir.z * along)
      const gy = this.deps.groundY(this.pos.x, this.pos.z)
      mesh.position.set(this.pos.x, gy + 0.12, this.pos.z)
      mesh.rotation.y = yaw
      // Nearer to the player = brighter; fade out toward the goal.
      const k = 1 - along / usable
      mesh.scale.setScalar(0.8 + k * 0.5)
    }

    // One shared material drives the global brightness pulse + distance falloff.
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4)
    this.mat.opacity = 0.45 + pulse * 0.2
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
