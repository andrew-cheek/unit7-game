import * as THREE from 'three'
import { config, type ZoneCfg } from './config'
import { hash01 } from './utils'
import { createSky, createWindowTexture, type SkyModel } from './procedural'
import type { Zone } from './types'

interface Billboard {
  mat: THREE.MeshBasicMaterial
  base: number
  rate: number
  phase: number
}

/**
 * Where the commuter buses stop and where the office buildings sit. Shared with
 * Events so buses + commuters line up with the lit office rooms. `face` is the
 * office group's yaw so its open front points back toward the avenue.
 */
export interface OfficeAnchor {
  office: THREE.Vector3 // office building centre
  door: THREE.Vector3 // where commuters enter (and vanish)
  stop: THREE.Vector3 // bus stop on the avenue
  face: number // office rotation.y
}
export const OFFICE_ANCHORS: OfficeAnchor[] = [
  { office: new THREE.Vector3(48, 0, 10), door: new THREE.Vector3(44, 0, 10), stop: new THREE.Vector3(38, 0, 10), face: -Math.PI / 2 },
  { office: new THREE.Vector3(10, 0, 48), door: new THREE.Vector3(10, 0, 44), stop: new THREE.Vector3(10, 0, 38), face: Math.PI },
  { office: new THREE.Vector3(-48, 0, -10), door: new THREE.Vector3(-44, 0, -10), stop: new THREE.Vector3(-38, 0, -10), face: Math.PI / 2 },
]

const ROT_NONE = new THREE.Quaternion() // identity rotation for instanced transforms
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

// Earth day/night cycle. Short loop so you see a sunrise and sunset within a
// minute of play. The sun comes UP FAST (a quick 6s dawn), holds daylight only
// briefly, then a longer sunset eases into a real stretch of neon-lit night.
const CYCLE = 80
const DAWN_START = 3
const DAWN_END = 9 // 6s sunrise: sun pops up quickly
const DUSK_START = 38 // ~29s of daylight, then it starts dropping
const DUSK_END = 56 // 18s sunset fade into night (~27s of night before dawn)
function dayCycle(time: number): number {
  const u = time % CYCLE
  if (u < DAWN_START) return 0
  if (u < DAWN_END) return smooth01((u - DAWN_START) / (DAWN_END - DAWN_START))
  if (u < DUSK_START) return 1
  if (u < DUSK_END) return 1 - smooth01((u - DUSK_START) / (DUSK_END - DUSK_START))
  return 0
}
const NIGHT = {
  skyTop: new THREE.Color(0x05070f),
  skyBot: new THREE.Color(0x180a2c),
  fog: new THREE.Color(0x070a16),
  ambient: new THREE.Color(0x223044),
  ambientI: 0.55,
  hemiSky: new THREE.Color(0x4a5a80),
  hemiI: 0.55,
  sun: new THREE.Color(0xbfd2ff),
  sunI: 1.0,
}
// "DAY" target (the cycle holds here): a bright blue sky, light haze and strong
// fills so the streets read clearly instead of looking like night-with-a-glow.
const DAWN = {
  skyTop: new THREE.Color(0x4f86e0),
  skyBot: new THREE.Color(0xbcd2f0),
  fog: new THREE.Color(0x6f8fc0),
  ambient: new THREE.Color(0x90a6cc),
  ambientI: 1.95,
  hemiSky: new THREE.Color(0xbcd4ff),
  hemiI: 1.5,
  sun: new THREE.Color(0xffffff),
  sunI: 3.0,
}
// Building window glow is dimmed toward daytime so lit windows don't read at noon.
// Pulled down hard (1.7 -> 1.25 -> 0.85): lit windows should read as a dim
// minority accent on a dark facade, not as light sources. The dark-city value
// contrast depends on this staying low.
const WINDOW_NIGHT_I = 0.85
const WINDOW_DAY_I = 0.16

/**
 * The futuristic district + its atmosphere. Stage 5 art pass turns the gray test
 * city into a neon-noir skyline: window-lit towers (emissive facade textures),
 * wet reflective roads with a neon grid, holographic billboards, a gradient/star
 * sky and volumetric fog. Collision/ground/landmark data is unchanged so physics
 * and the radar keep working.
 */
export class World {
  readonly group = new THREE.Group()
  readonly colliders: THREE.Box3[] = []
  readonly groundMeshes: THREE.Mesh[] = []
  readonly solidMeshes: THREE.Mesh[] = []
  readonly landmarks: { x: number; z: number }[] = []
  readonly bounds: THREE.Box3
  readonly spawn = new THREE.Vector3(0, 0, 0)

  sun!: THREE.DirectionalLight
  hemi!: THREE.HemisphereLight
  ambient!: THREE.AmbientLight

  private scene: THREE.Scene
  private boxGeo = new THREE.BoxGeometry(1, 1, 1)
  // Unit cylinder (radius 0.5, height 1) for round-tower silhouette variety.
  private cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 18)
  // Shared unit roof caps (scaled per tower) for building-silhouette variety.
  private domeGeo = new THREE.SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  private spireGeo = new THREE.ConeGeometry(0.5, 1, 10)
  private pyramidGeo = new THREE.ConeGeometry(0.5, 1, 4) // 4-sided crystal/pyramid cap
  private crownGeo = new THREE.TorusGeometry(0.5, 0.12, 6, 16) // glowing roof ring
  private tankGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12) // rooftop water tank
  private groundMat!: THREE.MeshStandardMaterial
  private windowTex: THREE.CanvasTexture[] = []
  private ownedMats: THREE.Material[] = []
  private ownedTex: THREE.Texture[] = []
  private ownedGeos: THREE.BufferGeometry[] = []
  private billboards: Billboard[] = []
  private facadeMats: THREE.MeshStandardMaterial[] = [] // window-lit tower facades (dimmed by day)
  private accentLights: THREE.PointLight[] = []
  private elevatorClimbers: { mesh: THREE.Mesh; t: number; speed: number }[] = []
  private elevatorRing?: THREE.Object3D
  private hangarBots: { mesh: THREE.Mesh; baseY: number; phase: number }[] = []
  private spaceportBeacon?: THREE.Object3D
  private spaceportWarn: THREE.MeshStandardMaterial[] = []
  private launchShip?: { mesh: THREE.Mesh; state: 'parked' | 'rising'; timer: number; vy: number; baseY: number }
  private trainSamples: THREE.Vector3[] = []
  private trainCars: THREE.Object3D[] = []
  private trainT = 0
  private tickers: { tex: THREE.CanvasTexture; speed: number; redraw: (lines: string[]) => void }[] = []
  private breaking: string[] = [] // runtime "BREAKING" headlines, newest first
  private beacons: { mat: THREE.MeshBasicMaterial; phase: number }[] = []
  private routeDashes: THREE.MeshBasicMaterial[] = []
  private static readonly ELEV = { x: 0, z: -108, baseTop: 120, tetherTop: 640 }
  private sky!: SkyModel
  private sunTarget = new THREE.Object3D()
  // Visible sun in the sky (glow + bright core sprites) that rises/sets with the
  // day cycle. Separate from the directional `sun` light, which you can't see.
  private sunGroup = new THREE.Group()
  private sunCoreMat!: THREE.SpriteMaterial
  private sunGlowMat!: THREE.SpriteMaterial
  private time = 0
  private dawn = 0 // current day factor (0 night .. 1 full day)

  /** Day-cycle factor, 0 = night, 1 = full day. Used to time the invasion. */
  get dayFactor() {
    return this.dawn
  }
  // Atmosphere + set dressing.
  private rain?: THREE.Points
  private rainGeo?: THREE.BufferGeometry
  private rainCount = 0
  private embers?: THREE.Points
  private emberGeo?: THREE.BufferGeometry
  private shafts: THREE.Mesh[] = []
  private dishes: THREE.Group[] = []
  private adPanels: THREE.MeshStandardMaterial[] = []
  private zone: Zone = 'earth'
  private cTmp = new THREE.Color()
  private cTmp2 = new THREE.Color()

  constructor(scene: THREE.Scene, zone: Zone = 'earth') {
    this.scene = scene
    scene.add(this.group)

    const half = config.world.half
    this.bounds = new THREE.Box3(new THREE.Vector3(-half, -10, -half), new THREE.Vector3(half, 260, half))

    this.buildMaterials()
    this.sky = createSky(0x05070f, 0x150a28, config.tier.starCount)
    scene.add(this.sky.group) // sky persists across zones (just recolored)
    this.buildGround()
    this.buildRoads()
    this.buildStreetProps()
    this.buildCity()
    this.buildNearbyBuildings()
    this.buildElevatedPlatform()
    this.buildDriveHighway()
    this.buildExtras()
    this.buildSkyline()
    this.buildLandmark()
    this.buildColossusStatue()
    this.buildSpaceElevator()
    this.buildMarket()
    this.buildSetPieces()
    this.buildAdPanels()
    this.buildOffices()
    this.buildMechHangar(60, 60)
    this.buildSpaceport(118, 96)
    this.buildHoverTrain()
    this.buildNewsTickers()
    this.buildRouteTrail()
    this.buildAtmosphere()
    this.buildLights()
    this.addBoundaryColliders()
    this.applyZone(zone)
  }

  private own<T extends THREE.Material>(m: T): T {
    this.ownedMats.push(m)
    return m
  }
  private ownG<T extends THREE.BufferGeometry>(g: T): T {
    this.ownedGeos.push(g)
    return g
  }
  private glow(color: number, intensity = 3) {
    return this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: intensity, roughness: 0.4 }))
  }

  private buildMaterials() {
    this.groundMat = this.own(
      new THREE.MeshStandardMaterial({ color: config.palette.asphalt, roughness: 0.3, metalness: 0.55 }), // wet sheen via env reflection
    )
    this.groundMat.envMapIntensity = config.tier.envMapIntensity
    this.windowTex = [3, 11, 27, 54, 71, 96, 123, 158].map((s) => createWindowTexture(s))
    this.windowTex.forEach((t) => {
      t.anisotropy = config.tier.anisotropy
      this.ownedTex.push(t)
    })
    this.ownedGeos.push(this.domeGeo, this.spireGeo, this.pyramidGeo, this.crownGeo, this.tankGeo, this.cylGeo)
  }

  private buildGround() {
    const half = config.world.half
    const geo = new THREE.PlaneGeometry(half * 2, half * 2, 1, 1)
    geo.rotateX(-Math.PI / 2)
    const ground = new THREE.Mesh(geo, this.groundMat)
    ground.receiveShadow = true
    ground.name = 'ground'
    this.group.add(ground)
    this.groundMeshes.push(ground)
    this.solidMeshes.push(ground)
  }

  /** Neon grid down the avenues - instant cyberpunk-road read on the wet ground. */
  private buildRoads() {
    const half = config.world.half
    const pitch = config.world.block + config.world.roadWidth
    const cells = Math.floor(half / pitch)
    const lineMat = this.glow(config.palette.cyan, 2.2)
    const lineGeo = this.boxGeo
    const make = (x: number, z: number, sx: number, sz: number) => {
      const m = new THREE.Mesh(lineGeo, lineMat)
      m.scale.set(sx, 0.05, sz)
      m.position.set(x, 0.03, z)
      this.group.add(m)
    }
    for (let i = -cells; i <= cells; i++) {
      const c = i * pitch + pitch / 2
      if (Math.abs(c) > half) continue
      make(c, 0, 0.4, half * 2) // along Z
      make(0, c, half * 2, 0.4) // along X
    }
  }

  /**
   * Street lamps lining the avenues - the single cheapest way to make the
   * ground plane read as streets instead of empty slabs. Two InstancedMeshes
   * (posts + warm heads) so the whole set is just two draw calls. Spacing is
   * widened on mobile to keep the instance count down.
   */
  private buildStreetProps() {
    const half = config.world.half
    const pitch = config.world.block + config.world.roadWidth
    const cells = Math.floor(half / pitch)
    const curb = config.world.roadWidth / 2 + 0.4 // just inside the road edge
    const spacing = config.tier.name === 'high' ? 40 : 64
    const postH = 7

    const pts: Array<{ x: number; z: number }> = []
    for (let i = -cells; i <= cells; i++) {
      const c = i * pitch + pitch / 2
      if (Math.abs(c) > half) continue
      for (let d = -half + spacing; d < half; d += spacing) {
        pts.push({ x: c - curb, z: d }, { x: c + curb, z: d }) // avenue running Z
        pts.push({ x: d, z: c - curb }, { x: d, z: c + curb }) // avenue running X
      }
    }
    const n = pts.length
    if (n === 0) return

    const postGeo = this.ownG(new THREE.CylinderGeometry(0.12, 0.16, postH, 6))
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3038, metalness: 0.7, roughness: 0.5 }))
    const posts = new THREE.InstancedMesh(postGeo, postMat, n)
    const headGeo = this.ownG(new THREE.SphereGeometry(0.3, 8, 6))
    // Warm head, just under the bloom threshold so lamps glow softly without
    // adding to the neon overload.
    const headMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd9a8, fog: true }))
    const heads = new THREE.InstancedMesh(headGeo, headMat, n)
    const m = new THREE.Matrix4()
    for (let k = 0; k < n; k++) {
      m.makeTranslation(pts[k].x, postH / 2, pts[k].z)
      posts.setMatrixAt(k, m)
      m.makeTranslation(pts[k].x, postH + 0.1, pts[k].z)
      heads.setMatrixAt(k, m)
    }
    posts.instanceMatrix.needsUpdate = true
    heads.instanceMatrix.needsUpdate = true
    this.group.add(posts, heads)
  }

  private addBuilding(cx: number, cz: number, fx: number, fz: number, h: number, seed: number) {
    // ~40% of towers are dark, matte concrete/metal with NO glowing window grid.
    // This is the main lever for both "less neon" and "more variety": the city
    // becomes lit towers standing among dark ones, instead of every face glowing.
    const dark = hash01(seed * 1.31) < 0.4
    // ~16% are cylindrical for silhouette variety against the box towers.
    const round = hash01(seed * 2.91) < 0.16
    const bodyGeo = round ? this.cylGeo : this.boxGeo

    let mat: THREE.MeshStandardMaterial
    if (dark) {
      const cset = [0x14171e, 0x191c24, 0x10131a, 0x1c2029, 0x21262f]
      mat = this.own(new THREE.MeshStandardMaterial({
        color: cset[Math.floor(hash01(seed * 1.7) * cset.length)],
        metalness: 0.5,
        roughness: 0.72,
        envMapIntensity: config.tier.envMapIntensity,
      }))
    } else {
      const facade = [0x0c0e15, 0x0f1219, 0x12151f, 0x0a0c12, 0x14181f, 0x0a1117, 0x161019][Math.floor(hash01(seed * 1.7) * 7)]
      const tex = this.windowTex[Math.floor(hash01(seed * 2.3) * this.windowTex.length)].clone()
      tex.needsUpdate = true
      tex.anisotropy = config.tier.anisotropy
      tex.repeat.set(Math.max(2, Math.round(fx / 6)), Math.max(3, Math.round(h / 8)))
      // Per-building offset so neighbouring towers don't share the same lit pattern.
      tex.offset.set(hash01(seed * 3.1), hash01(seed * 4.2))
      this.ownedTex.push(tex)
      mat = this.own(new THREE.MeshStandardMaterial({
        color: facade,
        metalness: 0.35,
        roughness: 0.55,
        emissive: 0xffffff,
        emissiveMap: tex,
        emissiveIntensity: WINDOW_NIGHT_I,
        envMapIntensity: config.tier.envMapIntensity,
      }))
      this.facadeMats.push(mat) // only lit towers dim with the day cycle
    }
    const mesh = new THREE.Mesh(bodyGeo, mat)
    mesh.scale.set(fx, h, fz)
    mesh.position.set(cx, h / 2, cz)
    mesh.castShadow = config.tier.buildingShadows // off on mobile (perf)
    mesh.receiveShadow = true
    this.group.add(mesh)
    this.solidMeshes.push(mesh)
    this.landmarks.push({ x: cx, z: cz })
    this.colliders.push(new THREE.Box3(new THREE.Vector3(cx - fx / 2, 0, cz - fz / 2), new THREE.Vector3(cx + fx / 2, h, cz + fz / 2)))

    // Neon roofline trim on a minority of towers + a vertical spine up tall ones.
    // Restricted to the 3-hue accent set (cyan / magenta / violet) for palette
    // discipline so a city block isn't every colour at once.
    const ACCENTS = [config.palette.cyan, config.palette.magenta, config.palette.purple]
    const neonCorner = ACCENTS[Math.floor(hash01(seed * 6.7) * ACCENTS.length)]
    // Trim on ~35% of lit towers (never on dark ones) at a calm intensity so
    // neon reads as occasional accent trim, not a glowing crown on every roof.
    if (!dark && !round && hash01(seed * 5.1) > 0.65) {
      const trim = new THREE.Mesh(this.boxGeo, this.glow(neonCorner, 1.5))
      trim.scale.set(fx + 0.6, 0.7, fz + 0.6)
      trim.position.set(cx, h + 0.1, cz)
      this.group.add(trim)
    }
    // Desktop-only decorative neon (extra draw calls). On mobile the window
    // texture carries the sci-fi look, so these are skipped to hold frame rate.
    // Dark towers stay matte (no spines/bands) for value contrast; round towers
    // skip the box-shaped neon strips that wouldn't wrap a cylinder cleanly.
    const richFacade = config.tier.name === 'high' && !dark && !round
    // A glowing vertical spine on taller towers (front + back faces).
    if (richFacade && h > 46 && hash01(seed * 8.9) > 0.55) {
      const spineMat = this.glow(neonCorner, 1.8)
      for (const sz of [fz / 2 + 0.05, -fz / 2 - 0.05]) {
        const spine = new THREE.Mesh(this.boxGeo, spineMat)
        spine.scale.set(0.5, h * 0.92, 0.3)
        spine.position.set(cx, h * 0.5, cz + sz)
        this.group.add(spine)
      }
    }
    // Stacked horizontal neon light-bands wrapping tall towers (Coruscant look).
    if (richFacade && h > 58 && hash01(seed * 9.7) > 0.55) {
      const bandMat = this.glow(neonCorner, 1.5)
      const bands = Math.min(3, Math.floor(h / 26))
      for (let k = 1; k <= bands; k++) {
        const band = new THREE.Mesh(this.boxGeo, bandMat)
        band.scale.set(fx + 0.5, 0.5, fz + 0.5)
        band.position.set(cx, (h * k) / (bands + 1), cz)
        this.group.add(band)
      }
    }
    // Roof-shape variety so the skyline isn't all flat boxes.
    const roof = hash01(seed * 4.4)
    const neonPick = ACCENTS[Math.floor(hash01(seed * 6.1) * ACCENTS.length)]
    if (roof < 0.14) {
      // Domed cap.
      const dome = new THREE.Mesh(this.domeGeo, mat)
      dome.scale.set(fx, Math.min(fx, fz) * 0.6, fz)
      dome.position.set(cx, h, cz)
      this.group.add(dome)
    } else if (roof < 0.28) {
      // Spire cap (glowing on lit towers, matte on dark ones).
      const spire = new THREE.Mesh(this.spireGeo, dark ? mat : this.glow(config.palette.cyan, 2.4))
      const sh = 6 + hash01(seed * 4.9) * 10
      spire.scale.set(fx * 0.5, sh, fz * 0.5)
      spire.position.set(cx, h + sh / 2, cz)
      this.group.add(spire)
    } else if (roof < 0.42) {
      // Ziggurat: two shrinking setbacks stacked into a stepped pyramid.
      let sw = fx, sd = fz, sy = h
      for (let k = 0; k < 2; k++) {
        const sh = 4 + hash01(seed * (4.1 + k)) * 8
        sw *= 0.64; sd *= 0.64
        const step = new THREE.Mesh(this.boxGeo, mat)
        step.scale.set(sw, sh, sd)
        step.position.set(cx, sy + sh / 2, cz)
        step.castShadow = config.tier.buildingShadows
        this.group.add(step)
        sy += sh
      }
    } else if (roof < 0.54) {
      // Pyramid / tapered crystal cap (4-sided cone).
      const pyr = new THREE.Mesh(this.pyramidGeo, (!dark && hash01(seed * 7.3) > 0.5) ? this.glow(neonPick, 2.0) : mat)
      const ph = Math.min(fx, fz) * (0.7 + hash01(seed * 5.5) * 0.8)
      pyr.rotation.y = Math.PI / 4
      pyr.scale.set(fx * 0.72, ph, fz * 0.72)
      pyr.position.set(cx, h + ph / 2, cz)
      this.group.add(pyr)
    } else if (roof < 0.64) {
      // Crown ring around the roofline (matte on dark towers).
      const crown = new THREE.Mesh(this.crownGeo, dark ? mat : this.glow(neonPick, 2.8))
      crown.rotation.x = Math.PI / 2
      crown.scale.set(fx * 0.6, fz * 0.6, Math.max(fx, fz) * 0.18)
      crown.position.set(cx, h + 0.6, cz)
      this.group.add(crown)
    } else if (roof < 0.74) {
      // Rooftop water-tank / utility cluster on stilts.
      for (let k = 0; k < 2; k++) {
        const tank = new THREE.Mesh(this.tankGeo, k === 0 ? mat : this.glow(neonPick, 1.6))
        const r = Math.min(fx, fz) * 0.18
        tank.scale.set(r, 2 + hash01(seed * (3.3 + k)) * 2, r)
        tank.position.set(cx + (k ? 1 : -1) * fx * 0.22, h + 1.4, cz + (hash01(seed * (2.2 + k)) - 0.5) * fz * 0.3)
        this.group.add(tank)
      }
    }

    // Rooftop antenna mast with a glowing tip on some towers (adds verticality).
    if (hash01(seed * 8.3) > 0.6) {
      const mast = new THREE.Mesh(this.boxGeo, this.own(new THREE.MeshStandardMaterial({ color: 0x2a3140, metalness: 0.7, roughness: 0.5 })))
      const mh = 4 + hash01(seed * 9.1) * 8
      mast.scale.set(0.25, mh, 0.25)
      mast.position.set(cx, h + mh / 2, cz)
      this.group.add(mast)
      const tip = new THREE.Mesh(this.boxGeo, this.glow(config.palette.magenta, 3))
      tip.scale.set(0.5, 0.5, 0.5)
      tip.position.set(cx, h + mh, cz)
      this.group.add(tip)
      // Blinking aircraft-warning beacon on the mast tip (desktop only - animated).
      if (config.tier.name === 'high') {
        const beaconMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff3b3b, fog: false, transparent: true }))
        const beacon = new THREE.Mesh(this.domeGeo, beaconMat)
        beacon.scale.set(0.6, 0.6, 0.6)
        beacon.position.set(cx, h + mh + 0.4, cz)
        this.group.add(beacon)
        this.beacons.push({ mat: beaconMat, phase: hash01(seed * 12.1) * 6.28 })
      }
    }
  }

  private buildCity() {
    const pitch = config.world.block + config.world.roadWidth
    const cells = Math.floor(config.world.half / pitch)
    for (let i = -cells; i <= cells; i++) {
      for (let j = -cells; j <= cells; j++) {
        if (i === 0 && j === 0) continue
        if (i === 1 && j === 0) continue // platform
        const cx = i * pitch
        const cz = j * pitch
        const seed = (i + 50) * 131 + (j + 50)
        if (hash01(seed) < 0.1) continue
        const distNorm = Math.min(1, Math.hypot(i, j) / cells)
        const maxH = 120 * (1 - distNorm) + 20 // taller glowing towers
        const usable = config.world.block - config.world.sidewalk * 2
        const n = hash01(seed * 7) < 0.45 ? 2 : 1
        for (let k = 0; k < n; k++) {
          const fx = 16 + hash01(seed * 3 + k) * (usable - 16) * (n === 2 ? 0.55 : 1)
          const fz = 16 + hash01(seed * 5 + k) * (usable - 16) * (n === 2 ? 0.55 : 1)
          const h = 14 + hash01(seed * 11 + k) * maxH
          const ox = n === 2 ? (k === 0 ? -1 : 1) * (usable * 0.22) : 0
          const oz = n === 2 ? (hash01(seed * 13 + k) - 0.5) * usable * 0.3 : 0
          this.addBuilding(cx + ox, cz + oz, fx, fz, h, seed * 19 + k)
        }
      }
    }
  }

  /** Big holographic billboards on the avenues; they pulse in World.update. */
  /** Cluster of smaller buildings around the spawn plaza (kept clear of the
   *  portals/vehicles) so the immediate area has structures, not empty ground. */
  private buildNearbyBuildings() {
    const spots: Array<[number, number]> = [
      [-26, 24], [24, 26], [-30, -6], [30, -4], [-16, 34], [16, 36],
      [-38, 16], [38, 18], [-22, -28], [22, -30], [0, 42], [-40, -22], [40, -24],
    ]
    for (let i = 0; i < spots.length; i++) {
      const [cx, cz] = spots[i]
      if (Math.hypot(cx, cz) < 20) continue // keep the immediate spawn clear
      const seed = 900 + i * 13
      const fx = 8 + hash01(seed) * 8
      const fz = 8 + hash01(seed * 1.7) * 8
      const h = 8 + hash01(seed * 2.3) * 16 // short, neighborhood-scale
      this.addBuilding(cx, cz, fx, fz, h, seed)
    }
  }

  private buildSignage() {
    const colors = [config.palette.cyan, config.palette.magenta, config.palette.orange, config.palette.lime, config.palette.purple]
    const spots: Array<[number, number, number]> = [
      [30, 8, 0.4], [-34, -20, -0.7], [44, -60, 1.4], [-60, 40, 2.4], [70, 90, 0.8], [-90, -70, -2.0], [10, 80, 3.0], [-44, 110, -0.5],
    ]
    spots.forEach(([x, z, rot], i) => {
      const c = colors[i % colors.length]
      const mat = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: true })
      this.ownedMats.push(mat)
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(8, 12), mat)
      panel.position.set(x, 16 + (i % 3) * 6, z)
      panel.rotation.y = rot
      this.group.add(panel)
      const frame = new THREE.Mesh(this.boxGeo, this.glow(c, 2.4))
      frame.scale.set(8.6, 12.6, 0.3)
      frame.position.copy(panel.position)
      frame.rotation.y = rot
      this.group.add(frame)
      this.billboards.push({ mat, base: 0.7, rate: 1.5 + i * 0.3, phase: i })
    })
  }

  private buildElevatedPlatform() {
    const pitch = config.world.block + config.world.roadWidth
    const px = pitch
    const pz = 0
    const height = 6
    const size = 30
    const deckMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1a1f2c, metalness: 0.6, roughness: 0.4 }))
    const deck = new THREE.Mesh(this.boxGeo, deckMat)
    deck.scale.set(size, 1.2, size)
    deck.position.set(px, height, pz)
    deck.castShadow = true
    deck.receiveShadow = true
    this.group.add(deck)
    this.groundMeshes.push(deck)
    this.solidMeshes.push(deck)
    this.colliders.push(new THREE.Box3(new THREE.Vector3(px - size / 2, 0, pz - size / 2), new THREE.Vector3(px + size / 2, height - 0.6, pz + size / 2)))

    const run = 22
    const rise = height
    const width = 10
    const slope = Math.hypot(run, rise)
    const angle = Math.atan2(rise, run)
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(width, 0.6, slope), this.own(new THREE.MeshStandardMaterial({ color: 0x171b27, metalness: 0.55, roughness: 0.45 })))
    ramp.rotation.x = -angle
    const z0 = pz - size / 2
    ramp.position.set(px, rise / 2, z0 - run / 2)
    ramp.castShadow = true
    ramp.receiveShadow = true
    this.group.add(ramp)
    this.groundMeshes.push(ramp)
    this.solidMeshes.push(ramp)

    const arch = new THREE.Mesh(this.boxGeo, this.glow(config.palette.cyan, 3))
    arch.scale.set(width + 2, 0.6, 0.6)
    arch.position.set(px, 0.3, z0 - run - 1)
    this.group.add(arch)
  }

  /**
   * A low elevated highway you can actually drive on: a long straight deck at a
   * modest height with a down-ramp at each end, glowing edge rails and support
   * pillars. The deck + ramps go into the ground/solid meshes so the hover
   * vehicles raycast onto them and drive up and along it. Runs along X just
   * south of the plaza so it's visible and reachable from spawn.
   */
  private buildDriveHighway() {
    const z = -36 // over the south avenue (clear road gap between building rows)
    const top = 9 // deck height (closer to the ground than the sky highway)
    const half = 140 // deck spans x -half..half
    const w = 14 // road width
    const deckMat = this.own(new THREE.MeshStandardMaterial({ color: 0x161a24, metalness: 0.5, roughness: 0.5 }))
    const deckMat2 = this.own(new THREE.MeshStandardMaterial({ color: 0x10131c, metalness: 0.5, roughness: 0.5 }))

    const deck = new THREE.Mesh(this.boxGeo, deckMat)
    deck.scale.set(half * 2, 1.0, w)
    deck.position.set(0, top, z)
    deck.castShadow = config.tier.buildingShadows
    deck.receiveShadow = true
    this.group.add(deck)
    this.groundMeshes.push(deck)
    this.solidMeshes.push(deck)
    // (No full-length collider - you can walk/drive under the deck; only the
    //  pillars below are solid, added with the pillars further down.)

    // Centre lane line (glowing) + edge rails.
    const lane = new THREE.Mesh(this.boxGeo, this.glow(config.palette.orange, 2.0))
    lane.scale.set(half * 2, 0.06, 0.5)
    lane.position.set(0, top + 0.56, z)
    this.group.add(lane)
    for (const off of [-w / 2 + 0.4, w / 2 - 0.4]) {
      const rail = new THREE.Mesh(this.boxGeo, this.glow(off < 0 ? config.palette.cyan : config.palette.magenta, 2.6))
      rail.scale.set(half * 2, 0.7, 0.4)
      rail.position.set(0, top + 0.7, z + off)
      this.group.add(rail)
    }

    // A down-ramp at each end so vehicles can climb up from the street.
    const run = 30
    const slope = Math.hypot(run, top)
    const angle = Math.atan2(top, run)
    for (const dir of [-1, 1]) {
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(slope, 0.8, w), deckMat2)
      ramp.rotation.z = dir * angle
      ramp.position.set(dir * (half + run / 2), top / 2, z)
      ramp.castShadow = config.tier.buildingShadows
      ramp.receiveShadow = true
      this.group.add(ramp)
      this.groundMeshes.push(ramp)
      this.solidMeshes.push(ramp)
    }

    // Support pillars down to the street.
    const pillarMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1a1f2c, metalness: 0.6, roughness: 0.5 }))
    for (let x = -half + 20; x <= half - 20; x += 40) {
      const pillar = new THREE.Mesh(this.boxGeo, pillarMat)
      pillar.scale.set(2.2, top, 2.2)
      pillar.position.set(x, top / 2, z)
      pillar.castShadow = config.tier.buildingShadows
      this.group.add(pillar)
      this.colliders.push(new THREE.Box3(new THREE.Vector3(x - 1.1, 0, z - 1.1), new THREE.Vector3(x + 1.1, top, z + 1.1)))
    }
  }

  private buildPlazaNeon() {
    const count = 8
    const radius = 16
    const neon = [config.palette.cyan, config.palette.magenta, config.palette.purple, config.palette.orange, config.palette.lime]
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2
      const x = Math.cos(a) * radius
      const z = Math.sin(a) * radius
      const h = 7 + hash01(i * 9.7) * 5
      const pylon = new THREE.Mesh(this.boxGeo, this.glow(neon[i % neon.length], 3))
      pylon.scale.set(0.5, h, 0.5)
      pylon.position.set(x, h / 2, z)
      this.group.add(pylon)
      this.solidMeshes.push(pylon)
      this.colliders.push(new THREE.Box3(new THREE.Vector3(x - 0.4, 0, z - 0.4), new THREE.Vector3(x + 0.4, h, z + 0.4)))
    }
  }

  /**
   * Ground-level dressing only (the sky is kept clear): a few lit landing pads
   * and scattered glow crates. Static meshes, cheap; scales with city.density.
   */
  private buildExtras() {
    const d = Math.max(0, config.city.density)
    const neon = [config.palette.cyan, config.palette.magenta, config.palette.purple, config.palette.orange, config.palette.lime]

    // Ground landing pads (lit rings).
    const padGeo = this.ownG(new THREE.CylinderGeometry(5, 5.4, 0.18, 28))
    const padSpots: Array<[number, number]> = [[34, 30], [-46, 26], [70, -50], [-80, -16]]
    for (let i = 0; i < padSpots.length; i++) {
      const [x, z] = padSpots[i]
      const pad = new THREE.Mesh(padGeo, this.glow(neon[i % neon.length], 2.2))
      pad.position.set(x, 0.1, z)
      this.group.add(pad)
    }

    // Scattered glow crates near the central plaza.
    const crateMat = this.own(new THREE.MeshStandardMaterial({ color: 0x12161f, metalness: 0.6, roughness: 0.5 }))
    for (let i = 0; i < Math.round(10 * d); i++) {
      const a = hash01(i * 3.7) * Math.PI * 2
      const r = 10 + hash01(i * 6.1) * 22
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const crate = new THREE.Mesh(this.boxGeo, crateMat)
      const s = 0.9 + hash01(i * 2.3) * 0.6
      crate.scale.set(s, s, s)
      crate.position.set(x, s / 2, z)
      crate.castShadow = true
      this.group.add(crate)
      const cap = new THREE.Mesh(this.boxGeo, this.glow(neon[i % neon.length], 2.4))
      cap.scale.set(s * 0.5, 0.08, s * 0.5)
      cap.position.set(x, s + 0.04, z)
      this.group.add(cap)
    }
  }

  /** Distant silhouette skyline ringing the playable area (fog-immune so it
   *  reads through the fog as far-off city), for a sense of vast scale. */
  private buildSkyline() {
    const R = config.world.half + 90
    const neon = [config.palette.cyan, config.palette.magenta, config.palette.purple, config.palette.orange]
    const n = config.tier.name === 'high' ? 72 : 38
    // Instanced: the whole ring is two draw calls (bodies + neon caps) instead
    // of ~150 meshes - a big draw-call saving on mobile for the far field.
    const bodyMat = this.own(new THREE.MeshBasicMaterial({ color: 0x0a1124, fog: false }))
    const capMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })) // tinted per-instance
    const bodies = new THREE.InstancedMesh(this.boxGeo, bodyMat, n)
    const caps = new THREE.InstancedMesh(this.boxGeo, capMat, n)
    bodies.frustumCulled = false
    caps.frustumCulled = false
    const m = new THREE.Matrix4()
    const col = new THREE.Color()
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const r = R + hash01(i * 3.1) * 90
      const h = 60 + hash01(i * 7.7) * 230
      const w = 14 + hash01(i * 2.3) * 28
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      m.compose(new THREE.Vector3(x, h / 2 - 10, z), ROT_NONE, new THREE.Vector3(w, h, w))
      bodies.setMatrixAt(i, m)
      m.compose(new THREE.Vector3(x, h - 10, z), ROT_NONE, new THREE.Vector3(w + 2, 3, w + 2))
      caps.setMatrixAt(i, m)
      caps.setColorAt(i, col.setHex(neon[i % neon.length]))
    }
    bodies.instanceMatrix.needsUpdate = true
    caps.instanceMatrix.needsUpdate = true
    if (caps.instanceColor) caps.instanceColor.needsUpdate = true
    this.group.add(bodies, caps)
  }

  /** One colossal arcology + a space-elevator tether, visible from anywhere as a
   *  scale landmark (fog-immune). */
  private buildLandmark() {
    const x = -250
    const z = -210
    const body = this.own(new THREE.MeshBasicMaterial({ color: 0x111a30, fog: false }))
    const neon = this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, fog: false }))
    for (let i = 0; i < 5; i++) {
      const w = 86 - i * 14
      const seg = new THREE.Mesh(this.boxGeo, body)
      seg.scale.set(w, 72, w)
      seg.position.set(x, 36 + i * 72, z)
      this.group.add(seg)
      const ring = new THREE.Mesh(this.boxGeo, neon)
      ring.scale.set(w + 3, 2.5, w + 3)
      ring.position.set(x, 72 + i * 72, z)
      this.group.add(ring)
    }
    const tether = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.6, 1.6, 950, 8)), neon)
    tether.position.set(x + 150, 470, z + 70)
    this.group.add(tether)
  }

  /**
   * A colossal Unit-7 robot statue towering over the city — the game's mascot as
   * a giant landmark you can see from across the map. Built from cheap blocky
   * parts with fog-immune materials (so it reads from a distance) and a glowing
   * visor + chest reactor. Static (no per-frame cost); base is solid + on radar.
   */
  private buildColossusStatue() {
    const x = 210
    const z = -150
    const armor = this.own(new THREE.MeshStandardMaterial({ color: 0x2c3b4a, metalness: 0.85, roughness: 0.35, fog: false }))
    const dark = this.own(new THREE.MeshStandardMaterial({ color: 0x141a26, metalness: 0.7, roughness: 0.5, fog: false }))
    const visor = this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, fog: false }))
    const core = this.own(new THREE.MeshBasicMaterial({ color: config.palette.magenta, fog: false }))
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    const part = (mat: THREE.Material, sx: number, sy: number, sz: number, px: number, py: number, pz: number) => {
      const m = new THREE.Mesh(this.boxGeo, mat)
      m.scale.set(sx, sy, sz)
      m.position.set(px, py, pz)
      g.add(m)
      return m
    }
    // Legs (feet at y=0), torso, shoulders, arms, head — total ~64m tall.
    for (const lx of [-5, 5]) {
      part(dark, 6, 26, 7, lx, 13, 0) // thigh+shin
      part(armor, 8, 4, 10, lx, 1.5, 1) // foot
      part(armor, 7, 6, 8, lx, 27, 0) // hip pad
    }
    part(dark, 16, 4, 11, 0, 30, 0) // pelvis
    part(armor, 20, 20, 13, 0, 42, 0) // torso
    const reactor = part(core, 6, 6, 1.5, 0, 44, 6.6) // chest reactor
    reactor.scale.z = 2
    for (const sx of [-13, 13]) {
      part(armor, 7, 7, 9, sx, 50, 0) // shoulder
      part(dark, 5, 22, 5, sx, 38, 0) // arm
      part(armor, 5.5, 5, 5.5, sx, 26, 0) // fist
    }
    part(dark, 9, 3, 9, 0, 53.5, 0) // neck base
    part(armor, 11, 9, 10, 0, 59, 0) // head
    const eye = part(visor, 8, 1.6, 1, 0, 60, 5.2) // glowing visor
    void eye
    // A beacon spike on the crown so it pings on the skyline.
    part(visor, 1.2, 7, 1.2, 0, 67, 0)
    this.group.add(g)
    this.landmarks.push({ x, z })
    this.colliders.push(new THREE.Box3(new THREE.Vector3(x - 12, 0, z - 8), new THREE.Vector3(x + 12, 30, z + 8)))
  }

  /**
   * The centerpiece: a colossal space elevator near the middle of the map. A
   * tapering megastructure base rises to a thick tether climbing far into the
   * sky, capped by a slowly rotating orbital ring + station. Climber cars ride
   * the tether (animated in update). Upper parts are fog-immune so it reads as a
   * landmark from anywhere. The base is solid (collider + on radar).
   */
  private buildSpaceElevator() {
    const { x, z, baseTop, tetherTop } = World.ELEV
    const dark = this.own(new THREE.MeshStandardMaterial({ color: 0x141a26, metalness: 0.7, roughness: 0.45 }))
    const farMetal = this.own(new THREE.MeshBasicMaterial({ color: 0x1a2740, fog: false }))
    const glowCyan = this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, fog: false }))
    const glowMag = this.own(new THREE.MeshBasicMaterial({ color: config.palette.magenta, fog: false }))

    // Tapering base tower (3 stacked segments) with neon trim rings.
    const segs: Array<[number, number]> = [[26, 50], [18, 42], [12, 30]] // [width, height]
    let y = 0
    for (let i = 0; i < segs.length; i++) {
      const [w, h] = segs[i]
      const seg = new THREE.Mesh(this.boxGeo, dark)
      seg.scale.set(w, h, w)
      seg.position.set(x, y + h / 2, z)
      seg.castShadow = config.tier.buildingShadows
      seg.receiveShadow = true
      this.group.add(seg)
      this.solidMeshes.push(seg)
      const ring = new THREE.Mesh(this.boxGeo, i % 2 ? glowMag : glowCyan)
      ring.scale.set(w + 1.5, 1.6, w + 1.5)
      ring.position.set(x, y + h, z)
      this.group.add(ring)
      y += h
    }
    // Base collider (so you can't walk through it) + radar landmark.
    this.colliders.push(new THREE.Box3(new THREE.Vector3(x - 13, 0, z - 13), new THREE.Vector3(x + 13, baseTop, z + 13)))
    this.landmarks.push({ x, z })

    // The tether: a tall glowing cylinder + four guide cables.
    const tetherH = tetherTop - baseTop
    const tether = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(2.2, 2.8, tetherH, 12)), farMetal)
    tether.position.set(x, baseTop + tetherH / 2, z)
    this.group.add(tether)
    const beam = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.5, 0.5, tetherH, 8)), glowCyan)
    beam.position.copy(tether.position)
    this.group.add(beam)

    // Climber cars riding the tether (animated). Bright so they read at distance.
    const carGeo = this.ownG(new THREE.BoxGeometry(7, 3.5, 7))
    for (let i = 0; i < 3; i++) {
      const car = new THREE.Mesh(carGeo, i === 1 ? glowMag : farMetal)
      car.position.set(x, baseTop, z)
      this.group.add(car)
      this.elevatorClimbers.push({ mesh: car, t: i / 3, speed: 0.04 + i * 0.012 })
    }

    // Orbital station: a hub + a big slowly rotating ring at the top.
    const station = new THREE.Group()
    station.position.set(x, tetherTop, z)
    const hub = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(10, 14, 10, 16)), farMetal)
    station.add(hub)
    const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(58, 3.4, 10, 40)), glowCyan)
    ring.rotation.x = Math.PI / 2
    station.add(ring)
    const ring2 = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(40, 1.6, 8, 36)), glowMag)
    ring2.rotation.x = Math.PI / 2
    station.add(ring2)
    // Spokes connecting hub to ring.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2
      const spoke = new THREE.Mesh(this.boxGeo, farMetal)
      spoke.scale.set(58, 1.4, 1.4)
      spoke.position.set(Math.cos(a) * 29, 0, Math.sin(a) * 29)
      spoke.rotation.y = -a
      station.add(spoke)
    }
    this.group.add(station)
    this.elevatorRing = station
  }

  /**
   * Mech Hangar: an industrial bay framing the colossus mech so it reads as a
   * destination ("go pilot the giant robot"). Open front faces spawn, with a
   * warning-stripe pad, tall frame pillars + overhead gantry, neon trim and a
   * couple of bobbing repair bots. Open-topped so the mech can lift off.
   */
  private buildMechHangar(cx: number, cz: number) {
    const g = new THREE.Group()
    g.position.set(cx, 0, cz)
    g.rotation.y = Math.atan2(-cx, -cz) // opening faces the city/spawn
    const W = 44, H = 56, D = 30
    const steel = this.own(new THREE.MeshStandardMaterial({ color: 0x1a1f2c, metalness: 0.75, roughness: 0.4 }))
    const warn = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.orange, emissiveIntensity: 2.2, roughness: 0.5 }))
    const trim = this.glow(config.palette.cyan, 2.6)

    // Landing pad with a warning-stripe border.
    const pad = new THREE.Mesh(this.boxGeo, this.own(new THREE.MeshStandardMaterial({ color: 0x12151f, metalness: 0.6, roughness: 0.6 })))
    pad.scale.set(W, 0.4, D); pad.position.set(0, 0.2, -D / 2 + 4); pad.receiveShadow = true
    g.add(pad)
    for (const sx of [-1, 1]) {
      const stripe = new THREE.Mesh(this.boxGeo, warn)
      stripe.scale.set(2, 0.5, D); stripe.position.set(sx * (W / 2 - 1), 0.25, -D / 2 + 4)
      g.add(stripe)
    }
    // Frame: two tall pillars + overhead gantry (open top so the mech flies out).
    for (const sx of [-1, 1]) {
      const pillar = new THREE.Mesh(this.boxGeo, steel)
      pillar.scale.set(4, H, 4); pillar.position.set(sx * (W / 2), H / 2, -D + 4); pillar.castShadow = config.tier.buildingShadows
      g.add(pillar)
      this.colliders.push(new THREE.Box3(new THREE.Vector3(cx + sx * (W / 2) - 2, 0, cz - D + 2), new THREE.Vector3(cx + sx * (W / 2) + 2, H, cz - D + 6)))
      const stripe = new THREE.Mesh(this.boxGeo, warn)
      stripe.scale.set(4.4, 4, 0.4); stripe.position.set(sx * (W / 2), H - 6, -D + 2)
      g.add(stripe)
    }
    const gantry = new THREE.Mesh(this.boxGeo, steel)
    gantry.scale.set(W + 4, 4, 5); gantry.position.set(0, H - 2, -D + 4)
    g.add(gantry)
    const gantryGlow = new THREE.Mesh(this.boxGeo, trim)
    gantryGlow.scale.set(W, 0.6, 0.6); gantryGlow.position.set(0, H - 4.2, -D + 1.6)
    g.add(gantryGlow)
    // Back wall (low, partial) so it reads as a bay, not a cage.
    const back = new THREE.Mesh(this.boxGeo, steel)
    back.scale.set(W, 16, 2); back.position.set(0, 8, -D + 3); back.castShadow = config.tier.buildingShadows
    g.add(back)
    this.group.add(g)

    // Bobbing repair bots near the pad (world space, animated in update).
    const botMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3140, metalness: 0.7, roughness: 0.4 }))
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2
      const bx = cx + Math.cos(a) * 16
      const bz = cz + Math.sin(a) * 16
      const bot = new THREE.Mesh(this.boxGeo, botMat)
      bot.scale.set(1.2, 1.2, 1.2)
      const baseY = 3 + i
      bot.position.set(bx, baseY, bz)
      this.group.add(bot)
      const eye = new THREE.Mesh(this.boxGeo, this.glow(config.palette.lime, 3))
      eye.scale.set(0.5, 0.2, 0.2); eye.position.set(0, 0, 0.6); bot.add(eye)
      this.hangarBots.push({ mesh: bot, baseY, phase: a })
    }
  }

  /**
   * Spaceport: a launch-pad complex landmark - a tall control tower with a
   * rotating beacon, lit landing pads, parked freighters, stacked cargo, pulsing
   * warning lights, and one ship that periodically lifts off. Tower top is
   * fog-immune so it reads as a far landmark. Animated in update().
   */
  private buildSpaceport(cx: number, cz: number) {
    const g = new THREE.Group()
    g.position.set(cx, 0, cz)
    const steel = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.8, roughness: 0.4 }))
    const hull = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4456, metalness: 0.8, roughness: 0.4 }))

    // Apron.
    const apron = new THREE.Mesh(this.boxGeo, this.own(new THREE.MeshStandardMaterial({ color: 0x12151f, metalness: 0.55, roughness: 0.6 })))
    apron.scale.set(60, 0.3, 48); apron.position.set(0, 0.15, 0); apron.receiveShadow = true
    g.add(apron)

    // Control tower (tall, fog-immune cap + rotating beacon).
    const tower = new THREE.Mesh(this.boxGeo, steel)
    tower.scale.set(6, 64, 6); tower.position.set(-22, 32, -16); tower.castShadow = config.tier.buildingShadows
    g.add(tower)
    const pod = new THREE.Mesh(this.boxGeo, this.own(new THREE.MeshBasicMaterial({ color: 0x223247, fog: false })))
    pod.scale.set(10, 5, 10); pod.position.set(-22, 64, -16)
    g.add(pod)
    const beacon = new THREE.Group()
    beacon.position.set(-22, 68, -16)
    const beam = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(2.4, 16, 12, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, transparent: true, opacity: 0.32, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    beam.rotation.z = Math.PI / 2; beam.position.x = 6
    beacon.add(beam)
    g.add(beacon)
    this.spaceportBeacon = beacon
    this.colliders.push(new THREE.Box3(new THREE.Vector3(cx - 25, 0, cz - 19), new THREE.Vector3(cx - 19, 64, cz - 13)))

    // Lit landing pads.
    const padGeo = this.ownG(new THREE.CylinderGeometry(8, 8.5, 0.3, 28))
    const padSpots: Array<[number, number, number]> = [[12, 8, config.palette.cyan], [22, -14, config.palette.orange], [-2, -16, config.palette.lime]]
    for (const [px, pz, c] of padSpots) {
      const pad = new THREE.Mesh(padGeo, this.glow(c, 2.2))
      pad.position.set(px, 0.32, pz)
      g.add(pad)
    }

    // Parked freighters (primitive hulls with fins + engine glow).
    const mkFreighter = (px: number, pz: number, ry: number) => {
      const f = new THREE.Group()
      f.position.set(px, 3.2, pz); f.rotation.y = ry
      const body = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(2.4, 2.8, 16, 12)), hull)
      body.rotation.z = Math.PI / 2; body.castShadow = config.tier.buildingShadows
      f.add(body)
      const nose = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(2.4, 5, 12)), hull)
      nose.rotation.z = -Math.PI / 2; nose.position.x = 10.5
      f.add(nose)
      for (const sx of [-1, 1]) {
        const fin = new THREE.Mesh(this.boxGeo, steel)
        fin.scale.set(3, 0.4, 3); fin.position.set(-6, 0, sx * 2.5); fin.rotation.x = sx * 0.5
        f.add(fin)
      }
      const eng = new THREE.Mesh(this.boxGeo, this.glow(config.palette.magenta, 3))
      eng.scale.set(0.6, 2.6, 2.6); eng.position.set(-8.2, 0, 0)
      f.add(eng)
      g.add(f)
    }
    mkFreighter(12, 8, 0.3)
    mkFreighter(-2, -16, -0.6)

    // Stacked cargo containers (glow-edged).
    const conMat = this.own(new THREE.MeshStandardMaterial({ color: 0x223040, metalness: 0.5, roughness: 0.6 }))
    for (let i = 0; i < 8; i++) {
      const cxx = 24 + (i % 2) * 4.4
      const cy = 1.2 + Math.floor(i / 2) * 2.4
      const con = new THREE.Mesh(this.boxGeo, i % 3 === 0 ? this.glow([config.palette.cyan, config.palette.orange, config.palette.lime][i % 3], 1.6) : conMat)
      con.scale.set(4, 2.2, 6); con.position.set(cxx, cy, 16); con.castShadow = config.tier.buildingShadows
      g.add(con)
    }

    // Pulsing warning lights around the pads.
    for (const [wx, wz] of [[2, 18], [-14, 10], [30, 2], [-12, -18]] as Array<[number, number]>) {
      const mat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.orange, emissiveIntensity: 2 }))
      const post = new THREE.Mesh(this.boxGeo, mat)
      post.scale.set(0.5, 3, 0.5); post.position.set(wx, 1.5, wz)
      g.add(post)
      this.spaceportWarn.push(mat)
    }

    // One ship that periodically lifts off from the first pad.
    const ship = new THREE.Group()
    ship.position.set(12, 3.2, 8)
    const sbody = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(2, 2.4, 12, 12)), hull)
    sbody.rotation.x = Math.PI / 2
    ship.add(sbody)
    const scone = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(2, 4, 12)), hull)
    scone.position.y = 8
    ship.add(scone)
    const sthr = new THREE.Mesh(this.boxGeo, this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    sthr.scale.set(2.4, 3, 2.4); sthr.position.y = -7
    ship.add(sthr)
    // Treat the group as a "mesh" handle for the animation record.
    const shipMesh = ship as unknown as THREE.Mesh
    g.add(ship)
    this.launchShip = { mesh: shipMesh, state: 'parked', timer: 8, vy: 0, baseY: 3.2 }

    this.group.add(g)
    this.landmarks.push({ x: cx, z: cz })
  }

  /**
   * Elevated hover-train: a sleek multi-car maglev that loops a glowing rail
   * ringing the city at rooftop height - living background motion + a landmark.
   * Rail + train are fog-immune so they read from a distance. Animated in update.
   */
  private buildHoverTrain() {
    const ctrl: THREE.Vector3[] = []
    const N = 7
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2
      const r = 178 + Math.sin(a * 2) * 24
      ctrl.push(new THREE.Vector3(Math.cos(a) * r, 30 + Math.sin(a * 3) * 5, Math.sin(a) * r))
    }
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'catmullrom', 0.5)
    const S = 300
    for (let i = 0; i < S; i++) this.trainSamples.push(curve.getPointAt(i / S))
    // Glowing rail.
    const rail = new THREE.Mesh(
      this.ownG(new THREE.TubeGeometry(curve, S, 0.5, 5, true)),
      this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })),
    )
    this.group.add(rail)
    // Train cars: sleek body + bright window strip.
    const carGeo = this.ownG(new THREE.BoxGeometry(2.6, 2.0, 7))
    const winGeo = this.ownG(new THREE.BoxGeometry(2.7, 0.7, 6))
    const carMat = this.own(new THREE.MeshBasicMaterial({ color: 0x16345a, fog: false }))
    const winMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbfe6ff, fog: false }))
    for (let i = 0; i < 6; i++) {
      const car = new THREE.Group()
      car.add(new THREE.Mesh(carGeo, carMat))
      const w = new THREE.Mesh(winGeo, winMat); w.position.y = 0.4; car.add(w)
      this.group.add(car)
      this.trainCars.push(car)
    }
  }

  /**
   * Animated news-ticker billboards: big neon signs that scroll humanoid-robot
   * headlines. The headline strip is rendered to a canvas once; the sign just
   * advances the texture offset each frame (no per-frame redraw, so it's cheap).
   */
  private buildNewsTickers() {
    type Place = { x: number; y: number; z: number; ry: number; w: number; color: string }
    const places: Place[] = [
      { x: 0, y: 24, z: 36, ry: Math.PI, w: 22, color: '#27e7ff' },
      { x: -34, y: 18, z: 0, ry: Math.PI / 2, w: 16, color: '#ff2bd0' },
      { x: 34, y: 18, z: 0, ry: -Math.PI / 2, w: 16, color: '#9bff4d' },
      { x: 0, y: 20, z: -64, ry: 0, w: 18, color: '#ff8a1e' },
      { x: 64, y: 16, z: 44, ry: -Math.PI * 0.75, w: 13, color: '#8a5cff' },
    ]
    places.forEach((p, i) => {
      const ph = p.w * 0.16 // sign height
      // A fixed-width canvas; the strip is drawn (and re-drawn on BREAKING news).
      const H = 72
      const W = 3200
      const cv = document.createElement('canvas')
      cv.width = W; cv.height = H
      const ctx = cv.getContext('2d')!
      const tex = new THREE.CanvasTexture(cv)
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = config.tier.anisotropy
      this.ownedTex.push(tex)
      const rot = i % 8
      const redraw = (lines: string[]) => {
        ctx.fillStyle = '#05060b'; ctx.fillRect(0, 0, W, H)
        ctx.font = '700 44px ui-monospace, Menlo, monospace'
        ctx.textBaseline = 'middle'
        let x = 40
        for (const line of lines) {
          const breaking = line.startsWith('★')
          ctx.fillStyle = breaking ? '#ff3b3b' : p.color
          ctx.shadowColor = ctx.fillStyle
          ctx.shadowBlur = 14
          ctx.fillText(line, x, H / 2)
          x += ctx.measureText(line).width
          ctx.fillStyle = '#5f6b82'; ctx.shadowBlur = 0
          ctx.fillText('   ◆   ', x, H / 2)
          x += ctx.measureText('   ◆   ').width
        }
        tex.needsUpdate = true
      }
      const mat = this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, fog: false }))
      tex.repeat.x = (p.w / ph) / (W / H)
      tex.repeat.y = 1
      const sign = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(p.w, ph)), mat)
      const g = new THREE.Group()
      g.position.set(p.x, p.y, p.z)
      g.rotation.y = p.ry
      g.add(sign)
      // Glowing frame + a fixed "NEWS" tag tab on the left.
      const frameMat = this.glow(parseInt(p.color.slice(1), 16), 2.6)
      const top = new THREE.Mesh(this.boxGeo, frameMat); top.scale.set(p.w + 0.6, 0.4, 0.4); top.position.y = ph / 2 + 0.2; g.add(top)
      const bot = new THREE.Mesh(this.boxGeo, frameMat); bot.scale.set(p.w + 0.6, 0.4, 0.4); bot.position.y = -ph / 2 - 0.2; g.add(bot)
      const tag = new THREE.Mesh(this.boxGeo, this.glow(parseInt(p.color.slice(1), 16), 3))
      tag.scale.set(ph * 1.1, ph + 0.6, 0.5); tag.position.set(-p.w / 2 - ph * 0.55, 0, 0.1); g.add(tag)
      this.group.add(g)
      this.tickers.push({ tex, speed: 0.045 + i * 0.006, redraw })
      // Initial content (rotated per sign).
      redraw(config.news.slice(rot).concat(config.news.slice(0, rot)))
    })
  }

  /** Inject a reactive BREAKING headline that scrolls across every ticker. */
  pushHeadline(text: string) {
    this.breaking.unshift('★ BREAKING: ' + text.toUpperCase())
    if (this.breaking.length > 3) this.breaking.pop()
    for (let i = 0; i < this.tickers.length; i++) {
      const rot = i % 8
      const base = config.news.slice(rot).concat(config.news.slice(0, rot))
      this.tickers[i].redraw([...this.breaking, ...base])
    }
  }

  /**
   * A glowing dotted "follow me" route on the ground from spawn to Portal Plaza.
   * Each dash pulses in sequence so the light visibly travels toward the plaza -
   * an unmissable first-30-seconds navigation cue. Cheap (~10 flat quads).
   */
  private buildRouteTrail() {
    const fromZ = 3, toZ = 12, n = 10
    for (let i = 0; i < n; i++) {
      const z = fromZ + (toZ - fromZ) * (i / (n - 1))
      const mat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const dash = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(1.4, 0.9)), mat)
      dash.rotation.x = -Math.PI / 2
      dash.position.set(0, 0.12, z) // spawn plaza is on the flat ground plane
      this.group.add(dash)
      this.routeDashes.push(mat)
    }
  }

  /** A small alien market district: canopied stalls, glow signs, crates, pods. */
  private buildMarket() {
    const ox = -80
    const oz = 72
    const canopyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x342654, roughness: 0.7, metalness: 0.2 }))
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x20242f, roughness: 0.6, metalness: 0.4 }))
    const podMat = this.own(new THREE.MeshStandardMaterial({ color: 0x0b2a1c, emissive: 0x2bff8a, emissiveIntensity: 1.4, roughness: 0.4, metalness: 0.2 }))
    const neon = [config.palette.cyan, config.palette.magenta, config.palette.lime, config.palette.orange]
    for (let gx = 0; gx < 4; gx++) {
      for (let gz = 0; gz < 2; gz++) {
        const x = ox + gx * 9
        const z = oz + gz * 11
        const c = neon[(gx + gz) % neon.length]
        const canopy = new THREE.Mesh(this.boxGeo, canopyMat)
        canopy.scale.set(5, 0.3, 5)
        canopy.position.set(x, 3.0, z)
        canopy.rotation.x = 0.08
        this.group.add(canopy)
        for (const sx of [-2.1, 2.1]) {
          for (const sz of [-2.1, 2.1]) {
            const post = new THREE.Mesh(this.boxGeo, postMat)
            post.scale.set(0.18, 3, 0.18)
            post.position.set(x + sx, 1.5, z + sz)
            this.group.add(post)
          }
        }
        const sign = new THREE.Mesh(this.boxGeo, this.glow(c, 2.6))
        sign.scale.set(4.2, 0.5, 0.2)
        sign.position.set(x, 3.4, z - 2.2)
        this.group.add(sign)
        const crate = new THREE.Mesh(this.boxGeo, this.glow(c, 1.6))
        crate.scale.set(0.8, 0.8, 0.8)
        crate.position.set(x + 1.2, 0.4, z + 1.0)
        this.group.add(crate)
        if ((gx + gz) % 2 === 0) {
          const pod = new THREE.Mesh(this.domeGeo, podMat)
          pod.scale.set(1.4, 2.4, 1.4)
          pod.position.set(x - 1.4, 0, z + 1.4)
          this.group.add(pod)
        }
      }
    }
  }

  /** Rotating radar dishes on tall poles - small animated "alive" detail. */
  private buildSetPieces() {
    const spots: Array<[number, number]> = [[64, -44], [-52, -96], [104, 44]]
    const poleMat = this.own(new THREE.MeshStandardMaterial({ color: 0x20242f, metalness: 0.7, roughness: 0.5 }))
    const dishMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4456, metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide }))
    const dishGeo = this.ownG(new THREE.CylinderGeometry(3, 0.5, 1.4, 16, 1, true))
    for (const [x, z] of spots) {
      const pole = new THREE.Mesh(this.boxGeo, poleMat)
      pole.scale.set(0.6, 14, 0.6)
      pole.position.set(x, 7, z)
      this.group.add(pole)
      const pivot = new THREE.Group()
      pivot.position.set(x, 14, z)
      const dish = new THREE.Mesh(dishGeo, dishMat)
      dish.rotation.z = 0.7
      dish.position.y = 1
      const emitter = new THREE.Mesh(this.boxGeo, this.glow(config.palette.magenta, 3))
      emitter.scale.set(0.3, 0.3, 0.3)
      emitter.position.set(0, 1.6, 0)
      pivot.add(dish, emitter)
      this.group.add(pivot)
      this.dishes.push(pivot)
    }
  }

  /** Wall-mounted animated neon ad panels (pulse in update). Not free-floating. */
  private buildAdPanels() {
    const spots: Array<[number, number, number]> = [[34, 20, 0.4], [-30, -40, 1.8], [70, 56, -0.6], [-64, 30, 2.4], [18, 90, 0.1]]
    const neon = [config.palette.cyan, config.palette.magenta, config.palette.orange, config.palette.lime, config.palette.purple]
    for (let i = 0; i < spots.length; i++) {
      const [x, z, rot] = spots[i]
      const mat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: neon[i % neon.length], emissiveIntensity: 1.8, roughness: 0.5 }))
      const panel = new THREE.Mesh(this.boxGeo, mat)
      panel.scale.set(7, 11, 0.4)
      panel.position.set(x, 14 + (i % 3) * 5, z)
      panel.rotation.y = rot
      this.group.add(panel)
      this.adPanels.push(mat)
    }
  }

  /**
   * Glass-fronted ground-floor office rooms at the bus-stop buildings: a lit
   * interior with desk rows and seated worker robots facing glowing monitors,
   * so the city's commuters have somewhere to "go to work". The open front faces
   * the avenue (anchor.face) so you see the workers from the street.
   */
  private buildOffices() {
    const wallMat = this.own(new THREE.MeshStandardMaterial({ color: 0x20242f, metalness: 0.5, roughness: 0.6 }))
    const floorMat = this.own(new THREE.MeshStandardMaterial({ color: 0x14171f, metalness: 0.4, roughness: 0.7 }))
    const deskMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3142, metalness: 0.6, roughness: 0.5 }))
    const workerMat = this.own(new THREE.MeshStandardMaterial({ color: config.palette.robot, metalness: 0.7, roughness: 0.4 }))
    // Warm interior glow so the office reads as lit and occupied.
    const lightMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffe6b0 }))

    const W = 8, D = 6, H = 3.6
    for (const a of OFFICE_ANCHORS) {
      const g = new THREE.Group()
      g.position.copy(a.office)
      g.rotation.y = a.face
      // Local space: open front at +Z, room extends to -Z.
      const floor = new THREE.Mesh(this.boxGeo, floorMat)
      floor.scale.set(W, 0.2, D); floor.position.set(0, 0.1, -D / 2)
      floor.receiveShadow = true
      g.add(floor)
      const back = new THREE.Mesh(this.boxGeo, wallMat)
      back.scale.set(W, H, 0.3); back.position.set(0, H / 2, -D)
      g.add(back)
      for (const sx of [-1, 1]) {
        const side = new THREE.Mesh(this.boxGeo, wallMat)
        side.scale.set(0.3, H, D); side.position.set(sx * W / 2, H / 2, -D / 2)
        g.add(side)
      }
      const roof = new THREE.Mesh(this.boxGeo, wallMat)
      roof.scale.set(W, 0.25, D); roof.position.set(0, H, -D / 2)
      roof.castShadow = true
      g.add(roof)
      // Ceiling light strip.
      const strip = new THREE.Mesh(this.boxGeo, lightMat)
      strip.scale.set(W * 0.7, 0.12, 0.5); strip.position.set(0, H - 0.2, -D / 2)
      g.add(strip)
      // Two desks with a seated worker robot + glowing monitor each.
      for (const dx of [-W / 4, W / 4]) {
        const desk = new THREE.Mesh(this.boxGeo, deskMat)
        desk.scale.set(2.0, 0.12, 1.0); desk.position.set(dx, 1.05, -D + 1.4)
        g.add(desk)
        const monitor = new THREE.Mesh(this.boxGeo, this.glow(config.palette.cyan, 2.2))
        monitor.scale.set(1.0, 0.6, 0.08); monitor.position.set(dx, 1.5, -D + 1.05)
        g.add(monitor)
        // Seated worker: torso + head, facing the monitor (toward -Z).
        const torso = new THREE.Mesh(this.boxGeo, workerMat)
        torso.scale.set(0.5, 0.7, 0.4); torso.position.set(dx, 1.25, -D + 2.1)
        torso.castShadow = true
        g.add(torso)
        const head = new THREE.Mesh(this.boxGeo, workerMat)
        head.scale.set(0.3, 0.3, 0.3); head.position.set(dx, 1.75, -D + 2.1)
        g.add(head)
      }
      this.group.add(g)
    }
  }

  /** Neon drizzle near the player + drifting embers + (desktop) light shafts. */
  private buildAtmosphere() {
    const high = config.tier.name === 'high'
    // Rain (follows the focus point each frame).
    this.rainCount = high ? 700 : 200
    const rp = new Float32Array(this.rainCount * 3)
    for (let i = 0; i < this.rainCount; i++) {
      rp[i * 3] = (Math.random() - 0.5) * 130
      rp[i * 3 + 1] = Math.random() * 80
      rp[i * 3 + 2] = (Math.random() - 0.5) * 130
    }
    this.rainGeo = new THREE.BufferGeometry()
    this.rainGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3))
    this.ownedGeos.push(this.rainGeo)
    const rainMat = this.own(new THREE.PointsMaterial({ color: 0x8fd8ff, size: 0.5, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending }))
    this.rain = new THREE.Points(this.rainGeo, rainMat)
    this.rain.frustumCulled = false
    this.group.add(this.rain)

    // Embers drifting upward near the streets.
    const ec = high ? 130 : 50
    const ep = new Float32Array(ec * 3)
    for (let i = 0; i < ec; i++) {
      ep[i * 3] = (Math.random() - 0.5) * 120
      ep[i * 3 + 1] = Math.random() * 30
      ep[i * 3 + 2] = (Math.random() - 0.5) * 120
    }
    this.emberGeo = new THREE.BufferGeometry()
    this.emberGeo.setAttribute('position', new THREE.BufferAttribute(ep, 3))
    this.ownedGeos.push(this.emberGeo)
    const emberMat = this.own(new THREE.PointsMaterial({ color: 0xff9a3c, size: 0.35, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }))
    this.embers = new THREE.Points(this.emberGeo, emberMat)
    this.embers.frustumCulled = false
    this.group.add(this.embers)

    // Volumetric-ish light shafts at a few neon hotspots (desktop only).
    if (high) {
      const shaftGeo = this.ownG(new THREE.CylinderGeometry(0.8, 6, 60, 14, 1, true))
      const spots: Array<[number, number, number]> = [[0, 0, config.palette.cyan], [34, 8, config.palette.magenta], [-34, -20, config.palette.purple], [44, -60, config.palette.orange]]
      for (const [x, z, c] of spots) {
        const mat = this.own(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }))
        const shaft = new THREE.Mesh(shaftGeo, mat)
        shaft.position.set(x, 30, z)
        this.group.add(shaft)
        this.shafts.push(shaft)
      }
    }
  }

  private buildLights() {
    this.hemi = new THREE.HemisphereLight(0x4a5a80, 0x0a0a12, 0.55)
    this.scene.add(this.hemi)
    this.ambient = new THREE.AmbientLight(0x223044, 0.55)
    this.scene.add(this.ambient)

    this.sun = new THREE.DirectionalLight(0xbfd2ff, 1.0)
    this.sun.position.set(60, 90, 40)
    this.sun.castShadow = config.tier.shadows
    const shadowSize = config.tier.shadowMapSize
    this.sun.shadow.mapSize.set(shadowSize, shadowSize)
    const s = 70
    this.sun.shadow.camera.left = -s
    this.sun.shadow.camera.right = s
    this.sun.shadow.camera.top = s
    this.sun.shadow.camera.bottom = -s
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 400
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.02
    this.scene.add(this.sun, this.sunTarget)
    this.sun.target = this.sunTarget
    this.buildSun()

    // A few colored accent fills near neon hotspots (no shadows - cheap).
    // Desktop only; mobile leans on the emissive + IBL alone to save draw cost.
    const accents: Array<[number, number, number, number]> = config.tier.accentLights
      ? [
          [0, 8, 0, config.palette.cyan], [30, 6, 8, config.palette.magenta], [-34, 6, -20, config.palette.purple], [44, 6, -60, config.palette.orange],
        ]
      : []
    for (const [x, y, z, c] of accents) {
      const pl = new THREE.PointLight(c, 42, 50, 2)
      pl.position.set(x, y, z)
      this.scene.add(pl)
      this.accentLights.push(pl)
    }
  }

  private addBoundaryColliders() {
    const half = config.world.half
    const t = 6
    const tall = 120
    const make = (min: THREE.Vector3, max: THREE.Vector3) => this.colliders.push(new THREE.Box3(min, max))
    make(new THREE.Vector3(-half - t, 0, -half - t), new THREE.Vector3(half + t, tall, -half))
    make(new THREE.Vector3(-half - t, 0, half), new THREE.Vector3(half + t, tall, half + t))
    make(new THREE.Vector3(-half - t, 0, -half), new THREE.Vector3(-half, tall, half))
    make(new THREE.Vector3(half, 0, -half), new THREE.Vector3(half + t, tall, half))
  }

  applyZone(zone: Zone) {
    this.zone = zone
    const z: ZoneCfg = config.zones[zone]
    const fogColor = new THREE.Color(z.fog)
    this.scene.fog = new THREE.FogExp2(fogColor.getHex(), zone === 'moon' ? 0.006 : 0.011)
    this.scene.background = fogColor.clone()
    this.groundMat.color.setHex(z.ground)
    this.ambient.color.setHex(z.ambient)
    this.ambient.intensity = z.ambientI
    const skyColors: Record<Zone, [number, number]> = {
      earth: [0x05070f, 0x180a2c],
      mars: [0x10060a, 0x5a1c0c],
      moon: [0x010104, 0x0a0a16],
    }
    this.sky.setColors(skyColors[zone][0], skyColors[zone][1])
    // Wetter, more mirror-like roads on Earth so the neon reflects off the tarmac.
    this.groundMat.metalness = zone === 'earth' ? 0.72 : 0.15
    this.groundMat.roughness = zone === 'earth' ? 0.18 : 0.85
    this.groundMat.envMapIntensity = config.tier.envMapIntensity * (zone === 'earth' ? 1.7 : 1)
  }

  /** Show/hide the Earth city (used when traveling to Mars/Moon). */
  cityVisible(v: boolean) {
    this.group.visible = v
    this.accentLights.forEach((l) => (l.visible = v))
  }

  /** Blend night -> dawn across the lighting, sky and fog for the given 0..1. */
  private applyDawn(t: number) {
    this.sky.setColors(
      this.cTmp.copy(NIGHT.skyTop).lerp(DAWN.skyTop, t).getHex(),
      this.cTmp2.copy(NIGHT.skyBot).lerp(DAWN.skyBot, t).getHex(),
    )
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(NIGHT.fog).lerp(DAWN.fog, t)
    }
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(NIGHT.fog).lerp(DAWN.fog, t)
    }
    this.ambient.color.copy(NIGHT.ambient).lerp(DAWN.ambient, t)
    this.ambient.intensity = lerp(NIGHT.ambientI, DAWN.ambientI, t)
    this.hemi.color.copy(NIGHT.hemiSky).lerp(DAWN.hemiSky, t)
    this.hemi.intensity = lerp(NIGHT.hemiI, DAWN.hemiI, t)
    this.sun.color.copy(NIGHT.sun).lerp(DAWN.sun, t)
    this.sun.intensity = lerp(NIGHT.sunI, DAWN.sunI, t)
    // Dim the lit windows toward daytime so towers don't glow at noon.
    const winI = lerp(WINDOW_NIGHT_I, WINDOW_DAY_I, t)
    for (const m of this.facadeMats) m.emissiveIntensity = winI
  }

  /**
   * Builds the visible sun: a soft glow sprite + a bright core sprite sharing a
   * radial-gradient texture. Additive and fog-immune so it reads as a bright
   * disc in the sky and gets caught by bloom. Positioned each frame in `update`.
   */
  private buildSun() {
    const size = 128
    const cv = document.createElement('canvas')
    cv.width = cv.height = size
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.28, 'rgba(255,255,255,0.95)')
    g.addColorStop(0.5, 'rgba(255,235,200,0.45)')
    g.addColorStop(1, 'rgba(255,220,180,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    this.ownedTex.push(tex)

    this.sunGlowMat = new THREE.SpriteMaterial({ map: tex, color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    this.sunCoreMat = new THREE.SpriteMaterial({ map: tex, color: 0xfff4e0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    this.ownedMats.push(this.sunGlowMat, this.sunCoreMat)
    const glow = new THREE.Sprite(this.sunGlowMat)
    glow.scale.setScalar(190)
    const core = new THREE.Sprite(this.sunCoreMat)
    core.scale.setScalar(70)
    this.sunGroup.add(glow, core)
    this.sunGroup.visible = false
    this.scene.add(this.sunGroup)
  }

  /** Update the sky/sun/billboards. Always runs so the sky animates everywhere. */
  update(dt: number, focus: THREE.Vector3) {
    this.time += dt
    this.sky.update(dt)
    this.sky.group.position.set(focus.x, 0, focus.z)

    // Day/night cycle on Earth: bright daylight most of the time, brief night.
    const dawn = this.zone === 'earth' ? dayCycle(this.time) : 0
    this.dawn = dawn
    // Sun climbs from the horizon at dawn and sinks again at dusk.
    const sunOffX = lerp(120, 60, dawn)
    const sunOffY = lerp(18, 92, dawn)
    this.sun.position.set(focus.x + sunOffX, focus.y + sunOffY, focus.z + 40)
    if (this.zone === 'earth') this.applyDawn(dawn)
    this.sunTarget.position.copy(focus)
    this.sunTarget.updateMatrixWorld()

    // Visible sun disc: below the horizon at night, rising fast at dawn to high
    // in the sky at noon. Warm orange low down, pale bright when high. Earth only.
    this.sunGroup.visible = this.zone === 'earth' && dawn > 0.01
    if (this.sunGroup.visible) {
      this.sunGroup.position.set(focus.x + lerp(440, 200, dawn), lerp(-120, 380, dawn), focus.z + 240)
      const warm = clamp01(dawn * 1.6)
      this.sunGlowMat.color.setHex(0xff7a3a).lerp(new THREE.Color(0xfff0cf), warm)
      this.sunCoreMat.color.setHex(0xffb070).lerp(new THREE.Color(0xfffbf0), warm)
      const a = clamp01((dawn - 0.02) / 0.18) // fade in as it clears the horizon
      this.sunGlowMat.opacity = a * 0.9
      this.sunCoreMat.opacity = a
    }
    for (const b of this.billboards) {
      b.mat.opacity = b.base + Math.sin(this.time * b.rate + b.phase) * 0.25
    }

    // Rain falls and follows the player; embers drift up; shafts/ads pulse.
    if (this.rain && this.rainGeo) {
      this.rain.position.set(focus.x, 0, focus.z)
      const a = this.rainGeo.attributes.position as THREE.BufferAttribute
      const arr = a.array as Float32Array
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] -= 55 * dt
        if (arr[i] < 0) arr[i] += 80
      }
      a.needsUpdate = true
    }
    if (this.embers && this.emberGeo) {
      this.embers.position.set(focus.x, 0, focus.z)
      const a = this.emberGeo.attributes.position as THREE.BufferAttribute
      const arr = a.array as Float32Array
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] += 4 * dt
        if (arr[i] > 32) arr[i] -= 32
      }
      a.needsUpdate = true
    }
    for (let i = 0; i < this.shafts.length; i++) {
      ;(this.shafts[i].material as THREE.MeshBasicMaterial).opacity = 0.06 + Math.sin(this.time * 1.5 + i) * 0.03
    }
    for (const d of this.dishes) d.rotation.y += dt * 0.5

    // Mech-hangar repair bots bob + slowly spin.
    for (const b of this.hangarBots) {
      b.mesh.position.y = b.baseY + Math.sin(this.time * 1.6 + b.phase) * 0.5
      b.mesh.rotation.y += dt * 0.8
    }

    // Spaceport: sweeping beacon, pulsing warning lights, periodic ship launch.
    if (this.spaceportBeacon) this.spaceportBeacon.rotation.y += dt * 1.6
    for (let i = 0; i < this.spaceportWarn.length; i++) {
      this.spaceportWarn[i].emissiveIntensity = 1.4 + Math.sin(this.time * 4 + i * 1.7) * 1.2
    }
    if (this.launchShip) {
      const s = this.launchShip
      if (s.state === 'parked') {
        s.timer -= dt
        if (s.timer <= 0) { s.state = 'rising'; s.vy = 6 }
      } else {
        s.vy += 22 * dt // accelerate upward
        s.mesh.position.y += s.vy * dt
        if (s.mesh.position.y > s.baseY + 520) { s.state = 'parked'; s.timer = 18; s.mesh.position.y = s.baseY }
      }
    }

    // News tickers scroll their headline strips.
    for (const t of this.tickers) t.tex.offset.x = (t.tex.offset.x + t.speed * dt) % 1
    // Rooftop beacons blink.
    for (const b of this.beacons) b.mat.opacity = Math.sin(this.time * 3 + b.phase) > 0.4 ? 1 : 0.12
    // Route trail: a pulse of light travels along the dashes toward the plaza.
    for (let i = 0; i < this.routeDashes.length; i++) {
      const phase = (this.time * 1.6 - i * 0.35) % 2
      this.routeDashes[i].opacity = 0.32 + Math.max(0, Math.cos(phase * Math.PI)) * 0.6
    }

    // Hover-train: cars follow the rail in a tight convoy.
    if (this.trainSamples.length && this.trainCars.length) {
      const S = this.trainSamples.length
      this.trainT = (this.trainT + dt * 0.014) % 1
      for (let i = 0; i < this.trainCars.length; i++) {
        const t = (this.trainT - i * 0.012 + 1) % 1
        const idx = Math.floor(t * S) % S
        const p = this.trainSamples[idx]
        const ahead = this.trainSamples[(idx + 2) % S]
        this.trainCars[i].position.copy(p)
        this.trainCars[i].lookAt(ahead)
      }
    }

    // Space elevator: climbers ride the tether, the orbital ring slowly turns.
    if (this.elevatorRing) this.elevatorRing.rotation.y += dt * 0.12
    if (this.elevatorClimbers.length) {
      const { x, z, baseTop, tetherTop } = World.ELEV
      for (const c of this.elevatorClimbers) {
        c.t = (c.t + c.speed * dt) % 1
        c.mesh.position.set(x, baseTop + c.t * (tetherTop - baseTop), z)
      }
    }
    for (let i = 0; i < this.adPanels.length; i++) {
      this.adPanels[i].emissiveIntensity = 1.6 + Math.sin(this.time * (2 + i * 0.4) + i) * 0.8
    }
  }

  dispose() {
    this.boxGeo.dispose()
    this.sky.dispose()
    this.ownedMats.forEach((m) => m.dispose())
    this.ownedTex.forEach((t) => t.dispose())
    this.ownedGeos.forEach((g) => g.dispose())
  }
}
