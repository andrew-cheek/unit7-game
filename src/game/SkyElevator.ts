import * as THREE from 'three'
import { config } from './config'

/**
 * Sky elevator: a hero set piece for the opening spawn platform — a raygun-gothic
 * "rocket-car to orbit" rising off the launch-pad deck. A chrome art-deco tower
 * wraps a translucent glass core; a streamlined chrome rocket-car (bullet body,
 * swept tail fins, ring of warm porthole lights, amber cabin glow) rides up and
 * down on a smooth eased loop (pausing at top and bottom); an additive "tractor
 * beam" shoots skyward with glowing rings travelling up it like an atompunk
 * transporter; and a retro-CRT holographic boarding sign reads "ELEVATOR" with a
 * destination line that cycles "▲ MOON" / "▲ MARS".
 *
 * Retro-futurism / raygun-gothic / atompunk: 1950s space-age chrome + art-deco
 * fluting and brass banding + warm amber tube-glow, MIXED with modern cyan neon
 * and holograms. Palette: amber/gold + chrome + cyan + a touch of magenta.
 *
 * Lifetime: this is owned by the LAUNCH PAD, not the world — the orchestrator
 * constructs it when the pad builds and disposes it when the pad tears down. It
 * is NOT a GameSystem and NOT zone-gated; it just lives as long as the deck does.
 *
 * Coordinates: everything is attached to the passed-in `parent` group in LOCAL
 * space — deck at local y≈0, centered at origin, deck radius `opts.radius`. The
 * tower is placed near the rim but clear of the spawn/dive path.
 *
 * Functional: the elevator can be a real off-world boarding point. It exposes
 * `boardLocal` / `boardRadius` (a footprint the game tests the player against),
 * `currentDest()` (which destination the sign is showing right now) and
 * `setBoarding(on)` (lock the sign + ramp up a boarding glow). The boarding ramp
 * is purely visual; it never touches physics, gameplay or determinism.
 *
 * Determinism: the car's Y, the sign cross-fade, the beam rings and the boarding
 * ramp are all driven off an internal `this.t` so it is frame-rate independent
 * and allocation-free in update(). config.reducedMotion is read live to soften
 * the skyward beam and travelling rings to a near-steady glow (never a strobe).
 *
 * Tier (config.tier.name): on 'low' we simplify — fewer chrome rings, no fluted
 * ribs, fewer tail fins and a single plain beam cone (no travelling rings) — but
 * KEEP the rocket-car, the shaft, the cycling sign and a beam. It stays a tiny
 * handful of draws on every tier.
 */
export class SkyElevator {
  private root = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []

  private t = 0

  // Animated handles (resolved once in the constructor; mutated in update()).
  private car!: THREE.Group
  private carGlowMat!: THREE.MeshBasicMaterial   // additive porthole ring + rim glow
  private cabinGlowMat!: THREE.MeshBasicMaterial // soft amber cabin glow
  private beamMat!: THREE.MeshBasicMaterial
  private ringMats: THREE.MeshBasicMaterial[] = []   // travelling tractor-beam rings
  private rings: THREE.Mesh[] = []
  private signMoonMat!: THREE.MeshBasicMaterial
  private signMarsMat!: THREE.MeshBasicMaterial

  // Car travel limits (local Y), set from the shaft height.
  private carLo = 0
  private carHi = 0
  private beamBaseY = 0
  private beamH = 0

  // --- Functional API state ---------------------------------------------------
  /** Boarding spot in PARENT-LOCAL space at deck level (game transforms via parent matrix). */
  readonly boardLocal: THREE.Vector3
  /** Car footprint radius at the base; the game tests player XZ distance against this. */
  readonly boardRadius = 2.6

  // Boarding ramp: target 0/1, eased value follows it in update() (no allocation).
  private boarding = false
  private boardRamp = 0
  // Destination locked at the moment setBoarding(true) is called.
  private lockedDest: 'moon' | 'mars' | null = null

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(parent: THREE.Group, opts: { radius: number }) {
    const R = opts.radius
    const low = config.tier.name === 'low'

    // Near the rim, off to one side and back, clear of the spawn/dive path.
    this.root.position.set(R * 0.6, 0, -R * 0.3)
    // Angle it so the boarding sign faces roughly back toward the deck centre.
    this.root.rotation.y = Math.atan2(-this.root.position.x, -this.root.position.z)

    // Boarding spot: at the tower base, in PARENT-LOCAL space.
    this.boardLocal = new THREE.Vector3(this.root.position.x, 0, this.root.position.z)

    const H = 46                 // shaft top (local Y)
    const half = 0.85            // half-width of the tower footprint

    // Shared palette.
    const chrome = 0xd8e2ec
    const brass = 0xcaa24a
    const amber = 0xffb24a
    const cyan = 0x6fe0ff

    // --- Base plinth: chrome drum with a brass collar, bolted to the deck. ---
    const plinthMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.95, roughness: 0.28, emissive: 0x0a1a2a, emissiveIntensity: 0.25 }))
    const plinth = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(half * 1.9, half * 2.3, 1.2, low ? 10 : 18)), plinthMat)
    plinth.position.y = 0.6; this.root.add(plinth)
    const collarMat = this.own(new THREE.MeshStandardMaterial({ color: brass, metalness: 0.95, roughness: 0.3, emissive: 0x3a2a08, emissiveIntensity: 0.4 }))
    const collar = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(half * 1.95, 0.16, 8, low ? 12 : 22)), collarMat)
    collar.rotation.x = Math.PI / 2; collar.position.y = 1.1; this.root.add(collar)

    // --- Translucent glass core (the lift tube), light-blue cyan glass. ---
    const glassMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x9fd8ff, metalness: 0.2, roughness: 0.1,
      transparent: true, opacity: 0.16, side: THREE.DoubleSide,
      emissive: 0x2a6ea0, emissiveIntensity: 0.3,
    }))
    const core = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(half * 0.8, half * 0.8, H, low ? 10 : 18, 1, true)), glassMat)
    core.position.y = H / 2; this.root.add(core)

    // --- Vertical fluted ribs (art-deco chrome) around the glass. Skipped on low. ---
    if (!low) {
      const ribMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.95, roughness: 0.25, emissive: 0x0c1830, emissiveIntensity: 0.2 }))
      const ribGeo = this.ownG(new THREE.CylinderGeometry(0.07, 0.07, H, 6))
      const ribCount = 6
      const ribR = half * 0.92
      for (let i = 0; i < ribCount; i++) {
        const a = (i / ribCount) * Math.PI * 2
        const rib = new THREE.Mesh(ribGeo, ribMat)
        rib.position.set(Math.cos(a) * ribR, H / 2, Math.sin(a) * ribR)
        this.root.add(rib)
      }
    }

    // --- Stacked chrome/brass banding rings up the tower (art-deco). ---
    const bandChromeMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.95, roughness: 0.22, emissive: 0x0a1a2a, emissiveIntensity: 0.2 }))
    const bandBrassMat = this.own(new THREE.MeshStandardMaterial({ color: brass, metalness: 0.95, roughness: 0.3, emissive: 0x3a2a08, emissiveIntensity: 0.45 }))
    const bandChromeGeo = this.ownG(new THREE.TorusGeometry(half * 0.92, 0.09, 6, low ? 12 : 22))
    const bandBrassGeo = this.ownG(new THREE.TorusGeometry(half * 0.95, 0.07, 6, low ? 12 : 22))
    const bands = low ? 4 : 9
    for (let i = 1; i <= bands; i++) {
      const y = (i / (bands + 1)) * H
      const brassBand = i % 2 === 0
      const band = new THREE.Mesh(brassBand ? bandBrassGeo : bandChromeGeo, brassBand ? bandBrassMat : bandChromeMat)
      band.rotation.x = Math.PI / 2; band.position.y = y; this.root.add(band)
    }

    // --- Warm amber tube-glow trim ring near the top (retro emissive accent). ---
    const trimMat = this.own(new THREE.MeshBasicMaterial({ color: amber, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const trim = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(half * 0.86, 0.05, 6, low ? 14 : 24)), trimMat)
    trim.rotation.x = Math.PI / 2; trim.position.y = H - 1.5; this.root.add(trim)

    // --- Streamlined raygun-gothic rocket-car that rides the core. ---
    this.car = new THREE.Group()
    // Chrome ogive hull: a rounded bullet body. Sphere (nose) + cylinder (barrel).
    const hullMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.95, roughness: 0.18, emissive: 0x0a1a2a, emissiveIntensity: 0.2 }))
    const barrelR = half * 0.6
    const barrel = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(barrelR, barrelR * 0.92, 2.0, low ? 12 : 18)), hullMat)
    this.car.add(barrel)
    // Rounded nose cone (ogive) on top.
    const nose = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(barrelR, low ? 10 : 16, low ? 6 : 10, 0, Math.PI * 2, 0, Math.PI / 2)), hullMat)
    nose.position.y = 1.0; nose.scale.y = 1.4; this.car.add(nose)
    // Tail bell.
    const tail = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(barrelR * 0.92, barrelR * 0.55, 0.7, low ? 10 : 16)), hullMat)
    tail.position.y = -1.35; this.car.add(tail)

    // Swept tail fins (2 on low, 3 otherwise).
    const finMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.95, roughness: 0.2, emissive: 0x1a0e02, emissiveIntensity: 0.3, side: THREE.DoubleSide }))
    {
      // A thin swept triangle: a tall thin box sheared by scaling is simplest —
      // use a cone slice flattened to a fin-like blade.
      const finGeo = this.ownG(new THREE.BoxGeometry(0.08, 1.1, 0.7))
      const finCount = low ? 2 : 3
      const finR = barrelR * 0.95
      for (let i = 0; i < finCount; i++) {
        const a = (i / finCount) * Math.PI * 2
        const fin = new THREE.Mesh(finGeo, finMat)
        fin.position.set(Math.cos(a) * finR, -1.0, Math.sin(a) * finR)
        fin.rotation.y = -a
        this.car.add(fin)
      }
    }

    // Ring of warm porthole lights around the cabin (additive amber).
    this.carGlowMat = this.own(new THREE.MeshBasicMaterial({ color: amber, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const portGeo = this.ownG(new THREE.SphereGeometry(0.1, 6, 6))
    const portCount = low ? 5 : 8
    const portR = barrelR + 0.02
    for (let i = 0; i < portCount; i++) {
      const a = (i / portCount) * Math.PI * 2
      const port = new THREE.Mesh(portGeo, this.carGlowMat)
      port.position.set(Math.cos(a) * portR, 0.2, Math.sin(a) * portR)
      this.car.add(port)
    }
    // Cyan accent rim band so the capsule reads as modern-neon too.
    const rim = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(barrelR + 0.04, 0.06, 8, low ? 14 : 22)), this.carGlowMat)
    rim.rotation.x = Math.PI / 2; rim.position.y = -0.4; this.car.add(rim)

    // Soft amber cabin glow (a faint additive sphere inside the hull).
    this.cabinGlowMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const cabin = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(barrelR * 0.7, low ? 8 : 12, low ? 6 : 10)), this.cabinGlowMat)
    cabin.position.y = 0.2; this.car.add(cabin)

    this.root.add(this.car)

    // Travel between just above the deck and just below the top.
    this.carLo = 2.4
    this.carHi = H - 2.4
    this.car.position.y = this.carLo

    // --- Skyward "tractor beam" tether: a tall thin additive cone + travelling rings. ---
    this.beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9be8ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const beamH = 70
    this.beamH = beamH
    this.beamBaseY = H
    const beamR = half * 0.7
    const beam = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(beamR, beamH, low ? 8 : 18, 1, true)), this.beamMat)
    beam.position.y = H + beamH / 2; this.root.add(beam)
    if (!low) {
      // Brighter slim inner core for desktop.
      const beamCore = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.16, 0.16, beamH, 8, 1, true)), this.beamMat)
      beamCore.position.y = H + beamH / 2; this.root.add(beamCore)
      // Travelling tractor-beam rings (atompunk transporter feel). Skipped on low.
      const ringMat = this.own(new THREE.MeshBasicMaterial({ color: amber, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      this.ringMats.push(ringMat)
      const ringGeoTop = this.ownG(new THREE.TorusGeometry(beamR * 0.55, 0.05, 6, 18))
      const ringCount = 3
      for (let i = 0; i < ringCount; i++) {
        const ring = new THREE.Mesh(ringGeoTop, ringMat)
        ring.rotation.x = Math.PI / 2
        ring.position.y = H   // positioned in update()
        this.root.add(ring)
        this.rings.push(ring)
      }
    }

    // --- Retro-CRT holographic boarding sign near the top: two cross-fading panels. ---
    const signMoonTex = this.signTexture('MOON', 0xb8ecff)
    const signMarsTex = this.signTexture('MARS', 0xff9a6a)
    this.texs.push(signMoonTex, signMarsTex)
    const signGeo = this.ownG(new THREE.PlaneGeometry(4.6, 2.6))
    this.signMoonMat = this.own(new THREE.MeshBasicMaterial({ map: signMoonTex, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }))
    this.signMarsMat = this.own(new THREE.MeshBasicMaterial({ map: signMarsTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }))
    const signY = H - 4
    const signZ = half + 0.4
    const moonPanel = new THREE.Mesh(signGeo, this.signMoonMat); moonPanel.position.set(0, signY, signZ); this.root.add(moonPanel)
    const marsPanel = new THREE.Mesh(signGeo, this.signMarsMat); marsPanel.position.set(0, signY, signZ + 0.02); this.root.add(marsPanel)
    // Chrome frame around the sign (rounded retro-CRT bezel feel via a torus).
    if (!low) {
      const frameMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.95, roughness: 0.25, emissive: 0x0a1a2a, emissiveIntensity: 0.2 }))
      const frameGeo = this.ownG(new THREE.TorusGeometry(2.6, 0.12, 6, 28))
      const frame = new THREE.Mesh(frameGeo, frameMat)
      frame.position.set(0, signY, signZ - 0.05); frame.scale.set(1.0, 0.62, 1.0)
      this.root.add(frame)
    }

    parent.add(this.root)
  }

  /** Retro-CRT holographic boarding panel drawn once to a canvas: "ELEVATOR" + a
   *  destination line "▲ <dest>" tinted to the destination's colour, with rounded
   *  corners, scanlines, a chrome bezel and an atomic-orbit starburst motif. */
  private signTexture(dest: string, accent: number): THREE.CanvasTexture {
    const W = 512, Hc = 288
    const cv = document.createElement('canvas'); cv.width = W; cv.height = Hc
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, W, Hc)

    // Rounded-corner CRT panel backing.
    const r = 28
    const rr = (x: number, y: number, w: number, h: number, rad: number) => {
      ctx.beginPath()
      ctx.moveTo(x + rad, y)
      ctx.arcTo(x + w, y, x + w, y + h, rad)
      ctx.arcTo(x + w, y + h, x, y + h, rad)
      ctx.arcTo(x, y + h, x, y, rad)
      ctx.arcTo(x, y, x + w, y, rad)
      ctx.closePath()
    }
    rr(10, 10, W - 20, Hc - 20, r)
    ctx.fillStyle = 'rgba(8,18,32,0.6)'; ctx.fill()
    // Chrome bezel.
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(216,226,236,0.85)'; ctx.stroke()
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,178,74,0.55)'; ctx.stroke()

    // Clip CRT content to the rounded panel.
    ctx.save()
    rr(14, 14, W - 28, Hc - 28, r - 4); ctx.clip()

    // Scanlines.
    ctx.fillStyle = 'rgba(39,231,255,0.06)'
    for (let y = 0; y < Hc; y += 6) ctx.fillRect(0, y, W, 2)

    const hex = '#' + new THREE.Color(accent).getHexString()

    // Atomic-orbit starburst motif behind the title (magenta touch + accent).
    ctx.save()
    ctx.translate(W / 2, 78)
    ctx.lineWidth = 2
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI / 3))
      ctx.strokeStyle = i === 1 ? 'rgba(255,90,200,0.30)' : 'rgba(39,231,255,0.22)'
      ctx.beginPath(); ctx.ellipse(0, 0, 150, 46, 0, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.restore()

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    // Title.
    ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 22; ctx.fillStyle = '#cdfaff'
    ctx.font = '900 60px ui-monospace, Menlo, monospace'; ctx.fillText('ELEVATOR', 256, 78)
    // Thin amber rule.
    ctx.shadowColor = '#ffb24a'; ctx.shadowBlur = 10; ctx.strokeStyle = '#ffb24a'; ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(96, 132); ctx.lineTo(416, 132); ctx.stroke()
    // Destination line.
    ctx.shadowColor = hex; ctx.shadowBlur = 26; ctx.fillStyle = hex
    ctx.font = '800 84px ui-monospace, Menlo, monospace'; ctx.fillText('▲ ' + dest, 256, 210)

    ctx.restore()
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  // --- Functional API ---------------------------------------------------------

  /** Which destination the sign is CURRENTLY showing, from the same cycle that
   *  drives the cross-fade. When boarding is locked, returns the locked dest. */
  currentDest(): 'moon' | 'mars' {
    if (this.lockedDest) return this.lockedDest
    return this.moonShowing(this.t) ? 'moon' : 'mars'
  }

  /** When true: lock the sign to the current destination (stop cycling) and ramp
   *  up the boarding visual. When false: resume normal cycling/idle. Visual only. */
  setBoarding(on: boolean): void {
    if (on === this.boarding) return
    this.boarding = on
    if (on) {
      // Lock to whatever the sign is showing at this instant.
      this.lockedDest = this.moonShowing(this.t) ? 'moon' : 'mars'
    } else {
      this.lockedDest = null
    }
  }

  /** Is the MOON panel the dominant one at time `t`? Mirrors the update() cycle
   *  (MOON during its dwell + the half of each blend nearer MOON). */
  private moonShowing(t: number): boolean {
    const dwell = 3.0, blend = 0.8
    const cyc = dwell * 2 + blend * 2
    const cp = ((t % cyc) + cyc) % cyc
    // MOON op >= 0.5 over [0, dwell+blend/2) and (dwell*2 + blend*1.5, cyc).
    return cp < dwell + blend / 2 || cp >= dwell * 2 + blend * 1.5
  }

  update(dt: number) {
    this.t += dt
    const calm = config.reducedMotion

    // --- Boarding ramp: ease boardRamp toward boarding (0/1). Frame-rate independent. ---
    const target = this.boarding ? 1 : 0
    const rampRate = 2.4 // ~0.4s to settle
    if (this.boardRamp !== target) {
      const k = 1 - Math.exp(-rampRate * dt)
      this.boardRamp += (target - this.boardRamp) * k
      if (Math.abs(this.boardRamp - target) < 0.001) this.boardRamp = target
    }
    const b = this.boardRamp

    // --- Car loop: eased up, pause at top, eased down, pause at bottom. ---
    const rise = 4.5, pause = 1.2
    const period = rise * 2 + pause * 2
    const ph = this.t % period
    let frac: number // 0 = bottom, 1 = top
    if (ph < rise) {
      frac = ph / rise
    } else if (ph < rise + pause) {
      frac = 1
    } else if (ph < rise * 2 + pause) {
      frac = 1 - (ph - rise - pause) / rise
    } else {
      frac = 0
    }
    // Smoothstep ease in/out (only meaningful during travel; flat during pauses).
    const e = frac * frac * (3 - 2 * frac)
    // When boarding, pull the car down to the base so the player can step in.
    const idleY = this.carLo + (this.carHi - this.carLo) * e
    this.car.position.y = idleY + (this.carLo - idleY) * b

    // Car glow gently breathes; brightens hard when boarding (porthole lights up).
    const breathe = 0.7 + 0.2 * Math.sin(this.t * 2.4)
    this.carGlowMat.opacity = breathe + 0.6 * b
    this.cabinGlowMat.opacity = 0.35 + 0.5 * b

    // --- Skyward beam pulse. reducedMotion: near-steady, never a flash. ---
    // Boarding intensifies the beam.
    const beamFreq = calm ? 1.0 : 2.2
    const beamBase = (calm ? 0.26 : 0.24) + 0.22 * b
    const beamAmp = calm ? 0.04 : 0.12
    this.beamMat.opacity = beamBase + beamAmp * (0.5 + 0.5 * Math.sin(this.t * beamFreq))

    // --- Travelling tractor-beam rings: rise up the beam on a loop (desktop only). ---
    if (this.rings.length) {
      const n = this.rings.length
      // reducedMotion slows the climb and dims; boarding speeds it up a touch.
      const speed = (calm ? 0.06 : 0.18) + 0.06 * b
      const ringOp = (calm ? 0.25 : 0.5) + 0.3 * b
      for (let i = 0; i < n; i++) {
        // Each ring offset by 1/n through the loop; loops 0..1 up the cone.
        const u = (this.t * speed + i / n) % 1
        this.rings[i].position.y = this.beamBaseY + u * this.beamH
        // Cone narrows toward the top: shrink the ring as it climbs.
        const s = 1 - 0.85 * u
        this.rings[i].scale.set(s, s, s)
      }
      this.ringMats[0].opacity = ringOp
    }

    // --- Destination sign cycle: cross-fade MOON <-> MARS, unless locked. ---
    if (this.lockedDest) {
      // Hold the locked destination solid; the other panel fully hidden.
      const moonOp = this.lockedDest === 'moon' ? 1 : 0
      this.signMoonMat.opacity = moonOp
      this.signMarsMat.opacity = 1 - moonOp
    } else {
      const dwell = 3.0, blend = 0.8
      const cyc = dwell * 2 + blend * 2
      const cp = this.t % cyc
      let moonOp: number
      if (cp < dwell) moonOp = 1
      else if (cp < dwell + blend) moonOp = 1 - (cp - dwell) / blend
      else if (cp < dwell * 2 + blend) moonOp = 0
      else moonOp = (cp - (dwell * 2 + blend)) / blend
      this.signMoonMat.opacity = moonOp
      this.signMarsMat.opacity = 1 - moonOp
    }
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root)
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
    this.geos.length = 0
    this.mats.length = 0
    this.texs.length = 0
    this.ringMats.length = 0
    this.rings.length = 0
  }
}
