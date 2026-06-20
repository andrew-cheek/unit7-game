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

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

// Earth day cycle: a slow sunrise then sunset. The sun rises starting at
// SUN_RISE_AT (climbing to full day at SUN_PEAK_AT), then sets from SUN_PEAK_AT
// fading back to night over SUN_SET_DUR. Day factor 0 = night, 1 = full day.
const SUN_RISE_AT = 5
const SUN_PEAK_AT = 10
const SUN_SET_DUR = 12
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
const DAWN = {
  skyTop: new THREE.Color(0x2a4f9c),
  skyBot: new THREE.Color(0xff8a4d),
  fog: new THREE.Color(0x3a5180),
  ambient: new THREE.Color(0x7186b0),
  ambientI: 1.25,
  hemiSky: new THREE.Color(0xa7bdec),
  hemiI: 0.95,
  sun: new THREE.Color(0xfff0d8),
  sunI: 2.2,
}

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
  private accentLights: THREE.PointLight[] = []
  private sky!: SkyModel
  private sunTarget = new THREE.Object3D()
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
    this.buildCity()
    this.buildNearbyBuildings()
    this.buildElevatedPlatform()
    this.buildDriveHighway()
    this.buildExtras()
    this.buildSkyline()
    this.buildLandmark()
    this.buildMarket()
    this.buildSetPieces()
    this.buildAdPanels()
    this.buildOffices()
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
    this.windowTex = [createWindowTexture(3), createWindowTexture(11), createWindowTexture(27), createWindowTexture(54)]
    this.windowTex.forEach((t) => {
      t.anisotropy = config.tier.anisotropy
      this.ownedTex.push(t)
    })
    this.ownedGeos.push(this.domeGeo, this.spireGeo, this.pyramidGeo, this.crownGeo, this.tankGeo)
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

  private addBuilding(cx: number, cz: number, fx: number, fz: number, h: number, seed: number) {
    const facade = [0x12151f, 0x171b27, 0x1d2230, 0x10131c, 0x222a38, 0x0d1a22, 0x241a2e][Math.floor(hash01(seed * 1.7) * 7)]
    const tex = this.windowTex[Math.floor(hash01(seed * 2.3) * this.windowTex.length)].clone()
    tex.needsUpdate = true
    tex.anisotropy = config.tier.anisotropy
    tex.repeat.set(Math.max(2, Math.round(fx / 6)), Math.max(3, Math.round(h / 8)))
    this.ownedTex.push(tex)
    const mat = this.own(
      new THREE.MeshStandardMaterial({
        color: facade,
        metalness: 0.35,
        roughness: 0.55,
        emissive: 0xffffff,
        emissiveMap: tex,
        emissiveIntensity: 1.25,
        envMapIntensity: config.tier.envMapIntensity,
      }),
    )
    const mesh = new THREE.Mesh(this.boxGeo, mat)
    mesh.scale.set(fx, h, fz)
    mesh.position.set(cx, h / 2, cz)
    mesh.castShadow = config.tier.buildingShadows // off on mobile (perf)
    mesh.receiveShadow = true
    this.group.add(mesh)
    this.solidMeshes.push(mesh)
    this.landmarks.push({ x: cx, z: cz })
    this.colliders.push(new THREE.Box3(new THREE.Vector3(cx - fx / 2, 0, cz - fz / 2), new THREE.Vector3(cx + fx / 2, h, cz + fz / 2)))

    // Neon roofline trim for a few towers.
    if (hash01(seed * 5.1) > 0.55) {
      const trim = new THREE.Mesh(this.boxGeo, this.glow([config.palette.cyan, config.palette.magenta, config.palette.purple][Math.floor(hash01(seed * 6.7) * 3)], 2.6))
      trim.scale.set(fx + 0.4, 0.5, fz + 0.4)
      trim.position.set(cx, h + 0.1, cz)
      this.group.add(trim)
    }
    // Roof-shape variety so the skyline isn't all flat boxes.
    const roof = hash01(seed * 4.4)
    const neonPick = [config.palette.cyan, config.palette.magenta, config.palette.purple, config.palette.orange, config.palette.lime][Math.floor(hash01(seed * 6.1) * 5)]
    if (roof < 0.14) {
      // Domed cap.
      const dome = new THREE.Mesh(this.domeGeo, mat)
      dome.scale.set(fx, Math.min(fx, fz) * 0.6, fz)
      dome.position.set(cx, h, cz)
      this.group.add(dome)
    } else if (roof < 0.28) {
      // Spire cap (glowing).
      const spire = new THREE.Mesh(this.spireGeo, this.glow(config.palette.cyan, 2.4))
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
      const pyr = new THREE.Mesh(this.pyramidGeo, hash01(seed * 7.3) > 0.5 ? this.glow(neonPick, 2.0) : mat)
      const ph = Math.min(fx, fz) * (0.7 + hash01(seed * 5.5) * 0.8)
      pyr.rotation.y = Math.PI / 4
      pyr.scale.set(fx * 0.72, ph, fz * 0.72)
      pyr.position.set(cx, h + ph / 2, cz)
      this.group.add(pyr)
    } else if (roof < 0.64) {
      // Glowing crown ring around the roofline.
      const crown = new THREE.Mesh(this.crownGeo, this.glow(neonPick, 2.8))
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
    const body = this.own(new THREE.MeshBasicMaterial({ color: 0x0a1124, fog: false }))
    const neon = [config.palette.cyan, config.palette.magenta, config.palette.purple, config.palette.orange]
    const n = config.tier.name === 'high' ? 72 : 38
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const r = R + hash01(i * 3.1) * 90
      const h = 60 + hash01(i * 7.7) * 230
      const w = 14 + hash01(i * 2.3) * 28
      const x = Math.cos(a) * r
      const z = Math.sin(a) * r
      const t = new THREE.Mesh(this.boxGeo, body)
      t.scale.set(w, h, w)
      t.position.set(x, h / 2 - 10, z)
      this.group.add(t)
      // Neon roofline so the distant towers twinkle against the night sky.
      const cap = new THREE.Mesh(this.boxGeo, this.own(new THREE.MeshBasicMaterial({ color: neon[i % neon.length], fog: false })))
      cap.scale.set(w + 2, 3, w + 2)
      cap.position.set(x, h - 10, z)
      this.group.add(cap)
    }
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
    this.groundMat.metalness = zone === 'earth' ? 0.42 : 0.15
    this.groundMat.roughness = zone === 'earth' ? 0.38 : 0.85
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
  }

  /** Update the sky/sun/billboards. Always runs so the sky animates everywhere. */
  update(dt: number, focus: THREE.Vector3) {
    this.time += dt
    this.sky.update(dt)
    this.sky.group.position.set(focus.x, 0, focus.z)

    // Day cycle on Earth: slow rise (5s -> 10s) then a slow set back to night.
    let dawn = 0
    if (this.zone === 'earth') {
      if (this.time < SUN_RISE_AT) dawn = 0
      else if (this.time < SUN_PEAK_AT) dawn = smooth01((this.time - SUN_RISE_AT) / (SUN_PEAK_AT - SUN_RISE_AT))
      else dawn = 1 - smooth01((this.time - SUN_PEAK_AT) / SUN_SET_DUR)
    }
    this.dawn = dawn
    // Sun climbs from the horizon at dawn and sinks again at dusk.
    const sunOffX = lerp(120, 60, dawn)
    const sunOffY = lerp(18, 92, dawn)
    this.sun.position.set(focus.x + sunOffX, focus.y + sunOffY, focus.z + 40)
    if (this.zone === 'earth') this.applyDawn(dawn)
    this.sunTarget.position.copy(focus)
    this.sunTarget.updateMatrixWorld()
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
