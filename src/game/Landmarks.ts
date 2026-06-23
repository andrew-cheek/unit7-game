import * as THREE from 'three'
import { config } from './config'
import type { Physics } from './Physics'
import type { MinigameKind } from './types'

/**
 * Static hub fixtures: a walk-in neon ARCADE building (the games are doors you
 * step into, each with a stylized preview + name), the Portal Plaza hero ring,
 * and the rocket launch gate. Built once at startup and added to the scene.
 *
 * Game owns the data + per-frame behaviour; this only builds meshes. Created
 * geos/mats/texs are returned so Game's disposal path frees them. Building wall
 * meshes are pushed into `solids` so the third-person camera collides with them.
 */
export interface ArcadeCabinet {
  kind: MinigameKind
  pos: THREE.Vector3 // stand-here trigger point in front of the door
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
  mats: THREE.Material[]
  geos: THREE.BufferGeometry[]
  texs: THREE.CanvasTexture[]
}

/** The eight cabinet games, in door order (kind, accent color, marquee name). */
const GAMES: { kind: MinigameKind; color: number; name: string }[] = [
  { kind: 'beamwars', color: 0x27e7ff, name: 'BEAM WARS' },
  { kind: 'snake', color: 0x8a5cff, name: 'SNAKE' },
  { kind: 'invaders', color: 0x9bff4d, name: 'INVADERS' },
  { kind: 'raceloop', color: 0xff2bd0, name: 'RACE LOOP' },
  { kind: 'digduel', color: 0xff8a1e, name: 'DIG DUEL' },
  { kind: 'mecharena', color: 0xff8a1e, name: 'MECH ARENA' },
  { kind: 'merge2048', color: 0xff2bd0, name: '2048' },
  { kind: 'drivemad', color: 0x9bff4d, name: 'DRIVE FRENZY' },
]

/** A neon text label baked to a canvas texture for a billboard sprite. */
function makeLabelTexture(text: string, color = 0x27e7ff): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = 512
  cv.height = 128
  const ctx = cv.getContext('2d')!
  ctx.clearRect(0, 0, cv.width, cv.height)
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

/** A stylized "screenshot" of a game: an iconic motif in its accent color. */
function arcadeThumbnail(kind: MinigameKind, color: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = 256
  cv.height = 192
  const ctx = cv.getContext('2d')!
  const col = '#' + color.toString(16).padStart(6, '0')
  ctx.fillStyle = '#070b12'
  ctx.fillRect(0, 0, 256, 192)
  ctx.strokeStyle = col
  ctx.lineWidth = 6
  ctx.strokeRect(5, 5, 246, 182)
  ctx.save()
  ctx.translate(128, 92)
  ctx.strokeStyle = col
  ctx.fillStyle = col
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  const box = (x: number, y: number, w: number, h: number) => ctx.fillRect(x, y, w, h)
  switch (kind) {
    case 'beamwars': {
      ctx.beginPath(); ctx.moveTo(-95, -55); ctx.lineTo(95, 55); ctx.moveTo(-95, 55); ctx.lineTo(95, -55); ctx.stroke()
      ctx.fillStyle = '#eaf6ff'; ctx.beginPath(); ctx.arc(0, 0, 9, 0, 7); ctx.fill()
      break
    }
    case 'snake': {
      const s = 18
      const cells = [[-3, 1], [-2, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [2, -1]]
      cells.forEach(([cx, cy]) => box(cx * s, cy * s, s - 3, s - 3))
      ctx.fillStyle = '#ff5050'; box(3 * s, -1 * s, s - 3, s - 3) // apple
      break
    }
    case 'invaders': {
      const s = 20
      for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) box(-90 + c * s + 3, -50 + r * s, s - 7, s - 9)
      ctx.fillStyle = '#eaf6ff'; box(-8, 55, 16, 8) // cannon
      break
    }
    case 'raceloop': {
      ctx.beginPath(); ctx.ellipse(0, 0, 90, 50, 0, 0, 7); ctx.stroke()
      ctx.lineWidth = 18; ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.ellipse(0, 0, 90, 50, 0, 0, 7); ctx.stroke()
      ctx.fillStyle = '#eaf6ff'; box(78, -8, 16, 16) // car
      break
    }
    case 'digduel': {
      ctx.fillStyle = '#5a3a1c'; ctx.fillRect(-100, 10, 200, 70) // dirt
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(-20, -40); ctx.lineTo(20, -40); ctx.lineTo(0, 30); ctx.closePath(); ctx.fill() // drill
      break
    }
    case 'mecharena': {
      box(-22, -45, 44, 50)        // torso
      box(-30, -58, 60, 16)        // shoulders
      box(-12, -78, 24, 20)        // head
      box(-30, 8, 16, 40); box(14, 8, 16, 40) // legs
      break
    }
    case 'merge2048': {
      const vals = ['2', '4', '8', '16']; const s = 52
      ctx.font = '800 26px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      let i = 0
      for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) {
        const x = -s + c * s, y = -s + r * s
        ctx.fillStyle = ['#27e7ff', '#8a5cff', '#ff8a1e', '#ff2bd0'][i]
        ctx.fillRect(x + 4, y + 4, s - 8, s - 8)
        ctx.fillStyle = '#0b0e16'; ctx.fillText(vals[i], x + s / 2, y + s / 2)
        i++
      }
      break
    }
    case 'drivemad': {
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 4
      ctx.beginPath(); ctx.moveTo(-90, 60); ctx.lineTo(-30, -60); ctx.moveTo(90, 60); ctx.lineTo(30, -60); ctx.stroke() // road
      ctx.setLineDash([14, 14]); ctx.beginPath(); ctx.moveTo(0, 60); ctx.lineTo(0, -60); ctx.stroke(); ctx.setLineDash([])
      ctx.fillStyle = col; box(-18, 12, 36, 40) // car
      break
    }
  }
  ctx.restore()
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function buildLandmarks(scene: THREE.Scene, physics: Physics, solids: THREE.Object3D[]): LandmarksResult {
  const mats: THREE.Material[] = []
  const geos: THREE.BufferGeometry[] = []
  const texs: THREE.CanvasTexture[] = []
  const own = <T extends THREE.Material>(m: T) => { mats.push(m); return m }
  const ownG = <T extends THREE.BufferGeometry>(g: T) => { geos.push(g); return g }

  const arcadePortals: ArcadeCabinet[] = []

  // ===========================================================================
  // ARCADE BUILDING — the walk-in hub. Doors = games. Sits just north of spawn
  // so it's the first thing you see; the Mars ring (below) is in front of it.
  // ===========================================================================
  {
    const CX = 0, CZ = 46 // building center
    const W = 44, D = 36, H = 14, t = 0.7 // bigger hall so the games read + you have room to walk
    const gy = physics.sampleGround(CX, CZ, 60)?.y ?? 0
    const frontZ = CZ - D / 2, backZ = CZ + D / 2
    const leftX = CX - W / 2, rightX = CX + W / 2
    const ENTRANCE = 13 // wide front opening (walk + camera room)

    const wallMat = own(new THREE.MeshStandardMaterial({ color: 0x14171f, metalness: 0.4, roughness: 0.6 }))
    const trimMat = own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, fog: false }))
    const trimMagenta = own(new THREE.MeshBasicMaterial({ color: config.palette.magenta, fog: false }))
    const floorMat = own(new THREE.MeshStandardMaterial({ color: 0x0c1019, metalness: 0.6, roughness: 0.35 }))

    const wall = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(ownG(new THREE.BoxGeometry(w, h, d)), wallMat)
      m.position.set(x, gy + y, z)
      m.castShadow = true; m.receiveShadow = true
      scene.add(m)
      solids.push(m) // camera collides with the building
      physics.colliders.push(new THREE.Box3(
        new THREE.Vector3(x - w / 2, gy, z - d / 2),
        new THREE.Vector3(x + w / 2, gy + h, z + d / 2),
      ))
      return m
    }
    // back + side walls
    wall(W, H, t, CX, H / 2, backZ)
    wall(t, H, D, leftX, H / 2, CZ)
    wall(t, H, D, rightX, H / 2, CZ)
    // front wall as two segments flanking the entrance
    const segW = (W - ENTRANCE) / 2
    wall(segW, H, t, CX - (ENTRANCE / 2 + segW / 2), H / 2, frontZ)
    wall(segW, H, t, CX + (ENTRANCE / 2 + segW / 2), H / 2, frontZ)
    // lintel over the entrance
    const lintel = new THREE.Mesh(ownG(new THREE.BoxGeometry(ENTRANCE + 1, H - 6, t)), wallMat)
    lintel.position.set(CX, gy + 6 + (H - 6) / 2, frontZ)
    lintel.castShadow = true
    scene.add(lintel)

    // floor
    const floor = new THREE.Mesh(ownG(new THREE.BoxGeometry(W - t, 0.1, D - t)), floorMat)
    floor.position.set(CX, gy + 0.05, CZ)
    floor.receiveShadow = true
    scene.add(floor)

    // Interior lighting so the room + doors read (cheap, no shadows). The main
    // cool key always lights the hall; the two colored fills are accent-only, so
    // the low/mobile tier sheds them like World's accent lights do.
    const lampA = new THREE.PointLight(0x9fe8ff, 2.2, 60, 2); lampA.position.set(CX, gy + 11, CZ); scene.add(lampA)
    if (config.tier.accentLights) {
      const lampB = new THREE.PointLight(0xff2bd0, 1.1, 40, 2); lampB.position.set(CX, gy + 6, frontZ + 6); scene.add(lampB)
      const lampC = new THREE.PointLight(0x27e7ff, 1.1, 40, 2); lampC.position.set(CX, gy + 6, backZ - 6); scene.add(lampC)
    }

    // roof: open frame (perimeter beams + a couple crossbeams) so the third-person
    // camera has headroom inside but it still reads as a roofed building.
    const beam = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(ownG(new THREE.BoxGeometry(w, 0.6, d)), wallMat)
      m.position.set(x, gy + H, z); scene.add(m)
    }
    beam(W, t, CX, frontZ); beam(W, t, CX, backZ)
    beam(t, D, leftX, CZ); beam(t, D, rightX, CZ)
    beam(t, D, CX - W / 4, CZ); beam(t, D, CX + W / 4, CZ)

    // neon trim along the top edge of the front + a big ARCADE marquee
    const frontTrim = new THREE.Mesh(ownG(new THREE.BoxGeometry(W, 0.4, 0.4)), trimMat)
    frontTrim.position.set(CX, gy + H - 0.4, frontZ - 0.2); scene.add(frontTrim)
    const entryGlowL = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.4, 6, 0.4)), trimMagenta)
    entryGlowL.position.set(CX - ENTRANCE / 2, gy + 3, frontZ - 0.2); scene.add(entryGlowL)
    const entryGlowR = entryGlowL.clone(); entryGlowR.position.x = CX + ENTRANCE / 2; scene.add(entryGlowR)

    // Big "ENTER ARCADE" marquee over the entrance.
    const marqueeTex = makeLabelTexture('ENTER ARCADE', config.palette.cyan); texs.push(marqueeTex)
    const marquee = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: marqueeTex, transparent: true, depthWrite: false })))
    marquee.position.set(CX, gy + H + 4, frontZ - 0.5)
    marquee.scale.set(30, 7.5, 1); scene.add(marquee)

    // The arcade is a full SKYSCRAPER rising from the walk-in hall: a tall mass
    // over almost the whole footprint, neon-banded so it's unmistakable from
    // anywhere in the city.
    const TOWER_H = 168
    const towerTopY = gy + H + TOWER_H
    const towerW = W * 0.88, towerD = D * 0.66
    const towerMat = own(new THREE.MeshStandardMaterial({ color: 0x0a0c16, emissive: config.palette.purple, emissiveIntensity: 0.7, metalness: 0.55, roughness: 0.4 }))
    const tower = new THREE.Mesh(ownG(new THREE.BoxGeometry(towerW, TOWER_H, towerD)), towerMat)
    tower.position.set(CX, gy + H + TOWER_H / 2, CZ)
    tower.castShadow = true
    scene.add(tower); solids.push(tower)
    // Collider starts at the hall CEILING (gy + H), not the ground, so the
    // walk-in hall below stays clear - the tower mass is only solid above it.
    physics.colliders.push(new THREE.Box3(
      new THREE.Vector3(CX - towerW / 2, gy + H, CZ - towerD / 2),
      new THREE.Vector3(CX + towerW / 2, towerTopY, CZ + towerD / 2),
    ))
    const towerFrontZ = CZ - towerD / 2 - 0.1 // face toward spawn
    // Stacked horizontal neon bands up the full height (alternating hues).
    const bands = Math.floor(TOWER_H / 12)
    for (let k = 0; k < bands; k++) {
      const band = new THREE.Mesh(ownG(new THREE.BoxGeometry(towerW + 0.4, 0.8, 0.4)), k % 2 ? trimMat : trimMagenta)
      band.position.set(CX, gy + H + 8 + k * 12, towerFrontZ)
      scene.add(band)
    }
    // Vertical neon pin-stripes framing the facade.
    for (const sx of [-towerW / 2 + 1, 0, towerW / 2 - 1]) {
      const stripe = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.6, TOWER_H - 4, 0.4)), trimMat)
      stripe.position.set(CX + sx, gy + H + TOWER_H / 2, towerFrontZ)
      scene.add(stripe)
    }
    // Two giant glowing "screen" panels on the facade so it reads as an arcade.
    for (const yy of [gy + H + TOWER_H * 0.35, gy + H + TOWER_H * 0.68]) {
      const screen = new THREE.Mesh(ownG(new THREE.BoxGeometry(towerW * 0.6, 18, 0.6)), own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.cyan, emissiveIntensity: 1.8, roughness: 0.4 })))
      screen.position.set(CX, yy, towerFrontZ - 0.3)
      scene.add(screen)
    }
    // Crowning hero sign high up + a glowing roof ring beacon.
    const topTex = makeLabelTexture('ARCADE', config.palette.magenta); texs.push(topTex)
    const topSign = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: topTex, transparent: true, depthWrite: false })))
    topSign.position.set(CX, towerTopY - 16, towerFrontZ - 1)
    topSign.scale.set(34, 17, 1); scene.add(topSign)
    const capMat = own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, fog: false }))
    const cap = new THREE.Mesh(ownG(new THREE.TorusGeometry(towerW * 0.4, 0.7, 8, 30)), capMat)
    cap.rotation.x = Math.PI / 2
    cap.position.set(CX, towerTopY + 0.5, CZ)
    scene.add(cap)

    // Big back-wall header so the hall reads as "pick a game".
    const headerTex = makeLabelTexture('SELECT A GAME', config.palette.cyan); texs.push(headerTex)
    const header = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: headerTex, transparent: true, depthWrite: false })))
    header.position.set(CX, gy + H - 2.4, backZ - 1.2)
    header.scale.set(20, 5, 1); scene.add(header)

    // ---- doors: 4 on each side wall, facing inward. Big lit preview screens. ----
    const perSide = 4
    const z0 = frontZ + 5, z1 = backZ - 4
    const doorThumbGeo = ownG(new THREE.PlaneGeometry(4.8, 3.6))
    const padGeo = ownG(new THREE.RingGeometry(1.8, 2.4, 28))
    for (let i = 0; i < GAMES.length; i++) {
      const g = GAMES[i]
      const side = i < perSide ? -1 : 1 // left wall first, then right
      const idx = i % perSide
      const z = THREE.MathUtils.lerp(z0, z1, idx / (perSide - 1))
      const wallX = side === -1 ? leftX + t / 2 : rightX - t / 2
      const inward = -side // doors on the left wall face +X, etc.
      const door = new THREE.Group()
      door.position.set(wallX, gy, z)
      door.name = 'arcade-door-' + g.kind
      door.userData.minigameKind = g.kind

      // recessed door frame (big arcade-cabinet portal)
      const frame = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.4, 7, 5)), own(new THREE.MeshStandardMaterial({ color: 0x05070c, metalness: 0.5, roughness: 0.4 })))
      frame.position.set(inward * 0.16, 3.6, 0)
      door.add(frame)
      // bright neon trim around the door (the screen material Game pulses)
      const screenMat = own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: g.color, emissiveIntensity: 2.2, roughness: 0.4 }))
      const trimTop = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.44, 0.28, 5.1)), screenMat)
      trimTop.position.set(inward * 0.18, 7.1, 0); door.add(trimTop)
      for (const sz of [-2.5, 2.5]) {
        const post = new THREE.Mesh(ownG(new THREE.BoxGeometry(0.44, 7, 0.28)), screenMat)
        post.position.set(inward * 0.18, 3.5, sz); door.add(post)
      }
      // large preview "screenshot" panel set in the doorway, facing inward
      const thumbTex = arcadeThumbnail(g.kind, g.color); texs.push(thumbTex)
      const thumb = new THREE.Mesh(doorThumbGeo, own(new THREE.MeshBasicMaterial({ map: thumbTex, toneMapped: false })))
      thumb.position.set(inward * 0.22, 3.7, 0)
      thumb.rotation.y = inward > 0 ? Math.PI / 2 : -Math.PI / 2
      door.add(thumb)
      // game name above the door (bigger)
      const nameTex = makeLabelTexture(g.name, g.color); texs.push(nameTex)
      const name = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: nameTex, transparent: true, depthWrite: false })))
      name.position.set(inward * 0.3, 8.0, 0)
      name.scale.set(6.4, 1.6, 1); door.add(name)
      scene.add(door)

      // stand-here pad + trigger point in front of the door (toward room center)
      const padX = wallX + inward * 3.0
      const pad = new THREE.Mesh(padGeo, own(new THREE.MeshBasicMaterial({ color: g.color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      pad.rotation.x = -Math.PI / 2
      pad.position.set(padX, gy + 0.12, z)
      scene.add(pad)

      arcadePortals.push({ kind: g.kind, pos: new THREE.Vector3(padX, gy, z), group: door, screenMat })
    }
  }

  // ===========================================================================
  // PORTAL PLAZA hero ring (Mars gateway) — set off to the EAST of the spawn axis
  // so it no longer blocks the line of sight to the arcade tower straight ahead.
  // ===========================================================================
  let plazaHub: PlazaHub
  let plazaMars: { pos: THREE.Vector3; radius: number }
  {
    const cx = 46, cz = 12
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
    let beamMat: THREE.MeshBasicMaterial | null = null
    if (config.tier.fxScale >= 0.6) {
      const beam = new THREE.Mesh(ownG(new THREE.CylinderGeometry(1.4, 2.6, 220, 20, 1, true)), own(new THREE.MeshBasicMaterial({ color: 0xffb14a, transparent: true, opacity: 0.12, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
      beam.position.y = 110
      beam.renderOrder = 4
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

  // ===========================================================================
  // ROCKET launch gate.
  // ===========================================================================
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
