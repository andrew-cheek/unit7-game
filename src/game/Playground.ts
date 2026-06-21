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

export class Playground {
  private scene: THREE.Scene
  private groups: Record<Zone, THREE.Group>
  private pads: Record<Zone, Pad[]> = { earth: [], mars: [], moon: [] }
  private floorTiles: THREE.MeshStandardMaterial[] = []
  private floor = { x: 0, z: 34, half: 7 }
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
    this.buildPad('mars', 16, -22, 30) // lower gravity → big air
    this.buildPad('mars', -20, -14, 30)
    this.buildPad('moon', 18, -20, 34) // lowest gravity → huge air
    this.buildPad('moon', -18, -18, 34)
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

  private buildPad(zone: Zone, x: number, z: number, strength: number) {
    const color = zone === 'mars' ? config.palette.orange : zone === 'moon' ? 0xbfe6ff : config.palette.lime
    const g = this.groups[zone]
    const ringMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 2.4, roughness: 0.4 }))
    const base = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(3, 3.4, 0.4, 24)), ringMat)
    base.position.set(x, 0.2, z)
    g.add(base)
    const discMat = this.own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const disc = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(2.7, 28)), discMat)
    disc.rotation.x = -Math.PI / 2
    disc.position.set(x, 0.45, z)
    g.add(disc)
    this.pads[zone].push({ x, z, r: 3, strength, ringMat, discMat })
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

  dispose() {
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) this.scene.remove(this.groups[z])
    this.mats.forEach((m) => m.dispose())
    this.geos.forEach((g) => g.dispose())
  }
}
