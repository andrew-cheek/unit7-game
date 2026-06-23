import * as THREE from 'three'
import { config } from './config'
import { createMech, createDrone } from './procedural'
import { randRange } from './utils'
import { trackEvent } from '../lib/analytics'
import type { Zone } from './types'

export interface Portal {
  group: THREE.Group
  position: THREE.Vector3 // ground position (XZ trigger)
  radius: number
  target: Zone
  update(dt: number): void
}

export interface PlanetEnv {
  group: THREE.Group
  groundMeshes: THREE.Mesh[]
  colliders: THREE.Box3[]
  solidMeshes: THREE.Object3D[]
  spawn: THREE.Vector3
  portals: Portal[]
  update(dt: number): void
  dispose(): void
}

const HALF = 200

/**
 * Off-world zones. Earth is the city (World); this builds the Mars and Moon
 * environments - displaced/cratered terrain the ground-raycast walks on, scattered
 * rocks (solid), a decorative sky body, and walk-through portals. Per-zone gravity
 * lives in config and is applied by Game, so jumps and parachute descent change
 * noticeably between worlds. Earth's outbound portals are also built here.
 */
export class Zones {
  readonly earthPortals: Portal[] = []
  // Built lazily on first visit (see ensure): you start on Earth, so the off-world
  // terrain + colonies don't need to be generated at boot.
  private mars: PlanetEnv | null = null
  private moon: PlanetEnv | null = null

  private scene: THREE.Scene
  private earthPortalGroup = new THREE.Group()
  // The zone the world is currently showing. Seeded to the constructor default so
  // the initial setActive('earth') is a no-op and never emits a transition event.
  private activeZone: Zone = 'earth'

  constructor(scene: THREE.Scene) {
    this.scene = scene

    // Mars is reached through the central Portal Plaza hero ring (wired in Game),
    // so the only ring portal on Earth is the Moon, set well out to the side so
    // the spawn view stays open instead of being framed by gateways.
    this.earthPortals.push(this.makePortal('moon', 0xbfe6ff, new THREE.Vector3(56, 0, 22)))
    for (const p of this.earthPortals) this.earthPortalGroup.add(p.group)
    // Planet/moon travel is its own thing, separate from the arcade: these ring
    // portals are how you leave Earth for another world.
    scene.add(this.earthPortalGroup)
  }

  /** Build a planet environment on first visit and cache it. Deferring this keeps
   *  the Earth boot cheap (no Mars/Moon terrain, colony, or data-centre geometry
   *  generated until you actually travel). The one-time build hides under the
   *  zone-transition fade. */
  private ensure(zone: Zone): PlanetEnv | null {
    if (zone === 'mars') {
      if (!this.mars) { this.mars = this.buildMars(); this.mars.group.visible = false; this.scene.add(this.mars.group) }
      return this.mars
    }
    if (zone === 'moon') {
      if (!this.moon) { this.moon = this.buildMoon(); this.moon.group.visible = false; this.scene.add(this.moon.group) }
      return this.moon
    }
    return null
  }

  env(zone: Zone): PlanetEnv | null {
    return this.ensure(zone)
  }
  portalsFor(zone: Zone): Portal[] {
    return zone === 'earth' ? this.earthPortals : this.ensure(zone)!.portals
  }

  setActive(zone: Zone) {
    this.earthPortalGroup.visible = zone === 'earth'
    if (zone === 'mars' || zone === 'moon') this.ensure(zone) // build before showing
    if (this.mars) this.mars.group.visible = zone === 'mars'
    if (this.moon) this.moon.group.visible = zone === 'moon'
    // Every Earth/Mars/Moon transition (portals and rocket both route through
    // here) emits one zone_change. Guarded so re-applying the same zone is silent.
    if (zone !== this.activeZone) {
      trackEvent('zone_change', { from: this.activeZone, to: zone })
      this.activeZone = zone
    }
  }

  update(dt: number, zone: Zone) {
    for (const p of this.portalsFor(zone)) p.update(dt)
    if (zone !== 'earth') this.env(zone)!.update(dt)
  }

  // --- builders ------------------------------------------------------------

  private makePortal(target: Zone, color: number, pos: THREE.Vector3): Portal {
    const group = new THREE.Group()
    group.position.copy(pos)
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 2, roughness: 0.4 })
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.22, 16, 40), ringMat)
    ring.position.y = 2.7
    group.add(ring)
    const discMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.3, 36), discMat)
    disc.position.y = 2.7
    group.add(disc)
    const padMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 2 })
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3.0, 0.2, 24), padMat)
    pad.position.y = 0.1
    group.add(pad)

    // Swirling interior: a second disc counter-rotating behind the first plus a
    // faint vertical energy column rising through the ring.
    const swirlMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const swirl = new THREE.Mesh(new THREE.RingGeometry(0.4, 2.2, 24, 1), swirlMat)
    swirl.position.y = 2.7
    group.add(swirl)
    const columnMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const column = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 9, 16, 1, true), columnMat)
    column.position.y = 4.5
    group.add(column)

    // Colored light spill on the ground around the pad.
    const spillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const spill = new THREE.Mesh(new THREE.CircleGeometry(5.5, 32), spillMat)
    spill.rotation.x = -Math.PI / 2
    spill.position.y = 0.06
    group.add(spill)

    // Surrounding machinery: glowing pylons flanking the gateway.
    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x0a0d16, emissive: color, emissiveIntensity: 1.6, metalness: 0.5, roughness: 0.5 })
    for (const sx of [-3.1, 3.1]) {
      const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 5, 8), pylonMat)
      pylon.position.set(sx, 2.5, 0)
      group.add(pylon)
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color, fog: false }))
      cap.position.set(sx, 5.1, 0)
      group.add(cap)
    }

    // A tall gateway arch over the portal so each reads as a distinct entrance
    // from a distance (unique silhouette), in the destination's accent colour.
    const archMat = new THREE.MeshStandardMaterial({ color: 0x0a0d16, emissive: color, emissiveIntensity: 1.4, metalness: 0.5, roughness: 0.5 })
    const arch = new THREE.Mesh(new THREE.TorusGeometry(4.4, 0.4, 10, 28, Math.PI), archMat)
    arch.position.y = 0.2
    group.add(arch)
    // A short receding tunnel of rings behind the gateway for depth.
    for (let r = 0; r < 3; r++) {
      const tube = new THREE.Mesh(new THREE.TorusGeometry(2.6 - r * 0.2, 0.12, 8, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 - r * 0.12, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      tube.position.set(0, 2.7, -1.2 - r * 1.1)
      group.add(tube)
    }

    // Floating label so the player can read the destination from a distance.
    const label = target === 'mars' ? 'MARS PORTAL' : target === 'moon' ? 'MOON PORTAL' : 'CITY RETURN'
    const sprite = this.labelSprite(label, color)
    sprite.position.set(0, 6.4, 0)
    group.add(sprite)

    let t = 0
    return {
      group,
      position: new THREE.Vector3(pos.x, 0, pos.z),
      radius: 3.2,
      target,
      update: (dt) => {
        t += dt
        disc.rotation.z += dt * 0.7
        swirl.rotation.z -= dt * 1.6 // swirl counter-spins
        ring.rotation.z += dt * 0.5 // the gateway ring slowly turns
        column.rotation.y += dt * 0.8
        const pulse = Math.sin(t * 3)
        ringMat.emissiveIntensity = 1.8 + pulse * 0.5
        discMat.opacity = 0.22 + Math.sin(t * 2) * 0.1
        swirlMat.opacity = 0.16 + pulse * 0.08
        spillMat.opacity = 0.3 + pulse * 0.12
        padMat.emissiveIntensity = 1.8 + pulse * 0.5
      },
    }
  }

  /** Neon text billboard sprite for portal labels. */
  private labelSprite(text: string, color: number): THREE.Sprite {
    const cv = document.createElement('canvas')
    cv.width = 512; cv.height = 128
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.font = '800 64px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#' + color.toString(16).padStart(6, '0')
    ctx.shadowBlur = 22
    ctx.fillStyle = '#eaf6ff'
    ctx.fillText(text, cv.width / 2, cv.height / 2)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
    sprite.scale.set(6.5, 1.6, 1)
    return sprite
  }

  private makeTerrain(displace: (x: number, z: number) => number, color: number, rough: number): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(HALF * 2 + 40, HALF * 2 + 40, 90, 90)
    geo.rotateX(-Math.PI / 2)
    const pos = geo.attributes.position
    for (let i = 0; i < pos.count; i++) pos.setY(i, displace(pos.getX(i), pos.getZ(i)))
    geo.computeVertexNormals()
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02 }))
    mesh.receiveShadow = true
    mesh.name = 'terrain'
    return mesh
  }

  private celestial(group: THREE.Group, color: number, pos: THREE.Vector3, size: number, emissive = true) {
    const mat = emissive
      ? new THREE.MeshBasicMaterial({ color, fog: false })
      : new THREE.MeshStandardMaterial({ color, roughness: 1, emissive: color, emissiveIntensity: 0.3, fog: false })
    const body = new THREE.Mesh(new THREE.SphereGeometry(size, 32, 24), mat)
    body.position.copy(pos)
    group.add(body)
  }

  /**
   * Launch ramps: solid wedges the rover (and player) drive up and fly off. Each
   * is a triangular prism added to the ground-raycast meshes (so Y follows the
   * slope on the way up) with a glowing top lip + side stripes so it reads as a
   * jump from a distance. No blocking collider - that would stop you climbing it;
   * the ground follow + per-zone gravity do the launch. Placed out in the hills
   * where the low gravity makes the air time dramatic.
   */
  private addRamps(group: THREE.Group, env: PlanetEnv, displace: (x: number, z: number) => number, color: number, specs: Array<[number, number, number, number, number, number]>) {
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x232733, metalness: 0.5, roughness: 0.55, side: THREE.DoubleSide })
    const lipMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 2.4, roughness: 0.4 })
    for (const [x, z, yaw, w, len, h] of specs) {
      const by = displace(x, z)
      const rg = new THREE.Group()
      rg.position.set(x, by, z)
      rg.rotation.y = yaw
      const wedge = new THREE.Mesh(makeWedge(w, len, h), rampMat)
      wedge.receiveShadow = true
      wedge.castShadow = true
      wedge.name = 'ramp'
      rg.add(wedge)
      // Glowing top lip at the launch edge + chevron stripes up the face.
      const lip = new THREE.Mesh(new THREE.BoxGeometry(w * 1.04, 0.5, 0.7), lipMat)
      lip.position.set(0, h + 0.25, len / 2)
      rg.add(lip)
      for (let i = 1; i <= 3; i++) {
        const f = i / 4
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.12, 0.5), lipMat)
        stripe.position.set(0, h * f + 0.18, -len / 2 + len * f)
        stripe.rotation.x = -Math.atan2(h, len)
        rg.add(stripe)
      }
      group.add(rg)
      rg.updateMatrixWorld(true)
      env.groundMeshes.push(wedge)
      env.solidMeshes.push(rg)
    }
  }

  private scatterRocks(group: THREE.Group, env: PlanetEnv, displace: (x: number, z: number) => number, color: number, count: number) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.03, flatShading: true })
    for (let i = 0; i < count; i++) {
      const x = randRange(-HALF + 20, HALF - 20)
      const z = randRange(-HALF + 20, HALF - 20)
      if (Math.hypot(x, z) < 16) continue // keep spawn clear
      const s = randRange(1.2, 4.5)
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), mat)
      rock.scale.set(randRange(0.7, 1.3), randRange(0.6, 1.1), randRange(0.7, 1.3))
      rock.rotation.set(randRange(0, 6.28), randRange(0, 6.28), randRange(0, 6.28))
      const y = displace(x, z)
      rock.position.set(x, y + s * 0.3, z)
      rock.castShadow = true
      rock.receiveShadow = true
      group.add(rock)
      env.solidMeshes.push(rock)
      env.colliders.push(new THREE.Box3(new THREE.Vector3(x - s, y - 1, z - s), new THREE.Vector3(x + s, y + s * 1.6, z + s)))
    }
  }

  /**
   * Mars life: drifting bioluminescent spore-jellies that bob and circle slowly
   * over the dunes. Cheap (sphere + tendrils), additive glow. Returns an animate
   * function the env calls each frame.
   */
  private buildSpores(group: THREE.Group, displace: (x: number, z: number) => number): (dt: number) => void {
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x2bff8a, transparent: true, opacity: 0.85, fog: false })
    const tendrilMat = new THREE.MeshBasicMaterial({ color: 0x6fffc0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const items: { g: THREE.Group; cx: number; cz: number; r: number; ang: number; spd: number; baseY: number; phase: number }[] = []
    const n = config.tier.name === 'high' ? 10 : 5
    for (let i = 0; i < n; i++) {
      const cx = randRange(-130, 130)
      const cz = randRange(-130, 130)
      if (Math.hypot(cx, cz) < 24) continue
      const jelly = new THREE.Group()
      const bell = new THREE.Mesh(new THREE.SphereGeometry(randRange(1.2, 2.2), 12, 10, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat)
      jelly.add(bell)
      for (let k = 0; k < 5; k++) {
        const tendril = new THREE.Mesh(new THREE.ConeGeometry(0.12, 3.2, 6), tendrilMat)
        tendril.rotation.x = Math.PI
        tendril.position.set(Math.cos((k / 5) * 6.28) * 0.7, -1.6, Math.sin((k / 5) * 6.28) * 0.7)
        jelly.add(tendril)
      }
      const baseY = displace(cx, cz) + randRange(12, 26)
      jelly.position.set(cx, baseY, cz)
      group.add(jelly)
      items.push({ g: jelly, cx, cz, r: randRange(6, 16), ang: randRange(0, 6.28), spd: randRange(0.08, 0.2) * (i % 2 ? 1 : -1), baseY, phase: randRange(0, 6.28) })
    }
    let t = 0
    return (dt: number) => {
      t += dt
      for (const it of items) {
        it.ang += it.spd * dt
        it.g.position.set(it.cx + Math.cos(it.ang) * it.r, it.baseY + Math.sin(t * 0.8 + it.phase) * 1.6, it.cz + Math.sin(it.ang) * it.r)
        it.g.rotation.y += dt * 0.3
      }
    }
  }

  /**
   * Moon life: hovering mining drones circling slowly above the regolith with a
   * downward survey beam. Returns an animate function.
   */
  private buildMiningDrones(group: THREE.Group, displace: (x: number, z: number) => number): (dt: number) => void {
    const items: { model: ReturnType<typeof createDrone>; cx: number; cz: number; r: number; ang: number; spd: number; h: number }[] = []
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const n = config.tier.name === 'high' ? 6 : 3
    for (let i = 0; i < n; i++) {
      const cx = randRange(-120, 120)
      const cz = randRange(-120, 120)
      if (Math.hypot(cx, cz) < 22) continue
      const model = createDrone()
      const beam = new THREE.Mesh(new THREE.ConeGeometry(2.2, 10, 12, 1, true), beamMat)
      beam.position.y = -5
      model.group.add(beam)
      group.add(model.group)
      items.push({ model, cx, cz, r: randRange(10, 26), ang: randRange(0, 6.28), spd: randRange(0.1, 0.25) * (i % 2 ? 1 : -1), h: displace(cx, cz) + randRange(8, 18) })
    }
    return (dt: number) => {
      for (const it of items) {
        it.ang += it.spd * dt
        it.model.group.position.set(it.cx + Math.cos(it.ang) * it.r, it.h, it.cz + Math.sin(it.ang) * it.r)
        it.model.group.rotation.y = -it.ang
        it.model.update(dt, 0)
      }
    }
  }

  private addBoundary(colliders: THREE.Box3[]) {
    const t = 6
    const tall = 80
    colliders.push(new THREE.Box3(new THREE.Vector3(-HALF - t, -20, -HALF - t), new THREE.Vector3(HALF + t, tall, -HALF)))
    colliders.push(new THREE.Box3(new THREE.Vector3(-HALF - t, -20, HALF), new THREE.Vector3(HALF + t, tall, HALF + t)))
    colliders.push(new THREE.Box3(new THREE.Vector3(-HALF - t, -20, -HALF), new THREE.Vector3(-HALF, tall, HALF)))
    colliders.push(new THREE.Box3(new THREE.Vector3(HALF, -20, -HALF), new THREE.Vector3(HALF + t, tall, HALF)))
  }

  private buildMars(): PlanetEnv {
    const displace = (x: number, z: number) => {
      const d = Math.hypot(x, z)
      // Big rolling dunes ramp in away from spawn (mask = 0 near origin, 1 by ~98m)
      // so you touch down on flat ground but the rover has real hills to launch off.
      const hill = Math.min(1, Math.max(0, (d - 34) / 64))
      let y = Math.sin(x * 0.018) * 3 + Math.cos(z * 0.022) * 2.6 + Math.sin((x + z) * 0.04) * 1.4
      y += hill * (Math.sin(x * 0.0065 + 1.3) * 13 + Math.cos(z * 0.0078 - 0.6) * 11 + Math.sin((x - z) * 0.0052) * 8)
      y -= 5.4 // flatten the origin region for spawn
      return y
    }
    const group = new THREE.Group()
    const terrain = this.makeTerrain(displace, 0x7a3a1c, 0.95)
    group.add(terrain)
    this.celestial(group, 0xffd9a8, new THREE.Vector3(-180, 150, -320), 30) // distant sun
    this.celestial(group, 0xc98b6b, new THREE.Vector3(260, 120, -200), 14) // small moon

    const portals = [
      this.makePortal('earth', config.palette.lime, new THREE.Vector3(-8, 0, 0)),
      this.makePortal('moon', 0xbfe6ff, new THREE.Vector3(8, 0, 0)),
    ]
    for (const p of portals) {
      p.group.position.y = displace(p.position.x, p.position.z)
      group.add(p.group)
    }

    const spores = this.buildSpores(group, displace)
    const env: PlanetEnv = {
      group,
      groundMeshes: [terrain],
      colliders: [],
      solidMeshes: [terrain],
      spawn: new THREE.Vector3(0, displace(0, 0) + 1, -10),
      portals,
      update: (dt) => { portals.forEach((p) => p.update(dt)); spores(dt) },
      dispose: () => disposePlanet(group),
    }
    this.addBoundary(env.colliders)
    this.scatterRocks(group, env, displace, 0x612e16, 26)
    // Launch ramps spread out into the dunes (x, z, yaw, width, length, height).
    this.addRamps(group, env, displace, config.palette.orange, [
      [22, -34, 0, 12, 22, 7],
      [-40, -20, Math.PI * 0.5, 11, 20, 6],
      [54, 40, Math.PI * 0.85, 13, 26, 8.5],
      [-60, 50, -Math.PI * 0.35, 12, 22, 7],
      [10, 70, Math.PI, 14, 26, 9],
    ])
    this.buildMarsLife(group, displace)
    const colony = this.buildMarsColony(group, env, displace, 64, -56)
    const baseUpdate = env.update
    env.update = (dt) => { baseUpdate(dt); colony(dt) }
    return env
  }

  /**
   * Mars colony: a Starship launch/catch tower ("Mechazilla") whose chopstick
   * arms catch a descending booster and relaunch it on a loop, a lit landing
   * pad, habitat domes, and rovers trundling a patrol - so Mars reads as a
   * working frontier, not just ruins. The catch cycle is parametric (no physics,
   * deterministic) and cheap; counts scale down on mobile. Returns an animate fn.
   */
  private buildMarsColony(group: THREE.Group, env: PlanetEnv, displace: (x: number, z: number) => number, cx: number, cz: number): (dt: number) => void {
    const low = config.tier.name === 'low'
    const by = displace(cx, cz)
    const site = new THREE.Group()
    site.position.set(cx, by, cz)
    group.add(site)

    const steel = new THREE.MeshStandardMaterial({ color: 0x2b2f38, metalness: 0.7, roughness: 0.45 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x14171e, metalness: 0.6, roughness: 0.5 })
    const lit = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.orange, emissiveIntensity: 2.2, roughness: 0.4 })
    const hull = new THREE.MeshStandardMaterial({ color: 0xd8dde6, metalness: 0.6, roughness: 0.32 })
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffce8a, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })

    // --- the tower (Mechazilla) ---
    const TOWER_H = 56
    const mast = new THREE.Mesh(new THREE.BoxGeometry(4.5, TOWER_H, 4.5), steel)
    mast.position.y = TOWER_H / 2; mast.castShadow = true
    site.add(mast)
    for (let i = 1; i < 8; i++) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(5, 0.35, 5), lit)
      band.position.y = i * (TOWER_H / 8)
      site.add(band)
    }
    env.colliders.push(new THREE.Box3(new THREE.Vector3(cx - 3, by - 1, cz - 3), new THREE.Vector3(cx + 3, by + TOWER_H, cz + 3)))

    // Chopstick arm carriage at catch height. Each arm hinges at the tower side
    // and swings open/closed in the horizontal plane to cradle the booster.
    const CATCH_Y = 34
    const carriage = new THREE.Group()
    carriage.position.y = CATCH_Y
    site.add(carriage)
    const arms: THREE.Group[] = []
    for (const sideSign of [-1, 1]) {
      const arm = new THREE.Group()
      arm.position.set(sideSign * 2.4, 0, 0)
      const beam = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 15), steel)
      beam.position.set(sideSign * 0.5, 0, 8.5)
      arm.add(beam)
      const cradle = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.6, 3.2), lit)
      cradle.position.set(sideSign * 0.5, 0, 15)
      arm.add(cradle)
      carriage.add(arm)
      arms.push(arm)
    }

    // --- the booster being caught (Super Heavy + a stub ship nose) ---
    const booster = new THREE.Group()
    booster.position.set(0, 13, 14)
    const body = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 22, 20), hull)
    body.position.y = 11; body.castShadow = true
    booster.add(body)
    const lugs = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.9, 0.9), dark)
    lugs.position.y = 20.5
    booster.add(lugs)
    // grid fins
    for (const s of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 2.2), dark)
      fin.position.set(s * 2.5, 19, 0)
      booster.add(fin)
    }
    // stub ship nose on top
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 2.4, 7, 20), hull)
    nose.position.y = 25.5
    booster.add(nose)
    // landing-burn flame at the base, pointing down
    const flame = new THREE.Mesh(new THREE.ConeGeometry(1.8, 7, 14, 1, true), flameMat)
    flame.rotation.x = Math.PI
    flame.position.y = -3.5
    booster.add(flame)
    site.add(booster)

    // --- pad, domes, perimeter ---
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(10, 10.6, 0.4, 32), new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.orange, emissiveIntensity: 1.3, roughness: 0.5 }))
    pad.position.set(0, 0.2, 14); pad.receiveShadow = true
    site.add(pad)
    const shell = new THREE.MeshStandardMaterial({ color: 0xc4b0a0, metalness: 0.4, roughness: 0.6 })
    const glow = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x49f2c0, emissiveIntensity: 2, roughness: 0.4 })
    const domeGeo = new THREE.SphereGeometry(1, 14, 9, 0, Math.PI * 2, 0, Math.PI / 2)
    for (const [dx, dz, r] of [[-16, 6, 4.5], [-22, -4, 3.4], [16, -14, 3.8]] as Array<[number, number, number]>) {
      const dome = new THREE.Mesh(domeGeo, shell)
      dome.scale.set(r, r * 0.8, r); dome.position.set(dx, 0, dz); dome.castShadow = true
      site.add(dome)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.7, 0.16, 8, 22), glow)
      ring.rotation.x = Math.PI / 2; ring.position.set(dx, r * 0.34, dz)
      site.add(ring)
      env.colliders.push(new THREE.Box3(new THREE.Vector3(cx + dx - r, by - 1, cz + dz - r), new THREE.Vector3(cx + dx + r, by + r, cz + dz + r)))
    }
    const perimMats: THREE.MeshStandardMaterial[] = []
    if (!low) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        const m = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.orange, emissiveIntensity: 2 })
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2, 0.4), m)
        post.position.set(Math.cos(a) * 26, 1, Math.sin(a) * 26)
        site.add(post); perimMats.push(m)
      }
    }

    // --- rovers patrolling the colony (ground-vehicle activity) ---
    const rovers: { g: THREE.Group; ang: number; spd: number; r: number }[] = []
    const rn = low ? 1 : 3
    for (let i = 0; i < rn; i++) {
      const rv = new THREE.Group()
      const rbody = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 2), dark)
      rbody.position.y = 0.9; rv.add(rbody)
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.8, 1.5), lit)
      cab.position.set(-0.4, 1.6, 0); rv.add(cab)
      for (const wx of [-1, 1]) for (const wz of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 9), steel)
        w.rotation.x = Math.PI / 2; w.position.set(wx * 1.1, 0.5, wz * 0.9); rv.add(w)
      }
      group.add(rv)
      rovers.push({ g: rv, ang: (i / rn) * Math.PI * 2, spd: 0.1 + i * 0.03, r: 30 + i * 9 })
    }

    let t = Math.random() * 4
    const T = 18 // full catch + relaunch cycle, seconds
    return (dt: number) => {
      t += dt
      const ph = t % T
      let yy = 13, close = 1, flameK = 0
      if (ph < 8) {
        // booster descends from high, arms open until the last moment, then snap shut
        const k = ph / 8
        yy = 84 + (13 - 84) * k
        close = k > 0.84 ? (k - 0.84) / 0.16 : 0
        flameK = k > 0.5 ? 1 : 0.25
      } else if (ph < 12) {
        yy = 13; close = 1; flameK = 0 // caught, held
      } else if (ph < 13) {
        yy = 13; close = 1 - (ph - 12); flameK = 0 // arms release
      } else {
        const k = (ph - 13) / (T - 13)
        yy = 13 + (84 - 13) * k; close = 0; flameK = 1 // relaunch
      }
      booster.position.y = yy
      const open = 1 - close
      arms[0].rotation.y = 0.42 * open
      arms[1].rotation.y = -0.42 * open
      flame.visible = flameK > 0.05
      flame.scale.set(1, flameK * (0.85 + Math.random() * 0.4) + 0.15, 1)
      ;(flameMat as THREE.MeshBasicMaterial).opacity = 0.6 + Math.random() * 0.35
      for (let i = 0; i < perimMats.length; i++) perimMats[i].emissiveIntensity = 1.2 + Math.sin(t * 3 + i) * 1.1
      for (const rv of rovers) {
        rv.ang += rv.spd * dt
        const rx = cx + Math.cos(rv.ang) * rv.r
        const rz = cz + Math.sin(rv.ang) * rv.r
        rv.g.position.set(rx, displace(rx, rz), rz)
        rv.g.rotation.y = -rv.ang + Math.PI / 2
      }
    }
  }

  /**
   * Mars-only dressing so it reads alien, not just "city minus buildings":
   * glowing monolith ruins, clusters of alien pods, and a couple of dormant
   * mech walkers standing in the dust. All static (no per-frame cost) and
   * disposed with the planet group.
   */
  private buildMarsLife(group: THREE.Group, displace: (x: number, z: number) => number) {
    const glyph = config.palette.lime
    // Leaning monolith ruins with glowing glyph bands.
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x3a1c12, roughness: 0.95, metalness: 0.05 })
    const glyphMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: glyph, emissiveIntensity: 2.4, roughness: 0.5 })
    for (let i = 0; i < 7; i++) {
      const x = randRange(-150, 150)
      const z = randRange(-150, 150)
      if (Math.hypot(x, z) < 24) continue
      const y = displace(x, z)
      const h = randRange(8, 20)
      const mono = new THREE.Mesh(new THREE.BoxGeometry(randRange(2, 4), h, randRange(2, 4)), stoneMat)
      mono.position.set(x, y + h / 2, z)
      mono.rotation.set(randRange(-0.12, 0.12), randRange(0, 6.28), randRange(-0.12, 0.12))
      mono.castShadow = true
      mono.receiveShadow = true
      group.add(mono)
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.6, h * 0.5, 0.2), glyphMat)
      band.position.set(x, y + h * 0.55, z + 1.1)
      band.rotation.copy(mono.rotation)
      group.add(band)
    }
    // Broken ring arches half-sunk in the dust.
    for (let i = 0; i < 3; i++) {
      const x = randRange(-130, 130)
      const z = randRange(-130, 130)
      if (Math.hypot(x, z) < 24) continue
      const y = displace(x, z)
      const arch = new THREE.Mesh(new THREE.TorusGeometry(6, 0.6, 10, 28, Math.PI * 1.3), new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.orange, emissiveIntensity: 1.8, roughness: 0.5 }))
      arch.position.set(x, y + 2, z)
      arch.rotation.set(Math.PI / 2 + randRange(-0.2, 0.2), 0, randRange(0, 6.28))
      group.add(arch)
    }
    // Clusters of glowing alien pods.
    const podMat = new THREE.MeshStandardMaterial({ color: 0x0b2a1c, emissive: 0x2bff8a, emissiveIntensity: 1.6, roughness: 0.4, metalness: 0.2 })
    for (let c = 0; c < 3; c++) {
      const cx = randRange(-120, 120)
      const cz = randRange(-120, 120)
      if (Math.hypot(cx, cz) < 24) continue
      for (let i = 0; i < 5; i++) {
        const px = cx + randRange(-4, 4)
        const pz = cz + randRange(-4, 4)
        const pod = new THREE.Mesh(new THREE.SphereGeometry(randRange(0.7, 1.3), 12, 10), podMat)
        pod.scale.y = 1.4
        pod.position.set(px, displace(px, pz) + 0.8, pz)
        pod.castShadow = true
        group.add(pod)
      }
    }
    // Dormant mech walkers as scenery (static - no behavior, just presence).
    for (let i = 0; i < 2; i++) {
      const mech = createMech(config.palette.orange)
      const x = randRange(-90, 90)
      const z = randRange(-90, 90)
      mech.group.position.set(x, displace(x, z), z)
      mech.group.rotation.y = randRange(0, 6.28)
      group.add(mech.group)
    }

    // A crashed derelict ship half-buried in the dust.
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x4a4f5a, metalness: 0.7, roughness: 0.5 })
    const dx = randRange(-100, 100)
    const dz = randRange(-100, 100)
    const dy = displace(dx, dz)
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 16, 12), hullMat)
    hull.position.set(dx, dy + 1.5, dz)
    hull.rotation.set(0.5, randRange(0, 6.28), 0.3)
    hull.castShadow = true
    group.add(hull)
    const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.5, 4), hullMat)
    wing.position.set(dx + 2, dy + 3, dz)
    wing.rotation.set(0.5, 0, 0.6)
    group.add(wing)
    const portMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.cyan, emissiveIntensity: 2, roughness: 0.4 })
    const port = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), portMat)
    port.position.set(dx, dy + 2, dz + 7)
    group.add(port)
  }

  private buildMoon(): PlanetEnv {
    const craters: Array<[number, number, number, number]> = []
    let seed = 1234
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
    for (let i = 0; i < 14; i++) craters.push([randRange(-160, 160), randRange(-160, 160), randRange(12, 34), randRange(2.5, 6)])
    const displace = (x: number, z: number) => {
      const rad = Math.hypot(x, z)
      const hill = Math.min(1, Math.max(0, (rad - 34) / 64))
      let y = Math.sin(x * 0.012) * 1.4 + Math.cos(z * 0.015) * 1.4
      // Big rolling regolith hills further out, masked flat near the spawn pad.
      y += hill * (Math.sin(x * 0.006 - 0.4) * 11 + Math.cos(z * 0.0072 + 1.1) * 10 + Math.sin((x + z) * 0.0049) * 6)
      for (const [cx, cz, r, d] of craters) {
        const dist = Math.hypot(x - cx, z - cz)
        if (dist < r * 1.25) {
          const t = dist / r
          if (t < 1) y -= d * (1 - t * t) // bowl
          else y += d * 0.5 * (1.25 - t) * 4 // rim
        }
      }
      return y
    }
    const group = new THREE.Group()
    const terrain = this.makeTerrain(displace, 0x6a6a73, 1.0)
    group.add(terrain)
    this.celestial(group, 0x3a6ea5, new THREE.Vector3(200, 150, -300), 26, false) // distant Earth
    void rnd

    const portals = [
      this.makePortal('earth', config.palette.lime, new THREE.Vector3(-8, 0, 0)),
      this.makePortal('mars', config.palette.orange, new THREE.Vector3(8, 0, 0)),
    ]
    for (const p of portals) {
      p.group.position.y = displace(p.position.x, p.position.z)
      group.add(p.group)
    }

    const drones = this.buildMiningDrones(group, displace)
    const env: PlanetEnv = {
      group,
      groundMeshes: [terrain],
      colliders: [],
      solidMeshes: [terrain],
      spawn: new THREE.Vector3(0, displace(0, 0) + 1, -10),
      portals,
      update: (dt) => { portals.forEach((p) => p.update(dt)); drones(dt) },
      dispose: () => disposePlanet(group),
    }
    this.addBoundary(env.colliders)
    this.scatterRocks(group, env, displace, 0x55555c, 22)
    // Launch ramps over the regolith hills - low gravity makes these huge hops.
    this.addRamps(group, env, displace, config.palette.cyan, [
      [-24, -32, 0.2, 12, 22, 7],
      [38, -18, -Math.PI * 0.5, 11, 20, 6],
      [-52, 44, Math.PI * 0.7, 13, 24, 8],
      [60, 54, Math.PI * 1.15, 12, 24, 8],
      [-8, 78, Math.PI, 14, 26, 9],
    ])
    const base = this.buildMoonBase(group, env, displace, 44, 30)
    const dc = this.buildMoonDataCenter(group, env, displace, 0, 34)
    const baseUpdate = env.update
    env.update = (dt) => { baseUpdate(dt); base(dt); dc(dt) }
    return env
  }

  /**
   * Moon data-centre construction site: rows of server racks (some finished and
   * humming, some still under scaffolding), a sliding gantry crane, and builder
   * robots welding away. This is where the robots are "building data centres" -
   * and the spaceport rockets nearby carry on to Mars. Returns an animate fn.
   */
  private buildMoonDataCenter(group: THREE.Group, env: PlanetEnv, displace: (x: number, z: number) => number, cx: number, cz: number): (dt: number) => void {
    const by = displace(cx, cz)
    const site = new THREE.Group()
    site.position.set(cx, by, cz)
    group.add(site)
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x23262e, metalness: 0.5, roughness: 0.7 })
    const rackMat = new THREE.MeshStandardMaterial({ color: 0x161a22, metalness: 0.7, roughness: 0.4 })
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xffb14a, metalness: 0.5, roughness: 0.5 }) // scaffold
    const lit = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x49f2c0, emissiveIntensity: 2.4, roughness: 0.4 })
    const rackLights: THREE.MeshStandardMaterial[] = []

    // Foundation slab.
    const slab = new THREE.Mesh(new THREE.BoxGeometry(46, 0.6, 34), slabMat)
    slab.position.set(0, 0.3, 0); slab.receiveShadow = true
    site.add(slab)
    env.colliders.push(new THREE.Box3(new THREE.Vector3(cx - 23, by - 1, cz - 17), new THREE.Vector3(cx + 23, by + 0.9, cz + 17)))

    // Grid of server racks. Front rows finished + humming; the back row is still
    // going up (shorter, wrapped in scaffolding).
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 5; col++) {
        const rx = -18 + col * 9
        const rz = -11 + row * 11
        const building = row === 2 // back row under construction
        const h = building ? 1.6 + (col % 3) * 0.7 : 5.5
        const rack = new THREE.Mesh(new THREE.BoxGeometry(4, h, 6), rackMat)
        rack.position.set(rx, 0.6 + h / 2, rz); rack.castShadow = true
        site.add(rack)
        if (!building) {
          // Glowing indicator columns on the finished racks.
          for (const sx of [-1.2, 1.2]) {
            const strip = new THREE.Mesh(new THREE.BoxGeometry(0.4, h * 0.86, 0.2), lit.clone())
            strip.position.set(rx + sx, 0.6 + h / 2, rz + 3.05)
            site.add(strip)
            rackLights.push(strip.material as THREE.MeshStandardMaterial)
          }
        } else {
          // Scaffold cage around the half-built rack.
          for (const sx of [-2.2, 2.2]) for (const sz of [-3.2, 3.2]) {
            const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 6, 0.2), frameMat)
            post.position.set(rx + sx, 3.6, rz + sz); site.add(post)
          }
          for (const yy of [2.4, 5.2]) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.15, 0.15), frameMat)
            bar.position.set(rx, 0.6 + yy, rz + 3.2); site.add(bar)
          }
        }
      }
    }

    // Gantry crane spanning the build row, hook sliding back and forth.
    for (const sx of [-22, 22]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.8, 13, 0.8), slabMat)
      leg.position.set(sx, 7, 11); site.add(leg)
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(46, 0.8, 1), slabMat)
    beam.position.set(0, 13, 11); site.add(beam)
    const hook = new THREE.Group()
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5, 6), frameMat)
    cable.position.y = -2.5; hook.add(cable)
    const load = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 3), rackMat)
    load.position.y = -5.5; hook.add(load)
    hook.position.set(0, 13, 11); site.add(hook)

    // Builder robots welding at the construction row (torso + head + spark).
    const builders: { g: THREE.Group; spark: THREE.MeshStandardMaterial; phase: number; baseY: number }[] = []
    const botMat = new THREE.MeshStandardMaterial({ color: config.palette.robot, metalness: 0.7, roughness: 0.4 })
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group()
      const rx = -18 + (i % 5) * 9 + 3
      const baseY = 0.6
      g.position.set(rx, baseY, 6.5)
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.5), botMat)
      torso.position.y = 0.9; torso.castShadow = true; g.add(torso)
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), botMat)
      head.position.y = 1.6; g.add(head)
      const sparkMat = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0xfff0b0, emissiveIntensity: 0 })
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), sparkMat)
      spark.position.set(0, 1.0, 0.6); g.add(spark)
      site.add(g)
      builders.push({ g, spark: sparkMat, phase: Math.random() * 6, baseY })
    }

    let t = 0
    return (dt: number) => {
      t += dt
      for (let i = 0; i < rackLights.length; i++) rackLights[i].emissiveIntensity = 1.6 + Math.sin(t * 4 + i * 0.7) * 1.0
      hook.position.x = Math.sin(t * 0.4) * 16
      load.position.y = -5.5 + Math.sin(t * 0.9) * 0.6
      for (const b of builders) {
        // Crouch/weld bob + a flickering torch spark.
        b.g.position.y = b.baseY + Math.abs(Math.sin(t * 4 + b.phase)) * 0.12
        b.spark.emissiveIntensity = Math.random() < 0.5 ? 2.6 + Math.random() * 2 : 0
      }
    }
  }

  /**
   * Moon research base: a cluster of glowing habitat domes linked by tubes, a
   * comms dish, a lit landing pad, blinking perimeter lights, and a couple of
   * rovers trundling a patrol loop. Returns an animate fn for the rovers/lights.
   */
  private buildMoonBase(group: THREE.Group, env: PlanetEnv, displace: (x: number, z: number) => number, bx: number, bz: number): (dt: number) => void {
    const by = displace(bx, bz)
    const shell = new THREE.MeshStandardMaterial({ color: 0xb8c2d0, metalness: 0.6, roughness: 0.5 })
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a3340, metalness: 0.6, roughness: 0.5 })
    const glow = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x7fd7ff, emissiveIntensity: 2.4, roughness: 0.4 })
    const domeGeo = new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)
    const domes: Array<[number, number, number]> = [[0, 0, 6], [10, 4, 4.4], [-8, 6, 3.6]]
    for (const [dx, dz, r] of domes) {
      const dome = new THREE.Mesh(domeGeo, shell)
      dome.scale.set(r, r * 0.8, r); dome.position.set(bx + dx, by, bz + dz); dome.castShadow = true
      group.add(dome)
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.7, 0.18, 8, 24), glow)
      ring.rotation.x = Math.PI / 2; ring.position.set(bx + dx, by + r * 0.35, bz + dz)
      group.add(ring)
      env.colliders.push(new THREE.Box3(new THREE.Vector3(bx + dx - r, by - 1, bz + dz - r), new THREE.Vector3(bx + dx + r, by + r, bz + dz + r)))
    }
    // Connecting tube between the two main domes.
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 11, 10), shell)
    tube.rotation.z = Math.PI / 2; tube.position.set(bx + 5, by + 1.2, bz + 2)
    group.add(tube)
    // Comms dish on a mast.
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 10, 8), dark)
    mast.position.set(bx - 8, by + 5, bz - 4); group.add(mast)
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(3, 0.4, 1.2, 14, 1, true), shell)
    dish.rotation.set(Math.PI / 2 + 0.5, 0, 0); dish.position.set(bx - 8, by + 10, bz - 4); group.add(dish)
    // Lit landing pad.
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.4, 0.3, 28), new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x7fd7ff, emissiveIntensity: 1.6, roughness: 0.5 }))
    pad.position.set(bx + 2, by + 0.2, bz - 14); group.add(pad)

    // Blinking perimeter lights.
    const lights: THREE.MeshStandardMaterial[] = []
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const m = new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0xff8a1e, emissiveIntensity: 2 })
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2, 0.4), m)
      post.position.set(bx + Math.cos(a) * 16, by + 1, bz + Math.sin(a) * 16)
      group.add(post); lights.push(m)
    }

    // Two rovers patrolling a loop around the base.
    const rovers: { g: THREE.Group; ang: number; spd: number; r: number }[] = []
    for (let i = 0; i < 2; i++) {
      const rv = new THREE.Group()
      const body = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 2), dark)
      body.position.y = 0.9; rv.add(body)
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.9, 1.6), glow)
      cab.position.set(-0.4, 1.7, 0); rv.add(cab)
      for (const wx of [-1, 1]) for (const wz of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 10), shell)
        w.rotation.x = Math.PI / 2; w.position.set(wx * 1.1, 0.5, wz * 0.9); rv.add(w)
      }
      group.add(rv)
      rovers.push({ g: rv, ang: i * Math.PI, spd: 0.12 + i * 0.03, r: 22 + i * 6 })
    }

    let t = 0
    return (dt: number) => {
      t += dt
      for (let i = 0; i < lights.length; i++) lights[i].emissiveIntensity = 1.2 + Math.sin(t * 3 + i) * 1.2
      for (const rv of rovers) {
        rv.ang += rv.spd * dt
        const rx = bx + Math.cos(rv.ang) * rv.r
        const rz = bz + Math.sin(rv.ang) * rv.r
        rv.g.position.set(rx, displace(rx, rz), rz)
        rv.g.rotation.y = -rv.ang + Math.PI / 2
      }
    }
  }

  dispose() {
    for (const p of this.earthPortals) disposePlanet(p.group)
    this.mars?.dispose()
    this.moon?.dispose()
  }
}

/** Triangular-prism launch ramp, centred on Z (-len/2..len/2), base at y=0 rising
 *  to height h at the +Z end. Non-indexed so each flat face keeps its own normal
 *  (the ground raycast reads the slope for vehicle pitch). DoubleSide material, so
 *  winding doesn't matter for visibility. */
function makeWedge(w: number, len: number, h: number): THREE.BufferGeometry {
  const x = w / 2, L = len / 2
  // Corners: A/B front-bottom, C/D back-bottom, E/F back-top.
  const A = [-x, 0, -L], B = [x, 0, -L], C = [-x, 0, L], D = [x, 0, L], E = [-x, h, L], F = [x, h, L]
  const tris = [
    A, B, F, A, F, E, // top slope
    A, C, D, A, D, B, // bottom
    C, E, F, C, F, D, // back
    A, E, C, // left
    B, F, D, // right
  ]
  const pos = new Float32Array(tris.length * 3)
  for (let i = 0; i < tris.length; i++) { pos[i * 3] = tris[i][0]; pos[i * 3 + 1] = tris[i][1]; pos[i * 3 + 2] = tris[i][2] }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.computeVertexNormals()
  return geo
}

function disposePlanet(group: THREE.Group) {
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose())
  })
}
