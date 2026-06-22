import * as THREE from 'three'
import { config } from './config'
import type { Physics } from './Physics'
import type { MinigameKind } from './types'

/**
 * Static hub fixtures: the arcade cabinet row (each bound to a 2D minigame), the
 * colossal ARCADE marquee, the Portal Plaza hero ring, and the rocket launch
 * gate. Pure construction, built once at startup and added to the scene.
 *
 * Extracted out of Game.ts (which was a 2,400-line god object). Game owns the
 * data and the per-frame behaviour (proximity, pulsing, travel); this module
 * only builds the meshes. Created geometries/materials/textures are returned in
 * `geos`/`mats`/`texs` so Game's existing disposal path can free them.
 */
export interface ArcadeCabinet {
  kind: MinigameKind
  pos: THREE.Vector3
  group: THREE.Group
  screenMat: THREE.MeshStandardMaterial
}
export interface PlazaHub {
  group: THREE.Group
  ring: THREE.Mesh
  ring2: THREE.Mesh
  beamMat: THREE.MeshBasicMaterial | null
}
export interface LandmarksResult {
  arcadePortals: ArcadeCabinet[]
  plazaHub: PlazaHub
  plazaMars: { pos: THREE.Vector3; radius: number }
  rocketGate: THREE.Group
  // Disposal sinks — Game pushes these into its arcade dispose arrays.
  mats: THREE.Material[]
  geos: THREE.BufferGeometry[]
  texs: THREE.CanvasTexture[]
}

/** A neon text label baked to a canvas texture for a billboard sprite. */
function makeLabelTexture(text: string, color = 0x27e7ff): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = 512
  cv.height = 128
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, cv.width, cv.height)
  // Shrink the font until the label fits the canvas, so longer signage
  // ("LAUNCH -> MARS / MOON") doesn't clip at the edges.
  let size = 72
  ctx.font = `800 ${size}px ui-monospace, Menlo, monospace`
  while (size > 30 && ctx.measureText(text).width > cv.width - 36) {
    size -= 4
    ctx.font = `800 ${size}px ui-monospace, Menlo, monospace`
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = '#' + color.toString(16).padStart(6, '0')
  ctx.shadowBlur = 22
  ctx.fillStyle = '#eaf6ff'
  ctx.fillText(text, cv.width / 2, cv.height / 2)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function buildLandmarks(scene: THREE.Scene, physics: Physics): LandmarksResult {
  const mats: THREE.Material[] = []
  const geos: THREE.BufferGeometry[] = []
  const texs: THREE.CanvasTexture[] = []
  const own = <T extends THREE.Material>(m: T) => { mats.push(m); return m }
  const ownG = <T extends THREE.BufferGeometry>(g: T) => { geos.push(g); return g }

  /**
   * Builds the cabinet fixture: a dark body with a glowing screen and marquee
   * facing the approaching player (toward -Z / the spawn), a control lip, and a
   * faint stand-here floor pad. Returns the group and the screen material so the
   * update loop can pulse it.
   */
  const makeCabinet = (color: number, label: string, pos: THREE.Vector3) => {
    const gy = physics.sampleGround(pos.x, pos.z, 40)?.y ?? 0
    pos.y = gy
    const g = new THREE.Group()
    g.position.set(pos.x, gy, pos.z)
    const bodyMat = own(new THREE.MeshStandardMaterial({ color: 0x0b0e16, metalness: 0.5, roughness: 0.5 }))
    const trimMat = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 1.6, roughness: 0.4 }))
    const screenMat = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: color, emissiveIntensity: 1.5, roughness: 0.3 }))

    const body = new THREE.Mesh(ownG(new THREE.BoxGeometry(3.2, 4.2, 1.8)), bodyMat)
    body.position.y = 2.1
    g.add(body)
    // Glowing screen, tilted back slightly, on the front (-Z) face.
    const tex = makeLabelTexture(label, color)
    texs.push(tex)
    const screenFace = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 1.4, roughness: 0.3 }))
    const screen = new THREE.Mesh(ownG(new THREE.PlaneGeometry(2.5, 1.6)), screenFace)
    screen.position.set(0, 2.6, -0.92)
    screen.rotation.x = 0.12
    g.add(screen)
    // Marquee header strip.
    const marquee = new THREE.Mesh(ownG(new THREE.BoxGeometry(3.0, 0.5, 0.2)), trimMat)
    marquee.position.set(0, 4.0, -0.85)
    g.add(marquee)
    // Side neon trim.
    for (const sx of [-1.55, 1.55]) {
      const strip = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.12, 3.6, 0.12)), trimMat)
      strip.position.set(sx, 2.2, -0.86)
      g.add(strip)
    }
    // Stand-here floor pad.
    const pad = new THREE.Mesh(ownG(new THREE.RingGeometry(1.4, 1.8, 28)), own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    pad.rotation.x = -Math.PI / 2
    pad.position.set(0, 0.06, -2.2)
    g.add(pad)
    // Keep the body from being walked through.
    physics.colliders.push(new THREE.Box3(
      new THREE.Vector3(pos.x - 1.6, 0, pos.z - 0.9),
      new THREE.Vector3(pos.x + 1.6, 4.2, pos.z + 0.9),
    ))
    scene.add(g)
    return { group: g, screenMat }
  }

  const buildCabinet = (kind: MinigameKind, color: number, label: string, pos: THREE.Vector3): ArcadeCabinet => {
    const { group, screenMat } = makeCabinet(color, label, pos)
    return { kind, pos: pos.clone(), group, screenMat }
  }

  const A = config.palette
  const arcadePortals: ArcadeCabinet[] = [
    buildCabinet('beamwars', A.cyan, 'BEAM WARS', new THREE.Vector3(-18, 0, 12)),
    buildCabinet('snake', A.purple, 'SNAKE', new THREE.Vector3(18, 0, 12)),
    buildCabinet('digduel', A.orange, 'DIG DUEL', new THREE.Vector3(-46, 0, 26)),
    buildCabinet('invaders', A.lime, 'INVADERS', new THREE.Vector3(46, 0, 26)),
    buildCabinet('raceloop', A.magenta, 'RACE LOOP', new THREE.Vector3(-34, 0, 46)),
    buildCabinet('mecharena', A.orange, 'MECH ARENA', new THREE.Vector3(34, 0, 46)),
    buildCabinet('merge2048', A.magenta, '2048', new THREE.Vector3(-12, 0, 56)),
    buildCabinet('drivemad', A.lime, 'DRIVE FRENZY', new THREE.Vector3(12, 0, 56)),
  ]

  // ARCADE marquee sprite above the (Vehicles-owned) titan at the back.
  {
    const x = 0, z = 44
    const gy = physics.sampleGround(x, z, 60)?.y ?? 0
    const tex = makeLabelTexture('ARCADE', config.palette.cyan)
    texs.push(tex)
    const signMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
    mats.push(signMat)
    const sign = new THREE.Sprite(signMat)
    sign.position.set(0, gy + 30, z - 6)
    sign.scale.set(30, 7.5, 1)
    scene.add(sign)
  }

  // Portal Plaza hero landmark: big glowing Mars gateway ring, sky beam, ground ring.
  let plazaHub: PlazaHub
  let plazaMars: { pos: THREE.Vector3; radius: number }
  {
    const cx = 0, cz = 13
    const g = new THREE.Group()
    const gy = physics.sampleGround(cx, cz, 40)?.y ?? 0
    g.position.set(cx, gy, cz)
    const mars = config.palette.orange
    const ring = new THREE.Mesh(ownG(new THREE.TorusGeometry(6, 0.5, 18, 56)), own(new THREE.MeshBasicMaterial({ color: mars, fog: false })))
    ring.position.y = 7
    g.add(ring)
    const ring2 = new THREE.Mesh(ownG(new THREE.TorusGeometry(4.4, 0.28, 14, 48)), own(new THREE.MeshBasicMaterial({ color: 0xffd9a8, fog: false })))
    ring2.position.y = 7
    g.add(ring2)
    const disc = new THREE.Mesh(ownG(new THREE.CircleGeometry(5.7, 40)), own(new THREE.MeshBasicMaterial({ color: mars, transparent: true, opacity: 0.18, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    disc.position.y = 7
    g.add(disc)
    const labelTex = makeLabelTexture('MARS', mars)
    texs.push(labelTex)
    const label = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false })))
    label.position.set(0, 15, 0)
    label.scale.set(9, 2.25, 1)
    g.add(label)
    // Tall sky beam — skipped on the low (mobile) tier to save full-height overdraw.
    let beamMat: THREE.MeshBasicMaterial | null = null
    if (config.tier.fxScale >= 0.6) {
      const beam = new THREE.Mesh(ownG(new THREE.CylinderGeometry(1.4, 2.6, 220, 20, 1, true)), own(new THREE.MeshBasicMaterial({ color: 0xffb14a, transparent: true, opacity: 0.12, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      beam.position.y = 110
      beam.renderOrder = 4 // stable sort slot (additive-flicker fix)
      g.add(beam)
      beamMat = beam.material as THREE.MeshBasicMaterial
    }
    const decal = new THREE.Mesh(ownG(new THREE.RingGeometry(8, 9.2, 48)), own(new THREE.MeshBasicMaterial({ color: mars, transparent: true, opacity: 0.26, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    decal.rotation.x = -Math.PI / 2
    decal.position.y = 0.15
    g.add(decal)
    scene.add(g)
    plazaHub = { group: g, ring, ring2, beamMat }
    plazaMars = { pos: new THREE.Vector3(cx, gy, cz), radius: 4.5 }
  }

  // Rocket launch gate: ground ring + tall sign on the parked rocket.
  let rocketGate: THREE.Group
  {
    const x = 2, z = -20
    const gy = physics.sampleGround(x, z, 40)?.y ?? 0
    const g = new THREE.Group()
    g.position.set(x, gy, z)
    const ring = new THREE.Mesh(ownG(new THREE.RingGeometry(5, 6.3, 44)), own(new THREE.MeshBasicMaterial({ color: config.palette.orange, transparent: true, opacity: 0.45, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.14
    g.add(ring)
    const tex = makeLabelTexture('LAUNCH → MARS / MOON', config.palette.orange)
    texs.push(tex)
    const sign = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })))
    sign.position.set(0, 17, 0)
    sign.scale.set(15, 3.75, 1)
    g.add(sign)
    scene.add(g)
    rocketGate = g
  }

  return { arcadePortals, plazaHub, plazaMars, rocketGate, mats, geos, texs }
}
