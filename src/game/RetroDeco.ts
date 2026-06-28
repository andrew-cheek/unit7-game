import * as THREE from 'three'
import { config } from './config'

/**
 * Retro deco: launch-pad-only set dressing for the opening spawn platform.
 *
 * It dresses the rim of the launch deck with a small set of "retro-futurism"
 * hero props — raygun-gothic / atompunk / 1950s space-age styling blended with
 * sci-fi neon — that tie the platform's aesthetic together while the player
 * stands on the deck deciding to dive. The cast:
 *   - CHROME RINGED PLANET: a chrome/gold sphere wearing a tilted Saturn ring,
 *     spinning slowly and bobbing, wrapped in a soft additive halo. The classic
 *     atompunk motif.
 *   - ATOMIC-ORBIT sculpture: a glowing amber nucleus circled by three tilted
 *     thin-torus orbital rings, each carrying a little electron sphere that
 *     travels around it (angle driven off this.t).
 *   - RAYGUN-GOTHIC FINNED PYLON: a streamlined chrome rocket-spire with swept
 *     fins and a glowing amber tip — art-deco rocket-age styling.
 *   - STARBURST NEON SIGN: a flat additive "atomic starburst" of radiating
 *     spokes paired with a CRT-style canvas placard ("UNIT 7 SPACEPORT", rounded
 *     corners + scanlines) that pulses gently.
 *
 * It is pure visual flavour: it never touches gameplay, physics or the
 * fixed-timestep sim, so all its motion may use Math.random / Math.sin freely
 * and is allowed to be fully frame-rate-driven off dt. Nothing here feeds
 * determinism.
 *
 * Lifetime: this is NOT a GameSystem and is NOT zone-gated. It lives exactly as
 * long as the launch pad exists — the orchestrator constructs it when the pad is
 * built and calls dispose() when the pad is torn down. It attaches every mesh to
 * the passed-in `parent` group (the launch-pad group), so it inherits the pad's
 * transform and vanishes with it.
 *
 * Local coordinates: all positions are LOCAL to `parent`. The platform deck sits
 * at local y≈0, centred on the local origin, with deck radius `opts.radius`
 * (~50). The player spawns near the local origin/front and dives off the +Z
 * ledge, so props are pushed to the BACK (−Z) corners and far sides at the rim —
 * the front-centre and the +Z ledge are kept clear so nothing blocks the spawn
 * or the path to the edge.
 *
 * Draw cost / tiering: counts are tier-scaled (PROP_SLOTS picks which of the
 * fixed prop layout slots are filled — high ~4-5, medium ~3, low ~2). Geometries
 * and materials are SHARED across repeated parts (one chrome material, one ring
 * geo, one electron geo, etc.); each prop is a small THREE.Group of a handful of
 * meshes, so the whole set is a couple dozen meshes at most. Per-frame motion
 * reuses scratch objects — no per-frame heap allocation. Additive glows / the
 * starburst / the halos use depthWrite:false and fog:false so they stay bright.
 * One CanvasTexture is created for the placard and tracked for disposal.
 *
 * Reduced motion: config.reducedMotion is read live in update(). When set, the
 * spin/orbit speeds are scaled down, the bob is softened, and the neon pulse is
 * flattened to a steady glow — nothing flashes.
 */

// Which prop slots are populated per tier. Each entry indexes into PROP_LAYOUT;
// high fills all five, medium three, low two — always keeping the marquee
// pieces (ringed planet + starburst sign).
const PROP_SLOTS = {
  high: [0, 1, 2, 3, 4],
  medium: [0, 1, 4],
  low: [0, 4],
} as const

// Fixed placement around the rim, in LOCAL units relative to deck radius.
// `rf` is the fraction of `opts.radius` to push the prop out to; angle is in
// radians measured so that +Z (the dive ledge / front) is left clear. We bias
// everything toward −Z (back) and the far sides. `kind` selects the builder.
type PropKind = 'planet' | 'atom' | 'pylon' | 'atom2' | 'sign'
interface PropLayout { kind: PropKind; angle: number; rf: number; y: number }
const PROP_LAYOUT: PropLayout[] = [
  // 0: ringed planet — back-left corner, floating above the rim.
  { kind: 'planet', angle: Math.PI * 0.78, rf: 0.86, y: 7.5 },
  // 1: atomic orbit — back-right corner.
  { kind: 'atom', angle: Math.PI * 1.22, rf: 0.86, y: 6.0 },
  // 2: finned pylon — far −Z (dead back), standing tall on the rim.
  { kind: 'pylon', angle: Math.PI, rf: 0.92, y: 0 },
  // 3: second smaller atom — left side, mid.
  { kind: 'atom2', angle: Math.PI * 0.5, rf: 0.9, y: 5.0 },
  // 4: starburst neon sign — back, raised like a marquee over the deck.
  { kind: 'sign', angle: Math.PI * 0.98, rf: 0.82, y: 9.0 },
]

// Palette: chrome reads off the standard material's metalness; the rest are
// emissive/additive neon — warm amber/gold plus cyan and a touch of magenta.
const CHROME = 0xeef2f6
const GOLD = 0xffc24a
const AMBER = 0xff9a2e
const CYAN = 0x49e0ff
const MAGENTA = 0xff5ad0

interface Planet {
  group: THREE.Group
  ring: THREE.Object3D
  halo: THREE.Object3D
  spin: number
  bobPhase: number
}
interface Atom {
  group: THREE.Group
  nucleus: THREE.Object3D
  rings: THREE.Object3D[]      // tilted orbital rings (their own spin)
  electrons: THREE.Object3D[]  // one per ring, parented under the ring
  orbitR: number[]             // orbit radius per electron
  spin: number
  bobPhase: number
}
interface Pylon {
  group: THREE.Group
  tip: THREE.Object3D
  tipMat: THREE.MeshBasicMaterial   // pulsed
}
interface Sign {
  group: THREE.Group
  burst: THREE.Object3D
  panelMat: THREE.MeshBasicMaterial // pulsed
  burstMat: THREE.MeshBasicMaterial // pulsed
  bobPhase: number
}

export class RetroDeco {
  private root = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private planets: Planet[] = []
  private atoms: Atom[] = []
  private pylons: Pylon[] = []
  private signs: Sign[] = []
  private t = 0
  private radius: number

  // Per-frame scratch (no heap allocation in update()).
  private readonly scratchV = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private ownT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t }

  constructor(parent: THREE.Group, opts: { radius: number }) {
    this.radius = opts.radius
    const tier = config.tier.name
    const slots = PROP_SLOTS[tier]

    // ----- Shared materials -------------------------------------------------
    // Chrome: physically shiny near-white standard material (high metalness, low
    // roughness) so it catches the platform's lights. Reused by every chrome part.
    const chromeMat = this.own(new THREE.MeshStandardMaterial({
      color: CHROME, metalness: 1.0, roughness: 0.18, fog: true,
    }))
    // Gold variant of the chrome look for warm accents (planet ring, fins).
    const goldMat = this.own(new THREE.MeshStandardMaterial({
      color: GOLD, metalness: 1.0, roughness: 0.28, fog: true,
    }))
    // Solid emissive neons (used where the part should read as a lit body, not a
    // translucent glow): nucleus + electrons.
    const amberSolid = this.own(new THREE.MeshBasicMaterial({ color: AMBER, fog: false }))
    const cyanSolid = this.own(new THREE.MeshBasicMaterial({ color: CYAN, fog: false }))

    // Additive glows: depthWrite off so they never occlude, fog off so they stay
    // bright. The halo and starburst share this look; tip/panel get their own
    // (cloned) instances so update() can pulse them independently.
    const haloMat = this.own(new THREE.MeshBasicMaterial({
      color: CYAN, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }))

    // ----- Shared geometry --------------------------------------------------
    const sphereGeo = this.ownG(new THREE.SphereGeometry(2.4, 20, 14))        // planet body
    const ringGeo = this.ownG(new THREE.TorusGeometry(4.2, 0.28, 10, 40))     // saturn ring
    const haloGeo = this.ownG(new THREE.PlaneGeometry(11, 11))                // soft glow quad
    const nucleusGeo = this.ownG(new THREE.SphereGeometry(0.9, 16, 12))       // atom core
    const orbitGeo = this.ownG(new THREE.TorusGeometry(2.6, 0.05, 8, 48))     // thin orbital ring
    const electronGeo = this.ownG(new THREE.SphereGeometry(0.32, 10, 8))      // electron
    const spireGeo = this.ownG(new THREE.CylinderGeometry(0.0, 1.1, 11, 14))  // rocket spire (pointed)
    const finGeo = this.ownG(new THREE.BoxGeometry(0.14, 2.6, 2.2))           // swept fin
    const tipGeo = this.ownG(new THREE.SphereGeometry(0.55, 12, 10))          // glowing nose tip
    const burstGeo = this.makeStarburstGeo()                                  // radiating spokes
    const panelGeo = this.ownG(new THREE.PlaneGeometry(9, 3.2))               // CRT placard

    // ----- Build the selected props ----------------------------------------
    for (let s = 0; s < slots.length; s++) {
      const layout = PROP_LAYOUT[slots[s]]
      const g = new THREE.Group()
      // Position on the rim from the layout angle/fraction; back/side of deck.
      const r = this.radius * layout.rf
      g.position.set(Math.cos(layout.angle) * r, layout.y, Math.sin(layout.angle) * r)
      // Face the prop loosely toward the deck centre so signage reads inward.
      g.rotation.y = Math.atan2(-g.position.x, -g.position.z)

      switch (layout.kind) {
        case 'planet':
          this.buildPlanet(g, sphereGeo, ringGeo, haloGeo, chromeMat, goldMat, haloMat)
          break
        case 'atom':
          this.buildAtom(g, nucleusGeo, orbitGeo, electronGeo, amberSolid, cyanSolid, chromeMat, 1.0)
          break
        case 'atom2':
          this.buildAtom(g, nucleusGeo, orbitGeo, electronGeo, amberSolid, cyanSolid, chromeMat, 0.7)
          break
        case 'pylon':
          this.buildPylon(g, spireGeo, finGeo, tipGeo, chromeMat, goldMat)
          break
        case 'sign':
          this.buildSign(g, burstGeo, panelGeo)
          break
      }
      this.root.add(g)
    }

    parent.add(this.root)
  }

  // ---- Builders -----------------------------------------------------------

  private buildPlanet(
    g: THREE.Group,
    sphereGeo: THREE.BufferGeometry, ringGeo: THREE.BufferGeometry, haloGeo: THREE.BufferGeometry,
    chromeMat: THREE.Material, goldMat: THREE.Material, haloMat: THREE.MeshBasicMaterial,
  ) {
    const body = new THREE.Mesh(sphereGeo, chromeMat)
    g.add(body)

    // Tilted Saturn ring (gold), rotated off the equator for the classic look.
    const ring = new THREE.Mesh(ringGeo, goldMat)
    ring.rotation.x = Math.PI / 2
    ring.rotation.z = 0.42        // tilt
    g.add(ring)

    // Soft cyan halo behind the planet (its own additive material, shared).
    const halo = new THREE.Mesh(haloGeo, haloMat)
    g.add(halo)

    this.planets.push({
      group: g, ring, halo,
      spin: 0.35,
      bobPhase: Math.random() * Math.PI * 2,
    })
  }

  private buildAtom(
    g: THREE.Group,
    nucleusGeo: THREE.BufferGeometry, orbitGeo: THREE.BufferGeometry, electronGeo: THREE.BufferGeometry,
    amberSolid: THREE.Material, cyanSolid: THREE.Material, chromeMat: THREE.Material,
    scale: number,
  ) {
    g.scale.setScalar(scale)

    const nucleus = new THREE.Mesh(nucleusGeo, amberSolid)
    g.add(nucleus)

    // Three tilted orbital rings; each carries one electron parented under it so
    // the electron rides the ring's spin for free, plus its own orbit angle.
    const rings: THREE.Object3D[] = []
    const electrons: THREE.Object3D[] = []
    const orbitR: number[] = []
    const tilts = [
      [0.0, 0.0],
      [Math.PI / 3, Math.PI / 4],
      [-Math.PI / 3, -Math.PI / 5],
    ]
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(orbitGeo, chromeMat)
      ring.rotation.x = tilts[i][0]
      ring.rotation.z = tilts[i][1]
      g.add(ring)
      rings.push(ring)

      // Electron parented to the ring so it inherits the ring's tilt; we move it
      // around the ring's local circle in update().
      const electron = new THREE.Mesh(electronGeo, cyanSolid)
      ring.add(electron)
      electrons.push(electron)
      orbitR.push(2.6)
    }

    this.atoms.push({
      group: g, nucleus, rings, electrons, orbitR,
      spin: 0.5,
      bobPhase: Math.random() * Math.PI * 2,
    })
  }

  private buildPylon(
    g: THREE.Group,
    spireGeo: THREE.BufferGeometry, finGeo: THREE.BufferGeometry, tipGeo: THREE.BufferGeometry,
    chromeMat: THREE.Material, goldMat: THREE.Material,
  ) {
    // Spire stands on the rim: cylinder centred, so lift it half its height.
    const spire = new THREE.Mesh(spireGeo, chromeMat)
    spire.position.y = 5.5
    g.add(spire)

    // Three swept fins around the base, gold for warmth.
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(finGeo, goldMat)
      const a = (i / 3) * Math.PI * 2
      fin.position.set(Math.cos(a) * 0.9, 1.5, Math.sin(a) * 0.9)
      fin.rotation.y = a
      fin.rotation.x = 0.18    // sweep back
      g.add(fin)
    }

    // Glowing amber nose tip (own additive material so it can pulse).
    const tipMat = this.own(new THREE.MeshBasicMaterial({
      color: AMBER, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }))
    const tip = new THREE.Mesh(tipGeo, tipMat)
    tip.position.y = 11.2
    g.add(tip)

    this.pylons.push({ group: g, tip, tipMat })
  }

  private buildSign(
    g: THREE.Group,
    burstGeo: THREE.BufferGeometry, panelGeo: THREE.BufferGeometry,
  ) {
    // Atomic starburst behind the panel: additive magenta spokes (own material so
    // it can pulse independently of the shared halo).
    const burstMat = this.own(new THREE.MeshBasicMaterial({
      color: MAGENTA, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }))
    const burst = new THREE.Mesh(burstGeo, burstMat)
    burst.position.z = -0.2
    burst.scale.setScalar(3.4)
    g.add(burst)

    // CRT-style placard: rounded-corner canvas with scanlines + the spaceport
    // name. Additive so the neon text glows; its own material pulses gently.
    const tex = this.ownT(this.makeSignTexture('UNIT 7 SPACEPORT'))
    const panelMat = this.own(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }))
    const panel = new THREE.Mesh(panelGeo, panelMat)
    g.add(panel)

    this.signs.push({
      group: g, burst, panelMat, burstMat,
      bobPhase: Math.random() * Math.PI * 2,
    })
  }

  // ---- Procedural geometry / textures ------------------------------------

  /** A flat "atomic starburst": alternating long/short radiating spokes built as
   *  a single triangle-fan-ish BufferGeometry centred on origin in the XY plane. */
  private makeStarburstGeo(): THREE.BufferGeometry {
    const spokes = 12
    const positions: number[] = []
    const inner = 0.12
    for (let i = 0; i < spokes; i++) {
      const a0 = (i / spokes) * Math.PI * 2
      const a1 = ((i + 0.5) / spokes) * Math.PI * 2
      const outer = i % 2 === 0 ? 1.0 : 0.62   // alternate spoke length
      // Thin triangle from centre out to a spoke tip, with a small base width.
      const bx = Math.cos(a0) * inner
      const by = Math.sin(a0) * inner
      const tx = Math.cos((a0 + a1) / 2) * outer
      const ty = Math.sin((a0 + a1) / 2) * outer
      const cx = Math.cos(a1) * inner
      const cy = Math.sin(a1) * inner
      positions.push(bx, by, 0, tx, ty, 0, cx, cy, 0)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    return this.ownG(geo)
  }

  /** CRT-style placard texture: rounded-corner dark panel, cyan/amber neon text,
   *  and horizontal scanlines. Returned as a CanvasTexture (tracked in texs). */
  private makeSignTexture(text: string): THREE.CanvasTexture {
    const w = 512, h = 192
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')!

    // Rounded-corner backing panel.
    const rad = 28
    ctx.fillStyle = '#0a0e16'
    ctx.beginPath()
    ctx.moveTo(rad, 0)
    ctx.arcTo(w, 0, w, h, rad)
    ctx.arcTo(w, h, 0, h, rad)
    ctx.arcTo(0, h, 0, 0, rad)
    ctx.arcTo(0, 0, w, 0, rad)
    ctx.closePath()
    ctx.fill()

    // Neon border.
    ctx.strokeStyle = '#49e0ff'
    ctx.lineWidth = 6
    ctx.stroke()

    // Marquee text — amber glow over cyan, retro condensed caps.
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = 'bold 64px "Arial Narrow", Arial, sans-serif'
    ctx.shadowColor = '#ff9a2e'
    ctx.shadowBlur = 22
    ctx.fillStyle = '#ffd24a'
    ctx.fillText(text, w / 2, h / 2)
    ctx.shadowBlur = 0

    // CRT scanlines.
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2)

    const tex = new THREE.CanvasTexture(cv)
    tex.anisotropy = 2
    tex.needsUpdate = true
    return tex
  }

  // ---- Per-frame motion (cosmetic; no heap allocation) -------------------

  update(dt: number) {
    this.t += dt
    const reduced = config.reducedMotion
    const spinMul = reduced ? 0.4 : 1.0
    const bobAmp = reduced ? 0.25 : 0.7
    // Neon pulse: a 0..1 oscillation, flattened to a steady glow when calm.
    const pulse = reduced ? 1.0 : 0.82 + 0.18 * Math.sin(this.t * 2.0)

    // ----- Ringed planets: spin, ring counter-tilt drift, bob, halo billboard -
    for (let i = 0; i < this.planets.length; i++) {
      const p = this.planets[i]
      p.group.rotation.y += p.spin * spinMul * dt
      // Gentle vertical bob about the prop's authored height.
      const baseY = PROP_LAYOUT_Y(p.group)
      p.group.position.y = baseY + Math.sin(this.t * 0.6 + p.bobPhase) * bobAmp
      // The ring rides the group spin; nudge its tilt slightly so it feels alive.
      p.ring.rotation.z = 0.42 + Math.sin(this.t * 0.4 + p.bobPhase) * (reduced ? 0.02 : 0.06)
    }

    // ----- Atoms: spin body, rings rotate, electrons travel their orbit ------
    for (let i = 0; i < this.atoms.length; i++) {
      const a = this.atoms[i]
      a.group.rotation.y += a.spin * spinMul * dt
      const baseY = PROP_LAYOUT_Y(a.group)
      a.group.position.y = baseY + Math.sin(this.t * 0.5 + a.bobPhase) * bobAmp * 0.6
      for (let r = 0; r < a.rings.length; r++) {
        // Each ring spins a touch on its own local axis for shimmer.
        a.rings[r].rotation.y += (0.3 + r * 0.15) * spinMul * dt
        // Electron rides the ring's local circle (XZ plane of the ring before its
        // tilt) — angle off this.t with a per-ring phase. Reused scratch vector.
        const ang = this.t * (1.2 + r * 0.5) * spinMul + (r * 2.1)
        this.scratchV.set(Math.cos(ang) * a.orbitR[r], 0, Math.sin(ang) * a.orbitR[r])
        a.electrons[r].position.copy(this.scratchV)
      }
    }

    // ----- Pylons: pulse the amber nose tip ----------------------------------
    for (let i = 0; i < this.pylons.length; i++) {
      const py = this.pylons[i]
      py.tipMat.opacity = 0.55 + 0.4 * pulse
    }

    // ----- Signs: soft bob + neon pulse on panel and starburst ---------------
    for (let i = 0; i < this.signs.length; i++) {
      const s = this.signs[i]
      const baseY = PROP_LAYOUT_Y(s.group)
      s.group.position.y = baseY + Math.sin(this.t * 0.5 + s.bobPhase) * bobAmp * 0.5
      s.panelMat.opacity = 0.7 + 0.25 * pulse
      s.burstMat.opacity = 0.35 + 0.3 * pulse
      // Slow starburst spin behind the placard.
      s.burst.rotation.z += (reduced ? 0.04 : 0.12) * dt
    }
  }

  dispose() {
    // Detach the whole subtree from the launch-pad group, then free every owned
    // geometry, material and CanvasTexture. No leaks.
    if (this.root.parent) this.root.parent.remove(this.root)
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    for (const t of this.texs) t.dispose()
    this.geos.length = 0
    this.mats.length = 0
    this.texs.length = 0
    this.planets.length = 0
    this.atoms.length = 0
    this.pylons.length = 0
    this.signs.length = 0
  }
}

/** Each prop group stashes its authored rim height on first bob so the bob
 *  oscillates about a stable centre instead of drifting. Reads from userData,
 *  seeding it once from the current y. Allocation-free. */
function PROP_LAYOUT_Y(g: THREE.Group): number {
  const ud = g.userData as { baseY?: number }
  if (ud.baseY === undefined) ud.baseY = g.position.y
  return ud.baseY
}
