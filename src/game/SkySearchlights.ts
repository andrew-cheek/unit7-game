import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus (unused for placement, but kept for parity with sky systems). */
  focus: () => THREE.Vector3
  /** Day/night factor: 1 = full day, 0 = night (Earth only). */
  dayFactor: () => number
}

interface Light {
  group: THREE.Group
  baseYaw: number
  panSpeed: number
  panRange: number
  phase: number
}

const NIGHT_AT = 0.55 // dayFactor below this begins to reveal the beams
const FULL_AT = 0.3 // fully bright at/below this dayFactor

/** Deterministic PRNG so the searchlight layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Noir rooftop searchlights for the Earth city: a handful of long translucent
 * additive light-shafts mounted on rooftops that slowly sweep the night sky,
 * fading in at dusk and out at dawn. Pure atmosphere - no colliders, no gameplay.
 * Shared beam + lamp materials (one night-fade opacity per frame), Earth-gated,
 * disposed together.
 */
export class SkySearchlights implements GameSystem {
  private group = new THREE.Group()
  private lights: Light[] = []
  private beamMat: THREE.MeshBasicMaterial
  private lampMat: THREE.MeshBasicMaterial
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'
  private t = 0

  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const count = low ? 3 : 6
    const reach = config.world.half * 0.7
    const rnd = mulberry32(70713)

    // One translucent additive cone shared across every beam. ConeGeometry's apex
    // sits at the top by default; translate it up by height/2 so the apex lands at
    // the group origin (the emitter) and the body extends along +Y. The whole
    // group is then tilted + panned to aim and sweep the shaft.
    const height = 70
    const beamGeo = this.ownG(new THREE.ConeGeometry(6, height, 16, 1, true))
    beamGeo.translate(0, height / 2, 0)
    const lampGeo = this.ownG(new THREE.SphereGeometry(1.2, 10, 8))

    this.beamMat = new THREE.MeshBasicMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide })
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })

    for (let i = 0; i < count; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const y = 18 + rnd() * 22 // rooftop height: reads as on a tall building

      const group = new THREE.Group()
      group.position.set(x, y, z)

      const beam = new THREE.Mesh(beamGeo, this.beamMat)
      // Lean the beam ~30-45deg off vertical so it sweeps across the sky rather
      // than pointing straight up. The group's Y rotation pans this tilted shaft.
      const tilt = THREE.MathUtils.degToRad(32 + rnd() * 13)
      beam.rotation.z = tilt
      group.add(beam)

      const lamp = new THREE.Mesh(lampGeo, this.lampMat)
      group.add(lamp)

      this.group.add(group)
      this.lights.push({
        group,
        baseYaw: rnd() * Math.PI * 2,
        panSpeed: 0.15 + rnd() * 0.2,
        panRange: 0.6 + rnd() * 0.5,
        phase: rnd() * Math.PI * 2,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const onEarth = this.zone === 'earth'
    if (!onEarth) { if (this.group.visible) this.group.visible = false; return }

    const day = this.deps.dayFactor()
    // night: 0 by day (>= NIGHT_AT), ramping to 1 at/below FULL_AT.
    const night = THREE.MathUtils.clamp((NIGHT_AT - day) / (NIGHT_AT - FULL_AT), 0, 1)
    if (night <= 0.02) { if (this.group.visible) this.group.visible = false; return }
    if (!this.group.visible) this.group.visible = true

    this.t += dt
    // Shared materials: set the night-faded opacity once per frame.
    this.beamMat.opacity = night * 0.16
    this.lampMat.opacity = night * 0.9

    for (const l of this.lights) {
      l.group.rotation.y = l.baseYaw + Math.sin(this.t * l.panSpeed + l.phase) * l.panRange
      // A gentle tilt wobble so the sweep doesn't trace a perfectly flat arc.
      l.group.rotation.x = Math.sin(this.t * l.panSpeed * 0.6 + l.phase) * 0.08
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    this.beamMat.dispose()
    this.lampMat.dispose()
  }
}
