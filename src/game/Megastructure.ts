import * as THREE from 'three'
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
  private marsBeacons: THREE.Mesh[] = []
  private ringLights: THREE.Mesh[] = []

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
    const tetherMat = this.own(new THREE.MeshBasicMaterial({ color: 0x8a6a52, fog: false }))
    const tetherGeo = this.ownG(new THREE.CylinderGeometry(1.2, 5.5, tetherH, 8, 1, true))
    const tether = new THREE.Mesh(tetherGeo, tetherMat)
    tether.position.y = tetherH / 2
    this.marsGroup.add(tether)

    // High anchor station + counterweight glow far above.
    const anchorMat = this.own(new THREE.MeshBasicMaterial({ color: 0x6a5040, fog: false }))
    const anchorGeo = this.ownG(new THREE.SphereGeometry(22, 12, 10))
    const anchor = new THREE.Mesh(anchorGeo, anchorMat)
    anchor.position.y = tetherH
    anchor.scale.set(1, 0.5, 1)
    this.marsGroup.add(anchor)

    const beaconGeo = this.ownG(new THREE.SphereGeometry(3.2, 8, 6))
    const beaconN = low ? 6 : 10
    for (let i = 0; i < beaconN; i++) {
      // Per-beacon material so the running-wave opacity can vary along the tether.
      const beaconMat = this.own(new THREE.MeshBasicMaterial({ color: warm, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const b = new THREE.Mesh(beaconGeo, beaconMat)
      b.position.y = (i / (beaconN - 1)) * tetherH
      this.marsBeacons.push(b)
      this.marsGroup.add(b)
    }

    // Climber car that slides up and down the tether.
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

    const lightGeo = this.ownG(new THREE.SphereGeometry(11, 8, 6))
    const lightN = low ? 24 : 48
    for (let i = 0; i < lightN; i++) {
      const a = (i / lightN) * Math.PI * 2
      // Per-light material so the chase opacity can vary around the ring.
      const lightMat = this.own(new THREE.MeshBasicMaterial({ color: 0xeafcff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const l = new THREE.Mesh(lightGeo, lightMat)
      // Place around the torus ring before the group rotation is applied.
      l.position.set(Math.cos(a) * ringR, Math.sin(a) * ringR, 0)
      this.ringLights.push(l)
      ring.add(l)
    }

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
      // Beacons pulse in a running wave up the tether.
      for (let i = 0; i < this.marsBeacons.length; i++) {
        const m = this.marsBeacons[i].material as THREE.MeshBasicMaterial
        m.opacity = 0.4 + 0.5 * (0.5 + 0.5 * Math.sin(this.t * 2 - i * 0.6))
      }
      // Climber slides slowly up and back down the full tether height.
      const tetherH = 1400
      this.climber.position.y = (0.5 + 0.5 * Math.sin(this.t * 0.07)) * tetherH
    } else {
      this.moonGroup.position.set(f.x + this.moonBase.x, this.moonBase.y, f.z + this.moonBase.z)
      // Running lights chase around the ring.
      for (let i = 0; i < this.ringLights.length; i++) {
        const m = this.ringLights[i].material as THREE.MeshBasicMaterial
        m.opacity = 0.25 + 0.65 * (0.5 + 0.5 * Math.sin(this.t * 3 - i * 0.5))
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
