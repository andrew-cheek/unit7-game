import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Ground height under a point in the current zone (for impact placement). */
  groundY: (x: number, z: number) => number
  /** Player focus position, for the near-impact camera kick. */
  focus: () => THREE.Vector3
  /** Fired when a meteor lands; `strength` is 0..1 by proximity to the player. */
  onImpact?: (pos: THREE.Vector3, strength: number) => void
}

interface Meteor {
  head: THREE.Mesh
  trail: THREE.Mesh
  vel: THREE.Vector3
  target: THREE.Vector3 // impact point (so we know when it lands)
  active: boolean
}
interface Impact {
  flash: THREE.Mesh
  ring: THREE.Mesh
  t: number
  active: boolean
}
interface Debris {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  t: number
  active: boolean
}

const AREA = 150 // meteors rain over a +/-AREA square around the origin

/**
 * Moon-only ambient spectacle: a steady meteor shower. Rocks streak out of the
 * dark lunar sky, slam into the regolith with a flash + an expanding dust ring,
 * and kick debris chunks that arc up and settle slowly in the low gravity. Pure
 * set dressing - no colliders - but a close strike kicks the camera so it reads
 * as physical. Everything is pooled; nothing allocates per impact.
 */
export class MeteorShower implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private meteors: Meteor[] = []
  private impacts: Impact[] = []
  private debris: Debris[] = []
  private zone: Zone = 'earth'
  private spawnTimer = 1.2
  private scratch = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const med = config.tier.name === 'medium'
    const meteorN = low ? 5 : med ? 9 : 14
    const impactN = low ? 4 : 8
    const debrisN = low ? 10 : 24

    const headGeo = this.ownG(new THREE.SphereGeometry(0.6, 8, 6))
    const trailGeo = this.ownG(new THREE.ConeGeometry(0.5, 7, 7))
    const headMat = this.own(new THREE.MeshBasicMaterial({ color: 0xfff0c0, fog: false }))
    const trailMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    for (let i = 0; i < meteorN; i++) {
      const head = new THREE.Mesh(headGeo, headMat)
      const trail = new THREE.Mesh(trailGeo, trailMat)
      head.visible = false; trail.visible = false
      this.group.add(head, trail)
      this.meteors.push({ head, trail, vel: new THREE.Vector3(), target: new THREE.Vector3(), active: false })
    }

    const flashGeo = this.ownG(new THREE.SphereGeometry(1, 12, 8))
    const ringGeo = this.ownG(new THREE.RingGeometry(0.7, 1, 28))
    for (let i = 0; i < impactN; i++) {
      const flashMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }))
      const flash = new THREE.Mesh(flashGeo, flashMat)
      const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = -Math.PI / 2
      flash.visible = false; ring.visible = false
      this.group.add(flash, ring)
      this.impacts.push({ flash, ring, t: 0, active: false })
    }

    const debrisGeo = this.ownG(new THREE.IcosahedronGeometry(0.35, 0))
    const debrisMat = this.own(new THREE.MeshStandardMaterial({ color: 0x6a6a73, emissive: 0xff6a2a, emissiveIntensity: 0.5, roughness: 0.9, metalness: 0.1 }))
    for (let i = 0; i < debrisN; i++) {
      const mesh = new THREE.Mesh(debrisGeo, debrisMat)
      mesh.visible = false
      this.group.add(mesh)
      this.debris.push({ mesh, vel: new THREE.Vector3(), t: 0, active: false })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'moon'
    if (zone !== 'moon') {
      // Park the pool so we don't re-enter mid-streak on the next visit.
      for (const m of this.meteors) { m.active = false; m.head.visible = false; m.trail.visible = false }
      for (const im of this.impacts) { im.active = false; im.flash.visible = false; im.ring.visible = false }
      for (const d of this.debris) { d.active = false; d.mesh.visible = false }
      this.spawnTimer = 1.2
    }
  }

  update(dt: number) {
    if (this.zone !== 'moon') return

    this.spawnTimer -= dt
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.5 + Math.random() * 1.1
      this.launch()
    }

    // Low-G factor so debris hangs the way it should on the Moon.
    const g = config.zones.moon.gravity

    for (const m of this.meteors) {
      if (!m.active) continue
      m.head.position.addScaledVector(m.vel, dt)
      // Point the trail back along the velocity, sitting just behind the head.
      this.scratch.copy(m.vel).normalize()
      m.trail.position.copy(m.head.position).addScaledVector(this.scratch, -3.5)
      this.scratch.multiplyScalar(-1) // trail cone points back up the path
      m.trail.quaternion.setFromUnitVectors(UP, this.scratch)
      if (m.head.position.y <= m.target.y) {
        m.active = false; m.head.visible = false; m.trail.visible = false
        this.impact(m.target)
      }
    }

    for (const im of this.impacts) {
      if (!im.active) continue
      im.t += dt
      const k = im.t / 0.6
      if (k >= 1) { im.active = false; im.flash.visible = false; im.ring.visible = false; continue }
      ;(im.flash.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k * 1.6))
      im.flash.scale.setScalar(1 + k * 4)
      ;(im.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.8 * (1 - k))
      im.ring.scale.setScalar(1 + k * 12)
    }

    for (const d of this.debris) {
      if (!d.active) continue
      d.t += dt
      d.vel.y += g * dt // moon gravity (negative) -> slow arc
      d.mesh.position.addScaledVector(d.vel, dt)
      d.mesh.rotation.x += dt * 3; d.mesh.rotation.z += dt * 2
      if (d.t > 2.4) { d.active = false; d.mesh.visible = false }
    }
  }

  /** Send a meteor streaking toward a random ground point. */
  private launch() {
    const m = this.meteors.find((x) => !x.active)
    if (!m) return
    const tx = (Math.random() * 2 - 1) * AREA
    const tz = (Math.random() * 2 - 1) * AREA
    const ty = this.deps.groundY(tx, tz)
    m.target.set(tx, ty, tz)
    // Come in at a shallow-ish angle from a random heading.
    const a = Math.random() * Math.PI * 2
    const reach = 90 + Math.random() * 40
    m.head.position.set(tx + Math.cos(a) * reach * 0.5, ty + 120, tz + Math.sin(a) * reach * 0.5)
    m.vel.set(m.target.x - m.head.position.x, m.target.y - m.head.position.y, m.target.z - m.head.position.z)
    m.vel.normalize().multiplyScalar(70 + Math.random() * 30)
    m.active = true; m.head.visible = true; m.trail.visible = true
  }

  /** Flash + dust ring + debris at an impact point, and a camera kick if near. */
  private impact(pos: THREE.Vector3) {
    const im = this.impacts.find((x) => !x.active)
    if (im) {
      im.active = true; im.t = 0
      im.flash.position.copy(pos); im.flash.position.y += 0.5
      im.ring.position.copy(pos); im.ring.position.y += 0.1
      im.flash.scale.setScalar(1); im.ring.scale.setScalar(1)
      im.flash.visible = true; im.ring.visible = true
    }
    // Kick up a handful of debris chunks.
    let spawned = 0
    for (const d of this.debris) {
      if (d.active || spawned >= 4) continue
      d.active = true; d.t = 0
      d.mesh.position.copy(pos); d.mesh.position.y += 0.4
      const a = Math.random() * Math.PI * 2
      const out = 3 + Math.random() * 5
      d.vel.set(Math.cos(a) * out, 6 + Math.random() * 5, Math.sin(a) * out)
      d.mesh.visible = true
      spawned++
    }
    // Proximity camera kick.
    const f = this.deps.focus()
    const dx = pos.x - f.x, dz = pos.z - f.z
    const dist = Math.hypot(dx, dz)
    if (dist < 60) this.deps.onImpact?.(pos.clone(), 1 - dist / 60)
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}

const UP = new THREE.Vector3(0, 1, 0)
