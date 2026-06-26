import * as THREE from 'three'

/**
 * A one-shot landing celebration burst: an expanding shockwave ring, a fountain
 * of sparks, a ground flash disc and a quick light pillar. Pooled and reused -
 * trigger() places it and replays the animation, update() advances it. Used so
 * EVERY drop-in touchdown reads as an arrival, wherever you come down.
 */
export class LandingFx {
  private group = new THREE.Group()
  private ring: THREE.Mesh
  private ringMat: THREE.MeshBasicMaterial
  private disc: THREE.Mesh
  private discMat: THREE.MeshBasicMaterial
  private pillar: THREE.Mesh
  private pillarMat: THREE.MeshBasicMaterial
  private sparks: THREE.Points
  private sparkMat: THREE.PointsMaterial
  private sparkPos: Float32Array
  private sparkVel: Float32Array
  private n: number
  private t = 999 // >= dur = idle
  private readonly dur = 1.6
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  constructor(scene: THREE.Scene, lowTier: boolean) {
    const own = <T extends THREE.Material>(m: T) => { this.mats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(g: T) => { this.geos.push(g); return g }
    const flat = { transparent: true, opacity: 0, blending: THREE.AdditiveBlending as THREE.Blending, depthWrite: false, fog: false, side: THREE.DoubleSide as THREE.Side }

    this.ringMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff, ...flat }))
    this.ring = new THREE.Mesh(ownG(new THREE.TorusGeometry(1, 0.18, 8, 44)), this.ringMat)
    this.ring.rotation.x = -Math.PI / 2
    this.group.add(this.ring)

    this.discMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff, ...flat }))
    this.disc = new THREE.Mesh(ownG(new THREE.CircleGeometry(6, 36)), this.discMat)
    this.disc.rotation.x = -Math.PI / 2
    this.disc.position.y = 0.05
    this.group.add(this.disc)

    this.pillarMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff, ...flat }))
    this.pillar = new THREE.Mesh(ownG(new THREE.CylinderGeometry(2.4, 3.4, 44, 18, 1, true)), this.pillarMat)
    this.pillar.position.y = 22
    this.group.add(this.pillar)

    this.n = lowTier ? 44 : 96
    this.sparkPos = new Float32Array(this.n * 3)
    this.sparkVel = new Float32Array(this.n * 3)
    const sg = ownG(new THREE.BufferGeometry())
    sg.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3))
    this.sparkMat = own(new THREE.PointsMaterial({ color: 0xffffff, size: 0.55, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.sparks = new THREE.Points(sg, this.sparkMat)
    this.sparks.frustumCulled = false
    this.group.add(this.sparks)

    this.group.visible = false
    scene.add(this.group)
  }

  /** Replay the burst at a ground position, tinted to taste. */
  trigger(pos: THREE.Vector3, color: number) {
    this.group.position.set(pos.x, pos.y + 0.1, pos.z)
    this.t = 0
    this.group.visible = true
    this.ringMat.color.setHex(color)
    this.discMat.color.setHex(color)
    this.pillarMat.color.setHex(color)
    for (let i = 0; i < this.n; i++) {
      const a = Math.random() * Math.PI * 2
      const out = 4 + Math.random() * 15
      this.sparkPos[i * 3] = 0; this.sparkPos[i * 3 + 1] = 0.2; this.sparkPos[i * 3 + 2] = 0
      this.sparkVel[i * 3] = Math.cos(a) * out
      this.sparkVel[i * 3 + 1] = 8 + Math.random() * 17
      this.sparkVel[i * 3 + 2] = Math.sin(a) * out
    }
    ;(this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  }

  update(dt: number) {
    if (this.t >= this.dur) { if (this.group.visible) this.group.visible = false; return }
    this.t += dt
    const f = Math.min(1, this.t / this.dur)
    const rs = 1 + f * 27
    this.ring.scale.set(rs, rs, 1)
    this.ringMat.opacity = 0.9 * (1 - f)
    this.disc.scale.setScalar(1 + f * 2)
    this.discMat.opacity = 0.42 * Math.max(0, 1 - f * 3)
    this.pillarMat.opacity = 0.32 * Math.max(0, 1 - f * 2.2)
    const G = 26
    for (let i = 0; i < this.n; i++) {
      this.sparkVel[i * 3 + 1] -= G * dt
      this.sparkPos[i * 3] += this.sparkVel[i * 3] * dt
      this.sparkPos[i * 3 + 1] = Math.max(0, this.sparkPos[i * 3 + 1] + this.sparkVel[i * 3 + 1] * dt)
      this.sparkPos[i * 3 + 2] += this.sparkVel[i * 3 + 2] * dt
    }
    ;(this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    this.sparkMat.opacity = Math.max(0, 1 - f * 1.3)
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
  }
}
