import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Local player position - the sweep curtain is centred on the player's XZ
   *  column (offset along the sweep axis) so it never runs out of map. */
  playerPos: () => THREE.Vector3
  /** Current zone, so we hard-gate to Mars each update (group.visible). */
  zone: () => Zone
}

/** Deterministic PRNG so per-billboard jitter is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** Per-billboard static layout (filled once from the seed, never re-allocated). */
interface Billboard {
  along: number // signed position along the sweep axis (curtain-local, metres)
  cross: number // signed position across the sweep axis (curtain-local, metres)
  up: number // height above the surface (metres)
  scale: number // billboard size multiplier
  phase: number // drift/flicker phase offset (radians)
  driftR: number // drift radius for in-curtain jitter (metres)
}

const TWO_PI = Math.PI * 2

/**
 * Mars-only ground-level weather: a sweeping rust dust storm. Renders in ~2 draws
 * - one additive InstancedMesh of large soft dust billboards (a shared quad mapped
 * with a radial-falloff rust canvas texture drawn ONCE) plus one faint haze plane
 * in front of the curtain. A slow weather cycle alternates a long CALM (curtain
 * hidden, zero opacity) with a SWEEP where the dust wall advances across the play
 * area, crossing the player's column, then eases back to calm. The curtain is
 * always centred on the player's XZ (offset along the sweep axis) so it never runs
 * out of map, giving Mars real ground-level weather the static sky dust-wall can't.
 *
 * Mars-gated (hidden elsewhere) and tier-gated counts (low 12 / medium 24 /
 * high 40). config.reducedMotion is read LIVE: it caps peak opacity to ~40%, slows
 * the sweep and drops the per-billboard flicker so it reads as a calm passing haze,
 * never a hard flash. Per-instance matrices come from a single reused scratch
 * Matrix4 (no per-frame heap allocation). Render-only - never touches the sim, and
 * NEVER mutates scene.fog or any global state: this is a self-contained visual
 * curtain, so it can't leak across zones. Disposed together (geo, materials, the
 * canvas texture in texs[], instancedMesh.dispose()).
 */
export class SandStorm implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private bills: Billboard[] = []
  private zone: Zone = 'earth'
  private t = 0

  // Sweep axis (unit XZ direction the curtain advances along) and its cross axis.
  private readonly axisX = 1
  private readonly axisZ = 0
  private readonly crossX = 0
  private readonly crossZ = 1

  // Weather cycle timing (seconds). CALM then SWEEP, repeating.
  private readonly calmDur = 26 // long quiet stretch with no storm
  private readonly sweepDur = 9 // curtain crosses the play area
  private readonly span = 130 // sweep travel half-extent along the axis (metres)

  private dustMesh!: THREE.InstancedMesh
  private dustMat!: THREE.MeshBasicMaterial
  private haze!: THREE.Mesh
  private hazeMat!: THREE.MeshBasicMaterial

  // Reused scratch - no per-frame heap allocation.
  private mInst = new THREE.Matrix4()
  private pos = new THREE.Vector3()
  private quat = new THREE.Quaternion()
  private scl = new THREE.Vector3()
  private eul = new THREE.Euler()
  private cScratch = new THREE.Color()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const name = config.tier.name
    // Tier-gated count: low is a thinner single layer, full curtain on high.
    const n = name === 'low' ? 12 : name === 'medium' ? 24 : 40
    const rnd = mulberry32(815523)

    // Radial-falloff rust dust puff, drawn ONCE into a canvas texture (tracked in
    // texs[] for disposal). White core => additive blend; rust tint comes from the
    // shared material colour, so we can recolour without redrawing.
    const tex = this.makeDustTexture()
    this.texs.push(tex)

    // Shared soft quad for every billboard.
    const quad = this.ownG(new THREE.PlaneGeometry(1, 1))

    this.dustMat = this.own(new THREE.MeshBasicMaterial({
      map: tex,
      color: 0x9a4a28, // Mars rust
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    }))

    // Layout each billboard once: spread across the curtain's cross axis, varied
    // height/size, with a small drift radius + phase for in-curtain jitter. low =
    // a thinner single layer (less depth along the axis).
    const layers = name === 'low' ? 1 : name === 'medium' ? 2 : 3
    const crossSpread = 90 // half-width of the curtain across the play area
    const depthSpread = name === 'low' ? 4 : 14 // billboard scatter along the axis
    for (let i = 0; i < n; i++) {
      const layer = i % layers
      this.bills.push({
        along: (layer - (layers - 1) / 2) * (depthSpread / Math.max(1, layers)) + (rnd() * 2 - 1) * 3,
        cross: (rnd() * 2 - 1) * crossSpread,
        up: 1.5 + rnd() * 16,
        scale: 14 + rnd() * 22,
        phase: rnd() * TWO_PI,
        driftR: 0.6 + rnd() * 1.8,
      })
    }

    this.dustMesh = new THREE.InstancedMesh(quad, this.dustMat, n)
    // One curtain spanning the whole front - skip culling, still one draw.
    this.dustMesh.frustumCulled = false
    this.dustMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.group.add(this.dustMesh)

    // One big faint haze plane riding just in front of the curtain front, so the
    // wall reads as a solid sheet of dust rather than discrete puffs.
    const hazeGeo = this.ownG(new THREE.PlaneGeometry(crossSpread * 2.4, 60))
    this.hazeMat = this.own(new THREE.MeshBasicMaterial({
      color: 0x9a4a28,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    }))
    this.haze = new THREE.Mesh(hazeGeo, this.hazeMat)
    this.haze.frustumCulled = false
    this.group.add(this.haze)

    this.group.visible = false
    scene.add(this.group)
  }

  /** Draw the radial rust-puff sprite ONCE; reused by every billboard instance. */
  private makeDustTexture(): THREE.Texture {
    const s = 128
    const c = document.createElement('canvas')
    c.width = c.height = s
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    // Soft falloff: bright-ish core fading to nothing at the rim (additive friendly).
    g.addColorStop(0, 'rgba(255,255,255,0.85)')
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)')
    g.addColorStop(0.7, 'rgba(255,255,255,0.12)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, s, s)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'mars'
  }

  update(dt: number) {
    // Hard zone gate each update: Mars-only.
    const active = this.deps.zone() === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return
    this.t += dt

    // LIVE accessibility read (render/FX only - never the sim).
    const calm = config.reducedMotion
    const peakOpacity = calm ? 0.4 : 1
    // Slow the whole cycle under reduced motion so it drifts past gently.
    const cycle = (calm ? 1.5 : 1) * (this.calmDur + this.sweepDur)
    const phaseT = this.t % cycle

    // Weather phase machine: long CALM, then a SWEEP across the play area.
    const calmDur = (calm ? 1.5 : 1) * this.calmDur
    let sweep = 0 // 0 in calm; 0..1 progress through the sweep
    let intensity = 0 // 0 hidden, 1 curtain dead-centre over the player
    if (phaseT > calmDur) {
      sweep = (phaseT - calmDur) / ((calm ? 1.5 : 1) * this.sweepDur)
      // Ease-in/ease-out envelope so the wall fades up as it arrives and fades
      // out as it leaves - never a hard flash, even in normal mode.
      intensity = Math.sin(sweep * Math.PI)
    }

    const f = this.deps.playerPos()
    // Curtain centre advances from -span to +span along the sweep axis, crossing
    // the player's column (offset 0) near the middle of the sweep.
    const along = (sweep * 2 - 1) * this.span
    const baseX = f.x + this.axisX * along
    const baseZ = f.z + this.axisZ * along

    // Face the whole curtain toward the player (cheap group-level billboarding).
    this.group.position.set(0, 0, 0)
    this.dustMesh.position.set(0, 0, 0)

    const flicker = calm ? 0 : 1 // skip per-billboard flicker under reduced motion
    let any = false
    for (let i = 0; i < this.bills.length; i++) {
      const b = this.bills[i]
      // World position of this billboard within the advancing curtain.
      const drift = flicker ? Math.sin(this.t * 0.9 + b.phase) * b.driftR : 0
      const along2 = along + b.along * 0.5
      const wx = f.x + this.axisX * along2 + this.crossX * (b.cross + drift)
      const wz = f.z + this.axisZ * along2 + this.crossZ * (b.cross + drift)
      const wy = b.up + (flicker ? Math.sin(this.t * 0.7 + b.phase * 1.3) * 1.2 : 0)
      // Yaw the quad to face the player (axis-billboarded about Y is enough).
      const yaw = Math.atan2(f.x - wx, f.z - wz)
      this.pos.set(wx, wy, wz)
      this.quat.setFromEuler(this.eul.set(0, yaw, 0, 'XYZ'))
      this.scl.setScalar(b.scale)
      this.mInst.compose(this.pos, this.quat, this.scl)
      this.dustMesh.setMatrixAt(i, this.mInst)

      // Per-instance brightness = curtain intensity * peak cap * gentle flicker.
      const flick = flicker ? 0.85 + 0.15 * Math.sin(this.t * 2.3 + b.phase) : 1
      const bright = intensity * peakOpacity * flick * 0.5
      this.cScratch.setScalar(bright)
      this.dustMesh.setColorAt(i, this.cScratch)
      any = true
    }
    if (any) {
      this.dustMesh.instanceMatrix.needsUpdate = true
      this.dustMesh.instanceColor!.needsUpdate = true
    }

    // Faint haze sheet riding just in front of the curtain front, facing the player.
    const hx = baseX + this.axisX * 8
    const hz = baseZ + this.axisZ * 8
    this.haze.position.set(hx, 12, hz)
    this.haze.rotation.y = Math.atan2(f.x - hx, f.z - hz)
    this.hazeMat.opacity = intensity * peakOpacity * 0.12
  }

  dispose() {
    this.dustMesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
    this.geos.length = 0
    this.mats.length = 0
    this.texs.length = 0
    this.bills.length = 0
    if (this.group.parent) this.group.parent.remove(this.group)
  }
}
