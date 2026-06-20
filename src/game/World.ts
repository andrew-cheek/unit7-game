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
    this.buildExtras()
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
    this.ownedGeos.push(this.domeGeo, this.spireGeo)
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
    const facade = [0x12151f, 0x171b27, 0x1d2230, 0x10131c][Math.floor(hash01(seed * 1.7) * 4)]
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
    if (roof < 0.18) {
      // Domed cap.
      const dome = new THREE.Mesh(this.domeGeo, mat)
      dome.scale.set(fx, Math.min(fx, fz) * 0.6, fz)
      dome.position.set(cx, h, cz)
      this.group.add(dome)
    } else if (roof < 0.34) {
      // Spire cap (glowing).
      const spire = new THREE.Mesh(this.spireGeo, this.glow(config.palette.cyan, 2.4))
      const sh = 6 + hash01(seed * 4.9) * 10
      spire.scale.set(fx * 0.5, sh, fz * 0.5)
      spire.position.set(cx, h + sh / 2, cz)
      this.group.add(spire)
    } else if (roof < 0.5) {
      // Stepped setback (a smaller box stacked on top).
      const step = new THREE.Mesh(this.boxGeo, mat)
      const sh = 6 + hash01(seed * 4.1) * 12
      step.scale.set(fx * 0.62, sh, fz * 0.62)
      step.position.set(cx, h + sh / 2, cz)
      step.castShadow = true
      this.group.add(step)
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

  /** Update the sky/sun/billboards. Always runs so the sky animates everywhere. */
  update(dt: number, focus: THREE.Vector3) {
    this.time += dt
    this.sky.update(dt)
    this.sky.group.position.set(focus.x, 0, focus.z)
    this.sun.position.set(focus.x + 60, focus.y + 90, focus.z + 40)
    this.sunTarget.position.copy(focus)
    this.sunTarget.updateMatrixWorld()
    for (const b of this.billboards) {
      b.mat.opacity = b.base + Math.sin(this.time * b.rate + b.phase) * 0.25
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
