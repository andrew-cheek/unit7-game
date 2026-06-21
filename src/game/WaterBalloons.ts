import * as THREE from 'three'

interface Balloon {
  mesh: THREE.Mesh
  vel: THREE.Vector3
  life: number
}
interface Splash {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  t: number
}

const G = -22 // balloon gravity

/**
 * Lobbed water balloons the invading aliens throw at the player. Each is a
 * wobbly blue blob on a ballistic arc; on hitting the ground (or its target) it
 * bursts into a quick translucent splash. Detonation is reported via callback so
 * the game can react (soak the player / banner). Shared geo + pooled splashes.
 */
export class WaterBalloons {
  private scene: THREE.Scene
  private group = new THREE.Group()
  private list: Balloon[] = []
  private splashes: Splash[] = []

  private geo = new THREE.SphereGeometry(0.45, 10, 8)
  private splashGeo = new THREE.SphereGeometry(1, 12, 8)
  private mat = new THREE.MeshStandardMaterial({ color: 0x3fb0ff, metalness: 0.2, roughness: 0.3, transparent: true, opacity: 0.85, emissive: 0x10406a, emissiveIntensity: 0.6 })

  constructor(scene: THREE.Scene) {
    this.scene = scene
    scene.add(this.group)
  }

  /** Lob a balloon from `origin` to land near `target` after ~`flight` seconds. */
  throw(origin: THREE.Vector3, target: THREE.Vector3, flight = 1.5) {
    const m = new THREE.Mesh(this.geo, this.mat)
    m.position.copy(origin)
    this.group.add(m)
    // Solve ballistic velocity: x/z linear, y compensates for gravity drop.
    const vx = (target.x - origin.x) / flight
    const vz = (target.z - origin.z) / flight
    const vy = (target.y - origin.y) / flight - 0.5 * G * flight
    this.list.push({ mesh: m, vel: new THREE.Vector3(vx, vy, vz), life: flight + 0.5 })
  }

  update(dt: number, groundAt: (x: number, z: number) => number, onBurst: (pos: THREE.Vector3) => void) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i]
      b.life -= dt
      b.vel.y += G * dt
      b.mesh.position.addScaledVector(b.vel, dt)
      b.mesh.rotation.x += dt * 4
      const gy = groundAt(b.mesh.position.x, b.mesh.position.z)
      if (b.life <= 0 || b.mesh.position.y <= gy + 0.4) {
        b.mesh.position.y = gy + 0.4
        this.burst(b.mesh.position)
        onBurst(b.mesh.position)
        this.group.remove(b.mesh)
        this.list.splice(i, 1)
      }
    }
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i]
      s.t += dt
      const k = s.t / 0.4
      s.mesh.scale.set(1 + k * 2.5, 0.4 + k, 1 + k * 2.5)
      s.mat.opacity = Math.max(0, 0.7 * (1 - k))
      if (s.t >= 0.4) {
        this.group.remove(s.mesh)
        s.mat.dispose()
        this.splashes.splice(i, 1)
      }
    }
  }

  private burst(pos: THREE.Vector3) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x6fc8ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })
    const mesh = new THREE.Mesh(this.splashGeo, mat)
    mesh.position.copy(pos)
    this.group.add(mesh)
    this.splashes.push({ mesh, mat, t: 0 })
  }

  clear() {
    for (const b of this.list) this.group.remove(b.mesh)
    for (const s of this.splashes) { this.group.remove(s.mesh); s.mat.dispose() }
    this.list.length = 0
    this.splashes.length = 0
  }

  /** Balloons currently in flight (used to cap the comedy spam). */
  get count() {
    return this.list.length
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  dispose() {
    this.clear()
    this.geo.dispose()
    this.splashGeo.dispose()
    this.mat.dispose()
    this.scene.remove(this.group)
  }
}
