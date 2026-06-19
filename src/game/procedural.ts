import * as THREE from 'three'
import { config } from './config'

/**
 * Procedural model factory. These are the fallbacks the AssetLoader uses when a
 * GLB is missing, and also the default player/NPC look until real assets drop in.
 * Everything here is hand-built from primitives but rigged enough to animate a
 * believable walk/idle cycle - a clear step up from capsules and boxes.
 */

export interface CharacterModel {
  group: THREE.Group
  /** Drive the walk/idle animation. speed01 = currentSpeed / runSpeed. */
  update(dt: number, speed01: number, grounded: boolean): void
  dispose(): void
}

/** The player robot exposes extra rig controls for jetpack/parachute/morph. */
export interface RobotModel extends CharacterModel {
  /** Tuck legs / spread arms for flight. amount 0..1. */
  setFlyPose(amount: number): void
  /** Thruster flame intensity. amount 0..1. */
  setThrust(amount: number): void
  /** Morph toward the winged plane form. amount 0..1. */
  setPlanePose(amount: number): void
}

export interface VehicleModel {
  group: THREE.Group
  update(dt: number, speed01: number): void
  dispose(): void
}

const box = (w: number, h: number, d: number, mat: THREE.Material) =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)

/**
 * A dark, neon-tinted image-based-lighting probe. Without an environment, PBR
 * metals reflect nothing and render black at night. This bakes a small scene of
 * colored emissive panels into a PMREM so metals catch cohesive neon highlights
 * while the surroundings stay dark (preserving the night mood). The Stage 5 art
 * pass swaps this for the real HDR sky probe.
 */
export function createEnvTexture(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer)
  const scene = new THREE.Scene()

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(60, 16, 10),
    new THREE.MeshBasicMaterial({ color: 0x0a1226, side: THREE.BackSide }),
  )
  scene.add(dome)

  const panel = (color: number, x: number, z: number, intensity: number) => {
    const mat = new THREE.MeshBasicMaterial({ color })
    mat.color.multiplyScalar(intensity) // HDR-bright so it reads as a neon source
    const m = new THREE.Mesh(new THREE.PlaneGeometry(10, 34), mat)
    m.position.set(x, 3, z)
    m.lookAt(0, 3, 0)
    scene.add(m)
  }
  panel(0x27e7ff, -34, 4, 2.4)
  panel(0xff2bd0, 32, 8, 2.2)
  panel(0x8a5cff, 6, -34, 1.8)
  panel(0xff8a1e, 14, 33, 1.4)
  panel(0x9bff4d, -20, -28, 1.0)

  const tex = pmrem.fromScene(scene, 0.4).texture
  scene.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose())
  })
  pmrem.dispose()
  return tex
}

export interface RobotColors {
  body?: number
  trim?: number
  accent?: number
}

/** Stylized humanoid robot, feet at the group origin (y=0), facing +Z. */
export function createRobot(colors: RobotColors = {}): RobotModel {
  const body = colors.body ?? config.palette.robot
  const trim = colors.trim ?? config.palette.robotTrim
  const accent = colors.accent ?? config.palette.purple

  const bodyMat = new THREE.MeshStandardMaterial({ color: body, metalness: 0.85, roughness: 0.32 })
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2a3140, metalness: 0.6, roughness: 0.5 })
  const accentMat = new THREE.MeshStandardMaterial({ color: accent, metalness: 0.7, roughness: 0.35 })
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x05060b,
    emissive: trim,
    emissiveIntensity: 3.4,
    roughness: 0.4,
  })
  const mats: THREE.Material[] = [bodyMat, darkMat, accentMat, trimMat]

  const group = new THREE.Group()

  // Upper body sits under a "core" node we can bob/sway without moving the feet.
  const core = new THREE.Group()
  group.add(core)

  // Pelvis + torso
  const pelvis = box(0.44, 0.24, 0.3, darkMat)
  pelvis.position.set(0, 1.0, 0)
  core.add(pelvis)

  const torso = box(0.52, 0.62, 0.34, bodyMat)
  torso.position.set(0, 1.34, 0)
  core.add(torso)

  const chestPlate = box(0.4, 0.34, 0.06, accentMat)
  chestPlate.position.set(0, 1.4, 0.17)
  core.add(chestPlate)

  const chestCore = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 16), trimMat)
  chestCore.rotation.x = Math.PI / 2
  chestCore.position.set(0, 1.4, 0.21)
  core.add(chestCore)

  // Jetpack on the back (visual home for thruster FX later).
  const pack = box(0.34, 0.4, 0.18, darkMat)
  pack.position.set(0, 1.34, -0.24)
  core.add(pack)
  for (const sx of [-0.09, 0.09]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.12, 12), trimMat)
    nozzle.position.set(sx, 1.1, -0.26)
    core.add(nozzle)
  }

  // Neck + head
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.1, 12), darkMat)
  neck.position.set(0, 1.66, 0)
  core.add(neck)

  const head = box(0.34, 0.32, 0.34, bodyMat)
  head.position.set(0, 1.82, 0)
  core.add(head)

  const visor = box(0.3, 0.11, 0.06, trimMat)
  visor.position.set(0, 1.84, 0.17)
  core.add(visor)

  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 8), darkMat)
  antenna.position.set(0.1, 2.05, 0)
  core.add(antenna)
  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 10), trimMat)
  antennaTip.position.set(0.1, 2.15, 0)
  core.add(antennaTip)

  // Limb factory: a pivot Group at the joint with geometry hanging downward.
  const makeLeg = (sx: number) => {
    const hip = new THREE.Group()
    hip.position.set(sx, 0.96, 0)
    const thigh = box(0.18, 0.44, 0.2, bodyMat)
    thigh.position.set(0, -0.22, 0)
    const shin = box(0.15, 0.44, 0.18, darkMat)
    shin.position.set(0, -0.64, 0)
    const foot = box(0.18, 0.12, 0.34, bodyMat)
    foot.position.set(0, -0.88, 0.06)
    hip.add(thigh, shin, foot)
    core.add(hip)
    return hip
  }
  const makeArm = (sx: number) => {
    const shoulder = new THREE.Group()
    shoulder.position.set(sx, 1.52, 0)
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), accentMat)
    const upper = box(0.14, 0.4, 0.16, bodyMat)
    upper.position.set(0, -0.22, 0)
    const fore = box(0.12, 0.36, 0.14, darkMat)
    fore.position.set(0, -0.58, 0)
    const hand = box(0.13, 0.14, 0.16, accentMat)
    hand.position.set(0, -0.78, 0)
    shoulder.add(ball, upper, fore, hand)
    core.add(shoulder)
    return shoulder
  }

  const legL = makeLeg(-0.15)
  const legR = makeLeg(0.15)
  const armL = makeArm(-0.36)
  const armR = makeArm(0.36)

  // Foldable wings for the plane morph: a pivot at the shoulder, geometry hung
  // outward so scaling the pivot extends the wing from the body.
  const wingMat = new THREE.MeshStandardMaterial({ color: 0x3a4456, metalness: 0.8, roughness: 0.3 })
  const wingEdgeMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: trim, emissiveIntensity: 2.6 })
  const makeWing = (sx: number) => {
    const pivot = new THREE.Group()
    pivot.position.set(sx * 0.28, 1.34, -0.05)
    const wing = box(1.5, 0.07, 0.62, wingMat)
    wing.position.set(sx * 0.85, 0, -0.05)
    wing.rotation.y = sx * 0.18
    const edge = box(1.5, 0.04, 0.1, wingEdgeMat)
    edge.position.set(sx * 0.85, 0, 0.25)
    edge.rotation.y = sx * 0.18
    pivot.add(wing, edge)
    pivot.scale.x = 0.001 // folded away
    core.add(pivot)
    return pivot
  }
  const wingL = makeWing(-1)
  const wingR = makeWing(1)
  mats.push(wingMat, wingEdgeMat)

  // Thruster flames (jetpack / plane engine). Additive, bloom-friendly.
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0x59d0ff,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const flames: THREE.Mesh[] = []
  for (const sx of [-0.09, 0.09]) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.7, 12), flameMat)
    flame.rotation.x = Math.PI // point down
    flame.position.set(sx, 0.95, -0.24)
    flame.scale.setScalar(0.001)
    group.add(flame)
    flames.push(flame)
  }

  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      const isFlame = (m.material as THREE.Material & { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial === true
      m.castShadow = !isFlame
      m.receiveShadow = !isFlame
    }
  })

  let phase = 0
  let t = 0
  let fly = 0
  let plane = 0
  let thrust = 0
  mats.push(flameMat)

  const update = (dt: number, speed01: number, _grounded: boolean) => {
    t += dt
    const s = Math.min(1, Math.max(0, speed01))
    phase += dt * (3 + s * 9)
    const stride = 0.12 + s * 0.7
    const swing = Math.sin(phase) * stride

    const pose = Math.max(fly, plane) // flight tuck shared by jetpack + plane
    const walk = 1 - pose
    legL.rotation.x = swing * walk + pose * 0.5
    legR.rotation.x = -swing * walk + pose * 0.5
    armL.rotation.x = -swing * 0.8 * walk - pose * 1.2
    armR.rotation.x = swing * 0.8 * walk - pose * 1.2
    armL.rotation.z = 0.08 + pose * 0.4
    armR.rotation.z = -0.08 - pose * 0.4

    // Bob + sway while moving; gentle breathing while idle.
    const bob = Math.abs(Math.sin(phase)) * 0.045 * s
    const breathe = Math.sin(t * 1.6) * 0.012 * (1 - s)
    core.position.y = bob + breathe
    core.rotation.z = Math.sin(phase) * 0.03 * s
    core.rotation.x = pose * 0.35

    // Wings deploy with the plane morph.
    const ws = 0.001 + plane * 0.999
    wingL.scale.x = ws
    wingR.scale.x = ws

    // Flame flicker scaled by thrust.
    const flicker = 0.85 + Math.sin(t * 40) * 0.15
    const fs = thrust * flicker
    for (const flame of flames) flame.scale.set(thrust * 0.9, fs, thrust * 0.9)
  }

  const setFlyPose = (amount: number) => {
    fly = Math.min(1, Math.max(0, amount))
  }
  const setPlanePose = (amount: number) => {
    plane = Math.min(1, Math.max(0, amount))
  }
  const setThrust = (amount: number) => {
    thrust = Math.min(1, Math.max(0, amount))
  }

  const dispose = () => {
    group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    mats.forEach((m) => m.dispose())
  }

  return { group, update, setFlyPose, setPlanePose, setThrust, dispose }
}

/** Spindly big-headed alien with glowing eyes - distinct from the citizens. */
export function createAlien(): CharacterModel {
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3ba86a, roughness: 0.5, metalness: 0.1 })
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x205a3c, roughness: 0.6 })
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0xff2bd0, emissiveIntensity: 3.2, roughness: 0.4 })
  const mats: THREE.Material[] = [bodyMat, darkMat, eyeMat]
  const group = new THREE.Group()
  const core = new THREE.Group()
  group.add(core)

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.42, 4, 10), bodyMat)
  torso.position.y = 1.0
  core.add(torso)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 14), bodyMat)
  head.scale.set(1, 1.25, 0.9)
  head.position.y = 1.46
  core.add(head)
  for (const sx of [-0.1, 0.1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), eyeMat)
    eye.scale.set(0.7, 1.3, 0.5)
    eye.position.set(sx, 1.48, 0.21)
    core.add(eye)
  }
  const makeLimb = (sx: number, y: number, len: number, r: number) => {
    const piv = new THREE.Group()
    piv.position.set(sx, y, 0)
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), darkMat)
    limb.position.y = -len / 2
    piv.add(limb)
    core.add(piv)
    return piv
  }
  const legL = makeLimb(-0.09, 0.82, 0.66, 0.06)
  const legR = makeLimb(0.09, 0.82, 0.66, 0.06)
  const armL = makeLimb(-0.2, 1.28, 0.6, 0.05)
  const armR = makeLimb(0.2, 1.28, 0.6, 0.05)

  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      m.castShadow = false
      m.receiveShadow = true
    }
  })
  let phase = Math.random() * 6.28
  return {
    group,
    update: (dt, s01) => {
      const s = Math.min(1, Math.max(0, s01))
      phase += dt * (5 + s * 8)
      const sw = Math.sin(phase) * (0.25 + s * 0.6)
      legL.rotation.x = sw
      legR.rotation.x = -sw
      armL.rotation.x = -sw * 0.6
      armR.rotation.x = sw * 0.6
      core.position.y = Math.abs(Math.sin(phase)) * 0.04 * s
      core.rotation.z = Math.sin(phase * 0.5) * 0.04
    },
    dispose: () => {
      group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
      })
      mats.forEach((m) => m.dispose())
    },
  }
}

/** Small hovering quad-drone for ambient life. */
export function createDrone(): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x222a38, metalness: 0.85, roughness: 0.35 })
  mats.push(bodyMat)
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), bodyMat)
  body.scale.set(1, 0.7, 1)
  group.add(body)
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), glowMat(mats, config.palette.cyan, 4))
  eye.position.set(0, -0.12, 0.28)
  group.add(eye)
  const rotors: THREE.Mesh[] = []
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const arm = box(0.5, 0.05, 0.08, bodyMat)
    arm.position.set(Math.cos(a) * 0.32, 0.05, Math.sin(a) * 0.32)
    arm.rotation.y = -a
    group.add(arm)
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 12), glowMat(mats, config.palette.magenta, 1.5))
    rotor.position.set(Math.cos(a) * 0.5, 0.1, Math.sin(a) * 0.5)
    group.add(rotor)
    rotors.push(rotor)
  }
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) m.castShadow = true
  })
  let t = 0
  return {
    group,
    update: (dt) => {
      t += dt
      for (const r of rotors) r.rotation.y += dt * 40
    },
    dispose: () => disposeGroup(group, mats),
  }
}

// --- sky + facades ----------------------------------------------------------

export interface SkyModel {
  group: THREE.Group
  setColors(top: number, horizon: number): void
  update(dt: number): void
  dispose(): void
}

/** Gradient sky dome + a twinkling starfield (both fog-immune so they stay visible). */
export function createSky(top = 0x05070f, horizon = 0x150a28, starCount = 1500): SkyModel {
  const group = new THREE.Group()
  const geo = new THREE.SphereGeometry(900, 32, 18)
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 3), 3))
  const domeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })
  const dome = new THREE.Mesh(geo, domeMat)
  dome.renderOrder = -1
  group.add(dome)

  const setColors = (t: number, h: number) => {
    const pos = geo.attributes.position
    const colors = geo.attributes.color as THREE.BufferAttribute
    const ct = new THREE.Color(t)
    const ch = new THREE.Color(h)
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const yn = THREE.MathUtils.clamp((pos.getY(i) / 900 + 0.15) / 0.7, 0, 1)
      c.copy(ch).lerp(ct, yn)
      colors.setXYZ(i, c.r, c.g, c.b)
    }
    colors.needsUpdate = true
  }
  setColors(top, horizon)

  const N = Math.max(100, Math.floor(starCount))
  const sp = new Float32Array(N * 3)
  const sc = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 760
    sp[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    sp[i * 3 + 1] = Math.abs(r * Math.cos(phi)) * 0.85 + 30
    sp[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    const b = 0.55 + Math.random() * 0.45
    const tint = Math.random()
    sc[i * 3] = b * (0.85 + tint * 0.15)
    sc[i * 3 + 1] = b * 0.92
    sc[i * 3 + 2] = b
  }
  const sg = new THREE.BufferGeometry()
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3))
  sg.setAttribute('color', new THREE.BufferAttribute(sc, 3))
  const starMat = new THREE.PointsMaterial({ size: 2.1, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true, depthWrite: false })
  const stars = new THREE.Points(sg, starMat)
  group.add(stars)

  let t = 0
  return {
    group,
    setColors,
    update: (dt) => {
      t += dt
      group.rotation.y = t * 0.004
      starMat.opacity = 0.75 + Math.sin(t * 0.6) * 0.25
    },
    dispose: () => {
      geo.dispose()
      domeMat.dispose()
      sg.dispose()
      starMat.dispose()
    },
  }
}

/** Tileable lit-window facade pattern, used as an emissiveMap so towers glow. */
export function createWindowTexture(seed = 1): THREE.CanvasTexture {
  const w = 64
  const h = 96
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#06070d'
  ctx.fillRect(0, 0, w, h)
  const cols = 4
  const rows = 6
  const mx = 4
  const my = 5
  const cw = (w - mx * (cols + 1)) / cols
  const ch = (h - my * (rows + 1)) / rows
  const tints = ['#fff0cf', '#bfe7ff', '#ffc9ee', '#cfffe9', '#ffe0a8']
  let s = seed * 9301 + 1
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  for (let yy = 0; yy < rows; yy++) {
    for (let xx = 0; xx < cols; xx++) {
      const x = mx + xx * (cw + mx)
      const y = my + yy * (ch + my)
      if (rnd() < 0.42) {
        ctx.fillStyle = '#0a0c14'
        ctx.globalAlpha = 1
      } else {
        ctx.fillStyle = tints[Math.floor(rnd() * tints.length)]
        ctx.globalAlpha = 0.45 + rnd() * 0.55
      }
      ctx.fillRect(x, y, cw, ch)
    }
  }
  ctx.globalAlpha = 1
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export interface CitizenColors {
  skin?: number
  outfit?: number
  accent?: number
  female?: boolean
}

/** Lightweight animated townsperson (feet at origin, faces +Z). ~7 meshes. */
export function createCitizen(opts: CitizenColors = {}): CharacterModel {
  const skin = opts.skin ?? 0xc9a88a
  const outfit = opts.outfit ?? 0x2b3a6b
  const accent = opts.accent ?? config.palette.cyan
  const female = opts.female ?? false

  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7, metalness: 0 })
  const outfitMat = new THREE.MeshStandardMaterial({ color: outfit, roughness: 0.6, metalness: 0.1 })
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: accent, emissiveIntensity: 1.8, roughness: 0.5 })
  const mats: THREE.Material[] = [skinMat, outfitMat, accentMat]
  const group = new THREE.Group()
  const core = new THREE.Group()
  group.add(core)

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(female ? 0.18 : 0.22, 0.46, 4, 10), outfitMat)
  torso.position.y = 1.12
  core.add(torso)
  const strip = box(0.32, 0.07, 0.26, accentMat)
  strip.position.set(0, 1.26, 0)
  core.add(strip)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 12), skinMat)
  head.position.y = 1.5
  core.add(head)
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), outfitMat)
  hair.position.y = 1.52
  core.add(hair)

  const makeLeg = (sx: number) => {
    const hip = new THREE.Group()
    hip.position.set(sx, 0.82, 0)
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.58, 4, 8), outfitMat)
    leg.position.y = -0.36
    hip.add(leg)
    core.add(hip)
    return hip
  }
  const makeArm = (sx: number) => {
    const sh = new THREE.Group()
    sh.position.set(sx, 1.38, 0)
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.46, 4, 8), outfitMat)
    arm.position.y = -0.28
    sh.add(arm)
    core.add(sh)
    return sh
  }
  const legL = makeLeg(-0.11)
  const legR = makeLeg(0.11)
  const armL = makeArm(-0.25)
  const armR = makeArm(0.25)

  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      m.castShadow = false // crowd doesn't cast shadows (perf)
      m.receiveShadow = true
    }
  })

  let phase = Math.random() * 6.28
  let t = 0
  return {
    group,
    update: (dt, speed01) => {
      t += dt
      const s = Math.min(1, Math.max(0, speed01))
      phase += dt * (4 + s * 8)
      const swing = Math.sin(phase) * (0.2 + s * 0.65)
      legL.rotation.x = swing
      legR.rotation.x = -swing
      armL.rotation.x = -swing * 0.7
      armR.rotation.x = swing * 0.7
      core.position.y = Math.abs(Math.sin(phase)) * 0.03 * s + Math.sin(t * 1.5) * 0.006 * (1 - s)
    },
    dispose: () => {
      group.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.geometry) m.geometry.dispose()
      })
      mats.forEach((m) => m.dispose())
    },
  }
}

// --- vehicle helpers --------------------------------------------------------

function shadowAll(group: THREE.Group) {
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      m.castShadow = true
      m.receiveShadow = true
    }
  })
}
function disposeGroup(group: THREE.Group, mats: THREE.Material[]) {
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
  })
  mats.forEach((m) => m.dispose())
}
const glowMat = (mats: THREE.Material[], color: number, intensity = 3) => {
  const m = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: intensity, roughness: 0.4 })
  mats.push(m)
  return m
}

/** Sleek low-slung hovercar (origin at chassis center; hovers via Vehicles). */
export function createHovercar(): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.92, roughness: 0.24 })
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x252e40, metalness: 0.8, roughness: 0.4 })
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0a1830, metalness: 0.5, roughness: 0.1, emissive: 0x0a2540, emissiveIntensity: 0.7, transparent: true, opacity: 0.85,
  })
  mats.push(bodyMat, trimMat, glassMat)

  const chassis = box(2.0, 0.4, 4.4, bodyMat)
  group.add(chassis)
  const lower = box(1.6, 0.3, 4.6, trimMat)
  lower.position.y = -0.22
  group.add(lower)
  const nose = box(1.5, 0.28, 1.3, bodyMat)
  nose.position.set(0, 0.04, 2.1)
  group.add(nose)
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.7, 18, 12), glassMat)
  canopy.scale.set(1.0, 0.5, 1.5)
  canopy.position.set(0, 0.32, 0.3)
  group.add(canopy)

  const under = box(1.5, 0.05, 3.8, glowMat(mats, 0x27e7ff, 4))
  under.position.y = -0.36
  group.add(under)
  for (const sx of [-1, 1]) {
    const strip = box(0.06, 0.12, 3.2, glowMat(mats, 0xff2bd0, 2.6))
    strip.position.set(sx, 0, 0)
    group.add(strip)
    const fin = box(0.08, 0.5, 1.0, bodyMat)
    fin.position.set(sx, 0.25, -1.7)
    fin.rotation.z = sx * 0.22
    group.add(fin)
  }
  for (const sx of [-0.55, 0.55]) {
    const thr = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.3, 16), glowMat(mats, 0x59d0ff, 3))
    thr.rotation.x = Math.PI / 2
    thr.position.set(sx, 0.02, -2.35)
    group.add(thr)
  }

  shadowAll(group)
  let t = 0
  const underMat = under.material as THREE.MeshStandardMaterial
  return {
    group,
    update: (dt) => {
      t += dt
      underMat.emissiveIntensity = 3 + Math.sin(t * 4) * 1.2
    },
    dispose: () => disposeGroup(group, mats),
  }
}

/** Flying-saucer / shuttle (origin at hull center). Distinct from the hovercar. */
export function createSpaceship(): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const hull = new THREE.MeshStandardMaterial({ color: 0x2b3447, metalness: 0.93, roughness: 0.22 })
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0a1830, metalness: 0.5, roughness: 0.08, emissive: 0x123a55, emissiveIntensity: 0.8, transparent: true, opacity: 0.85,
  })
  mats.push(hull, glassMat)

  const top = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.7, 0.5, 28), hull)
  group.add(top)
  const bottom = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 0.9, 0.6, 28), hull)
  bottom.position.y = -0.5
  group.add(bottom)
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.1, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), glassMat)
  dome.position.y = 0.24
  group.add(dome)

  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.12, 12, 40), glowMat(mats, 0x27e7ff, 3.6))
  ring.rotation.x = Math.PI / 2
  ring.position.y = -0.55
  group.add(ring)

  const lights: THREE.Mesh[] = []
  const lightMat = glowMat(mats, 0x9bff4d, 4)
  const lightMat2 = glowMat(mats, 0xff2bd0, 4)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), i % 2 ? lightMat : lightMat2)
    l.position.set(Math.cos(a) * 2.55, -0.2, Math.sin(a) * 2.55)
    group.add(l)
    lights.push(l)
  }

  shadowAll(group)
  let t = 0
  return {
    group,
    update: (dt) => {
      t += dt
      ring.rotation.z += dt * 1.4
      lights.forEach((l, i) => (l.visible = Math.sin(t * 5 + i * 0.7) > -0.2))
    },
    dispose: () => disposeGroup(group, mats),
  }
}

/** Tall rocket (origin at the base, y=0). Used for Mars/Moon travel in Stage 6. */
export function createRocket(): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd8dde6, metalness: 0.7, roughness: 0.35 })
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xb33b3b, metalness: 0.6, roughness: 0.4 })
  mats.push(bodyMat, accentMat)

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 6, 24), bodyMat)
  body.position.y = 3.2
  group.add(body)
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 0.8, 24), accentMat)
  band.position.y = 4.6
  group.add(band)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 24), accentMat)
  nose.position.y = 7.3
  group.add(nose)
  const windows = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.78, 0.5, 24), glowMat(mats, 0x27e7ff, 3))
  windows.position.y = 5.6
  group.add(windows)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    const fin = box(0.12, 1.6, 1.3, accentMat)
    fin.position.set(Math.cos(a) * 0.95, 0.9, Math.sin(a) * 0.95)
    fin.rotation.y = -a
    group.add(fin)
  }
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.7, 0.7, 20), new THREE.MeshStandardMaterial({ color: 0x2a2f3a, metalness: 0.8, roughness: 0.5 }))
  nozzle.position.y = -0.1
  group.add(nozzle)
  mats.push(nozzle.material as THREE.Material)
  const engineGlow = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 12), glowMat(mats, 0xff8a1e, 2))
  engineGlow.position.y = -0.2
  engineGlow.scale.y = 0.5
  group.add(engineGlow)

  shadowAll(group)
  let t = 0
  const glowMatRef = engineGlow.material as THREE.MeshStandardMaterial
  return {
    group,
    update: (dt) => {
      t += dt
      glowMatRef.emissiveIntensity = 1.6 + Math.sin(t * 6) * 0.8
    },
    dispose: () => disposeGroup(group, mats),
  }
}
