// Playground — interactive sci-fi "toys" scattered through the zones: trampoline
// bounce pads that fling you sky-high (all zones) and a neon dance floor in the
// city that makes Unit 7 break into a robot dance. Cheap glowing meshes that
// pulse; Game queries pad/floor positions against the player each frame.

import * as THREE from 'three'
import { config } from './config'
import type { Zone } from './types'

interface Pad {
  x: number
  z: number
  r: number
  strength: number
  ringMat: THREE.MeshStandardMaterial
  discMat: THREE.MeshBasicMaterial
}

interface Updraft {
  x: number
  z: number
  r: number
  lift: number // upward acceleration while inside (m/s^2)
  top: number // stops lifting above this world height
  colMat: THREE.MeshBasicMaterial
}

interface Cannon {
  x: number
  z: number
  r: number
  vel: THREE.Vector3 // launch velocity applied as a one-shot when you step in
  glowMat: THREE.MeshStandardMaterial
}

interface LowG {
  x: number
  y: number
  z: number
  r: number
  factor: number // gravity multiplier inside (e.g. 0.3 = floaty)
  mat: THREE.MeshBasicMaterial
}

export class Playground {
  private scene: THREE.Scene
  private groups: Record<Zone, THREE.Group>
  private pads: Record<Zone, Pad[]> = { earth: [], mars: [], moon: [] }
  private updrafts: Record<Zone, Updraft[]> = { earth: [], mars: [], moon: [] }
  private cannons: Record<Zone, Cannon[]> = { earth: [], mars: [], moon: [] }
  private lowZones: Record<Zone, LowG[]> = { earth: [], mars: [], moon: [] }
  private floorTiles: THREE.MeshStandardMaterial[] = []
  // Open ground SOUTH of spawn - well clear of the arcade interior (north) so you
  // never get stuck auto-dancing when you walk in to play the minigames.
  private floor = { x: 0, z: -44, half: 7 }
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private t = 0

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.groups = { earth: new THREE.Group(), mars: new THREE.Group(), moon: new THREE.Group() }
    // Bounce pads. Mars/Moon pads sit near the (flattened) spawn region so they
    // rest on near-flat ground; Earth ground is flat everywhere.
    this.buildPad('earth', 40, -20, 24)
    this.buildPad('earth', -46, 28, 24)
    this.buildPad('earth', 8, 70, 28)
    // MEGA pads: a big gold launcher that flings you skyscraper-high.
    this.buildPad('earth', -70, -56, 58, { mega: true })
    this.buildPad('earth', 96, 24, 58, { mega: true })
    this.buildPad('mars', 16, -22, 30) // lower gravity → big air
    this.buildPad('mars', -20, -14, 30)
    this.buildPad('mars', 40, 30, 60, { mega: true })
    this.buildPad('moon', 18, -20, 34) // lowest gravity → huge air
    this.buildPad('moon', -18, -18, 34)
    this.buildPad('moon', 30, 26, 64, { mega: true })
    // A couple more bounce pads for rooftop-hopping routes.
    this.buildPad('earth', 120, -90, 30)
    this.buildPad('earth', -130, -30, 30)
    // Updraft columns: ride the rising air to hover + climb (like a thermal).
    this.buildUpdraft('earth', 60, -64, 7, 30, 150)
    this.buildUpdraft('earth', -96, 70, 7, 30, 150)
    this.buildUpdraft('mars', -52, 36, 8, 26, 140)
    // Launch cannons: step in, get flung across the map on a clean arc.
    this.buildCannon('earth', -64, -40, 30, 30, 34) // toward the plaza/center
    this.buildCannon('earth', 110, 60, -34, 32, -20)
    this.buildCannon('mars', 60, -60, -28, 26, 30)
    this.buildCannon('moon', -40, 40, 26, 22, -26)
    // Low-G bubbles: float + triple-hop inside (per-zone gravity scaled down more).
    this.buildLowG('earth', 30, 14, -70, 16, 0.35)
    this.buildLowG('earth', -110, 110, 18, 18, 0.3)
    this.buildLowG('mars', 40, 16, 40, 20, 0.4)
    this.buildLowG('moon', -30, 16, -30, 22, 0.45)
    this.buildDanceFloor()
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) {
      this.groups[z].visible = z === 'earth'
      scene.add(this.groups[z])
    }
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  setActive(zone: Zone) {
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) this.groups[z].visible = z === zone
  }

  update(dt: number) {
    this.t += dt
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) {
      for (const p of this.pads[z]) {
        p.ringMat.emissiveIntensity = 2 + Math.sin(this.t * 4 + p.x) * 1.2
        p.discMat.opacity = 0.4 + Math.sin(this.t * 4 + p.x) * 0.2
      }
    }
    for (let i = 0; i < this.floorTiles.length; i++) {
      this.floorTiles[i].emissiveIntensity = 1.4 + Math.sin(this.t * 3 + i * 0.7) * 1.3
    }
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) {
      for (const u of this.updrafts[z]) u.colMat.opacity = 0.12 + Math.sin(this.t * 2 + u.x) * 0.06
      for (const c of this.cannons[z]) c.glowMat.emissiveIntensity = 2 + Math.sin(this.t * 5 + c.x) * 1
      for (const l of this.lowZones[z]) l.mat.opacity = 0.1 + Math.sin(this.t * 1.5 + l.x) * 0.05
    }
  }

  /** Launch velocity if the player is standing on a cannon in `zone`, else null. */
  cannonAt(zone: Zone, x: number, z: number): THREE.Vector3 | null {
    for (const c of this.cannons[zone]) {
      const dx = x - c.x
      const dz = z - c.z
      if (dx * dx + dz * dz < c.r * c.r) return c.vel
    }
    return null
  }

  /** Gravity multiplier at a point (1 = normal, <1 = floaty low-G bubble). */
  lowGFactor(zone: Zone, x: number, y: number, z: number): number {
    for (const l of this.lowZones[zone]) {
      const dx = x - l.x
      const dy = y - l.y
      const dz = z - l.z
      if (dx * dx + dy * dy + dz * dz < l.r * l.r) return l.factor
    }
    return 1
  }

  /** Upward acceleration if the player is inside an updraft column in `zone` and
   *  below its ceiling, else 0. Applied as a sustained lift by Game. */
  updraftAt(zone: Zone, x: number, y: number, z: number): number {
    for (const u of this.updrafts[zone]) {
      if (y > u.top) continue
      const dx = x - u.x
      const dz = z - u.z
      if (dx * dx + dz * dz < u.r * u.r) return u.lift
    }
    return 0
  }

  /** Bounce strength if the player is standing on a pad in `zone`, else 0. */
  bouncePadAt(zone: Zone, x: number, z: number): number {
    for (const p of this.pads[zone]) {
      const dx = x - p.x
      const dz = z - p.z
      if (dx * dx + dz * dz < p.r * p.r) return p.strength
    }
    return 0
  }

  /** True when the player is on the city dance floor. */
  onDanceFloor(zone: Zone, x: number, z: number): boolean {
    if (zone !== 'earth') return false
    return Math.abs(x - this.floor.x) < this.floor.half && Math.abs(z - this.floor.z) < this.floor.half
  }

  private buildPad(zone: Zone, x: number, z: number, strength: number, opts: { mega?: boolean } = {}) {
    const mega = opts.mega ?? false
    // Mega pads are gold + larger so they read as "the big launcher".
    const color = mega ? 0xffd24a : zone === 'mars' ? config.palette.orange : zone === 'moon' ? 0xbfe6ff : config.palette.lime
    const rad = mega ? 5 : 3
    const g = this.groups[zone]
    const ringMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: mega ? 3 : 2.4, roughness: 0.4 }))
    const base = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(rad, rad + 0.4, mega ? 0.7 : 0.4, 28)), ringMat)
    base.position.set(x, mega ? 0.35 : 0.2, z)
    g.add(base)
    const discMat = this.own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const disc = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(rad - 0.3, 30)), discMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.set(x, mega ? 0.75 : 0.45, z)
    g.add(disc)
    if (mega) {
      // A chevron stack so it reads as "launch UP" from a distance.
      const arrowMat = this.own(new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      for (let i = 0; i < 3; i++) {
        const ch = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(rad * (0.5 - i * 0.12), 1.2, 4)), arrowMat)
        ch.position.set(x, 1.4 + i * 1.3, z)
        ch.rotation.y = Math.PI / 4
        g.add(ch)
      }
    }
    this.pads[zone].push({ x, z, r: rad, strength, ringMat, discMat })
  }

  /** A translucent rising-air column you can ride upward (hover + climb). */
  private buildUpdraft(zone: Zone, x: number, z: number, r: number, lift: number, height: number) {
    const g = this.groups[zone]
    const colMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.14, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const col = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(r, r, height, 20, 1, true)), colMat)
    col.position.set(x, height / 2, z)
    g.add(col)
    const ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.7, fog: false }))
    const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(r, 0.3, 8, 28)), ringMat)
    ring.rotation.x = Math.PI / 2
    ring.position.set(x, 0.4, z)
    g.add(ring)
    this.updrafts[zone].push({ x, z, r, lift, top: height, colMat })
  }

  private buildDanceFloor() {
    const g = this.groups.earth
    const palette = [config.palette.cyan, config.palette.magenta, config.palette.purple, config.palette.lime]
    const tileGeo = this.ownG(new THREE.BoxGeometry(3.2, 0.2, 3.2))
    const N = 4
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const mat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: palette[(i + j) % palette.length], emissiveIntensity: 1.8, roughness: 0.4 }))
        const tile = new THREE.Mesh(tileGeo, mat)
        tile.position.set(this.floor.x + (i - (N - 1) / 2) * 3.4, 0.12, this.floor.z + (j - (N - 1) / 2) * 3.4)
        g.add(tile)
        this.floorTiles.push(mat)
      }
    }
    // A glowing arch so the dance floor reads as a destination.
    const archMat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.magenta, fog: false }))
    const arch = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(7, 0.3, 8, 28, Math.PI)), archMat)
    arch.position.set(this.floor.x, 0.1, this.floor.z)
    g.add(arch)
  }

  /** A glowing barrel tilted along the launch vector + a pad you step onto. */
  private buildCannon(zone: Zone, x: number, z: number, vx: number, vy: number, vz: number) {
    const g = this.groups[zone]
    const glowMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.orange, emissiveIntensity: 2.4, roughness: 0.4 }))
    const barrel = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.6, 2.0, 5, 16, 1, true)), glowMat)
    // Aim the barrel along the launch direction.
    const dir = new THREE.Vector3(vx, vy, vz).normalize()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    barrel.quaternion.copy(q)
    barrel.position.set(x, 2.2, z)
    g.add(barrel)
    const ringMat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.orange, transparent: true, opacity: 0.7, fog: false }))
    const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(2.2, 0.3, 8, 24)), ringMat)
    ring.rotation.x = Math.PI / 2
    ring.position.set(x, 0.4, z)
    g.add(ring)
    this.cannons[zone].push({ x, z, r: 2.4, vel: new THREE.Vector3(vx, vy, vz), glowMat })
  }

  /** A translucent low-gravity bubble you can float + triple-hop inside. */
  private buildLowG(zone: Zone, x: number, y: number, z: number, r: number, factor: number) {
    const g = this.groups[zone]
    const mat = this.own(new THREE.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const bubble = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(r, 20, 14)), mat)
    bubble.position.set(x, y, z)
    g.add(bubble)
    this.lowZones[zone].push({ x, y, z, r, factor, mat })
  }

  dispose() {
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) this.scene.remove(this.groups[z])
    this.mats.forEach((m) => m.dispose())
    this.geos.forEach((g) => g.dispose())
  }
}
