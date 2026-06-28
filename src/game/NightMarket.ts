import * as THREE from 'three'
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  groundY: (x: number, z: number) => number
  /** Day/night factor: ~1 day, ~0 night (Earth only). */
  dayFactor: () => number
}

interface Lantern {
  mesh: THREE.Mesh
  baseY: number
  phase: number
  bob: number
}

const NIGHT_AT = 0.55 // dayFactor below this begins to light the market
const FULL_AT = 0.35 // fully lit at/below this dayFactor

// Shared constant axes/quaternion used while baking part transforms (no alloc).
const YAXIS = new THREE.Vector3(0, 1, 0)
const XAXIS = new THREE.Vector3(1, 0, 0)
const IDENTQ = new THREE.Quaternion()

/** Deterministic PRNG so the market layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Night-market district for the Earth city: a fixed cluster of striped canopy
 * vendor stalls with hanging lanterns, holographic price signs and warm glowing
 * wares. Comes alive at night (lanterns/signs/wares glow + gently flicker) and
 * powers down by day. Pure atmosphere - no colliders, no gameplay. Shared geos,
 * a few shared glow materials faded by one night opacity per frame, Earth-gated.
 */
export class NightMarket implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private lanterns: Lantern[] = []
  // Shared glow materials whose opacity is driven by the night factor each frame.
  private lanternMat: THREE.MeshBasicMaterial
  private signMats: THREE.MeshBasicMaterial[] = []
  private waresMat: THREE.MeshBasicMaterial
  private stringMat: THREE.LineBasicMaterial
  private zone: Zone = 'earth'
  private t = 0

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private ownT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const count = low ? 6 : 10
    const rnd = mulberry32(72109)

    // Fixed district centre, offset from city centre but well within the city.
    const cx = config.world.half * 0.35
    const cz = config.world.half * -0.3

    // Awning tints, cycled across the stalls for a varied market look.
    const awnings = [0xff4ec7, 0x49e0ff, 0xffd24a, 0x9bff6a, 0xb07cff, 0xff6a4a]
    const signWords = ['RAMEN', 'PARTS', 'FUEL CELLS', 'CHIPS', 'TEA', 'NOODLES']

    // --- Shared geometries (one of each, reused by every stall) ---
    const canopyGeo = this.ownG(new THREE.BoxGeometry(3.2, 0.18, 2.4))
    const postGeo = this.ownG(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 6))
    const counterGeo = this.ownG(new THREE.BoxGeometry(3.0, 0.5, 1.0))
    const wareGeo = this.ownG(new THREE.SphereGeometry(0.16, 8, 6))
    const lanternGeo = this.ownG(new THREE.SphereGeometry(0.13, 8, 6))
    const signGeo = this.ownG(new THREE.PlaneGeometry(1.6, 0.5))

    // --- Shared structural (non-glow) materials ---
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.8, metalness: 0.3 }))
    const counterMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.7, metalness: 0.4 }))
    // Per-tint canopy materials (small fixed set, one per awning colour).
    const canopyMats = awnings.map((c) => this.own(new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.1, emissive: new THREE.Color(c), emissiveIntensity: 0.15 })))

    // --- Shared glow materials (night-faded once per frame) ---
    this.lanternMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffb86a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.waresMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.stringMat = this.own(new THREE.LineBasicMaterial({ color: 0x4a3a2a, transparent: true, opacity: 0, fog: false }))
    // One sign material per word (each carries its own CanvasTexture), shared night opacity.
    for (let s = 0; s < signWords.length; s++) {
      const tint = awnings[s % awnings.length]
      const tex = this.ownT(this.drawSign(signWords[s], '#' + new THREE.Color(tint).getHexString()))
      this.signMats.push(this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })))
    }

    // Scratch reused across the layout loop (no per-iteration Vector3 allocation).
    const sp = new THREE.Vector3()
    // Scratch matrices/quaternion for baking child local transforms into the
    // stall transform (no per-part allocation; reused every push()).
    const stallMat = new THREE.Matrix4()
    const childMat = new THREE.Matrix4()
    const bakeMat = new THREE.Matrix4()
    const bq = new THREE.Quaternion()
    const bs = new THREE.Vector3(1, 1, 1)

    // Merge buckets: one list of baked geometry clones per material. Every static
    // (non-per-frame-transformed) part is baked into market-group space here and
    // merged into a single mesh per material at the end of the constructor, so the
    // whole market draws in a handful of calls instead of ~150.
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>()
    const bake = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      // childMat holds the part's local transform (set by callers via the helpers
      // below); compose with the current stall transform, then bake into a clone.
      bakeMat.multiplyMatrices(stallMat, childMat)
      const g = geo.clone()
      g.applyMatrix4(bakeMat)
      let list = buckets.get(mat)
      if (!list) { list = []; buckets.set(mat, list) }
      list.push(g)
    }
    // String segments share one material across the whole market: collect baked
    // line-segment endpoint pairs and emit a single LineSegments at the end.
    const stringPositions: number[] = []
    const segP = new THREE.Vector3()

    for (let i = 0; i < count; i++) {
      // Loose rows/cluster layout: a couple of rows, jittered, around the centre.
      const cols = low ? 3 : 5
      const colW = 6.0
      const rowD = 6.5
      const col = i % cols
      const row = (i / cols) | 0
      const jx = (rnd() * 2 - 1) * 1.4
      const jz = (rnd() * 2 - 1) * 1.4
      const x = cx + (col - (cols - 1) / 2) * colW + jx
      const z = cz + (row - 0.5) * rowD + jz

      const gy = this.deps.groundY(x, z)
      const ry = (rnd() * 2 - 1) * 0.35
      // Stall transform (was a Group): position + Y rotation. Baked into each
      // static part's geometry so all stalls collapse into shared merged meshes.
      bq.setFromAxisAngle(YAXIS, ry)
      sp.set(x, gy, z)
      stallMat.compose(sp, bq, bs)

      const tintIdx = i % awnings.length
      const counterH = 1.0
      const postH = 2.2
      const canopyY = postH + 0.1

      // Counter slab.
      childMat.makeTranslation(0, counterH * 0.5, 0)
      bake(counterGeo, counterMat)

      // Support posts (2-4) at the corners of the canopy footprint.
      const nPosts = 2 + ((rnd() * 3) | 0)
      const px = 1.4, pz = 1.0
      const cornerX = [px, -px, px, -px]
      const cornerZ = [pz, pz, -pz, -pz]
      for (let p = 0; p < nPosts; p++) {
        childMat.makeTranslation(cornerX[p], postH * 0.5, cornerZ[p])
        bake(postGeo, postMat)
      }

      // Canopy (slightly peaked: tilt it a touch for a peaked-awning read).
      bq.setFromAxisAngle(XAXIS, (rnd() * 2 - 1) * 0.08)
      sp.set(0, canopyY, 0)
      childMat.compose(sp, bq, bs)
      bake(canopyGeo, canopyMats[tintIdx])

      // Glowing wares on the counter (a few small additive spheres).
      const nWares = 3 + ((rnd() * 3) | 0)
      for (let w = 0; w < nWares; w++) {
        sp.set((rnd() * 2 - 1) * 1.1, counterH + 0.16, (rnd() * 2 - 1) * 0.35)
        bs.setScalar(0.7 + rnd() * 0.8)
        childMat.compose(sp, IDENTQ, bs)
        bs.setScalar(1)
        bake(wareGeo, this.waresMat)
      }

      // Holographic price/sign plane, hung at the canopy front edge.
      childMat.makeTranslation(0, canopyY - 0.5, pz + 0.05)
      bake(signGeo, this.signMats[i % this.signMats.length])

      // String of hanging lanterns spanning the canopy front (post to post).
      const nLanterns = low ? 3 : 4
      const lanternY = canopyY - 0.35
      const x0 = -px, x1 = px
      // String line behind the lanterns (a sagging poly-line). Baked into the
      // shared market-wide LineSegments as consecutive endpoint pairs.
      for (let s = 0; s < nLanterns; s++) {
        const f0 = s / nLanterns, f1 = (s + 1) / nLanterns
        const lx0 = x0 + (x1 - x0) * f0, lx1 = x0 + (x1 - x0) * f1
        const sag0 = Math.sin(f0 * Math.PI) * 0.18, sag1 = Math.sin(f1 * Math.PI) * 0.18
        segP.set(lx0, lanternY + 0.1 - sag0, pz + 0.02).applyMatrix4(stallMat)
        stringPositions.push(segP.x, segP.y, segP.z)
        segP.set(lx1, lanternY + 0.1 - sag1, pz + 0.02).applyMatrix4(stallMat)
        stringPositions.push(segP.x, segP.y, segP.z)
      }

      for (let s = 0; s < nLanterns; s++) {
        const f = (s + 0.5) / nLanterns
        const lx = x0 + (x1 - x0) * f
        const sag = Math.sin(f * Math.PI) * 0.18
        const ly = lanternY - sag
        // Lanterns bob in Y per frame, so they cannot be merged; keep them as
        // individual meshes. Bake the stall transform (which is pure Y rotation +
        // translation, so it preserves world Y) into the base position.
        sp.set(lx, ly, pz + 0.02).applyMatrix4(stallMat)
        const lantern = new THREE.Mesh(lanternGeo, this.lanternMat)
        lantern.position.copy(sp)
        lantern.rotation.y = ry
        lantern.scale.setScalar(0.8 + rnd() * 0.6)
        this.group.add(lantern)
        this.lanterns.push({ mesh: lantern, baseY: sp.y, phase: rnd() * 6.28, bob: 0.03 + rnd() * 0.04 })
      }
    }

    // --- Merge each material bucket into a single mesh added to the group. ---
    for (const [mat, geos] of buckets) {
      const merged = BufferGeometryUtils.mergeGeometries(geos, false)
      for (const g of geos) g.dispose() // temp clones, no longer needed
      if (!merged) continue
      this.ownG(merged)
      this.group.add(new THREE.Mesh(merged, mat))
    }

    // Single LineSegments for every stall's lantern string (one draw, one mat).
    if (stringPositions.length) {
      const sg = this.ownG(new THREE.BufferGeometry())
      sg.setAttribute('position', new THREE.Float32BufferAttribute(stringPositions, 3))
      this.group.add(new THREE.LineSegments(sg, this.stringMat))
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Draw a neon market sign word to a canvas ONCE; returns a CanvasTexture. */
  private drawSign(word: string, tint: string): THREE.CanvasTexture {
    const w = 256, h = 80
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(6,10,22,0.5)'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = tint
    ctx.shadowColor = tint
    ctx.shadowBlur = 12
    ctx.lineWidth = 3
    ctx.strokeRect(6, 6, w - 12, h - 12)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowBlur = 18
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 38px sans-serif'
    ctx.fillText(word, w / 2, h / 2 + 2, w - 24)
    ctx.shadowBlur = 24
    ctx.fillStyle = tint
    ctx.globalAlpha = 0.7
    ctx.fillText(word, w / 2, h / 2 + 2, w - 24)
    ctx.globalAlpha = 1
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    tex.needsUpdate = true
    return tex
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const onEarth = this.zone === 'earth'
    if (!onEarth) { if (this.group.visible) this.group.visible = false; return }
    if (!this.group.visible) this.group.visible = true

    const day = this.deps.dayFactor()
    // night: 0 by day (>= NIGHT_AT), ramping to 1 at/below FULL_AT.
    const night = THREE.MathUtils.clamp((NIGHT_AT - day) / (NIGHT_AT - FULL_AT), 0, 1)

    this.t += dt
    // Subtle global flicker so the whole market shimmers together (cheap).
    const flick = 0.92 + 0.08 * Math.sin(this.t * 9.0) + 0.04 * Math.sin(this.t * 23.0)
    const g = night * flick

    // Shared glow materials: one night-faded opacity write each per frame.
    this.lanternMat.opacity = g * 0.95
    this.waresMat.opacity = g * 0.8
    this.stringMat.opacity = night * 0.4
    for (const m of this.signMats) m.opacity = g * 0.85

    // Per-lantern bob (no allocation: scalar writes only).
    for (const l of this.lanterns) {
      l.mesh.position.y = l.baseY + Math.sin(this.t * 1.4 + l.phase) * l.bob
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
  }
}
