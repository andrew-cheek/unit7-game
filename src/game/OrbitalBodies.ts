import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the distant bodies anchor to wherever you are looking from. */
  focus: () => THREE.Vector3
  /** Current zone, re-read every update so the group stays correctly hidden. */
  zone: () => Zone
}

/** Deterministic PRNG so crater fields are identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * One distant celestial body anchored to the player's focus so it reads as
 * infinitely far away. The body sits at a fixed bearing + high Y; its XZ is
 * lerped to track focus.x/z (parallax-free anchoring), and it spins very slowly.
 */
interface Body {
  /** The pivot that follows focus. Children (sphere, halo) hang off it. */
  pivot: THREE.Group
  /** Fixed offset from the focus point (bearing direction * distance, fixed high Y). */
  ox: number; oy: number; oz: number
  /** Self-rotation rate (rad/sec) applied to the body mesh. */
  spin: number
  /** The visible body, spun in place. */
  body: THREE.Mesh
  /** Optional additive halo material to pulse (high tier only). null otherwise. */
  halo: THREE.MeshBasicMaterial | null
  /** Per-body phase so halos don't pulse in lockstep. */
  phase: number
}

/**
 * Off-world sky bodies with anchored parallax. Pure additive set-dressing that
 * hangs distant celestial objects in the black/dust sky and keeps them locked to
 * the player's focus so they read as infinitely far away:
 *
 *   MOON: a large blue-marble Earth (procedural canvas texture) with a soft
 *         atmosphere halo, plus a small bright distant Sun.
 *   MARS: two tiny cratered moons (Phobos/Deimos) drifting over the horizon,
 *         plus a smaller, dimmer warm Sun.
 *
 * Each body lerps its XZ toward focus.x/z (so it never gets closer/further as you
 * move), keeps a fixed high Y + bearing, and spins very slowly. Tier-gated:
 *   high   - all bodies + soft additive halos, halo pulse
 *   medium - all bodies, anchored parallax, NO extra halos
 *   low    - static positions (no per-frame anchor), no halos
 *
 * Both zones gated: moon bodies show only on the Moon, mars bodies only on Mars,
 * everything hidden on Earth. No colliders, no rewards, no gameplay. Disposed
 * together (geometries, materials AND the canvas textures).
 *
 * Constructor: (scene: THREE.Scene, deps: { focus: () => THREE.Vector3; zone: () => Zone })
 */
export class OrbitalBodies implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private moonBodies: Body[] = []
  private marsBodies: Body[] = []
  private zone: Zone = 'earth'
  private t = 0
  // Scratch focus, reused each frame so we never allocate in update().
  private focus = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private ownT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const low = tier === 'low'
    const high = tier === 'high'
    // Halos cost extra additive draws; high tier only.
    const halos = high

    // --- MOON: big Earth + bright distant Sun ---
    {
      // Earth: procedural blue-marble canvas texture, far out and high.
      const earth = this.makeEarthBody(150, 110, -260, 70, halos)
      this.moonBodies.push(earth)
      // Sun: small, bright, emissive disc with a tight halo on high.
      const sun = this.makeStarBody(0xfff6e0, -210, 150, -180, 9, halos, halos ? 2.2 : 0)
      this.moonBodies.push(sun)
    }

    // --- MARS: twin cratered moons + smaller warm Sun ---
    {
      // Phobos: closer, larger, low over the horizon.
      const phobos = this.makeCrateredMoon(0xc6b09a, 190, 96, -250, 8, 412001, halos)
      this.marsBodies.push(phobos)
      // Deimos: further, smaller, higher.
      const deimos = this.makeCrateredMoon(0x9a8a78, -150, 150, -300, 4.5, 778203, halos)
      this.marsBodies.push(deimos)
      // Warm, dimmer distant Sun (Mars is further from the Sun -> smaller disc).
      const sun = this.makeStarBody(0xffcaa0, 220, 140, -160, 6.5, halos, halos ? 1.6 : 0)
      this.marsBodies.push(sun)
    }

    // Slower anchoring / no anchoring on low; we tune via a flag read in update().
    this.staticPos = low

    this.group.visible = false
    scene.add(this.group)
  }

  /** When true (low tier), bodies hold their seeded position - no per-frame anchor. */
  private staticPos = false

  /** Big Earth: blue-marble canvas texture + optional additive atmosphere halo. */
  private makeEarthBody(ox: number, oy: number, oz: number, radius: number, halo: boolean): Body {
    const pivot = new THREE.Group()
    pivot.position.set(ox, oy, oz)
    this.group.add(pivot)

    // Procedural blue-marble texture (oceans + land + clouds + ice caps).
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 256
    const ctx = cv.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 0, 256)
    g.addColorStop(0, '#0a2a5e'); g.addColorStop(0.5, '#1862b4'); g.addColorStop(1, '#0a2a5e')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 256)
    const land = ['#2e6b3a', '#3f7a44', '#6b5a2e', '#4a7a3a', '#7a6b3a']
    const rnd = mulberry32(305517)
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = land[i % land.length]
      ctx.beginPath(); ctx.ellipse(rnd() * 512, 30 + rnd() * 196, 16 + rnd() * 44, 10 + rnd() * 28, rnd() * 3, 0, 6.28); ctx.fill()
    }
    ctx.globalAlpha = 0.5; ctx.fillStyle = '#eef4ff'
    for (let i = 0; i < 30; i++) { ctx.beginPath(); ctx.ellipse(rnd() * 512, rnd() * 256, 12 + rnd() * 34, 5 + rnd() * 12, 0, 0, 6.28); ctx.fill() }
    ctx.globalAlpha = 1; ctx.fillStyle = '#dfeaff'
    ctx.fillRect(0, 0, 512, 16); ctx.fillRect(0, 240, 512, 16)
    const tex = this.ownT(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace

    const geo = this.ownG(new THREE.SphereGeometry(radius, 48, 32))
    const mat = this.own(new THREE.MeshBasicMaterial({ map: tex, fog: false }))
    const body = new THREE.Mesh(geo, mat)
    body.rotation.z = 0.32
    body.frustumCulled = false
    pivot.add(body)

    let haloMat: THREE.MeshBasicMaterial | null = null
    if (halo) {
      // Atmosphere glow shell behind the marble (additive, depthWrite off).
      const ag = this.ownG(new THREE.SphereGeometry(radius * 1.13, 40, 28))
      haloMat = this.own(new THREE.MeshBasicMaterial({ color: 0x4aa6ff, transparent: true, opacity: 0.22, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const atmo = new THREE.Mesh(ag, haloMat)
      atmo.frustumCulled = false
      pivot.add(atmo)
    }

    return { pivot, ox, oy, oz, spin: 0.015, body, halo: haloMat, phase: 0 }
  }

  /** A bright emissive star disc (the Sun) with an optional soft additive flare. */
  private makeStarBody(color: number, ox: number, oy: number, oz: number, radius: number, halo: boolean, flareScale: number): Body {
    const pivot = new THREE.Group()
    pivot.position.set(ox, oy, oz)
    this.group.add(pivot)

    const geo = this.ownG(new THREE.SphereGeometry(radius, 24, 16))
    const mat = this.own(new THREE.MeshBasicMaterial({ color, fog: false }))
    const body = new THREE.Mesh(geo, mat)
    body.frustumCulled = false
    pivot.add(body)

    let haloMat: THREE.MeshBasicMaterial | null = null
    if (halo && flareScale > 0) {
      // Soft additive flare disc, always facing forward-ish (a back-side shell glow).
      const fg = this.ownG(new THREE.SphereGeometry(radius * flareScale, 28, 18))
      haloMat = this.own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const flare = new THREE.Mesh(fg, haloMat)
      flare.frustumCulled = false
      pivot.add(flare)
    }

    return { pivot, ox, oy, oz, spin: 0, body, halo: haloMat, phase: Math.PI * 0.5 }
  }

  /** A tiny grey cratered moon (Phobos/Deimos) with an optional faint halo. */
  private makeCrateredMoon(color: number, ox: number, oy: number, oz: number, radius: number, seed: number, halo: boolean): Body {
    const pivot = new THREE.Group()
    pivot.position.set(ox, oy, oz)
    this.group.add(pivot)

    // Procedural cratered surface on a small canvas.
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
    ctx.fillRect(0, 0, 128, 64)
    const rnd = mulberry32(seed)
    for (let i = 0; i < 36; i++) {
      const r = 2 + rnd() * 7
      const x = rnd() * 128, y = rnd() * 64
      // Dark crater floor + light rim for a pitted look.
      ctx.globalAlpha = 0.5; ctx.fillStyle = '#3a322a'
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.8, 0, 0, 6.28); ctx.fill()
      ctx.globalAlpha = 0.4; ctx.fillStyle = '#e8ddc8'
      ctx.beginPath(); ctx.ellipse(x - r * 0.2, y - r * 0.2, r * 0.6, r * 0.5, 0, 0, 6.28); ctx.fill()
    }
    ctx.globalAlpha = 1
    const tex = this.ownT(new THREE.CanvasTexture(cv)); tex.colorSpace = THREE.SRGBColorSpace

    const geo = this.ownG(new THREE.IcosahedronGeometry(radius, 1))
    const mat = this.own(new THREE.MeshBasicMaterial({ map: tex, fog: false }))
    const body = new THREE.Mesh(geo, mat)
    body.frustumCulled = false
    pivot.add(body)

    let haloMat: THREE.MeshBasicMaterial | null = null
    if (halo) {
      const hg = this.ownG(new THREE.SphereGeometry(radius * 1.45, 20, 14))
      haloMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffcaa0, transparent: true, opacity: 0.12, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const h = new THREE.Mesh(hg, haloMat)
      h.frustumCulled = false
      pivot.add(h)
    }

    // Slow, gentle drift-spin so the twin moons feel alive over the horizon.
    return { pivot, ox, oy, oz, spin: 0.02 + rnd() * 0.02, body, halo: haloMat, phase: rnd() * Math.PI * 2 }
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.applyVisibility()
  }

  /** Show only the bodies belonging to the current off-world zone. */
  private applyVisibility() {
    const onMoon = this.zone === 'moon'
    const onMars = this.zone === 'mars'
    this.group.visible = onMoon || onMars
    for (const b of this.moonBodies) b.pivot.visible = onMoon
    for (const b of this.marsBodies) b.pivot.visible = onMars
  }

  update(dt: number) {
    // Per-update zone guard (the deps.zone() source of truth), so we stay hidden
    // on Earth and on the non-target zone even if a setZone was missed.
    const z = this.deps.zone()
    if (z !== this.zone) { this.zone = z; this.applyVisibility() }
    const active = z === 'moon' || z === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return

    this.t += dt
    const bodies = z === 'moon' ? this.moonBodies : this.marsBodies

    // Anchor each body's XZ to the focus (so distance never changes), keep the
    // fixed high Y + bearing offset, and spin it slowly in place.
    if (!this.staticPos) {
      this.focus.copy(this.deps.focus())
      // Frame-rate-independent exponential follow toward the focus-anchored point.
      const k = 1 - Math.exp(-dt * 4)
      for (const b of bodies) {
        const tx = this.focus.x + b.ox
        const tz = this.focus.z + b.oz
        b.pivot.position.x += (tx - b.pivot.position.x) * k
        b.pivot.position.z += (tz - b.pivot.position.z) * k
        b.pivot.position.y = b.oy
      }
    }

    for (const b of bodies) {
      if (b.spin) b.body.rotation.y += b.spin * dt
      // High-tier halo pulse (only present on high; null elsewhere).
      if (b.halo) {
        const base = b.halo.userData.base ?? (b.halo.userData.base = b.halo.opacity)
        b.halo.opacity = base * (0.82 + 0.18 * (0.5 + 0.5 * Math.sin(this.t * 0.8 + b.phase)))
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
  }
}
