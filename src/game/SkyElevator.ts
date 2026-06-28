import * as THREE from 'three'
import { config } from './config'

/**
 * Sky elevator: a hero set piece for the opening spawn platform — a tall glass
 * "space elevator to orbit" rising off the launch-pad deck. A slim metal-railed
 * tower wraps a translucent glass core; a glowing capsule car rides up and down
 * on a smooth eased loop (pausing at top and bottom); an additive beam of light
 * shoots skyward from the top like a tether to orbit; and a holographic boarding
 * sign reads "ELEVATOR" with a destination line that cycles "▲ MOON" / "▲ MARS".
 *
 * Lifetime: this is owned by the LAUNCH PAD, not the world — the orchestrator
 * constructs it when the pad builds and disposes it when the pad tears down. It
 * is NOT a GameSystem and NOT zone-gated; it just lives as long as the deck does.
 *
 * Coordinates: everything is attached to the passed-in `parent` group in LOCAL
 * space — deck at local y≈0, centered at origin, deck radius `opts.radius`. The
 * tower is placed near the rim but clear of the spawn/dive path.
 *
 * Purely visual: it never touches physics, gameplay or determinism. The car's Y
 * and the sign cross-fade are driven entirely off an internal `this.t` so it is
 * frame-rate independent and allocation-free in update(). config.reducedMotion is
 * read live to soften the skyward beam's pulse to a near-steady glow (never a
 * flash/strobe).
 *
 * Tier (config.tier.name): on 'low' we simplify — fewer corner rails, no
 * cross-braces and a single plain beam cone — but KEEP the shaft, the travelling
 * car and the cycling sign. It stays a tiny handful of draws on every tier.
 */
export class SkyElevator {
  private root = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []

  private t = 0

  // Animated handles (resolved once in the constructor; mutated in update()).
  private car!: THREE.Group
  private carGlowMat!: THREE.MeshBasicMaterial
  private beamMat!: THREE.MeshBasicMaterial
  private signMoonMat!: THREE.MeshBasicMaterial
  private signMarsMat!: THREE.MeshBasicMaterial

  // Car travel limits (local Y), set from the shaft height.
  private carLo = 0
  private carHi = 0

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(parent: THREE.Group, opts: { radius: number }) {
    const R = opts.radius
    const low = config.tier.name === 'low'

    // Near the rim, off to one side and back, clear of the spawn/dive path.
    this.root.position.set(R * 0.6, 0, -R * 0.3)
    // Angle it so the boarding sign faces roughly back toward the deck centre.
    this.root.rotation.y = Math.atan2(-this.root.position.x, -this.root.position.z)

    const H = 46                 // shaft top (local Y)
    const half = 0.85            // half-width of the rail footprint
    const railW = 0.32

    // --- Base plinth so the tower reads as bolted to the deck. ---
    const plinthMat = this.own(new THREE.MeshStandardMaterial({ color: 0x141d30, metalness: 0.7, roughness: 0.4, emissive: 0x0a2236, emissiveIntensity: 0.4 }))
    const plinth = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(half * 1.9, half * 2.2, 1.2, low ? 8 : 14)), plinthMat)
    plinth.position.y = 0.6; this.root.add(plinth)

    // --- Translucent glass core (the lift tube), light-blue like the game's glass. ---
    const glassMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x9fd8ff, metalness: 0.2, roughness: 0.1,
      transparent: true, opacity: 0.18, side: THREE.DoubleSide,
      emissive: 0x2a6ea0, emissiveIntensity: 0.28,
    }))
    const core = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(half * 0.78, half * 0.78, H, low ? 10 : 16, 1, true)), glassMat)
    core.position.y = H / 2; this.root.add(core)

    // --- Corner rails (dark metallic). 3 on low, 4 otherwise. ---
    const railMat = this.own(new THREE.MeshStandardMaterial({ color: 0x222c44, metalness: 0.75, roughness: 0.35, emissive: 0x0c1830, emissiveIntensity: 0.3 }))
    const railGeo = this.ownG(new THREE.BoxGeometry(railW, H, railW))
    const corners: [number, number][] = low
      ? [[-half, -half], [half, -half], [0, half]]
      : [[-half, -half], [half, -half], [half, half], [-half, half]]
    for (const [cx, cz] of corners) {
      const rail = new THREE.Mesh(railGeo, railMat)
      rail.position.set(cx, H / 2, cz); this.root.add(rail)
    }

    // --- Cross-braces ringing the tower (skipped on low). ---
    if (!low) {
      const braceMat = this.own(new THREE.MeshStandardMaterial({ color: 0x33405e, metalness: 0.7, roughness: 0.4 }))
      const braceGeo = this.ownG(new THREE.BoxGeometry(half * 2 + railW, 0.18, 0.18))
      const rings = 7
      for (let i = 1; i <= rings; i++) {
        const y = (i / (rings + 1)) * H
        // Front/back + left/right bars per ring, forming a square cage.
        const b0 = new THREE.Mesh(braceGeo, braceMat); b0.position.set(0, y, -half); this.root.add(b0)
        const b1 = new THREE.Mesh(braceGeo, braceMat); b1.position.set(0, y, half); this.root.add(b1)
        const b2 = new THREE.Mesh(braceGeo, braceMat); b2.rotation.y = Math.PI / 2; b2.position.set(-half, y, 0); this.root.add(b2)
        const b3 = new THREE.Mesh(braceGeo, braceMat); b3.rotation.y = Math.PI / 2; b3.position.set(half, y, 0); this.root.add(b3)
      }
    }

    // --- Glowing capsule car that rides the core. ---
    this.car = new THREE.Group()
    const carBodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0xbfe9ff, metalness: 0.3, roughness: 0.2, transparent: true, opacity: 0.55, emissive: 0x2a8edb, emissiveIntensity: 0.6, side: THREE.DoubleSide }))
    const carBody = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(half * 0.62, half * 0.62, 2.4, low ? 10 : 16)), carBodyMat)
    this.car.add(carBody)
    // Additive rim band so the capsule glows.
    this.carGlowMat = this.own(new THREE.MeshBasicMaterial({ color: 0x6fe0ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const rim = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(half * 0.66, 0.1, 8, low ? 14 : 20)), this.carGlowMat)
    rim.rotation.x = Math.PI / 2; this.car.add(rim)
    this.root.add(this.car)

    // Travel between just above the deck and just below the top.
    this.carLo = 2.4
    this.carHi = H - 2.4
    this.car.position.y = this.carLo

    // --- Skyward beam (the "tether to orbit"): a tall thin additive cone. ---
    this.beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9be8ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const beamH = 70
    // A narrowing cone reads as a god-ray. Low keeps a single coarse cone.
    const beam = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(half * 0.7, beamH, low ? 8 : 18, 1, true)), this.beamMat)
    // Cone apex points up: place so its wide base sits at the shaft top.
    beam.position.y = H + beamH / 2; this.root.add(beam)
    if (!low) {
      // A brighter slim inner core for desktop.
      const beamCore = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.16, 0.16, beamH, 8, 1, true)), this.beamMat)
      beamCore.position.y = H + beamH / 2; this.root.add(beamCore)
    }

    // --- Holographic boarding sign near the top: two cross-fading panels. ---
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

    parent.add(this.root)
  }

  /** Holographic boarding panel drawn once to a canvas: "ELEVATOR" + a destination
   *  line "▲ <dest>" tinted to the destination's colour. */
  private signTexture(dest: string, accent: number): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 288
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, 512, 288)
    // Faint panel backing + scanlines so it reads as a hologram.
    ctx.fillStyle = 'rgba(8,20,36,0.55)'; ctx.fillRect(0, 0, 512, 288)
    ctx.fillStyle = 'rgba(39,231,255,0.06)'; for (let y = 0; y < 288; y += 6) ctx.fillRect(0, y, 512, 2)
    const hex = '#' + new THREE.Color(accent).getHexString()
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    // Title.
    ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 22; ctx.fillStyle = '#cdfaff'
    ctx.font = '900 64px ui-monospace, Menlo, monospace'; ctx.fillText('ELEVATOR', 256, 78)
    // Thin rule.
    ctx.shadowBlur = 10; ctx.strokeStyle = '#27e7ff'; ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(96, 132); ctx.lineTo(416, 132); ctx.stroke()
    // Destination line.
    ctx.shadowColor = hex; ctx.shadowBlur = 26; ctx.fillStyle = hex
    ctx.font = '800 88px ui-monospace, Menlo, monospace'; ctx.fillText('▲ ' + dest, 256, 210)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  update(dt: number) {
    this.t += dt

    // --- Car loop: eased up, pause at top, eased down, pause at bottom. ---
    // One full cycle = up + pauseTop + down + pauseBottom.
    const rise = 4.5, pause = 1.2
    const period = rise * 2 + pause * 2
    let ph = this.t % period
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
    this.car.position.y = this.carLo + (this.carHi - this.carLo) * e
    // Car glow gently breathes.
    this.carGlowMat.opacity = 0.7 + 0.2 * Math.sin(this.t * 2.4)

    // --- Skyward beam pulse. reducedMotion: near-steady, never a flash. ---
    const calm = config.reducedMotion
    const beamFreq = calm ? 1.0 : 2.2
    const beamBase = calm ? 0.26 : 0.24
    const beamAmp = calm ? 0.04 : 0.12
    this.beamMat.opacity = beamBase + beamAmp * (0.5 + 0.5 * Math.sin(this.t * beamFreq))

    // --- Destination sign cycle: cross-fade MOON <-> MARS every few seconds. ---
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

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root)
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
    this.geos.length = 0
    this.mats.length = 0
    this.texs.length = 0
  }
}
