import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Planar speed in units/sec (sprint ~14, walk ~6). */
  speed: () => number
  /** Player facing (radians), so the ribbons stream off the right sides. */
  yaw: () => number
}

/**
 * Speed-feel juice: two thin neon motion-trail ribbons that stream off the
 * player's shoulders when moving fast (sprint, jetpack, hoverboard). Each ribbon
 * is one additive triangle-strip mesh fed by a ring buffer of past head points,
 * fading bright->transparent head to tail. Pure FX - no colliders, all zones.
 */
export class SpeedRibbons implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  // Two ribbons (left/right shoulder). Each is a strip of `segN` cross-sections.
  private segN: number
  private ribbons: {
    side: number // -1 left, +1 right
    mesh: THREE.Mesh
    pos: THREE.BufferAttribute
    // Ring buffer of head anchor points (segN of them), reused, never reallocated.
    histX: Float32Array
    histY: Float32Array
    histZ: Float32Array
    filled: boolean
  }[] = []

  // Eased speed intensity 0..1.
  private intensity = 0
  // Scratch vectors, reused every frame - no per-frame allocation.
  private head = new THREE.Vector3()
  private right = new THREE.Vector3()
  private up = new THREE.Vector3(0, 1, 0)
  private out = new THREE.Vector3()
  private a = new THREE.Vector3()
  private b = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    // Segment count scales with tier: medium gets a trimmed count between low and high.
    const tier = config.tier.name
    this.segN = tier === 'low' ? 16 : tier === 'medium' ? 20 : 24

    const head = new THREE.Color(0x49e0ff)
    for (const side of [-1, 1]) {
      // A triangle strip: segN cross-sections, 2 verts each -> 2*segN verts.
      const verts = this.segN * 2
      const geo = this.ownG(new THREE.BufferGeometry())
      const positions = new Float32Array(verts * 3)
      const colors = new Float32Array(verts * 3)
      // Bake the head->tail fade into vertex colours (additive, so dark == faint).
      for (let s = 0; s < this.segN; s++) {
        const f = 1 - s / (this.segN - 1) // 1 at head, 0 at tail
        for (let e = 0; e < 2; e++) {
          const ci = (s * 2 + e) * 3
          colors[ci] = head.r * f
          colors[ci + 1] = head.g * f
          colors[ci + 2] = head.b * f
        }
      }
      // Index the strip as a list of triangles.
      const idx: number[] = []
      for (let s = 0; s < this.segN - 1; s++) {
        const i0 = s * 2, i1 = s * 2 + 1, i2 = s * 2 + 2, i3 = s * 2 + 3
        idx.push(i0, i1, i2, i2, i1, i3)
      }
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      geo.setIndex(idx)

      const mat = this.own(new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }))
      const mesh = new THREE.Mesh(geo, mat)
      mesh.frustumCulled = false // anchored at the player; trail extends behind
      this.group.add(mesh)

      this.ribbons.push({
        side,
        mesh,
        pos: geo.getAttribute('position') as THREE.BufferAttribute,
        histX: new Float32Array(this.segN),
        histY: new Float32Array(this.segN),
        histZ: new Float32Array(this.segN),
        filled: false,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  update(dt: number) {
    const spd = this.deps.speed()
    // Rise toward 1 above ~9 u/s, fall toward 0 below; smooth ease either way.
    const target = THREE.MathUtils.clamp((spd - 9) / 5, 0, 1)
    const rate = target > this.intensity ? 8 : 4
    this.intensity += (target - this.intensity) * Math.min(1, dt * rate)

    if (this.intensity < 0.02) {
      if (this.group.visible) this.group.visible = false
      // Drop history so the trail doesn't snap from a stale position next time.
      for (const r of this.ribbons) r.filled = false
      return
    }
    this.group.visible = true

    const f = this.deps.focus()
    const yaw = this.deps.yaw()
    // Right vector from yaw (yaw 0 faces -Z in this codebase's convention).
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw))

    const width = (0.18 + 0.22 * this.intensity)
    const sideOff = 0.42
    const headY = f.y + 1.0 // torso height

    for (const r of this.ribbons) {
      // New head anchor: just behind+to one side of the player at torso height.
      this.head.set(
        f.x + this.right.x * r.side * sideOff,
        headY,
        f.z + this.right.z * r.side * sideOff,
      )

      if (!r.filled) {
        // Seed the whole history at the head so it grows out smoothly.
        for (let s = 0; s < this.segN; s++) {
          r.histX[s] = this.head.x
          r.histY[s] = this.head.y
          r.histZ[s] = this.head.z
        }
        r.filled = true
      } else {
        // Shift history toward the tail (in place), then write the new head.
        for (let s = this.segN - 1; s > 0; s--) {
          r.histX[s] = r.histX[s - 1]
          r.histY[s] = r.histY[s - 1]
          r.histZ[s] = r.histZ[s - 1]
        }
        r.histX[0] = this.head.x
        r.histY[0] = this.head.y
        r.histZ[0] = this.head.z
      }

      // Rewrite the strip: at each section, offset +/- width across the ribbon,
      // tapering to a point at the tail. Width direction is right x up-ish; we
      // use the horizontal `right` vector so the ribbon stays roughly vertical.
      const arr = r.pos.array as Float32Array
      for (let s = 0; s < this.segN; s++) {
        const taper = 1 - s / (this.segN - 1) // 1 head -> 0 tail
        const w = width * (0.25 + 0.75 * taper)
        this.a.set(r.histX[s], r.histY[s], r.histZ[s])
        // Cross-section runs along the world right vector, slightly upward bias.
        this.out.copy(this.right).multiplyScalar(w)
        this.b.copy(this.up).multiplyScalar(w * 0.35)
        const i0 = (s * 2) * 3
        const i1 = (s * 2 + 1) * 3
        arr[i0] = this.a.x + this.out.x + this.b.x
        arr[i0 + 1] = this.a.y + this.out.y + this.b.y
        arr[i0 + 2] = this.a.z + this.out.z + this.b.z
        arr[i1] = this.a.x - this.out.x - this.b.x
        arr[i1 + 1] = this.a.y - this.out.y - this.b.y
        arr[i1 + 2] = this.a.z - this.out.z - this.b.z
      }
      r.pos.needsUpdate = true
      const mat = r.mesh.material as THREE.MeshBasicMaterial
      mat.opacity = 0.85 * this.intensity
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
