import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

/**
 * A friendly roaming vendor drone that drifts the Earth city carrying a glowing
 * market stall. A MOBILE credit sink with a treasure-hunt feel: spot it, walk up,
 * and it sells the current cycling buff (speed/shield/score/fuel) for credits, then
 * restocks a different item and wanders on. Earth-gated, shared geos, pooled + disposed.
 */
export class WanderingMerchant implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private zone: Zone = 'earth'
  private t = 0
  private rnd = mulberry32(0x5a1e07)

  // Movement state.
  private pos = new THREE.Vector3()
  private target = new THREE.Vector3()
  private speed = 5.5
  private yaw = 0

  // Stock / sale state.
  private stockIdx = 0
  private armed = true       // re-arms when player is far; disarms on a buy attempt
  private cooldown = 0       // >0 after a sale: drift away before selling again
  private flash = 0          // 0..1 bright pop right after a successful sale

  private readonly reach = 3   // XZ buy radius
  private readonly disarmR = 8 // re-arm once the player is at least this far
  private readonly saleCool = 6
  private readonly retry = 2.5

  // Scene refs whose appearance changes per frame.
  private waresMat!: THREE.MeshBasicMaterial
  private wares!: THREE.Mesh
  private lanternMat!: THREE.MeshBasicMaterial
  private canopyMat!: THREE.MeshBasicMaterial
  private signMat!: THREE.MeshBasicMaterial
  private signTexCtx!: CanvasRenderingContext2D
  private signTex!: THREE.CanvasTexture

  // Pre-allocated scratch (no per-frame heap allocation).
  private dir = new THREE.Vector3()
  private scratch = new THREE.Color()

  private static readonly STOCK: StockDef[] = [
    { kind: 'speed',  tint: 0x49e0ff, css: '#49e0ff', label: 'SOLD: SPEED BOOST!', cost: 70 },
    { kind: 'shield', tint: 0x9bff6a, css: '#9bff6a', label: 'SOLD: SHIELD UP!',   cost: 100 },
    { kind: 'score',  tint: 0xffd24a, css: '#ffd24a', label: 'SOLD: SCORE x2!',    cost: 130 },
    { kind: 'fuel',   tint: 0xb07cff, css: '#b07cff', label: 'SOLD: JET REFUEL!',  cost: 60 },
  ]

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    // Pick a first stock item + starting position/waypoint.
    this.stockIdx = Math.floor(this.rnd() * WanderingMerchant.STOCK.length)
    this.scatter(this.pos)
    this.scatter(this.target)

    // Shared geometries.
    const hullGeo = this.ownG(new THREE.SphereGeometry(0.8, 16, 12))
    const ringGeo = this.ownG(new THREE.TorusGeometry(0.95, 0.08, 8, 24))
    const poleGeo = this.ownG(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6))
    const canopyGeo = this.ownG(new THREE.ConeGeometry(1.7, 0.9, 10, 1, true))
    const lanternGeo = this.ownG(new THREE.SphereGeometry(0.22, 10, 8))
    const waresGeo = this.ownG(new THREE.OctahedronGeometry(0.42, 0))
    const signGeo = this.ownG(new THREE.PlaneGeometry(1.4, 0.7))

    // Shared materials. Hull is lit metal; everything glowy is additive basic.
    const hullMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2b3552, metalness: 0.6, roughness: 0.45, emissive: 0x0a1428, emissiveIntensity: 0.5 }))
    const ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0x6fe7ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const poleMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1c2438, metalness: 0.5, roughness: 0.6 }))
    this.canopyMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffcf6a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }))
    this.lanternMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd07a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.waresMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    // Body group (faces direction of travel).
    const body = new THREE.Group()

    // Floating hull with an orbiting accent ring underneath the canopy.
    const hull = new THREE.Mesh(hullGeo, hullMat)
    hull.scale.set(1, 0.7, 1)
    body.add(hull)
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = Math.PI / 2
    ring.position.y = -0.1
    body.add(ring)

    // A pole up to the market canopy (umbrella).
    const pole = new THREE.Mesh(poleGeo, poleMat)
    pole.position.y = 1.1
    body.add(pole)
    const canopy = new THREE.Mesh(canopyGeo, this.canopyMat)
    canopy.position.y = 2.0
    body.add(canopy)

    // A swinging lantern hung off a little arm.
    const lantern = new THREE.Mesh(lanternGeo, this.lanternMat)
    lantern.position.set(0.85, 0.7, 0)
    body.add(lantern)

    this.body = body
    this.group.add(body)

    // Floating wares icon + price sign hovering above (NOT inside the body group,
    // so the sign can be left un-rotated/billboard-ish and read cleanly).
    this.wares = new THREE.Mesh(waresGeo, this.waresMat)
    this.wares.position.y = 3.3
    this.group.add(this.wares)

    // Price sign as a small CanvasTexture (redrawn only on restock, not per frame).
    const cv = document.createElement('canvas')
    cv.width = 256; cv.height = 128
    this.signTexCtx = cv.getContext('2d')!
    this.signTex = new THREE.CanvasTexture(cv)
    this.signTex.anisotropy = 2
    this.texs.push(this.signTex)
    this.signMat = this.own(new THREE.MeshBasicMaterial({ map: this.signTex, transparent: true, depthWrite: false, fog: false }))
    this.sign = new THREE.Mesh(signGeo, this.signMat)
    this.sign.position.y = 4.1
    this.group.add(this.sign)

    this.redrawSign()
    this.applyTint()

    this.group.visible = false
    scene.add(this.group)
  }

  private body!: THREE.Group
  private sign!: THREE.Mesh

  /** Pick a wander waypoint within the city, writing into `out`. */
  private scatter(out: THREE.Vector3) {
    const reach = config.world.half * 0.6
    out.set((this.rnd() * 2 - 1) * reach, 0, (this.rnd() * 2 - 1) * reach)
  }

  /** Tint the glowy wares/canopy/sign to the current stock colour. */
  private applyTint() {
    const def = WanderingMerchant.STOCK[this.stockIdx]
    this.waresMat.color.set(def.tint)
    // Keep the sign panel readable: tint it but not too dark.
    this.scratch.set(def.tint)
    this.signMat.color.copy(this.scratch)
  }

  /** Redraw the price sign canvas (only called on restock). */
  private redrawSign() {
    const def = WanderingMerchant.STOCK[this.stockIdx]
    const ctx = this.signTexCtx
    ctx.clearRect(0, 0, 256, 128)
    ctx.fillStyle = 'rgba(8,12,20,0.78)'
    roundRect(ctx, 6, 6, 244, 116, 14)
    ctx.fill()
    ctx.lineWidth = 4
    ctx.strokeStyle = def.css
    roundRect(ctx, 6, 6, 244, 116, 14)
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillStyle = def.css
    ctx.font = 'bold 40px sans-serif'
    ctx.fillText(KIND_NAME[def.kind], 128, 54)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 34px sans-serif'
    ctx.fillText(`${def.cost} CR`, 128, 98)
    this.signTex.needsUpdate = true
  }

  /** Move to a fresh, different stock item and drift onward. */
  private restock() {
    let next = this.stockIdx
    while (next === this.stockIdx) next = Math.floor(this.rnd() * WanderingMerchant.STOCK.length)
    this.stockIdx = next
    this.applyTint()
    this.redrawSign()
    this.scatter(this.target) // head somewhere new after a sale
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    // Drive visibility from the zone each frame (setZone only fires on a change,
    // and the game begins on Earth).
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt)
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 1.6)

    // --- Wander toward the current waypoint, hovering above local ground. ---
    this.dir.subVectors(this.target, this.pos)
    this.dir.y = 0
    const dist = this.dir.length()
    if (dist < 1.5) {
      this.scatter(this.target)
    } else {
      this.dir.multiplyScalar(1 / dist) // normalize without allocating
      const step = Math.min(dist, this.speed * dt)
      this.pos.addScaledVector(this.dir, step)
      const want = Math.atan2(this.dir.x, this.dir.z)
      let turn = want - this.yaw
      while (turn > Math.PI) turn -= Math.PI * 2
      while (turn < -Math.PI) turn += Math.PI * 2
      this.yaw += turn * Math.min(1, dt * 3)
    }

    // Hover height: a low float above the sampled ground at the current XZ.
    const groundY = this.deps.groundY(this.pos.x, this.pos.z)
    const bob = Math.sin(this.t * 1.8) * 0.18
    const hoverY = groundY + 2.5 + bob
    this.group.position.set(this.pos.x, hoverY, this.pos.z)
    this.body.rotation.y = this.yaw + this.t * 0.25 // gentle spin so it feels alive

    // --- Purchase: one approach = one attempt (armed gate + post-sale cooldown). ---
    const f = this.deps.focus()
    const dx = this.pos.x - f.x, dz = this.pos.z - f.z
    const d2 = dx * dx + dz * dz
    if (d2 > this.disarmR * this.disarmR) this.armed = true
    else if (this.armed && this.cooldown <= 0 && d2 < this.reach * this.reach) {
      this.armed = false
      const def = WanderingMerchant.STOCK[this.stockIdx]
      const labelY = hoverY + 3
      if (this.deps.spend(def.cost)) {
        this.deps.buff(def.kind)
        this.deps.notify(this.pos.x, labelY, this.pos.z, def.label, def.css)
        this.flash = 1
        this.cooldown = this.saleCool
        this.restock()
      } else {
        this.deps.notify(this.pos.x, labelY, this.pos.z, `NEED ${def.cost} CR`, '#ff5a5a')
        this.cooldown = this.retry // brief gap so it can't re-prompt every frame
      }
    }

    // --- Liveliness: pulse the wares + canopy + lantern, blow out on a sale. ---
    const def = WanderingMerchant.STOCK[this.stockIdx]
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3)
    this.waresMat.opacity = 0.7 + pulse * 0.25 + this.flash * 0.5
    this.canopyMat.opacity = 0.7 + pulse * 0.15 + this.flash * 0.4
    this.lanternMat.opacity = 0.75 + (0.5 + 0.5 * Math.sin(this.t * 5)) * 0.2

    // Float + spin the wares icon; scale-pop on flash.
    this.wares.rotation.y += dt * 1.6
    this.wares.rotation.x += dt * 0.9
    this.wares.scale.setScalar(1 + this.flash * 0.5 + pulse * 0.06)

    // Brighten the wares colour on a fresh sale flash.
    this.scratch.set(def.tint).multiplyScalar(1 + this.flash * 0.8)
    this.waresMat.color.copy(this.scratch)
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
  }
}

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ so the merchant hovers above the floor. */
  groundY: (x: number, z: number) => number
  /** Current player credit balance. */
  credits: () => number
  /** Attempt to charge `cost` credits; returns true if the player could pay. */
  spend: (cost: number) => boolean
  /** Grant the timed buff this sale offers. */
  buff: (kind: BuffKind) => void
  /** Pop a floating feedback label at a world point in a CSS colour string. */
  notify: (x: number, y: number, z: number, label: string, color: string) => void
}

type BuffKind = 'speed' | 'shield' | 'score' | 'fuel'

interface StockDef {
  kind: BuffKind
  tint: number
  css: string
  label: string // shown on a successful sale, e.g. "SOLD: SPEED BOOST!"
  cost: number
}

const KIND_NAME: Record<BuffKind, string> = {
  speed: 'SPEED',
  shield: 'SHIELD',
  score: 'SCORE x2',
  fuel: 'JET FUEL',
}

/** Rounded-rect path helper for the price sign canvas. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Deterministic PRNG so the merchant's route is stable per load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
