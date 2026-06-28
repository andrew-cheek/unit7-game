import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player position, so the critter field always surrounds wherever you are. */
  playerPos: () => THREE.Vector3
  /** Current world, so we hide off-world (Earth-only ambient). */
  zone: () => Zone
  /** Ground height under a point, so critters sit on terrain/ramps. */
  groundY: (x: number, z: number) => number
}

const WRAP = 26 // distance from the player at which a critter wraps to the far side (XZ)
const SCATTER_R = 4 // come within this and nearby critters bolt
const SCATTER_R2 = SCATTER_R * SCATTER_R
const HOVER = 0.18 // resting height of the body above the ground

interface Critter {
  x: number
  z: number
  heading: number // wander direction (radians)
  speed: number // current ground speed (m/s)
  vx: number // scatter velocity (m/s), decays to 0
  vz: number
  flutter: number // 0..1 startle energy (drives the hop), decays
  phase: number // wing/bob phase offset
  jitter: number // per-critter heading-wander rate
}

/**
 * Glowing digital sparrows that make the Earth city feel inhabited: tiny critters
 * that wander near the ground around the player and SCATTER when you get close,
 * bolting away with a brief flutter-hop before resettling into a lazy wander. The
 * field WRAPS to stay centred on the player (like NeonRain) so they're always
 * nearby without ever spawning more than the tier count. Two InstancedMeshes -
 * one matte body, one additive glow halo - so the whole flock is ~2 draws.
 *
 * Earth-only atmosphere: zone-gated off-world (setZone + the deps.zone() guard),
 * no colliders, no gameplay. Frame-rate-independent motion, zero per-frame heap
 * allocation (scratch matrix/quat/vectors reused), everything disposed together.
 */
export class GroundCritters implements GameSystem {
  private bodyMesh: THREE.InstancedMesh
  private glowMesh: THREE.InstancedMesh
  private bodyGeo: THREE.BufferGeometry
  private glowGeo: THREE.BufferGeometry
  private bodyMat: THREE.MeshBasicMaterial
  private glowMat: THREE.MeshBasicMaterial
  private critters: Critter[] = []
  private n: number
  private zone: Zone = 'earth'

  // Scratch objects reused every frame so update() never allocates.
  private center = new THREE.Vector3()
  private mat = new THREE.Matrix4()
  private quat = new THREE.Quaternion()
  private scl = new THREE.Vector3()
  private posV = new THREE.Vector3()
  private up = new THREE.Vector3(0, 1, 0)

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    this.n = tier === 'low' ? 8 : tier === 'medium' ? 16 : 26

    // --- procedural geometry: a stubby dart of a body + a soft glow halo ---
    // Body: a small flattened sphere reads as a hunched little sparrow/beetle.
    this.bodyGeo = new THREE.SphereGeometry(0.16, 7, 5)
    this.bodyGeo.scale(1, 0.7, 1.5) // flatten + stretch forward into a teardrop
    // Glow: a billboard-ish blob (low-poly sphere is cheaper than a sprite atlas).
    this.glowGeo = new THREE.SphereGeometry(0.34, 6, 5)

    this.bodyMat = new THREE.MeshBasicMaterial({ color: 0x9af0ff, fog: true })
    this.glowMat = new THREE.MeshBasicMaterial({
      color: 0x4fd6ff,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    })

    this.bodyMesh = new THREE.InstancedMesh(this.bodyGeo, this.bodyMat, this.n)
    this.glowMesh = new THREE.InstancedMesh(this.glowGeo, this.glowMat, this.n)
    this.bodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The field re-centres on the player every frame, so its bounds are useless
    // for culling; skip it so critters never pop out as the box wraps.
    this.bodyMesh.frustumCulled = false
    this.glowMesh.frustumCulled = false
    this.bodyMesh.visible = false
    this.glowMesh.visible = false

    const f = this.deps.playerPos()
    for (let i = 0; i < this.n; i++) {
      this.critters.push({
        x: f.x + (Math.random() * 2 - 1) * WRAP,
        z: f.z + (Math.random() * 2 - 1) * WRAP,
        heading: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 0.5,
        vx: 0,
        vz: 0,
        flutter: 0,
        phase: Math.random() * Math.PI * 2,
        jitter: 0.8 + Math.random() * 1.2,
      })
    }

    scene.add(this.bodyMesh, this.glowMesh)
  }

  setZone(zone: Zone) {
    this.zone = zone
    if (zone !== 'earth') {
      this.bodyMesh.visible = false
      this.glowMesh.visible = false
    }
  }

  update(dt: number) {
    if (this.zone !== 'earth' || this.deps.zone() !== 'earth') {
      if (this.bodyMesh.visible) { this.bodyMesh.visible = false; this.glowMesh.visible = false }
      return
    }
    this.bodyMesh.visible = true
    this.glowMesh.visible = true

    const f = this.deps.playerPos()
    this.center.copy(f)
    const span = WRAP * 2

    // Frame-rate-independent decay factors (exponential damping).
    const velDecay = Math.exp(-dt * 3.5) // scatter velocity bleeds off
    const flutDecay = Math.exp(-dt * 2.5) // startle energy settles

    for (let i = 0; i < this.n; i++) {
      const c = this.critters[i]

      // Wrap horizontally to keep the flock centred on the player.
      const dxc = c.x - this.center.x
      if (dxc > WRAP) c.x -= span
      else if (dxc < -WRAP) c.x += span
      const dzc = c.z - this.center.z
      if (dzc > WRAP) c.z -= span
      else if (dzc < -WRAP) c.z += span

      // Startle: if the player is close, push velocity directly away and flutter.
      const px = c.x - this.center.x
      const pz = c.z - this.center.z
      const d2 = px * px + pz * pz
      if (d2 < SCATTER_R2) {
        const d = Math.sqrt(d2) || 0.0001
        const flee = (1 - d / SCATTER_R) // stronger the closer you are
        const ax = px / d
        const az = pz / d
        const burst = (5 + Math.random() * 3) * flee
        c.vx += ax * burst * dt * 6
        c.vz += az * burst * dt * 6
        c.flutter = Math.min(1, c.flutter + flee * dt * 8)
        c.heading = Math.atan2(az, ax)
      }

      // Lazy wander when calm: drift the heading and amble forward.
      c.heading += (Math.random() - 0.5) * c.jitter * dt
      const wander = c.speed
      c.x += (Math.cos(c.heading) * wander + c.vx) * dt
      c.z += (Math.sin(c.heading) * wander + c.vz) * dt

      // Bleed scatter velocity + startle back to a calm wander.
      c.vx *= velDecay
      c.vz *= velDecay
      c.flutter *= flutDecay

      c.phase += dt * (6 + c.flutter * 16)

      // Sit on the ground with a hop scaled by startle; idle critters bob softly.
      const gy = this.deps.groundY(c.x, c.z)
      const hop = c.flutter > 0.02 ? Math.abs(Math.sin(c.phase)) * (0.3 + c.flutter * 0.8) : 0
      const idle = Math.abs(Math.sin(c.phase * 0.5)) * 0.04
      const y = gy + HOVER + hop + idle

      // Face travel direction (heading + a bit of scatter lean), then write both
      // instances from one transform (glow scaled up a touch and pulsing).
      const faceX = Math.cos(c.heading) + c.vx * 0.05
      const faceZ = Math.sin(c.heading) + c.vz * 0.05
      const facing = Math.atan2(faceZ, faceX)
      this.quat.setFromAxisAngle(this.up, -facing + Math.PI / 2)
      this.posV.set(c.x, y, c.z)

      this.scl.set(1, 1, 1)
      this.mat.compose(this.posV, this.quat, this.scl)
      this.bodyMesh.setMatrixAt(i, this.mat)

      const gs = 1 + c.flutter * 0.5 + Math.sin(c.phase * 0.5) * 0.06
      this.scl.set(gs, gs, gs)
      this.mat.compose(this.posV, this.quat, this.scl)
      this.glowMesh.setMatrixAt(i, this.mat)
    }

    this.bodyMesh.instanceMatrix.needsUpdate = true
    this.glowMesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.bodyMesh.dispose()
    this.glowMesh.dispose()
    this.bodyGeo.dispose()
    this.glowGeo.dispose()
    this.bodyMat.dispose()
    this.glowMat.dispose()
  }
}
