import * as THREE from 'three'
import { config } from './config'
import { createMech } from './procedural'
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

    this.earthPortals.push(this.makePortal('mars', config.palette.orange, new THREE.Vector3(-18, 0, -20)))
    this.earthPortals.push(this.makePortal('moon', 0xbfe6ff, new THREE.Vector3(18, 0, -20)))
    for (const p of this.earthPortals) this.earthPortalGroup.add(p.group)
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

    let t = 0
    return {
      group,
      position: new THREE.Vector3(pos.x, 0, pos.z),
      radius: 3.2,
      target,
      update: (dt) => {
        t += dt
        disc.rotation.z += dt * 0.7
        ringMat.emissiveIntensity = 1.8 + Math.sin(t * 3) * 0.5
        discMat.opacity = 0.22 + Math.sin(t * 2) * 0.1
      },
    }
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

    const env: PlanetEnv = {
      group,
      groundMeshes: [terrain],
      colliders: [],
      solidMeshes: [terrain],
      spawn: new THREE.Vector3(0, displace(0, 0) + 1, -10),
      portals,
      update: (dt) => portals.forEach((p) => p.update(dt)),
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

    const env: PlanetEnv = {
      group,
      groundMeshes: [terrain],
      colliders: [],
      solidMeshes: [terrain],
      spawn: new THREE.Vector3(0, displace(0, 0) + 1, -10),
      portals,
      update: (dt) => portals.forEach((p) => p.update(dt)),
      dispose: () => disposePlanet(group),
    }
    this.addBoundary(env.colliders)
    this.scatterRocks(group, env, displace, 0x55555c, 22)
    return env
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
