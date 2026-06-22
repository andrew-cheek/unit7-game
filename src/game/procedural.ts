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
  /** Recolor the robot's accent + trim/wing glow (cosmetic). */
  setAccent(color: number): void
}

export interface VehicleModel {
  group: THREE.Group
  update(dt: number, speed01: number): void
  dispose(): void
  /** Mech-only: blend between robot (0) and jet/flight form (1). */
  setMorph?(amount: number): void
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
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: trim, emissiveIntensity: 3.4, roughness: 0.4 })
  const mats: THREE.Material[] = [bodyMat, darkMat, accentMat, trimMat]

  const group = new THREE.Group()

  // Upper body sits under a "core" node we can bob/sway without moving the feet.
  const core = new THREE.Group()
  group.add(core)

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

  const pack = box(0.34, 0.4, 0.18, darkMat)
  pack.position.set(0, 1.34, -0.24)
  core.add(pack)
  for (const sx of [-0.09, 0.09]) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.12, 12), trimMat)
    nozzle.position.set(sx, 1.1, -0.26)
    core.add(nozzle)
  }

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

  // Slim legs: thigh / shin / foot hung off a hip pivot that swings.
  const makeLeg = (sx: number) => {
    const hip = new THREE.Group()
    hip.position.set(sx, 0.98, 0)
    const thigh = box(0.16, 0.4, 0.18, darkMat)
    thigh.position.set(0, -0.2, 0)
    const shin = box(0.14, 0.42, 0.16, bodyMat)
    shin.position.set(0, -0.6, 0)
    const foot = box(0.18, 0.12, 0.32, accentMat)
    foot.position.set(0, -0.84, 0.06)
    hip.add(thigh, shin, foot)
    core.add(hip)
    return hip
  }
  // Slim arms: ball shoulder, upper, forearm, hand. Shoulder pivot swings.
  const makeArm = (sx: number) => {
    const shoulder = new THREE.Group()
    shoulder.position.set(sx, 1.56, 0)
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), accentMat)
    const upper = box(0.14, 0.34, 0.16, bodyMat)
    upper.position.set(0, -0.22, 0)
    const fore = box(0.12, 0.32, 0.14, darkMat)
    fore.position.set(0, -0.5, 0)
    const hand = box(0.14, 0.14, 0.16, accentMat)
    hand.position.set(0, -0.7, 0)
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

  const setAccent = (color: number) => {
    accentMat.color.setHex(color)
    trimMat.emissive.setHex(color)
    wingEdgeMat.emissive.setHex(color)
  }

  const dispose = () => {
    group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    mats.forEach((m) => m.dispose())
  }

  return { group, update, setFlyPose, setPlanePose, setThrust, setAccent, dispose }
}

/** Spindly big-headed alien with glowing eyes - distinct from the citizens. */
export function createAlien(opts: { big?: boolean; color?: number; eye?: number } = {}): CharacterModel {
  const base = opts.color ?? 0x3ba86a
  const bodyMat = new THREE.MeshStandardMaterial({ color: base, roughness: 0.5, metalness: 0.1 })
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(base).multiplyScalar(0.6).getHex(), roughness: 0.6 })
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: opts.eye ?? 0xff2bd0, emissiveIntensity: 3.2, roughness: 0.4 })
  const mats: THREE.Material[] = [bodyMat, darkMat, eyeMat]
  const group = new THREE.Group()
  // Large aliens are simply scaled up (cheap variety, distinct silhouette).
  group.scale.setScalar(opts.big ? 1.9 : 1)
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
  // Radius sits below the camera far plane (900). The dome group is centered on
  // the focus, ~10m ahead of the camera, so an equal radius let the rear
  // hemisphere cross the far plane and show clear-color through it.
  const geo = new THREE.SphereGeometry(860, 32, 18)
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
      const yn = THREE.MathUtils.clamp((pos.getY(i) / 860 + 0.15) / 0.7, 0, 1)
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

  // Distant ringed planet hanging in the sky (fog-immune).
  const planetGeo = new THREE.SphereGeometry(70, 24, 18)
  const planetMat = new THREE.MeshBasicMaterial({ color: 0x6a4bd0, fog: false })
  const planet = new THREE.Mesh(planetGeo, planetMat)
  planet.position.set(-420, 320, -650)
  group.add(planet)
  const ringGeo = new THREE.RingGeometry(95, 140, 48)
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xb89cff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, fog: false, depthWrite: false })
  const planetRing = new THREE.Mesh(ringGeo, ringMat)
  planetRing.position.copy(planet.position)
  planetRing.rotation.set(1.2, 0.4, 0)
  group.add(planetRing)

  // A single reusable shooting-star streak.
  const streakGeo = new THREE.BoxGeometry(0.6, 0.6, 46)
  const streakMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, fog: false, blending: THREE.AdditiveBlending, depthWrite: false })
  const streak = new THREE.Mesh(streakGeo, streakMat)
  streak.visible = false
  group.add(streak)
  const streakDir = new THREE.Vector3()
  let nextStreak = 3 + Math.random() * 5

  let t = 0
  return {
    group,
    setColors,
    update: (dt) => {
      t += dt
      group.rotation.y = t * 0.004
      starMat.opacity = 0.75 + Math.sin(t * 0.6) * 0.25
      if (streak.visible) {
        streak.position.addScaledVector(streakDir, 620 * dt)
        streakMat.opacity = Math.max(0, streakMat.opacity - dt * 1.3)
        if (streakMat.opacity <= 0) streak.visible = false
      } else {
        nextStreak -= dt
        if (nextStreak <= 0) {
          nextStreak = 4 + Math.random() * 7
          streak.position.set((Math.random() - 0.5) * 800, 250 + Math.random() * 200, -300 - Math.random() * 350)
          const a = Math.random() * Math.PI * 2
          streakDir.set(Math.cos(a), -0.2 - Math.random() * 0.25, Math.sin(a)).normalize()
          streak.lookAt(streak.position.clone().add(streakDir))
          streakMat.opacity = 0.9
          streak.visible = true
        }
      }
    },
    dispose: () => {
      geo.dispose()
      domeMat.dispose()
      sg.dispose()
      starMat.dispose()
      planetGeo.dispose()
      planetMat.dispose()
      ringGeo.dispose()
      ringMat.dispose()
      streakGeo.dispose()
      streakMat.dispose()
    },
  }
}

/** Tileable lit-window facade pattern, used as an emissiveMap so towers glow. */
export function createWindowTexture(seed = 1): THREE.CanvasTexture {
  const w = 128
  const h = 192
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')!
  let s = seed * 9301 + 1
  const rnd = () => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }

  // Dark glass facade with a faint vertical sheen.
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#0a0e1a')
  grad.addColorStop(0.5, '#070910')
  grad.addColorStop(1, '#0b0f1c')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)

  // Each tower gets a dominant neon hue, but individual windows vary widely in
  // colour and brightness - a few are "hot" (near-white) so they bloom hard.
  // Per-window variety is the single biggest factor in a believable night city.
  // Palette discipline: a small accent set (cyan / magenta / violet) plus a few
  // warm-white office hues, so the city reads as art-directed rather than every
  // neon colour at once.
  const neon = ['#27e7ff', '#ff2bd0', '#8a5cff']
  const accent = neon[Math.floor(rnd() * neon.length)]
  const litHues = [accent, accent, '#bfe7ff', '#ffd9a8', '#cfe6ff']

  // Surface style varies per tower so the skyline isn't one repeated window
  // grid: an even grid, wide horizontal louvers, or narrow vertical slits.
  const style = Math.floor(rnd() * 3)
  const cols = style === 1 ? 4 : style === 2 ? 9 : 6
  const rows = style === 1 ? 16 : style === 2 ? 9 : 12
  const mx = 3
  const my = 3
  const cw = (w - mx * (cols + 1)) / cols
  const ch = (h - my * (rows + 1)) / rows

  for (let yy = 0; yy < rows; yy++) {
    // Occasional full-width glowing "data band" (sci-fi signage strips). Rarer
    // and dimmer now so they read as the odd lit strip, not a glowing grid.
    const band = rnd() < 0.05
    for (let xx = 0; xx < cols; xx++) {
      const x = mx + xx * (cw + mx)
      const y = my + yy * (ch + my)
      if (band) {
        ctx.fillStyle = accent
        ctx.globalAlpha = 0.35 + rnd() * 0.2
        ctx.fillRect(x, y + ch * 0.3, cw, ch * 0.4)
        continue
      }
      const r = rnd()
      // The strong majority of windows are dark (~76%) so the facade base reads
      // dark and the lit windows are a clear minority accent.
      if (r < 0.76) {
        // dark/unlit window
        ctx.fillStyle = '#0a0d14'
        ctx.globalAlpha = 1
        ctx.fillRect(x, y, cw, ch)
      } else if (r < 0.778) {
        // "hot" window: near-white. Rare (~1.8%) so only a few specks bloom.
        ctx.fillStyle = '#ffffff'
        ctx.globalAlpha = 1
        ctx.fillRect(x, y, cw, ch)
      } else {
        // lit: mostly the tower's accent, sometimes a warm/cool office hue. Dim.
        ctx.fillStyle = rnd() < 0.6 ? accent : litHues[Math.floor(rnd() * litHues.length)]
        ctx.globalAlpha = 0.18 + rnd() * 0.34
        ctx.fillRect(x, y, cw, ch)
        // a third of the lit windows get a slightly brighter inner core
        if (rnd() < 0.34) {
          ctx.globalAlpha = Math.min(0.8, ctx.globalAlpha + 0.22)
          ctx.fillRect(x + cw * 0.25, y + ch * 0.2, cw * 0.5, ch * 0.6)
        }
      }
    }
  }
  ctx.globalAlpha = 1

  // Faint neon mullions between cells. Kept low so they read as panel seams, not
  // a glowing grid laid over the whole facade.
  ctx.fillStyle = accent
  ctx.globalAlpha = 0.1
  for (let xx = 0; xx <= cols; xx++) ctx.fillRect(mx / 2 + xx * (cw + mx) - 1, 0, 1, h)
  ctx.globalAlpha = 0.04
  for (let yy = 0; yy <= rows; yy++) ctx.fillRect(0, my / 2 + yy * (ch + my) - 1, w, 1)
  // Edge pillars (left/right seams) so tiled facades show a vertical neon line.
  ctx.globalAlpha = 0.4
  ctx.fillRect(0, 0, 2, h)
  ctx.fillRect(w - 2, 0, 2, h)
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
  robot?: boolean // metallic humanoid robot pedestrian instead of a citizen
}

/** Lightweight animated townsperson (feet at origin, faces +Z). ~7 meshes. */
export function createCitizen(opts: CitizenColors = {}): CharacterModel {
  const robot = opts.robot ?? false
  const skin = opts.skin ?? (robot ? 0x9fb0c4 : 0xc9a88a)
  const outfit = opts.outfit ?? (robot ? 0x39414f : 0x2b3a6b)
  const accent = opts.accent ?? config.palette.cyan
  const female = opts.female ?? false

  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: robot ? 0.35 : 0.7, metalness: robot ? 0.85 : 0 })
  const outfitMat = new THREE.MeshStandardMaterial({ color: outfit, roughness: robot ? 0.4 : 0.6, metalness: robot ? 0.7 : 0.1 })
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: accent, emissiveIntensity: robot ? 2.6 : 1.8, roughness: 0.5 })
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
  if (robot) {
    // Glowing visor band + antenna so it reads as a humanoid robot.
    const visor = box(0.26, 0.07, 0.06, accentMat)
    visor.position.set(0, 1.51, 0.13)
    core.add(visor)
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.14, 6), skinMat)
    ant.position.set(0.07, 1.66, 0)
    core.add(ant)
  } else {
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), outfitMat)
    hair.position.y = 1.52
    core.add(hair)
  }

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

/**
 * A long city commuter bus / shuttle (origin at body center, facing +Z). Boxy
 * hull with a bright lit window strip, a roof sign, headlights and four wheels.
 * Used by Events to ferry commuter NPCs to the office buildings.
 */
export function createBus(): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf0a52a, metalness: 0.5, roughness: 0.5 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x16181f, metalness: 0.6, roughness: 0.5 })
  mats.push(bodyMat, dark)
  const glass = glowMat(mats, 0x9fe6ff, 1.6)

  const hull = box(2.4, 2.2, 7.2, bodyMat)
  hull.position.y = 1.6
  group.add(hull)
  // Lit window band down both sides + the front.
  for (const sx of [-1.21, 1.21]) {
    const win = box(0.06, 0.8, 6.2, glass)
    win.position.set(sx, 1.9, 0)
    group.add(win)
  }
  const windshield = box(2.0, 0.9, 0.06, glass)
  windshield.position.set(0, 1.9, 3.61)
  group.add(windshield)
  // Roof destination sign.
  const sign = box(1.6, 0.4, 0.1, glowMat(mats, config.palette.orange, 2.4))
  sign.position.set(0, 2.85, 2.6)
  group.add(sign)
  // Headlights + tail lights.
  for (const sx of [-0.8, 0.8]) {
    const hl = box(0.4, 0.25, 0.1, glowMat(mats, 0xffffe0, 3))
    hl.position.set(sx, 0.8, 3.62)
    group.add(hl)
    const tl = box(0.4, 0.25, 0.1, glowMat(mats, 0xff3030, 2.6))
    tl.position.set(sx, 0.8, -3.62)
    group.add(tl)
  }
  // Wheels.
  const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 14)
  for (const sx of [-1.15, 1.15]) {
    for (const sz of [-2.4, 2.2]) {
      const w = new THREE.Mesh(wheelGeo, dark)
      w.rotation.z = Math.PI / 2
      w.position.set(sx, 0.5, sz)
      group.add(w)
    }
  }
  shadowAll(group)
  return {
    group,
    update: () => {},
    dispose: () => disposeGroup(group, mats),
  }
}

/**
 * Police hover-cruiser (origin at chassis center). Reads as a cop car: dark
 * livery, white door panels, headlights, and a roof light bar whose red/blue
 * halves flash alternately in `update` so the siren is on. Bloom makes the bar
 * pop. Used by Events for the ambient patrol.
 */
export function createPoliceCar(): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x10131c, metalness: 0.85, roughness: 0.3 })
  const panelMat = new THREE.MeshStandardMaterial({ color: 0xdfe6f0, metalness: 0.5, roughness: 0.45 })
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0a1830, metalness: 0.5, roughness: 0.1, emissive: 0x0a2540, emissiveIntensity: 0.6, transparent: true, opacity: 0.85,
  })
  mats.push(bodyMat, panelMat, glassMat)

  const chassis = box(2.0, 0.5, 4.4, bodyMat)
  group.add(chassis)
  const cabin = box(1.7, 0.6, 2.2, glassMat)
  cabin.position.set(0, 0.5, -0.1)
  group.add(cabin)
  // White door panels down each side.
  for (const sx of [-1.01, 1.01]) {
    const door = box(0.04, 0.34, 2.0, panelMat)
    door.position.set(sx, -0.02, 0)
    group.add(door)
  }
  const hood = box(1.8, 0.16, 1.2, bodyMat)
  hood.position.set(0, 0.22, 1.7)
  group.add(hood)
  // Headlights + under-glow.
  for (const sx of [-0.7, 0.7]) {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), glowMat(mats, 0xfff2cf, 3))
    hl.position.set(sx, 0.1, 2.2)
    group.add(hl)
  }
  const under = box(1.6, 0.06, 3.8, glowMat(mats, 0x27e7ff, 2.4))
  under.position.y = -0.34
  group.add(under)

  // Roof light bar: two halves we flash alternately.
  const redMat = glowMat(mats, 0xff2b3c, 4)
  const blueMat = glowMat(mats, 0x2b6cff, 4)
  const barBase = box(1.2, 0.12, 0.5, bodyMat)
  barBase.position.set(0, 0.86, -0.1)
  group.add(barBase)
  const redLamp = box(0.5, 0.18, 0.42, redMat)
  redLamp.position.set(-0.3, 0.96, -0.1)
  group.add(redLamp)
  const blueLamp = box(0.5, 0.18, 0.42, blueMat)
  blueLamp.position.set(0.3, 0.96, -0.1)
  group.add(blueLamp)

  shadowAll(group)
  let t = 0
  return {
    group,
    update: (dt) => {
      t += dt
      // ~3 Hz alternating red/blue strobe.
      const phase = Math.sin(t * 18)
      redMat.emissiveIntensity = phase > 0 ? 5.5 : 0.4
      blueMat.emissiveIntensity = phase > 0 ? 0.4 : 5.5
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
  // A second, counter-spinning magenta accent ring tighter to the hull.
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.08, 10, 36), glowMat(mats, 0xff2bd0, 3))
  ring2.rotation.x = Math.PI / 2
  ring2.position.y = -0.35
  group.add(ring2)

  // Radial hull panel seams on the upper dome cone.
  const seam = new THREE.MeshStandardMaterial({ color: 0x141a26, metalness: 0.8, roughness: 0.4 })
  mats.push(seam)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const p = box(0.08, 0.12, 1.4, seam)
    p.position.set(Math.cos(a) * 1.4, 0.18, Math.sin(a) * 1.4)
    p.rotation.y = -a
    group.add(p)
  }
  // Sensor mast + nubs on top.
  const mast = box(0.08, 0.7, 0.08, seam)
  mast.position.set(0.7, 0.5, 0.4)
  group.add(mast)
  const mastTip = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), glowMat(mats, 0xff2bd0, 3))
  mastTip.position.set(0.7, 0.9, 0.4)
  group.add(mastTip)

  // Underside hover-thrusters: four nozzles with downward glow cones (pulse).
  const pulseMats: THREE.MeshStandardMaterial[] = []
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 0.5, 12), hull)
    noz.position.set(Math.cos(a) * 1.5, -0.85, Math.sin(a) * 1.5)
    group.add(noz)
    const jm = glowMat(mats, 0x9fe8ff, 2)
    pulseMats.push(jm as THREE.MeshStandardMaterial)
    const jet = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.4, 12, 1, true), jm)
    jet.rotation.x = Math.PI
    jet.position.set(Math.cos(a) * 1.5, -1.7, Math.sin(a) * 1.5)
    group.add(jet)
  }

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
      ring2.rotation.z -= dt * 2.0
      const e = 1.4 + Math.sin(t * 7) * 0.7
      for (const m of pulseMats) m.emissiveIntensity = e
      lights.forEach((l, i) => (l.visible = Math.sin(t * 5 + i * 0.7) > -0.2))
    },
    dispose: () => disposeGroup(group, mats),
  }
}

/** Tall rocket (origin at the base, y=0). Used for Mars/Moon travel in Stage 6. */
export interface RocketOpts {
  scale?: number // overall size multiplier (1 = base)
  hull?: number // hull colour
  accent?: number // fin / spire colour
  flaps?: boolean // Starship-style forward + aft control flaps
}

export function createRocket(opts: RocketOpts = {}): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const TAU = Math.PI * 2
  const hull = new THREE.MeshStandardMaterial({ color: opts.hull ?? 0xc7cfdb, metalness: 0.82, roughness: 0.3 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a3340, metalness: 0.85, roughness: 0.42 })
  const accent = new THREE.MeshStandardMaterial({ color: opts.accent ?? 0xb33b3b, metalness: 0.6, roughness: 0.4 })
  mats.push(hull, dark, accent)
  const cyan = config.palette.cyan
  const orange = config.palette.orange
  const pulseMats: THREE.MeshStandardMaterial[] = []

  // Flared engine skirt + a ring of three thrusters with glowing throats.
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.55, 1.3, 24), dark)
  skirt.position.y = 0.95
  group.add(skirt)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU
    const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.3, 0.8, 14), dark)
    noz.position.set(Math.cos(a) * 0.6, 0.1, Math.sin(a) * 0.6)
    group.add(noz)
    const eg = glowMat(mats, orange, 2)
    pulseMats.push(eg as THREE.MeshStandardMaterial)
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), eg)
    flame.position.set(Math.cos(a) * 0.6, -0.1, Math.sin(a) * 0.6)
    flame.scale.y = 0.5
    group.add(flame)
  }

  // Tapered main hull with raised panel lines + two neon accent rings.
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.15, 4.6, 24), hull)
  body.position.y = 3.9
  group.add(body)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU
    const panel = box(0.06, 4.0, 0.45, dark)
    panel.position.set(Math.cos(a) * 1.03, 3.9, Math.sin(a) * 1.03)
    panel.rotation.y = -a
    group.add(panel)
  }
  for (const y of [2.3, 5.3]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.08, 8, 28), glowMat(mats, cyan, 2.6))
    ring.rotation.x = Math.PI / 2
    ring.position.y = y
    group.add(ring)
  }

  // Cockpit collar with a wrap-around glowing window.
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.02, 1.1, 24), dark)
  cab.position.y = 6.45
  group.add(cab)
  const win = new THREE.Mesh(new THREE.CylinderGeometry(1.04, 1.04, 0.55, 24, 1, true), glowMat(mats, cyan, 3))
  win.position.y = 6.6
  group.add(win)

  // Ogive nose + sensor spire with a blinking beacon.
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.0, 2.1, 24), hull)
  nose.position.y = 8.05
  group.add(nose)
  const spire = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.1, 12), accent)
  spire.position.y = 9.55
  group.add(spire)
  const beaconMat = glowMat(mats, orange, 3)
  pulseMats.push(beaconMat as THREE.MeshStandardMaterial)
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), beaconMat)
  beacon.position.y = 10.15
  group.add(beacon)

  // Four swept fins with glowing leading edges.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU
    const fin = box(0.16, 2.3, 1.5, accent)
    fin.position.set(Math.cos(a) * 1.15, 1.7, Math.sin(a) * 1.15)
    fin.rotation.y = -a
    group.add(fin)
    const edge = box(0.2, 2.3, 0.14, glowMat(mats, cyan, 2.2))
    edge.position.set(Math.cos(a) * 1.15, 1.7, Math.sin(a) * 1.15 + 0.0)
    edge.rotation.y = -a
    edge.translateZ(0.72)
    group.add(edge)
  }

  // Splayed landing legs (deployed lander stance).
  for (let i = 0; i < 4; i++) {
    const legG = new THREE.Group()
    legG.rotation.y = (i / 4) * TAU + Math.PI / 4
    group.add(legG)
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 2.9, 8), dark)
    strut.position.set(1.25, 0.95, 0)
    strut.rotation.z = -0.5
    legG.add(strut)
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.16, 12), dark)
    foot.position.set(2.0, 0.06, 0)
    legG.add(foot)
  }

  // Starship-style control flaps: two forward (near the nose) + two aft.
  if (opts.flaps) {
    for (const [fy, len] of [[7.0, 1.8], [2.4, 2.0]] as const) {
      for (const s of [-1, 1]) {
        const flap = box(0.18, len, 1.3, dark)
        flap.position.set(s * 1.02, fy, -0.25)
        flap.rotation.z = s * 0.1
        group.add(flap)
        const fe = box(0.22, len, 0.12, glowMat(mats, cyan, 2.0))
        fe.position.set(s * 1.02, fy, -0.9)
        group.add(fe)
      }
    }
  }

  if (opts.scale && opts.scale !== 1) group.scale.setScalar(opts.scale)
  shadowAll(group)
  let t = 0
  return {
    group,
    update: (dt) => {
      t += dt
      const e = 1.6 + Math.sin(t * 6) * 0.8
      for (const m of pulseMats) m.emissiveIntensity = e
    },
    dispose: () => disposeGroup(group, mats),
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Four-legged robot walker (~1.5m tall). CharacterModel; legs trot-animate. */
export function createQuadruped(accent = config.palette.orange): CharacterModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const body = new THREE.MeshStandardMaterial({ color: 0x2a3342, metalness: 0.85, roughness: 0.35 })
  mats.push(body)
  const trim = glowMat(mats, accent, 2.8)
  const core = new THREE.Group()
  group.add(core)
  const hull = box(0.9, 0.5, 1.7, body)
  hull.position.y = 1.05
  core.add(hull)
  const neck = box(0.34, 0.3, 0.5, body)
  neck.position.set(0, 1.2, 1.0)
  core.add(neck)
  const eye = box(0.3, 0.1, 0.08, trim)
  eye.position.set(0, 1.24, 1.25)
  core.add(eye)
  const legs: THREE.Group[] = []
  const mkLeg = (sx: number, sz: number) => {
    const hip = new THREE.Group()
    hip.position.set(sx, 0.92, sz)
    const up = box(0.13, 0.5, 0.13, body)
    up.position.y = -0.26
    const lo = box(0.1, 0.5, 0.1, body)
    lo.position.y = -0.72
    hip.add(up, lo)
    core.add(hip)
    legs.push(hip)
  }
  mkLeg(-0.5, 0.6); mkLeg(0.5, 0.6); mkLeg(-0.5, -0.6); mkLeg(0.5, -0.6)
  shadowAll(group)
  let phase = 0
  return {
    group,
    update: (dt, s01) => {
      const s = clamp01(s01)
      phase += dt * (3 + s * 6)
      // Diagonal trot gait.
      legs.forEach((l, i) => { l.rotation.x = Math.sin(phase + (i === 0 || i === 3 ? 0 : Math.PI)) * (0.18 + s * 0.5) })
      core.position.y = Math.abs(Math.sin(phase * 2)) * 0.04 * s
    },
    dispose: () => disposeGroup(group, mats),
  }
}

/** Big bipedal mech walker (~5m). Slow, heavy stomp; glowing cockpit core. */
export function createMech(accent = config.palette.magenta): CharacterModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const body = new THREE.MeshStandardMaterial({ color: 0x222a38, metalness: 0.88, roughness: 0.34 })
  const plate = new THREE.MeshStandardMaterial({ color: 0x3a4456, metalness: 0.8, roughness: 0.4 })
  mats.push(body, plate)
  const trim = glowMat(mats, accent, 3)
  const core = new THREE.Group()
  group.add(core)
  const torso = box(1.8, 1.6, 1.2, body)
  torso.position.y = 3.6
  core.add(torso)
  const cockpit = box(1.0, 0.6, 0.3, trim)
  cockpit.position.set(0, 3.9, 0.65)
  core.add(cockpit)
  const head = box(0.7, 0.5, 0.7, plate)
  head.position.set(0, 4.6, 0)
  core.add(head)
  // Shoulder cannons.
  for (const sx of [-1.2, 1.2]) {
    const sh = box(0.5, 0.6, 0.6, plate)
    sh.position.set(sx, 4.0, 0)
    core.add(sh)
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.0, 10), body)
    barrel.rotation.x = Math.PI / 2
    barrel.position.set(sx, 4.0, 0.7)
    core.add(barrel)
  }
  // Legs (pivot at hip, geometry hung down).
  const legs: THREE.Group[] = []
  const mkLeg = (sx: number) => {
    const hip = new THREE.Group()
    hip.position.set(sx, 2.8, 0)
    const thigh = box(0.5, 1.4, 0.6, body)
    thigh.position.y = -0.7
    const shin = box(0.42, 1.4, 0.5, plate)
    shin.position.y = -2.0
    const foot = box(0.6, 0.3, 1.0, body)
    foot.position.set(0, -2.75, 0.2)
    hip.add(thigh, shin, foot)
    core.add(hip)
    legs.push(hip)
  }
  mkLeg(-0.55); mkLeg(0.55)
  shadowAll(group)
  let phase = 0
  return {
    group,
    update: (dt, s01) => {
      const s = clamp01(s01)
      phase += dt * (1.4 + s * 2.2)
      legs.forEach((l, i) => { l.rotation.x = Math.sin(phase + (i ? Math.PI : 0)) * (0.1 + s * 0.4) })
      core.position.y = Math.abs(Math.sin(phase)) * 0.12 * s // heavy bob
      core.rotation.z = Math.sin(phase) * 0.02 * s
    },
    dispose: () => disposeGroup(group, mats),
  }
}

/**
 * Massive four-legged walker war-machine (~18m tall) for distant/outskirt
 * patrols - the "giant robot on the horizon" beat. Original design: a long
 * command hull on splayed segmented legs with a sensor head and chin cannons,
 * neon-trimmed to match the city. Legs animate a slow, heavy gait.
 */
export function createMassiveWalker(accent = config.palette.cyan): CharacterModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const body = new THREE.MeshStandardMaterial({ color: 0x1c2430, metalness: 0.85, roughness: 0.4 })
  const plate = new THREE.MeshStandardMaterial({ color: 0x2c3748, metalness: 0.8, roughness: 0.45 })
  mats.push(body, plate)
  const trim = glowMat(mats, accent, 2.6)
  const core = new THREE.Group()
  group.add(core)

  const hullY = 15
  const hull = box(5.5, 4.5, 12, body)
  hull.position.set(0, hullY, 0)
  core.add(hull)
  const belly = box(4.8, 2.2, 10, plate)
  belly.position.set(0, hullY - 2.6, 0)
  core.add(belly)
  for (const sx of [-2.85, 2.85]) {
    const strip = box(0.2, 0.5, 9, trim)
    strip.position.set(sx, hullY, 0)
    core.add(strip)
  }
  // Sensor head on a short neck at the front (+Z).
  const neck = box(1.6, 1.6, 1.6, plate)
  neck.position.set(0, hullY + 1.4, 6.4)
  core.add(neck)
  const head = box(3.2, 2.4, 3.0, body)
  head.position.set(0, hullY + 2.6, 7.8)
  core.add(head)
  const eye = box(2.3, 0.5, 0.3, trim)
  eye.position.set(0, hullY + 2.8, 9.35)
  core.add(eye)
  for (const sx of [-0.8, 0.8]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 2.4, 10), body)
    barrel.rotation.x = Math.PI / 2
    barrel.position.set(sx, hullY + 1.4, 9.3)
    core.add(barrel)
  }

  // Four long segmented legs: hip pivot on the hull, knee pivot partway down.
  const hips: THREE.Group[] = []
  const knees: THREE.Group[] = []
  const mkLeg = (sx: number, sz: number) => {
    const hip = new THREE.Group()
    hip.position.set(sx, hullY - 1.5, sz)
    const thigh = box(1.0, 7, 1.0, plate)
    thigh.position.y = -3.5
    const knee = new THREE.Group()
    knee.position.y = -7
    const shin = box(0.8, 7.5, 0.8, body)
    shin.position.y = -3.75
    const foot = box(1.6, 0.6, 2.2, plate)
    foot.position.set(0, -7.5, 0.3)
    knee.add(shin, foot)
    hip.add(thigh, knee)
    core.add(hip)
    hips.push(hip)
    knees.push(knee)
  }
  mkLeg(-2.6, 4); mkLeg(2.6, 4); mkLeg(-2.6, -4); mkLeg(2.6, -4)
  shadowAll(group)
  let phase = 0
  return {
    group,
    update: (dt, s01) => {
      const s = clamp01(s01)
      phase += dt * (0.8 + s * 1.3) // slow and ponderous
      hips.forEach((h, i) => {
        const ph = phase + (i === 0 || i === 3 ? 0 : Math.PI)
        h.rotation.x = Math.sin(ph) * (0.12 + s * 0.3)
        knees[i].rotation.x = Math.max(0, Math.sin(ph + 0.6)) * (0.18 + s * 0.4)
      })
      core.position.y = Math.abs(Math.sin(phase * 2)) * 0.22 * s // heavy sway
    },
    dispose: () => disposeGroup(group, mats),
  }
}

/** Small sleek flier with a glowing engine. VehicleModel; Sky positions it. */
export function createSmallShip(accent = config.palette.cyan): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const body = new THREE.MeshStandardMaterial({ color: 0x252e40, metalness: 0.9, roughness: 0.25 })
  mats.push(body)
  const hull = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.6, 12), body)
  hull.rotation.x = Math.PI / 2
  group.add(hull)
  const wing = box(2.6, 0.1, 0.7, body)
  wing.position.z = -0.3
  group.add(wing)
  for (const sx of [-1.3, 1.3]) {
    const tip = box(0.2, 0.1, 0.5, glowMat(mats, accent, 3))
    tip.position.set(sx, 0, -0.3)
    group.add(tip)
  }
  const engine = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 10), glowMat(mats, accent, 3.5))
  engine.scale.z = 0.5
  engine.position.z = -1.3
  group.add(engine)
  shadowAll(group)
  const engMat = engine.material as THREE.MeshStandardMaterial
  let t = 0
  return {
    group,
    update: (dt) => { t += dt; engMat.emissiveIntensity = 3 + Math.sin(t * 12) * 1.2 },
    dispose: () => disposeGroup(group, mats),
  }
}

/** Big capital ship for flyovers - low detail, large, lit window strip + engines. */
export function createBigShip(): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const body = new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.85, roughness: 0.35 })
  mats.push(body)
  const hull = box(8, 3, 22, body)
  group.add(hull)
  const fin = box(3, 5, 6, body)
  fin.position.set(0, 2.5, -8)
  group.add(fin)
  const strip = box(8.1, 0.5, 16, glowMat(mats, config.palette.cyan, 2.2))
  strip.position.y = 0.4
  group.add(strip)
  for (const sx of [-2.5, 0, 2.5]) {
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.2, 14), glowMat(mats, config.palette.magenta, 3))
    eng.rotation.x = Math.PI / 2
    eng.position.set(sx, 0, -11.4)
    group.add(eng)
  }
  shadowAll(group)
  return { group, update: () => {}, dispose: () => disposeGroup(group, mats) }
}

/** Sleek single-seat speeder bike (origin at chassis center; hovers via Vehicles). */
export function createSpeederBike(): VehicleModel {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const body = new THREE.MeshStandardMaterial({ color: 0x2a2050, metalness: 0.9, roughness: 0.28 })
  mats.push(body)
  const spine = box(0.5, 0.34, 3.4, body)
  group.add(spine)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.4, 12), body)
  nose.rotation.x = Math.PI / 2
  nose.position.set(0, 0.05, 2.2)
  group.add(nose)
  const seat = box(0.42, 0.18, 1.0, new THREE.MeshStandardMaterial({ color: 0x14101f, metalness: 0.5, roughness: 0.6 }))
  ;(seat.material as THREE.Material) && mats.push(seat.material as THREE.Material)
  seat.position.set(0, 0.28, -0.4)
  group.add(seat)
  const under = box(0.42, 0.06, 3.0, glowMat(mats, config.palette.magenta, 4))
  under.position.y = -0.22
  group.add(under)
  for (const sx of [-0.5, 0.5]) {
    const fin = box(0.06, 0.5, 1.1, glowMat(mats, config.palette.cyan, 2.8))
    fin.position.set(sx, 0.1, -1.4)
    fin.rotation.z = sx * 0.25
    group.add(fin)
  }
  const thr = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.3, 14), glowMat(mats, config.palette.cyan, 3.4))
  thr.rotation.x = Math.PI / 2
  thr.position.set(0, 0, -1.9)
  group.add(thr)
  shadowAll(group)
  const underMat = under.material as THREE.MeshStandardMaterial
  let t = 0
  return {
    group,
    update: (dt) => { t += dt; underMat.emissiveIntensity = 3.4 + Math.sin(t * 5) * 1.0 },
    dispose: () => disposeGroup(group, mats),
  }
}

/**
 * A pilotable humanoid battle-mech, built at a base ~5m scale and then scaled by
 * `opts.scale` so the same rig serves the medium / large / extra-large suits.
 * Heavy armor with neon trim, an open cockpit, shoulder missile pods (with
 * visible tubes), back + foot thrusters that glow for flight, and a pulsing
 * reactor core. Returned as a VehicleModel; the legs tuck into a flight pose as
 * speed rises.
 */
export interface MechOpts { scale?: number; armor?: number; trim?: number; core?: number }
export function createMechSuit(opts: MechOpts = {}): VehicleModel {
  const scale = opts.scale ?? 1
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const armor = new THREE.MeshStandardMaterial({ color: opts.armor ?? 0x2348c8, metalness: 0.85, roughness: 0.3 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x141a2c, metalness: 0.7, roughness: 0.45 })
  const steel = new THREE.MeshStandardMaterial({ color: 0x9fb4d8, metalness: 0.9, roughness: 0.28 })
  mats.push(armor, dark, steel)
  const trim = glowMat(mats, opts.trim ?? config.palette.cyan, 3.2)
  const coreGlow = glowMat(mats, opts.core ?? 0x6fd8ff, 4)
  const missileMat = glowMat(mats, opts.trim ?? config.palette.orange, 2.6)

  const core = new THREE.Group()
  group.add(core)

  // Hips / waist.
  const pelvis = box(1.5, 0.7, 1.0, dark)
  pelvis.position.y = 2.5
  core.add(pelvis)

  // Chest with an open cockpit recess the pilot drops into.
  const torso = box(1.9, 1.5, 1.3, armor)
  torso.position.y = 3.5
  core.add(torso)
  const cockpit = box(0.9, 0.8, 0.5, dark)
  cockpit.position.set(0, 3.7, 0.55)
  core.add(cockpit)
  const reactor = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.2, 18), coreGlow)
  reactor.rotation.x = Math.PI / 2
  reactor.position.set(0, 3.3, 0.62)
  core.add(reactor)
  for (const sx of [-0.95, 0.95]) {
    const strip = box(0.12, 1.2, 0.2, trim)
    strip.position.set(sx, 3.5, 0.6)
    core.add(strip)
  }

  // Head / sensor.
  const head = box(0.7, 0.55, 0.7, steel)
  head.position.y = 4.5
  core.add(head)
  const eye = box(0.5, 0.14, 0.2, trim)
  eye.position.set(0, 4.52, 0.35)
  core.add(eye)

  // Shoulder pods with visible missile tubes pointing forward (+Z).
  const arms: THREE.Group[] = []
  const mkArm = (sx: number) => {
    const sh = new THREE.Group()
    sh.position.set(sx, 4.0, 0)
    const pod = box(0.8, 0.85, 0.95, armor)
    sh.add(pod)
    // Missile tube cluster on top of the shoulder pod.
    for (const tx of [-0.22, 0.22]) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.7, 10), missileMat)
      tube.rotation.x = Math.PI / 2
      tube.position.set(tx, 0.55, 0.4)
      sh.add(tube)
    }
    const upper = box(0.45, 1.0, 0.5, steel)
    upper.position.set(sx * 0.1, -0.8, 0)
    const fore = box(0.5, 0.9, 0.55, dark)
    fore.position.set(sx * 0.1, -1.7, 0)
    const fist = box(0.6, 0.55, 0.6, steel)
    fist.position.set(sx * 0.1, -2.25, 0)
    sh.add(upper, fore, fist)
    core.add(sh)
    arms.push(sh)
    return sh
  }
  mkArm(-1.3); mkArm(1.3)

  // Legs.
  const legs: THREE.Group[] = []
  const mkLeg = (sx: number) => {
    const hip = new THREE.Group()
    hip.position.set(sx, 2.3, 0)
    const thigh = box(0.6, 1.2, 0.7, armor)
    thigh.position.y = -0.6
    const shin = box(0.5, 1.2, 0.55, steel)
    shin.position.y = -1.7
    const foot = box(0.75, 0.4, 1.2, dark)
    foot.position.set(0, -2.4, 0.25)
    hip.add(thigh, shin, foot)
    core.add(hip)
    legs.push(hip)
  }
  mkLeg(-0.6); mkLeg(0.6)

  // Flight thrusters: additive cones on the back + under the feet. They flare
  // with thrust (driven by speed01) so the mech reads as jet-powered.
  const flameMat = new THREE.MeshBasicMaterial({ color: opts.core ?? 0x6fd8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
  mats.push(flameMat)
  const flames: THREE.Mesh[] = []
  const addFlame = (x: number, y: number, z: number, len: number) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.3, len, 12), flameMat)
    f.rotation.x = Math.PI // point down
    f.position.set(x, y, z)
    core.add(f)
    flames.push(f)
  }
  addFlame(-0.6, 0.0, 0.0, 1.4) // under-foot
  addFlame(0.6, 0.0, 0.0, 1.4)
  addFlame(-0.5, 3.4, -0.8, 1.8) // back pack
  addFlame(0.5, 3.4, -0.8, 1.8)

  group.scale.setScalar(scale)
  shadowAll(group)
  const reactorMat = reactor.material as THREE.MeshStandardMaterial
  let phase = 0
  let t = 0
  let morph = 0 // 0 = robot stance, 1 = horizontal jet/flight form
  return {
    group,
    setMorph: (a: number) => { morph = Math.min(1, Math.max(0, a)) },
    update: (dt, s01) => {
      t += dt
      const s = clamp01(s01)
      phase += dt * (1.6 + s * 3.0)
      // Tuck the legs back as it speeds up (flight pose); idle sway otherwise.
      const tuck = s * 0.5
      // Jet form: body tips horizontal, legs stream straight back as a tail and
      // the arms sweep back like wings; blended by `morph`.
      legs.forEach((l, i) => {
        const robot = -tuck + Math.sin(phase + (i ? Math.PI : 0)) * 0.06 * (1 - s)
        l.rotation.x = robot * (1 - morph) + 0.15 * morph
      })
      arms.forEach((a, i) => {
        const robot = Math.sin(phase + (i ? 0 : Math.PI)) * 0.05
        a.rotation.x = robot * (1 - morph) - 1.35 * morph
        a.rotation.z = (i ? -1 : 1) * 0.5 * morph
      })
      core.rotation.x = -s * 0.18 * (1 - morph) - (Math.PI / 2) * 0.82 * morph
      reactorMat.emissiveIntensity = 3.6 + Math.sin(t * 4) * 0.8
      const flicker = 0.7 + Math.sin(t * 38) * 0.2
      const fs = (0.35 + s * 0.65 + morph * 0.6) * flicker
      for (const f of flames) f.scale.set(0.6 + s * 0.4 + morph * 0.3, fs, 0.6 + s * 0.4 + morph * 0.3)
    },
    dispose: () => disposeGroup(group, mats),
  }
}

/** Glowing sci-fi crate prop (returns a group; static, used for street dressing). */
export function createGlowCrate(accent = config.palette.lime): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group()
  const mats: THREE.Material[] = []
  const shell = new THREE.MeshStandardMaterial({ color: 0x12161f, metalness: 0.6, roughness: 0.5 })
  mats.push(shell)
  const crate = box(1.1, 1.1, 1.1, shell)
  crate.position.y = 0.55
  crate.castShadow = true
  group.add(crate)
  const edge = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 8, 4), glowMat(mats, accent, 2.6))
  edge.rotation.x = Math.PI / 2
  edge.position.y = 0.55
  group.add(edge)
  const top = box(0.5, 0.06, 0.5, glowMat(mats, accent, 2.6))
  top.position.y = 1.12
  group.add(top)
  return { group, dispose: () => disposeGroup(group, mats) }
}
