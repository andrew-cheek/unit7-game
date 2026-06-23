// ExplorationPointSystem — small "reward for wandering" discoveries placed away
// from the main path in each zone: a crashed relay, an alien artifact, a
// derelict rover, plus collectible energy cores that pay out credits when you
// reach them. Each discovery has a tall, fog-immune light beacon so it is
// visible from a distance and pulls you off the beaten track.
//
// Cheap and static (a few meshes per zone) except the slow spin/bob on cores
// and beacons. One zone group is visible at a time. Everything is disposed on
// teardown via tracked material/geometry sets.

import * as THREE from 'three'
import { config } from './config'
import type { Zone } from './types'

interface Core {
  mesh: THREE.Object3D
  beam: THREE.Mesh
  x: number
  z: number
  collected: boolean
  phase: number
}

const CORE_VALUE = 60

export class ExplorationPoints {
  private scene: THREE.Scene
  private onCollect: (credits: number, label: string) => void
  private groups: Record<Zone, THREE.Group>
  private cores: Record<Zone, Core[]> = { earth: [], mars: [], moon: [] }
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'
  private t = 0

  constructor(scene: THREE.Scene, onCollect: (credits: number, label: string) => void) {
    this.scene = scene
    this.onCollect = onCollect
    this.groups = {
      earth: this.buildEarth(),
      mars: this.buildMars(),
      moon: this.buildMoon(),
    }
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) {
      this.groups[z].visible = z === 'earth'
      scene.add(this.groups[z])
    }
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  setActive(zone: Zone) {
    this.zone = zone
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) this.groups[z].visible = z === zone
  }

  update(dt: number, zone: Zone, playerX: number, playerZ: number) {
    this.t += dt
    const cores = this.cores[zone]
    for (const c of cores) {
      if (c.collected) continue
      c.mesh.rotation.y += dt * 1.4
      c.mesh.position.y = c.mesh.userData.baseY + Math.sin(this.t * 2 + c.phase) * 0.4
      const beamMat = c.beam.material as THREE.MeshBasicMaterial
      beamMat.opacity = 0.18 + Math.sin(this.t * 3 + c.phase) * 0.1
      const dx = c.x - playerX
      const dz = c.z - playerZ
      if (dx * dx + dz * dz < 3.5 * 3.5) {
        c.collected = true
        c.mesh.visible = false
        c.beam.visible = false
        this.onCollect(CORE_VALUE, 'ENERGY CORE')
      }
    }
  }

  // --- builders --------------------------------------------------------------

  /** A glowing energy core (octahedron) on a thin light beacon, at (x,z,baseY). */
  private makeCore(group: THREE.Group, x: number, z: number, baseY: number, color: number, zone: Zone) {
    const core = new THREE.Mesh(
      this.ownG(new THREE.OctahedronGeometry(0.7, 0)),
      this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 3, roughness: 0.3, metalness: 0.4 })),
    )
    core.position.set(x, baseY, z)
    core.userData.baseY = baseY
    group.add(core)
    const beam = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(0.25, 0.25, 40, 8, 1, true)),
      this.own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })),
    )
    beam.position.set(x, baseY + 20, z)
    group.add(beam)
    this.cores[zone].push({ mesh: core, beam, x, z, collected: false, phase: Math.random() * 6.28 })
  }

  /** A tall fog-immune marker beam so a discovery reads from across the map. */
  private marker(group: THREE.Group, x: number, z: number, y: number, color: number) {
    const beam = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(0.5, 0.5, 120, 10, 1, true)),
      this.own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })),
    )
    beam.position.set(x, y + 60, z)
    group.add(beam)
  }

  private buildEarth(): THREE.Group {
    const g = new THREE.Group()
    const cyan = config.palette.cyan
    // A toppled comms relay tucked at the city edge.
    const metal = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4150, metalness: 0.7, roughness: 0.5 }))
    const glow = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: cyan, emissiveIntensity: 2.4, roughness: 0.4 }))
    const rx = -150, rz = 120
    const mast = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.5, 0.7, 14, 10)), metal)
    mast.position.set(rx, 6, rz); mast.rotation.z = 0.5
    g.add(mast)
    const dish = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(4, 0.5, 1.5, 16, 1, true)), metal)
    dish.rotation.set(Math.PI / 2 + 0.7, 0, 0); dish.position.set(rx + 3, 11, rz)
    g.add(dish)
    const beacon = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.5, 10, 8)), glow)
    beacon.position.set(rx + 3, 11, rz)
    g.add(beacon)
    this.marker(g, rx, rz, 0, cyan)
    // Energy cores spread across the WHOLE city (it now runs out to ~560m), not
    // just the inner blocks, so wandering the outskirts always pays off.
    const half = config.world.half
    const palette = [cyan, config.palette.magenta, config.palette.purple, config.palette.orange, config.palette.lime]
    const n = config.tier.name === 'high' ? 11 : config.tier.name === 'medium' ? 7 : 4
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.6
      const rad = half * (0.34 + (i % 3) * 0.19) // three radial bands out to ~0.72*half
      this.makeCore(g, Math.cos(a) * rad, Math.sin(a) * rad, 2.2, palette[i % palette.length], 'earth')
    }
    // A tall discovery beacon over each district's hero tower so every sector
    // reads as a place worth heading toward, not just filler sprawl.
    const anchors: Array<[number, number, number]> = [
      [40, 178, config.palette.cyan], [188, 36, config.palette.magenta],
      [-176, -52, config.palette.orange], [44, -184, config.palette.purple],
    ]
    for (const [ax, az, col] of anchors) {
      if (Math.abs(ax) < half - 10 && Math.abs(az) < half - 10) this.marker(g, ax, az, 0, col)
    }
    return g
  }

  private buildMars(): THREE.Group {
    const g = new THREE.Group()
    const lime = config.palette.lime
    // A floating alien artifact — a slowly hovering crystal cluster.
    const ax = 140, az = -120
    const crystalMat = this.own(new THREE.MeshStandardMaterial({ color: 0x07140d, emissive: lime, emissiveIntensity: 2.6, roughness: 0.25, metalness: 0.3 }))
    const cluster = new THREE.Group()
    for (let i = 0; i < 5; i++) {
      const shard = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(0.8, 4 + i, 5)), crystalMat)
      shard.position.set(Math.cos(i) * 1.8, 2 + i * 0.3, Math.sin(i) * 1.8)
      shard.rotation.set(0.2 * i, i, 0.15 * i)
      cluster.add(shard)
    }
    cluster.position.set(ax, 5, az)
    g.add(cluster)
    this.marker(g, ax, az, 4, lime)
    this.makeCore(g, -130, -140, 3, lime, 'mars')
    this.makeCore(g, 120, 140, 3, config.palette.orange, 'mars')
    this.makeCore(g, -150, 100, 3, lime, 'mars')
    return g
  }

  private buildMoon(): THREE.Group {
    const g = new THREE.Group()
    const ice = 0xbfe6ff
    // A derelict rover half-tipped in the regolith.
    const dark = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3340, metalness: 0.6, roughness: 0.6 }))
    const glow = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: ice, emissiveIntensity: 2, roughness: 0.4 }))
    const rx = -140, rz = 130
    const body = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(4, 1.4, 2.4)), dark)
    body.position.set(rx, 2.5, rz); body.rotation.z = 0.4
    g.add(body)
    const cab = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1.6, 1, 1.8)), glow)
    cab.position.set(rx - 0.6, 3.4, rz); cab.rotation.z = 0.4
    g.add(cab)
    this.marker(g, rx, rz, 2, ice)
    this.makeCore(g, 150, -120, 2.8, ice, 'moon')
    this.makeCore(g, -120, -150, 2.8, config.palette.cyan, 'moon')
    this.makeCore(g, 130, 150, 2.8, ice, 'moon')
    return g
  }

  dispose() {
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) this.scene.remove(this.groups[z])
    this.mats.forEach((m) => m.dispose())
    this.geos.forEach((g) => g.dispose())
  }
}
