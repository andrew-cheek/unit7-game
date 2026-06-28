import * as THREE from 'three'
import { config } from './config'

/**
 * The opening you stand on, not fall into: a big floating robot FACTORY high above
 * the city. An assembly line runs LEFT-TO-RIGHT right in front of where you spawn:
 * raw chassis drop in at the glowing forge, ride the belt while worker arms weld on
 * legs, torso, arms and head, then finished units step off the end, walk across the
 * deck and dive off the ledge under a neon DROP ZONE sign. Follow them off the edge.
 *
 * The deck collider, the visual floor and the step-off test all share ONE radius,
 * so there's no invisible lip to "walk on the sky" past the visible edge.
 *
 * Local space: +Z is the ledge / dive direction (you face it at spawn). The belt
 * runs along X at z = beltZ, a short distance in front of the spawn, so the whole
 * build-and-march-off sequence plays out across your view up close.
 */
export class LaunchPad {
  readonly group = new THREE.Group()
  readonly topY: number
  readonly radius = 50
  readonly collider: THREE.Mesh
  readonly spawn = new THREE.Vector3()
  readonly spawnYaw: number

  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private t = 0
  private yaw: number
  private center: THREE.Vector3

  private units: {
    g: THREE.Group; parts: THREE.Object3D[]; legL: THREE.Object3D; legR: THREE.Object3D
    wheel: THREE.Object3D | null; kind: 'biped' | 'roller'
    bodyMat: THREE.MeshStandardMaterial; headMat: THREE.MeshStandardMaterial
    x: number; z: number; tx: number; tz: number; state: 'build' | 'wander' | 'edge' | 'fall'
    v: number; ph: number; fallT: number; wait: number; lane: number
  }[] = []
  private arms: { pivot: THREE.Group; elbow: THREE.Group; spark: THREE.Mesh; sparkMat: THREE.MeshBasicMaterial; ph: number }[] = []
  private cores: THREE.Mesh[] = []
  private beltSeams: THREE.Mesh[] = []
  // Sci-fi props that animate.
  private drones: { g: THREE.Group; a: number; r: number; h: number; sp: number; rotors: THREE.Object3D[] }[] = []
  private holos: { o: THREE.Object3D; sp: number }[] = []
  private pylons: THREE.MeshBasicMaterial[] = []
  private cargo: { o: THREE.Object3D; ph: number; baseY: number }[] = []
  private rockets: { g: THREE.Group; flame: THREE.Mesh; flameMat: THREE.MeshBasicMaterial; glowMat: THREE.MeshBasicMaterial; smokeMat: THREE.SpriteMaterial; bx: number; bz: number; t: number; vy: number; y: number; ph: number }[] = []
  private arrowMat!: THREE.MeshBasicMaterial
  private arrowChevs: THREE.Mesh[] = []
  private edgeGlow!: THREE.MeshBasicMaterial
  // Epic upgrade: a tall glass skyline behind the deck + an overhead assembly
  // gantry, holographic blueprint and a heavier forge that animate.
  private beacons: { mat: THREE.MeshBasicMaterial; ph: number }[] = []
  private gTrolley?: THREE.Group
  private gWeldMat?: THREE.MeshBasicMaterial
  private gWeld?: THREE.Mesh
  private scanMat?: THREE.MeshBasicMaterial
  private scan?: THREE.Mesh
  private forgePistons: { o: THREE.Object3D; ph: number; base: number }[] = []
  private lifts: { o: THREE.Object3D; lo: number; hi: number; ph: number }[] = []
  private towerArms: { pivot: THREE.Group; elbow: THREE.Group; spark: THREE.Mesh; sparkMat: THREE.MeshBasicMaterial; ph: number }[] = []
  private towerStripMats: THREE.MeshBasicMaterial[] = []

  // Belt runs along X (forge at beltX0, output at beltX1), sitting at z = beltZ
  // just in front of the spawn so the line crosses your view head-on.
  private readonly beltX0 = -17
  private readonly beltX1 = 17
  private readonly beltZ = 8
  private get lenX() { return this.beltX1 - this.beltX0 }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, center: THREE.Vector3, faceYaw: number) {
    this.center = center.clone()
    this.topY = center.y
    this.yaw = faceYaw
    this.group.position.copy(this.center)
    this.group.rotation.y = faceYaw

    this.buildTowers()
    this.buildFactoryTower()
    this.buildDeck()
    this.buildConveyor()
    this.buildForgeMachine()
    this.buildAssemblyHangar()
    this.buildArms()
    this.buildSign()
    this.buildProps()
    this.buildSciFi()
    this.buildRockets()
    this.buildClouds()
    this.buildUnits()

    // Circular collider with enough segments to read as a true circle, matching the
    // visual floor radius exactly - so you fall off right at the visible edge.
    this.collider = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(this.radius, this.radius, 1, 48)),
      this.own(new THREE.MeshBasicMaterial({ visible: false })),
    )
    this.collider.position.set(this.center.x, this.topY - 0.5, this.center.z)
    scene.add(this.collider)
    this.collider.updateMatrixWorld(true)

    // Spawn a short way back from the belt, dead-centre, facing the line and the
    // ledge beyond it - so the assembly line fills your view the instant you land.
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw))
    this.spawn.copy(this.center).addScaledVector(fwd, -4)
    this.spawn.y = this.topY + 0.1
    this.spawnYaw = this.yaw

    scene.add(this.group)
    this.group.updateMatrixWorld(true)
  }

  /** Procedural glass-tower facade: a grid of lit/unlit windows for the skyline. */
  private windowTex(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 512
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#060a14'; ctx.fillRect(0, 0, 128, 512)
    const cols = 7, rows = 30
    const mw = 128 / cols, mh = 512 / rows
    const lit = ['#cfeeff', '#8fd8ff', '#ffe0ad', '#a8ecff', '#6fc4ff', '#dfe9ff']
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const on = Math.random() < 0.74
      ctx.fillStyle = on ? lit[(Math.random() * lit.length) | 0] : '#0a1322'
      ctx.fillRect(c * mw + 1.5, r * mh + 1.5, mw - 3, mh - 3)
      if (on && Math.random() < 0.45) { ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(c * mw + 1.5, r * mh + mh * 0.5, mw - 3, mh * 0.5 - 1.5) }
    }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  /** A skyline of tall, sleek glass towers rising behind and beside the deck, so
   *  the factory reads as the crown of a colossal future-city megastructure. Pure
   *  backdrop (beyond the deck rim, so never an obstacle) with lit-window facades,
   *  accent light strips, antenna spires and blinking rooftop beacons. */
  private buildTowers() {
    const low = config.tier.name === 'low'
    const winTex = this.windowTex(); this.texs.push(winTex)
    const winMat = this.own(new THREE.MeshStandardMaterial({ map: winTex, emissiveMap: winTex, emissive: 0xffffff, emissiveIntensity: 0.6, metalness: 0.35, roughness: 0.5 }))
    const capMat = this.own(new THREE.MeshStandardMaterial({ color: 0x0c1424, metalness: 0.7, roughness: 0.4, emissive: 0x0a2236, emissiveIntensity: 0.5 }))
    const stripMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const spireMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1a2336, metalness: 0.7, roughness: 0.4 }))
    // [x, z, footprint, height] - kept to the back hemisphere so the dive view stays open.
    const specs: [number, number, number, number][] = [
      // Frame the front-left factory: one behind it, one across to the right.
      [-94, 60, 17, 124], [56, 70, 18, 142],
      // ...with a deeper skyline spread around the rest of the sky.
      [-40, -94, 22, 132], [40, -100, 18, 168], [-62, -52, 17, 104],
      [60, -58, 19, 120], [-82, -10, 14, 82], [80, -16, 15, 90],
    ]
    const list = low ? specs.slice(0, 4) : specs
    const baseY = -54
    for (const [x, z, fp, h] of list) {
      const g = new THREE.Group(); g.position.set(x, baseY, z)
      // Stacked setback tiers for a modern stepped profile.
      const tiers = 3
      let cy = 0, w = fp, rem = h
      for (let t = 0; t < tiers; t++) {
        const th = (rem / (tiers - t)) * (t === tiers - 1 ? 1 : 0.82)
        rem -= th
        const shaft = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(w, th, w)), winMat)
        shaft.position.y = cy + th / 2; g.add(shaft)
        // Vertical accent light strips on the corners.
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
          const strip = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, th * 0.96, 0.5)), stripMat)
          strip.position.set(sx * w / 2, cy + th / 2, sz * w / 2); g.add(strip)
        }
        cy += th; w *= 0.74
      }
      // Roof cap, antenna spire + a blinking beacon.
      const cap = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(w * 1.25, 2.4, w * 1.25)), capMat); cap.position.y = cy + 1.2; g.add(cap)
      const spire = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.18, 0.5, 14, 7)), spireMat); spire.position.y = cy + 9; g.add(spire)
      const beaconMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff4a6a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const beacon = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.7, 10, 8)), beaconMat); beacon.position.y = cy + 16; g.add(beacon)
      this.beacons.push({ mat: beaconMat, ph: Math.random() * 6.28 })
      this.group.add(g)
    }
  }

  /** A partially-assembled humanoid hung in an assembly bay - the robot being
   *  built, posed mid-construction. Body-colored metal with glowing joints. */
  private makeSuspendedBot(col: number): THREE.Group {
    const g = new THREE.Group()
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0xaeb8cc, metalness: 0.6, roughness: 0.4, emissive: col, emissiveIntensity: 0.35 }))
    const jointMat = this.own(new THREE.MeshBasicMaterial({ color: col, fog: false }))
    const darkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x10151f, metalness: 0.7, roughness: 0.4 }))
    const torso = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1.5, 2.1, 1)), bodyMat); torso.position.y = 0; g.add(torso)
    const chest = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.3, 0.3, 0.18, 12)), jointMat); chest.rotation.x = Math.PI / 2; chest.position.set(0, 0.4, 0.52); g.add(chest)
    const head = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.9, 0.9, 0.9)), bodyMat); head.position.y = 1.75; g.add(head)
    const visor = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.7, 0.18, 0.1)), jointMat); visor.position.set(0, 1.78, 0.46); g.add(visor)
    // Arms out (being worked on).
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 1.7, 0.4)), bodyMat); arm.position.set(sx * 1.15, 0.1, 0); arm.rotation.z = sx * 0.5; g.add(arm)
      const shoulder = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.32, 8, 6)), jointMat); shoulder.position.set(sx * 0.95, 0.85, 0); g.add(shoulder)
    }
    for (const sx of [-0.45, 0.45]) { const leg = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, 1.9, 0.5)), bodyMat); leg.position.set(sx, -2, 0); g.add(leg) }
    const hip = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1.3, 0.5, 0.9)), darkMat); hip.position.y = -1.1; g.add(hip)
    return g
  }

  /** A robotic assembly arm mounted in a bay, welding the suspended unit. Pushed
   *  to towerArms so it animates. Returns its root group (already positioned). */
  private makeBayArm(x: number, y: number, z: number, faceSign: number): THREE.Group {
    const segMat = this.own(new THREE.MeshStandardMaterial({ color: 0xdfe6f2, metalness: 0.6, roughness: 0.35 }))
    const jMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.7, roughness: 0.4, emissive: 0x123a52, emissiveIntensity: 0.4 }))
    const root = new THREE.Group(); root.position.set(x, y, z)
    const base = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.45, 0.6, 0.7, 10)), jMat); base.position.y = 0.35; root.add(base)
    const pivot = new THREE.Group(); pivot.position.y = 0.7; root.add(pivot)
    const upper = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.3, 0.3, 2.2)), segMat); upper.position.z = faceSign * 1; pivot.add(upper)
    const elbow = new THREE.Group(); elbow.position.z = faceSign * 2; pivot.add(elbow)
    const fore = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.24, 0.24, 1.8)), segMat); fore.position.set(0, -0.2, faceSign * 0.8); elbow.add(fore)
    const sparkMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const spark = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.18, 8, 6)), sparkMat); spark.position.set(0, -0.35, faceSign * 1.6); elbow.add(spark)
    this.towerArms.push({ pivot, elbow, spark, sparkMat, ph: Math.random() * 6.28 })
    return root
  }

  /** THE factory: a tall, multi-storey glass robotics tower rising behind the deck.
   *  You can see right into each lit bay where assembly arms weld suspended humanoid
   *  units; glass lift tubes with travelling cores run the corners, a giant
   *  "UNIT 7 ROBOTICS" sign crowns it, and neon bands ring every floor. */
  private buildFactoryTower() {
    const low = config.tier.name === 'low'
    const W = 32, D = 18, FH = 12
    const floors = low ? 2 : 4
    // Off to the FRONT-LEFT and beyond the rim, angled to face the deck - so the
    // centred player robot doesn't block it and you can take in the whole glass
    // plant beside you. Far enough out that it never overlaps the deck.
    const cx = -52, cz = 54
    const g = new THREE.Group(); g.position.set(cx, 0, cz); g.rotation.y = Math.atan2(-cx, -cz) // face the deck centre

    const frameMat = this.own(new THREE.MeshStandardMaterial({ color: 0xe6ebf4, metalness: 0.5, roughness: 0.4 }))
    const darkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x141d30, metalness: 0.75, roughness: 0.35, emissive: 0x0a2236, emissiveIntensity: 0.4 }))
    const glassMat = this.own(new THREE.MeshStandardMaterial({ color: 0x8fd6ff, metalness: 0.2, roughness: 0.1, transparent: true, opacity: 0.15, side: THREE.DoubleSide, emissive: 0x2a6ea0, emissiveIntensity: 0.25 }))
    const floorMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1a2740, metalness: 0.6, roughness: 0.4, emissive: 0x0c2236, emissiveIntensity: 0.4 }))
    const crateMat = this.own(new THREE.MeshStandardMaterial({ color: 0x24314c, metalness: 0.6, roughness: 0.45, emissive: 0x16324f, emissiveIntensity: 0.5 }))
    const tints = [0x27e7ff, 0xff2bd0, 0x9dff5a, 0xffd24a]

    // Podium + structural base rising from far below the deck.
    const podium = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(W + 6, 4, D + 6)), darkMat); podium.position.set(0, -56, 0); g.add(podium)
    const shaft = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(W + 2, 52, D + 2)), darkMat); shaft.position.set(0, -28, 0); g.add(shaft)

    // Corner pillars running the full visible height.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const pil = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1.4, floors * FH + 4, 1.4)), frameMat)
      pil.position.set(sx * (W / 2), floors * FH / 2, sz * (D / 2)); g.add(pil)
    }

    // Assembly floors.
    for (let f = 0; f < floors; f++) {
      const y0 = f * FH
      const tint = tints[f % tints.length]
      const slab = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(W, 0.7, D)), floorMat); slab.position.y = y0 + 0.35; g.add(slab)
      const glass = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(W - 0.6, FH - 1, D - 0.6)), glassMat); glass.position.y = y0 + FH / 2; g.add(glass)
      // Neon band ringing the floor.
      const bandMat = this.own(new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      this.towerStripMats.push(bandMat)
      for (const ey of [y0 + 0.9, y0 + FH - 0.6]) {
        for (const [w, , ox, oz, rot] of [[W, 0.001, 0, D / 2, 0], [W, 0.001, 0, -D / 2, 0], [D, 0.001, W / 2, 0, Math.PI / 2], [D, 0.001, -W / 2, 0, Math.PI / 2]] as [number, number, number, number, number][]) {
          const bar = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(w, 0.22, 0.22)), bandMat); bar.position.set(ox, ey, oz); bar.rotation.y = rot; g.add(bar)
        }
      }
      // Ceiling light strips.
      for (const sx of [-W * 0.3, 0, W * 0.3]) {
        const strip = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 0.1, D - 3)), this.own(new THREE.MeshBasicMaterial({ color: 0xdff2ff, transparent: true, opacity: 0.8, fog: false })))
        strip.position.set(sx, y0 + FH - 1.2, 0); g.add(strip)
      }
      // Wall holo screens.
      for (const sx of [-W * 0.34, W * 0.34]) {
        const scr = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(4.5, 2.8)), this.own(new THREE.MeshBasicMaterial({ map: this.screenTexture(), toneMapped: false, transparent: true })))
        scr.position.set(sx, y0 + FH * 0.6, -D / 2 + 0.4); g.add(scr)
        this.texs.push((scr.material as THREE.MeshBasicMaterial).map!)
      }
      // Floor conveyor with part crates riding it.
      const beltMat = this.own(new THREE.MeshStandardMaterial({ color: 0x10182a, metalness: 0.6, roughness: 0.5, emissive: tint, emissiveIntensity: 0.25 }))
      const belt = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(W - 4, 0.4, 2)), beltMat); belt.position.set(0, y0 + 1, D * 0.24); g.add(belt)
      for (let c = 0; c < 4; c++) { const crate = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1.2, 1.2, 1.2)), crateMat); crate.position.set(-W / 2 + 4 + c * (W - 8) / 3, y0 + 1.85, D * 0.24); g.add(crate) }
      // Parts bins stacked in a corner.
      for (let s = 0; s < 3; s++) { const bin = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(2, 1, 1.6)), crateMat); bin.position.set(-W / 2 + 2.4, y0 + 1 + s * 1.05, -D / 2 + 2); g.add(bin) }
      // A rotating holographic blueprint of the unit.
      const bpMat = this.own(new THREE.MeshBasicMaterial({ color: tint, wireframe: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const bp = new THREE.Group()
      bp.add(new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.9, 1.2, 0.6)), bpMat))
      const bpHead = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.6, 0.6, 0.6)), bpMat); bpHead.position.y = 1; bp.add(bpHead)
      bp.scale.setScalar(1.4); bp.position.set(W * 0.36, y0 + FH * 0.45, -D * 0.18); g.add(bp); this.holos.push({ o: bp, sp: 0.6 })

      // Robots being built: suspended units + welding arms across the bays.
      const bays = low ? 1 : 3
      for (let bidx = 0; bidx < bays; bidx++) {
        const bx = bays === 1 ? 0 : (bidx - 1) * W * 0.26
        const bot = this.makeSuspendedBot(tint); bot.scale.setScalar(1.1); bot.position.set(bx, y0 + FH * 0.52, -0.6); g.add(bot)
        const cable = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.06, 0.06, FH * 0.3, 5)), frameMat); cable.position.set(bx, y0 + FH * 0.84, -0.6); g.add(cable)
        g.add(this.makeBayArm(bx - 2.6, y0 + 0.7, 2.4, -1))
        if (!low) g.add(this.makeBayArm(bx + 2.6, y0 + 0.7, -2.4, 1))
      }
    }

    // Side glass lift tubes with a travelling glowing core.
    for (const sx of [-1, 1]) {
      const tubeX = sx * (W / 2 + 2)
      const tube = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(2, 2, floors * FH + 2, 16, 1, true)), this.own(new THREE.MeshStandardMaterial({ color: 0x9fdcff, metalness: 0.2, roughness: 0.1, transparent: true, opacity: 0.18, side: THREE.DoubleSide, emissive: 0x2a6ea0, emissiveIntensity: 0.3 })))
      tube.position.set(tubeX, floors * FH / 2, 0); g.add(tube)
      const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0x6fe0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const core = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.5, 1.5, 2.4, 14)), coreMat); core.position.set(tubeX, 0, 0); g.add(core)
      this.lifts.push({ o: core, lo: 1, hi: floors * FH - 1, ph: sx > 0 ? 0 : Math.PI })
    }

    // Flanking buttress pillars give the HQ its strong silhouette, clad with
    // vertical neon trim (cyan + magenta).
    const trimCyan = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const trimMag = this.own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.towerStripMats.push(trimCyan, trimMag)
    const pillarH = floors * FH + 10
    for (const sx of [-1, 1]) {
      const px = sx * (W / 2 + 3.5)
      const pillar = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(5, pillarH, D + 2)), frameMat); pillar.position.set(px, pillarH / 2 - 2, 0); g.add(pillar)
      const cap = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(5.6, 2.2, D + 2.6)), darkMat); cap.position.set(px, pillarH - 2.5, 0); g.add(cap)
      const inner = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, pillarH - 5, 0.4)), trimCyan); inner.position.set(px - sx * 2.5, pillarH / 2 - 2, D / 2 * 0.85); g.add(inner)
      const outer = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, pillarH - 5, 0.4)), trimMag); outer.position.set(px + sx * 2.5, pillarH / 2 - 2, D / 2 * 0.85); g.add(outer)
    }

    // Iconic entrance archway at the base, facing the deck, with a lit ramp.
    const archZ = D / 2 + 0.3
    for (const sx of [-1, 1]) { const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(1.3, 8.5, 1.4)), frameMat); post.position.set(sx * 3.2, 4.25, archZ); g.add(post) }
    const lintel = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(8.7, 1.6, 1.4)), frameMat); lintel.position.set(0, 8.3, archZ); g.add(lintel)
    const doorway = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(5.4, 7.4)), this.own(new THREE.MeshBasicMaterial({ color: 0x0c2236, transparent: true, opacity: 0.55, fog: false }))); doorway.position.set(0, 4.1, archZ + 0.2); g.add(doorway)
    const doorTrim = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(6, 0.2, 0.2)), trimCyan); doorTrim.position.set(0, 7.5, archZ + 0.3); g.add(doorTrim)
    const ramp = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(6, 7)), this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))); ramp.rotation.x = -Math.PI / 2; ramp.position.set(0, 0.12, archZ + 4); g.add(ramp)

    // Crown: sign housing + a big lit "HUMANOID ROBOTS" panel facing the deck.
    const topY = floors * FH
    const housing = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(W * 0.78, 7, D * 0.7)), darkMat); housing.position.set(0, topY + 3.5, 0); g.add(housing)
    const signTex = this.factorySignTex(); this.texs.push(signTex)
    const sign = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(W * 0.72, 5.5)), this.own(new THREE.MeshBasicMaterial({ map: signTex, transparent: true, toneMapped: false, side: THREE.DoubleSide })))
    sign.position.set(0, topY + 3.6, D * 0.35 + 0.1); g.add(sign)
    const signFrameMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, fog: false }))
    for (const ey of [topY + 6.4, topY + 0.9]) { const bar = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(W * 0.74, 0.3, 0.3)), signFrameMat); bar.position.set(0, ey, D * 0.35 + 0.1); g.add(bar) }
    // Roof antenna + beacon.
    const ant = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.16, 0.4, 12, 7)), frameMat); ant.position.set(0, topY + 13, 0); g.add(ant)
    const beaconMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff4a6a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const beacon = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.8, 10, 8)), beaconMat); beacon.position.set(0, topY + 19, 0); g.add(beacon)
    this.beacons.push({ mat: beaconMat, ph: 1.2 })

    this.group.add(g)
  }

  private factorySignTex(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#05080f'; ctx.fillRect(0, 0, 1024, 256)
    ctx.fillStyle = 'rgba(39,231,255,0.05)'; for (let y = 0; y < 256; y += 6) ctx.fillRect(0, y, 1024, 2)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 26; ctx.fillStyle = '#cdfaff'
    ctx.font = '900 116px ui-monospace, Menlo, monospace'; ctx.fillText('HUMANOID', 512, 92)
    ctx.shadowColor = '#ff2bd0'; ctx.shadowBlur = 18; ctx.fillStyle = '#ff8ae6'
    ctx.font = '800 76px ui-monospace, Menlo, monospace'; ctx.fillText('R O B O T S', 512, 190)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  /** A heavy forge "birthing machine" at the head of the line: a glowing furnace
   *  block where raw chassis are pressed into being, with pumping pistons. */
  private buildForgeMachine() {
    const Z = this.beltZ, X = this.beltX0
    const shellMat = this.own(new THREE.MeshStandardMaterial({ color: 0x161f33, metalness: 0.75, roughness: 0.35, emissive: 0x0c2236, emissiveIntensity: 0.5 }))
    const hotMat = this.own(new THREE.MeshStandardMaterial({ color: 0x140a06, emissive: 0xff5a1e, emissiveIntensity: 2.2, roughness: 0.3 }))
    // Big furnace housing straddling the belt start.
    const housing = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(6, 9, 12)), shellMat); housing.position.set(X - 2.5, 4.5, Z); this.group.add(housing)
    const mawMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff7a2e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const maw = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(5, 4)), mawMat); maw.position.set(X + 0.1, 3.2, Z); maw.rotation.y = -Math.PI / 2; this.group.add(maw)
    const core = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.9, 0.9, 5, 12)), hotMat); core.position.set(X - 2.5, 6.5, Z); this.group.add(core)
    // Pumping pistons on top that bob.
    for (let i = 0; i < 3; i++) {
      const pist = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.4, 0.4, 3, 8)), shellMat)
      pist.position.set(X - 4 + i * 1.6, 10, Z - 3 + i * 3); this.group.add(pist)
      this.forgePistons.push({ o: pist, ph: i * 1.5, base: 10 })
    }
    // Crucible glow spill on the belt.
    const spill = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(6, 7)), this.own(new THREE.MeshBasicMaterial({ color: 0xff6a1e, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    spill.rotation.x = -Math.PI / 2; spill.position.set(X + 2, 1.25, Z); this.group.add(spill)
  }

  /** Overhead assembly gantry: a bridge crane spanning the line with a trolley that
   *  tracks back and forth and lowers a welder, a rotating holographic blueprint of
   *  the robot being built, and a scanner arch the chassis passes under. */
  private buildGantry() {
    const Z = this.beltZ, cx = (this.beltX0 + this.beltX1) / 2, len = this.lenX
    const steelMat = this.own(new THREE.MeshStandardMaterial({ color: 0x222c44, metalness: 0.7, roughness: 0.35, emissive: 0x0c1830, emissiveIntensity: 0.3 }))
    const bridgeY = 13
    // End towers + spanning bridge beams.
    for (const ex of [this.beltX0 - 3, this.beltX1 + 3]) for (const sz of [-6, 6]) {
      const col = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.7, bridgeY, 0.7)), steelMat); col.position.set(ex, bridgeY / 2, Z + sz); this.group.add(col)
    }
    for (const sz of [-6, 6]) { const beam = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(len + 8, 0.7, 0.7)), steelMat); beam.position.set(cx, bridgeY, Z + sz); this.group.add(beam) }
    // Trolley that rides the bridge + a lowered welder head.
    const trolley = new THREE.Group(); trolley.position.set(cx, bridgeY, Z)
    const cab = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(2.2, 1.1, 4)), steelMat); trolley.add(cab)
    const cable = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.16, 6.5, 0.16)), steelMat); cable.position.y = -3.4; trolley.add(cable)
    const welder = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.7, 1.2, 0.7)), steelMat); welder.position.y = -7; trolley.add(welder)
    this.gWeldMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.gWeld = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.4, 8, 6)), this.gWeldMat); this.gWeld.position.y = -7.7; trolley.add(this.gWeld)
    this.group.add(trolley); this.gTrolley = trolley

    // Big rotating holographic blueprint of a robot, high over the line.
    const bpMat = this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, wireframe: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const bp = new THREE.Group()
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z = 0) => { const m = new THREE.Mesh(this.ownG(geo), bpMat); m.position.set(x, y, z); bp.add(m) }
    add(new THREE.BoxGeometry(1.1, 1.4, 0.7), 0, 0)        // torso
    add(new THREE.BoxGeometry(0.7, 0.7, 0.7), 0, 1.3)      // head
    add(new THREE.BoxGeometry(0.32, 1.3, 0.32), -0.8, -0.1) // arm L
    add(new THREE.BoxGeometry(0.32, 1.3, 0.32), 0.8, -0.1)  // arm R
    add(new THREE.BoxGeometry(0.36, 1.4, 0.36), -0.32, -1.6) // leg L
    add(new THREE.BoxGeometry(0.36, 1.4, 0.36), 0.32, -1.6)  // leg R
    bp.scale.setScalar(1.7); bp.position.set(cx, bridgeY + 4.5, Z)
    this.group.add(bp); this.holos.push({ o: bp, sp: 0.5 })

    // Scanner arch midway down the line, with a sweeping scan plane.
    const archX = cx
    const archMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2438, metalness: 0.7, roughness: 0.4, emissive: 0x123a52, emissiveIntensity: 0.6 }))
    for (const sz of [-5, 5]) { const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, 8, 0.5)), archMat); post.position.set(archX, 4, Z + sz); this.group.add(post) }
    const top = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.6, 0.6, 11)), archMat); top.position.set(archX, 8, Z); this.group.add(top)
    this.scanMat = this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    this.scan = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(0.9, 10)), this.scanMat); this.scan.rotation.z = Math.PI / 2; this.scan.position.set(archX, 4, Z); this.group.add(this.scan)
  }

  /** Detailed circular deck: paneled floor with a neon grid, a raised rim wall with
   *  a glowing lip, warning chevrons at the edge, a central core. */
  private buildDeck() {
    const R = this.radius
    const floorTex = this.deckTexture(); this.texs.push(floorTex)
    const floor = new THREE.Mesh(
      this.ownG(new THREE.CircleGeometry(R, 48)),
      this.own(new THREE.MeshStandardMaterial({ map: floorTex, metalness: 0.5, roughness: 0.55, emissive: 0x0c1a30, emissiveIntensity: 0.35 })),
    )
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.02
    this.group.add(floor)
    // Lighting so it isn't dark up at altitude.
    const key = new THREE.PointLight(0xdcecff, 4.6, 180, 2); key.position.set(0, 26, this.beltZ - 4); this.group.add(key)
    const fill = new THREE.PointLight(0x6fa8ff, 2.4, 140, 2); fill.position.set(0, 12, R * 0.5); this.group.add(fill)
    const forge = new THREE.PointLight(0xff8a3c, 2.2, 42, 2); forge.position.set(this.beltX0, 6, this.beltZ); this.group.add(forge)
    const ambient = new THREE.HemisphereLight(0x9fc0ff, 0x0a1020, 0.7); this.group.add(ambient)

    // Raised rim wall + glowing top lip (so the edge is unmistakable).
    const wall = new THREE.Mesh(
      this.ownG(new THREE.CylinderGeometry(R, R, 1.8, 48, 1, true)),
      this.own(new THREE.MeshStandardMaterial({ color: 0x141d30, metalness: 0.6, roughness: 0.45, side: THREE.DoubleSide, emissive: 0x0a1830, emissiveIntensity: 0.4 })),
    )
    wall.position.y = 0.9; this.group.add(wall)
    this.edgeGlow = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, fog: false }))
    const lip = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(R, 0.32, 10, 64)), this.edgeGlow)
    lip.rotation.x = -Math.PI / 2; lip.position.y = 1.7; this.group.add(lip)
    // Warning chevrons painted just inside the rim, all the way around.
    const warnMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const chevGeo = this.ownG(new THREE.RingGeometry(R - 3.2, R - 1.2, 2, 1, 0, 0.32))
    for (let i = 0; i < 24; i++) {
      const ch = new THREE.Mesh(chevGeo, warnMat); ch.rotation.x = -Math.PI / 2
      ch.rotation.z = (i / 24) * Math.PI * 2; ch.position.y = 0.06; this.group.add(ch)
    }
    // Central core hub.
    const hub = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(4, 5, 0.7, 24)), this.own(new THREE.MeshStandardMaterial({ color: 0x121a2c, metalness: 0.7, roughness: 0.4, emissive: 0x0a2a3a, emissiveIntensity: 0.7 })))
    hub.position.set(0, 0.12, this.beltZ); this.group.add(hub)
    // Under-glow + engine pods so it reads as a hovering rig.
    const glow = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(R * 1.05, 48)), this.own(new THREE.MeshBasicMaterial({ color: 0x1a5cff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })))
    glow.rotation.x = -Math.PI / 2; glow.position.y = -1.8; this.group.add(glow)
    const podMat = this.own(new THREE.MeshStandardMaterial({ color: 0x10182a, metalness: 0.7, roughness: 0.4, emissive: 0x1a5cff, emissiveIntensity: 0.5 }))
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const pod = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.5, 0.7, 5, 8)), podMat)
      pod.position.set(Math.cos(a) * R * 0.82, -2.8, Math.sin(a) * R * 0.82); this.group.add(pod)
    }
  }

  /** Conveyor running along X with an open overhead gantry framing it. */
  private buildConveyor() {
    const len = this.lenX
    const cx = (this.beltX0 + this.beltX1) / 2
    const Z = this.beltZ
    const beltMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1c2740, metalness: 0.6, roughness: 0.55, emissive: 0x0c1a30, emissiveIntensity: 0.4 }))
    const belt = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(len, 0.6, 7)), beltMat)
    belt.position.set(cx, 0.6, Z); this.group.add(belt)
    const stripeMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    for (let i = 0; i < 12; i++) {
      const st = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.6, 0.02, 6.4)), stripeMat)
      st.position.set(this.beltX0 + (i / 12) * len, 0.92, Z); this.group.add(st); this.beltSeams.push(st)
    }
    const railMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2438, metalness: 0.7, roughness: 0.4 }))
    for (const sz of [-3.6, 3.6]) { const rail = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(len, 1.3, 0.5)), railMat); rail.position.set(cx, 0.85, Z + sz); this.group.add(rail) }
    // (the exposed overhead truss "gantry" was retired - the belt now sits inside
    //  the vaulted assembly hangar built in buildAssemblyHangar)
    // Hot forge arch at the head where raw chassis drop in.
    const forgeMat = this.own(new THREE.MeshStandardMaterial({ color: 0x0c1018, emissive: 0xff6a1e, emissiveIntensity: 1.9, roughness: 0.3 }))
    const forge = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.6, 0.5, 7)), forgeMat); forge.position.set(this.beltX0, 2.4, Z); this.group.add(forge)
    const forgeGlow = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(3, 5)), this.own(new THREE.MeshBasicMaterial({ color: 0xff7a2e, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    forgeGlow.position.set(this.beltX0 - 0.4, 2.4, Z); forgeGlow.rotation.y = Math.PI / 2; this.group.add(forgeGlow)
    // (the big girder status screens were removed - they blocked the HUMANOID
    //  ROBOTS sign on the tower; the tower's own wall screens cover that detail)
    // Conduits running along the gantry.
    const pipeMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.75, roughness: 0.35, emissive: 0x112233, emissiveIntensity: 0.3 }))
    for (const sz of [-6.85, 6.85]) for (const yy of [2.4, 3.4]) { const pipe = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.18, 0.18, len + 4, 8)), pipeMat); pipe.rotation.z = Math.PI / 2; pipe.position.set(cx, yy, Z + sz); this.group.add(pipe) }
  }

  /** The assembly building over the conveyor line, styled after the concept art:
   *  a chunky dark-navy block with cyan neon edge-trim, glass upper assembly floor,
   *  a big glowing octagonal robot-head logo, corner light-pillars and a rooftop
   *  antenna. The ground floor is an open walk-through passage (front + back
   *  archways) over the belt; the solid side walls register colliders. */
  private buildAssemblyHangar() {
    const Z = this.beltZ
    const HW = 22, depth = 26
    const frontZ = Z - depth / 2, backZ = Z + depth / 2
    const FH0 = 8.5, FH1 = 7.5 // ground (walk-through) + upper (glass assembly) floor heights
    const roofY = FH0 + FH1 // ~16

    const navy = this.own(new THREE.MeshStandardMaterial({ color: 0x141d33, metalness: 0.6, roughness: 0.42, emissive: 0x0a1430, emissiveIntensity: 0.4 }))
    const navyDark = this.own(new THREE.MeshStandardMaterial({ color: 0x0b1124, metalness: 0.55, roughness: 0.6 }))
    const deck = this.own(new THREE.MeshStandardMaterial({ color: 0x101a30, metalness: 0.5, roughness: 0.6 }))
    const glass = this.own(new THREE.MeshStandardMaterial({ color: 0x0a2b4a, metalness: 0.2, roughness: 0.1, transparent: true, opacity: 0.32, emissive: 0x0a3a5e, emissiveIntensity: 0.5, side: THREE.DoubleSide }))
    const cyan = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.towerStripMats.push(cyan)
    const box = (w: number, h: number, d: number, m: THREE.Material) => new THREE.Mesh(this.ownG(new THREE.BoxGeometry(w, h, d)), m)

    // Upper floor slab + flat roof.
    const upperFloor = box(HW * 2, 0.5, depth, deck); upperFloor.position.set(0, FH0, Z); this.group.add(upperFloor)
    const roof = box(HW * 2 + 1, 0.6, depth + 1, navy); roof.position.set(0, roofY + 0.3, Z); roof.castShadow = true; this.group.add(roof)

    // Solid navy side walls (full height) with a glass band on the upper floor.
    for (const sx of [-1, 1]) {
      const wall = box(0.7, roofY, depth, navy); wall.position.set(sx * HW, roofY / 2, Z); wall.castShadow = true; this.group.add(wall)
      const g = box(0.25, FH1 - 1.4, depth - 3, glass); g.position.set(sx * HW - sx * 0.45, FH0 + FH1 / 2, Z); this.group.add(g)
    }
    // Back + front: upper floor is walled (glass front), ground floor is an open
    // archway you walk through (flanking posts + a lintel, central gap clear).
    for (const sz of [frontZ, backZ]) {
      const upperWall = box(HW * 2, FH1, 0.6, navy); upperWall.position.set(0, FH0 + FH1 / 2, sz); this.group.add(upperWall)
      for (const sx of [-1, 1]) { const post = box(HW * 0.58, FH0, 0.7, navy); post.position.set(sx * (HW * 0.71), FH0 / 2, sz); this.group.add(post) }
      const lintel = box(HW * 2, 0.7, 0.9, cyan); lintel.position.set(0, FH0 - 0.2, sz); this.group.add(lintel)
    }
    // Glass front of the upper assembly floor (between the side glass bands).
    const frontGlass = box(HW * 2 - 4, FH1 - 1.4, 0.2, glass); frontGlass.position.set(0, FH0 + FH1 / 2, frontZ - 0.2); this.group.add(frontGlass)

    // Chunky corner light-pillars with vertical cyan strips + glowing caps.
    for (const sx of [-1, 1]) for (const sz of [frontZ, backZ]) {
      const pil = box(2.2, roofY + 1.6, 2.2, navy); pil.position.set(sx * (HW + 0.6), (roofY + 1.6) / 2, sz); pil.castShadow = true; this.group.add(pil)
      const strip = box(0.32, roofY - 1, 0.32, cyan); strip.position.set(sx * (HW + 0.6) + sx * 1.15, roofY / 2, sz); this.group.add(strip)
      const cap = box(2.6, 0.4, 2.6, cyan); cap.position.set(sx * (HW + 0.6), roofY + 1.7, sz); this.group.add(cap)
    }

    // Cyan neon edge-trim running along the front + sides at each floor level.
    for (const y of [0.35, FH0 + 0.35, roofY + 0.4]) {
      const bar = box(HW * 2 + 0.4, 0.16, 0.16, cyan); bar.position.set(0, y, frontZ); this.group.add(bar)
      for (const sx of [-1, 1]) { const s = box(0.16, 0.16, depth + 0.3, cyan); s.position.set(sx * HW + sx * 0.1, y, Z); this.group.add(s) }
    }

    // Big glowing octagonal robot-head logo on the upper front (faces the deck).
    const logoMat = this.own(new THREE.MeshBasicMaterial({ map: this.hangarLogoTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.towerStripMats.push(logoMat)
    const logo = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(6.8, 6.8)), logoMat)
    logo.position.set(0, FH0 + FH1 / 2 + 0.3, frontZ - 0.55); logo.rotation.y = Math.PI; this.group.add(logo)

    // Rooftop antenna beacon (the concept's mast + cyan tip).
    const mast = box(0.3, 5, 0.3, navyDark); mast.position.set(HW * 0.55, roofY + 2.9, Z - depth * 0.3); this.group.add(mast)
    const beacon = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.42, 10, 8)), cyan); beacon.position.set(HW * 0.55, roofY + 5.7, Z - depth * 0.3); this.group.add(beacon)

    // Hazard-striped entrance ramp leading up to the front archway.
    const ramp = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(11, 0.4, 6.5)), this.own(new THREE.MeshStandardMaterial({ map: this.hazardTexture(), metalness: 0.4, roughness: 0.6 })))
    ramp.position.set(0, 0.32, frontZ - 3.3); ramp.rotation.x = 0.12; this.group.add(ramp)

    // Upper-floor assembly read: a short belt with a row of half-built robot units
    // behind the glass, so the floor looks like the line is running up there too.
    const unitMat = this.own(new THREE.MeshStandardMaterial({ color: config.palette.robot, metalness: 0.7, roughness: 0.4 }))
    const ubelt = box(HW * 1.6, 0.3, 1.6, navyDark); ubelt.position.set(0, FH0 + 0.65, Z); this.group.add(ubelt)
    const ustrip = box(HW * 1.6, 0.06, 0.5, cyan); ustrip.position.set(0, FH0 + 0.83, Z); this.group.add(ustrip)
    for (let i = 0; i < 5; i++) {
      const x = -14 + i * 7
      const torso = box(0.6, 0.9, 0.5, unitMat); torso.position.set(x, FH0 + 1.3, Z); this.group.add(torso)
      const head = box(0.42, 0.42, 0.42, unitMat); head.position.set(x, FH0 + 2.0, Z); this.group.add(head)
    }

    // Floor guide strips flanking the belt on the walk-through ground floor.
    for (const sz of [-7.5, 7.5]) { const fl = box(HW * 1.7, 0.05, 0.3, cyan); fl.position.set(0, 0.13, Z + sz); this.group.add(fl) }
  }

  /** A glowing octagonal robot-head logo drawn once to a canvas. */
  private hangarLogoTexture(): THREE.CanvasTexture {
    const s = 256
    const cv = document.createElement('canvas'); cv.width = s; cv.height = s
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, s, s)
    const c = '#27e7ff'
    ctx.strokeStyle = c; ctx.fillStyle = c; ctx.shadowColor = c
    ctx.lineWidth = 10; ctx.shadowBlur = 26
    const cx = s / 2, cy = s / 2, R = 104, k = R * 0.41
    const oct: [number, number][] = [[-k, -R], [k, -R], [R, -k], [R, k], [k, R], [-k, R], [-R, k], [-R, -k]]
    ctx.beginPath(); oct.forEach(([x, y], i) => { const px = cx + x, py = cy + y; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) }); ctx.closePath(); ctx.stroke()
    ctx.shadowBlur = 18; ctx.lineWidth = 12
    const hw = 46
    ctx.beginPath(); ctx.roundRect(cx - hw, cy - hw + 8, hw * 2, hw * 2, 16); ctx.stroke()
    ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(cx, cy - hw + 8); ctx.lineTo(cx, cy - hw - 18); ctx.stroke()
    ctx.beginPath(); ctx.arc(cx, cy - hw - 24, 8, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(cx - 20, cy + 12, 13, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(cx + 20, cy + 12, 13, 0, Math.PI * 2); ctx.fill()
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    this.texs.push(tex)
    return tex
  }

  /** Yellow/black hazard stripes for the entrance ramp. */
  private hazardTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#14161c'; ctx.fillRect(0, 0, 128, 128)
    ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 16
    for (let i = -128; i < 256; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 128, 128); ctx.stroke() }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(2, 1)
    this.texs.push(tex)
    return tex
  }

  /** Industrial worker arms at stations down both sides of the belt. */
  private buildArms() {
    const baseMat = this.own(new THREE.MeshStandardMaterial({ color: 0x222c44, metalness: 0.7, roughness: 0.35 }))
    const segMat = this.own(new THREE.MeshStandardMaterial({ color: 0x33405e, metalness: 0.7, roughness: 0.35 }))
    const armGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.5, 3.6))
    const foreGeo = this.ownG(new THREE.BoxGeometry(0.4, 0.4, 2.6))
    const baseGeo = this.ownG(new THREE.CylinderGeometry(0.9, 1.1, 1.8, 10))
    const sparkGeo = this.ownG(new THREE.SphereGeometry(0.22, 8, 6))
    const stations = 4
    let s = 0
    for (let i = 0; i < stations; i++) {
      const x = this.beltX0 + 5 + (i / (stations - 1)) * (this.lenX - 10)
      for (const sz of [-1, 1]) {
        const root = new THREE.Group(); root.position.set(x, 0, this.beltZ + sz * 5)
        const base = new THREE.Mesh(baseGeo, baseMat); base.position.y = 0.9; root.add(base)
        const pivot = new THREE.Group(); pivot.position.set(0, 1.8, 0); root.add(pivot)
        const upper = new THREE.Mesh(armGeo, segMat); upper.position.set(0, 0, -sz * 1.6); pivot.add(upper)
        const elbow = new THREE.Group(); elbow.position.set(0, 0, -sz * 3.2); pivot.add(elbow)
        const fore = new THREE.Mesh(foreGeo, segMat); fore.position.set(0, -0.4, -sz * 1.1); elbow.add(fore)
        const sparkMat = this.own(new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
        const spark = new THREE.Mesh(sparkGeo, sparkMat); spark.position.set(0, -0.8, -sz * 2.2); elbow.add(spark)
        this.group.add(root)
        this.arms.push({ pivot, elbow, spark, sparkMat, ph: s * 1.3 }); s++
      }
    }
  }

  /** Neon DROP ZONE billboard + a big animated down-arrow at the ledge. */
  private buildSign() {
    const R = this.radius
    // Sign sits just INSIDE the ledge (the glass tower now rises beyond it), a
    // foreground "step off here" banner that doesn't fight the tower behind it.
    const sz = R - 7
    const postMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1b2336, metalness: 0.6, roughness: 0.4 }))
    for (const sx of [-10, 10]) { const post = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.8, 12, 0.8)), postMat); post.position.set(sx, 6, sz); this.group.add(post) }
    const tex = this.signTex(); this.texs.push(tex)
    const panel = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(22, 7.5)), this.own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide })))
    panel.position.set(0, 9.5, sz); panel.rotation.y = Math.PI; this.group.add(panel)
    const frameMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff2bd0, fog: false }))
    for (const y of [13.4, 5.8]) { const bar = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(23, 0.4, 0.4)), frameMat); bar.position.set(0, y, sz); this.group.add(bar) }
    // Down-arrow chevrons flowing toward the drop.
    this.arrowMat = this.own(new THREE.MeshBasicMaterial({ color: 0x27e7ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const chevGeo = this.ownG(new THREE.ConeGeometry(2.6, 2.8, 4))
    for (let i = 0; i < 4; i++) {
      const chev = new THREE.Mesh(chevGeo, this.arrowMat)
      chev.rotation.x = Math.PI; chev.rotation.y = Math.PI / 4
      chev.position.set(0, 6 - i * 2.3, R - 3); this.group.add(chev); this.arrowChevs.push(chev)
    }
  }

  private buildProps() {
    const R = this.radius
    const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9b6bff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(1.6, 0))
    const cageMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.7, roughness: 0.4, emissive: 0x27e7ff, emissiveIntensity: 0.4 }))
    const cageGeo = this.ownG(new THREE.TorusGeometry(2.1, 0.12, 6, 16))
    // Tucked toward the rim on the sides so they accent the deck without blocking
    // the line-to-ledge sightline.
    for (const [ax, az] of [[-0.82, -0.2], [0.82, -0.2], [-0.82, 0.5], [0.82, 0.5]] as [number, number][]) {
      const core = new THREE.Mesh(coreGeo, coreMat); core.scale.setScalar(0.6); core.position.set(ax * R, 2.6, this.beltZ + az * R)
      this.group.add(core); this.cores.push(core)
      for (let k = 0; k < 2; k++) { const cage = new THREE.Mesh(cageGeo, cageMat); cage.scale.setScalar(0.6); cage.position.copy(core.position); cage.rotation.x = k * Math.PI / 2; this.group.add(cage) }
    }
  }

  /** Two rockets on launch gantries at the sides that ignite, shake and blast off
   *  on a staggered loop. */
  private buildRockets() {
    const R = this.radius
    const smokeTex = this.smokeTexture(); this.texs.push(smokeTex)
    const specs: { x: number; z: number; off: number }[] = [
      { x: -R * 0.66, z: this.beltZ + 2, off: 0 },
      { x: R * 0.66, z: this.beltZ - 4, off: 6.5 },
    ]
    // Shared clean low-poly materials: white hull, dark nose/nozzles, glowing blue.
    const hullMat = this.own(new THREE.MeshStandardMaterial({ color: 0xeef2f8, metalness: 0.4, roughness: 0.38 }))
    const darkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x161c2a, metalness: 0.7, roughness: 0.4 }))
    const blueMat = this.own(new THREE.MeshBasicMaterial({ color: 0x33b8ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    for (const s of specs) {
      const g = new THREE.Group(); g.position.set(s.x, 0, s.z)
      // Central core: tall white body, ogive nose with a dark tip.
      const body = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.5, 1.7, 13, 18)), hullMat); body.position.y = 7.5; g.add(body)
      const noseBase = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.7, 1.5, 2.4, 18)), hullMat); noseBase.position.y = 15.2; g.add(noseBase)
      const noseTip = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(0.7, 2.4, 18)), darkMat); noseTip.position.y = 17.6; g.add(noseTip)
      // Glowing blue accent bands + vertical strakes.
      for (const by of [11.6, 4.4]) { const band = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.64, 1.66, 0.5, 18)), blueMat); band.position.y = by; g.add(band) }
      for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; const st = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.18, 8, 0.18)), blueMat); st.position.set(Math.cos(a) * 1.62, 8, Math.sin(a) * 1.62); g.add(st) }
      // Two side boosters with their own noses, accents, fins and nozzles.
      for (const bx of [-1, 1]) {
        const boost = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.85, 0.95, 9, 14)), hullMat); boost.position.set(bx * 2.2, 5, 0); g.add(boost)
        const bnose = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(0.85, 2, 14)), darkMat); bnose.position.set(bx * 2.2, 10.5, 0); g.add(bnose)
        const bband = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.95, 0.97, 0.45, 14)), blueMat); bband.position.set(bx * 2.2, 8, 0); g.add(bband)
        const bnoz = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.6, 0.95, 1, 14)), darkMat); bnoz.position.set(bx * 2.2, 0.2, 0); g.add(bnoz)
        const bfin = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.3, 3.4, 2.4)), darkMat); bfin.position.set(bx * 3, 1.8, 0); bfin.rotation.z = bx * -0.18; g.add(bfin)
      }
      // Strong swept main fins.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4
        const fin = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.35, 4, 2.8)), darkMat)
        fin.position.set(Math.cos(a) * 1.7, 2.4, Math.sin(a) * 1.7); fin.rotation.y = -a; fin.rotation.x = 0.12; g.add(fin)
        const finEdge = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 0.2, 2.8)), blueMat); finEdge.position.set(Math.cos(a) * 1.7, 4.2, Math.sin(a) * 1.7); finEdge.rotation.y = -a; g.add(finEdge)
      }
      const bell = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.0, 1.7, 1.6, 16)), darkMat); bell.position.y = 0.6; g.add(bell)
      // Glowing circular launch pad under the stack.
      const pad = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(5, 5.4, 0.6, 24)), darkMat); pad.position.y = -0.4; g.add(pad)
      const padRing = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(4.6, 0.16, 8, 32)), blueMat); padRing.rotation.x = -Math.PI / 2; padRing.position.y = 0; g.add(padRing)
      const padGlow = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(4.4, 28)), this.own(new THREE.MeshBasicMaterial({ color: 0x33b8ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))); padGlow.rotation.x = -Math.PI / 2; padGlow.position.y = 0.06; g.add(padGlow)
      // Engine flame (cone pointing down) + a bright glow disc, hidden until ignition.
      const flameMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffb24a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const flame = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(1.5, 6, 14)), flameMat); flame.rotation.x = Math.PI; flame.position.y = -2.4; g.add(flame)
      const glowMat = this.own(new THREE.MeshBasicMaterial({ color: 0x59c0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const glow = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.4, 12, 10)), glowMat); glow.position.y = -1.5; g.add(glow)
      this.group.add(g)
      // Static launch gantry tower beside it.
      const towerMat = this.own(new THREE.MeshStandardMaterial({ color: 0x232c40, metalness: 0.6, roughness: 0.45, emissive: 0x0c2030, emissiveIntensity: 0.4 }))
      const tower = new THREE.Group(); tower.position.set(s.x + 3.2, 0, s.z)
      for (const sx of [-0.9, 0.9]) { const leg = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.4, 16, 0.4)), towerMat); leg.position.set(sx, 8, 0); tower.add(leg) }
      for (let i = 0; i < 4; i++) { const rung = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(2.2, 0.25, 0.25)), towerMat); rung.position.set(0, 3 + i * 4, 0); tower.add(rung) }
      const arm = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(2.4, 0.3, 0.3)), towerMat); arm.position.set(-1.6, 11, 0); tower.add(arm)
      this.group.add(tower)
      // Ground smoke sprites at the base.
      const smokeMat = this.own(new THREE.SpriteMaterial({ map: smokeTex, color: 0xcdd6e2, transparent: true, opacity: 0, depthWrite: false, fog: false }))
      for (let i = 0; i < 5; i++) { const sp = new THREE.Sprite(smokeMat); sp.position.set(s.x + (Math.random() - 0.5) * 5, 0.6, s.z + (Math.random() - 0.5) * 5); sp.scale.set(6, 6, 1); this.group.add(sp) }
      this.rockets.push({ g, flame, flameMat, glowMat, smokeMat, bx: s.x, bz: s.z, t: s.off, vy: 0, y: 0, ph: s.off })
    }
  }

  private buildClouds() {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(220,235,255,0.4)'); g.addColorStop(1, 'rgba(220,235,255,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; this.texs.push(tex)
    const mat = this.own(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.5, depthWrite: false, fog: false }))
    const n = config.tier.name === 'low' ? 6 : 12
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2; const r = 60 + (i % 3) * 34
      const puff = new THREE.Sprite(mat); puff.position.set(Math.cos(a) * r, -34 - (i % 4) * 18, this.beltZ + Math.sin(a) * r); puff.scale.set(90, 54, 1); this.group.add(puff)
    }
  }

  // Shared low-poly part geometries (reused across every unit; only materials
  // differ per robot, so the variety is cheap).
  private ug = {
    torso: this.ownG(new THREE.BoxGeometry(0.95, 1.1, 0.6)),
    torsoSlim: this.ownG(new THREE.BoxGeometry(0.7, 1.25, 0.5)),
    headBox: this.ownG(new THREE.BoxGeometry(0.55, 0.55, 0.55)),
    headDome: this.ownG(new THREE.SphereGeometry(0.32, 10, 8)),
    leg: this.ownG(new THREE.BoxGeometry(0.26, 0.95, 0.26)),
    foot: this.ownG(new THREE.BoxGeometry(0.34, 0.18, 0.5)),
    arm: this.ownG(new THREE.BoxGeometry(0.22, 0.9, 0.22)),
    claw: this.ownG(new THREE.BoxGeometry(0.16, 0.32, 0.16)),
    hips: this.ownG(new THREE.BoxGeometry(0.9, 0.32, 0.7)),
    wheel: this.ownG(new THREE.CylinderGeometry(0.6, 0.6, 0.26, 16)),
    hub: this.ownG(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 8)),
    fork: this.ownG(new THREE.BoxGeometry(0.22, 0.8, 0.22)),
    visor: this.ownG(new THREE.BoxGeometry(0.5, 0.13, 0.08)),
    eye: this.ownG(new THREE.BoxGeometry(0.1, 0.1, 0.06)),
    pad: this.ownG(new THREE.BoxGeometry(0.3, 0.22, 0.5)),
    core: this.ownG(new THREE.CylinderGeometry(0.16, 0.16, 0.08, 12)),
    antenna: this.ownG(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 5)),
    tip: this.ownG(new THREE.SphereGeometry(0.07, 6, 5)),
    pack: this.ownG(new THREE.BoxGeometry(0.55, 0.7, 0.28)),
  }

  private buildUnits() {
    const tints = [0x27e7ff, 0xff2bd0, 0x9dff5a, 0xffd24a, 0xb98cff, 0xff8a1e, 0x4af0c0, 0xff5a7a]
    const n = config.tier.name === 'low' ? 8 : 13
    for (let i = 0; i < n; i++) {
      const col = tints[i % tints.length]
      const roller = i % 3 === 2          // every third unit rolls on wheels
      const humanoid = !roller && i % 2 === 0 // half-human variant for some bipeds
      const scale = 0.85 + ((i * 0.37) % 1) * 0.8 // 0.85 .. 1.65, deterministic spread
      const u = this.makeUnit(col, scale, roller ? 'roller' : 'biped', humanoid)
      this.units.push(u)
      // Seed a lively mix: most mid-build along the belt, a couple already finished
      // and walking the deck - so you see robots being built AND walking off to dive.
      if (i % 3 === 1) this.startWalker(u)
      else this.respawnUnit(u, this.beltX0 + (i / n) * this.lenX * 0.95)
    }
  }

  /** Build one varied robot: legs or wheels, with a visor, antenna, chest core,
   *  shoulder pads and a back module - some leaning humanoid. */
  private makeUnit(col: number, scale: number, kind: 'biped' | 'roller', humanoid: boolean) {
    const g = new THREE.Group(); g.scale.setScalar(1.45 * scale)
    const ug = this.ug
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: humanoid ? 0x8a93ab : 0x5a6f96, emissive: col, emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.5, transparent: true, opacity: 1 }))
    const headMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: col, emissiveIntensity: 2.4, roughness: 0.4, transparent: true, opacity: 1 }))
    const darkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x161d2e, metalness: 0.7, roughness: 0.4 }))

    const hips = new THREE.Mesh(ug.hips, bodyMat); hips.position.y = 0.32

    // Locomotion: legs (biped) or a wheel rig (roller).
    let legL: THREE.Object3D, legR: THREE.Object3D, wheel: THREE.Object3D | null = null
    if (kind === 'roller') {
      const rig = new THREE.Group()
      const w = new THREE.Group() // spun while moving
      for (const sx of [-0.42, 0.42]) {
        const tire = new THREE.Mesh(ug.wheel, darkMat); tire.rotation.z = Math.PI / 2; tire.position.x = sx; w.add(tire)
        const hub = new THREE.Mesh(ug.hub, headMat); hub.rotation.z = Math.PI / 2; hub.position.x = sx; w.add(hub)
      }
      w.position.y = 0.6; rig.add(w)
      const fork = new THREE.Mesh(ug.fork, darkMat); fork.position.y = 0.95; rig.add(fork)
      wheel = w; legL = rig; legR = new THREE.Group() // legR unused for rollers
      hips.position.y = 1.15
    } else {
      legL = new THREE.Mesh(ug.leg, bodyMat); legL.position.set(-0.22, 0.75, 0)
      legR = new THREE.Mesh(ug.leg, bodyMat); legR.position.set(0.22, 0.75, 0)
      for (const leg of [legL, legR]) { const foot = new THREE.Mesh(ug.foot, darkMat); foot.position.set(0, -0.52, 0.08); leg.add(foot) }
    }

    const torsoY = kind === 'roller' ? 2.0 : 1.75
    const torso = new THREE.Mesh(humanoid ? ug.torsoSlim : ug.torso, bodyMat); torso.position.y = torsoY
    const core = new THREE.Mesh(ug.core, headMat); core.rotation.x = Math.PI / 2; core.position.set(0, 0.05, (humanoid ? 0.26 : 0.31)); torso.add(core)
    for (const sx of [-0.62, 0.62]) { const pad = new THREE.Mesh(ug.pad, darkMat); pad.position.set(sx, 0.5, 0); torso.add(pad) }
    const pack = new THREE.Mesh(ug.pack, darkMat); pack.position.set(0, 0.1, -0.42); torso.add(pack)

    const armL = new THREE.Mesh(ug.arm, bodyMat); armL.position.set(-0.62, torsoY, 0)
    const armR = new THREE.Mesh(ug.arm, bodyMat); armR.position.set(0.62, torsoY, 0)
    // One hand is a little claw for character.
    for (const dx of [-0.07, 0.07]) { const cl = new THREE.Mesh(ug.claw, darkMat); cl.position.set(dx, -0.55, 0); armR.add(cl) }
    const hand = new THREE.Mesh(ug.tip, headMat); hand.scale.setScalar(1.6); hand.position.y = -0.5; armL.add(hand)

    const headY = torsoY + 0.85
    // Head shell is body-colored metal; the visor/eyes glow. Details parent to the
    // head so they only appear once the head is welded on.
    const headShell = new THREE.Mesh(humanoid ? ug.headDome : ug.headBox, bodyMat); headShell.position.y = headY
    const visor = new THREE.Mesh(ug.visor, headMat); visor.position.set(0, 0.02, humanoid ? 0.26 : 0.29); headShell.add(visor)
    if (humanoid) { for (const sx of [-0.12, 0.12]) { const e = new THREE.Mesh(ug.eye, headMat); e.position.set(sx, 0.03, 0.27); headShell.add(e) } }
    const ant = new THREE.Mesh(ug.antenna, darkMat); ant.position.set(0.18, 0.42, 0); headShell.add(ant)
    const tip = new THREE.Mesh(ug.tip, headMat); tip.position.set(0.18, 0.7, 0); headShell.add(tip)

    // parts[] drives the staged build reveal: [hips, loco, loco, torso, armL, armR, head]
    const parts: THREE.Object3D[] = [hips, legL, legR, torso, armL, armR, headShell]
    for (const p of parts) g.add(p)
    this.group.add(g)

    return {
      g, parts, legL, legR, wheel, kind, bodyMat, headMat,
      x: 0, z: 0, tx: 0, tz: 0, state: 'build' as const,
      v: (5.4 - scale * 1.2) + Math.random() * 1.2, ph: Math.random() * 6.28, fallT: 0, wait: 0, lane: (Math.random() - 0.5) * 1.4,
    }
  }

  /** Wild sci-fi set dressing around the deck: hover drones, hologram projectors,
   *  energy pylons and floating cargo. */
  private buildSciFi() {
    const R = this.radius, low = config.tier.name === 'low'
    // Hologram projectors to the sides: a pedestal beaming a rotating wireframe.
    const holoMat = this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, wireframe: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const padMat = this.own(new THREE.MeshStandardMaterial({ color: 0x141d30, metalness: 0.7, roughness: 0.4, emissive: 0x0c3050, emissiveIntensity: 0.6 }))
    const holoGeos = [this.ownG(new THREE.IcosahedronGeometry(1.5, 0)), this.ownG(new THREE.TorusKnotGeometry(0.9, 0.32, 48, 6))]
    const spots: [number, number, number][] = [[-R * 0.62, 6, 0], [R * 0.62, 6, 0]]
    spots.forEach((s, i) => {
      const ped = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(1.3, 1.6, 0.6, 16)), padMat); ped.position.set(s[0], 0.3, s[2]); this.group.add(ped)
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(1.4, 0.08, 8, 24)), this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, fog: false }))); ring.rotation.x = -Math.PI / 2; ring.position.set(s[0], 0.65, s[2]); this.group.add(ring)
      const beam = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(1.3, 4.5, 16, 1, true)), beamMat); beam.position.set(s[0], 2.9, s[2]); this.group.add(beam)
      const holo = new THREE.Mesh(holoGeos[i % holoGeos.length], holoMat); holo.position.set(s[0], 3.4, s[2]); this.group.add(holo)
      this.holos.push({ o: holo, sp: i ? -0.6 : 0.8 })
    })

    // Energy pylons at the back corners: poles capped with a pulsing orb.
    const poleMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1a2336, metalness: 0.7, roughness: 0.4 }))
    for (const sx of [-R * 0.66, R * 0.66]) {
      const pole = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.35, 0.5, 9, 10)), poleMat); pole.position.set(sx, 4.5, -R * 0.5); this.group.add(pole)
      const cage = new THREE.Mesh(this.ownG(new THREE.IcosahedronGeometry(1.1, 0)), this.own(new THREE.MeshBasicMaterial({ color: 0x9b6bff, wireframe: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))); cage.position.set(sx, 9.4, -R * 0.5); this.group.add(cage); this.holos.push({ o: cage, sp: 1.4 })
      const orbMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbf9bff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const orb = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.6, 12, 10)), orbMat); orb.position.set(sx, 9.4, -R * 0.5); this.group.add(orb); this.pylons.push(orbMat)
    }

    // Floating cargo pods scattered near the rim.
    const crateMat = this.own(new THREE.MeshStandardMaterial({ color: 0x223052, metalness: 0.6, roughness: 0.45, emissive: 0x16324f, emissiveIntensity: 0.5 }))
    const stripeMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const crateGeo = this.ownG(new THREE.BoxGeometry(2.4, 2.4, 2.4))
    const stGeo = this.ownG(new THREE.BoxGeometry(2.46, 0.18, 2.46))
    const cpos: [number, number][] = [[-R * 0.5, -R * 0.66], [R * 0.46, -R * 0.6], [-R * 0.72, R * 0.18], [R * 0.7, R * 0.2]]
    cpos.forEach(([cx, cz], i) => {
      const crate = new THREE.Group()
      const box = new THREE.Mesh(crateGeo, crateMat); crate.add(box)
      const st = new THREE.Mesh(stGeo, stripeMat); st.position.y = 0.4; crate.add(st)
      crate.scale.setScalar(0.7 + (i % 3) * 0.18); crate.rotation.y = i * 0.7
      const baseY = 1.6 + (i % 2) * 0.8
      crate.position.set(cx, baseY, cz); this.group.add(crate)
      // anti-grav glow under it
      const ag = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(1.6, 16)), this.own(new THREE.MeshBasicMaterial({ color: 0x36e0ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      ag.rotation.x = -Math.PI / 2; ag.position.set(cx, 0.1, cz); this.group.add(ag)
      this.cargo.push({ o: crate, ph: i * 1.7, baseY })
    })

    // Hover drones that orbit the deck, bobbing, with spinning rotors and an eye.
    const droneBody = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.6, roughness: 0.4, emissive: 0x0c2030, emissiveIntensity: 0.6 }))
    const droneEye = this.own(new THREE.MeshBasicMaterial({ color: 0xff4a6a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const rotorMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const bodyGeo = this.ownG(new THREE.SphereGeometry(0.6, 10, 8))
    const eyeGeo = this.ownG(new THREE.SphereGeometry(0.16, 8, 6))
    const armGeo = this.ownG(new THREE.BoxGeometry(1.5, 0.06, 0.12))
    const rotorGeo = this.ownG(new THREE.CircleGeometry(0.34, 12))
    const nD = low ? 2 : 4
    for (let i = 0; i < nD; i++) {
      const d = new THREE.Group()
      const body = new THREE.Mesh(bodyGeo, droneBody); d.add(body)
      const eye = new THREE.Mesh(eyeGeo, droneEye); eye.position.set(0, 0, 0.55); d.add(eye)
      const rotors: THREE.Object3D[] = []
      for (let k = 0; k < 2; k++) { const a = new THREE.Mesh(armGeo, droneBody); a.rotation.y = k * Math.PI / 2; d.add(a) }
      for (const [rx, rz] of [[0.72, 0], [-0.72, 0], [0, 0.72], [0, -0.72]] as [number, number][]) {
        const r = new THREE.Mesh(rotorGeo, rotorMat); r.rotation.x = -Math.PI / 2; r.position.set(rx, 0.12, rz); d.add(r); rotors.push(r)
      }
      this.group.add(d)
      this.drones.push({ g: d, a: (i / nD) * Math.PI * 2, r: R * 0.5 + (i % 2) * 7, h: 9 + (i % 3) * 3, sp: 0.25 + (i % 2) * 0.12, rotors })
    }
  }

  /** Drop a finished unit on the open deck in front of the line, already walking
   *  toward the ledge - used to seed visible foot traffic at startup. */
  private startWalker(u: LaunchPad['units'][number]) {
    for (const p of u.parts) p.visible = true
    u.bodyMat.opacity = 1; u.headMat.opacity = 1; u.headMat.emissiveIntensity = 2.4; u.bodyMat.emissiveIntensity = 0.55
    u.fallT = 0; u.wait = 0
    u.x = (Math.random() - 0.5) * this.radius * 0.8
    u.z = this.beltZ + 6 + Math.random() * (this.radius - this.beltZ - 12)
    u.g.rotation.set(0, 0, 0)
    u.g.position.set(u.x, 0, u.z) // local to the deck (group already sits at topY)
    this.headToEdge(u)
  }

  /** Send a unit on a straight walk to the ledge near its current lane, then dive. */
  private headToEdge(u: LaunchPad['units'][number]) {
    u.state = 'edge'
    u.tx = THREE.MathUtils.clamp(u.x, -this.radius * 0.55, this.radius * 0.55)
  }

  /** Reset a unit to the head of the belt to be built again. */
  private respawnUnit(u: LaunchPad['units'][number], x: number) {
    u.x = x; u.z = this.beltZ + u.lane; u.state = 'build'; u.fallT = 0; u.wait = 0
    u.g.position.set(u.x, 0.9, u.z) // sitting on the belt (local deck space)
    u.g.rotation.set(0, 0, 0)
    u.bodyMat.opacity = 1; u.headMat.opacity = 1; u.headMat.emissiveIntensity = 2.4; u.bodyMat.emissiveIntensity = 0.25
  }

  /** A random point on the deck in front of the line for a unit to wander to. */
  private wanderPoint(): { x: number; z: number } {
    return { x: (Math.random() - 0.5) * this.radius * 1.1, z: this.beltZ + 5 + Math.random() * (this.radius - this.beltZ - 11) }
  }

  update(dt: number, _x: number, _z: number) {
    this.t += dt
    for (const st of this.beltSeams) { st.position.x += 6 * dt; if (st.position.x > this.beltX1) st.position.x = this.beltX0 }
    for (const a of this.arms) {
      a.pivot.rotation.x = Math.sin(this.t * 2 + a.ph) * 0.5 - 0.3
      a.elbow.rotation.x = Math.sin(this.t * 3 + a.ph) * 0.6
      a.sparkMat.opacity = Math.max(0, Math.sin(this.t * 18 + a.ph)) * 0.85
      a.spark.scale.setScalar(1 + a.sparkMat.opacity * 0.9)
    }
    for (let i = 0; i < this.cores.length; i++) { const c = this.cores[i]; c.rotation.x += dt * 1.1; c.rotation.y += dt * 0.8; c.position.y = 3.4 + Math.sin(this.t * 1.4 + i) * 0.5 }
    // Sci-fi props.
    for (const h of this.holos) { h.o.rotation.y += h.sp * dt; h.o.rotation.x += h.sp * 0.4 * dt }
    for (const m of this.pylons) m.opacity = 0.45 + Math.sin(this.t * 3.2) * 0.4
    // Skyline rooftop beacons blink out of phase.
    for (const b of this.beacons) b.mat.opacity = 0.25 + Math.pow(Math.max(0, Math.sin(this.t * 1.6 + b.ph)), 6) * 0.75
    // Factory tower: lift cores travel the tubes, bay arms weld, neon bands pulse.
    for (const l of this.lifts) l.o.position.y = l.lo + (Math.sin(this.t * 0.6 + l.ph) * 0.5 + 0.5) * (l.hi - l.lo)
    for (const a of this.towerArms) {
      a.pivot.rotation.x = Math.sin(this.t * 2.2 + a.ph) * 0.4 - 0.2
      a.elbow.rotation.x = Math.sin(this.t * 3.3 + a.ph) * 0.5
      a.sparkMat.opacity = Math.max(0, Math.sin(this.t * 17 + a.ph)) * 0.9
      a.spark.scale.setScalar(1 + a.sparkMat.opacity)
    }
    for (let i = 0; i < this.towerStripMats.length; i++) this.towerStripMats[i].opacity = 0.6 + Math.sin(this.t * 2.4 + i) * 0.3
    // Forge pistons pump.
    for (const p of this.forgePistons) p.o.position.y = p.base + Math.sin(this.t * 3 + p.ph) * 0.8
    // Gantry trolley tracks back and forth over the line; welder flares as it works.
    if (this.gTrolley && this.gWeldMat && this.gWeld) {
      const cx = (this.beltX0 + this.beltX1) / 2
      const tx = cx + Math.sin(this.t * 0.55) * (this.lenX / 2 - 2)
      this.gTrolley.position.x = tx
      const work = Math.max(0, Math.sin(this.t * 16))
      this.gWeldMat.opacity = work * 0.95
      this.gWeld.scale.setScalar(1 + work * 1.4)
    }
    // Scanner plane sweeps up and down the arch.
    if (this.scan && this.scanMat) {
      this.scan.position.y = 1.6 + (Math.sin(this.t * 1.3) * 0.5 + 0.5) * 6
      this.scanMat.opacity = 0.25 + Math.sin(this.t * 6) * 0.12
    }
    for (const c of this.cargo) { c.o.position.y = c.baseY + Math.sin(this.t * 1.2 + c.ph) * 0.3; c.o.rotation.y += 0.2 * dt }
    for (const d of this.drones) {
      d.a += d.sp * dt
      const cz = this.beltZ * 0.4
      d.g.position.set(Math.cos(d.a) * d.r, d.h + Math.sin(this.t * 1.5 + d.a) * 1.3, cz + Math.sin(d.a) * d.r)
      d.g.rotation.y = -d.a
      for (const r of d.rotors) r.rotation.z += dt * 40
    }
    // Launching rockets: idle -> ignite -> blast off on a staggered loop.
    const CYCLE = 13, IGNITE = 4.2, LIFT = 5.8
    for (const r of this.rockets) {
      r.t += dt
      if (r.t > CYCLE) { r.t -= CYCLE; r.y = 0; r.vy = 0 }
      let flame = 0, shake = 0, smoke = 0
      if (r.t < IGNITE) { flame = 0; r.y = 0 }
      else if (r.t < LIFT) { const f = (r.t - IGNITE) / (LIFT - IGNITE); flame = f; shake = f * 0.14; smoke = f }
      else { r.vy += 17 * dt; r.y += r.vy * dt; flame = 1; smoke = Math.max(0, 1 - (r.t - LIFT) * 0.5) }
      const flick = 0.7 + Math.abs(Math.sin(this.t * 38 + r.ph)) * 0.3
      r.flameMat.opacity = flame * flick * 0.95
      r.flame.scale.set(1, (0.85 + flame * 0.7) * flick, 1)
      r.glowMat.opacity = flame * 0.5 * flick
      r.smokeMat.opacity = smoke * 0.55
      r.g.position.set(r.bx + (Math.random() - 0.5) * shake, r.y, r.bz + (Math.random() - 0.5) * shake)
    }
    this.arrowMat.opacity = 0.5 + Math.sin(this.t * 4) * 0.35
    for (let i = 0; i < this.arrowChevs.length; i++) this.arrowChevs[i].position.y = 6 - i * 2.3 - ((this.t * 3 + i) % 1) * 0.6

    const ledgeZ = this.radius - 2
    const lenX = this.lenX
    for (const u of this.units) {
      if (u.state === 'build') {
        u.x += (lenX / 5) * dt
        const f = THREE.MathUtils.clamp((u.x - this.beltX0) / lenX, 0, 1)
        u.parts[0].visible = true
        u.parts[1].visible = u.parts[2].visible = f > 0.15
        u.parts[3].visible = f > 0.38
        u.parts[4].visible = u.parts[5].visible = f > 0.58
        u.parts[6].visible = f > 0.78
        u.bodyMat.emissiveIntensity = 0.25 + f * 0.4 // "powers up" as it's assembled
        u.g.rotation.y = Math.PI / 2 // face along the belt (+x)
        if (u.wheel) u.wheel.rotation.x -= dt * 2.2
        u.g.position.set(u.x, 0.9, this.beltZ + u.lane)
        if (u.x >= this.beltX1) {
          for (const p of u.parts) p.visible = true; u.bodyMat.emissiveIntensity = 0.55
          u.z = this.beltZ + u.lane
          // Fresh off the line: most stroll out across the deck first (so you see
          // robots milling around), then head to the ledge and dive.
          if (Math.random() < 0.35) this.headToEdge(u)
          else { const w = this.wanderPoint(); u.tx = w.x; u.tz = w.z; u.state = 'wander'; u.wait = 0.4 + Math.random() * 1.2 }
        }
      } else if (u.state === 'wander' || u.state === 'edge') {
        const tx = u.tx
        const tz = u.state === 'edge' ? ledgeZ : u.tz
        const dx = tx - u.x, dz = tz - u.z, d = Math.hypot(dx, dz) || 1
        if (d > 0.4) {
          u.x += (dx / d) * u.v * dt; u.z += (dz / d) * u.v * dt
          u.g.rotation.y = Math.atan2(dx, dz)
          if (u.kind === 'roller') {
            if (u.wheel) u.wheel.rotation.x -= u.v * dt * 1.7
            u.g.position.set(u.x, 0, u.z)
          } else {
            const sw = Math.sin(this.t * 8 + u.ph) * 0.5; u.legL.rotation.x = sw; u.legR.rotation.x = -sw
            u.g.position.set(u.x, Math.abs(Math.sin(this.t * 8 + u.ph)) * 0.06, u.z)
          }
        } else if (u.state === 'edge') {
          u.state = 'fall'; u.fallT = 0
        } else {
          if (u.kind === 'biped') { u.legL.rotation.x = 0; u.legR.rotation.x = 0 }
          u.wait -= dt
          u.g.position.set(u.x, 0, u.z)
          if (u.wait <= 0) {
            if (Math.random() < 0.85) this.headToEdge(u)
            else { const w = this.wanderPoint(); u.tx = w.x; u.tz = w.z; u.wait = 0.4 + Math.random() * 1.2 }
          }
        }
      } else {
        u.fallT += dt
        u.z += u.v * dt
        u.g.position.set(u.x, -0.5 * 9.8 * u.fallT * u.fallT * 0.6, u.z)
        u.g.rotation.x = Math.min(Math.PI / 2, u.fallT * 2.2)
        const o = Math.max(0, 1 - u.fallT * 0.8); u.bodyMat.opacity = o; u.headMat.opacity = o
        if (u.fallT > 2) this.respawnUnit(u, this.beltX0)
      }
    }
  }

  colliderBoxes(): THREE.Box3[] {
    const cx = (this.beltX0 + this.beltX1) / 2
    // Assembly building footprint (must match buildAssemblyHangar): spans +/-HW on
    // x, depth on z centred at beltZ. The two solid side walls are colliders; the
    // front + back are open archways you walk through, so they're left clear.
    const HW = 22, depth = 26, roofY = 16
    const Z = this.beltZ
    return [
      // The conveyor line: a low solid bar so you can't clip the belt + arms.
      this.worldBox(cx, 1.6, Z, this.lenX / 2 + 1.5, 1.8, 5.5),
      // Solid side walls (full building height) so you can't walk through the sides.
      this.worldBox(-HW, roofY / 2, Z, 0.9, roofY / 2, depth / 2),
      this.worldBox(HW, roofY / 2, Z, 0.9, roofY / 2, depth / 2),
    ]
  }

  private worldBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): THREE.Box3 {
    const box = new THREE.Box3(); const v = new THREE.Vector3()
    for (let i = 0; i < 8; i++) { v.set(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz)); v.applyMatrix4(this.group.matrixWorld); box.expandByPoint(v) }
    return box
  }

  /** Left the deck - off the edge of the (circular) floor, which the collider and
   *  this test now share a radius with, so there's no invisible lip to walk on. */
  steppedOff(x: number, y: number, z: number): boolean {
    const d = Math.hypot(x - this.center.x, z - this.center.z)
    if (d <= this.radius - 3) return false
    return y < this.topY - 1.5 || d > this.radius + 6
  }

  private deckTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 256
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#0e1626'; ctx.fillRect(0, 0, 256, 256)
    ctx.strokeStyle = 'rgba(20,40,70,0.9)'; ctx.lineWidth = 4
    for (let i = 0; i <= 256; i += 64) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke() }
    ctx.strokeStyle = 'rgba(39,231,255,0.22)'; ctx.lineWidth = 1.5
    for (let i = 0; i <= 256; i += 32) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke() }
    ctx.fillStyle = 'rgba(39,231,255,0.06)'
    for (const [px, py] of [[32, 96], [160, 32], [192, 192], [64, 192]]) ctx.fillRect(px, py, 60, 60)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(6, 6)
    return tex
  }

  private screenTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 160
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#04101a'; ctx.fillRect(0, 0, 256, 160)
    ctx.strokeStyle = '#27e7ff'; ctx.lineWidth = 2; ctx.strokeRect(8, 8, 240, 144)
    ctx.strokeStyle = '#9dff5a'; ctx.lineWidth = 3
    ctx.strokeRect(110, 40, 36, 44)
    ctx.strokeRect(116, 18, 24, 20)
    ctx.beginPath(); ctx.moveTo(110, 50); ctx.lineTo(92, 70); ctx.moveTo(146, 50); ctx.lineTo(164, 70); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(120, 84); ctx.lineTo(120, 112); ctx.moveTo(136, 84); ctx.lineTo(136, 112); ctx.stroke()
    ctx.fillStyle = '#27e7ff'; ctx.font = '700 16px monospace'; ctx.fillText('UNIT BUILD', 20, 30); ctx.fillText('OK', 200, 140)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private smokeTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128
    const ctx = cv.getContext('2d')!
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(0.5, 'rgba(210,220,235,0.35)'); g.addColorStop(1, 'rgba(210,220,235,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  private signTex(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 384
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#070b14'; ctx.fillRect(0, 0, 1024, 384)
    ctx.fillStyle = 'rgba(39,231,255,0.05)'; for (let y = 0; y < 384; y += 6) ctx.fillRect(0, y, 1024, 2)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#ff2bd0'; ctx.shadowBlur = 30; ctx.fillStyle = '#ff2bd0'
    ctx.font = '900 150px ui-monospace, Menlo, monospace'; ctx.fillText('DROP ZONE', 512, 150)
    ctx.shadowColor = '#27e7ff'; ctx.shadowBlur = 18; ctx.fillStyle = '#bfefff'
    ctx.font = '800 62px ui-monospace, Menlo, monospace'; ctx.fillText('STEP OFF TO SKYDIVE  ▼', 512, 285)
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  dispose() {
    this.group.parent?.remove(this.group)
    this.collider.parent?.remove(this.collider)
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.texs.forEach((t) => t.dispose())
  }
}
