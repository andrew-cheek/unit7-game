import * as THREE from 'three'
import { config } from './config'

/**
 * The SECOND drop zone, on the far (-Z) side of the launch-pad deck — the mirror
 * of the assembly-line DROP ZONE the player faces at spawn. Here a steady stream
 * of finished UNIT 7 ROBOTS PARACHUTE DOWN onto a marked landing pad, cut their
 * canopies, then walk to the back rim and STEP OFF into a dive. It reads as
 * "arrivals" — newly-built units raining in and diving out — so when the player
 * turns around they see a busy, self-explanatory drop zone instead of dead deck.
 *
 * Like PlatformAirshow this is pure visual flavour: it never touches gameplay,
 * physics or the fixed-timestep sim, so its motion uses Math.random / Math.sin
 * freely and is fully frame-rate-driven off dt. Nothing here feeds determinism.
 *
 * Lifetime mirrors PlatformAirshow: NOT a GameSystem, NOT zone-gated. It lives as
 * long as the launch pad, attaches every mesh to the passed-in `parent` (the
 * launch-pad group) so it inherits the pad transform, and frees everything in
 * dispose(). All positions are LOCAL to `parent`: deck centre at the origin, deck
 * radius `opts.radius`, the dive edge at |xz| = radius.
 *
 * Draw cost / tiering: robot/canopy counts are tier-scaled and every part geometry
 * is shared via own/ownG. Each robot is a small Group of a handful of meshes with
 * one cloned (tinted) body + glow material, so variety is cheap. Per-frame motion
 * reuses no allocations beyond the cosmetic respawn. Additive glows use
 * depthWrite:false / fog:false; the deck markings + sign are emissive, not lights.
 */

const ROBOT_COUNT = { high: 6, medium: 4, low: 3 } as const

// Landing-pad placement (local deck space). The back-left/centre of the deck is
// the clearest patch — it dodges the back-right sky elevator (~x+18,z-29) and the
// energy pylons (~x±33,z-25). Robots touch down inside LAND_R of this point.
const LZ_X = -8
const LZ_Z = -30
const LAND_R = 8.5

const CHUTE_TOP = 54           // local y a robot resets to (high, drifts down in view)
const FALL_MIN = 4.5           // descent speed floor (m/s)
const FALL_VAR = 2.5           // + up to this much
const SWAY = 1.3               // canopy sway amplitude (softened under reduced motion)
const STAND_Y = 0              // group y when feet are on the deck (feet modelled below 0)
const WALK_SPEED = 3.2         // deck walk speed after landing (local m/s)
const SINK_Y = -34             // y a diver sinks to past the rim before re-dropping

// Cyan / steel / lime accent family — magenta is reserved for the hero DROP ZONE
// sign per the art direction, so the canopies + visors stay cool here.
const TINTS = [0x49e0ff, 0x7fd8ff, 0x9bff6a, 0x4af0c0, 0xffd24a, 0xdff2ff]

interface Robot {
  group: THREE.Group
  canopy: THREE.Object3D
  risers: THREE.Object3D[]
  legL: THREE.Object3D
  legR: THREE.Object3D
  bodyMat: THREE.MeshStandardMaterial
  state: 'descend' | 'walk' | 'dive'
  x: number
  z: number
  y: number
  fall: number
  swayPhase: number
  swaySpeed: number
  tx: number
  tz: number
  bob: number
}

export class ParachuteDropZone {
  private root = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private robots: Robot[] = []
  private ringMat!: THREE.MeshBasicMaterial
  private beaconMats: THREE.MeshBasicMaterial[] = []
  private signGlow!: THREE.MeshBasicMaterial
  private chevrons: THREE.Mesh[] = []
  private t = 0
  private radius: number

  // Shared part geometries (authored once, reused by every robot).
  private g!: {
    torso: THREE.BufferGeometry; head: THREE.BufferGeometry; visor: THREE.BufferGeometry
    leg: THREE.BufferGeometry; foot: THREE.BufferGeometry; arm: THREE.BufferGeometry
    pack: THREE.BufferGeometry; core: THREE.BufferGeometry; canopy: THREE.BufferGeometry
    riser: THREE.BufferGeometry
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(geo: T): T { this.geos.push(geo); return geo }

  constructor(parent: THREE.Group, opts: { radius: number }) {
    this.radius = opts.radius
    this.g = {
      torso: this.ownG(new THREE.BoxGeometry(0.72, 0.92, 0.46)),
      head: this.ownG(new THREE.BoxGeometry(0.46, 0.46, 0.46)),
      visor: this.ownG(new THREE.BoxGeometry(0.34, 0.1, 0.06)),
      leg: this.ownG(new THREE.BoxGeometry(0.2, 0.72, 0.22)),
      foot: this.ownG(new THREE.BoxGeometry(0.26, 0.14, 0.36)),
      arm: this.ownG(new THREE.BoxGeometry(0.17, 0.74, 0.17)),
      pack: this.ownG(new THREE.BoxGeometry(0.44, 0.52, 0.22)),
      core: this.ownG(new THREE.CylinderGeometry(0.12, 0.12, 0.07, 10)),
      canopy: this.ownG(new THREE.ConeGeometry(2.3, 1.2, 12, 1, true)),
      riser: this.ownG(new THREE.BoxGeometry(0.05, 1.9, 0.05)),
    }

    this.buildLandingPad()
    this.buildSign()

    const n = ROBOT_COUNT[config.tier.name]
    for (let i = 0; i < n; i++) {
      const robot = this.makeRobot(TINTS[i % TINTS.length])
      this.robots.push(robot)
      // Stagger: a couple start already on the deck walking off, the rest drift in.
      this.respawn(robot, true)
      if (i % 3 === 0) this.startWalker(robot)
    }

    parent.add(this.root)
  }

  /** Marked landing pad on the deck: a pulsing target ring + cross, a flow of
   *  chevrons pointing to the back rim ("walk this way to dive"), and corner
   *  beacons. All emissive / additive (no dynamic lights). */
  private buildLandingPad() {
    // Dark pad slab so the ring reads against the deck grid.
    const slab = new THREE.Mesh(
      this.ownG(new THREE.CircleGeometry(LAND_R, 36)),
      this.own(new THREE.MeshStandardMaterial({ color: 0x0c1626, metalness: 0.5, roughness: 0.6, emissive: 0x0a1c30, emissiveIntensity: 0.5 })),
    )
    slab.rotation.x = -Math.PI / 2; slab.position.set(LZ_X, 0.03, LZ_Z); this.root.add(slab)

    // Pulsing target ring (animated) + a static inner ring.
    this.ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const ring = new THREE.Mesh(this.ownG(new THREE.RingGeometry(LAND_R - 1.1, LAND_R - 0.5, 48)), this.ringMat)
    ring.rotation.x = -Math.PI / 2; ring.position.set(LZ_X, 0.05, LZ_Z); this.root.add(ring)
    const inner = new THREE.Mesh(this.ownG(new THREE.RingGeometry(2.4, 2.8, 36)), this.ringMat)
    inner.rotation.x = -Math.PI / 2; inner.position.set(LZ_X, 0.05, LZ_Z); this.root.add(inner)
    // Centre cross-hair "H" (helipad-style) bars.
    for (const rot of [0, Math.PI / 2]) {
      const bar = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(0.5, 4)), this.ringMat)
      bar.rotation.x = -Math.PI / 2; bar.rotation.z = rot; bar.position.set(LZ_X, 0.05, LZ_Z); this.root.add(bar)
    }

    // Flow chevrons from the pad to the back rim, pointing -Z (toward the dive).
    const chevMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9bff6a, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const chevGeo = this.ownG(new THREE.PlaneGeometry(3.4, 1.6))
    const tex = this.chevronTex(); this.texs.push(tex); chevMat.map = tex
    const startZ = LZ_Z - LAND_R + 1, endZ = -this.radius + 4
    const steps = 5
    for (let i = 0; i < steps; i++) {
      const z = startZ + (endZ - startZ) * (i / (steps - 1))
      const ch = new THREE.Mesh(chevGeo, chevMat)
      ch.rotation.x = -Math.PI / 2; ch.rotation.z = Math.PI // point -Z
      ch.position.set(LZ_X, 0.06, z); this.root.add(ch); this.chevrons.push(ch)
    }

    // Corner beacons around the pad (blink out of phase in update).
    const beaconGeo = this.ownG(new THREE.CylinderGeometry(0.16, 0.22, 1.4, 8))
    const capGeo = this.ownG(new THREE.SphereGeometry(0.28, 10, 8))
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4
      const bx = LZ_X + Math.cos(a) * (LAND_R - 0.4)
      const bz = LZ_Z + Math.sin(a) * (LAND_R - 0.4)
      const post = new THREE.Mesh(beaconGeo, this.own(new THREE.MeshStandardMaterial({ color: 0x16202f, metalness: 0.6, roughness: 0.5 })))
      post.position.set(bx, 0.7, bz); this.root.add(post)
      const capMat = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const cap = new THREE.Mesh(capGeo, capMat); cap.position.set(bx, 1.5, bz); this.root.add(cap)
      this.beaconMats.push(capMat)
    }
  }

  /** A neon DROP ZONE / PARACHUTE ARRIVALS billboard at the back rim, facing the
   *  deck centre so a player who turns around reads it instantly. */
  private buildSign() {
    const sz = -this.radius + 7
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.6, roughness: 0.4 }))
    for (const sx of [-10, 10]) { const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.8, 12, 0.8)), postMat); post.position.set(LZ_X + sx, 6, sz); this.root.add(post) }
    const tex = this.signTex(); this.texs.push(tex)
    const panel = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(22, 7.5)), this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide })))
    panel.position.set(LZ_X, 9.5, sz) // default +Z normal faces the deck centre — no flip
    this.root.add(panel)
    this.signGlow = this.own(new THREE.MeshBasicMaterial({ color: 0x49e0ff, fog: false }))
    for (const y of [13.4, 5.8]) { const bar = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(23, 0.4, 0.4)), this.signGlow); bar.position.set(LZ_X, y, sz); this.root.add(bar) }
  }

  /** One Unit 7 robot under a canopy: low-poly humanoid + tinted glow accents. */
  private makeRobot(tint: number): Robot {
    const g = new THREE.Group(); g.scale.setScalar(1.15)
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x6f7f9c, metalness: 0.45, roughness: 0.5, emissive: tint, emissiveIntensity: 0.4, transparent: true, opacity: 1 }))
    const glowMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 1, fog: false }))
    const darkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x161d2e, metalness: 0.6, roughness: 0.45, transparent: true, opacity: 1 }))

    const torso = new THREE.Mesh(this.g.torso, bodyMat); torso.position.y = 1.5; g.add(torso)
    const core = new THREE.Mesh(this.g.core, glowMat); core.rotation.x = Math.PI / 2; core.position.set(0, 1.55, 0.24); g.add(core)
    const pack = new THREE.Mesh(this.g.pack, darkMat); pack.position.set(0, 1.55, -0.3); g.add(pack)
    const head = new THREE.Mesh(this.g.head, bodyMat); head.position.y = 2.2; g.add(head)
    const visor = new THREE.Mesh(this.g.visor, glowMat); visor.position.set(0, 2.22, 0.24); g.add(visor)
    const armL = new THREE.Mesh(this.g.arm, bodyMat); armL.position.set(-0.46, 1.5, 0); g.add(armL)
    const armR = new THREE.Mesh(this.g.arm, bodyMat); armR.position.set(0.46, 1.5, 0); g.add(armR)
    const legL = new THREE.Mesh(this.g.leg, bodyMat); legL.position.set(-0.18, 0.72, 0)
    const legR = new THREE.Mesh(this.g.leg, bodyMat); legR.position.set(0.18, 0.72, 0)
    for (const leg of [legL, legR]) { const foot = new THREE.Mesh(this.g.foot, darkMat); foot.position.set(0, -0.42, 0.07); leg.add(foot); g.add(leg) }

    // Tinted canopy + two crossed risers (hidden once it lands).
    const canopyMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const canopy = new THREE.Mesh(this.g.canopy, canopyMat); canopy.position.y = 4.4; g.add(canopy)
    const riserMat = this.own(new THREE.MeshBasicMaterial({ color: 0x33424f, fog: true }))
    const risers: THREE.Object3D[] = []
    for (let r = 0; r < 2; r++) {
      const riser = new THREE.Mesh(this.g.riser, riserMat)
      riser.position.set(r === 0 ? -0.4 : 0.4, 3.0, 0); riser.rotation.z = r === 0 ? 0.16 : -0.16
      g.add(riser); risers.push(riser)
    }

    this.root.add(g)
    return {
      group: g, canopy, risers, legL, legR, bodyMat,
      state: 'descend', x: 0, z: 0, y: 0, fall: 0,
      swayPhase: Math.random() * Math.PI * 2, swaySpeed: 0.6 + Math.random() * 0.5,
      tx: 0, tz: 0, bob: Math.random() * Math.PI * 2,
    }
  }

  /** Send a robot back to the top to drift down again, aimed at a fresh touchdown
   *  point inside the landing pad. `stagger` spreads start heights on first spawn. */
  private respawn(c: Robot, stagger = false) {
    const r = LAND_R * (0.1 + Math.random() * 0.75)
    const a = Math.random() * Math.PI * 2
    c.x = LZ_X + Math.cos(a) * r
    c.z = LZ_Z + Math.sin(a) * r
    c.fall = FALL_MIN + Math.random() * FALL_VAR
    c.swayPhase = Math.random() * Math.PI * 2
    c.state = 'descend'
    c.bob = Math.random() * Math.PI * 2
    c.canopy.visible = true
    for (const ri of c.risers) ri.visible = true
    c.legL.rotation.x = 0; c.legR.rotation.x = 0
    c.bodyMat.opacity = 1
    c.group.rotation.set(0, Math.random() * Math.PI * 2, 0)
    c.y = stagger ? STAND_Y + Math.random() * (CHUTE_TOP - STAND_Y) : CHUTE_TOP
    c.group.position.set(c.x, c.y, c.z)
  }

  /** Drop a finished unit straight onto the deck already walking off the back rim,
   *  to seed visible foot traffic at startup. */
  private startWalker(c: Robot) {
    c.canopy.visible = false
    for (const ri of c.risers) ri.visible = false
    c.y = STAND_Y
    c.x = LZ_X + (Math.random() - 0.5) * LAND_R
    c.z = LZ_Z - Math.random() * (this.radius * 0.4)
    c.group.position.set(c.x, c.y, c.z)
    this.headToEdge(c)
  }

  /** Aim a landed robot at the back rim along -Z so it steps off into a dive. */
  private headToEdge(c: Robot) {
    c.state = 'walk'
    c.tx = c.x
    c.tz = -(this.radius + 12)
  }

  update(dt: number) {
    this.t += dt
    const reduced = config.reducedMotion
    const swayAmp = reduced ? SWAY * 0.35 : SWAY

    // Pulsing pad markings + blinking beacons (cheap uniform writes).
    this.ringMat.opacity = 0.5 + Math.sin(this.t * 2.4) * 0.35
    for (let i = 0; i < this.beaconMats.length; i++) this.beaconMats[i].opacity = 0.3 + Math.pow(Math.max(0, Math.sin(this.t * 2 + i * 1.6)), 4) * 0.7
    // Chevrons flow toward the rim (a travelling brightness wave).
    for (let i = 0; i < this.chevrons.length; i++) {
      const m = this.chevrons[i].material as THREE.MeshBasicMaterial
      m.opacity = 0.3 + Math.pow(Math.max(0, Math.sin(this.t * 2.6 - i * 0.7)), 2) * 0.6
    }
    this.signGlow.opacity = 0.7 + Math.sin(this.t * 2.2) * 0.25

    for (let i = 0; i < this.robots.length; i++) {
      const c = this.robots[i]
      const g = c.group

      if (c.state === 'descend') {
        c.y -= c.fall * dt
        const sway = Math.sin(this.t * c.swaySpeed + c.swayPhase) * swayAmp
        g.position.set(c.x + sway, c.y, c.z)
        g.rotation.z = reduced ? 0 : Math.sin(this.t * c.swaySpeed + c.swayPhase) * 0.1
        if (c.y <= STAND_Y) {
          c.y = STAND_Y
          g.position.set(c.x, c.y, c.z)
          g.rotation.z = 0
          c.canopy.visible = false
          for (const ri of c.risers) ri.visible = false
          this.headToEdge(c)
        }
        continue
      }

      if (c.state === 'walk') {
        const dx = c.tx - c.x, dz = c.tz - c.z
        const d = Math.hypot(dx, dz)
        if (d > 0.01) {
          const step = Math.min(d, WALK_SPEED * dt)
          c.x += (dx / d) * step
          c.z += (dz / d) * step
          g.rotation.y = Math.atan2(dx, dz)
        }
        c.bob += dt * 9
        const sw = Math.sin(c.bob) * 0.5
        c.legL.rotation.x = sw; c.legR.rotation.x = -sw
        g.position.set(c.x, STAND_Y + Math.abs(Math.sin(c.bob)) * 0.07, c.z)
        if (Math.hypot(c.x, c.z) > this.radius) { c.state = 'dive'; c.legL.rotation.x = 0; c.legR.rotation.x = 0 }
        continue
      }

      // Off the rim: pitch into a dive, sink out of view, fade, then re-drop.
      c.z += WALK_SPEED * 1.2 * dt
      c.y -= (FALL_MIN + 3) * dt
      g.position.set(c.x, c.y, c.z)
      g.rotation.x = Math.min(0.7, g.rotation.x + dt * 1.6)
      // Fade out as it sinks (c.y and SINK_Y are both negative, so the ratio is 0..1).
      c.bodyMat.opacity = Math.max(0, 1 - c.y / SINK_Y)
      if (c.y < SINK_Y) { g.rotation.set(0, 0, 0); this.respawn(c) }
    }
  }

  private chevronTex(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, 128, 64)
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 14; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.beginPath(); ctx.moveTo(24, 48); ctx.lineTo(64, 16); ctx.lineTo(104, 48); ctx.stroke()
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private signTex(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 384
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, 1024, 384)
    ctx.fillStyle = 'rgba(73,224,255,0.05)'; for (let y = 0; y < 384; y += 6) ctx.fillRect(0, y, 1024, 2)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#49e0ff'; ctx.shadowBlur = 18; ctx.fillStyle = '#d8f6ff'
    ctx.font = '900 150px ui-monospace, Menlo, monospace'; ctx.fillText('DROP ZONE', 512, 150)
    ctx.shadowColor = '#9bff6a'; ctx.shadowBlur = 14; ctx.fillStyle = '#cdffb0'
    ctx.font = '800 58px ui-monospace, Menlo, monospace'; ctx.fillText('▲ UNIT 7 ARRIVALS ▲', 512, 285)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root)
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
    this.geos.length = 0
    this.mats.length = 0
    this.texs.length = 0
    this.robots.length = 0
  }
}
