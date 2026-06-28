import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'

/**
 * Level-up spectacle: when the player's level ticks up, a triumphant gold pop
 * fires at their feet - an expanding shockwave ring, a ring of rising light
 * pillars, and a fountain of pooled sparks that burst up and fall under gravity.
 * Polls level itself (no new hook) and fires a "LEVEL N!" banner. Pure FX in
 * every zone: one pre-built rig, inactive and near-free until it triggers.
 */

interface Deps {
  /** Player position; the celebration plays here. */
  focus: () => THREE.Vector3
  /** Current player level; the system detects increases itself. */
  level: () => number
  /** "LEVEL N!" callout. */
  banner: (text: string) => void
}

const GOLD = 0xffd24a
const WHITE = 0xffffff
const DURATION = 1.2 // total effect lifetime, seconds
const RING_LIFE = 0.8 // shockwave expand+fade window
const RING_MAX_R = 7 // shockwave scale at full expansion
const PILLAR_COUNT = 6
const PILLAR_RADIUS = 1.6 // ring radius the pillars stand on
const PILLAR_HEIGHT = 9 // full pillar height when grown
const SPARK_GRAVITY = 16 // units/sec^2 pulling sparks back down

export class LevelUpShow implements GameSystem {
  private group = new THREE.Group()
  // First update only seeds lastLevel; -1 marks "not yet initialised".
  private lastLevel = -1
  private active = false
  private t = 0

  // Shockwave ground ring.
  private ringMat: THREE.MeshBasicMaterial
  private ringMesh: THREE.Mesh
  private ringGeo: THREE.RingGeometry

  // Rising light pillars (shared geometry + per-pillar material).
  private pillarGeo: THREE.PlaneGeometry
  private pillars: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = []

  // Pooled spark fountain.
  private sparkCount: number
  private sparkGeo: THREE.BufferGeometry
  private sparkMat: THREE.PointsMaterial
  private sparkPoints: THREE.Points
  private sparkPos: Float32Array
  private sparkVel: Float32Array

  // Disposal tracking.
  private geos: { dispose(): void }[] = []
  private mats: { dispose(): void }[] = []

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    this.sparkCount = low ? 30 : 60

    // --- Shockwave ring: flat additive ring on the ground. ---
    this.ringGeo = new THREE.RingGeometry(0.6, 1, 40)
    this.ringGeo.rotateX(-Math.PI / 2)
    this.ringMat = new THREE.MeshBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    this.ringMesh = new THREE.Mesh(this.ringGeo, this.ringMat)
    this.ringMesh.frustumCulled = false
    this.group.add(this.ringMesh)
    this.geos.push(this.ringGeo)
    this.mats.push(this.ringMat)

    // --- Light pillars: thin tall additive planes in a ring. ---
    this.pillarGeo = new THREE.PlaneGeometry(0.5, 1) // unit-tall, scaled in update
    this.pillarGeo.translate(0, 0.5, 0) // anchor base at y=0 so it grows upward
    this.geos.push(this.pillarGeo)
    for (let i = 0; i < PILLAR_COUNT; i++) {
      const ang = (i / PILLAR_COUNT) * Math.PI * 2
      const mat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? GOLD : WHITE,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
      const mesh = new THREE.Mesh(this.pillarGeo, mat)
      mesh.frustumCulled = false
      mesh.position.set(Math.cos(ang) * PILLAR_RADIUS, 0, Math.sin(ang) * PILLAR_RADIUS)
      // Face outward from the centre so the planes read as a radiant crown.
      mesh.rotation.y = -ang
      this.group.add(mesh)
      this.pillars.push({ mesh, mat })
      this.mats.push(mat)
    }

    // --- Spark fountain: pooled additive points. ---
    this.sparkPos = new Float32Array(this.sparkCount * 3)
    this.sparkVel = new Float32Array(this.sparkCount * 3)
    const col = new Float32Array(this.sparkCount * 3)
    const gold = new THREE.Color(GOLD)
    for (let i = 0; i < this.sparkCount; i++) {
      const i3 = i * 3
      const j = 0.8 + Math.random() * 0.2
      col[i3] = gold.r * j
      col[i3 + 1] = gold.g * j
      col[i3 + 2] = gold.b * j
    }
    this.sparkGeo = new THREE.BufferGeometry()
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3))
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    this.sparkMat = new THREE.PointsMaterial({
      size: low ? 1.7 : 1.4,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    })
    this.sparkPoints = new THREE.Points(this.sparkGeo, this.sparkMat)
    this.sparkPoints.frustumCulled = false
    this.group.add(this.sparkPoints)
    this.geos.push(this.sparkGeo)
    this.mats.push(this.sparkMat)

    this.group.visible = false
    scene.add(this.group)
  }

  /** Place the rig on the player and seed every sub-effect for a fresh play. */
  private trigger() {
    const f = this.deps.focus()
    this.group.position.set(f.x, f.y, f.z)
    this.t = 0
    this.active = true
    this.group.visible = true

    // Reset ring.
    this.ringMesh.position.y = 0.1
    this.ringMesh.scale.setScalar(0.2)
    this.ringMat.opacity = 1

    // Reset pillars: zero height, full opacity.
    for (const p of this.pillars) {
      p.mesh.scale.set(1, 0.01, 1)
      p.mat.opacity = 1
    }

    // Seed sparks: burst up and outward from the feet (local origin).
    for (let i = 0; i < this.sparkCount; i++) {
      const i3 = i * 3
      const ang = Math.random() * Math.PI * 2
      const out = Math.random() * 5 // outward spread speed
      const up = 9 + Math.random() * 9 // upward kick
      this.sparkPos[i3] = 0
      this.sparkPos[i3 + 1] = 0.3
      this.sparkPos[i3 + 2] = 0
      this.sparkVel[i3] = Math.cos(ang) * out
      this.sparkVel[i3 + 1] = up
      this.sparkVel[i3 + 2] = Math.sin(ang) * out
    }
    this.sparkMat.opacity = 1
    ;(this.sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  update(dt: number) {
    const level = this.deps.level()

    // First update seeds the baseline without firing, so loading in at an
    // existing level doesn't trigger a celebration.
    if (this.lastLevel < 0) {
      this.lastLevel = level
    } else if (level > this.lastLevel) {
      // Fire once even if more than one level was gained at once.
      this.trigger()
      this.deps.banner('LEVEL ' + level + '!')
      this.lastLevel = level
    }

    // Inactive: do nothing else - the level poll above is the whole per-frame cost.
    if (!this.active) return

    this.t += dt
    if (this.t >= DURATION) {
      this.active = false
      this.group.visible = false
      return
    }

    // Shockwave ring: expand + fade over its window.
    {
      const k = Math.min(1, this.t / RING_LIFE)
      this.ringMesh.scale.setScalar(RING_MAX_R * (0.2 + k * 0.8))
      this.ringMat.opacity = Math.max(0, 1 - k)
    }

    // Pillars: shoot up quickly, then fade across the full duration.
    {
      const grow = Math.min(1, this.t / 0.25) // reach full height in 0.25s
      const h = PILLAR_HEIGHT * (0.05 + grow * 0.95)
      const fade = Math.max(0, 1 - this.t / DURATION)
      for (const p of this.pillars) {
        p.mesh.scale.y = h
        p.mat.opacity = fade
      }
    }

    // Sparks: integrate under gravity in local space, fade over the duration.
    {
      const pos = this.sparkPos
      const vel = this.sparkVel
      for (let i = 0; i < this.sparkCount; i++) {
        const i3 = i * 3
        vel[i3 + 1] -= SPARK_GRAVITY * dt
        pos[i3] += vel[i3] * dt
        pos[i3 + 1] += vel[i3 + 1] * dt
        pos[i3 + 2] += vel[i3 + 2] * dt
      }
      this.sparkMat.opacity = Math.max(0, 1 - this.t / DURATION)
      ;(this.sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
