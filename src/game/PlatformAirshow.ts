import * as THREE from 'three'
import { config } from './config'

/**
 * Platform airshow: launch-pad-only set dressing for the opening spawn platform.
 *
 * It brings the airspace around the launch pad to life while the player stands
 * on the deck deciding to dive: sleek low-poly PLANES/SHUTTLES streak past at
 * altitude, and little ROBOTS PARACHUTE DOWN past the platform edge — a quiet
 * "others are diving too" loop that foreshadows the drop the player is about to
 * make. It is pure visual flavour: it never touches gameplay, physics or the
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
 * (~34). "Over the edge" therefore means beyond `radius` horizontally while
 * descending below y=0 — that is where the parachutists sink out of view.
 *
 * Draw cost / tiering: counts are tier-scaled (see PLANE_COUNT / CHUTE_COUNT).
 * Geometries and materials are SHARED across instances via own/ownG, but because
 * there are only a handful of each, every craft and every parachutist is its own
 * small THREE.Group of a few meshes (cheaper to author than instancing, still a
 * tiny, bounded mesh count). Per-frame motion reuses scratch objects — no
 * per-frame heap allocation. Additive engine glows / canopy glows use
 * depthWrite:false and fog:false; on the low tier the engine-trail glow is
 * dropped entirely (planes + parachutists still both run, just at low counts).
 *
 * Reduced motion: config.reducedMotion is read live in update(). When set, the
 * parachutists' sway amplitude is softened (calmer descent) and nothing flashes.
 */

const PLANE_COUNT = { high: 5, medium: 3, low: 2 } as const
const CHUTE_COUNT = { high: 4, medium: 3, low: 2 } as const

// ---- Plane/shuttle tuning (all local units) -------------------------------
const PLANE_ALT_MIN = 30        // lowest cruise altitude (local y)
const PLANE_ALT_VAR = 50        // + up to this much altitude (so y ~ 30..80)
const PLANE_SPEED_MIN = 14      // m/s along the pass
const PLANE_SPEED_VAR = 10      // + up to this much speed
const PLANE_BANK = 0.22         // roll (radians) into the pass for a little life
const PLANE_BOB = 0.6           // gentle vertical bob amplitude

// ---- Parachutist tuning (all local units) ---------------------------------
const CHUTE_TOP = 90            // local y a parachutist resets to (drops from up high)
const CHUTE_FALL_MIN = 4.5      // descent speed floor (m/s)
const CHUTE_FALL_VAR = 2.5      // + up to this much descent speed
const CHUTE_BOTTOM = -60        // local y at which a parachutist has sunk out of view -> reset
const CHUTE_SWAY = 1.4          // horizontal sway amplitude (softened under reduced motion)
const CHUTE_RIM_PAD = 4         // how far beyond `radius` they spawn, so they pass the edge

// Neon palette shared by both craft accents and parachute canopies.
const PALETTE = [0x49e0ff, 0x9bff6a, 0xffd24a, 0xff5ad0, 0xb07cff, 0xff8a4a]

interface Plane {
  group: THREE.Group
  dir: THREE.Vector3     // unit travel direction (XZ), reused, never reallocated
  baseY: number          // cruise altitude this pass
  speed: number
  bound: number          // |pos| at which the craft wraps to the far side
  phase: number          // bob phase offset
}

interface Chute {
  group: THREE.Group
  angle: number          // bearing around the rim (where over the edge it sits)
  radius: number         // horizontal distance from centre
  y: number              // current local height
  fall: number           // descent speed
  swayPhase: number      // sway phase offset
  swaySpeed: number      // sway frequency
}

export class PlatformAirshow {
  private root = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private planes: Plane[] = []
  private chutes: Chute[] = []
  private t = 0
  private radius: number

  // Per-frame scratch (no heap allocation in update()).
  private readonly scratchV = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(parent: THREE.Group, opts: { radius: number }) {
    this.radius = opts.radius
    const tier = config.tier.name
    const nPlanes = PLANE_COUNT[tier]
    const nChutes = CHUTE_COUNT[tier]
    const withTrail = tier !== 'low'   // drop the additive engine glow on low

    // ----- Shared geometry (authored once, reused by every craft/chute) -----
    // Fuselage: a stretched, pointed body. Wings: a thin swept box. Engine
    // trail: a small additive quad streaming behind the craft.
    const fuselageGeo = this.ownG(new THREE.CylinderGeometry(0.0, 0.9, 7.0, 8))
    const wingGeo = this.ownG(new THREE.BoxGeometry(9.0, 0.18, 1.8))
    const tailGeo = this.ownG(new THREE.BoxGeometry(0.18, 1.6, 1.4))
    const trailGeo = this.ownG(new THREE.PlaneGeometry(1.4, 6.0))

    // Parachutist: a tiny blocky robot body + a head, a curved canopy (a cone),
    // and a thin riser box standing in for the lines.
    const robotBodyGeo = this.ownG(new THREE.BoxGeometry(0.8, 1.0, 0.5))
    const robotHeadGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.5, 0.5))
    const canopyGeo = this.ownG(new THREE.ConeGeometry(2.2, 1.1, 12, 1, true))
    const riserGeo = this.ownG(new THREE.BoxGeometry(0.06, 1.8, 0.06))

    // ----- Shared materials -------------------------------------------------
    const hullMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbfd0e0, fog: true }))
    const wingMat = this.own(new THREE.MeshBasicMaterial({ color: 0x8fa3b8, fog: true }))
    // Additive engine trail; glow doubles as opacity. depthWrite off so it never
    // occludes, fog off so it stays bright at distance.
    const trailMat = this.own(new THREE.MeshBasicMaterial({
      color: 0x49e0ff,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }))
    const robotMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fb0c0, fog: true }))
    const headMat = this.own(new THREE.MeshBasicMaterial({ color: 0xd0dce8, fog: true }))
    const riserMat = this.own(new THREE.MeshBasicMaterial({ color: 0x33424f, fog: true }))
    // Canopy: additive neon glow, double-sided (it's an open cone), no fog so it
    // pops against the sky as it drifts past the edge.
    const canopyMat = this.own(new THREE.MeshBasicMaterial({
      color: 0xff5ad0,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    }))

    // ----- Build planes -----------------------------------------------------
    for (let i = 0; i < nPlanes; i++) {
      const g = new THREE.Group()

      // Fuselage points +Z (nose forward): rotate the cylinder from +Y to +Z.
      const fuselage = new THREE.Mesh(fuselageGeo, hullMat)
      fuselage.rotation.x = Math.PI / 2
      g.add(fuselage)

      const wing = new THREE.Mesh(wingGeo, wingMat)
      wing.rotation.y = 0.18   // slight sweep
      g.add(wing)

      const tail = new THREE.Mesh(tailGeo, wingMat)
      tail.position.set(0, 0.5, -3.0)
      g.add(tail)

      if (withTrail) {
        // Streams behind the nose direction; the plane group is oriented to face
        // travel, so a -Z offset puts the trail at the tail.
        const trail = new THREE.Mesh(trailGeo, trailMat)
        trail.position.set(0, 0, -5.2)
        trail.rotation.x = Math.PI / 2
        g.add(trail)
      }

      this.root.add(g)
      this.planes.push({
        group: g,
        dir: new THREE.Vector3(1, 0, 0),
        baseY: 0,
        speed: 0,
        bound: 0,
        phase: Math.random() * Math.PI * 2,
      })
      this.respawnPlane(this.planes[i], true)
    }

    // ----- Build parachutists ----------------------------------------------
    for (let i = 0; i < nChutes; i++) {
      const g = new THREE.Group()

      const body = new THREE.Mesh(robotBodyGeo, robotMat)
      body.position.y = 0
      g.add(body)

      const head = new THREE.Mesh(robotHeadGeo, headMat)
      head.position.y = 0.75
      g.add(head)

      // Two crossed risers angling up to the canopy.
      for (let r = 0; r < 2; r++) {
        const riser = new THREE.Mesh(riserGeo, riserMat)
        riser.position.set(r === 0 ? -0.4 : 0.4, 1.6, 0)
        riser.rotation.z = r === 0 ? 0.18 : -0.18
        g.add(riser)
      }

      // Canopy glow: per-chute tint so the sky reads as a few different divers.
      const canopyTinted = this.own((canopyMat.clone() as THREE.MeshBasicMaterial))
      canopyTinted.color.setHex(PALETTE[(Math.random() * PALETTE.length) | 0])
      const canopy = new THREE.Mesh(canopyGeo, canopyTinted)
      canopy.position.y = 3.0
      g.add(canopy)

      this.root.add(g)
      this.chutes.push({
        group: g,
        angle: 0,
        radius: 0,
        y: 0,
        fall: 0,
        swayPhase: Math.random() * Math.PI * 2,
        swaySpeed: 0.6 + Math.random() * 0.5,
      })
      // Stagger initial heights so they don't all reset in lockstep.
      this.respawnChute(this.chutes[i], true)
    }

    parent.add(this.root)
  }

  /** Place a plane at one edge of its pass with a fresh altitude/offset/speed.
   *  `stagger` spreads the craft along the path on first spawn so they don't all
   *  enter together. Allocation-free: mutates the plane's reused dir vector. */
  private respawnPlane(p: Plane, stagger = false) {
    // Pick a travel heading around the compass and a lateral offset so passes
    // don't all overlap the centre.
    const heading = Math.random() * Math.PI * 2
    p.dir.set(Math.cos(heading), 0, Math.sin(heading))
    p.baseY = PLANE_ALT_MIN + Math.random() * PLANE_ALT_VAR
    p.speed = PLANE_SPEED_MIN + Math.random() * PLANE_SPEED_VAR
    // Travel far enough out that the craft clears the deck on both sides.
    p.bound = this.radius * 3.5 + 40

    // Perpendicular lateral offset (sideways from the travel line).
    const perpX = -p.dir.z
    const perpZ = p.dir.x
    const lateral = (Math.random() * 2 - 1) * (this.radius * 1.6)

    // Start back at the entry edge (or somewhere along it if staggering).
    const along = stagger ? (Math.random() * 2 - 1) * p.bound : -p.bound
    const g = p.group
    g.position.set(
      p.dir.x * along + perpX * lateral,
      p.baseY,
      p.dir.z * along + perpZ * lateral,
    )
    // Orient the group so +Z (nose) faces travel direction; add a slight bank.
    g.rotation.set(0, Math.atan2(p.dir.x, p.dir.z), PLANE_BANK)
  }

  /** Send a parachutist back to the top to drift down again. They spawn just
   *  beyond the deck rim (radius + pad) so their descent visibly crosses the
   *  platform edge. `stagger` spreads start heights on first spawn. */
  private respawnChute(c: Chute, stagger = false) {
    c.angle = Math.random() * Math.PI * 2
    c.radius = this.radius + CHUTE_RIM_PAD + Math.random() * 8
    c.fall = CHUTE_FALL_MIN + Math.random() * CHUTE_FALL_VAR
    c.swayPhase = Math.random() * Math.PI * 2
    // Fresh start near the top; stagger drops some partway down so the sky is
    // already populated on the first frame.
    c.y = stagger ? CHUTE_BOTTOM + Math.random() * (CHUTE_TOP - CHUTE_BOTTOM) : CHUTE_TOP
  }

  update(dt: number) {
    this.t += dt
    const reduced = config.reducedMotion
    const swayAmp = reduced ? CHUTE_SWAY * 0.35 : CHUTE_SWAY

    // ----- Planes: straight pass, wrap when past the bound --------------------
    for (let i = 0; i < this.planes.length; i++) {
      const p = this.planes[i]
      const g = p.group
      // Advance along the travel direction.
      g.position.x += p.dir.x * p.speed * dt
      g.position.z += p.dir.z * p.speed * dt
      // Gentle vertical bob around the cruise altitude (cosmetic).
      g.position.y = p.baseY + Math.sin(this.t * 0.6 + p.phase) * PLANE_BOB

      // Distance from centre along the pass; wrap to the far side when past it.
      const distSq = g.position.x * g.position.x + g.position.z * g.position.z
      if (distSq > p.bound * p.bound) {
        this.respawnPlane(p)
      }
    }

    // ----- Parachutists: sink past the edge, sway, reset at the bottom -------
    for (let i = 0; i < this.chutes.length; i++) {
      const c = this.chutes[i]
      c.y -= c.fall * dt
      if (c.y < CHUTE_BOTTOM) {
        this.respawnChute(c)
      }

      // Sway: a gentle horizontal oscillation along the tangent at the rim, plus
      // a tiny lean so the canopy rocks. Reused scratch for the tangent dir.
      const sway = Math.sin(this.t * c.swaySpeed + c.swayPhase) * swayAmp
      const tx = -Math.sin(c.angle)   // tangent to the rim circle
      const tz = Math.cos(c.angle)
      this.scratchV.set(
        Math.cos(c.angle) * c.radius + tx * sway,
        c.y,
        Math.sin(c.angle) * c.radius + tz * sway,
      )
      const g = c.group
      g.position.copy(this.scratchV)
      // Lean the whole rig into the sway (flattened under reduced motion).
      g.rotation.z = reduced ? 0 : Math.sin(this.t * c.swaySpeed + c.swayPhase) * 0.12
    }
  }

  dispose() {
    // Detach the whole subtree from the launch-pad group, then free every owned
    // geometry, material and the per-chute cloned canopy materials. No leaks.
    if (this.root.parent) this.root.parent.remove(this.root)
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.geos.length = 0
    this.mats.length = 0
    this.planes.length = 0
    this.chutes.length = 0
  }
}
