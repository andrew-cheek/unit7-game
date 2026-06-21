// DawnShow — the city's day/night spectacle (Earth only), driven by the world's
// dayFactor (0 night .. 1 full day):
//  - Solar trees whose panel-fronds fold shut at night and unfold + glow at dawn.
//  - At sunrise a passenger shuttle descends to the office plaza and drops off
//    commuters who walk to the office doors and head in to work.
//  - At dusk commuters stream back out of the offices to the shuttle, board, and
//    it lifts off and flies away — only at night do they leave.
//
// Self-contained and cheap: a handful of meshes, simple lerped walkers (no
// pathfinding), one shuttle. Fully disposed on teardown.

import * as THREE from 'three'
import { config } from './config'
import { createCitizen, createSpaceship, type CharacterModel, type VehicleModel } from './procedural'
import { OFFICE_ANCHORS } from './World'

interface Tree {
  fronds: THREE.Object3D[]
  panelMats: THREE.MeshStandardMaterial[]
}

interface Walker {
  model: CharacterModel
  from: THREE.Vector3
  to: THREE.Vector3
  t: number
  dur: number
}

const PAD = new THREE.Vector3(26, 0, 26) // shuttle landing pad near the offices
const SEQ = 12 // seconds per arrival/departure sequence

export class DawnShow {
  private scene: THREE.Scene
  private group = new THREE.Group()
  private trees: Tree[] = []
  private shuttle: VehicleModel
  private walkers: Walker[] = []
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  private prevDay = -1
  private mode: 'idle' | 'arrive' | 'depart' = 'idle'
  private seqT = 0

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.buildSolarTrees()
    this.shuttle = createSpaceship()
    this.shuttle.group.visible = false
    this.group.add(this.shuttle.group)
    scene.add(this.group)
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  setActive(earth: boolean) {
    this.group.visible = earth
    if (!earth) this.clearWalkers()
  }

  update(dt: number, dayFactor: number) {
    if (!this.group.visible) return
    // Solar trees track the day: fronds unfold and glow as the sun rises.
    const open = THREE.MathUtils.clamp((dayFactor - 0.1) / 0.5, 0, 1)
    for (const tr of this.trees) {
      for (let i = 0; i < tr.fronds.length; i++) {
        // folded ~ -1.4rad (up, closed), open ~ +0.35rad (spread to the sky)
        tr.fronds[i].rotation.z = -1.4 + open * 1.75
      }
      for (const m of tr.panelMats) m.emissiveIntensity = 0.2 + open * 2.2
    }

    // Detect the dawn / dusk crossings to trigger the arrival / departure show.
    if (this.prevDay >= 0) {
      if (this.prevDay < 0.5 && dayFactor >= 0.5) this.start('arrive')
      else if (this.prevDay >= 0.5 && dayFactor < 0.5) this.start('depart')
    }
    this.prevDay = dayFactor

    if (this.mode !== 'idle') this.runSequence(dt)
  }

  private start(mode: 'arrive' | 'depart') {
    this.clearWalkers()
    this.mode = mode
    this.seqT = 0
    this.shuttle.group.visible = true
    if (mode === 'depart') {
      // Commuters emerge from the office doors and head for the pad.
      this.spawnWalkers(true)
    }
  }

  private runSequence(dt: number) {
    this.seqT += dt
    const t = this.seqT
    // Shuttle: descend 0..3s, hold, ascend + peel away 9..12s.
    const sg = this.shuttle.group
    if (t < 3) {
      sg.position.set(PAD.x, THREE.MathUtils.lerp(120, 2.5, t / 3), PAD.z)
    } else if (t < 9) {
      sg.position.set(PAD.x, 2.5, PAD.z)
    } else {
      const k = (t - 9) / 3
      sg.position.set(PAD.x + k * 60, THREE.MathUtils.lerp(2.5, 130, k), PAD.z + k * 20)
    }
    this.shuttle.update(dt, 0.4)

    // Arrival: once the shuttle has touched down, commuters spill out to offices.
    if (this.mode === 'arrive' && t >= 3 && this.walkers.length === 0 && !this.arriveSpawned) {
      this.spawnWalkers(false)
      this.arriveSpawned = true
    }
    this.updateWalkers(dt)

    if (t >= SEQ) {
      this.shuttle.group.visible = false
      this.clearWalkers()
      this.mode = 'idle'
      this.arriveSpawned = false
    }
  }

  private arriveSpawned = false

  /** depart=true: doors -> pad. depart=false (arrival): pad -> doors. */
  private spawnWalkers(depart: boolean) {
    const n = 6
    for (let i = 0; i < n; i++) {
      const anchor = OFFICE_ANCHORS[i % OFFICE_ANCHORS.length]
      const door = anchor.door
      const padSpot = new THREE.Vector3(PAD.x + (Math.random() * 4 - 2), 0, PAD.z + 3 + (Math.random() * 4 - 2))
      const from = depart ? door.clone() : padSpot
      const to = depart ? padSpot : door.clone()
      const model = createCitizen({ outfit: [0x2b3a6b, 0x6b2b4a, 0x2b6b4a, 0x6b5a2b][i % 4], robot: i % 3 === 0 })
      model.group.position.copy(from)
      this.group.add(model.group)
      const dur = Math.max(2, from.distanceTo(to) / 3.2)
      this.walkers.push({ model, from, to, t: 0, dur })
    }
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
        // Reached the door (entering) or the shuttle (boarding): vanish.
        this.group.remove(w.model.group)
        w.model.dispose()
        this.walkers.splice(i, 1)
      }
    }
  }

  private clearWalkers() {
    for (const w of this.walkers) { this.group.remove(w.model.group); w.model.dispose() }
    this.walkers = []
  }

  private buildSolarTrees() {
    const trunkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a2f25, metalness: 0.4, roughness: 0.7 }))
    const trunkGeo = this.ownG(new THREE.CylinderGeometry(0.5, 0.9, 9, 8))
    const panelGeo = this.ownG(new THREE.BoxGeometry(4.5, 0.2, 1.8))
    // Scatter a grove around the city, off the very center.
    const spots: [number, number][] = [
      [30, -34], [-34, 30], [62, -50], [-58, -44], [44, 52], [-20, 66], [70, 18], [-66, 10],
    ]
    for (const [x, z] of spots) {
      const tree = new THREE.Group()
      const trunk = new THREE.Mesh(trunkGeo, trunkMat)
      trunk.position.y = 4.5
      trunk.castShadow = config.tier.buildingShadows
      tree.add(trunk)
      const fronds: THREE.Object3D[] = []
      const panelMats: THREE.MeshStandardMaterial[] = []
      const k = 6
      for (let i = 0; i < k; i++) {
        // Each frond is a pivot at the top of the trunk holding a solar panel.
        const pivot = new THREE.Group()
        pivot.position.y = 9
        pivot.rotation.y = (i / k) * Math.PI * 2
        const mat = this.own(new THREE.MeshStandardMaterial({ color: 0x0a1430, emissive: config.palette.cyan, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.3 }))
        const panel = new THREE.Mesh(panelGeo, mat)
        panel.position.set(2.4, 0, 0) // offset out along the frond
        pivot.add(panel)
        pivot.rotation.z = -1.4 // start folded
        tree.add(pivot)
        fronds.push(pivot)
        panelMats.push(mat)
      }
      tree.position.set(x, 0, z)
      this.group.add(tree)
      this.trees.push({ fronds, panelMats })
    }
  }

  dispose() {
    this.clearWalkers()
    this.shuttle.dispose()
    this.scene.remove(this.group)
    this.mats.forEach((m) => m.dispose())
    this.geos.forEach((g) => g.dispose())
  }
}
