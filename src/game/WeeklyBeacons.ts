// WeeklyBeacons — a rotating set of "bonus" neon light columns that returning
// players discover scattered around the city. The layout is derived from the
// CURRENT ISO WEEK number fed into a deterministic PRNG, so every player sees
// the SAME beacons within a given week, and a brand-new set the following week.
// That makes the world feel like it changes on a regular cadence without any
// server, save data, or content authoring.
//
// Each beacon is a tall additive light column (fog-immune so it reads from
// across the map) standing on a glowing base ring, slowly pulsing. Walking
// within ~4m of one collects it: it pays out via deps.onCollect and hides for
// the rest of the session. Collection is in-memory ONLY (no persistence) — a
// reload re-shows everything for the current week, which is fine for a kids'
// "free reward" beat.
//
// Earth-only: the whole group hides off-world. Cheap and pooled — a fixed set
// of columns + rings built once, never per-frame allocation, all geo/mats
// tracked and disposed on teardown. Tier-gated counts (high 6 / medium 5 /
// low 3) keep the draw-call cost trivial on mobile.

import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position (read each step for the proximity test). */
  playerPos: () => THREE.Vector3
  /** Current zone, so the system can hide itself off Earth. */
  zone: () => Zone
  /** Sampled ground height at an XZ so each beacon sits on the floor. */
  groundY: (x: number, z: number) => number
  /** Award a pickup at a world point: credits + XP, with a feedback pop. */
  onCollect: (x: number, y: number, z: number, credits: number, xp: number) => void
}

interface Beacon {
  group: THREE.Group
  columnMat: THREE.MeshBasicMaterial
  ringMat: THREE.MeshBasicMaterial
  coreMat: THREE.MeshBasicMaterial
  x: number
  z: number
  baseY: number
  phase: number
  collected: boolean
}

/** Deterministic PRNG — same seed yields the same stream every time. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * ISO-8601 week number (1..53) for a date. ISO weeks start Monday and the week
 * containing the year's first Thursday is week 1. We combine it with the ISO
 * week-year so the seed is unique across year boundaries (week 1 of 2026 must
 * differ from week 1 of 2027).
 */
function isoWeekSeed(d: Date): number {
  // Work in UTC to avoid timezone drift around midnight.
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  // Shift to the Thursday of this week (ISO weeks are Thursday-anchored).
  const day = (date.getUTCDay() + 6) % 7 // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - day + 3)
  const isoYear = date.getUTCFullYear()
  // First Thursday of the ISO year.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const fday = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3)
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  // Mix year + week into one stable, well-spread seed.
  return (isoYear * 53 + week) >>> 0
}

const CREDITS = 80
const XP = 40

/**
 * WeeklyBeacons: a weekly-rotating set of tall pulsing neon reward columns in
 * the Earth city. Positions are deterministic per ISO week (so all players this
 * week share them, and they refresh next week); reaching one pays credits + XP
 * and hides it for the session. Earth-gated, pooled, fully disposed.
 */
export class WeeklyBeacons implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private beacons: Beacon[] = []
  private t = 0
  private readonly reach = 4 // proximity radius (XZ) that collects a beacon

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const count = tier === 'high' ? 6 : tier === 'medium' ? 5 : 3

    const seed = isoWeekSeed(new Date())
    const rnd = mulberry32(seed)

    // Weekly tint rotation: pick a starting palette offset from the seed so the
    // colour mix also feels fresh week to week.
    const palette = [
      config.palette.cyan, config.palette.magenta, config.palette.purple,
      config.palette.orange, config.palette.lime,
    ]
    const tintOffset = seed % palette.length

    // Shared geometry across every beacon — only the materials are per-beacon
    // (so each can pulse independently). Tall, thin, open-ended cylinder for the
    // light column; a flat ring + a small core orb on the base.
    const columnGeo = this.ownG(new THREE.CylinderGeometry(0.6, 0.9, 70, 12, 1, true))
    const ringGeo = this.ownG(new THREE.TorusGeometry(2.2, 0.18, 8, 28))
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(0.8, 0))

    // Spread beacons across most of the district, but keep them clear of the
    // very centre (spawn/plaza) so they read as "out there to find".
    const half = config.world.half
    for (let i = 0; i < count; i++) {
      // Angular slots with jitter give an even, non-clumped scatter.
      const a = ((i + rnd() * 0.7) / count) * Math.PI * 2
      const rad = half * (0.32 + rnd() * 0.5) // ~0.32..0.82 of half-extent
      const x = Math.cos(a) * rad
      const z = Math.sin(a) * rad
      const baseY = this.deps.groundY(x, z)
      const tintHex = palette[(i + tintOffset) % palette.length]

      const group = new THREE.Group()
      group.position.set(x, baseY, z)

      const columnMat = this.own(new THREE.MeshBasicMaterial({ color: tintHex, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const column = new THREE.Mesh(columnGeo, columnMat)
      column.position.y = 35 // half of the 70m height, so the base sits on the floor
      group.add(column)

      const ringMat = this.own(new THREE.MeshBasicMaterial({ color: tintHex, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const ring = new THREE.Mesh(ringGeo, ringMat)
      ring.rotation.x = Math.PI / 2
      ring.position.y = 0.4
      group.add(ring)

      const coreMat = this.own(new THREE.MeshBasicMaterial({ color: tintHex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const core = new THREE.Mesh(coreGeo, coreMat)
      core.position.y = 1.6
      group.add(core)

      this.group.add(group)
      this.beacons.push({ group, columnMat, ringMat, coreMat, x, z, baseY, phase: rnd() * 6.28, collected: false })
    }

    this.group.visible = this.deps.zone() === 'earth'
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    const onEarth = this.deps.zone() === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt

    const p = this.deps.playerPos()
    for (const b of this.beacons) {
      if (b.collected) continue

      // Proximity collect (XZ only — height doesn't matter for a ground column).
      const dx = b.x - p.x, dz = b.z - p.z
      if (dx * dx + dz * dz < this.reach * this.reach) {
        b.collected = true
        b.group.visible = false
        this.deps.onCollect(b.x, b.baseY + 2.4, b.z, CREDITS, XP)
        continue
      }

      // Pulse: a slow breathing glow with a faster shimmer overlaid.
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 1.8 + b.phase)
      const shimmer = 0.5 + 0.5 * Math.sin(this.t * 6 + b.phase * 1.7)
      b.columnMat.opacity = 0.32 + pulse * 0.34
      b.ringMat.opacity = 0.55 + pulse * 0.35
      b.coreMat.opacity = 0.6 + shimmer * 0.4

      // Spin + bob the core orb; slow-rotate the base ring.
      const core = b.group.children[2]
      core.position.y = 1.6 + Math.sin(this.t * 1.4 + b.phase) * 0.3
      core.rotation.y += dt * 1.1
      core.rotation.x += dt * 0.6
      const ring = b.group.children[1]
      ring.rotation.z += dt * 0.5
      const s = 1 + pulse * 0.12
      core.scale.setScalar(s)
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
