import * as THREE from 'three'
import { config } from './config'
import { createCitizen } from './procedural'
import type { CharacterModel } from './procedural'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Current zone; ambient is Earth-only and hides off-world. */
  zone: () => Zone
  /** Terrain height sampler so performers stand on the ground. */
  groundY: (x: number, z: number) => number
}

interface Performer {
  model: CharacterModel
  // Pivot at feet; we sway/turn/bob the model around it each frame.
  pivot: THREE.Group
  baseY: number
  baseRotY: number
  phase: number
  // Per-performer emote tempos so they're never in lockstep.
  swaySpeed: number
  bobSpeed: number
  waveSpeed: number
}

// Seeded hotspots (x, z) where street life clusters: near spawn, the plaza
// approach, and the arcade district. Performers are scattered around these.
const HOTSPOTS: ReadonlyArray<readonly [number, number]> = [
  [8, 6], // just off spawn
  [40, 14], // Portal Plaza approach (mission plaza is ~46,12)
  [-18, 22], // arcade-side street
]

/** Deterministic PRNG so the performer layout is identical every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Static street performers / buskers for the Earth city. A handful of citizens
 * stand at seeded hotspots (spawn, plaza approach, arcade street) and loop a
 * gentle procedural emote - a slow body sway, a bob, and an arm wave driven by
 * the citizen's own walk rig at a low "speed" - so the streets read as lived-in.
 *
 * No movement, no AI, no colliders. Each performer is phase-offset so the group
 * never moves in lockstep. A small additive "tip jar" glow at each one's feet
 * adds charm for a couple of extra cheap draws. Earth-gated: hidden off-world.
 *
 * Cost: tier-scaled count (high 5 / medium 3 / low 2) citizens (~7 meshes each)
 * plus one shared tip-jar InstancedMesh. All geometry/materials are disposed on
 * teardown; no per-frame heap allocation (scalar writes / shared scratch only).
 */
export class StreetPerformers implements GameSystem {
  private group = new THREE.Group()
  private performers: Performer[] = []
  // Shared tip-jar glow: one small additive sphere instanced per performer.
  private jars: THREE.InstancedMesh | null = null
  private jarGeo: THREE.SphereGeometry | null = null
  private jarMat: THREE.MeshBasicMaterial | null = null
  private t = 0

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const count = tier === 'high' ? 5 : tier === 'low' ? 2 : 3
    const rnd = mulberry32(0x57aff)

    // Outfit/accent palette cycled across performers for visual variety.
    const outfits = [0x2b3a6b, 0x6b2b4a, 0x2b6b54, 0x6b5a2b, 0x4a2b6b]
    const accents = [config.palette.cyan, config.palette.magenta, 0xffd24a, 0x9bff6a, 0xb07cff]

    // Tip-jar glow instanced across all performers (one draw call total).
    this.jarGeo = new THREE.SphereGeometry(0.12, 8, 6)
    this.jarMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const jars = new THREE.InstancedMesh(this.jarGeo, this.jarMat, count)
    jars.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    this.jars = jars

    // Scratch reused while placing performers (no per-iteration allocation).
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3(1, 1, 1)

    for (let i = 0; i < count; i++) {
      const hot = HOTSPOTS[i % HOTSPOTS.length]
      // Scatter around the hotspot so multiple performers don't overlap.
      const ang = rnd() * Math.PI * 2
      const rad = 1.5 + rnd() * 3.5
      const x = hot[0] + Math.cos(ang) * rad
      const z = hot[1] + Math.sin(ang) * rad
      const gy = this.deps.groundY(x, z)

      // Roughly face the hotspot centre (toward passers-by / the crowd).
      const facing = Math.atan2(hot[0] - x, hot[1] - z) + (rnd() * 2 - 1) * 0.5

      const model = createCitizen({
        outfit: outfits[i % outfits.length],
        accent: accents[i % accents.length],
        female: rnd() < 0.45,
        robot: rnd() < 0.35,
      })

      const pivot = new THREE.Group()
      pivot.position.set(x, gy, z)
      pivot.rotation.y = facing
      pivot.add(model.group)
      this.group.add(pivot)

      this.performers.push({
        model,
        pivot,
        baseY: gy,
        baseRotY: facing,
        phase: rnd() * 6.28,
        swaySpeed: 1.1 + rnd() * 0.7,
        bobSpeed: 1.6 + rnd() * 0.9,
        waveSpeed: 0.18 + rnd() * 0.12, // feeds the rig's "speed01" for arm motion
      })

      // Tip jar at the performer's feet, just in front of them.
      p.set(x + Math.sin(facing) * 0.5, gy + 0.12, z + Math.cos(facing) * 0.5)
      m.compose(p, q, s)
      jars.setMatrixAt(i, m)
    }
    jars.instanceMatrix.needsUpdate = true
    this.group.add(jars)

    this.group.visible = this.deps.zone() === 'earth'
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    // Earth-only: keep visibility correct at startup too (setZone only fires on
    // a change, and the player begins on Earth).
    const onEarth = this.deps.zone() === 'earth'
    if (!onEarth) { if (this.group.visible) this.group.visible = false; return }
    if (!this.group.visible) this.group.visible = true

    this.t += dt
    for (const pf of this.performers) {
      // Gentle body sway (rotation) + vertical bob around the feet pivot.
      const a = this.t + pf.phase
      pf.pivot.rotation.y = pf.baseRotY + Math.sin(a * pf.swaySpeed) * 0.12
      pf.pivot.position.y = pf.baseY + Math.abs(Math.sin(a * pf.bobSpeed)) * 0.04
      // Drive the citizen's own walk rig at a low "speed" so the arms wave and
      // the limbs idle without the performer actually walking anywhere.
      pf.model.update(dt, pf.waveSpeed, true)
    }
  }

  dispose() {
    for (const pf of this.performers) pf.model.dispose()
    this.performers = []
    this.jars?.dispose()
    this.jarGeo?.dispose()
    this.jarMat?.dispose()
    this.jars = null
    this.jarGeo = null
    this.jarMat = null
  }
}
