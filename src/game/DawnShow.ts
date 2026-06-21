// DawnShow — the day/night spectacle, driven by the world's dayFactor.
//
// As the sun reaches full strength, props across every zone RISE up out of
// trapdoors in the ground and unfold: solar panels tilt open, planters push up
// trees / plants / flowers, and water fountains switch on. When night falls
// they fold back down and sink into the ground.
//
// On Earth there's also the commuter choreography: at sunrise a shuttle lands
// and drops off workers who head into the offices; at dusk the workers leave
// the offices (briefcases in hand), walk to the shuttle, board, and it departs.
//
// Cheap: a pool of prop groups that just translate/scale with one "bloom"
// factor, simple lerped walkers, one shuttle. Fully disposed on teardown.

import * as THREE from 'three'
import { config } from './config'
import { createCitizen, createSpaceship, type CharacterModel, type VehicleModel } from './procedural'
import { OFFICE_ANCHORS } from './World'
import type { Zone } from './types'

type RiserKind = 'panel' | 'planter' | 'fountain' | 'tree'

interface Riser {
  kind: RiserKind
  group: THREE.Group
  depth: number // how far below ground it sinks when folded
  panel?: THREE.Object3D
  glow?: THREE.MeshStandardMaterial
  plants?: THREE.Object3D[]
  water?: THREE.Mesh
  waterMat?: THREE.MeshBasicMaterial
}

interface Walker {
  model: CharacterModel
  from: THREE.Vector3
  to: THREE.Vector3
  t: number
  dur: number
}

const PAD = new THREE.Vector3(26, 0, 26)
const SEQ = 12
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t) }

export class DawnShow {
  private scene: THREE.Scene
  private groups: Record<Zone, THREE.Group>
  private risers: Record<Zone, Riser[]> = { earth: [], mars: [], moon: [] }
  private shuttle: VehicleModel
  private walkers: Walker[] = []
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  private zone: Zone = 'earth'
  private prevDay = -1
  private mode: 'idle' | 'arrive' | 'depart' = 'idle'
  private seqT = 0
  private arriveSpawned = false

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.groups = { earth: new THREE.Group(), mars: new THREE.Group(), moon: new THREE.Group() }
    this.buildZone('earth')
    this.buildZone('mars')
    this.buildZone('moon')
    this.shuttle = createSpaceship()
    this.shuttle.group.visible = false
    this.groups.earth.add(this.shuttle.group)
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
    if (zone !== 'earth') this.clearWalkers()
  }

  update(dt: number, dayFactor: number) {
    // Bloom: props are fully risen at full sun, fully sunk in the dark.
    const bloom = smooth((dayFactor - 0.2) / 0.6)
    for (const r of this.risers[this.zone]) this.animateRiser(r, bloom)

    if (this.zone === 'earth') {
      // Dawn / dusk crossings drive the commuter shuttle show.
      if (this.prevDay >= 0) {
        if (this.prevDay < 0.5 && dayFactor >= 0.5) this.start('arrive')
        else if (this.prevDay >= 0.5 && dayFactor < 0.5) this.start('depart')
      }
      if (this.mode !== 'idle') this.runSequence(dt)
    }
    this.prevDay = dayFactor
  }

  // --- rising / folding props ------------------------------------------------

  private animateRiser(r: Riser, bloom: number) {
    const up = bloom
    r.group.position.y = (up - 1) * r.depth // up=1 → at ground, up=0 → sunk
    if (r.kind === 'panel') {
      if (r.panel) r.panel.rotation.x = -Math.PI / 2 + up * (Math.PI / 2 - 0.55) // fold flat → tilt open
      if (r.glow) r.glow.emissiveIntensity = 0.2 + up * 2.4
    } else if (r.kind === 'planter') {
      if (r.plants) for (const p of r.plants) p.scale.setScalar(0.001 + up)
    } else if (r.kind === 'fountain') {
      if (r.water) r.water.scale.set(1, 0.001 + up * 1.3, 1)
      if (r.waterMat) r.waterMat.opacity = up * 0.5
    }
  }

  private buildZone(zone: Zone) {
    const g = this.groups[zone]
    const fx = config.tier.fxScale
    const panels = Math.max(3, Math.round((zone === 'earth' ? 9 : 6) * fx))
    const ring = zone === 'earth' ? 90 : 70
    for (let i = 0; i < panels; i++) {
      const a = (i / panels) * Math.PI * 2 + (zone === 'mars' ? 0.4 : 0)
      const r = ring * (0.5 + ((i * 7) % 5) / 8)
      this.addPanel(g, zone, Math.cos(a) * r, Math.sin(a) * r)
    }
    const planters = Math.max(2, Math.round(5 * fx))
    for (let i = 0; i < planters; i++) {
      const a = (i / planters) * Math.PI * 2 + 0.7
      const r = ring * 0.6
      this.addPlanter(g, zone, Math.cos(a) * r, Math.sin(a) * r)
    }
    const trees = Math.max(2, Math.round(4 * fx))
    for (let i = 0; i < trees; i++) {
      const a = (i / trees) * Math.PI * 2 + 1.3
      const r = ring * 0.75
      this.addTree(g, zone, Math.cos(a) * r, Math.sin(a) * r)
    }
    if (zone === 'earth') {
      // Water fountains only make sense in the city.
      this.addFountain(g, 20, -28)
      this.addFountain(g, -30, 22)
    }
  }

  private addTree(g: THREE.Group, zone: Zone, x: number, z: number) {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    const barkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a2c1f, roughness: 0.9 }))
    const trunk = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.6, 0.9, 7, 8)), barkMat)
    trunk.position.y = 3.5
    group.add(trunk)
    const leafCol = zone === 'mars' ? 0x8fdf9f : zone === 'moon' ? 0x9fd0e0 : 0x3f9a4a
    const leafMat = this.own(new THREE.MeshStandardMaterial({ color: leafCol, roughness: 0.7 }))
    for (let i = 0; i < 3; i++) {
      const blob = new THREE.Mesh(this.ownG(new THREE.IcosahedronGeometry(2.4 - i * 0.4, 0)), leafMat)
      blob.position.set((Math.random() - 0.5) * 1.5, 6.5 + i * 1.4, (Math.random() - 0.5) * 1.5)
      group.add(blob)
    }
    g.add(group)
    // A "tree" riser just rises whole out of the ground (no unfold).
    this.risers[zone].push({ kind: 'tree', group, depth: 11 })
  }

  private addPanel(g: THREE.Group, zone: Zone, x: number, z: number) {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x222a36, metalness: 0.6, roughness: 0.5 }))
    const post = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.25, 0.35, 3, 8)), postMat)
    post.position.y = 1.5
    group.add(post)
    // Panel pivots at the top of the post; folds down flat, tilts open at noon.
    const pivot = new THREE.Group()
    pivot.position.y = 3
    const glow = this.own(new THREE.MeshStandardMaterial({ color: 0x0a1430, emissive: config.palette.cyan, emissiveIntensity: 0.4, metalness: 0.6, roughness: 0.3 }))
    const panel = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(3.6, 0.18, 2.2)), glow)
    panel.position.set(0, 0, 1.1)
    pivot.add(panel)
    pivot.rotation.x = -Math.PI / 2
    group.add(pivot)
    g.add(group)
    this.risers[zone].push({ kind: 'panel', group, depth: 4, panel: pivot, glow })
  }

  private addPlanter(g: THREE.Group, zone: Zone, x: number, z: number) {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    const boxMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a2f25, metalness: 0.3, roughness: 0.8 }))
    const planter = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(3, 1, 3)), boxMat)
    planter.position.y = 0.5
    group.add(planter)
    const plants: THREE.Object3D[] = []
    const leafMat = this.own(new THREE.MeshStandardMaterial({ color: zone === 'mars' ? 0x7fffb0 : 0x4caf50, roughness: 0.7 }))
    const flowerMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: zone === 'moon' ? 0xbfe6ff : config.palette.magenta, emissiveIntensity: 1.4, roughness: 0.5 }))
    for (let i = 0; i < 5; i++) {
      const stalk = new THREE.Group()
      stalk.position.set((Math.random() * 2 - 1) * 1, 1, (Math.random() * 2 - 1) * 1)
      const leaf = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(0.5, 2.4 + Math.random(), 6)), leafMat)
      leaf.position.y = 1.2
      stalk.add(leaf)
      const flower = new THREE.Mesh(this.ownG(new THREE.IcosahedronGeometry(0.4, 0)), flowerMat)
      flower.position.y = 2.4
      stalk.add(flower)
      group.add(stalk)
      plants.push(stalk)
    }
    g.add(group)
    this.risers[zone].push({ kind: 'planter', group, depth: 3, plants })
  }

  private addFountain(g: THREE.Group, x: number, z: number) {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    const stoneMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4452, metalness: 0.4, roughness: 0.7 }))
    const basin = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(3, 3.3, 1, 20)), stoneMat)
    basin.position.y = 0.5
    group.add(basin)
    const waterMat = this.own(new THREE.MeshBasicMaterial({ color: 0x6fd0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const water = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.6, 1.2, 6, 12, 1, true)), waterMat)
    water.position.y = 3.5
    group.add(water)
    g.add(group)
    this.risers.earth.push({ kind: 'fountain', group, depth: 2, water, waterMat })
  }

  // --- commuter shuttle (Earth) ---------------------------------------------

  private start(mode: 'arrive' | 'depart') {
    this.clearWalkers()
    this.mode = mode
    this.seqT = 0
    this.arriveSpawned = false
    this.shuttle.group.visible = true
    if (mode === 'depart') this.spawnWalkers(true)
  }

  private runSequence(dt: number) {
    this.seqT += dt
    const t = this.seqT
    const sg = this.shuttle.group
    if (t < 3) sg.position.set(PAD.x, THREE.MathUtils.lerp(120, 2.5, t / 3), PAD.z)
    else if (t < 9) sg.position.set(PAD.x, 2.5, PAD.z)
    else {
      const k = (t - 9) / 3
      sg.position.set(PAD.x + k * 60, THREE.MathUtils.lerp(2.5, 130, k), PAD.z + k * 20)
    }
    this.shuttle.update(dt, 0.4)

    if (this.mode === 'arrive' && t >= 3 && !this.arriveSpawned) {
      this.spawnWalkers(false)
      this.arriveSpawned = true
    }
    this.updateWalkers(dt)

    if (t >= SEQ) {
      this.shuttle.group.visible = false
      this.clearWalkers()
      this.mode = 'idle'
    }
  }

  /** depart=true: offices -> shuttle (with briefcases). false: shuttle -> offices. */
  private spawnWalkers(depart: boolean) {
    const n = 7
    for (let i = 0; i < n; i++) {
      const anchor = OFFICE_ANCHORS[i % OFFICE_ANCHORS.length]
      const door = anchor.door
      const padSpot = new THREE.Vector3(PAD.x + (Math.random() * 4 - 2), 0, PAD.z + 3 + (Math.random() * 4 - 2))
      const from = depart ? door.clone() : padSpot
      const to = depart ? padSpot : door.clone()
      const model = createCitizen({ outfit: [0x2b3a6b, 0x6b2b4a, 0x2b6b4a, 0x6b5a2b][i % 4], robot: i % 3 === 0 })
      model.group.position.copy(from)
      if (depart) this.attachBriefcase(model.group)
      this.groups.earth.add(model.group)
      const dur = Math.max(2, from.distanceTo(to) / 3.2)
      this.walkers.push({ model, from, to, t: 0, dur })
    }
  }

  private attachBriefcase(g: THREE.Group) {
    const mat = this.own(new THREE.MeshStandardMaterial({ color: 0x4a2f1a, metalness: 0.3, roughness: 0.7 }))
    const bag = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, 0.4, 0.18)), mat)
    bag.position.set(0.35, 0.7, 0.1) // in hand, at the side
    g.add(bag)
  }

  private updateWalkers(dt: number) {
    for (let i = this.walkers.length - 1; i >= 0; i--) {
      const w = this.walkers[i]
      w.t += dt
      const k = Math.min(1, w.t / w.dur)
      w.model.group.position.lerpVectors(w.from, w.to, k)
      const dx = w.to.x - w.from.x
      const dz = w.to.z - w.from.z
      if (dx * dx + dz * dz > 1e-4) w.model.group.rotation.y = Math.atan2(dx, dz)
      w.model.update(dt, 0.8, true)
      if (k >= 1) {
        this.groups.earth.remove(w.model.group)
        w.model.dispose()
        this.walkers.splice(i, 1)
      }
    }
  }

  private clearWalkers() {
    for (const w of this.walkers) { this.groups.earth.remove(w.model.group); w.model.dispose() }
    this.walkers = []
  }

  dispose() {
    this.clearWalkers()
    this.shuttle.dispose()
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) this.scene.remove(this.groups[z])
    this.mats.forEach((m) => m.dispose())
    this.geos.forEach((g) => g.dispose())
  }
}
