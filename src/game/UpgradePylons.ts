import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ so each pylon sits on the floor. */
  groundY: (x: number, z: number) => number
  /** Current player credit balance, used to gate affordability for the prompt. */
  credits: () => number
  /** Attempt to charge `cost` credits; returns true if the player could pay. */
  spend: (cost: number) => boolean
  /** Grant the timed buff this pylon offers. */
  buff: (kind: BuffKind) => void
  /** Pop a floating feedback label at a world point in a CSS colour string. */
  notify: (x: number, y: number, z: number, label: string, color: string) => void
}

type BuffKind = 'speed' | 'shield' | 'score' | 'fuel'

interface PylonDef {
  kind: BuffKind
  tint: number
  css: string
  label: string // shown on a successful buy, e.g. "SPEED BOOST!"
  cost: number
}

interface Pylon {
  def: PylonDef
  group: THREE.Group
  accent: THREE.Mesh
  accentMat: THREE.MeshBasicMaterial
  tint: THREE.Color // cached full-bright accent colour (multiplied by brightness)
  ring: THREE.Mesh
  haloMat: THREE.MeshBasicMaterial
  icon: THREE.Mesh
  x: number
  z: number
  baseY: number
  phase: number
  cooldown: number // >0 = charging / dimmed, counting down to ready
  flash: number    // 0..1 eased bright pop right after activation
  armed: boolean   // false while the player stays inside; re-arms on exit
}

/** Deterministic PRNG so the pylon layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Upgrade-pylons: glowing buff-stations standing in the neon city that give the
 * player a way to SPEND credits (the economy is income-heavy, sink-light). Walk
 * into one and, if you can afford it and it's ready, it charges credits and grants
 * a timed buff (speed / shield / score x2 / jetpack fuel), flashes bright, then
 * dims onto a cooldown. Auto-activates on proximity; Earth-gated; pooled + disposed.
 */
export class UpgradePylons implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private pylons: Pylon[] = []
  private zone: Zone = 'earth'
  private t = 0
  private readonly reach = 3 // proximity radius (XZ) that triggers a purchase
  private readonly cooldown = 12 // seconds dimmed after a successful buy
  private readonly retry = 3 // short re-prompt gap after a "can't afford"

  // Pre-allocated scratch + per-pylon base tint so the per-frame brightness
  // multiply never allocates a Color.
  private scratch = new THREE.Color()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const defs: PylonDef[] = [
      { kind: 'speed',  tint: 0x49e0ff, css: '#49e0ff', label: 'SPEED BOOST!', cost: 60 },
      { kind: 'shield', tint: 0x9bff6a, css: '#9bff6a', label: 'SHIELD UP!',   cost: 90 },
      { kind: 'score',  tint: 0xffd24a, css: '#ffd24a', label: 'SCORE x2!',    cost: 120 },
      { kind: 'fuel',   tint: 0xb07cff, css: '#b07cff', label: 'JET REFUEL!',  cost: 50 },
    ]
    // Low tier drops the priciest station to keep the count down; high shows all 4.
    const chosen = low ? defs.filter(d => d.kind !== 'score') : defs
    const rnd = mulberry32(91733)
    const reach = config.world.half * 0.5

    // Shared geometry across every pylon; only the column accent material is per-pylon.
    const padGeo = this.ownG(new THREE.CylinderGeometry(1.3, 1.5, 0.25, 20))
    const colGeo = this.ownG(new THREE.CylinderGeometry(0.32, 0.42, 5.4, 6))
    const ringGeo = this.ownG(new THREE.TorusGeometry(0.8, 0.07, 8, 24))
    const iconGeo = this.ownG(new THREE.OctahedronGeometry(0.5, 0))

    const padMat = this.own(new THREE.MeshBasicMaterial({ color: 0x121826, fog: true }))

    for (const def of chosen) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const baseY = this.deps.groundY(x, z)

      const group = new THREE.Group()
      group.position.set(x, baseY, z)

      // Base pad: a dark sci-fi plinth so the column reads as "step here".
      const pad = new THREE.Mesh(padGeo, padMat)
      pad.position.y = 0.12
      group.add(pad)

      // The glowing obelisk column; its emissive accent is dimmed on cooldown.
      const accentMat = this.own(new THREE.MeshBasicMaterial({ color: def.tint, fog: false }))
      const accent = new THREE.Mesh(colGeo, accentMat)
      accent.position.y = 0.25 + 2.7
      group.add(accent)

      // A floating ring + spinning icon above the column, shared additive material.
      const haloMat = this.own(new THREE.MeshBasicMaterial({ color: def.tint, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const ring = new THREE.Mesh(ringGeo, haloMat)
      ring.rotation.x = Math.PI / 2
      ring.position.y = 6.4
      group.add(ring)

      const icon = new THREE.Mesh(iconGeo, haloMat)
      icon.position.y = 6.4
      group.add(icon)

      this.group.add(group)
      this.pylons.push({ def, group, accent, accentMat, tint: new THREE.Color(def.tint), ring, haloMat, icon, x, z, baseY, phase: rnd() * 6.28, cooldown: 0, flash: 0, armed: true })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()

    for (const p of this.pylons) {
      if (p.cooldown > 0) p.cooldown = Math.max(0, p.cooldown - dt)
      if (p.flash > 0) p.flash = Math.max(0, p.flash - dt * 1.6)

      const dx = p.x - f.x, dz = p.z - f.z
      const inside = dx * dx + dz * dz < this.reach * this.reach

      // One entry = one purchase attempt: disarm while inside, re-arm on exit.
      if (!inside) {
        p.armed = true
      } else if (p.armed && p.cooldown <= 0) {
        p.armed = false
        const topY = p.baseY + 5.6
        if (this.deps.spend(p.def.cost)) {
          this.deps.buff(p.def.kind)
          this.deps.notify(p.x, topY, p.z, p.def.label, p.def.css)
          p.flash = 1
          p.cooldown = this.cooldown
        } else {
          this.deps.notify(p.x, topY, p.z, `NEED ${p.def.cost} CR`, '#ff5a5a')
          p.cooldown = this.retry // brief gap so it can't re-prompt every frame
        }
      }

      // Brightness: full when ready, dim on cooldown, blown out on a fresh flash.
      const ready = p.cooldown <= 0 ? 1 : 0
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.4 + p.phase)
      // While charging, run a slow sweep so a cooling pylon reads as "recharging".
      const sweep = ready ? 0 : 0.12 * (0.5 + 0.5 * Math.sin(this.t * 5 + p.phase))
      const base = ready ? 0.55 + pulse * 0.35 : 0.16 + sweep
      const lvl = Math.min(1, base + p.flash * 1.2)
      this.scratch.copy(p.tint).multiplyScalar(lvl)
      p.accentMat.color.copy(this.scratch)

      // Halo (ring + icon) share this pylon's additive material.
      p.haloMat.opacity = (ready ? 0.55 : 0.22) + pulse * 0.2 + p.flash * 0.5

      // Float + spin the icon, slow-rotate the ring; tiny bob on the whole halo.
      const bob = Math.sin(this.t * 1.6 + p.phase) * 0.18
      p.icon.position.y = 6.4 + bob
      p.icon.rotation.y += dt * 1.4
      p.icon.rotation.x += dt * 0.8
      p.ring.position.y = 6.4 + bob * 0.5
      p.ring.rotation.z += dt * 0.9
      const s = 1 + p.flash * 0.4 + pulse * 0.05
      p.icon.scale.setScalar(s)
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
