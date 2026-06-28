import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Current zone (Mars-gate; checked each update so we stay hidden off-world). */
  zone: () => Zone
  /** Ground height under a point in the current zone (so vents hug the terrain). */
  groundY: (x: number, z: number) => number
}

interface Vent {
  group: THREE.Group
  column: THREE.Mesh // the rising steam cone (shared geo)
  glow: THREE.Mesh // faint warm glow disc at the base (shared geo)
  phase: number // current position in the slow erupt cycle (radians)
  rate: number // erupt cycle speed (rad/s), slow + per-vent varied
}

const AREA = 150 // vents are scattered within a +/-AREA square
const TWO_PI = Math.PI * 2

/**
 * Deterministic hash -> [0,1). Lets us seed vent positions/timers so the field
 * is identical every visit without storing anything. Cheap integer mixing.
 */
function hash(n: number): number {
  let h = (n ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * Mars-only ambient set dressing: clustered ground steam geysers. Each vent
 * erupts a thin translucent steam column - a tall additive, fog-aware cone with
 * depthWrite off - that rises and grows then subsides on a slow, phase-offset
 * per-vent timer, with a faint warm glow at the base. Vents are anchored to
 * deterministic seeded ground positions (via deps.groundY) so the field is the
 * same every visit. Pure set dressing: no colliders, no rewards, no lift.
 *
 * Cheap by construction: one shared cone geometry + one shared glow disc geo,
 * two shared materials, pooled meshes. Mars-gated (hidden elsewhere) and
 * tier-gated counts (low 4 / medium 8 / high 12). Zero per-frame allocation.
 */
export class ThermalVents implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private vents: Vent[] = []
  private zone: Zone = 'earth'

  // Reused scratch (no per-frame heap alloc).
  private scratchColor = new THREE.Color()

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const n = tier === 'low' ? 4 : tier === 'medium' ? 8 : 12

    // Shared steam cone: tall, narrow, apex up. Unit-ish; per-vent scale/opacity
    // is animated via mesh.scale + material is shared (opacity pulses globally is
    // not enough, so we drive a per-vent column scale + a base-only glow).
    const coneGeo = new THREE.ConeGeometry(1, 1, 10, 1, true)
    coneGeo.translate(0, 0.5, 0) // base at y=0, apex at y=1, so scale grows upward
    this.geos.push(coneGeo)

    // Shared base glow disc (faces up, sits just above ground).
    const glowGeo = new THREE.CircleGeometry(1, 18)
    glowGeo.rotateX(-Math.PI / 2)
    this.geos.push(glowGeo)

    const steamMat = new THREE.MeshBasicMaterial({
      color: 0xcfd6dd,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    })
    this.mats.push(steamMat)

    // Clustered scatter: pick a few seeded cluster centres, then jitter vents
    // around them so geysers feel grouped rather than evenly spread.
    const clusters = Math.max(2, Math.ceil(n / 3))
    for (let i = 0; i < n; i++) {
      const c = i % clusters
      const cx = (hash(c * 71 + 11) * 2 - 1) * AREA
      const cz = (hash(c * 131 + 7) * 2 - 1) * AREA
      const ang = hash(i * 977 + 3) * TWO_PI
      const dist = hash(i * 53 + 19) * 22
      const x = THREE.MathUtils.clamp(cx + Math.cos(ang) * dist, -AREA, AREA)
      const z = THREE.MathUtils.clamp(cz + Math.sin(ang) * dist, -AREA, AREA)

      const group = new THREE.Group()
      group.position.set(x, this.deps.groundY(x, z), z)

      const sizeBias = 0.8 + hash(i * 311 + 41) * 0.7

      const column = new THREE.Mesh(coneGeo, steamMat)
      // Narrow column, tall. Stored unit; animated each frame.
      column.position.y = 0
      group.add(column)

      // Per-vent glow material so each base can pulse its own warm colour
      // (n is tiny: <=12). Geometry stays shared.
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0xff7a3c, // warm vent glow
        transparent: true,
        opacity: 0.28,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: true,
      })
      this.mats.push(glowMat)
      const glow = new THREE.Mesh(glowGeo, glowMat)
      glow.position.y = 0.06
      glow.scale.setScalar(1.6 * sizeBias)
      group.add(glow)

      group.scale.setScalar(sizeBias)

      this.vents.push({
        group,
        column,
        glow,
        phase: hash(i * 199 + 5) * TWO_PI, // phase-offset so they don't pulse in sync
        rate: 0.18 + hash(i * 421 + 13) * 0.22, // slow cycle
      })
      this.group.add(group)
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'mars'
  }

  update(dt: number) {
    if (this.deps.zone() !== 'mars') {
      // Per-update guard: stay hidden off-target even if setZone lagged.
      if (this.group.visible) this.group.visible = false
      return
    }
    if (!this.group.visible) this.group.visible = true

    for (const v of this.vents) {
      v.phase += v.rate * dt
      if (v.phase > TWO_PI) v.phase -= TWO_PI

      // Eruption envelope 0..1: rises + grows, then subsides. Smooth, never 0
      // so a wisp always lingers. sin gives the slow swell; clamp the floor.
      const swell = Math.sin(v.phase) * 0.5 + 0.5 // 0..1
      const env = 0.12 + swell * 0.88

      // Column grows taller and a touch wider as it erupts.
      const height = 4 + env * 16 // 4..20 units (before group scale)
      const radius = 0.5 + env * 1.3
      v.column.scale.set(radius, height, radius)

      // Steam material is shared, so we can't fade it per-vent; instead the
      // column reads as erupting through its scale. The base glow (per-vent
      // material) brightens at the peak of the swell.
      const glowPulse = 0.18 + swell * 0.5
      this.scratchColor.setRGB(glowPulse, glowPulse * 0.45, glowPulse * 0.18)
      ;(v.glow.material as THREE.MeshBasicMaterial).color.copy(this.scratchColor)
      // group already applies sizeBias to children, so this is the local pulse only.
      v.glow.scale.x = v.glow.scale.z = 1.2 + swell * 0.9

      // Re-hug terrain (groundY is cheap and zones can differ in height).
      const p = v.group.position
      p.y = this.deps.groundY(p.x, p.z)
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.geos.length = 0
    this.mats.length = 0
    this.vents.length = 0
    if (this.group.parent) this.group.parent.remove(this.group)
  }
}
