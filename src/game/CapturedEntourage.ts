import * as THREE from 'three'
import type { GameSystem } from './System'
import { config } from './config'

interface Deps {
  /** Player position to trail. */
  focus: () => THREE.Vector3
  /** Player facing (radians), so the posse trails BEHIND the player. */
  yaw: () => number
  /** How many aliens you've captured this session (sizes the posse). */
  count: () => number
}

/** One captured-alien follower: spring-follow state + bake into instances. */
interface Follower {
  pos: THREE.Vector3
  vel: THREE.Vector3
  phase: number
  tint: THREE.Color
  placed: boolean
}

/**
 * A floating entourage of the aliens you've captured, bobbing along behind the
 * player as a flex/progression display - the more you've caught, the bigger your
 * posse. Cute glowing orbs trail in a loose V with spring-follow lag, bob, spin
 * and pulse. Pure character; no gameplay, no colliders. Shows in every zone.
 *
 * Rendered as three InstancedMeshes (body / core / halo) so the whole posse is
 * three draw calls regardless of how many you've captured, instead of three per
 * follower. Each follower's transform and per-instance tint are written every
 * frame via setMatrixAt / setColorAt from reused scratch objects (no per-frame
 * allocation). Inactive followers are hidden with a zero-scale matrix.
 */
export class CapturedEntourage implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private followers: Follower[] = []
  private body!: THREE.InstancedMesh
  private core!: THREE.InstancedMesh
  private halo!: THREE.InstancedMesh
  private t = 0

  // Reused scratch - never allocate per frame.
  private scratch = new THREE.Vector3()
  private mtx = new THREE.Matrix4()
  private quat = new THREE.Quaternion()
  private sclV = new THREE.Vector3()
  private euler = new THREE.Euler()
  private col = new THREE.Color()
  private spin = 0

  // A small neon palette to tint each captured alien from.
  private static readonly PALETTE = [0x49e0ff, 0xff5fd2, 0x7cff5f, 0xffd24a, 0xb37cff, 0xff8a5f]
  private static readonly ZERO_SCALE = new THREE.Vector3(0, 0, 0)

  // Local part offsets/scales matching the original group children.
  private static readonly BODY_SCALE = new THREE.Vector3(1, 0.9, 1)
  private static readonly CORE_OFFSET = new THREE.Vector3(0, 0.04, 0.16)
  private static readonly HALO_OFFSET = new THREE.Vector3(0, 0.04, 0.17)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const max = config.tier.name === 'low' ? 6 : 10

    // Shared geometry across all followers (one allocation each).
    const bodyGeo = this.ownG(new THREE.SphereGeometry(0.22, 12, 10))
    const coreGeo = this.ownG(new THREE.SphereGeometry(0.1, 10, 8))
    const haloGeo = this.ownG(new THREE.RingGeometry(0.18, 0.28, 16))

    // One material per part type, shared across all instances. Per-follower tint
    // is delivered through the per-instance color (instanceColor), which multiplies
    // the material color. We keep the material color white so the instance color is
    // the tint directly. For the body's emissive glow we patch the shader so the
    // instance color also tints emissive, preserving the original look where the
    // body both diffuse-colors AND emissive-glows in its tint.
    const bodyMat = this.own(new THREE.MeshStandardMaterial({
      color: 0xffffff, metalness: 0.2, roughness: 0.5,
      emissive: 0xffffff, emissiveIntensity: 0.6,
      transparent: true, opacity: 0.85,
    }))
    bodyMat.onBeforeCompile = (shader) => {
      // Multiply emissive by the per-instance color so each follower glows its tint.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\n totalEmissiveRadiance *= vColor;\n#endif',
      )
    }
    // core/halo are additive; tint+pulse-brightness are baked into the instance color.
    const coreMat = this.own(new THREE.MeshBasicMaterial({
      color: 0xffffff, blending: THREE.AdditiveBlending, fog: false,
    }))
    const haloMat = this.own(new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    }))

    this.body = new THREE.InstancedMesh(bodyGeo, bodyMat, max)
    this.core = new THREE.InstancedMesh(coreGeo, coreMat, max)
    this.halo = new THREE.InstancedMesh(haloGeo, haloMat, max)
    for (const im of [this.body, this.core, this.halo]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // The posse spring-follows behind the player, so the instanced bounding
      // sphere (built at the local origin) doesn't reflect the trailing world
      // position - disable frustum culling so a follower never pops out when it's
      // behind you. (Property preserved from the pre-instancing per-mesh fix.)
      im.frustumCulled = false
      im.count = max
      this.group.add(im)
    }
    // Allocate the per-instance color buffers (setColorAt needs them present).
    this.col.set(0xffffff)
    for (let i = 0; i < max; i++) {
      this.body.setColorAt(i, this.col)
      this.core.setColorAt(i, this.col)
      this.halo.setColorAt(i, this.col)
    }

    for (let i = 0; i < max; i++) {
      const tint = CapturedEntourage.PALETTE[i % CapturedEntourage.PALETTE.length]
      // Start every instance hidden (zero-scale) until activated by capture count.
      this.mtx.makeScale(0, 0, 0)
      this.body.setMatrixAt(i, this.mtx)
      this.core.setMatrixAt(i, this.mtx)
      this.halo.setMatrixAt(i, this.mtx)
      this.followers.push({
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        phase: i * 1.7, tint: new THREE.Color(tint), placed: false,
      })
    }
    this.body.instanceMatrix.needsUpdate = true
    this.core.instanceMatrix.needsUpdate = true
    this.halo.instanceMatrix.needsUpdate = true

    scene.add(this.group)
  }

  update(dt: number) {
    this.t += dt
    this.spin += dt * 0.9 // slow spin shared by all (matches per-follower rotation.y rate)
    const p = this.deps.focus()
    const yaw = this.deps.yaw()
    const n = Math.max(0, Math.min(this.followers.length, Math.floor(this.deps.count())))

    // Behind-the-player basis: -forward points back, right spreads the V sideways.
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw)
    const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw)

    for (let i = 0; i < this.followers.length; i++) {
      const f = this.followers[i]
      if (i >= n) {
        if (f.placed) {
          // Hide with a zero-scale matrix across all three parts.
          this.mtx.compose(this.scratch.set(0, 0, 0), this.quat.identity(), CapturedEntourage.ZERO_SCALE)
          this.body.setMatrixAt(i, this.mtx)
          this.core.setMatrixAt(i, this.mtx)
          this.halo.setMatrixAt(i, this.mtx)
          f.placed = false
        }
        continue
      }

      // Formation slot: rows fall back in a loose V, alternating left/right.
      const row = Math.floor(i / 2)
      const side = (i % 2 === 0 ? -1 : 1)
      const back = 1.3 + row * 0.85
      const spread = (row * 0.55 + 0.45) * side
      const bob = Math.sin(this.t * 1.8 + f.phase) * 0.12

      const tx = p.x - fwdX * back + rightX * spread
      const tz = p.z - fwdZ * back + rightZ * spread
      const ty = p.y + 1.7 + bob
      this.scratch.set(tx, ty, tz)

      if (!f.placed) { f.pos.copy(this.scratch); f.vel.set(0, 0, 0); f.placed = true }
      else {
        // Critically-damped-ish spring so each one swarms then settles.
        const k = Math.min(1, dt * 6)
        f.vel.x += (this.scratch.x - f.pos.x) * k - f.vel.x * k
        f.vel.y += (this.scratch.y - f.pos.y) * k - f.vel.y * k
        f.vel.z += (this.scratch.z - f.pos.z) * k - f.vel.z * k
        f.pos.addScaledVector(f.vel, Math.min(1, dt * 9))
      }

      // Per-follower orientation: slow spin (y) + sway (z), matching the original.
      const rotZ = Math.sin(this.t * 1.4 + f.phase) * 0.18
      this.euler.set(0, this.spin, rotZ)
      this.quat.setFromEuler(this.euler)

      // Body: scaled (1, 0.9, 1), centered on the follower position.
      this.mtx.compose(f.pos, this.quat, CapturedEntourage.BODY_SCALE)
      this.body.setMatrixAt(i, this.mtx)
      this.col.copy(f.tint)
      this.body.setColorAt(i, this.col)

      // Core + halo: local offsets rotated by the follower orientation, then placed.
      const pulse = 0.6 + 0.4 * Math.sin(this.t * 3 + f.phase)

      this.scratch.copy(CapturedEntourage.CORE_OFFSET).applyQuaternion(this.quat).add(f.pos)
      this.mtx.compose(this.scratch, this.quat, this.sclV.set(1, 1, 1))
      this.core.setMatrixAt(i, this.mtx)
      // Core was white at per-follower opacity 0.7+pulse*0.3 (additive). Fold that
      // brightness into the instance color so it pulses identically without a
      // per-instance material opacity (which InstancedMesh can't vary).
      const coreB = 0.7 + pulse * 0.3
      this.col.setRGB(coreB, coreB, coreB)
      this.core.setColorAt(i, this.col)

      this.scratch.copy(CapturedEntourage.HALO_OFFSET).applyQuaternion(this.quat).add(f.pos)
      this.mtx.compose(this.scratch, this.quat, this.sclV.set(1, 1, 1))
      this.halo.setMatrixAt(i, this.mtx)
      // Halo: tint at material opacity 0.45, pulsed 0.3+pulse*0.3 (additive). Bake
      // the (pulsedOpacity / baseOpacity) scalar into the tint's brightness.
      const haloB = (0.3 + pulse * 0.3) / 0.45
      this.col.copy(f.tint).multiplyScalar(haloB)
      this.halo.setColorAt(i, this.col)
    }

    this.body.instanceMatrix.needsUpdate = true
    this.core.instanceMatrix.needsUpdate = true
    this.halo.instanceMatrix.needsUpdate = true
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true
    if (this.core.instanceColor) this.core.instanceColor.needsUpdate = true
    if (this.halo.instanceColor) this.halo.instanceColor.needsUpdate = true
  }

  dispose() {
    this.body.dispose()
    this.core.dispose()
    this.halo.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
