import * as THREE from 'three'
import { config } from './config'

interface Missile {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  life: number
  active: boolean
}
interface Blast {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  t: number
  life: number
  radius: number
  active: boolean
}
// Pooled flat ground ring (mech footstep dust / landing shockwave). Reused, no
// per-event allocation.
interface Ring {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  active: boolean
  t: number
  life: number
  maxR: number
}

/**
 * Mech ordnance: glowing missiles that fly straight, leave a bright additive
 * look, and detonate on a timer / on hitting the ground into an expanding
 * shockwave. Detonation calls back into the game so it can capture/score nearby
 * targets. Pooled-ish: geometries/materials are shared and disposed on teardown.
 */
export class Missiles {
  private scene: THREE.Scene
  private group = new THREE.Group()
  private missiles: Missile[] = []
  private blasts: Blast[] = []

  private bodyGeo = new THREE.CylinderGeometry(0.18, 0.18, 1.4, 8)
  private headGeo = new THREE.ConeGeometry(0.2, 0.5, 8)
  private blastGeo = new THREE.SphereGeometry(1, 16, 12)
  private bodyMat = new THREE.MeshStandardMaterial({ color: 0x20242f, metalness: 0.6, roughness: 0.5 })
  private glowMat = new THREE.MeshBasicMaterial({ color: config.palette.orange, fog: false })
  private ringGeo = new THREE.RingGeometry(0.72, 1, 28)
  private rings: Ring[] = []
  private static readonly UP = new THREE.Vector3(0, 1, 0)

  constructor(scene: THREE.Scene) {
    this.scene = scene
    scene.add(this.group)
    // Pre-build a small ring pool (footsteps + shockwaves reuse these).
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      const mesh = new THREE.Mesh(this.ringGeo, mat)
      mesh.rotation.x = -Math.PI / 2 // lie flat on the ground
      mesh.visible = false
      this.group.add(mesh)
      this.rings.push({ mesh, mat, active: false, t: 0, life: 0.5, maxR: 4 })
    }
    // Pre-build the missile pool: each is a body sharing one material, with two
    // exhaust cones sharing the glow material. Reused across shots (sustained
    // mech fire used to allocate a fresh Mesh trio per shot and churn the GC).
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(this.bodyGeo, this.bodyMat)
      const head = new THREE.Mesh(this.headGeo, this.glowMat)
      head.position.y = 0.9
      const tail = new THREE.Mesh(this.headGeo, this.glowMat)
      tail.position.y = -0.9
      tail.rotation.x = Math.PI
      tail.scale.set(1.1, 1.8, 1.1) // flarey exhaust
      mesh.add(head, tail)
      mesh.visible = false
      this.group.add(mesh)
      this.missiles.push({ mesh, vel: new THREE.Vector3(), life: 0, active: false })
    }
    // Pre-build the blast pool: each keeps its own material so several blasts can
    // fade independently. Reused instead of allocated+disposed per detonation.
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffb24d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      const mesh = new THREE.Mesh(this.blastGeo, mat)
      mesh.visible = false
      this.group.add(mesh)
      this.blasts.push({ mesh, mat, t: 0, life: 0.5, radius: 9, active: false })
    }
  }

  /** Spawn an expanding ground ring (mech footstep / landing shockwave). */
  shockwave(pos: { x: number; y: number; z: number }, color: number, maxR: number, life = 0.5) {
    const r = this.rings.find((x) => !x.active)
    if (!r) return
    r.active = true
    r.t = 0
    r.life = life
    r.maxR = maxR
    r.mat.color.setHex(color)
    r.mesh.visible = true
    r.mesh.position.set(pos.x, pos.y + 0.2, pos.z)
    r.mesh.scale.setScalar(0.1)
  }

  /** Launch one missile from `origin` heading along `dir` (will be normalized). */
  fire(origin: THREE.Vector3, dir: THREE.Vector3, speed = 70, life = 2.6) {
    const mo = this.missiles.find((x) => !x.active)
    if (!mo) return // pool exhausted; drop the shot rather than allocate
    mo.active = true
    mo.life = life
    mo.vel.copy(dir).normalize()
    mo.mesh.position.copy(origin)
    // Orient local +Y down the travel direction.
    mo.mesh.quaternion.setFromUnitVectors(Missiles.UP, mo.vel)
    mo.vel.multiplyScalar(speed)
    mo.mesh.visible = true
  }

  /** Step missiles + blasts. `groundAt` gives terrain height; `onDetonate` is
   *  called with the blast centre + radius so the game can apply damage. */
  update(dt: number, groundAt: (x: number, z: number) => number, onDetonate: (pos: THREE.Vector3, radius: number) => void) {
    for (const mo of this.missiles) {
      if (!mo.active) continue
      mo.life -= dt
      mo.mesh.position.addScaledVector(mo.vel, dt)
      const gy = groundAt(mo.mesh.position.x, mo.mesh.position.z)
      if (mo.life <= 0 || mo.mesh.position.y <= gy + 0.3) {
        this.detonate(mo.mesh.position, 9)
        onDetonate(mo.mesh.position, 9)
        mo.active = false
        mo.mesh.visible = false
      }
    }
    for (const b of this.blasts) {
      if (!b.active) continue
      b.t += dt
      const k = b.t / b.life
      const s = b.radius * (0.2 + k * 0.9)
      b.mesh.scale.setScalar(s)
      b.mat.opacity = Math.max(0, 0.8 * (1 - k))
      if (b.t >= b.life) {
        b.active = false
        b.mesh.visible = false
      }
    }
    for (const r of this.rings) {
      if (!r.active) continue
      r.t += dt
      const k = r.t / r.life
      r.mesh.scale.setScalar(r.maxR * (0.1 + k * 0.9))
      r.mat.opacity = Math.max(0, 0.7 * (1 - k))
      if (r.t >= r.life) { r.active = false; r.mesh.visible = false }
    }
  }

  private detonate(pos: THREE.Vector3, radius: number) {
    const b = this.blasts.find((x) => !x.active)
    if (!b) return // pool exhausted; skip the visual
    b.active = true
    b.t = 0
    b.radius = radius
    b.mat.opacity = 0.8
    b.mesh.position.copy(pos)
    b.mesh.scale.setScalar(radius * 0.2)
    b.mesh.visible = true
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  dispose() {
    this.bodyGeo.dispose()
    this.headGeo.dispose()
    this.blastGeo.dispose()
    this.bodyMat.dispose()
    this.glowMat.dispose()
    this.ringGeo.dispose()
    for (const r of this.rings) r.mat.dispose()
    for (const b of this.blasts) b.mat.dispose()
    this.scene.remove(this.group)
  }
}
