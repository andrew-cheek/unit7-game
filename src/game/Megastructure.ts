import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the megastructure stays pinned to the horizon as you move. */
  focus: () => THREE.Vector3
}

/**
 * Off-world horizon set-dressing for awe and scale. On Mars a towering SPACE
 * ELEVATOR (a tapering tether climbing from far across the surface up past the
 * sky, with beacon lights and a slow climber car); on the Moon a vast ORBITAL
 * RING arcing overhead with running lights. Far, huge, no colliders; the active
 * sub-group is offset by the player focus each frame so it reads as distant.
 *
 * Draw-call budget: each sub-group's static structure is merged into one mesh,
 * and the many repeated beacon/ring lights are drawn as a single InstancedMesh.
 * Per-light animation that was opacity-based now drives per-instance color
 * (additive blending makes a brightness ramp read identically), so it costs no
 * extra draw calls and allocates nothing per frame.
 */
export class Megastructure implements GameSystem {
  private group = new THREE.Group()
  private marsGroup = new THREE.Group()
  private moonGroup = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'
  private t = 0

  // Animated bits (no per-frame allocation).
  private climber: THREE.Mesh
  private marsBeacons: THREE.InstancedMesh
  private marsBeaconN: number
  private readonly marsBeaconBase: THREE.Color
  private ringLights: THREE.InstancedMesh
  private ringLightN: number
  private readonly ringLightBase: THREE.Color

  // Scratch color reused for per-instance brightness writes (no per-frame alloc).
  private readonly scratchColor = new THREE.Color()

  // Anchor offsets so we can keep great distance while tracking the focus XZ.
  private readonly marsBase = new THREE.Vector3(-340, 0, -260)
  private readonly moonBase = new THREE.Vector3(0, 0, -120)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'

    // ---- Mars: space elevator -------------------------------------------------
    const tetherH = 1400
    const warm = 0xffcaa0

    // Static structure (tether + anchor) merged into one mesh. The two parts
    // had distinct base colors, so bake those into vertex colors and use one
    // vertex-coloured material — identical visuals, a single draw call.
    const tetherGeo = this.ownG(new THREE.CylinderGeometry(1.2, 5.5, tetherH, 8, 1, true))
    tetherGeo.translate(0, tetherH / 2, 0)
    paintGeometry(tetherGeo, 0x8a6a52)

    const anchorGeo = new THREE.SphereGeometry(22, 12, 10)
    anchorGeo.scale(1, 0.5, 1)
    anchorGeo.translate(0, tetherH, 0)
    paintGeometry(anchorGeo, 0x6a5040)

    const marsStaticGeo = this.ownG(mergeGeometries([tetherGeo, anchorGeo], false))
    anchorGeo.dispose() // consumed by the merge; tetherGeo is owned for disposal
    const marsStaticMat = this.own(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }))
    this.marsGroup.add(new THREE.Mesh(marsStaticGeo, marsStaticMat))

    // Beacons: one InstancedMesh, per-instance color drives the running wave.
    const beaconGeo = this.ownG(new THREE.SphereGeometry(3.2, 8, 6))
    this.marsBeaconN = low ? 6 : 10
    this.marsBeaconBase = new THREE.Color(warm)
    const beaconMat = this.own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.marsBeacons = new THREE.InstancedMesh(beaconGeo, beaconMat, this.marsBeaconN)
    this.marsBeacons.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    {
      const m = new THREE.Matrix4()
      for (let i = 0; i < this.marsBeaconN; i++) {
        m.makeTranslation(0, (i / (this.marsBeaconN - 1)) * tetherH, 0)
        this.marsBeacons.setMatrixAt(i, m)
        this.marsBeacons.setColorAt(i, this.marsBeaconBase)
      }
    }
    this.marsBeacons.instanceMatrix.needsUpdate = true
    this.marsGroup.add(this.marsBeacons)

    // Climber car that slides up and down the tether (animated each frame).
    const climberMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffe6b0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const climberGeo = this.ownG(new THREE.BoxGeometry(14, 18, 14))
    this.climber = new THREE.Mesh(climberGeo, climberMat)
    this.climber.position.y = 80
    this.marsGroup.add(this.climber)

    // ---- Moon: orbital ring ---------------------------------------------------
    const ringR = 900
    const ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fd8ff, fog: false }))
    const ringGeo = this.ownG(new THREE.TorusGeometry(ringR, 7, 8, 96))
    const ring = new THREE.Mesh(ringGeo, ringMat)
    // Tilt the ring so a great arc sweeps high across the sky, the rest below the horizon.
    ring.rotation.x = Math.PI * 0.5 + 0.32
    ring.position.y = -ringR * 0.55
    this.moonGroup.add(ring)

    // Running lights: one InstancedMesh parented to the ring so it inherits the
    // ring's tilt exactly as the individual light meshes used to. Per-instance
    // color drives the chase.
    const lightGeo = this.ownG(new THREE.SphereGeometry(11, 8, 6))
    this.ringLightN = low ? 24 : 48
    this.ringLightBase = new THREE.Color(0xeafcff)
    const lightMat = this.own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.ringLights = new THREE.InstancedMesh(lightGeo, lightMat, this.ringLightN)
    this.ringLights.instanceMatrix.setUsage(THREE.StaticDrawUsage)
    {
      const m = new THREE.Matrix4()
      for (let i = 0; i < this.ringLightN; i++) {
        const a = (i / this.ringLightN) * Math.PI * 2
        // Place around the torus ring (in the ring's local space, pre-tilt).
        m.makeTranslation(Math.cos(a) * ringR, Math.sin(a) * ringR, 0)
        this.ringLights.setMatrixAt(i, m)
        this.ringLights.setColorAt(i, this.ringLightBase)
      }
    }
    this.ringLights.instanceMatrix.needsUpdate = true
    ring.add(this.ringLights)

    this.group.add(this.marsGroup, this.moonGroup)
    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) { this.zone = zone }

  update(dt: number) {
    // Drive visibility from the zone each frame (setZone only fires on a change,
    // and the game begins on Earth where this must be hidden).
    const active = this.zone === 'moon' || this.zone === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return
    this.marsGroup.visible = this.zone === 'mars'
    this.moonGroup.visible = this.zone === 'moon'

    this.t += dt
    const f = this.deps.focus()

    if (this.zone === 'mars') {
      // Keep its great distance while tracking the player so it stays on the horizon.
      this.marsGroup.position.set(f.x + this.marsBase.x, this.marsBase.y, f.z + this.marsBase.z)
      // Beacons pulse in a running wave up the tether. Additive blending makes a
      // brightness ramp read the same as the old per-mesh opacity ramp.
      for (let i = 0; i < this.marsBeaconN; i++) {
        const o = 0.4 + 0.5 * (0.5 + 0.5 * Math.sin(this.t * 2 - i * 0.6))
        this.scratchColor.copy(this.marsBeaconBase).multiplyScalar(0.9 * o)
        this.marsBeacons.setColorAt(i, this.scratchColor)
      }
      if (this.marsBeacons.instanceColor) this.marsBeacons.instanceColor.needsUpdate = true
      // Climber slides slowly up and back down the full tether height.
      const tetherH = 1400
      this.climber.position.y = (0.5 + 0.5 * Math.sin(this.t * 0.07)) * tetherH
    } else {
      this.moonGroup.position.set(f.x + this.moonBase.x, this.moonBase.y, f.z + this.moonBase.z)
      // Running lights chase around the ring.
      for (let i = 0; i < this.ringLightN; i++) {
        const o = 0.25 + 0.65 * (0.5 + 0.5 * Math.sin(this.t * 3 - i * 0.5))
        this.scratchColor.copy(this.ringLightBase).multiplyScalar(0.9 * o)
        this.ringLights.setColorAt(i, this.scratchColor)
      }
      if (this.ringLights.instanceColor) this.ringLights.instanceColor.needsUpdate = true
    }
  }

  dispose() {
    this.marsBeacons.dispose()
    this.ringLights.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}

/** Bake a flat color into a geometry's vertex colors so it can be merged with
 *  differently-coloured static parts under a single vertex-coloured material. */
function paintGeometry(geo: THREE.BufferGeometry, color: number) {
  const c = new THREE.Color(color)
  const count = geo.attributes.position.count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}
