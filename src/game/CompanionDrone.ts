import * as THREE from 'three'
import type { GameSystem } from './System'

interface Deps {
  /** Player position to trail. */
  focus: () => THREE.Vector3
  /** Player facing (radians), so the drone tucks behind a shoulder. */
  yaw: () => number
  /** Only show while on foot as the robot (not in a vehicle / minigame / morphed). */
  active: () => boolean
}

/**
 * A little hover-drone buddy that trails the player around every zone - bobbing
 * at your shoulder with a blinking eye and a soft hover glow. Pure character; no
 * gameplay, no colliders. Smoothly lags behind so it feels alive, and tucks away
 * whenever you're piloting something or in a minigame.
 */
export class CompanionDrone implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private eyeMat: THREE.MeshBasicMaterial
  private glowMat: THREE.MeshBasicMaterial
  private rotors: THREE.Object3D[] = []
  private pos = new THREE.Vector3()
  private vel = new THREE.Vector3()
  private scratch = new THREE.Vector3()
  private t = 0
  private placed = false

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x223049, metalness: 0.7, roughness: 0.4, emissive: 0x0c2236, emissiveIntensity: 0.5 }))
    const trimMat = this.own(new THREE.MeshStandardMaterial({ color: 0xdfe6f2, metalness: 0.6, roughness: 0.4 }))
    this.eyeMat = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, fog: false }))
    this.glowMat = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    const body = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.32, 14, 12)), bodyMat); body.scale.set(1, 0.85, 1); this.group.add(body)
    const collar = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(0.3, 0.05, 8, 18)), trimMat); collar.rotation.x = Math.PI / 2; this.group.add(collar)
    const eye = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.12, 10, 8)), this.eyeMat); eye.position.set(0, 0.02, 0.28); this.group.add(eye)
    const halo = new THREE.Mesh(this.ownG(new THREE.RingGeometry(0.14, 0.2, 16)), this.glowMat); halo.position.set(0, 0.02, 0.29); this.group.add(halo)
    // Hover glow + little rotor discs to either side.
    const under = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(0.4, 18)), this.glowMat); under.rotation.x = -Math.PI / 2; under.position.y = -0.34; this.group.add(under)
    const armMat = trimMat
    const rotorGeo = this.ownG(new THREE.CircleGeometry(0.16, 12))
    for (const sx of [-0.42, 0.42]) {
      const arm = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, 0.05, 0.08)), armMat); arm.position.set(sx * 0.5, 0, 0); this.group.add(arm)
      const r = new THREE.Mesh(rotorGeo, this.glowMat); r.rotation.x = -Math.PI / 2; r.position.set(sx, 0.06, 0); this.group.add(r); this.rotors.push(r)
    }
    // A stubby antenna.
    const ant = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 6)), trimMat); ant.position.set(0, 0.34, -0.05); this.group.add(ant)
    const tip = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.04, 8, 6)), this.eyeMat); tip.position.set(0, 0.44, -0.05); this.group.add(tip)

    this.group.visible = false
    scene.add(this.group)
  }

  update(dt: number) {
    if (!this.deps.active()) { if (this.group.visible) this.group.visible = false; this.placed = false; return }
    this.group.visible = true
    this.t += dt

    const p = this.deps.focus()
    const yaw = this.deps.yaw()
    // Rest spot: up at head height, behind and over the LEFT shoulder.
    const back = 1.05, side = 0.95, height = 2.1
    const tx = p.x - Math.sin(yaw) * back - Math.cos(yaw) * side
    const tz = p.z - Math.cos(yaw) * back + Math.sin(yaw) * side
    const ty = p.y + height + Math.sin(this.t * 2) * 0.12 // gentle bob
    this.scratch.set(tx, ty, tz)

    if (!this.placed) { this.pos.copy(this.scratch); this.vel.set(0, 0, 0); this.placed = true }
    else {
      // Critically-damped-ish spring so it lags then catches up smoothly.
      const k = Math.min(1, dt * 6)
      this.vel.x += (this.scratch.x - this.pos.x) * k - this.vel.x * k
      this.vel.y += (this.scratch.y - this.pos.y) * k - this.vel.y * k
      this.vel.z += (this.scratch.z - this.pos.z) * k - this.vel.z * k
      this.pos.addScaledVector(this.vel, Math.min(1, dt * 9))
    }
    this.group.position.copy(this.pos)
    // Face roughly toward the player, plus a little idle sway.
    this.group.rotation.y = Math.atan2(p.x - this.pos.x, p.z - this.pos.z) + Math.sin(this.t * 0.8) * 0.15
    this.group.rotation.z = Math.sin(this.t * 1.3) * 0.06
    // Blink: eye dims briefly on a slow cycle.
    const blink = Math.sin(this.t * 0.7)
    this.eyeMat.opacity = blink > 0.96 ? 0.2 : 1
    this.eyeMat.transparent = true
    this.glowMat.opacity = 0.4 + (0.5 + 0.5 * Math.sin(this.t * 3)) * 0.25
    for (const r of this.rotors) r.rotation.z += dt * 30
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
