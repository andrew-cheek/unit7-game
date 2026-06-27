import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the creatures roam the sky around wherever you are. */
  focus: () => THREE.Vector3
}

interface Leviathan {
  group: THREE.Group
  segs: THREE.Mesh[]
  finL: THREE.Object3D
  finR: THREE.Object3D
  baseSeg: number[] // resting z of each segment along the spine
  angle: number // position around its slow orbit
  radius: number
  height: number
  speed: number
  phase: number
  amp: number
}

/**
 * Earth-roam spectacle: a couple of colossal, translucent bio-luminescent
 * "sky leviathans" that drift high over the neon city, their segmented bodies
 * undulating as they swim and their wing-fins slowly beating. Pure atmosphere -
 * additive, no colliders, way up out of reach - that gives the skyline a sense of
 * living scale. Pooled + Earth-gated; everything is disposed together.
 */
export class SkyLeviathans implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private bodies: Leviathan[] = []
  private zone: Zone = 'earth'
  private t = 0

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const count = low ? 1 : 2
    const segN = low ? 6 : 10
    const tints = [0x3fd8ff, 0xb07cff]

    const bodyGeo = this.ownG(new THREE.SphereGeometry(1, 12, 10))
    const finGeo = this.ownG(new THREE.PlaneGeometry(1, 1))
    for (let i = 0; i < count; i++) {
      const tint = tints[i % tints.length]
      // Body uses normal blending so it reads as a translucent form against the
      // bright daytime sky too; the core + fins add an additive bio-luminescence.
      const bodyMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.5, depthWrite: false, fog: false }))
      const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fe9ff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const finMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.32, depthWrite: false, fog: false, side: THREE.DoubleSide }))
      const group = new THREE.Group()
      const segs: THREE.Mesh[] = []
      const baseSeg: number[] = []
      const len = 60 // body length
      for (let s = 0; s < segN; s++) {
        const f = s / (segN - 1) // 0 head .. 1 tail
        // Taper: fat near the head, thin to the tail.
        const r = (1 - f) * 5 + 1.2
        const seg = new THREE.Mesh(bodyGeo, bodyMat)
        seg.scale.set(r, r * 0.7, r * 1.2)
        const z = (0.5 - f) * len
        seg.position.set(0, 0, z)
        group.add(seg); segs.push(seg); baseSeg.push(z)
        // A brighter belly-light core inside the front segments.
        if (s < segN * 0.5) { const core = new THREE.Mesh(bodyGeo, coreMat); core.scale.setScalar(r * 0.28); seg.add(core) }
      }
      // Big translucent wing-fins midway down the body.
      const finL = new THREE.Mesh(finGeo, finMat); finL.scale.set(26, 16, 1); finL.position.set(-8, 0, 6); finL.rotation.set(-Math.PI / 2, 0, 0.3)
      const finR = new THREE.Mesh(finGeo, finMat); finR.scale.set(26, 16, 1); finR.position.set(8, 0, 6); finR.rotation.set(-Math.PI / 2, 0, -0.3)
      group.add(finL, finR)

      this.group.add(group)
      this.bodies.push({
        group, segs, finL, finR, baseSeg,
        angle: (i / count) * Math.PI * 2,
        radius: 180 + i * 70,
        height: 95 + i * 26,
        speed: (0.05 + i * 0.015) * (i % 2 ? -1 : 1),
        phase: i * 2,
        amp: 6 + i * 2,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()
    for (const b of this.bodies) {
      b.angle += b.speed * dt
      // Drift in a slow orbit centred on the player, high in the sky.
      const cx = f.x + Math.cos(b.angle) * b.radius
      const cz = f.z + Math.sin(b.angle) * b.radius
      b.group.position.set(cx, b.height + Math.sin(this.t * 0.3 + b.phase) * 6, cz)
      // Face along the direction of travel (tangent to the orbit).
      b.group.rotation.y = -b.angle + (b.speed > 0 ? Math.PI / 2 : -Math.PI / 2)
      // Swim: an S-wave runs down the spine, stronger toward the tail.
      for (let s = 0; s < b.segs.length; s++) {
        const fr = s / (b.segs.length - 1)
        b.segs[s].position.x = Math.sin(this.t * 1.4 + b.phase - s * 0.55) * b.amp * fr
        b.segs[s].position.y = Math.cos(this.t * 1.1 + b.phase - s * 0.4) * b.amp * 0.3 * fr
      }
      // Fins beat slowly.
      const beat = Math.sin(this.t * 0.9 + b.phase) * 0.35
      b.finL.rotation.z = 0.3 + beat
      b.finR.rotation.z = -0.3 - beat
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
