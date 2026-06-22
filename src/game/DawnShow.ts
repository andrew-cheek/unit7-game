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
import { createCitizen, createSpaceship, createRocket, type CharacterModel, type VehicleModel } from './procedural'
import { OFFICE_ANCHORS } from './World'
import type { Physics } from './Physics'
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
  to: THREE.Vector3
  t: number
}

// Landing pads laid out in a fan in front of spawn (player faces +Z) so the
// whole morning fleet - several rockets and shuttles - touches down right where
// you're looking, staggered so they arrive as a steady stream, not all at once.
const PADS = [
  { p: new THREE.Vector3(-40, 0, 48), kind: 'rocket', delay: 0.0 },
  { p: new THREE.Vector3(28, 0, 34), kind: 'ship', delay: 1.2 },
  { p: new THREE.Vector3(-26, 0, 36), kind: 'ship', delay: 2.4 },
  { p: new THREE.Vector3(42, 0, 52), kind: 'rocket', delay: 3.4 },
  { p: new THREE.Vector3(0, 0, 64), kind: 'ship', delay: 4.6 },
  { p: new THREE.Vector3(-44, 0, 70), kind: 'rocket', delay: 5.8 },
] as const
const SPAWN_Y = 80 // craft spawn altitude (lower than before so the descent is clearly seen)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t) }

interface Craft {
  model: VehicleModel
  pad: THREE.Vector3
  landY: number
  delay: number
  t: number
  state: 'wait' | 'descend' | 'hold' | 'ascend' | 'done'
  dropped: boolean
}

export class DawnShow {
  private scene: THREE.Scene
  private physics: Physics
  private groups: Record<Zone, THREE.Group>
  private risers: Record<Zone, Riser[]> = { earth: [], mars: [], moon: [] }
  private craft: Craft[] = []
  private walkers: Walker[] = []
  private vscratch = new THREE.Vector3()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  private zone: Zone = 'earth'
  private prevDay = -1
  private mode: 'idle' | 'arrive' | 'depart' = 'idle'

  constructor(scene: THREE.Scene, physics: Physics) {
    this.scene = scene
    this.physics = physics
    this.groups = { earth: new THREE.Group(), mars: new THREE.Group(), moon: new THREE.Group() }
    this.buildZone('earth')
    this.buildZone('mars')
    this.buildZone('moon')
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

  /** Re-sync the dawn/dusk detector after the world clock is jumped, so it
   *  doesn't mistake the jump for a crossing and mis-fire a sequence. */
  resetClock() {
    this.prevDay = -1
    this.endFleet()
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
      if (this.mode !== 'idle') this.updateFleet(dt)
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

  // --- morning/evening arrival fleet (Earth) --------------------------------

  /** Spawn the fleet: a couple of shuttles + a vertically-landing rocket, in
   *  front of spawn, staggered. Arrival drops workers off; departure has workers
   *  walk out to the pads to board before the craft lift off. */
  private start(mode: 'arrive' | 'depart') {
    this.endFleet()
    this.mode = mode
    for (const def of PADS) {
      const model = def.kind === 'rocket' ? createRocket() : createSpaceship()
      model.group.position.set(def.p.x, SPAWN_Y, def.p.z)
      this.groups.earth.add(model.group)
      this.craft.push({ model, pad: def.p.clone(), landY: def.kind === 'rocket' ? 0.5 : 2.5, delay: def.delay, t: 0, state: 'wait', dropped: false })
      // Departure: commuters head out to this pad to board (briefcases in hand).
      if (mode === 'depart') this.spawnWorkersAt(def.p, true)
    }
  }

  private updateFleet(dt: number) {
    let allDone = true
    for (const c of this.craft) {
      c.t += dt
      const g = c.model.group
      if (c.state === 'wait') {
        g.position.set(c.pad.x, SPAWN_Y, c.pad.z)
        if (c.t >= c.delay) { c.state = 'descend'; c.t = 0 }
      } else if (c.state === 'descend') {
        // Slow, clearly-visible descent (was a 2.6s plunge from way up high).
        const k = smooth(Math.min(1, c.t / 5.5))
        g.position.set(c.pad.x, THREE.MathUtils.lerp(SPAWN_Y, c.landY, k), c.pad.z)
        if (k >= 1) { c.state = 'hold'; c.t = 0 }
      } else if (c.state === 'hold') {
        g.position.set(c.pad.x, c.landY, c.pad.z)
        if (this.mode === 'arrive' && !c.dropped) { this.spawnWorkersAt(c.pad, false); c.dropped = true }
        if (c.t >= (this.mode === 'depart' ? 5 : 4.5)) { c.state = 'ascend'; c.t = 0 }
      } else if (c.state === 'ascend') {
        const k = Math.min(1, c.t / 3)
        g.position.set(c.pad.x + k * 40, THREE.MathUtils.lerp(c.landY, 150, k), c.pad.z - k * 12)
        if (k >= 1) c.state = 'done'
      }
      if (c.state !== 'done') allDone = false
      c.model.update(dt, 0.4)
    }
    this.updateWalkers(dt)
    if (allDone && this.walkers.length === 0) this.endFleet()
  }

  private endFleet() {
    for (const c of this.craft) { this.groups.earth.remove(c.model.group); c.model.dispose() }
    this.craft = []
    this.clearWalkers()
    this.mode = 'idle'
  }

  /** Spawn a few commuters at a pad. depart=true: door -> pad (boarding, with
   *  briefcase). depart=false: pad -> nearest office door (heading to work). */
  private spawnWorkersAt(pad: THREE.Vector3, depart: boolean) {
    const n = 5
    for (let i = 0; i < n; i++) {
      const door = OFFICE_ANCHORS[Math.floor(Math.random() * OFFICE_ANCHORS.length)].door
      const padSpot = new THREE.Vector3(pad.x + (Math.random() * 5 - 2.5), 0, pad.z + 4 + (Math.random() * 4 - 2))
      const from = depart ? door.clone() : padSpot
      const to = depart ? padSpot : door.clone()
      const model = createCitizen({ outfit: [0x2b3a6b, 0x6b2b4a, 0x2b6b4a, 0x6b5a2b][i % 4], robot: i % 3 === 0 })
      model.group.position.copy(from)
      if (depart) this.attachBriefcase(model.group)
      this.groups.earth.add(model.group)
      this.walkers.push({ model, to, t: 0 })
    }
  }

  private attachBriefcase(g: THREE.Group) {
    const mat = this.own(new THREE.MeshStandardMaterial({ color: 0x4a2f1a, metalness: 0.3, roughness: 0.7 }))
    const bag = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, 0.4, 0.18)), mat)
    bag.position.set(0.35, 0.7, 0.1) // in hand, at the side
    g.add(bag)
  }

  private updateWalkers(dt: number) {
    const speed = 3.4
    for (let i = this.walkers.length - 1; i >= 0; i--) {
      const w = this.walkers[i]
      w.t += dt
      const p = w.model.group.position
      const dx = w.to.x - p.x
      const dz = w.to.z - p.z
      const d = Math.hypot(dx, dz)
      // Arrived (entered the office / boarded), or stuck too long: remove.
      if (d < 1.1 || w.t > 11) {
        this.groups.earth.remove(w.model.group)
        w.model.dispose()
        this.walkers.splice(i, 1)
        continue
      }
      const vx = (dx / d) * speed
      const vz = (dz / d) * speed
      p.x += vx * dt
      p.z += vz * dt
      // Walk around buildings instead of through them.
      this.vscratch.set(vx, 0, vz)
      this.physics.resolveHorizontal(p, this.vscratch, 0.4, 1.6)
      w.model.group.rotation.y = Math.atan2(dx, dz)
      w.model.update(dt, 0.8, true)
    }
  }

  private clearWalkers() {
    for (const w of this.walkers) { this.groups.earth.remove(w.model.group); w.model.dispose() }
    this.walkers = []
  }

  dispose() {
    this.endFleet()
    for (const z of ['earth', 'mars', 'moon'] as Zone[]) this.scene.remove(this.groups[z])
    this.mats.forEach((m) => m.dispose())
    this.geos.forEach((g) => g.dispose())
  }
}
