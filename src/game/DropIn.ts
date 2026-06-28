import * as THREE from 'three'
import { clamp, dampAngle } from './utils'
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
  boomCharge: number // 0..1 sonic-boom charge while held at terminal velocity (0 when not charging)
  combo: number // running boost-ring chain count (0 = no active chain)
  comboFade: number // 0..1 how much of the 2.2s chain window remains (drives a decay bar)
  showJetTip: boolean // early-dive prompt: hold the jetpack to fly/hover the sky
  danger: boolean // falling too fast to survive a ground hit - drives a PULL UP warning
}

// You start very high and fall the whole way down, steering the dive (tuck to
// plunge, flare to slow + hang) toward a beacon-marked destination, optionally
// clipping floating target orbs on the way. Pop the canopy in time and glide it
// down; leave it too late and you smash into pieces - then a helper bot zips in
// and reassembles you on the spot.
const START_Y = 1320 // begin far above the city (a long, high opening drop)
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
  /** A vehicle model that rides the dive in place of the diver robot (set when you
   *  drive off the launch pad). It tracks the diver's position/orientation. */
  private rider: THREE.Object3D | null = null
  /** 0..1 how much altitude you had on canopy deploy (drives the reward). */
  chuteQuality = 0
  /** Optional target orbs threaded on the way down (small bonus). */
  bonusTargets = 0
  /** Boost-rings threaded dead-centre (a precision bonus on top of bonusTargets). */
  perfects = 0
  /** True if you hit the ground without a chute (crash + repair). */
  crashed = false
  /** Set when you fly through one of the floating destination portals on the way
   *  down; Game routes the handoff (zone travel for mars/moon, spawn for the
   *  others). Null = a normal touchdown in the city. */
  chosenDest: 'arcade' | 'mars' | 'moon' | 'city' | null = null
  /** Where you ended up - the handoff places the player here. */
  readonly landingPos = new THREE.Vector3()
  hud: DropHud = { alt: START_Y, speed: 0, phase: 'dive', hint: null, canDeploy: false, canTrick: false, result: null, place: null, boomCharge: 0, combo: 0, comboFade: 0, showJetTip: true, danger: false }
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
  private diveHeading = 0 // the direction you're steering the dive (moveX turns it)
  private steerX = 0 // smoothed steer input - keyboard A/D are binary, so ramp them to an analog value for smooth turns + roll
  private pitch = 0.5
  // Initial nose-over: counts down at the start of the dive. While positive, the
  // diver is forced into a steep head-down plunge (and the chase cam swings to look
  // down at the city) regardless of input, so going over the edge reads as a real
  // dive rather than a feet-first drop. Then normal steering takes over.
  private plungeT = 0

  private phase: DropHud['phase'] = 'dive'
  private lastAlt = START_Y // height above ground, cached so the camera clamp can skip its raycast up high
  private hasJetted = false // dismiss the jetpack tip once the player first uses it
  private quality = 0
  private pendingDeploy = false
  private wantCut = false // cut the canopy back to free-fall
  private resultT = 0
  private totalT = 0 // total opening time, for a safety timeout (never soft-lock)

  // Destination beacon + optional target orbs.
  private orbs: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; pos: THREE.Vector3; hit: boolean; popT: number }[] = []
  private orbCombo = 0 // consecutive boost-rings grabbed (resets if you miss a stretch)
  private orbComboT = 0 // time since the last grab (resets the combo)
  // Drifting neon balloons scattered around the corridor - pure delight: dive
  // through one and it bursts. Off to the sides so they're a thing you steer into.
  private balloons: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; bx: number; by: number; bz: number; ph: number; hit: boolean; popT: number }[] = []
  // Big "fly through" boost gates on the centre line: thread one for a speed surge.
  private boostGates: { mesh: THREE.Group; mat: THREE.MeshBasicMaterial; pos: THREE.Vector3; hit: boolean; popT: number }[] = []
  private boostT = 0 // seconds of active speed surge from a boost gate
  // A flock of little drones near each cloud deck that scatter when you punch through.
  private drones: { mesh: THREE.Mesh; bx: number; by: number; bz: number; vx: number; vy: number; vz: number; ph: number; scattered: boolean; life: number; mat: THREE.MeshStandardMaterial }[] = []
  // Glowing rings that climb each destination beam (the "this way up" playground look).
  private beamChevrons: { mesh: THREE.Mesh; base: number; top: number; speed: number }[] = []
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
  private texs: THREE.Texture[] = [] // canvas textures (holograms) to dispose on exit

  // Cloud decks you punch through on the way down (a staged reveal of the city).
  // depth 0..1 = how far down the deck sits (1 = lowest, the city-reveal punch).
  private clouds: { mesh: THREE.Object3D; y: number; punched: boolean; depth: number }[] = []
  private streakBurst = 0 // seconds of forced speed-line intensity after a deep cloud punch
  private streakTick = 0 // half-rate toggle for the streak buffer upload on mobile
  private streakDt = 0 // accumulated dt between streak buffer uploads (keeps motion speed right)
  private cloudTex?: THREE.Texture
  private vapor!: THREE.Mesh // pooled punch-through burst
  private vaporMat!: THREE.MeshBasicMaterial
  private vaporT = 1 // >=1 = idle
  // Sonic boom at terminal velocity: a bright shock ring + a flaring vapor cone.
  private boomRing!: THREE.Mesh
  private boomMat!: THREE.MeshBasicMaterial
  private boomCone!: THREE.Mesh
  private boomConeMat!: THREE.MeshBasicMaterial
  private boomT = 1 // >=1 = idle
  private boomCharge = 0
  private boomed = false
  // Rival race: live placement vs the other skydivers, paid out on landing.
  racePlace = 1
  raceTotal = 1
  private prevPlace = 0 // last frame's placement, to fire juice the moment you climb
  private camShake = 0

  private camPos = new THREE.Vector3()
  private camLook = new THREE.Vector3()
  private fwd = new THREE.Vector3()
  // Hand-off ease: when launched from the pad, glide the camera from the on-foot
  // view into the dive view (instead of a hard snap) so stepping off feels like
  // tipping into a dive, not a jump-cut.
  private camEase = 0
  private camFrom = new THREE.Vector3()
  private lookFrom = new THREE.Vector3()
  private easeLook = new THREE.Vector3()

  private static readonly STEER = 64 // canopy steer authority
  private static readonly TURN_RATE = 4.0 // dive heading turn speed (rad/s) at full moveX - snappy aiming
  private static readonly THETA_MIN = 0.32 // shallowest dive angle (~18deg from horizontal) when flared - a flat, far glide
  private static readonly V_FLARE = 26 // travel speed flared right back - a slow, hanging glide when flat/standing up
  // Pulling the stick fully down past belly-flat stands the diver upright into a
  // slow flight glide. Below this pitch the body rises from flat toward standing.
  private static readonly STAND_KNEE = 0.28
  private static readonly V_DIVE = 92 // travel speed at a full straight-down plunge
  private static readonly H_DAMP = 1.4
  private static readonly H_MAX = 88
  // Vertical speed (m/s) above which a no-chute ground hit (or a head-on wall
  // smack) breaks you apart. Below it you survive a hard landing - so flaring or
  // a jetpack tap is always enough to save yourself. The HUD warns past ~52.
  private static readonly CRASH_VSPEED = 74

  // Push the diver out of building walls (and cancel into-wall speed). Optional so
  // the drop still works without a physics world; set from Game.
  private solid?: (pos: THREE.Vector3, vel: THREE.Vector3) => void

  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera, input: Input, target: THREE.Vector3, getGround: (x: number, z: number) => number, solid?: (pos: THREE.Vector3, vel: THREE.Vector3) => void, startPos?: THREE.Vector3, easeIn?: boolean) {
    this.scene = scene
    this.cam = cam
    this.input = input
    this.target = target.clone()
    this.getGround = getGround
    this.solid = solid
    // Default high-altitude start, or begin exactly where the player stepped off
    // the launch pad so the hand-off is seamless.
    this.start = startPos ? startPos.clone() : new THREE.Vector3(target.x + 30, START_Y, target.z - 300)
    this.pos = this.start.clone()
    this.rb = createRobot()
    this.camHeading = Math.atan2(this.target.x - this.start.x, this.target.z - this.start.z)
    this.diveHeading = this.camHeading
    this.build()
    scene.add(this.group)
    // Nose into a head-down dive at the start. A touch longer when you step off the
    // pad (easeIn) so the dive reads clearly as the camera eases in behind you.
    this.plungeT = easeIn ? 1.5 : 1.0
    this.pitch = 0.7 // start already tipped forward, not standing
    if (easeIn) {
      // Stepped off the pad: keep the camera where it was (behind the walking
      // robot) and ease it into the dive view; start the fall gently and let it
      // accelerate, so it reads as "step off -> tip into a dive", not a jump-cut.
      this.camEase = 1
      this.camFrom.copy(cam.position)
      cam.getWorldDirection(this.lookFrom).multiplyScalar(12).add(cam.position)
      this.vy = -4
    } else {
      this.placeCamera(true)
    }
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  private build() {
    this.rb.setFlyPose(1)
    // Yaw-first Euler so turning a pitched-down diver reads as a clean banked turn
    // instead of tumbling the body upside down (default XYZ gimbal-locks at a dive).
    this.diver.rotation.order = 'YXZ'
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
      const rx = Math.cos(a) * 2.8, rz = Math.sin(a) * 2.8, ry = 6.85 // canopy rim (dome sits at y 6.5, r 2.9)
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
    const N_AI = config.tier.name === 'low' ? 4 : 9 // fewer rival skydivers on mobile (memory + draw)
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
    this.buildBalloons()
    this.buildBoostGates()
    this.buildDrones()
    this.buildHolograms()

    // Pooled punch-through vapor burst (cloud decks) - one reused sphere.
    this.vaporMat = this.own(new THREE.MeshBasicMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.vapor = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(1, 16, 12)), this.vaporMat)
    this.vapor.visible = false
    this.vapor.frustumCulled = false
    this.group.add(this.vapor)

    // Pooled sonic-boom shockwave: a bright fat ring + a flaring vapor cone that
    // blooms around the diver, so the boom reads as a punch instead of a thin hoop.
    this.boomMat = this.own(new THREE.MeshBasicMaterial({ color: 0xdff1ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.boomRing = new THREE.Mesh(this.ownG(new THREE.TorusGeometry(1, 0.16, 10, 56)), this.boomMat)
    this.boomRing.visible = false
    this.boomRing.frustumCulled = false
    this.group.add(this.boomRing)
    this.boomConeMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    // Open cone (apex up) that flares downward like a pressure cone behind the dive.
    this.boomCone = new THREE.Mesh(this.ownG(new THREE.ConeGeometry(1, 1.6, 28, 1, true)), this.boomConeMat)
    this.boomCone.visible = false
    this.boomCone.frustumCulled = false
    this.group.add(this.boomCone)
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
    for (let bi = 0; bi < bands.length; bi++) {
      const b = bands[bi]
      const depth = bands.length > 1 ? bi / (bands.length - 1) : 0 // 0 highest -> 1 lowest
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
      this.clouds.push({ mesh: deck, y, punched: false, depth })
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
    // One pad per destination, placed right IN the descent corridor at staggered
    // altitudes with a small left/right offset - so you just drift toward the one
    // you want as you fall past it. (The old wide ring of pads sat far off the dive
    // line and was nearly impossible to reach.) [dest, altitude, lateral offset]
    // Offset must stay well WIDER than the catch radius (below) + the float bob, or
    // a normal straight-down freefall passes through a pad and teleports you away
    // mid-dive. You reach a pad by steering out to it, not by falling past it.
    const defs: Array<['city' | 'arcade' | 'mars' | 'moon', number, number]> = [
      ['moon', 900, -74],
      ['arcade', 690, 74],
      ['mars', 470, -74],
      ['city', 280, 74],
    ]
    const span = this.start.y - this.target.y
    const chevGeo = this.ownG(new THREE.TorusGeometry(6, 0.45, 8, 26)) // shared: rings that climb each beam
    for (const [dest, alt, off] of defs) {
      const col = C[dest]
      const y = this.target.y + alt
      // Position on the start->target descent line at this altitude, nudged aside.
      const f = THREE.MathUtils.clamp((this.start.y - y) / span, 0, 1)
      const x = THREE.MathUtils.lerp(this.start.x, this.target.x, f) + off
      const z = THREE.MathUtils.lerp(this.start.z, this.target.z, f)
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
      // Glowing rings that climb the beam - the "this way up" playground look that
      // makes each destination read as an inviting lift, not just a marker.
      const chevMat = this.own(new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const CHEV = 5, top = 200
      for (let c = 0; c < CHEV; c++) {
        const chev = new THREE.Mesh(chevGeo, chevMat)
        chev.rotation.x = Math.PI / 2 // lie flat so it rings the vertical beam
        chev.position.y = 20 + (c / CHEV) * top
        group.add(chev)
        this.beamChevrons.push({ mesh: chev, base: 20, top: 20 + top, speed: 26 + c * 1.5 })
      }
      // Big floating label above the ring.
      const sprite = this.labelSprite(labels[dest], col)
      sprite.position.set(0, 40, 0)
      sprite.scale.set(44, 16, 1)
      group.add(sprite)
      this.group.add(group)
      this.platforms.push({ group, ring, x, y, z, bx: x, by: y, bz: z, ph: alt * 0.013, dest })
    }
  }

  /** Drifting neon balloons scattered through the descent. Diving through one
   *  bursts it (scale-up + fade + chime). Decorative - no score, just joy. */
  private buildBalloons() {
    const balloonGeo = this.ownG(new THREE.SphereGeometry(2.2, 14, 12))
    const stringGeo = this.ownG(new THREE.CylinderGeometry(0.05, 0.05, 3, 5))
    const colors = [0xff5ba8, 0x5bdcff, 0xffd24a, 0x9dff5a, 0xb98cff]
    const n = config.tier.name === 'low' ? 5 : config.tier.name === 'medium' ? 14 : 20
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n
      const y = THREE.MathUtils.lerp(START_Y - 70, this.target.y + 70, f) + (Math.random() - 0.5) * 36
      // Scattered in a ring around the descent line, biased outward so they fill
      // the sky to the sides rather than blocking the straight-down corridor.
      const ang = i * 2.39 + Math.random() // golden-ish angle so they don't clump
      const rad = 16 + Math.random() * 44
      const cx = THREE.MathUtils.lerp(this.start.x, this.target.x, f)
      const cz = THREE.MathUtils.lerp(this.start.z, this.target.z, f)
      const x = cx + Math.cos(ang) * rad
      const z = cz + Math.sin(ang) * rad
      const col = colors[i % colors.length]
      const mat = this.own(new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.1, transparent: true, opacity: 1 }))
      const mesh = new THREE.Mesh(balloonGeo, mat)
      mesh.position.set(x, y, z)
      mesh.scale.y = 1.18 // slightly egg-shaped, like a real balloon
      const str = new THREE.Mesh(stringGeo, this.own(new THREE.MeshBasicMaterial({ color: 0x9fb0c8, transparent: true, opacity: 0.4, fog: false })))
      str.position.y = -2.7
      mesh.add(str)
      this.group.add(mesh)
      this.balloons.push({ mesh, mat, bx: x, by: y, bz: z, ph: i * 1.7, hit: false, popT: 0 })
    }
  }

  /** Bob the balloons and burst any the diver passes through. */
  private updateBalloons(dt: number) {
    for (const b of this.balloons) {
      if (b.hit) {
        if (b.popT < 1) {
          b.popT = Math.min(1, b.popT + dt * 3.5)
          b.mesh.scale.setScalar(1 + b.popT * 2.2)
          b.mat.opacity = 1 - b.popT
          if (b.popT >= 1) b.mesh.visible = false
        }
        continue
      }
      const py = b.by + Math.sin(this.totalT * 0.8 + b.ph) * 1.4
      const px = b.bx + Math.cos(this.totalT * 0.5 + b.ph) * 1.2
      b.mesh.position.set(px, py, b.bz)
      if (Math.abs(this.pos.y - py) < 4) {
        const d = Math.hypot(this.pos.x - px, this.pos.z - b.bz)
        if (d < 4.4) { b.hit = true; this.onSfx?.('ring') }
      }
    }
  }

  /** Big "fly through" boost gates on the centre line - thread one for a speed
   *  surge + speed-line crack, rewarding a committed straight-down plunge. */
  private buildBoostGates() {
    const N = 4
    const ringGeo = this.ownG(new THREE.TorusGeometry(11, 0.9, 12, 40))
    const chevGeo = this.ownG(new THREE.ConeGeometry(2.4, 3.2, 4))
    for (let i = 0; i < N; i++) {
      const f = (i + 0.7) / (N + 0.5)
      const y = THREE.MathUtils.lerp(START_Y - 120, this.target.y + 150, f)
      const x = THREE.MathUtils.lerp(this.start.x, this.target.x, f)
      const z = THREE.MathUtils.lerp(this.start.z, this.target.z, f)
      const g = new THREE.Group()
      const mat = this.own(new THREE.MeshBasicMaterial({ color: 0x6cf6ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
      const ring = new THREE.Mesh(ringGeo, mat)
      ring.rotation.x = Math.PI / 2 // lie flat - you drop straight down through it
      g.add(ring)
      for (let k = 0; k < 3; k++) {
        const cv = new THREE.Mesh(chevGeo, mat)
        cv.rotation.x = Math.PI // point the cone down: "dive through here"
        cv.position.y = 4 - k * 4
        g.add(cv)
      }
      g.position.set(x, y, z)
      this.group.add(g)
      this.boostGates.push({ mesh: g, mat, pos: new THREE.Vector3(x, y, z), hit: false, popT: 0 })
    }
  }

  /** Combined dive speed multiplier: the hold-to-boost button and any active
   *  boost-gate surge stack. */
  private boostMul(): number {
    return (this.input.held.boost ? 1.5 : 1) * (this.boostT > 0 ? 1.5 : 1)
  }

  /** Spin/pulse the gates and fire a surge when the diver threads one. */
  private updateBoostGates(dt: number) {
    if (this.boostT > 0) this.boostT = Math.max(0, this.boostT - dt)
    for (const gt of this.boostGates) {
      if (gt.hit) {
        if (gt.popT < 1) {
          gt.popT = Math.min(1, gt.popT + dt * 2.5)
          gt.mesh.scale.setScalar(1 + gt.popT * 0.9)
          gt.mat.opacity = 0.9 * (1 - gt.popT)
          if (gt.popT >= 1) gt.mesh.visible = false
        }
        continue
      }
      gt.mesh.rotation.y += dt * 0.6
      gt.mat.opacity = 0.7 + Math.sin(this.totalT * 4 + gt.pos.y * 0.1) * 0.22
      if (this.phase === 'dive' && Math.abs(this.pos.y - gt.pos.y) < 6) {
        if (Math.hypot(this.pos.x - gt.pos.x, this.pos.z - gt.pos.z) < 11) {
          gt.hit = true
          this.boostT = 1.5
          this.streakBurst = Math.max(this.streakBurst, 0.6)
          this.kick(0.7)
          this.onSfx?.('deploy')
          if (!this.hud.result || (!this.hud.result.startsWith('PORTAL') && !this.hud.result.startsWith('SONIC'))) { this.hud.result = 'BOOST!'; this.resultT = 0 }
        }
      }
    }
  }

  /** A little flock of drones hovering at each cloud deck - they scatter when you
   *  punch through that deck (wired from the cloud-punch in updateSkyFx). */
  private buildDrones() {
    // Skip the drone flock on mobile: dark boxes near the descent line are the
    // most likely thing to clip the close camera's near plane (a black flash),
    // and the low tier wants fewer scene objects anyway.
    if (config.tier.name === 'low') return
    const bodyGeo = this.ownG(new THREE.BoxGeometry(1.0, 0.34, 1.0))
    const tints = [0x27e7ff, 0xff2bd0, 0x9dff5a, 0xffd24a, 0xb98cff]
    const perDeck = config.tier.name === 'medium' ? 4 : 5
    let i = 0
    for (const c of this.clouds) {
      for (let k = 0; k < perDeck; k++, i++) {
        const ang = (k / perDeck) * Math.PI * 2 + c.depth * 2
        const rad = 10 + Math.random() * 38
        const x = this.target.x + Math.cos(ang) * rad
        const z = this.target.z + Math.sin(ang) * rad
        const y = c.y + (Math.random() - 0.5) * 14
        const col = tints[i % tints.length]
        const mat = this.own(new THREE.MeshStandardMaterial({ color: 0x10151f, emissive: col, emissiveIntensity: 1.5, roughness: 0.5, transparent: true, opacity: 1 }))
        const mesh = new THREE.Mesh(bodyGeo, mat)
        mesh.position.set(x, y, z)
        this.group.add(mesh)
        this.drones.push({ mesh, bx: x, by: y, bz: z, vx: 0, vy: 0, vz: 0, ph: ang, scattered: false, life: 0, mat })
      }
    }
  }

  /** Hover the drones in formation; once scattered they tumble away and fade. */
  private updateDrones(dt: number) {
    for (const d of this.drones) {
      if (d.scattered) {
        d.life += dt
        d.vy -= 16 * dt
        d.bx += d.vx * dt; d.by += d.vy * dt; d.bz += d.vz * dt
        d.mesh.position.set(d.bx, d.by, d.bz)
        d.mesh.rotation.x += dt * 5
        d.mesh.rotation.z += dt * 4
        d.mat.opacity = Math.max(0, 1 - d.life * 0.5)
        if (d.life > 2.2) d.mesh.visible = false
        continue
      }
      d.mesh.position.set(d.bx + Math.cos(this.totalT * 0.6 + d.ph) * 1.4, d.by + Math.sin(this.totalT * 1.6 + d.ph) * 0.8, d.bz)
      d.mesh.rotation.y += dt * 2.5
    }
  }

  /** When a cloud deck is punched, scatter the drones hovering at that altitude. */
  private scatterDrones(y: number) {
    for (const d of this.drones) {
      if (d.scattered || Math.abs(d.by - y) > 46) continue
      d.scattered = true
      d.vx = Math.cos(d.ph) * (20 + Math.random() * 18)
      d.vz = Math.sin(d.ph) * (20 + Math.random() * 18)
      d.vy = 6 + Math.random() * 12
      d.bx = d.mesh.position.x; d.by = d.mesh.position.y; d.bz = d.mesh.position.z
    }
  }

  /** Holographic billboards drifting past at the sides of the descent (flavor). */
  private buildHolograms() {
    // Skip on mobile: each is a 512x256 canvas texture, and the drop already peaks
    // mobile GPU memory (the whole city + the entire drop scene coexist) - shedding
    // textures here helps avoid a context-loss black-out on phones.
    if (config.tier.name === 'low') return
    const lines: [string, string][] = [['WELCOME TO', 'UNIT 7'], ['NEON', 'CITY'], ['DROP', 'ZONE']]
    for (let i = 0; i < lines.length; i++) {
      const f = (i + 0.6) / (lines.length + 0.3)
      const y = THREE.MathUtils.lerp(START_Y - 200, this.target.y + 230, f)
      const side = i % 2 === 0 ? 1 : -1
      const x = THREE.MathUtils.lerp(this.start.x, this.target.x, f) + side * 95
      const z = THREE.MathUtils.lerp(this.start.z, this.target.z, f) + side * 24
      const col = i % 2 === 0 ? 0x27e7ff : 0xff2bd0
      const tex = this.holoText(lines[i][0], lines[i][1], col)
      this.texs.push(tex)
      const spr = new THREE.Sprite(this.own(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })) as THREE.SpriteMaterial)
      spr.position.set(x, y, z)
      spr.scale.set(72, 36, 1)
      this.group.add(spr)
    }
  }

  /** Two-line neon hologram texture for the sky billboards. */
  private holoText(line1: string, line2: string, color: number): THREE.CanvasTexture {
    const cv = document.createElement('canvas')
    cv.width = 512; cv.height = 256
    const ctx = cv.getContext('2d')!
    const hex = '#' + color.toString(16).padStart(6, '0')
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = hex; ctx.shadowBlur = 26
    ctx.fillStyle = hex
    ctx.font = '800 64px ui-monospace, Menlo, monospace'
    ctx.fillText(line1, 256, 90)
    ctx.font = '900 104px ui-monospace, Menlo, monospace'
    ctx.fillText(line2, 256, 176)
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  /** A neon text billboard sprite for the platform labels. */
  private labelSprite(text: string, color: number): THREE.Sprite {
    const cv = document.createElement('canvas')
    cv.width = 256; cv.height = 96
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, 256, 96) // start from a transparent canvas so text stays crisp
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

  /** Ride the dive in a vehicle: hide the diver robot and let `obj` track it. */
  setRider(obj: THREE.Object3D | null) {
    this.rider = obj
    this.rb.group.visible = !obj
  }

  get riding() { return !!this.rider }

  /** Bail out of the vehicle mid-dive: drop the rider, show the diver, keep falling. */
  bail() {
    this.rider = null
    this.rb.group.visible = true
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
    this.chuteRig.visible = false // skipping mid-canopy must not leave the chute on screen
    this.phase = 'land'
  }

  update(dt: number) {
    if (this.done) return
    if (this.camEase > 0) this.camEase = Math.max(0, this.camEase - dt / 0.7) // hand-off ease timer
    // Safety: a normal drop finishes well under a minute; if anything stalls it,
    // force a clean handoff so the player is never trapped in the drop-in. Hand off
    // at the PLAZA target (not wherever the stall left you) so you still arrive by
    // the guide + the first objectives.
    this.totalT += dt
    if (this.totalT > 48) {
      this.landingPos.copy(this.target)
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
    this.lastAlt = alt

    const chute = this.input.consumeEdge('chute')
    if (chute) {
      if (this.phase === 'dive') this.pendingDeploy = true // deploy at any altitude
      else if (this.phase === 'canopy') this.wantCut = true // cut back to free-fall
    }
    if (this.wantCut && this.phase === 'canopy') this.cutCanopy()
    // FLIP (H / button): a somersault that kicks the board away.
    if (this.input.consumeEdge('net')) this.trick()
    if (this.flipT > 0) this.flipT = Math.max(0, this.flipT - dt)

    // --- horizontal steering (heading-relative for both dive + canopy) ---
    if (this.phase === 'dive') {
      // Steer like a skydiver. moveX TURNS your heading (you bank into the turn
      // instead of sliding sideways); moveY sets the dive ANGLE via `pitch`. Your
      // velocity vector tilts from a shallow forward glide (flared) to dead vertical
      // (full push), so pushing all the way gives a CLEAN straight-down plunge with
      // no drift, and a neutral stick cruises forward at an angle. The approach lerp
      // keeps real momentum so it still feels like falling, not a cursor.
      // Turn freely when flat/flared, but barely while plunging near-vertical - so
      // holding a turn in a steep dive no longer spirals you around your own axis
      // (you turn by flaring out, then dive again). Boost = thrust the way you point.
      // moveX is SUBTRACTED: a +x heading rotation reads as screen-left, so right
      // input must lower the heading to actually turn right.
      // Ramp the raw stick to an analog steer so keyboard turns ease in/out
      // instead of snapping (the desktop "turns feel jerky" fix).
      this.steerX += (this.input.moveX - this.steerX) * Math.min(1, dt * 8)
      this.diveHeading -= this.steerX * DropIn.TURN_RATE * (1 - this.pitch * 0.8) * dt
      const tp = Math.min(1, this.pitch * 1.05) // saturate so a near-full hold is dead vertical
      const theta = THREE.MathUtils.lerp(DropIn.THETA_MIN, Math.PI / 2, tp)
      const speed = THREE.MathUtils.lerp(DropIn.V_FLARE, DropIn.V_DIVE, this.pitch) * this.boostMul()
      const hSpeed = Math.cos(theta) * speed
      const tvx = Math.sin(this.diveHeading) * hSpeed
      const tvz = Math.cos(this.diveHeading) * hSpeed
      const k = Math.min(1, dt * 4.5) // snappier so the velocity follows your turns quickly
      this.hVel.x += (tvx - this.hVel.x) * k
      this.hVel.z += (tvz - this.hVel.z) * k
    } else if (this.phase === 'canopy') {
      // Steer the canopy the SAME heading-based way as the dive (moveX turns,
      // glide along the heading, moveY trims) so the controls can NEVER invert
      // relative to the view. The old version steered in fixed-yaw world space
      // while the camera faced wherever you'd turned to, so a turn on the way down
      // flipped left/right. Plus a gentle pull toward the beacon.
      this.steerX += (this.input.moveX - this.steerX) * Math.min(1, dt * 8)
      this.diveHeading -= this.steerX * DropIn.TURN_RATE * 0.7 * dt // right input turns right (see dive note)
      const glide = (20 + this.input.moveY * 10) * (0.6 + this.quality * 0.4)
      const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z
      const d = Math.hypot(dx, dz) || 1
      const tvx = Math.sin(this.diveHeading) * glide + (dx / d) * 5
      const tvz = Math.cos(this.diveHeading) * glide + (dz / d) * 5
      const k = Math.min(1, dt * 2)
      this.hVel.x += (tvx - this.hVel.x) * k
      this.hVel.z += (tvz - this.hVel.z) * k
    } else {
      // Land: settle straight down where you are.
      const damp = Math.exp(-DropIn.H_DAMP * dt)
      this.hVel.x *= damp
      this.hVel.z *= damp
    }
    const hs = Math.hypot(this.hVel.x, this.hVel.z)
    const hMax = this.phase === 'canopy' ? 32 : DropIn.H_MAX
    if (hs > hMax) { this.hVel.x *= hMax / hs; this.hVel.z *= hMax / hs }

    // --- phase machine ---
    if (this.phase === 'dive') {
      if (this.input.held.jet) {
        this.hasJetted = true // learned the jetpack -> stop nagging the tip
        // Jetpack while falling: thrust upward toward the cruise cap so you can
        // arrest the fall, hover, or even climb to line up a high portal pad.
        const cap = config.jetpack.maxAscend
        const rate = config.jetpack.thrust * dt
        this.vy = this.vy < cap ? Math.min(this.vy + rate, cap) : Math.max(this.vy - rate, cap)
        this.pitch += (0 - this.pitch) * Math.min(1, dt * 4) // upright jet pose
      } else {
        // moveY sets the dive angle: push forward to tip toward straight-down,
        // pull back to flatten/flare. Neutral sits below mid so letting go settles
        // into a forward glide (not a hover). Fall speed is the vertical component
        // of the same tilted velocity vector the steering uses, so a full hold is
        // ~2x the flared-glide descent and points dead-down.
        // Neutral sits at a committed head-down dive so letting go still reads as a
        // DIVE (and the down-camera keeps looking down). Pulling the stick DOWN
        // flattens out and, held all the way, brings the diver up to a near-vertical
        // standing flight pose gliding slowly - so the pull side reaches pitch 0
        // (full flare) while the push side keeps the same dive feel as before.
        let diveAmt = this.input.moveY < 0
          ? clamp(0.55 + this.input.moveY * 0.55, 0, 1) // pull down: flatten fully, then stand up
          : clamp(0.55 + this.input.moveY * 0.45, 0, 1) // push up: steepen toward a vertical plunge
        let approach = dt * 3.5
        if (this.plungeT > 0) {
          // Forced head-down nose-over at the start of the dive (see plungeT). Snap
          // into the steep dive faster than normal steering so the launch commits.
          this.plungeT = Math.max(0, this.plungeT - dt)
          diveAmt = Math.max(diveAmt, 0.92)
          approach = dt * 5
        }
        this.pitch += (diveAmt - this.pitch) * Math.min(1, approach)
        const tp = Math.min(1, this.pitch * 1.05)
        const speed = THREE.MathUtils.lerp(DropIn.V_FLARE, DropIn.V_DIVE, this.pitch) * this.boostMul()
        const term = -speed * Math.sin(THREE.MathUtils.lerp(DropIn.THETA_MIN, Math.PI / 2, tp))
        this.vy += (term - this.vy) * Math.min(1, dt * 1.6)
        // A full straight-down nose-dive holds steady - flips are deliberate only
        // (FLIP button / H), so pushing all the way forward plunges cleanly at
        // terminal velocity instead of tumbling into an involuntary loop.
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
        // A fast nose-dive into the ground without a chute splatters you - but if
        // you bled off speed (flared or jetpacked), you stick a hard landing
        // instead of breaking apart. You have to be really booking it to explode.
        if (-this.vy > DropIn.CRASH_VSPEED) { this.beginCrash(ground); return }
        this.phase = 'land'
        this.landingPos.set(this.pos.x, ground, this.pos.z)
        this.onSfx?.('land')
        this.hud.result = 'NO-CHUTE LANDING'
        this.resultT = 0
      }
    } else if (this.phase === 'canopy') {
      // Flare control: pull back (moveY < 0) to brake your descent for a soft
      // touchdown, push forward to sink faster. Base rate scales with how cleanly
      // you popped the canopy (quality).
      const base = THREE.MathUtils.lerp(16, 9, this.quality)
      const want = -base * (1 + this.input.moveY * 0.55) // ~0.45x flared .. ~1.55x pushed
      this.vy += (want - this.vy) * Math.min(1, dt * 2.5)
      this.chuteRig.scale.setScalar(THREE.MathUtils.damp(this.chuteRig.scale.x, 1, 6, dt))
      this.pitch += (0 - this.pitch) * Math.min(1, dt * 3)
      if (alt <= 1.5) {
        this.phase = 'land'
        this.landingPos.set(this.pos.x, ground, this.pos.z)
        // A well-timed flare (gentle descent at touchdown) is a feather landing -
        // a little style bonus, paid out with the perfects in finishDrop.
        if (-this.vy < 7) { this.perfects++; this.hud.result = 'FEATHER LANDING'; this.resultT = 0 }
      }
    } else {
      // land: settle straight down where you are - no relocation.
      this.vy += (-2 - this.vy) * Math.min(1, dt * 4)
    }

    // integrate
    this.pos.x += this.hVel.x * dt
    this.pos.z += this.hVel.z * dt
    this.pos.y += this.vy * dt

    // Ground floor. The landing check above uses the altitude from the START of the
    // frame (before this move), so a fast / boosted dive over rising terrain or a
    // rooftop can step its vertical position straight through the surface in one
    // frame - which reads as a sudden "skip" to the ground. Clamp to the ground at
    // the NEW x/z and finalize the landing (or crash) exactly at contact, never
    // underground.
    if (this.phase === 'dive' || this.phase === 'canopy' || this.phase === 'land') {
      const gy = this.getGround(this.pos.x, this.pos.z)
      if (this.pos.y < gy) {
        if (this.phase === 'dive' && -this.vy > DropIn.CRASH_VSPEED) { this.pos.y = gy; this.beginCrash(gy); return }
        if (this.phase !== 'land') {
          this.phase = 'land'
          this.landingPos.set(this.pos.x, gy, this.pos.z)
          if (!this.hud.result) { this.hud.result = 'NO-CHUTE LANDING'; this.resultT = 0 }
        }
        this.pos.y = gy
        if (this.vy < 0) this.vy = 0
      }
    }

    // Soft horizontal boundary: the jetpack lets you climb and cruise freely, but
    // don't let the dive wander off into empty space far from the city - clamp to a
    // generous box around the descent corridor (and bleed the speed into it).
    if (this.phase === 'dive' || this.phase === 'canopy') {
      const B = 460
      if (this.pos.x < this.target.x - B) { this.pos.x = this.target.x - B; if (this.hVel.x < 0) this.hVel.x = 0 }
      else if (this.pos.x > this.target.x + B) { this.pos.x = this.target.x + B; if (this.hVel.x > 0) this.hVel.x = 0 }
      if (this.pos.z < this.target.z - B) { this.pos.z = this.target.z - B; if (this.hVel.z < 0) this.hVel.z = 0 }
      else if (this.pos.z > this.target.z + B) { this.pos.z = this.target.z + B; if (this.hVel.z > 0) this.hVel.z = 0 }
    }

    // Buildings are solid: push out of any wall the diver enters (the resolver only
    // acts when the diver overlaps a building vertically, so you still sail ABOVE
    // rooftops). A hard, fast head-on smack into a wall while diving is a crash -
    // the repair drone reassembles you, which is its own little spectacle.
    if (this.solid && (this.phase === 'dive' || this.phase === 'canopy')) {
      const pre = Math.hypot(this.hVel.x, this.hVel.z)
      this.solid(this.pos, this.hVel)
      if (this.phase === 'dive') {
        const lost = pre - Math.hypot(this.hVel.x, this.hVel.z)
        if (lost > 42 && this.vy < -28) { this.beginCrash(this.getGround(this.pos.x, this.pos.z)); return }
      }
    }

    this.diver.position.copy(this.pos)
    const diving = this.phase === 'dive'
    // The chase camera trails the controlled heading for BOTH dive and canopy, so
    // turning always turns the view and left/right never invert.
    if (diving || this.phase === 'canopy') this.camHeading = dampAngle(this.camHeading, this.diveHeading, 6, dt)
    else if (hs > 0.5) this.camHeading = dampAngle(this.camHeading, Math.atan2(this.hVel.x, this.hVel.z), 7, dt)
    // HEAD-FIRST dive: the body tips PAST horizontal so the head leads down toward
    // the ground (matches the velocity vector). PI/2 is belly-flat/superman; adding
    // the dive angle on top points the head down. Flared eases back toward flat so
    // pulling up reads as levelling out. (Not full PI, so it never goes dead-upside-
    // down — it's a steep head-first dive, head + shoulders leading.)
    const tpPose = Math.min(1, this.pitch * 1.05)
    // Flared (~86°) reads as belly-flat / levelling out; a full dive (~155°) is a
    // steep head-first plunge. So pulling back pitches up and diving tips head-down.
    // Below the stand knee (a full pull-down) the body keeps rising past belly-flat
    // up to a near-upright standing pose (~7°), so holding down "pulls up to flight".
    const kneeVal = THREE.MathUtils.lerp(1.5, 2.7, DropIn.STAND_KNEE)
    const bodyPitch = diving
      ? (tpPose >= DropIn.STAND_KNEE
          ? THREE.MathUtils.lerp(1.5, 2.7, tpPose)
          : THREE.MathUtils.lerp(0.12, kneeVal, tpPose / DropIn.STAND_KNEE))
      : 0
    const flip = this.flipT > 0 ? (1 - this.flipT / DropIn.FLIP_DUR) * Math.PI * 2 : 0
    // Bank into the turn (roll with moveX) while diving for a steered feel.
    const roll = diving ? clamp(this.steerX * 0.5, -0.6, 0.6) : clamp(-this.hVel.x * 0.02, -0.5, 0.5)
    this.diver.rotation.set(bodyPitch + flip, this.camHeading, roll)
    // A vehicle rider tracks the diver: same position, a softened version of the
    // dive tilt (a car shouldn't go fully nose-down), so it reads as plummeting.
    if (this.rider) {
      this.rider.position.copy(this.diver.position)
      this.rider.rotation.set((bodyPitch + flip) * 0.45, this.camHeading, roll * 0.6)
    }
    // Arms react to steering: sweep back when diving forward, spread when flaring,
    // and bank asymmetrically when steering left/right.
    this.rb.setSteer?.(this.input.moveX, this.input.moveY)
    // Wings spread when flared (a glide) and FOLD back as the dive steepens, so a
    // committed plunge reads as a streamlined head-first dive (arms/legs trailing)
    // rather than a flying-V; under canopy they're stowed entirely.
    this.rb.setWings(diving ? THREE.MathUtils.lerp(0.95, 0.3, tpPose) : 0)
    this.rb.setThrust(this.phase === 'dive' && this.input.held.jet ? 1 : 0) // jetpack flame
    this.rb.update(dt, diving ? 0.4 : 0.15, false)

    this.updateAi(dt)
    this.updateTraffic(dt)
    if (this.phase === 'dive' || this.phase === 'canopy') { this.checkPlatforms(); this.updateBalloons(dt); this.updateBoostGates(dt); this.updateDrones(dt) }
    this.updateStreaks(dt, diving)
    this.updateSkyFx(dt)
    this.placeCamera(false)

    this.hud.alt = Math.max(0, alt)
    this.hud.speed = Math.hypot(hs, this.vy)
    this.hud.phase = this.phase
    this.hud.canDeploy = this.phase === 'dive'
    this.hud.canTrick = this.phase === 'dive' || this.phase === 'canopy'
    // Going too fast to survive a ground hit: warn so you flare / deploy / jet in
    // time. Only while diving and not super-high, so it reads as approaching danger.
    this.hud.danger = this.phase === 'dive' && -this.vy > DropIn.CRASH_VSPEED - 18 && alt < 480
    // Hide the jetpack coaching tip while the PULL UP warning is up, so the two
    // prompts don't stack on top of each other.
    this.hud.showJetTip = this.phase === 'dive' && !this.hasJetted && this.totalT < 18 && !this.hud.danger
    this.hud.hint = this.phase === 'canopy'
      ? (alt < 70 ? (-this.vy < 7 ? 'FLARED - SOFT LANDING' : 'PULL BACK TO FLARE') : 'STEER TO A PORTAL OR THE BEACON')
      : this.phase === 'land' ? 'TOUCHDOWN'
      : 'STEER · PULL DOWN TO LEVEL INTO A GLIDE · DEPLOY ANYTIME'
    // Sonic-boom charge bar (only while diving toward terminal velocity); the
    // running ring chain + how much of its 2.2s window remains. All derived from
    // values the sim already tracks - no extra per-frame work.
    this.hud.boomCharge = this.phase === 'dive' ? (this.boomed ? 1 : clamp(this.boomCharge / 0.5, 0, 1)) : 0
    this.hud.combo = this.phase === 'dive' ? this.orbCombo : 0
    this.hud.comboFade = clamp(1 - this.orbComboT / 2.2, 0, 1)
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
          // Dead-centre threading is a "perfect": banks an extra precision bonus
          // (paid out in finishDrop) and flashes PERFECT. The running chain count
          // itself lives in the persistent combo chip (hud.combo), so a normal
          // grab no longer churns the shared result line.
          if (d < 2.5) {
            this.perfects++
            if (!this.hud.result || this.hud.result.startsWith('PERFECT') || this.hud.result.startsWith('BOOST')) {
              this.hud.result = `PERFECT x${this.orbCombo}`
              this.resultT = 0
            }
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
        // reducedMotion: drop the 30 rad/s strobe to a calm ~2.5 rad/s low-amplitude
        // shimmer (visual-only; beam geometry/physics unchanged).
        bm.opacity = config.reducedMotion
          ? 0.45 + Math.sin(t * 2.5) * 0.08
          : 0.4 + Math.sin(t * 30) * 0.25
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
      // Gentle bob only - the old wide drift made the pads dodge away as you fell.
      p.x = p.bx + Math.cos(pt * 0.3 + p.ph) * 8
      p.y = p.by + Math.sin(pt * 0.5 + p.ph) * 7
      p.z = p.bz + Math.sin(pt * 0.27 + p.ph) * 8
      p.group.position.set(p.x, p.y, p.z)
    }
    // Climb the beam rings upward (local to each platform group), wrapping at the top.
    for (const ch of this.beamChevrons) {
      let y = ch.mesh.position.y + ch.speed * dt
      if (y > ch.top) y = ch.base + (y - ch.top)
      ch.mesh.position.y = y
    }
  }

  /** Steered into a destination portal? Lock the destination + start the handoff. */
  private checkPlatforms() {
    for (const p of this.platforms) {
      if (Math.abs(this.pos.y - p.y) > 50) continue // vertical catch window
      if (Math.hypot(this.pos.x - p.x, this.pos.z - p.z) < 44) { // catch radius - kept well under the lateral offset (74) minus bob (8) so a straight-down faller never passes through
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
      // Deeper decks hit harder: the lowest punch (depth 1) is the city reveal,
      // so it kicks the camera more and fires a brief speed-line burst.
      this.kick(1.1 + c.depth * 1.4)
      this.streakBurst = Math.max(this.streakBurst, 0.3 + c.depth * 0.25)
      this.scatterDrones(c.y) // burst the flock hovering at this deck
      this.onSfx?.('land')
    }
    if (this.vaporT < 1) {
      this.vaporT = Math.min(1, this.vaporT + dt * 2.2)
      this.vapor.position.copy(this.pos)
      this.vapor.scale.setScalar(2 + this.vaporT * 46)
      // Eased (quadratic) fade alongside the scale growth so the burst blooms in
      // softly instead of popping to full opacity on the first mobile frame.
      this.vaporMat.opacity = Math.max(0, 0.7 * (1 - this.vaporT * this.vaporT))
      if (this.vaporT >= 1) this.vapor.visible = false
    }

    // Sonic boom: hold a full nose-dive to terminal velocity and you punch a
    // shockwave. Re-arms once you slow back down. DESKTOP ONLY - on mobile the
    // big additive cone + camera punch were a flicker culprit, so it's removed
    // there entirely (no charge, ring, cone, or kick).
    if (config.tier.name !== 'low' && this.phase === 'dive' && this.vy < -82) {
      this.boomCharge += dt
      if (this.boomCharge > 0.5 && !this.boomed) {
        this.boomed = true
        this.boomRing.position.copy(this.pos)
        this.boomRing.rotation.x = Math.PI / 2
        this.boomRing.visible = true
        this.boomCone.position.copy(this.pos)
        this.boomCone.visible = true
        this.boomT = 0
        this.kick(2.6) // harder camera punch
        this.streakBurst = Math.max(this.streakBurst, 0.5) // speed-line crack
        this.onSfx?.('deploy')
        // A sonic boom is a marquee beat: let it override the lesser transient
        // labels (combo / overtake) but never a PORTAL lock-in.
        if (!this.hud.result || !this.hud.result.startsWith('PORTAL')) { this.hud.result = 'SONIC BOOM'; this.resultT = 0 }
      }
    } else if (this.vy > -70) {
      this.boomed = false
      this.boomCharge = 0
    }
    if (this.boomT < 1) {
      // Ring expands fast + fades; the cone blooms wide and flat behind the diver.
      this.boomT = Math.min(1, this.boomT + dt * 1.5)
      const e = this.boomT
      this.boomRing.position.copy(this.pos)
      this.boomRing.scale.setScalar(2 + e * 120)
      this.boomMat.opacity = 0.9 * (1 - e)
      this.boomCone.position.set(this.pos.x, this.pos.y + 3 - e * 8, this.pos.z) // trails up the dive line
      const cr = 2 + e * 80
      this.boomCone.scale.set(cr, 6 + e * 40, cr)
      this.boomConeMat.opacity = 0.55 * (1 - e) * (1 - e)
      if (this.boomT >= 1) { this.boomRing.visible = false; this.boomCone.visible = false }
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
    // Climbing the standings is felt per-overtake: a camera kick + a transient
    // label, gated so it never stomps a SONIC BOOM / PORTAL result on screen.
    if (this.phase === 'dive' && this.prevPlace > 0 && this.racePlace < this.prevPlace) {
      this.kick(0.5)
      if (!this.hud.result || this.hud.result.startsWith('BOOST') || this.hud.result.startsWith('PERFECT')) {
        this.hud.result = this.racePlace === 1 ? 'TOOK THE LEAD' : 'PASSED RIVAL'
        this.resultT = 0
      }
    }
    this.prevPlace = this.racePlace
  }

  private updateStreaks(dt: number, fast: boolean) {
    if (this.streakBurst > 0) this.streakBurst = Math.max(0, this.streakBurst - dt)
    const burst = this.streakBurst > 0
    const m = this.streaks.material as THREE.PointsMaterial
    m.opacity = THREE.MathUtils.damp(m.opacity, burst ? 1 : fast ? 0.85 : 0.3, burst ? 12 : 5, dt)
    this.streaks.position.copy(this.pos)
    // Rewriting the 130-point buffer + re-uploading it (needsUpdate) every frame is
    // a real GPU stall on mobile, and this runs through the whole opening drop-in.
    // On the low tier do it every other frame (accumulating dt so the lines still
    // rise at the right speed); the cheap opacity/position above stay per-frame.
    this.streakDt += dt
    if (config.tier.name === 'low') { this.streakTick ^= 1; if (this.streakTick === 0) return }
    const sdt = this.streakDt
    this.streakDt = 0
    const fp = (this.streaks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    const rise = burst ? 86 : fast ? 54 : 20
    for (let i = 0; i < this.streakVel.length; i++) {
      const j = i * 3 + 1
      fp[j] += (this.streakVel[i] + rise) * sdt
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
      // Under canopy: a slower, calmer cam — sit a bit FARTHER back and ABOVE than
      // the dive (the chute + diver read against the sky) and aim down the glide
      // path so the ground you're steering toward fills the centre. (Y offsets
      // folded in to avoid per-frame Vector3 allocs.)
      want = this.camPos.copy(this.pos).addScaledVector(this.fwd, -9.5); want.y += 5.0
      lookWant = this.camLook.copy(this.pos).addScaledVector(this.fwd, 9); lookWant.y -= 4.0
    } else {
      // Dive: third-person chase from behind + ABOVE, looking DOWN over the diver
      // along the fall line at the city/portal below. Target framing — robot in the
      // lower third, the destination centred, a sliver of horizon up top. The camera
      // sits above the diver and aims at a point well AHEAD-and-down, so the diver
      // (close, below the camera) projects into the lower third while the distant
      // ground fills the centre. Medium distance: the path reads, the robot stays a
      // good size (not tiny, not blocking). Steeper dive -> a touch higher + further
      // down the line.
      const steep = Math.min(1, this.pitch * 1.05)
      const back = THREE.MathUtils.lerp(8.5, 7.2, steep) // medium chase distance
      const up = THREE.MathUtils.lerp(3.2, 6.2, steep)   // above the diver, higher when steep
      const ahead = THREE.MathUtils.lerp(7.0, 12.0, steep) // look down the fall line
      const down = THREE.MathUtils.lerp(3.2, 7.5, steep) // modest down so the robot stays low, not centred
      want = this.camPos.copy(this.pos).addScaledVector(this.fwd, -back); want.y += up
      lookWant = this.camLook.copy(this.pos).addScaledVector(this.fwd, ahead); lookWant.y -= down
    }
    // Ground/roof clearance: the drop camera has no other collision, so on the
    // steep look-down near touchdown its above-behind spot can sink into terrain,
    // decks or rooftops. Only sample the ground when actually low - up high the
    // camera is nowhere near the ground, and a raycast every sim step (it allocates)
    // is what made the long descent hiccup on desktop.
    if (this.lastAlt < 140) {
      const camFloor = this.getGround(want.x, want.z) + 2.5
      if (want.y < camFloor) want.y = camFloor
    }
    // The dive falls FAST (up to ~88 m/s), so a slow lerp leaves the camera
    // lagging tens of metres behind and the robot reads tiny. Follow tightly while
    // diving; the slower canopy phase can ease more gently.
    if (snap) this.cam.position.copy(want)
    else this.cam.position.lerp(want, this.phase === 'canopy' ? 0.12 : 0.34)
    // Transient shake from cloud punch-throughs / the sonic boom. This is a
    // ROTATIONAL shake - we jitter the LOOK TARGET, never the camera position.
    // A positional shake on the close-trailing dive camera kept shoving its near
    // plane into nearby geometry (the diver, clouds, drop props), which flashed
    // dark for a frame - the "black flicker while skydiving", and worse on mobile.
    // Wobbling only the aim keeps every bit of the impact with zero clipping.
    if (this.camShake > 0.01) {
      // Mobile gets a much gentler shake (it read as jarring there anyway).
      const j = this.camShake * (config.tier.name === 'low' ? 0.6 : 1.2)
      lookWant.x += (Math.random() - 0.5) * j
      lookWant.y += (Math.random() - 0.5) * j
      lookWant.z += (Math.random() - 0.5) * j
      this.camShake *= 0.86
    }
    // Hand-off ease: blend position + aim from the on-foot view into the dive view.
    if (this.camEase > 0) {
      const p = 1 - this.camEase
      const pe = p * p * (3 - 2 * p) // smoothstep
      this.cam.position.lerpVectors(this.camFrom, want, pe)
      this.easeLook.lerpVectors(this.lookFrom, lookWant, pe)
      this.cam.lookAt(this.easeLook)
    } else {
      this.cam.lookAt(lookWant)
    }
  }

  dispose() {
    this.scene.remove(this.group)
    this.rb.dispose()
    this.helper?.dispose()
    for (const t of this.traffic) t.v.dispose()
    this.geos.forEach((g) => g.dispose())
    this.mats.forEach((m) => m.dispose())
    this.texs.forEach((t) => t.dispose())
    this.cloudTex?.dispose()
  }
}
