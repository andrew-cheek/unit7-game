import * as THREE from 'three'
import { config } from './config'

/**
 * Living-skyline spectacle for the Earth roam: a colossal slowly-rotating
 * holographic globe + orbiting rings high over the city centre (with a beam
 * pillar grounding it), sweeping rooftop searchlights, and ad-blimps drifting
 * the skyline. Pure set dressing - no colliders, no gameplay. Visible on Earth
 * only; everything is pooled and disposed together.
 */
export class CitySpectacle {
  readonly group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private t = 0

  private holo!: THREE.Object3D
  private core!: THREE.Mesh
  private rings: THREE.Object3D[] = []
  private lights: { cone: THREE.Mesh; base: THREE.Vector3; ph: number; sp: number }[] = []
  private blimps: { g: THREE.Group; a: number; r: number; h: number; sp: number }[] = []

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene) {
    const low = config.tier.name === 'low'
    this.buildHologram()
    this.buildSearchlights(low ? 2 : 6)
    this.buildBlimps(low ? 1 : 2)
    scene.add(this.group)
  }

  /** A giant wireframe globe with orbiting neon rings, hung high over the city on
   *  a translucent light pillar - the unmistakable centre-of-town landmark. */
  private buildHologram() {
    const cx = 0, cy = 124, cz = 10
    const holo = new THREE.Group(); holo.position.set(cx, cy, cz)
    const globe = new THREE.Mesh(
      this.ownG(new THREE.IcosahedronGeometry(28, 2)),
      this.own(new THREE.MeshBasicMaterial({ color: 0x3df0ff, wireframe: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })),
    )
    holo.add(globe)
    const innerMat = this.own(new THREE.MeshBasicMaterial({ color: 0x1a6cff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    holo.add(new THREE.Mesh(this.ownG(new THREE.SphereGeometry(25, 24, 18)), innerMat))
    // Bright pulsing core (the eye-catch).
    this.core = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(5, 16, 12)), this.own(new THREE.MeshBasicMaterial({ color: 0xeaffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    holo.add(this.core)
    // Orbiting rings at varied tilts.
    const ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const ringMat2 = this.own(new THREE.MeshBasicMaterial({ color: 0x9b6bff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(34 + i * 6, 0.8, 8, 90)), i === 1 ? ringMat2 : ringMat)
      ring.rotation.set(Math.PI / 2 + i * 0.5, i * 0.9, i * 0.4)
      holo.add(ring); this.rings.push(ring)
    }
    // Light pillar grounding it to the plaza.
    const pillar = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(7, 16, cy, 24, 1, true)),
      this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    )
    pillar.position.set(cx, cy / 2, cz)
    this.group.add(pillar)
    this.group.add(holo)
    this.holo = holo
  }

  /** Tall sweeping searchlight beams anchored around the city edge. */
  private buildSearchlights(n: number) {
    // LOW tier: halve the cone's radial segments and render single-sided to cut
    // overdraw/fill-rate on mobile. High/medium keep 16-seg DoubleSide beams.
    const low = config.tier.name === 'low'
    const beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0xcdeaff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: low ? THREE.FrontSide : THREE.DoubleSide, fog: false }))
    const beamGeo = this.ownG(new THREE.ConeGeometry(6, 150, low ? 8 : 16, 1, true))
    const baseMat = this.own(new THREE.MeshStandardMaterial({ color: 0x161d2e, metalness: 0.7, roughness: 0.4, emissive: 0x0c2030, emissiveIntensity: 0.5 }))
    const baseGeo = this.ownG(new THREE.CylinderGeometry(1.6, 2.2, 4, 10))
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3
      const r = 118 + (i % 2) * 22
      const bx = Math.cos(a) * r, bz = Math.sin(a) * r
      const base = new THREE.Mesh(baseGeo, baseMat); base.position.set(bx, 2, bz); this.group.add(base)
      const cone = new THREE.Mesh(beamGeo, beamMat)
      // pivot the beam from its narrow tip at the base
      cone.geometry.translate(0, 65, 0)
      cone.position.set(bx, 4, bz)
      this.group.add(cone)
      this.lights.push({ cone, base: new THREE.Vector3(bx, 4, bz), ph: i * 1.7, sp: 0.25 + (i % 3) * 0.12 })
    }
  }

  /** Ad-blimps drifting the skyline with a glowing neon banner. */
  private buildBlimps(n: number) {
    const ads = ['UNIT 7', 'NEON CITY', 'OFF-WORLD']
    const hullMat = this.own(new THREE.MeshStandardMaterial({ color: 0x20283e, metalness: 0.5, roughness: 0.5, emissive: 0x0c1830, emissiveIntensity: 0.5 }))
    const finMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.6, roughness: 0.45 }))
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group()
      const hull = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(7, 16, 12)), hullMat)
      hull.scale.set(2.4, 1, 1); g.add(hull)
      for (const s of [-1, 1]) { const fin = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(4, 0.3, 2.4)), finMat); fin.position.set(-13, 0, s * 1.5); fin.rotation.y = s * 0.4; g.add(fin) }
      const tex = this.adTexture(ads[i % ads.length]); this.texs.push(tex)
      const panel = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(20, 5)), this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide })))
      panel.position.set(0, 0, 7.2); g.add(panel)
      const gondola = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(5, 1.4, 2)), finMat); gondola.position.y = -6.5; g.add(gondola)
      this.group.add(g)
      this.blimps.push({ g, a: (i / n) * Math.PI * 2, r: 150 + i * 30, h: 62 + i * 14, sp: 0.04 + i * 0.015 })
    }
  }

  private adTexture(text: string): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, 512, 128)
    ctx.strokeStyle = '#27e7ff'; ctx.lineWidth = 4; ctx.strokeRect(6, 6, 500, 116)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#ff2bd0'; ctx.shadowBlur = 22; ctx.fillStyle = '#ff5ad6'
    ctx.font = '900 70px ui-monospace, Menlo, monospace'; ctx.fillText(text, 256, 66)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  setVisible(v: boolean) { this.group.visible = v }

  update(dt: number) {
    if (!this.group.visible) return
    this.t += dt
    this.holo.rotation.y += dt * 0.12
    const pulse = 1 + Math.sin(this.t * 2.2) * 0.18
    this.core.scale.setScalar(pulse)
    for (let i = 0; i < this.rings.length; i++) { const r = this.rings[i]; r.rotation.z += dt * (0.3 + i * 0.12) * (i % 2 ? -1 : 1); r.rotation.y += dt * 0.08 }
    for (const l of this.lights) {
      // sweep the beam around by tilting it on a slow oscillation
      const tilt = 0.5 + Math.sin(this.t * l.sp + l.ph) * 0.35
      const yaw = this.t * l.sp * 1.3 + l.ph
      l.cone.rotation.set(Math.sin(yaw) * tilt, yaw, Math.cos(yaw) * tilt)
    }
    for (const b of this.blimps) {
      b.a += b.sp * dt
      b.g.position.set(Math.cos(b.a) * b.r, b.h + Math.sin(this.t * 0.3 + b.a) * 3, Math.sin(b.a) * b.r)
      b.g.rotation.y = -b.a + Math.PI / 2
    }
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.texs.forEach((t) => t.dispose())
  }
}
