import * as THREE from 'three'
import { config } from './config'
import { createMech, createDrone } from './procedural'
import { randRange } from './utils'
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
  readonly mars: PlanetEnv
  readonly moon: PlanetEnv

  private scene: THREE.Scene
  private earthPortalGroup = new THREE.Group()

  constructor(scene: THREE.Scene) {
    this.scene = scene

    // Well-separated gateways flanking the plaza (clear of the arcade row at
    // x -33..33) so each portal has breathing room and its own focal point.
    this.earthPortals.push(this.makePortal('mars', config.palette.orange, new THREE.Vector3(-46, 0, 6)))
    this.earthPortals.push(this.makePortal('moon', 0xbfe6ff, new THREE.Vector3(46, 0, 6)))
    for (const p of this.earthPortals) this.earthPortalGroup.add(p.group)
    // Planet/moon travel is its own thing, separate from the arcade: these ring
    // portals are how you leave Earth for another world.
    scene.add(this.earthPortalGroup)

    this.mars = this.buildMars()
    this.moon = this.buildMoon()
    this.mars.group.visible = false
    this.moon.group.visible = false
    scene.add(this.mars.group, this.moon.group)
  }

  env(zone: Zone): PlanetEnv | null {
    return zone === 'mars' ? this.mars : zone === 'moon' ? this.moon : null
  }
  portalsFor(zone: Zone): Portal[] {
    return zone === 'earth' ? this.earthPortals : this.env(zone)!.portals
  }

  setActive(zone: Zone) {
    this.earthPortalGroup.visible = zone === 'earth'
    this.mars.group.visible = zone === 'mars'
    this.moon.group.visible = zone === 'moon'
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
      let y = Math.sin(x * 0.018) * 3 + Math.cos(z * 0.022) * 2.6 + Math.sin((x + z) * 0.04) * 1.4
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
    this.buildMarsLife(group, displace)
    return env
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
      let y = Math.sin(x * 0.012) * 1.4 + Math.cos(z * 0.015) * 1.4
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
    const base = this.buildMoonBase(group, env, displace, 44, 30)
    const baseUpdate = env.update
    env.update = (dt) => { baseUpdate(dt); base(dt) }
    return env
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
    this.mars.dispose()
    this.moon.dispose()
  }
}

function disposePlanet(group: THREE.Group) {
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose())
  })
}
