import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the stations stay pinned to the far horizon as you move. */
  focus: () => THREE.Vector3
  /** Active zone, read each frame to gate visibility (mirrors the per-update guard). */
  zone: () => Zone
}

/**
 * Off-world horizon set-dressing: distant ORBITAL SILHOUETTES on the far horizon.
 *
 * MOON: 1-4 compact angular research/mining ring-stations at extreme distance
 * (~450-600u out), dark hull silhouettes with cool twinkling additive running
 * lights, each slowly rotating in place.
 *
 * MARS: a cluster of sprawling industrial refineries / construction platforms in
 * low orbit, dark hulls with warm glowing reactor lights, the whole cluster
 * slowly drifting.
 *
 * Like the space elevator in Megastructure, the active sub-group is offset by the
 * player focus each frame so it reads as fixed on the far horizon no matter where
 * you walk. No colliders, no gameplay — pure additive set-dressing.
 *
 * Draw-call budget: every station hull is dark MeshStandard merged into ONE mesh
 * per zone-set, and ALL running/reactor lights across all stations in a set are
 * drawn as a SINGLE additive InstancedMesh with per-instance color + independent
 * pulse. Tier-gated counts: low = 1 station / no lights, medium = 2 / sparse,
 * high = 3-4 / dense. Zero per-frame heap allocation; scratch objects are reused.
 */
export class OrbitalSilhouettes implements GameSystem {
  private group = new THREE.Group()
  private moonGroup = new THREE.Group()
  private marsGroup = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'
  private t = 0

  // Per-station rotators (Moon: each station spins; Mars: stations are children
  // of the cluster which drifts as a whole). Kept as plain Object3D refs so the
  // per-frame loop touches them without allocating.
  private moonStations: THREE.Object3D[] = []
  private readonly moonSpin: number[] = []

  // One additive InstancedMesh of light quads per zone-set.
  private moonLights: THREE.InstancedMesh | null = null
  private moonLightN = 0
  private marsLights: THREE.InstancedMesh | null = null
  private marsLightN = 0

  // Per-light pulse params (phase + speed), parallel to instance index. Filled at
  // build time so the per-frame loop only reads — no allocation.
  private readonly moonPhase: number[] = []
  private readonly moonSpeed: number[] = []
  private readonly marsPhase: number[] = []
  private readonly marsSpeed: number[] = []
  // Per-light base color, stored once so the pulse can scale brightness off it.
  private readonly moonLightBase: THREE.Color[] = []
  private readonly marsLightBase: THREE.Color[] = []

  // Scratch reused for per-instance brightness writes (no per-frame alloc).
  private readonly scratchColor = new THREE.Color()

  // Anchor offsets: kept far out so the cluster sits on the horizon while we
  // track focus XZ. Mars drift is applied on top of marsBase each frame.
  private readonly moonBase = new THREE.Vector3(40, 70, -520)
  private readonly marsBase = new THREE.Vector3(-120, 90, -540)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const name = config.tier.name
    const low = name === 'low'
    const high = name === 'high'

    // Station counts per tier. Low keeps the silhouette but no lights at all.
    const moonCount = low ? 1 : high ? 4 : 2
    const marsCount = low ? 1 : high ? 4 : 2
    const lightsOn = !low

    this.buildMoon(moonCount, lightsOn)
    this.buildMars(marsCount, lightsOn)

    this.group.add(this.moonGroup, this.marsGroup)
    this.group.visible = false
    scene.add(this.group)
  }

  // ---- Moon: compact angular ring-stations, each slowly rotating ------------
  private buildMoon(count: number, lightsOn: boolean) {
    const hullMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x20242c, roughness: 0.85, metalness: 0.5, fog: false,
    }))

    // Per-station light geometry quad reused across instances.
    const lightGeo = lightsOn ? this.ownG(new THREE.PlaneGeometry(2.6, 2.6)) : null
    const lightMat = lightsOn ? this.own(new THREE.MeshBasicMaterial({
      transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    })) : null

    // Accumulate light matrices/colors across all stations into one buffer, then
    // bake into a single InstancedMesh parented to moonGroup.
    const lightMats: THREE.Matrix4[] = []
    const baseColor = new THREE.Color(0x9fe6ff)

    for (let s = 0; s < count; s++) {
      const station = new THREE.Group()
      // Spread stations around the horizon at slightly varied distance/height.
      const a = (s / Math.max(1, count)) * Math.PI * 2 + 0.6
      const r = 30 + s * 26
      station.position.set(Math.cos(a) * r, (s % 2) * 24 - 8, Math.sin(a) * r)
      station.rotation.set(0.3 * s, a, 0.18 * s)

      // A compact ring with a cross-brace hub: angular research/mining look.
      const ringGeo = new THREE.TorusGeometry(20 + s * 3, 3.2, 6, 14)
      const hubGeo = new THREE.BoxGeometry(7, 7, 26)
      const braceGeo = new THREE.BoxGeometry(26, 4, 4)
      const merged = this.ownG(mergeGeometries([ringGeo, hubGeo, braceGeo], false))
      ringGeo.dispose(); hubGeo.dispose(); braceGeo.dispose()
      station.add(new THREE.Mesh(merged, hullMat))

      this.moonGroup.add(station)
      this.moonStations.push(station)
      // Alternate spin direction, slow.
      this.moonSpin.push((s % 2 === 0 ? 1 : -1) * (0.05 + 0.015 * s))

      // Running lights ride around the station's ring; bake their world-relative
      // matrices (station transform * local) so one InstancedMesh covers all.
      if (lightsOn && lightGeo) {
        const perStation = 8
        const ringR = 20 + s * 3
        const local = new THREE.Matrix4()
        const stationM = new THREE.Matrix4().compose(
          station.position,
          new THREE.Quaternion().setFromEuler(station.rotation),
          new THREE.Vector3(1, 1, 1),
        )
        for (let i = 0; i < perStation; i++) {
          const la = (i / perStation) * Math.PI * 2
          local.makeTranslation(Math.cos(la) * ringR, Math.sin(la) * ringR, 0)
          const world = new THREE.Matrix4().multiplyMatrices(stationM, local)
          lightMats.push(world)
          this.moonLightBase.push(baseColor.clone())
          this.moonPhase.push(la + s)
          this.moonSpeed.push(2.4 + 0.6 * (s % 3))
        }
      }
    }

    if (lightsOn && lightGeo && lightMat && lightMats.length) {
      this.moonLightN = lightMats.length
      // Lights are NOT parented to spinning stations (they'd need per-frame
      // matrix rebuilds); they sit fixed in moonGroup space, which still reads as
      // station markers from extreme distance while costing nothing per frame.
      this.moonLights = new THREE.InstancedMesh(lightGeo, lightMat, this.moonLightN)
      this.moonLights.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      for (let i = 0; i < this.moonLightN; i++) {
        this.moonLights.setMatrixAt(i, lightMats[i])
        this.moonLights.setColorAt(i, this.moonLightBase[i])
      }
      this.moonLights.instanceMatrix.needsUpdate = true
      this.moonGroup.add(this.moonLights)
    }
  }

  // ---- Mars: sprawling industrial refineries, cluster slowly drifting -------
  private buildMars(count: number, lightsOn: boolean) {
    const hullMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x2a2018, roughness: 0.9, metalness: 0.4, fog: false,
    }))

    const lightGeo = lightsOn ? this.ownG(new THREE.PlaneGeometry(3.4, 3.4)) : null
    const lightMat = lightsOn ? this.own(new THREE.MeshBasicMaterial({
      transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    })) : null

    const lightMats: THREE.Matrix4[] = []
    const reactor = new THREE.Color(0xff8a3a)

    // Collect every station hull into ONE merged mesh for the whole cluster.
    const hullParts: THREE.BufferGeometry[] = []

    for (let s = 0; s < count; s++) {
      const a = (s / Math.max(1, count)) * Math.PI * 2 + 1.2
      const r = 36 + s * 30
      const cx = Math.cos(a) * r
      const cy = (s % 3) * 30 - 12
      const cz = Math.sin(a) * r

      // Sprawling platform: a long deck with stacked refinery towers + a reactor
      // drum. Built in local geo then translated into cluster space.
      const deck = new THREE.BoxGeometry(54, 6, 22)
      deck.translate(cx, cy, cz)
      const towerA = new THREE.CylinderGeometry(5, 6, 36, 8)
      towerA.translate(cx - 14, cy + 18, cz)
      const towerB = new THREE.CylinderGeometry(4, 5, 26, 8)
      towerB.translate(cx + 12, cy + 13, cz - 4)
      const drum = new THREE.SphereGeometry(11, 10, 8)
      drum.translate(cx + 4, cy + 10, cz + 8)
      hullParts.push(deck, towerA, towerB, drum)

      if (lightsOn && lightGeo) {
        // A few reactor lights scattered across the platform.
        const spots: Array<[number, number, number]> = [
          [cx - 14, cy + 36, cz],
          [cx + 12, cy + 26, cz - 4],
          [cx + 4, cy + 10, cz + 8],
          [cx - 22, cy + 4, cz + 6],
          [cx + 22, cy + 4, cz - 6],
        ]
        const n = count >= 3 ? spots.length : 3
        for (let i = 0; i < n; i++) {
          const [x, y, z] = spots[i]
          lightMats.push(new THREE.Matrix4().makeTranslation(x, y, z))
          this.marsLightBase.push(reactor.clone())
          this.marsPhase.push(i * 1.3 + s)
          this.marsSpeed.push(1.6 + 0.5 * (i % 3))
        }
      }
    }

    if (hullParts.length) {
      const merged = this.ownG(mergeGeometries(hullParts, false))
      for (const g of hullParts) g.dispose()
      this.marsGroup.add(new THREE.Mesh(merged, hullMat))
    }

    if (lightsOn && lightGeo && lightMat && lightMats.length) {
      this.marsLightN = lightMats.length
      this.marsLights = new THREE.InstancedMesh(lightGeo, lightMat, this.marsLightN)
      this.marsLights.instanceMatrix.setUsage(THREE.StaticDrawUsage)
      for (let i = 0; i < this.marsLightN; i++) {
        this.marsLights.setMatrixAt(i, lightMats[i])
        this.marsLights.setColorAt(i, this.marsLightBase[i])
      }
      this.marsLights.instanceMatrix.needsUpdate = true
      this.marsGroup.add(this.marsLights)
    }
  }

  setZone(zone: Zone) { this.zone = zone }

  update(dt: number) {
    // Drive visibility from the zone each frame (setZone only fires on a change,
    // and the game begins on Earth where this must be hidden).
    const z = this.deps.zone()
    const active = z === 'moon' || z === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return
    this.moonGroup.visible = z === 'moon'
    this.marsGroup.visible = z === 'mars'

    this.t += dt
    const f = this.deps.focus()

    if (z === 'moon') {
      // Keep extreme distance while tracking focus so it stays on the horizon.
      this.moonGroup.position.set(f.x + this.moonBase.x, this.moonBase.y, f.z + this.moonBase.z)
      // Each station rotates slowly in place (frame-rate independent via dt).
      for (let i = 0; i < this.moonStations.length; i++) {
        this.moonStations[i].rotation.z += this.moonSpin[i] * dt
      }
      // Running lights twinkle independently.
      if (this.moonLights) {
        for (let i = 0; i < this.moonLightN; i++) {
          const o = 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(this.t * this.moonSpeed[i] + this.moonPhase[i]))
          this.scratchColor.copy(this.moonLightBase[i]).multiplyScalar(0.9 * o)
          this.moonLights.setColorAt(i, this.scratchColor)
        }
        if (this.moonLights.instanceColor) this.moonLights.instanceColor.needsUpdate = true
      }
    } else {
      // Whole cluster slowly drifts: a gentle lateral sway layered on the anchor.
      const driftX = Math.sin(this.t * 0.04) * 26
      const driftY = Math.sin(this.t * 0.03 + 1) * 10
      this.marsGroup.position.set(
        f.x + this.marsBase.x + driftX,
        this.marsBase.y + driftY,
        f.z + this.marsBase.z,
      )
      this.marsGroup.rotation.y = Math.sin(this.t * 0.02) * 0.12
      if (this.marsLights) {
        for (let i = 0; i < this.marsLightN; i++) {
          const o = 0.35 + 0.6 * (0.5 + 0.5 * Math.sin(this.t * this.marsSpeed[i] + this.marsPhase[i]))
          this.scratchColor.copy(this.marsLightBase[i]).multiplyScalar(0.9 * o)
          this.marsLights.setColorAt(i, this.scratchColor)
        }
        if (this.marsLights.instanceColor) this.marsLights.instanceColor.needsUpdate = true
      }
    }
  }

  dispose() {
    this.moonLights?.dispose()
    this.marsLights?.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
