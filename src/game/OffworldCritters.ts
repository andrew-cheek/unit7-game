import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'
import type { Capturable } from './Game'

interface Deps {
  /** Ground height under a point in the current zone. */
  groundY: (x: number, z: number) => number
}

interface Critter {
  zone: 'moon' | 'mars'
  group: THREE.Group
  cap: Capturable
  pos: THREE.Vector3
  heading: number
  speed: number
  bob: number // phase
  hover: number // resting height above ground
  respawn: number // >0 while captured, counting down to a fresh spawn
}

const AREA = 100 // critters roam within a +/-AREA square

/**
 * Off-world wildlife you can net, giving the Moon and Mars the same capture loop
 * the city has. Lunar drifters (floating glow-jellies) on the Moon; dust crawlers
 * scuttling the Martian surface. Each registers a Capturable into the shared list
 * so the existing net + missiles catch them and award score/credits/count with no
 * special-casing. Captured ones fade out and respawn elsewhere. Zone-gated: only
 * the active world's critters are alive, so Earth capture logic never sees them.
 */
export class OffworldCritters implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private critters: Critter[] = []
  private zone: Zone = 'earth'

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, capturables: Capturable[], private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 3 : 5

    // --- shared geometry/materials per species ---
    const moonBodyGeo = this.ownG(new THREE.SphereGeometry(1.1, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6))
    const moonCoreGeo = this.ownG(new THREE.SphereGeometry(0.55, 10, 8))
    const tentGeo = this.ownG(new THREE.ConeGeometry(0.12, 1.6, 6))
    const moonBodyMat = this.own(new THREE.MeshBasicMaterial({ color: 0x6fe9ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: true, side: THREE.DoubleSide }))
    const moonCoreMat = this.own(new THREE.MeshBasicMaterial({ color: 0xeafcff, fog: false }))

    const marsBodyGeo = this.ownG(new THREE.SphereGeometry(0.85, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55))
    const legGeo = this.ownG(new THREE.CylinderGeometry(0.06, 0.04, 0.7, 5))
    const eyeGeo = this.ownG(new THREE.SphereGeometry(0.12, 8, 6))
    const marsBodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x8a3a1c, emissive: 0xff5a2a, emissiveIntensity: 0.35, roughness: 0.8, metalness: 0.1 }))
    const marsEyeMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffe24a, fog: false }))

    const makeMoon = () => {
      const g = new THREE.Group()
      const body = new THREE.Mesh(moonBodyGeo, moonBodyMat)
      const core = new THREE.Mesh(moonCoreGeo, moonCoreMat); core.position.y = -0.1
      g.add(body, core)
      for (let i = 0; i < 4; i++) {
        const t = new THREE.Mesh(tentGeo, moonBodyMat)
        const a = (i / 4) * Math.PI * 2
        t.position.set(Math.cos(a) * 0.5, -0.9, Math.sin(a) * 0.5)
        g.add(t)
      }
      return g
    }
    const makeMars = () => {
      const g = new THREE.Group()
      const body = new THREE.Mesh(marsBodyGeo, marsBodyMat)
      g.add(body)
      for (let i = 0; i < 4; i++) {
        const leg = new THREE.Mesh(legGeo, marsBodyMat)
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4
        leg.position.set(Math.cos(a) * 0.7, -0.3, Math.sin(a) * 0.7)
        leg.rotation.z = Math.cos(a) * 0.5
        leg.rotation.x = Math.sin(a) * 0.5
        g.add(leg)
      }
      for (let i = 0; i < 2; i++) {
        const eye = new THREE.Mesh(eyeGeo, marsEyeMat)
        eye.position.set((i ? 0.25 : -0.25), 0.35, 0.6)
        g.add(eye)
      }
      return g
    }

    const build = (zone: 'moon' | 'mars') => {
      for (let i = 0; i < n; i++) {
        const grp = zone === 'moon' ? makeMoon() : makeMars()
        grp.visible = false
        this.group.add(grp)
        const pos = new THREE.Vector3()
        const critter: Critter = {
          zone, group: grp, pos,
          heading: Math.random() * Math.PI * 2,
          speed: zone === 'moon' ? 2.2 : 3.4,
          bob: Math.random() * Math.PI * 2,
          hover: zone === 'moon' ? 3.2 : 0.55,
          respawn: 0,
          cap: { position: pos, alive: false, capture: () => this.onCaptured(critter) },
        }
        this.scatter(critter)
        this.critters.push(critter)
        capturables.push(critter.cap)
      }
    }
    build('moon')
    build('mars')

    this.group.visible = false
    scene.add(this.group)
  }

  /** Place a critter at a fresh random spot (used at spawn + respawn). */
  private scatter(c: Critter) {
    const x = (Math.random() * 2 - 1) * AREA
    const z = (Math.random() * 2 - 1) * AREA
    c.pos.set(x, this.deps.groundY(x, z) + c.hover, z)
    c.group.position.copy(c.pos)
    c.heading = Math.random() * Math.PI * 2
  }

  /** Netted/blasted: award score, fade out, schedule a respawn. */
  private onCaptured(c: Critter): number {
    c.cap.alive = false
    c.group.visible = false
    c.respawn = 6 + Math.random() * 6
    return c.zone === 'moon' ? 60 : 50
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'moon' || zone === 'mars'
    for (const c of this.critters) {
      const on = c.zone === zone && c.respawn <= 0
      c.cap.alive = on
      c.group.visible = on
    }
  }

  update(dt: number) {
    if (this.zone !== 'moon' && this.zone !== 'mars') return
    for (const c of this.critters) {
      if (c.zone !== this.zone) continue
      if (c.respawn > 0) {
        c.respawn -= dt
        if (c.respawn <= 0) { this.scatter(c); c.cap.alive = true; c.group.visible = true }
        continue
      }
      // Lazy random-walk across the surface, reflecting at the boundary.
      c.heading += (Math.random() - 0.5) * dt * 1.5
      c.pos.x += Math.cos(c.heading) * c.speed * dt
      c.pos.z += Math.sin(c.heading) * c.speed * dt
      if (Math.abs(c.pos.x) > AREA) { c.pos.x = Math.sign(c.pos.x) * AREA; c.heading = Math.PI - c.heading }
      if (Math.abs(c.pos.z) > AREA) { c.pos.z = Math.sign(c.pos.z) * AREA; c.heading = -c.heading }
      c.bob += dt
      const gy = this.deps.groundY(c.pos.x, c.pos.z)
      c.pos.y = gy + c.hover + (c.zone === 'moon' ? Math.sin(c.bob * 1.4) * 0.6 : Math.abs(Math.sin(c.bob * 6)) * 0.12)
      c.group.position.copy(c.pos)
      c.group.rotation.y = -c.heading + Math.PI / 2
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
