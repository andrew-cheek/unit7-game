import * as THREE from 'three'
import { clamp } from './utils'
import { config } from './config'
import { createRobot, createRocket, createSpaceship, type RobotModel, type VehicleModel } from './procedural'
import type { Input } from './Input'

/** Live readout for the drop HUD: altimeter, speed, phase + contextual hint. */
export interface DropHud {
  alt: number
  speed: number
  phase: 'dive' | 'canopy' | 'land' | 'crash'
  hint: string | null
  canDeploy: boolean // the chute can be popped now (drives the DEPLOY button)
  canTrick: boolean // flips + fireworks available (drives the TRICK button)
  result: string | null
  place: string | null // live race placement vs the rival skydivers, e.g. "3/10"
}

// You start very high and fall the whole way down, steering the dive (tuck to
// plunge, flare to slow + hang) toward a beacon-marked destination, optionally
// clipping floating target orbs on the way. Pop the canopy in time and glide it
// down; leave it too late and you smash into pieces - then a helper bot zips in
// and reassembles you on the spot.
const START_Y = 1320 // begin far above the city (a long, high opening drop)
const TERM_DIVE = -88 // fall speed at a full nose-dive (forward all the way)
const TERM_FLARE = -30 // fall speed flared right back; the dive lerps between these
const DEPLOY_REF_ALT = 260 // reference height for canopy-quality scaling (not a cap - deploy anytime)

/**
 * The playable opening: a high-altitude dive. You spawn nearly a kilometre up
 * and fall the whole way, steering the freefall (hold Space / drag forward to
 * tuck into a fast plunge; pull back to flare and hang) toward a beacon over the
 * destination, with optional target orbs to thread for a bonus. Pop the canopy
 * while you still have altitude and glide it down - you take control on foot
 * exactly where you touch down. Hit the ground without a chute and you shatter,
 * then a repair drone reassembles you. Reads as gameplay, not a cutscene.
 */
export class DropIn {
  readonly group = new THREE.Group()
  done = false
  fade = 0
  /** 0..1 how much altitude you had on canopy deploy (drives the reward). */
  chuteQuality = 0
  /** Optional target orbs threaded on the way down (small bonus). */
  bonusTargets = 0
  /** True if you hit the ground without a chute (crash + repair). */
  crashed = false
  /** Set when you fly through one of the floating destination portals on the way
   *  down; Game routes the handoff (zone travel for mars/moon, spawn for the
   *  others). Null = a normal touchdown in the city. */
  chosenDest: 'arcade' | 'mars' | 'moon' | 'city' | null = null
  /** Where you ended up - the handoff places the player here. */
  readonly landingPos = new THREE.Vector3()
  hud: DropHud = { alt: START_Y, speed: 0, phase: 'dive', hint: null, canDeploy: false, canTrick: false, result: null, place: null }
  /** Flips + fireworks pulled on the way down (small style bonus). */
  tricks = 0

  /** Fired on a target-orb pass, the canopy pop, and touchdown/crash, for SFX. */
  onSfx: ((kind: 'ring' | 'deploy' | 'land') => void) | null = null

  private scene: THREE.Scene
  private cam: THREE.PerspectiveCamera
  private input: Input
  private getGround: (x: number, z: number) => number
  private target: THREE.Vector3
  private start: THREE.Vector3

  private rb: RobotModel
  private diver = new THREE.Group()
  private pos: THREE.Vector3
  private vy = -24
  private hVel = new THREE.Vector3()
  private camHeading = 0
  private pitch = 0.5

  private phase: DropHud['phase'] = 'dive'
  private quality = 0
  private pendingDeploy = false
  private wantCut = false // cut the canopy back to free-fall
  private resultT = 0
  private totalT = 0 // total opening time, for a safety timeout (never soft-lock)

  // Destination beacon + optional target orbs.
  private orbs: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; pos: THREE.Vector3; hit: boolean; popT: number }[] = []
  private orbCombo = 0 // consecutive boost-rings grabbed (resets if you miss a stretch)
  private orbComboT = 0 // time since the last grab (resets the combo)
  // Crash + repair.
  private crashT = 0
  private fragGeo!: THREE.BoxGeometry
  private fragMat!: THREE.MeshStandardMaterial
  private frags: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3 }[] = []
  private helper: RobotModel | null = null
  private repairBeam!: THREE.Mesh
  private impact = new THREE.Vector3()

  // y/vy drive the (recycling) VISUAL diver; raceY/raceSpd/finishedAhead are a
  // separate, non-recycling model used only for the race standings so passing a
  // rival is permanent and the placement can't flap when a visual diver loops.
  private ai: { g: THREE.Group; canopy: THREE.Mesh; chute: boolean; cx: number; cz: number; r: number; ang: number; spd: number; y: number; vy: number; raceY: number; raceSpd: number; finishedAhead: boolean }[] = []
  // Decorative air traffic (rockets + shuttles) cruising the sky as you fall.
  private traffic: { v: VehicleModel; cx: number; cz: number; r: number; ang: number; spd: number; y: number; vy: number; spin: number }[] = []
  // Floating destination portals you can steer into mid-dive.
  // x/y/z are the LIVE (animated) centre used for fly-through tests; bx/by/bz the
  // base the float animation orbits; ph a per-pad phase so they don't bob in sync.
  private platforms: { group: THREE.Group; ring: THREE.Mesh; x: number; y: number; z: number; bx: number; by: number; bz: number; ph: number; dest: 'arcade' | 'mars' | 'moon' | 'city' }[] = []
  private finishing = false
  private flipT = 0 // remaining time in a somersault (0 = not flipping)
  private static readonly FLIP_DUR = 0.7
  private chute!: THREE.Mesh
  private chuteRig!: THREE.Group // canopy + suspension cords, scaled together
  private streaks!: THREE.Points
  private streakVel!: Float32Array
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []

  // Cloud decks you punch through on the way down (a staged reveal of the city).
  private clouds: { mesh: THREE.Object3D; y: number; punched: boolean }[] = []
  private cloudTex?: THREE.Texture
  private vapor!: THREE.Mesh // pooled punch-through burst
  private vaporMat!: THREE.MeshBasicMaterial
  private vaporT = 1 // >=1 = idle
  // Sonic boom at terminal velocity.
  private boomRing!: THREE.Mesh
  private boomMat!: THREE.MeshBasicMaterial
  private boomT = 1 // >=1 = idle
  private boomCharge = 0
  private boomed = false
  // Rival race: live placement vs the other skydivers, paid out on landing.
  racePlace = 1
  raceTotal = 1
  private camShake = 0

  private camPos = new THREE.Vector3()
  private camLook = new THREE.Vector3()
  private fwd = new THREE.Vector3()

  private static readonly STEER = 60 // strong horizontal control over the long fall
  private static readonly H_DAMP = 1.4
  private static readonly H_MAX = 68

  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera, input: Input, target: THREE.Vector3, getGround: (x: number, z: number) => number) {
    this.scene = scene
    this.cam = cam
    this.input = input
    this.target = target.clone()
    this.getGround = getGround
    this.start = new THREE.Vector3(target.x + 30, START_Y, target.z - 300)
    this.pos = this.start.clone()
    this.rb = createRobot()
    this.camHeading = Math.atan2(this.target.x - this.start.x, this.target.z - this.start.z)
    this.build()
    scene.add(this.group)
    this.placeCamera(true)
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  private build() {
    this.rb.setFlyPose(1)
    this.diver.add(this.rb.group)
    this.diver.position.copy(this.pos)
    this.group.add(this.diver)

    const chuteMat = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0x27e7ff, emissiveIntensity: 1.4, roughness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.82 }))
    // Canopy + suspension cords live in one rig that scales as a unit, so the
    // whole parachute inflates together and the cords stay attached to the body.
    this.chuteRig = new THREE.Group()
    this.chuteRig.scale.setScalar(0.1)
    this.chuteRig.visible = false
    this.chute = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.9, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.2)), chuteMat)
    this.chute.position.y = 6.5
    this.chuteRig.add(this.chute)
    // Suspension cords fanning from the diver's shoulders up to the canopy rim.
    const cordMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.55, fog: false }))
    const cordGeo = this.ownG(new THREE.CylinderGeometry(0.04, 0.04, 1, 5))
    const up = new THREE.Vector3(0, 1, 0)
    const d = new THREE.Vector3()
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const rx = Math.cos(a) * 2.5, rz = Math.sin(a) * 2.5, ry = 5.1 // canopy rim
      const bx = Math.cos(a) * 0.4, bz = Math.sin(a) * 0.4, by = 2.3 // shoulders
      const cord = new THREE.Mesh(cordGeo, cordMat)
      cord.position.set((rx + bx) / 2, (ry + by) / 2, (rz + bz) / 2)
      const len = Math.hypot(rx - bx, ry - by, rz - bz)
      cord.scale.y = len
      cord.quaternion.setFromUnitVectors(up, d.set(rx - bx, ry - by, rz - bz).normalize())
      this.chuteRig.add(cord)
    }
    this.diver.add(this.chuteRig)

    // Destination beacon: a tall fog-immune pillar of light over where to land,
    // plus a ground ring, so the goal is unmistakable from altitude.
    const beamMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9dff5a, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const beam = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(2.2, 2.2, START_Y, 12, 1, true)), beamMat)
    beam.position.set(this.target.x, this.target.y + START_Y / 2, this.target.z)
    this.group.add(beam)
    const ringMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9dff5a, transparent: true, opacity: 0.8, fog: false }))
    const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(7, 0.5, 10, 36)), ringMat)
    ring.rotation.x = Math.PI / 2
    ring.position.set(this.target.x, this.target.y + 0.6, this.target.z)
    this.group.add(ring)

    // Boost-ring ribbon: a long snaking line of glowing rings down the descent
    // that you weave left/right to thread. Grabbing them chains a combo (paid out
    // as a bonus on landing) and gives the long dive a constant "collect + steer"
    // goal. They sit on the central approach so going for a side portal is the
    // trade-off (rings vs a chosen destination).
    const orbMatBase = { transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending as THREE.Blending, depthWrite: false, fog: false }
    const orbGeo = this.ownG(new THREE.TorusGeometry(4.2, 0.7, 10, 28))
    const orbColors = [0x27e7ff, 0xff2bd0, 0xffd24a, 0x9dff5a]
    const N_ORB = 16
    for (let i = 0; i < N_ORB; i++) {
      const f = (i + 0.5) / N_ORB
      const y = THREE.MathUtils.lerp(START_Y - 40, this.target.y + 90, f)
      // Snake side-to-side so threading them is an active weave, not a straight line.
      const sway = Math.sin(f * Math.PI * 3.5) * 34
      const x = THREE.MathUtils.lerp(this.start.x, this.target.x, f) + sway
      const z = THREE.MathUtils.lerp(this.start.z, this.target.z, f)
      const mat = this.own(new THREE.MeshBasicMaterial({ color: orbColors[i % orbColors.length], ...orbMatBase }))
      const mesh = new THREE.Mesh(orbGeo, mat)
      mesh.position.set(x, y, z)
      mesh.rotation.x = Math.PI / 2 // lie flat-ish so you drop through it
      this.group.add(mesh)
      this.orbs.push({ mesh, mat, pos: new THREE.Vector3(x, y, z), hit: false, popT: 0 })
    }

    // Crash fragments + repair beam (built once, used only on a crash).
    this.fragGeo = this.ownG(new THREE.BoxGeometry(0.5, 0.5, 0.5))
    this.fragMat = this.own(new THREE.MeshStandardMaterial({ color: 0xc9d4e3, metalness: 0.6, roughness: 0.5, emissive: 0x27e7ff, emissiveIntensity: 0.4 }))
    this.repairBeam = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.25, 0.25, 1, 8, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: 0x9dff5a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    this.repairBeam.visible = false
    this.group.add(this.repairBeam)

    // Other "pilots" sharing the sky: tinted little robots, some freefalling in a
    // head-down tuck, some already gliding under a canopy. Reads as a busy jump.
    const aiBody = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3650, metalness: 0.55, roughness: 0.45 }))
    const tints = [0xff2bd0, 0x8a5cff, 0xff8a1e, 0x9dff5a, 0x27e7ff, 0xffd24a]
    const N_AI = 9
    for (let i = 0; i < N_AI; i++) {
      const g = new THREE.Group()
      const torso = new THREE.Mesh(this.ownG(new THREE.CapsuleGeometry(0.5, 1.1, 4, 8)), aiBody)
      g.add(torso)
      const col = tints[i % tints.length]
      const head = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.5, 0.5, 0.5)), this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: col, emissiveIntensity: 1.6, roughness: 0.4 })))
      head.position.y = 1.1
      g.add(head)
      // Limbs (thin boxes) so the silhouette reads as a flailing skydiver.
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(0.22, 1.0, 0.22)), aiBody)
        arm.position.set(sx * 0.6, 0.2, 0); arm.rotation.z = sx * 0.9
        g.add(arm)
      }
      const chute = i % 2 === 0 // half under canopy, half in freefall
      const canopy = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(2.8, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.1)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: false })))
      canopy.position.y = 4.0
      canopy.visible = chute
      g.add(canopy)
      // Suspension lines for the canopied ones.
      if (chute) {
        const cordMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.5, fog: false }))
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2
          const cord = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(0.04, 0.04, 3.6, 4)), cordMat)
          cord.position.set(Math.cos(a) * 1.2, 2.2, Math.sin(a) * 1.2)
          cord.rotation.z = Math.cos(a) * 0.4; cord.rotation.x = Math.sin(a) * 0.4
          g.add(cord)
        }
      }
      const cx = this.start.x + (Math.random() - 0.5) * 220
      const cz = this.start.z * 0.5 + (Math.random() - 0.5) * 260
      const y = this.target.y + 120 + Math.random() * 620
      g.position.set(cx, y, cz)
      if (!chute) g.rotation.x = 1.2 // head-down tuck
      this.group.add(g)
      this.ai.push({ g, canopy, chute, cx, cz, r: 5 + Math.random() * 16, ang: Math.random() * 6.28, spd: 0.15 + Math.random() * 0.35, y, vy: chute ? 10 + Math.random() * 8 : 42 + Math.random() * 30, raceY: START_Y - Math.random() * 120, raceSpd: 32 + Math.random() * 40, finishedAhead: false })
    }

    const NF = 130
    const fp = new Float32Array(NF * 3)
    this.streakVel = new Float32Array(NF)
    for (let i = 0; i < NF; i++) {
      fp[i * 3] = (Math.random() - 0.5) * 16
      fp[i * 3 + 1] = (Math.random() - 0.5) * 24
      fp[i * 3 + 2] = (Math.random() - 0.5) * 16
      this.streakVel[i] = 20 + Math.random() * 22
    }
    const fg = this.ownG(new THREE.BufferGeometry())
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3))
    this.streaks = new THREE.Points(fg, this.own(new THREE.PointsMaterial({ color: 0xdff1ff, size: 0.1, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })))
    this.streaks.frustumCulled = false
    this.group.add(this.streaks)

    this.buildTraffic()
    this.buildPlatforms()
    this.buildClouds()

    // Pooled punch-through vapor burst (cloud decks) - one reused sphere.
    this.vaporMat = this.own(new THREE.MeshBasicMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.vapor = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(1, 16, 12)), this.vaporMat)
    this.vapor.visible = false
    this.vapor.frustumCulled = false
    this.group.add(this.vapor)

    // Pooled sonic-boom shockwave ring.
    this.boomMat = this.own(new THREE.MeshBasicMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.boomRing = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(1, 0.08, 8, 40)), this.boomMat)
    this.boomRing.visible = false
    this.boomRing.frustumCulled = false
    this.group.add(this.boomRing)
  }

  /** A few soft cloud decks stacked down the descent. You punch through each one
   *  (vapor burst + shudder) so the long fall is staged: clear sky, into the
   *  cloud layers, then the city opens up below. */
  private buildClouds() {
    // Radial soft-white puff texture, reused across all puffs.
    const cv = document.createElement('canvas')
    cv.width = 128; cv.height = 128
    const ctx = cv.getContext('2d')!
    const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    grad.addColorStop(0, 'rgba(255,255,255,0.9)')
    grad.addColorStop(0.5, 'rgba(225,238,255,0.5)')
    grad.addColorStop(1, 'rgba(225,238,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 128, 128)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    this.cloudTex = tex
    // Faint so they read as thin layers you punch through, not constant haze.
    const puffMat = this.own(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.32, depthWrite: false, fog: false }))
    // Three thin decks between the start and the city.
    const bands = [0.74, 0.52, 0.3]
    for (const b of bands) {
      const y = THREE.MathUtils.lerp(this.target.y + 120, START_Y - 80, b)
      const deck = new THREE.Group()
      // A ring of puffs around the descent corridor (leaving the centre clearer),
      // kept as a thin band so it doesn't grey out the whole view.
      const n = config.tier.name === 'low' ? 6 : 9
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + b * 3
        const r = 110 + Math.random() * 260
        const s = 150 + Math.random() * 160
        const puff = new THREE.Sprite(puffMat)
        puff.position.set(Math.cos(a) * r, (Math.random() - 0.5) * 18, Math.sin(a) * r)
        puff.scale.set(s, s * 0.6, 1)
        deck.add(puff)
      }
      deck.position.set(this.target.x, y, this.target.z)
      this.group.add(deck)
      this.clouds.push({ mesh: deck, y, punched: false })
    }
  }

  /** Rockets + shuttles cruising the sky around the drop, so the air feels busy
   *  on the way down. Each circles a slow loop and climbs/falls gently. */
  private buildTraffic() {
    const specs: Array<['rocket' | 'ship', number]> = [
      ['rocket', 1.4], ['rocket', 2.0], ['rocket', 1.1], ['rocket', 1.7],
      ['ship', 1.0], ['ship', 1.0], ['ship', 1.0], ['ship', 1.0],
    ]
    for (let i = 0; i < specs.length; i++) {
      const [kind, scale] = specs[i]
      const v = kind === 'rocket'
        ? createRocket({ scale, flaps: true, hull: 0xd8dee8, accent: i % 2 ? 0xff4d6d : 0x27e7ff })
        : createSpaceship()
      const cx = this.start.x + (Math.random() - 0.5) * 320
      const cz = this.start.z * 0.4 + (Math.random() - 0.5) * 320
      const y = this.target.y + 120 + Math.random() * 460
      v.group.position.set(cx, y, cz)
      if (kind === 'ship') v.group.scale.setScalar(1.6)
      this.group.add(v.group)
      this.traffic.push({ v, cx, cz, r: 40 + Math.random() * 80, ang: Math.random() * 6.28, spd: 0.12 + Math.random() * 0.22, y, vy: (Math.random() - 0.5) * 6, spin: kind === 'rocket' ? 0 : 0.4 })
    }
  }

  /** Four floating ringed platforms spread across the descent. Steer through one
   *  to pick where you come down: the open city, the arcade, Mars, or the Moon. */
  private buildPlatforms() {
    const C = { city: 0x27e7ff, arcade: 0xff2bd0, mars: 0xff8a1e, moon: 0xbfe6ff }
    const labels: Record<string, string> = { city: 'CITY', arcade: 'ARCADE', mars: 'MARS', moon: 'MOON' }
    // Two pads per destination, spread wide on a ring around the descent at big
    // staggered altitudes - so they're easy to spot, you commit to one (they're
    // not clustered), and there's always a backup of each. The jetpack lets you
    // climb to the high ones. Pulled closer to the descent line + higher up so you
    // pass right by them. [dest, angle, ring radius, altitude]
    const defs: Array<['city' | 'arcade' | 'mars' | 'moon', number, number, number]> = [
      ['moon', 0.4, 130, 320],
      ['mars', 1.2, 200, 280],
      ['city', 2.0, 150, 470],
      ['arcade', 2.9, 230, 380],
      ['moon', 3.7, 180, 660],
      ['mars', 4.4, 140, 560],
      ['city', 5.1, 240, 770],
      ['arcade', 5.9, 160, 500],
    ]
    for (const [dest, ang, rad, alt] of defs) {
      const col = C[dest]
      const x = this.target.x + Math.cos(ang) * rad
      const z = this.target.z + Math.sin(ang) * rad
      const y = this.getGround(x, z) + alt
      const group = new THREE.Group()
      group.position.set(x, y, z)
      // Huge landing disk.
      const disk = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(30, 31, 1.4, 44)), this.own(new THREE.MeshStandardMaterial({ color: 0x0a0d16, emissive: col, emissiveIntensity: 1.8, roughness: 0.5, metalness: 0.4 })))
      group.add(disk)
      const rim = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(30, 1.3, 8, 52)), this.own(new THREE.MeshBasicMaterial({ color: col, fog: false })))
      rim.rotation.x = Math.PI / 2
      group.add(rim)
      // Big upright portal ring you fly through.
      const ring = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(24, 2.2, 16, 52)), this.own(new THREE.MeshBasicMaterial({ color: col, fog: false })))
      ring.position.y = 20
      group.add(ring)
      const disc = new THREE.Mesh(this.ownG(new THREE.CircleGeometry(23, 44)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.32, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      disc.position.y = 20
      group.add(disc)
      // A fat pillar of light spearing UP into the sky from the pad (and a bit
      // below it), so each platform reads as a beam coming down from the sky and
      // is unmistakable from anywhere in the dive.
      const beam = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(7, 7, 1100, 16, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      beam.position.y = 520 // mostly above the pad, reaching into the sky
      group.add(beam)
      // Big floating label above the ring.
      const sprite = this.labelSprite(labels[dest], col)
      sprite.position.set(0, 40, 0)
      sprite.scale.set(44, 16, 1)
      group.add(sprite)
      this.group.add(group)
      this.platforms.push({ group, ring, x, y, z, bx: x, by: y, bz: z, ph: ang * 1.7, dest })
    }
  }

  /** A neon text billboard sprite for the platform labels. */
  private labelSprite(text: string, color: number): THREE.Sprite {
    const cv = document.createElement('canvas')
    cv.width = 256; cv.height = 96
    const ctx = cv.getContext('2d')!
    ctx.font = '800 56px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = '#' + color.toString(16).padStart(6, '0')
    ctx.shadowBlur = 18
    ctx.fillStyle = '#eaf6ff'
    ctx.fillText(text, 128, 48)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
    sprite.scale.set(9, 3.4, 1)
    this.mats.push(sprite.material)
    return sprite
  }

  /** Called by the DEPLOY button / a screen tap. Only arms once low enough. */
  deploy() {
    // Context action: in free-fall it pops the chute (any altitude); under canopy
    // it CUTS the chute and drops you back into the dive.
    if (this.phase === 'dive') this.pendingDeploy = true
    else if (this.phase === 'canopy') this.wantCut = true
  }

  /** FLIP button / key: a mid-air somersault (small style bonus). */
  trick() {
    if (this.done || this.finishing || this.phase === 'crash' || this.phase === 'land') return
    if (this.flipT <= 0) this.flipT = DropIn.FLIP_DUR
    this.tricks++
    this.onSfx?.('ring')
  }

  private cutCanopy() {
    this.phase = 'dive'
    this.chuteRig.visible = false
    this.chuteRig.scale.setScalar(0.1)
    this.rb.setFlyPose(1)
    this.hud.result = null
    this.wantCut = false
    this.pendingDeploy = false // clear any stale arm so we don't instantly re-pop
  }

  skip() {
    if (this.done) return
    this.pos.copy(this.target).setY(this.target.y + 0.4)
    this.vy = -2
    this.hVel.set(0, 0, 0)
    this.landingPos.copy(this.target)
    this.phase = 'land'
  }

  update(dt: number) {
    if (this.done) return
    // Safety: the opening should finish in ~25s; if anything stalls it, force a
    // clean handoff so the player is never trapped in the drop-in forever.
    this.totalT += dt
    if (this.totalT > 72) {
      this.landingPos.set(this.pos.x, this.getGround(this.pos.x, this.pos.z), this.pos.z)
      this.fade = 1
      this.done = true
      return
    }
    if (this.phase === 'crash') { this.updateCrash(dt); return }
    // Flew through a destination portal: fade out and hand off (Game routes it).
    if (this.finishing) {
      this.updateTraffic(dt)
      this.fade = clamp(this.fade + dt * 2, 0, 1)
      this.placeCamera(false)
      if (this.fade >= 1) this.done = true
      return
    }

    const ground = this.getGround(this.pos.x, this.pos.z)
    const alt = this.pos.y - ground

    const chute = this.input.consumeEdge('chute')
    if (chute) {
      if (this.phase === 'dive') this.pendingDeploy = true // deploy at any altitude
      else if (this.phase === 'canopy') this.wantCut = true // cut back to free-fall
    }
    if (this.wantCut && this.phase === 'canopy') this.cutCanopy()
    // FLIP (H / button): a somersault that kicks the board away.
    if (this.input.consumeEdge('net')) this.trick()
    if (this.flipT > 0) this.flipT = Math.max(0, this.flipT - dt)

    // --- horizontal steering (camera-relative) ---
    const yaw = this.input.yaw
    const controlScale = this.phase === 'canopy' ? 0.6 + this.quality * 0.4 : 1
    const ax = (-Math.cos(yaw) * this.input.moveX + Math.sin(yaw) * this.input.moveY) * DropIn.STEER * controlScale
    const az = (Math.sin(yaw) * this.input.moveX + Math.cos(yaw) * this.input.moveY) * DropIn.STEER * controlScale
    this.hVel.x += ax * dt
    this.hVel.z += az * dt

    if (this.phase === 'canopy') {
      // Gentle pull toward the beacon so a flailing drop still ends near the
      // plaza - but light enough that you mostly land where you steer.
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z
      const d = Math.hypot(dx, dz) || 1
      const assist = 5
      this.hVel.x += (dx / d) * assist * dt
      this.hVel.z += (dz / d) * assist * dt
    }
    const damp = Math.exp(-DropIn.H_DAMP * dt)
    this.hVel.x *= damp
    this.hVel.z *= damp
    const hs = Math.hypot(this.hVel.x, this.hVel.z)
    const hMax = this.phase === 'canopy' ? 32 : DropIn.H_MAX
    if (hs > hMax) { this.hVel.x *= hMax / hs; this.hVel.z *= hMax / hs }

    // --- phase machine ---
    if (this.phase === 'dive') {
      if (this.input.held.jet) {
        // Jetpack while falling: thrust upward toward the cruise cap so you can
        // arrest the fall, hover, or even climb to line up a high portal pad.
        const cap = config.jetpack.maxAscend
        const rate = config.jetpack.thrust * dt
        this.vy = this.vy < cap ? Math.min(this.vy + rate, cap) : Math.max(this.vy - rate, cap)
        this.pitch += (0 - this.pitch) * Math.min(1, dt * 4) // upright jet pose
      } else {
        // Continuous dive: the further you push forward, the steeper the robot
        // faces down AND the faster it falls; pulling back flattens out and slows.
        // moveY -1..1 maps straight to a 0..1 dive amount (0.5 = hands-off neutral).
        const diveAmt = clamp(0.5 + this.input.moveY * 0.5, 0, 1)
        this.pitch += (diveAmt - this.pitch) * Math.min(1, dt * 3.5)
        const term = TERM_FLARE + (TERM_DIVE - TERM_FLARE) * diveAmt
        this.vy += (term - this.vy) * Math.min(1, dt * 1.6)
      }

      this.checkOrbs(dt)

      if (this.pendingDeploy) {
        this.pendingDeploy = false // consume the arm so a later CUT isn't re-popped
        this.quality = clamp((alt - 40) / (DEPLOY_REF_ALT - 40), 0.3, 1)
        this.chuteQuality = this.quality
        this.hud.result = this.quality >= 0.78 ? 'CLEAN CANOPY' : this.quality >= 0.5 ? 'CANOPY OPEN' : 'HARD OPEN'
        this.phase = 'canopy'
        this.chuteRig.visible = true
        this.rb.setFlyPose(0.2)
        this.onSfx?.('deploy')
        this.vy *= 0.5
      } else if (alt <= 2) {
        this.beginCrash(ground)
        return
      }
    } else if (this.phase === 'canopy') {
      const want = -THREE.MathUtils.lerp(16, 9, this.quality)
      this.vy += (want - this.vy) * Math.min(1, dt * 2.5)
      this.chuteRig.scale.setScalar(THREE.MathUtils.damp(this.chuteRig.scale.x, 1, 6, dt))
      this.pitch += (0 - this.pitch) * Math.min(1, dt * 3)
      if (alt <= 1.5) { this.phase = 'land'; this.landingPos.set(this.pos.x, ground, this.pos.z) }
    } else {
      // land: settle straight down where you are - no relocation.
      this.vy += (-2 - this.vy) * Math.min(1, dt * 4)
    }

    // integrate
    this.pos.x += this.hVel.x * dt
    this.pos.z += this.hVel.z * dt
    this.pos.y += this.vy * dt

    this.diver.position.copy(this.pos)
    if (hs > 0.5) this.camHeading = Math.atan2(this.hVel.x, this.hVel.z)
    const diving = this.phase === 'dive'
    // Pressing forward tips the robot well past horizontal into a steep head-down
    // dive; flaring brings it near upright. (0 = upright, ~1.6 = past face-down.)
    const bodyPitch = diving ? THREE.MathUtils.lerp(0.1, 1.6, this.pitch) : 0
    const flip = this.flipT > 0 ? (1 - this.flipT / DropIn.FLIP_DUR) * Math.PI * 2 : 0
    this.diver.rotation.set(bodyPitch + flip, this.camHeading, clamp(-this.hVel.x * 0.02, -0.5, 0.5))
    // Arms react to steering: sweep back when diving forward, spread when flaring,
    // and bank asymmetrically when steering left/right.
    this.rb.setSteer?.(this.input.moveX, this.input.moveY)
    this.rb.setThrust(this.phase === 'dive' && this.input.held.jet ? 1 : 0) // jetpack flame
    this.rb.update(dt, diving ? 0.4 : 0.15, false)

    this.updateAi(dt)
    this.updateTraffic(dt)
    if (this.phase === 'dive' || this.phase === 'canopy') this.checkPlatforms()
    this.updateStreaks(dt, diving)
    this.updateSkyFx(dt)
    this.placeCamera(false)

    this.hud.alt = Math.max(0, alt)
    this.hud.speed = Math.hypot(hs, this.vy)
    this.hud.phase = this.phase
    this.hud.canDeploy = this.phase === 'dive'
    this.hud.canTrick = this.phase === 'dive' || this.phase === 'canopy'
    this.hud.hint = this.phase === 'canopy' ? 'STEER TO A PORTAL OR THE BEACON'
      : this.phase === 'land' ? 'TOUCHDOWN'
      : 'STEER · SPACE = JETPACK · DEPLOY ANYTIME'
    if (this.hud.result) { this.resultT += dt; if (this.resultT > 2.2) this.hud.result = null }

    if (this.phase === 'land' && alt <= 0.6) {
      if (this.fade === 0) { this.onSfx?.('land'); this.landingPos.set(this.pos.x, this.getGround(this.pos.x, this.pos.z), this.pos.z) }
      this.fade = clamp(this.fade + dt * 2.2, 0, 1)
      if (this.fade >= 1) this.done = true
    }
  }

  /** Optional target orbs: clipping one pops it, plays a chime, banks a bonus. */
  private checkOrbs(dt: number) {
    // The combo decays if you go a while without grabbing a ring.
    this.orbComboT += dt
    if (this.orbComboT > 2.2) this.orbCombo = 0
    for (const o of this.orbs) {
      if (o.hit) {
        // Collect pop: flash bigger + fade, then hide.
        if (o.popT < 1) {
          o.popT = Math.min(1, o.popT + dt * 4)
          o.mesh.scale.setScalar(1 + o.popT * 1.8)
          o.mat.opacity = 0.95 * (1 - o.popT)
          if (o.popT >= 1) o.mesh.visible = false
        }
        continue
      }
      o.mesh.rotation.z += dt * 1.6
      if (Math.abs(this.pos.y - o.pos.y) < 7) {
        const d = Math.hypot(this.pos.x - o.pos.x, this.pos.z - o.pos.z)
        if (d < 7) {
          o.hit = true
          this.bonusTargets++
          this.orbCombo++
          this.orbComboT = 0
          this.onSfx?.('ring')
          // Show the running boost-ring combo (transient) unless a more important
          // result (canopy/portal) is already on screen.
          if (!this.hud.result || this.hud.result.startsWith('BOOST')) {
            this.hud.result = `BOOST x${this.orbCombo}`
            this.resultT = 0
          }
        }
      }
    }
  }

  // --- crash + repair -------------------------------------------------------

  private beginCrash(ground: number) {
    this.crashed = true
    this.phase = 'crash'
    this.crashT = 0
    this.impact.set(this.pos.x, ground, this.pos.z)
    this.landingPos.copy(this.impact)
    this.diver.visible = false
    this.onSfx?.('land')
    this.hud.phase = 'crash'
    this.hud.result = 'SMASHED!'
    this.hud.hint = 'REASSEMBLING…'
    this.hud.canDeploy = false
    // Scatter fragments from the impact.
    for (let i = 0; i < 14; i++) {
      const mesh = new THREE.Mesh(this.fragGeo, this.fragMat)
      mesh.position.set(this.impact.x, this.impact.y + 1, this.impact.z)
      mesh.scale.setScalar(0.6 + Math.random())
      const a = Math.random() * 6.28
      const sp = 4 + Math.random() * 7
      this.frags.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * sp, 6 + Math.random() * 6, Math.sin(a) * sp),
        spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      })
      this.group.add(mesh)
    }
    // A repair drone (small robot) drops in from above-beside the wreck.
    this.helper = createRobot({ trim: 0x9dff5a, accent: 0x9dff5a })
    this.helper.group.scale.setScalar(0.5)
    this.helper.group.position.set(this.impact.x + 8, this.impact.y + 34, this.impact.z - 8)
    this.helper.setFlyPose(1)
    this.group.add(this.helper.group)
    this.repairBeam.visible = false
  }

  private updateCrash(dt: number) {
    this.crashT += dt
    const t = this.crashT

    // Fragments fly out + fall, then converge back and shrink as you're rebuilt.
    for (const f of this.frags) {
      if (t < 1.1) {
        f.vel.y -= 26 * dt
        f.mesh.position.addScaledVector(f.vel, dt)
        if (f.mesh.position.y < this.impact.y + 0.25) { f.mesh.position.y = this.impact.y + 0.25; f.vel.y *= -0.35; f.vel.x *= 0.6; f.vel.z *= 0.6 }
        f.mesh.rotation.x += f.spin.x * dt; f.mesh.rotation.y += f.spin.y * dt
      } else {
        const k = Math.min(1, (t - 1.1) / 1.0)
        f.mesh.position.lerp(this.impact, k * 0.2)
        f.mesh.scale.multiplyScalar(Math.max(0.0001, 1 - dt * 2.2))
        f.mesh.rotation.y += f.spin.y * dt * 0.5
      }
    }

    // Helper descends to hover over the wreck, then beams a repair.
    if (this.helper) {
      const h = this.helper.group
      const hoverY = this.impact.y + 5
      h.position.x = THREE.MathUtils.damp(h.position.x, this.impact.x + 2.2, 4, dt)
      h.position.z = THREE.MathUtils.damp(h.position.z, this.impact.z - 2.2, 4, dt)
      h.position.y = THREE.MathUtils.damp(h.position.y, t > 2.4 ? this.impact.y + 34 : hoverY, 3, dt)
      h.lookAt(this.impact.x, this.impact.y + 1, this.impact.z)
      this.helper.setThrust(0.6)
      this.helper.update(dt, 0.2, false)
      const bm = this.repairBeam.material as THREE.MeshBasicMaterial
      if (t > 0.9 && t < 2.3) {
        this.repairBeam.visible = true
        const from = h.position, to = this.impact
        const mid = this.camPos.copy(from).lerp(to, 0.5)
        const len = from.distanceTo(to)
        this.repairBeam.position.copy(mid)
        this.repairBeam.scale.set(1, len, 1)
        this.repairBeam.lookAt(to)
        this.repairBeam.rotateX(Math.PI / 2)
        bm.opacity = 0.4 + Math.sin(t * 30) * 0.25
      } else {
        this.repairBeam.visible = false
      }
    }

    // Rebuilt: the diver pops back, standing, then we hand off.
    if (t > 2.0 && !this.diver.visible) {
      this.diver.visible = true
      this.diver.position.copy(this.impact)
      this.diver.rotation.set(0, this.camHeading, 0)
      this.rb.setFlyPose(0)
      this.diver.scale.setScalar(0.2)
    }
    if (this.diver.visible) {
      const s = THREE.MathUtils.damp(this.diver.scale.x, 1, 8, dt)
      this.diver.scale.setScalar(s)
      this.rb.update(dt, 0, true)
    }

    this.hud.alt = 0
    this.hud.speed = 0
    this.placeCamera(false)

    if (t > 2.7) {
      this.fade = clamp(this.fade + dt * 2.4, 0, 1)
      if (this.fade >= 1) this.done = true
    }
  }

  private updateAi(dt: number) {
    const floor = this.target.y + 4
    for (const a of this.ai) {
      a.ang += a.spd * dt
      a.y -= a.vy * dt
      // Race model: descend once and lock at the ground (never recycles), so a
      // rival that lands stays "ahead" and the standings can't flap.
      if (!a.finishedAhead) {
        a.raceY -= a.raceSpd * dt
        if (a.raceY <= this.target.y) { a.raceY = this.target.y; a.finishedAhead = true }
      }
      // Loop back to the top when they reach the deck so the sky stays populated.
      if (a.y < floor) { a.y = this.target.y + 560 + Math.random() * 160; a.vy = a.chute ? 10 + Math.random() * 8 : 42 + Math.random() * 30 }
      a.g.position.set(a.cx + Math.cos(a.ang) * a.r, a.y, a.cz + Math.sin(a.ang) * a.r)
      if (a.chute) {
        a.g.rotation.set(0, -a.ang, Math.sin(a.ang * 2) * 0.12) // sway under canopy
      } else {
        a.g.rotation.set(1.2, -a.ang, Math.sin(a.ang * 3) * 0.25) // head-down flail
      }
    }
  }

  /** Drift the sky traffic on slow loops and spin the platform portal rings. */
  private updateTraffic(dt: number) {
    for (const t of this.traffic) {
      t.ang += t.spd * dt
      t.y += t.vy * dt
      if (t.y < this.target.y + 90 || t.y > this.target.y + 620) t.vy = -t.vy
      t.v.group.position.set(t.cx + Math.cos(t.ang) * t.r, t.y, t.cz + Math.sin(t.ang) * t.r)
      t.v.group.rotation.y = -t.ang + Math.PI / 2
      t.v.update(dt, 0.4)
    }
    // Float the portal platforms: a wide, clearly-visible drift orbit + vertical
    // bob + slow spin, each on its own phase. The live x/y/z (used by the
    // fly-through test) track the motion so the bigger pads stay catchable.
    const pt = this.totalT
    for (const p of this.platforms) {
      p.ring.rotation.z += dt * 0.8
      p.group.rotation.y += dt * 0.25
      p.x = p.bx + Math.cos(pt * 0.32 + p.ph) * 34
      p.y = p.by + Math.sin(pt * 0.55 + p.ph) * 22
      p.z = p.bz + Math.sin(pt * 0.27 + p.ph) * 34
      p.group.position.set(p.x, p.y, p.z)
    }
  }

  /** Steered into a destination portal? Lock the destination + start the handoff. */
  private checkPlatforms() {
    for (const p of this.platforms) {
      if (Math.abs(this.pos.y - p.y) > 36) continue
      if (Math.hypot(this.pos.x - p.x, this.pos.z - p.z) < 28) {
        this.chosenDest = p.dest
        this.landingPos.set(p.x, this.getGround(p.x, p.z), p.z)
        this.finishing = true
        this.hud.result = 'PORTAL · ' + p.dest.toUpperCase()
        this.hud.hint = 'LOCKED IN'
        this.onSfx?.('deploy')
        return
      }
    }
  }

  private kick(a: number) { this.camShake = Math.min(3, this.camShake + a) }

  /** The three opening set-pieces: punch through the cloud decks, a sonic boom at
   *  terminal velocity, and the live rival-race placement. */
  private updateSkyFx(dt: number) {
    // Cloud punch-through: trigger as the diver crosses each deck downward, and
    // re-arm if you jetpack back up above it so a second descent punches again.
    for (const c of this.clouds) {
      if (c.punched) {
        if (this.pos.y > c.y + 25) c.punched = false // climbed back above: re-arm
        continue
      }
      if (this.pos.y >= c.y) continue
      c.punched = true
      this.vapor.position.copy(this.pos)
      this.vapor.visible = true
      this.vaporT = 0
      this.kick(1.1)
      this.onSfx?.('land')
    }
    if (this.vaporT < 1) {
      this.vaporT = Math.min(1, this.vaporT + dt * 2.2)
      this.vapor.position.copy(this.pos)
      this.vapor.scale.setScalar(2 + this.vaporT * 46)
      this.vaporMat.opacity = 0.7 * (1 - this.vaporT)
      if (this.vaporT >= 1) this.vapor.visible = false
    }

    // Sonic boom: hold a full nose-dive to terminal velocity and you punch a
    // shockwave. Re-arms once you slow back down.
    if (this.phase === 'dive' && this.vy < -82) {
      this.boomCharge += dt
      if (this.boomCharge > 0.5 && !this.boomed) {
        this.boomed = true
        this.boomRing.position.copy(this.pos)
        this.boomRing.rotation.x = Math.PI / 2
        this.boomRing.visible = true
        this.boomT = 0
        this.kick(1.7)
        this.onSfx?.('deploy')
        if (!this.hud.result || this.hud.result.startsWith('BOOST')) { this.hud.result = 'SONIC BOOM'; this.resultT = 0 }
      }
    } else if (this.vy > -70) {
      this.boomed = false
      this.boomCharge = 0
    }
    if (this.boomT < 1) {
      this.boomT = Math.min(1, this.boomT + dt * 1.5)
      this.boomRing.position.copy(this.pos)
      this.boomRing.scale.setScalar(2 + this.boomT * 95)
      this.boomMat.opacity = 0.7 * (1 - this.boomT)
      if (this.boomT >= 1) this.boomRing.visible = false
    }

    // Rival race: a rival is "ahead" if it already reached the ground or its race
    // altitude is still below you. You start near the top with everyone and climb
    // the standings by diving past them; passing is permanent (uses raceY, not the
    // recycling visual y).
    let ahead = 0
    for (const a of this.ai) if (a.finishedAhead || a.raceY < this.pos.y) ahead++
    this.racePlace = 1 + ahead
    this.raceTotal = this.ai.length + 1
    this.hud.place = `${this.racePlace}/${this.raceTotal}`
  }

  private updateStreaks(dt: number, fast: boolean) {
    const m = this.streaks.material as THREE.PointsMaterial
    m.opacity = THREE.MathUtils.damp(m.opacity, fast ? 0.85 : 0.3, 5, dt)
    this.streaks.position.copy(this.pos)
    const fp = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    const rise = fast ? 54 : 20
    for (let i = 0; i < this.streakVel.length; i++) {
      const j = i * 3 + 1
      fp[j] += (this.streakVel[i] + rise) * dt
      if (fp[j] > 14) fp[j] = -14
    }
    ;(this.streaks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  private placeCamera(snap: boolean) {
    if (this.phase === 'crash') {
      // Pull out and frame the wreck + the repair drone.
      const want = this.camPos.set(this.impact.x + 10, this.impact.y + 7, this.impact.z - 12)
      this.cam.position.lerp(want, 0.06)
      this.cam.lookAt(this.impact.x, this.impact.y + 1.5, this.impact.z)
      return
    }
    this.fwd.set(Math.sin(this.camHeading), 0, Math.cos(this.camHeading))
    let want: THREE.Vector3
    let lookWant: THREE.Vector3
    if (this.phase === 'canopy') {
      // Under canopy: sit ABOVE and behind the diver and aim down the glide path,
      // so the ground you're steering toward fills most of the frame while the
      // open chute + diver stay framed in the upper third. Pulled in close so the
      // robot reads big. (Y offsets folded in to avoid per-frame Vector3 allocs.)
      want = this.camPos.copy(this.pos).addScaledVector(this.fwd, -6.5); want.y += 3.6
      lookWant = this.camLook.copy(this.pos).addScaledVector(this.fwd, 7); lookWant.y -= 2.6
    } else {
      // Dive: chase from just above-behind, framed so the robot fills the frame
      // but you can see the ground rushing up below (camera sits a bit higher and
      // aims well down the dive line).
      want = this.camPos.copy(this.pos).addScaledVector(this.fwd, -4.2); want.y += 2.6
      lookWant = this.camLook.copy(this.pos).addScaledVector(this.fwd, 4.5); lookWant.y -= 6.5
    }
    // The dive falls FAST (up to ~88 m/s), so a slow lerp leaves the camera
    // lagging tens of metres behind and the robot reads tiny. Follow tightly while
    // diving; the slower canopy phase can ease more gently.
    if (snap) this.cam.position.copy(want)
    else this.cam.position.lerp(want, this.phase === 'canopy' ? 0.12 : 0.34)
    // Transient shake from cloud punch-throughs / the sonic boom.
    if (this.camShake > 0.01) {
      const j = this.camShake
      this.cam.position.x += (Math.random() - 0.5) * j
      this.cam.position.y += (Math.random() - 0.5) * j
      this.cam.position.z += (Math.random() - 0.5) * j
      this.camShake *= 0.86
    }
    this.cam.lookAt(lookWant)
  }

  dispose() {
    this.scene.remove(this.group)
    this.rb.dispose()
    this.helper?.dispose()
    for (const t of this.traffic) t.v.dispose()
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.cloudTex?.dispose()
  }
}
