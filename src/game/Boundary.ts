import * as THREE from 'three'
import { config } from './config'

/** A bounce returned when the player crosses the edge: a launch velocity plus the
 *  position clamped back just inside the ring (so they can never escape). */
export interface BoundaryBounce {
  /** Position clamped back just inside the ring (always applied when past it). */
  x: number; z: number
  /** True only on a real bounce frame: apply the launch velocity + juice. */
  launch: boolean
  vx: number; vy: number; vz: number
}

/**
 * The soft world edge. Fly past the district and, instead of an invisible wall or
 * an endless void, you hit a ring of big jiggly alien blobs that squash and fling
 * you back up into the air toward the arcade. You can never leave the map, but the
 * boundary is a toy, not a barrier.
 *
 * Self-contained: owns its meshes, animates the blobs, and reports a bounce for
 * Game to apply to the player. Earth-only.
 */
export class Boundary {
  readonly group = new THREE.Group()
  readonly radius: number

  private blobs: { g: THREE.Group; baseY: number; ph: number; react: number }[] = []
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private t = 0
  private cooldown = 0
  private arcadeX: number
  private arcadeZ: number

  constructor(
    scene: THREE.Scene,
    getGround: (x: number, z: number) => number,
    opts: { radius: number; count: number; arcade: THREE.Vector3; eyes: boolean },
  ) {
    this.radius = opts.radius
    this.arcadeX = opts.arcade.x
    this.arcadeZ = opts.arcade.z

    const own = <T extends THREE.Material>(m: T) => { this.mats.push(m); return m }
    const ownG = <T extends THREE.BufferGeometry>(g: T) => { this.geos.push(g); return g }

    // Shared assets across all blobs (one material/geometry set, scaled per blob).
    const bodyMat = own(new THREE.MeshStandardMaterial({
      color: 0x0a2113, emissive: 0x57ff9c, emissiveIntensity: 1.7,
      roughness: 0.35, metalness: 0.1, transparent: true, opacity: 0.92,
    }))
    // Additive halo so the rim of blobs reads as a glowing wall from across the map.
    const glowMat = own(new THREE.MeshBasicMaterial({ color: 0x6effae, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const eyeMat = own(new THREE.MeshBasicMaterial({ color: 0xeafff2, fog: false }))
    const pupilMat = own(new THREE.MeshBasicMaterial({ color: 0x05140b, fog: false }))
    const bodyGeo = ownG(new THREE.IcosahedronGeometry(1, 2)) // blobby unit sphere
    const glowGeo = ownG(new THREE.IcosahedronGeometry(1, 1))
    const eyeGeo = ownG(new THREE.SphereGeometry(1, 10, 8))
    const pupilGeo = ownG(new THREE.SphereGeometry(1, 8, 6))

    const R = opts.radius
    for (let i = 0; i < opts.count; i++) {
      // Distribute evenly around the SQUARE rim (matching the square play area) so
      // no corner content gets walled off, rather than an inscribed circle.
      const seg = (i / opts.count) * 4
      const e = Math.floor(seg) % 4
      const u = (seg - Math.floor(seg)) * 2 - 1 // -1..1 along this edge
      const x = e === 1 ? R : e === 3 ? -R : u * R
      const z = e === 0 ? -R : e === 2 ? R : u * R
      const size = 14 + (i % 3) * 4 // bigger so they read as a barrier, with variety

      const g = new THREE.Group()
      g.rotation.y = Math.atan2(-x, -z) // face the city centre (local +z points inward)

      const body = new THREE.Mesh(bodyGeo, bodyMat)
      body.scale.setScalar(size)
      g.add(body)
      const glow = new THREE.Mesh(glowGeo, glowMat)
      glow.scale.setScalar(size * 1.5)
      g.add(glow)

      if (opts.eyes) {
        for (const sx of [-1, 1]) {
          const eye = new THREE.Mesh(eyeGeo, eyeMat)
          eye.position.set(sx * size * 0.42, size * 0.28, size * 0.9)
          eye.scale.setScalar(size * 0.2)
          g.add(eye)
          const pupil = new THREE.Mesh(pupilGeo, pupilMat)
          pupil.position.set(sx * size * 0.42, size * 0.28, size * 1.04)
          pupil.scale.setScalar(size * 0.1)
          g.add(pupil)
        }
      }

      const baseY = getGround(x, z) + size * 0.5
      g.position.set(x, baseY, z)
      this.group.add(g)
      this.blobs.push({ g, baseY, ph: i * 1.7, react: 0 })
    }

    scene.add(this.group)
  }

  /**
   * Animate the blobs and, if the player is past the ring, return how to keep them
   * in. The clamped-back position is ALWAYS returned past the ring (so nothing can
   * leave); the launch velocity fires only when `canLaunch` (false in a vehicle,
   * where a fling makes no sense) and a short cooldown has elapsed.
   */
  update(dt: number, px: number, pz: number, canLaunch: boolean): BoundaryBounce | null {
    this.t += dt
    if (this.cooldown > 0) this.cooldown -= dt

    for (const b of this.blobs) {
      if (b.react > 0) b.react = Math.max(0, b.react - dt * 2.4)
      // Idle wobble + a squash-and-stretch kick when freshly bounced (react).
      const stretch = 1 + Math.sin(this.t * 2.1 + b.ph) * 0.07 + b.react * 0.45
      const squish = 1 / Math.sqrt(stretch) // rough volume preserve so it reads as a blob
      b.g.scale.set(squish, stretch, squish)
      b.g.position.y = b.baseY + Math.sin(this.t * 1.5 + b.ph) * 1.4 + b.react * 4
    }

    // Square containment (matches the playable square): out if either axis is past
    // the rim. Height-independent so you can't jetpack over it.
    if (Math.abs(px) <= this.radius && Math.abs(pz) <= this.radius) return null

    // Shove back just inside the rim on whichever axis (or both) went past it.
    const lim = this.radius - 2
    const x = Math.max(-lim, Math.min(lim, px))
    const z = Math.max(-lim, Math.min(lim, pz))
    if (!canLaunch || this.cooldown > 0) return { x, z, launch: false, vx: 0, vy: 0, vz: 0 }

    // A real bounce: kick the nearest blob so it reads as the one that flung you,
    // then fling the player up and back toward the arcade (roughly).
    this.cooldown = 0.7
    let best = this.blobs[0]
    let bd = Infinity
    for (const b of this.blobs) {
      const dd = (b.g.position.x - px) ** 2 + (b.g.position.z - pz) ** 2
      if (dd < bd) { bd = dd; best = b }
    }
    if (best) best.react = 1

    let dx = this.arcadeX - px
    let dz = this.arcadeZ - pz
    const L = Math.hypot(dx, dz) || 1
    dx /= L; dz /= L
    // "Roughly" toward the arcade: a small random spread so it's playful.
    const j = (Math.random() - 0.5) * 0.5
    const c = Math.cos(j), s = Math.sin(j)
    const rx = dx * c - dz * s
    const rz = dx * s + dz * c

    // Bounce HIGH and aim the arc to land near the arcade: derive the horizontal
    // speed from the ballistic range for this launch (time of flight 2*UP/g),
    // boosted a little to counter air drag and clamped so it never flings absurdly.
    const UP = 50
    const g = Math.abs(config.zones.earth.gravity)
    const vh = Math.min(120, Math.max(26, (L / ((2 * UP) / g)) * 1.3))
    return { x, z, launch: true, vx: rx * vh, vy: UP, vz: rz * vh }
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
  }
}
