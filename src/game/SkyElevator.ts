import * as THREE from 'three'
import { config } from './config'

/**
 * Sky elevator: a hero set piece for the opening spawn platform — an UNMISTAKABLE
 * glass passenger elevator that ferries little robots up to orbit, placed in the
 * player's forward-right view so it reads instantly as "this is how you leave".
 *
 * The structure: a lit lobby pad at the base (doorway threshold + glowing floor
 * ring), an open framework SHAFT with glass guide rails rising ~40 tall, and a
 * boxy glass-walled CAB (solid floor + ceiling slab, a bright glowing interior
 * light, neon edge trim) with a pair of SLIDING DOORS on the deck-facing side
 * that visibly open and close. A big retro-CRT MARQUEE above the doors cycles the
 * destination MOON / MARS. Retro-futurist chrome + amber + cyan styling, but
 * elevator legibility comes first: it is bright, big and obviously a lift.
 *
 * The passenger loop (what sells it as a working elevator) is a state machine:
 *   APPROACH  cab at base, doors open; riders spawn a few metres out and walk in.
 *   LOAD      riders park at offsets inside the cab footprint.
 *   CLOSE     doors slide together.
 *   ASCEND    cab rises up the shaft, carrying the riders with it.
 *   DELIVER   brief hold at the top, then riders fade out (delivered to orbit).
 *   DESCEND   empty cab returns to base, doors open, loop repeats fresh group.
 *
 * Lifetime: owned by the LAUNCH PAD, not the world — the orchestrator constructs
 * it when the pad builds and disposes it when the pad tears down. It is NOT a
 * GameSystem and NOT zone-gated; it lives as long as the deck does.
 *
 * Coordinates: everything attaches to the passed-in `parent` group in LOCAL space
 * — deck at local y≈0, centered at origin, deck radius `opts.radius`. The tower
 * sits in the forward-right view, clear of the assembly belt and the dive lane.
 *
 * Functional API (the game wires these): `boardLocal` / `boardRadius` give a
 * footprint the game tests the player against; `currentDest()` reports the
 * destination on the sign right now; `setBoarding(on)` brings the cab to the base
 * with its doors open (so the player can step into a receiving car) and locks the
 * sign to the current destination. The boarding ramp is purely visual — it never
 * touches physics, gameplay or determinism.
 *
 * Determinism: the cab Y, the doors, the sign cross-fade and every rider are
 * driven off an internal `this.t` / phase so it is frame-rate independent and
 * allocation-free in update() (rider structs + offsets are pre-allocated; scratch
 * vectors are reused). config.reducedMotion is read live to calm the interior /
 * marquee pulse to a steady glow and gently slow motion (never a strobe).
 *
 * Tier (config.tier.name): on 'low' we keep the cab, doors, shaft, marquee, base
 * pad, the loop and a couple of riders — we drop only fine detail (extra guide
 * rails, marquee bevel, interior props). It stays a modest handful of draws.
 */

type RiderState = 'idle' | 'walk' | 'inside'

interface Rider {
  group: THREE.Group
  visorMat: THREE.MeshBasicMaterial
  state: RiderState
  // Pre-allocated targets/offsets (local to root): spawn point on deck, slot in cab.
  spawnX: number
  spawnZ: number
  slotX: number       // offset within the cab footprint (cab-local X)
  slotZ: number       // offset within the cab footprint (cab-local Z)
  walkT: number       // 0..1 progress along the walk into the doorway
  bobPhase: number    // per-rider step-bob phase offset
  opacity: number     // current fade (1 visible, 0 gone)
}

export class SkyElevator {
  private root = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []

  private t = 0

  // Animated handles (resolved once in the constructor; mutated in update()).
  private cab!: THREE.Group
  private doorL!: THREE.Mesh
  private doorR!: THREE.Mesh
  private interiorMat!: THREE.MeshBasicMaterial   // bright glowing cab interior light
  private cabEdgeMat!: THREE.MeshBasicMaterial    // neon edge trim on the cab
  private baseRingMat!: THREE.MeshBasicMaterial   // glowing floor ring at the lobby
  private signMoonMat!: THREE.MeshBasicMaterial
  private signMarsMat!: THREE.MeshBasicMaterial

  // Cab travel limits (local Y of the cab's FLOOR), set from the shaft height.
  private cabLo = 0
  private cabHi = 0
  private cabH = 4.0          // cab height (floor->ceiling)
  private cabHalfW = 1.6      // cab half-width / depth
  private doorOpenX = 1.15    // how far each door slides apart when open
  private doorClosedX = 0.35  // door inner edge when closed
  private doorFaceZ = 0       // cab-local Z of the door plane (deck-facing)

  // --- Passenger loop state machine -----------------------------------------
  // Phases run on a fixed schedule; cab Y + door open + riders read off the phase.
  private phase: 'approach' | 'load' | 'close' | 'ascend' | 'deliver' | 'descend' = 'approach'
  private phaseT = 0          // seconds elapsed in current phase
  private cabY = 0            // current cab floor Y (driven by the machine)
  private doorOpen = 1        // 0 closed .. 1 fully open (eased)
  private riders: Rider[] = []
  private riderCount = 0
  private deliverFade = 1     // riders fade this -> 0 during DELIVER

  // --- Functional API state --------------------------------------------------
  /** Boarding spot in PARENT-LOCAL space at deck level (game transforms via parent matrix). */
  readonly boardLocal: THREE.Vector3
  /** Cab footprint radius at the base; the game tests player XZ distance against this. */
  readonly boardRadius = 3.2

  // Boarding ramp: target 0/1, eased value follows it in update() (no allocation).
  private boarding = false
  private boardRamp = 0
  // Destination locked at the moment setBoarding(true) is called.
  private lockedDest: 'moon' | 'mars' | null = null

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(parent: THREE.Group, opts: { radius: number; mirror?: boolean }) {
    const R = opts.radius
    const low = config.tier.name === 'low'

    // In the OPEN deck behind the assembly hangar (the hangar box is x[-22,22],
    // z[-5,21]; the launch rockets sit at x≈±33). The side gaps beside the hangar
    // were cramped and the tall shaft clipped the glass wall/roof, so we sit it in
    // the clear zone behind the hangar toward the dive ledge — z>21 has no roof, no
    // walls and no rockets — offset left of the central dive lane so it fills the
    // otherwise-empty back-left of the deck and you pass it on the way to the edge.
    // `mirror` puts a twin on the opposite side of the deck (the functional lift is
    // the un-mirrored one; the twin is a matching decorative set piece).
    const side = opts.mirror ? -1 : 1
    this.root.position.set(-R * 0.36 * side, 0, R * 0.58 * side) // ≈ (-18, 0, 29), or mirrored
    // Face the doorway back toward the deck centre (so the doors greet the player).
    this.root.rotation.y = Math.atan2(-this.root.position.x, -this.root.position.z)

    // Boarding spot: at the tower base, in PARENT-LOCAL space.
    this.boardLocal = new THREE.Vector3(this.root.position.x, 0, this.root.position.z)

    const H = 41                 // shaft top (local Y)
    const halfW = this.cabHalfW  // cab / shaft half-footprint
    const shaftHalf = halfW + 0.35

    // Shared palette.
    const chrome = 0xd8e2ec
    const brass = 0xcaa24a
    const amber = 0xffb24a
    const cyan = 0x6fe0ff

    // === BASE LANDING / LOBBY PAD ===========================================
    // A wide lit pad you obviously board from: a chrome slab + glowing floor ring
    // + a doorway threshold strip on the deck-facing side.
    const padMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.9, roughness: 0.3, emissive: 0x0a1a2a, emissiveIntensity: 0.3 }))
    const pad = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(shaftHalf * 2.4, shaftHalf * 2.7, 0.5, low ? 14 : 28)), padMat)
    pad.position.y = 0.25; this.root.add(pad)

    // Glowing cyan floor ring on the pad (the "stand here to board" marker).
    this.baseRingMat = this.own(new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const baseRing = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(shaftHalf * 2.0, 0.12, 8, low ? 20 : 40)), this.baseRingMat)
    baseRing.rotation.x = Math.PI / 2; baseRing.position.y = 0.52; this.root.add(baseRing)

    // Amber doorway threshold strip in front of the cab doors.
    const thresholdMat = this.own(new THREE.MeshBasicMaterial({ color: amber, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const threshold = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(halfW * 2.4, 0.06, 0.5)), thresholdMat)
    threshold.position.set(0, 0.53, shaftHalf + 0.5); this.root.add(threshold)

    // === SHAFT: open framework + glass guide rails ==========================
    // Four corner columns (chrome) running the full height read as a lift shaft.
    const colMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.92, roughness: 0.25, emissive: 0x0c1830, emissiveIntensity: 0.25 }))
    const colGeo = this.ownG(new THREE.CylinderGeometry(0.12, 0.12, H, low ? 6 : 10))
    const colR = shaftHalf
    const colCount = 4
    for (let i = 0; i < colCount; i++) {
      const a = Math.PI / 4 + (i / colCount) * Math.PI * 2
      const col = new THREE.Mesh(colGeo, colMat)
      col.position.set(Math.cos(a) * colR, H / 2, Math.sin(a) * colR)
      this.root.add(col)
    }

    // Glass guide rails (two flat translucent panes on the side walls) — the
    // rails the cab slides along. On low we keep one back pane only.
    const railGlassMat = this.own(new THREE.MeshStandardMaterial({
      color: 0x9fd8ff, metalness: 0.2, roughness: 0.1,
      transparent: true, opacity: 0.12, side: THREE.DoubleSide,
      emissive: 0x2a6ea0, emissiveIntensity: 0.25,
    }))
    const railGeo = this.ownG(new THREE.PlaneGeometry(shaftHalf * 1.9, H))
    // Back pane (away from the deck).
    const railBack = new THREE.Mesh(railGeo, railGlassMat)
    railBack.position.set(0, H / 2, -shaftHalf); this.root.add(railBack)
    if (!low) {
      const railL = new THREE.Mesh(railGeo, railGlassMat)
      railL.position.set(-shaftHalf, H / 2, 0); railL.rotation.y = Math.PI / 2; this.root.add(railL)
      const railR = new THREE.Mesh(railGeo, railGlassMat)
      railR.position.set(shaftHalf, H / 2, 0); railR.rotation.y = Math.PI / 2; this.root.add(railR)
    }

    // Stacked chrome/brass banding rings up the shaft (retro art-deco rungs).
    const bandChromeMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.95, roughness: 0.22, emissive: 0x0a1a2a, emissiveIntensity: 0.2 }))
    const bandBrassMat = this.own(new THREE.MeshStandardMaterial({ color: brass, metalness: 0.95, roughness: 0.3, emissive: 0x3a2a08, emissiveIntensity: 0.45 }))
    const bandGeo = this.ownG(new THREE.TorusGeometry(shaftHalf * 1.18, 0.07, 6, low ? 12 : 22))
    const bands = low ? 4 : 8
    for (let i = 1; i <= bands; i++) {
      const y = (i / (bands + 1)) * H
      const isBrass = i % 2 === 0
      const band = new THREE.Mesh(bandGeo, isBrass ? bandBrassMat : bandChromeMat)
      band.rotation.x = Math.PI / 2; band.position.y = y; this.root.add(band)
    }

    // Top header beam / housing so the shaft has a clear "top of the lift".
    const headerMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.92, roughness: 0.25, emissive: 0x0a1a2a, emissiveIntensity: 0.3 }))
    const header = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(shaftHalf * 2.5, 0.7, shaftHalf * 2.5)), headerMat)
    header.position.y = H + 0.2; this.root.add(header)

    // === CAB: boxy glass-walled elevator car ================================
    this.cab = new THREE.Group()

    // Solid floor + ceiling slabs (chrome).
    const slabMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.92, roughness: 0.28, emissive: 0x0a1a2a, emissiveIntensity: 0.3 }))
    const slabGeo = this.ownG(new THREE.BoxGeometry(halfW * 2, 0.16, halfW * 2))
    const floor = new THREE.Mesh(slabGeo, slabMat)
    floor.position.y = 0; this.cab.add(floor)
    const ceiling = new THREE.Mesh(slabGeo, slabMat)
    ceiling.position.y = this.cabH; this.cab.add(ceiling)

    // Glass walls: back + two sides (the front is the sliding doors).
    const cabGlassMat = this.own(new THREE.MeshStandardMaterial({
      color: 0xbfeaff, metalness: 0.15, roughness: 0.08,
      transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      emissive: 0x2a7ab0, emissiveIntensity: 0.3,
    }))
    const wallGeo = this.ownG(new THREE.PlaneGeometry(halfW * 2, this.cabH))
    const backWall = new THREE.Mesh(wallGeo, cabGlassMat)
    backWall.position.set(0, this.cabH / 2, -halfW); this.cab.add(backWall)
    const sideWallL = new THREE.Mesh(wallGeo, cabGlassMat)
    sideWallL.position.set(-halfW, this.cabH / 2, 0); sideWallL.rotation.y = Math.PI / 2; this.cab.add(sideWallL)
    const sideWallR = new THREE.Mesh(wallGeo, cabGlassMat)
    sideWallR.position.set(halfW, this.cabH / 2, 0); sideWallR.rotation.y = Math.PI / 2; this.cab.add(sideWallR)

    // Neon edge trim around the cab (additive cyan) so it reads bright + boxy.
    this.cabEdgeMat = this.own(new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const edgeBarGeo = this.ownG(new THREE.BoxGeometry(0.07, this.cabH, 0.07))
    // Four vertical corner edges.
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        const e = new THREE.Mesh(edgeBarGeo, this.cabEdgeMat)
        e.position.set(sx * halfW, this.cabH / 2, sz * halfW); this.cab.add(e)
      }
    }
    // Top + bottom amber rims (additive) for a lit-car silhouette.
    const cabRimMat = this.own(new THREE.MeshBasicMaterial({ color: amber, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const cabRimGeo = this.ownG(new THREE.BoxGeometry(halfW * 2.1, 0.06, halfW * 2.1))
    const rimTop = new THREE.Mesh(cabRimGeo, cabRimMat); rimTop.position.y = this.cabH - 0.04; this.cab.add(rimTop)
    const rimBot = new THREE.Mesh(cabRimGeo, cabRimMat); rimBot.position.y = 0.04; this.cab.add(rimBot)

    // Bright glowing interior light: an additive slab near the ceiling.
    this.interiorMat = this.own(new THREE.MeshBasicMaterial({ color: 0xfff0c8, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const lamp = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(halfW * 1.5, 0.1, halfW * 1.5)), this.interiorMat)
    lamp.position.y = this.cabH - 0.25; this.cab.add(lamp)
    if (!low) {
      // A soft interior fill glow (faint big additive box) so the cab reads "lit".
      const fillMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffe6b0, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const fill = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(halfW * 1.7, this.cabH * 0.8, halfW * 1.7)), fillMat)
      fill.position.y = this.cabH / 2; this.cab.add(fill)
    }

    // Sliding doors on the deck-facing (+Z) side: two glass panels.
    this.doorFaceZ = halfW + 0.02
    const doorGlassMat = this.own(new THREE.MeshStandardMaterial({
      color: 0xcfeeff, metalness: 0.2, roughness: 0.08,
      transparent: true, opacity: 0.4, side: THREE.DoubleSide,
      emissive: 0x2f86c0, emissiveIntensity: 0.4,
    }))
    const doorGeo = this.ownG(new THREE.PlaneGeometry(halfW, this.cabH * 0.92))
    this.doorL = new THREE.Mesh(doorGeo, doorGlassMat)
    this.doorL.position.set(-this.doorClosedX, this.cabH / 2, this.doorFaceZ)
    this.cab.add(this.doorL)
    this.doorR = new THREE.Mesh(doorGeo, doorGlassMat)
    this.doorR.position.set(this.doorClosedX, this.cabH / 2, this.doorFaceZ)
    this.cab.add(this.doorR)
    // Bright cyan leading-edge bars on each door so the slide is readable. The
    // bars are children of their door (door-local space) so they slide with it.
    const doorEdgeGeo = this.ownG(new THREE.BoxGeometry(0.05, this.cabH * 0.92, 0.05))
    const dEdgeL = new THREE.Mesh(doorEdgeGeo, this.cabEdgeMat)
    dEdgeL.position.set(halfW / 2, 0, 0.01)   // inner (toward centre) edge of left door
    this.doorL.add(dEdgeL)
    const dEdgeR = new THREE.Mesh(doorEdgeGeo, this.cabEdgeMat)
    dEdgeR.position.set(-halfW / 2, 0, 0.01)  // inner edge of right door
    this.doorR.add(dEdgeR)

    this.root.add(this.cab)

    // Cab travel: floor from just above the lobby to just below the header.
    this.cabLo = 0.6
    this.cabHi = H - this.cabH - 0.8
    this.cabY = this.cabLo
    this.cab.position.y = this.cabY

    // === MARQUEE: big retro-CRT destination sign above the doors =============
    const signMoonTex = this.signTexture('MOON', 0xb8ecff)
    const signMarsTex = this.signTexture('MARS', 0xff9a6a)
    this.texs.push(signMoonTex, signMarsTex)
    const signGeo = this.ownG(new THREE.PlaneGeometry(halfW * 3.4, halfW * 1.9))
    this.signMoonMat = this.own(new THREE.MeshBasicMaterial({ map: signMoonTex, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }))
    this.signMarsMat = this.own(new THREE.MeshBasicMaterial({ map: signMarsTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }))
    const signY = H - 2.4
    const signZ = shaftHalf + 0.5
    const moonPanel = new THREE.Mesh(signGeo, this.signMoonMat); moonPanel.position.set(0, signY, signZ); this.root.add(moonPanel)
    const marsPanel = new THREE.Mesh(signGeo, this.signMarsMat); marsPanel.position.set(0, signY, signZ + 0.02); this.root.add(marsPanel)
    if (!low) {
      // Chrome bezel frame around the marquee.
      const frameMat = this.own(new THREE.MeshStandardMaterial({ color: chrome, metalness: 0.95, roughness: 0.25, emissive: 0x0a1a2a, emissiveIntensity: 0.25 }))
      const frameGeo = this.ownG(new THREE.BoxGeometry(halfW * 3.7, 0.12, 0.12))
      for (let s = -1; s <= 1; s += 2) {
        const bar = new THREE.Mesh(frameGeo, frameMat)
        bar.position.set(0, signY + s * halfW * 0.95, signZ - 0.04); this.root.add(bar)
      }
    }

    // === RIDERS: little blocky robots (shared geometry across riders) ========
    this.riderCount = config.tier.name === 'high' ? 3 : config.tier.name === 'medium' ? 2 : 2
    // Shared rider geometries (built once, reused for every rider's parts).
    const bodyGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.6, 0.35))
    const headGeo = this.ownG(new THREE.BoxGeometry(0.34, 0.3, 0.32))
    const visorGeo = this.ownG(new THREE.PlaneGeometry(0.26, 0.1))
    const legGeo = this.ownG(new THREE.BoxGeometry(0.12, 0.3, 0.12))
    const robotBodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0xb7c2cc, metalness: 0.7, roughness: 0.4, emissive: 0x0a1620, emissiveIntensity: 0.3 }))
    const robotHeadMat = this.own(new THREE.MeshStandardMaterial({ color: 0xd8e2ec, metalness: 0.8, roughness: 0.35, emissive: 0x0a1620, emissiveIntensity: 0.3 }))

    // Park slots inside the cab footprint (cab-local XZ), evenly spread.
    const span = halfW - 0.4
    const slot = (i: number, n: number): { x: number; z: number } => {
      if (n === 1) return { x: 0, z: -0.15 }
      if (n === 2) return { x: i === 0 ? -span * 0.5 : span * 0.5, z: -0.1 }
      const a = (i / n) * Math.PI * 2
      return { x: Math.cos(a) * span * 0.55, z: Math.sin(a) * span * 0.45 }
    }

    for (let i = 0; i < this.riderCount; i++) {
      const g = new THREE.Group()
      const body = new THREE.Mesh(bodyGeo, robotBodyMat); body.position.y = 0.6; g.add(body)
      const head = new THREE.Mesh(headGeo, robotHeadMat); head.position.y = 1.02; g.add(head)
      // Per-rider visor material so each can fade independently.
      const visorMat = this.own(new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const visor = new THREE.Mesh(visorGeo, visorMat); visor.position.set(0, 1.04, 0.165); g.add(visor)
      const legL = new THREE.Mesh(legGeo, robotBodyMat); legL.position.set(-0.13, 0.15, 0); g.add(legL)
      const legR = new THREE.Mesh(legGeo, robotBodyMat); legR.position.set(0.13, 0.15, 0); g.add(legR)
      g.visible = false
      // Start under root (deck space) for the walk-in; update() reparents to the
      // cab once a rider is 'inside' so it rides up with the car.
      this.root.add(g)

      const s = slot(i, this.riderCount)
      // Spawn a few metres out on the deck, fanned in front of the doors (+Z).
      const spreadX = (i - (this.riderCount - 1) / 2) * 0.9
      this.riders.push({
        group: g,
        visorMat,
        state: 'idle',
        spawnX: spreadX,
        spawnZ: shaftHalf + 3.0,
        slotX: s.x,
        slotZ: s.z,
        walkT: 0,
        bobPhase: i * 1.7,
        opacity: 1,
      })
    }

    // Kick the machine off: cab at base, doors open, fresh group approaching.
    this.startApproach()

    parent.add(this.root)
  }

  /** Reset riders to a fresh group at the deck and begin the APPROACH phase. */
  private startApproach() {
    this.phase = 'approach'
    this.phaseT = 0
    this.deliverFade = 1
    this.cabY = this.cabLo
    for (const r of this.riders) {
      r.state = 'walk'
      r.walkT = 0
      r.opacity = 1
      r.group.visible = true
    }
  }

  /** Big retro-CRT marquee panel drawn once to a canvas: "ELEVATOR" title + a
   *  large "▲ <dest>" destination line tinted to the destination's colour, with
   *  rounded corners, scanlines, a chrome bezel and an atomic-orbit motif. */
  private signTexture(dest: string, accent: number): THREE.CanvasTexture {
    const W = 512, Hc = 288
    const cv = document.createElement('canvas'); cv.width = W; cv.height = Hc
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, W, Hc)

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
    ctx.fillStyle = 'rgba(8,18,32,0.62)'; ctx.fill()
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(216,226,236,0.9)'; ctx.stroke()
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,178,74,0.6)'; ctx.stroke()

    ctx.save()
    rr(14, 14, W - 28, Hc - 28, r - 4); ctx.clip()

    // Scanlines.
    ctx.fillStyle = 'rgba(39,231,255,0.06)'
    for (let y = 0; y < Hc; y += 6) ctx.fillRect(0, y, W, 2)

    const hex = '#' + new THREE.Color(accent).getHexString()

    // Atomic-orbit motif behind the title.
    ctx.save()
    ctx.translate(W / 2, 74)
    ctx.lineWidth = 2
    for (let i = 0; i < 3; i++) {
      ctx.rotate((Math.PI / 3))
      ctx.strokeStyle = i === 1 ? 'rgba(255,90,200,0.30)' : 'rgba(39,231,255,0.22)'
      ctx.beginPath(); ctx.ellipse(0, 0, 150, 44, 0, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.restore()

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    // Title.
    ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 22; ctx.fillStyle = '#cdfaff'
    ctx.font = '900 56px ui-monospace, Menlo, monospace'; ctx.fillText('ELEVATOR', 256, 74)
    // Amber rule.
    ctx.shadowColor = '#ffb24a'; ctx.shadowBlur = 10; ctx.strokeStyle = '#ffb24a'; ctx.lineWidth = 3
    ctx.beginPath(); ctx.moveTo(90, 128); ctx.lineTo(422, 128); ctx.stroke()
    // Big destination line.
    ctx.shadowColor = hex; ctx.shadowBlur = 28; ctx.fillStyle = hex
    ctx.font = '800 92px ui-monospace, Menlo, monospace'; ctx.fillText('▲ ' + dest, 256, 212)

    ctx.restore()
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  // --- Functional API --------------------------------------------------------

  /** Which destination the sign is CURRENTLY showing. When boarding is locked,
   *  returns the locked dest; otherwise the dominant panel from the cycle. */
  currentDest(): 'moon' | 'mars' {
    if (this.lockedDest) return this.lockedDest
    return this.moonShowing(this.t) ? 'moon' : 'mars'
  }

  /** When true: bring the cab to the base with doors OPEN so the player can step
   *  into a receiving car, and lock the sign to the current destination. When
   *  false: resume the ambient passenger loop. Visual only — no physics/gameplay. */
  setBoarding(on: boolean): void {
    if (on === this.boarding) return
    this.boarding = on
    if (on) {
      this.lockedDest = this.moonShowing(this.t) ? 'moon' : 'mars'
    } else {
      this.lockedDest = null
      // Resume the ambient loop cleanly with a fresh group walking in.
      this.startApproach()
    }
  }

  /** Is the MOON panel the dominant one at time `t`? Mirrors the update() cycle. */
  private moonShowing(t: number): boolean {
    const dwell = 3.0, blend = 0.8
    const cyc = dwell * 2 + blend * 2
    const cp = ((t % cyc) + cyc) % cyc
    return cp < dwell + blend / 2 || cp >= dwell * 2 + blend * 1.5
  }

  update(dt: number) {
    this.t += dt
    const calm = config.reducedMotion
    const slow = calm ? 0.7 : 1.0   // gently slow motion under reducedMotion

    // --- Boarding ramp: ease boardRamp toward boarding (0/1). FR-independent. ---
    const target = this.boarding ? 1 : 0
    const rampRate = 2.4
    if (this.boardRamp !== target) {
      const k = 1 - Math.exp(-rampRate * dt)
      this.boardRamp += (target - this.boardRamp) * k
      if (Math.abs(this.boardRamp - target) < 0.001) this.boardRamp = target
    }
    const b = this.boardRamp

    // === Passenger loop state machine =======================================
    // Durations (s). When boarding, we override to: cab at base + doors open.
    const D_APPROACH = 3.0
    const D_LOAD = 1.0
    const D_CLOSE = 1.0
    const D_ASCEND = 4.0
    const D_DELIVER = 1.6
    const D_DESCEND = 3.4

    if (b < 0.5) {
      // ---- Ambient loop runs (player not boarding) ----
      this.phaseT += dt * slow
      switch (this.phase) {
        case 'approach': {
          // Cab at base, doors open; walk riders toward the doorway.
          this.cabY = this.cabLo
          this.doorOpen = 1
          for (const r of this.riders) {
            if (r.state === 'walk') {
              r.walkT = Math.min(1, r.walkT + dt * slow / (D_APPROACH * 0.85))
            }
          }
          if (this.phaseT >= D_APPROACH) { this.phase = 'load'; this.phaseT = 0; for (const r of this.riders) r.state = 'inside' }
          break
        }
        case 'load': {
          this.cabY = this.cabLo; this.doorOpen = 1
          if (this.phaseT >= D_LOAD) { this.phase = 'close'; this.phaseT = 0 }
          break
        }
        case 'close': {
          this.cabY = this.cabLo
          this.doorOpen = 1 - this.phaseT / D_CLOSE
          if (this.phaseT >= D_CLOSE) { this.phase = 'ascend'; this.phaseT = 0; this.doorOpen = 0 }
          break
        }
        case 'ascend': {
          this.doorOpen = 0
          const f = Math.min(1, this.phaseT / D_ASCEND)
          const e = f * f * (3 - 2 * f)
          this.cabY = this.cabLo + (this.cabHi - this.cabLo) * e
          if (this.phaseT >= D_ASCEND) { this.phase = 'deliver'; this.phaseT = 0; this.cabY = this.cabHi }
          break
        }
        case 'deliver': {
          this.cabY = this.cabHi; this.doorOpen = 0
          // After a brief hold, fade riders out (delivered to orbit).
          const holdEnd = D_DELIVER * 0.4
          if (this.phaseT > holdEnd) {
            this.deliverFade = Math.max(0, 1 - (this.phaseT - holdEnd) / (D_DELIVER - holdEnd))
          }
          if (this.phaseT >= D_DELIVER) {
            this.deliverFade = 0
            for (const r of this.riders) { r.state = 'idle'; r.group.visible = false }
            this.phase = 'descend'; this.phaseT = 0
          }
          break
        }
        case 'descend': {
          this.doorOpen = 0
          const f = Math.min(1, this.phaseT / D_DESCEND)
          const e = f * f * (3 - 2 * f)
          this.cabY = this.cabHi + (this.cabLo - this.cabHi) * e
          if (this.phaseT >= D_DESCEND) { this.cabY = this.cabLo; this.startApproach() }
          break
        }
      }
    } else {
      // ---- Boarding: pull cab to base + force doors open for the player ----
      this.cabY += (this.cabLo - this.cabY) * (1 - Math.exp(-4.0 * dt))
      this.doorOpen += (1 - this.doorOpen) * (1 - Math.exp(-4.0 * dt))
      // Pause the ambient riders out of the way (hidden) while the player boards.
      if (this.phase !== 'descend') {
        for (const r of this.riders) { if (r.state !== 'idle') { r.state = 'idle'; r.group.visible = false } }
      }
    }

    // Apply cab Y.
    this.cab.position.y = this.cabY

    // --- Doors: slide L/R apart by doorOpen (0 closed -> 1 open). ---
    const dx = this.doorClosedX + (this.doorOpenX - this.doorClosedX) * this.doorOpen
    this.doorL.position.x = -dx
    this.doorR.position.x = dx

    // --- Riders: walk in (root-space) or ride inside the cab (cab-space). ---
    for (let i = 0; i < this.riders.length; i++) {
      const r = this.riders[i]
      if (!r.group.visible) continue
      if (r.state === 'walk') {
        // Lerp from spawn point on the deck to the doorway, in root-local space.
        if (r.group.parent !== this.root) this.root.add(r.group)
        const w = r.walkT * r.walkT * (3 - 2 * r.walkT)
        const targetZ = this.doorFaceZ + 0.4 // just inside the doorway
        const x = r.spawnX + (r.slotX - r.spawnX) * w
        const z = r.spawnZ + (targetZ - r.spawnZ) * w
        // Step bob: small vertical hop while walking, stops at the door.
        const bob = (1 - w) * 0.06 * Math.abs(Math.sin(this.t * 7 * slow + r.bobPhase))
        r.group.position.set(x, this.cabLo + bob, z)
        // Face the direction of travel (toward the cab doorway).
        r.group.rotation.y = Math.atan2(r.slotX - r.spawnX, targetZ - r.spawnZ)
        if (r.walkT >= 1) r.state = 'inside'
      } else if (r.state === 'inside') {
        // Ride with the cab: parent under cab, park at the slot offset.
        if (r.group.parent !== this.cab) this.cab.add(r.group)
        r.group.position.set(r.slotX, 0, r.slotZ)
        r.group.rotation.y = Math.PI // face out the doors
        // Apply deliver fade to the visor (and dim via scale-free opacity only).
        r.opacity = this.deliverFade
        r.visorMat.opacity = 0.9 * r.opacity
        // Hide the whole rider once fully faded (deliver end handles visible=false).
        r.group.visible = r.opacity > 0.01
      }
    }

    // --- Cab interior + edge glow. reducedMotion: steady, never a strobe. ---
    const pulse = calm ? 0.0 : 0.12 * (0.5 + 0.5 * Math.sin(this.t * 2.2))
    this.interiorMat.opacity = (0.78 + pulse) + 0.15 * b
    this.cabEdgeMat.opacity = (0.78 + pulse * 0.5) + 0.2 * b
    // Base lobby ring breathes gently, brightens when boarding.
    this.baseRingMat.opacity = (calm ? 0.7 : 0.7 + 0.12 * Math.sin(this.t * 1.6)) + 0.25 * b

    // --- Destination sign cycle: cross-fade MOON <-> MARS, unless locked. ---
    if (this.lockedDest) {
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
    this.riders.length = 0
  }
}
