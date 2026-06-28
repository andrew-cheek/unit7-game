// WarpForms - the seven sci-fi things you can teleport into.
//
// Each form is a compact procedural model (a Group + a tiny idle animator) plus
// a bit of movement flavour (speed multiplier + a hover offset). The game hides
// the player's robot and shows the chosen form at the player's transform while
// warped. Built from primitives with emissive / additive glow so they read as
// energy constructs without textures. Disposed when you warp out.

import * as THREE from 'three'
import { config } from './config'

export interface WarpFormMeta {
  id: string
  name: string
  desc: string
  color: number // accent colour (hex) for the menu + glow
  speedMul: number // movement speed vs the robot
}

export interface WarpFormModel {
  group: THREE.Group
  update: (dt: number) => void
  dispose: () => void
}

// Menu/meta for all seven forms (shared with the HUD picker).
export const WARP_FORMS: WarpFormMeta[] = [
  { id: 'drone', name: 'RECON DRONE', desc: 'Nimble hover-eye', color: 0x27e7ff, speedMul: 1.35 },
  { id: 'wraith', name: 'PLASMA WRAITH', desc: 'Phasing energy phantom', color: 0xb46bff, speedMul: 1.5 },
  { id: 'fighter', name: 'STAR FIGHTER', desc: 'Personal void interceptor', color: 0xff8a1e, speedMul: 1.8 },
  { id: 'golem', name: 'CRYSTAL GOLEM', desc: 'Heavy shard construct', color: 0x6fe8c8, speedMul: 0.95 },
  { id: 'orb', name: 'ENERGY ORB', desc: 'Pulsing ringed core', color: 0xffd24a, speedMul: 1.6 },
  { id: 'cube', name: 'QUANTUM CUBE', desc: 'Tumbling tesseract', color: 0x9bff4d, speedMul: 1.2 },
  { id: 'saucer', name: 'SCOUT SAUCER', desc: 'Classic flying disc', color: 0xff2bd0, speedMul: 1.45 },
]

export function isWarpForm(id: string): boolean {
  return WARP_FORMS.some((f) => f.id === id)
}

export function hoverOffset(id: string): number {
  // Flying forms float above the ground; the golem stands on it.
  return id === 'golem' ? 0 : 1.1
}

/** Build the model for a form id. Caller adds `group` to the scene. */
export function createWarpForm(id: string): WarpFormModel {
  switch (id) {
    case 'wraith': return buildWraith()
    case 'fighter': return buildFighter()
    case 'golem': return buildGolem()
    case 'orb': return buildOrb()
    case 'cube': return buildCube()
    case 'saucer': return buildSaucer()
    default: return buildDrone()
  }
}

// --- helpers -----------------------------------------------------------------

// Identity passthrough kept for readability at the build sites; each form's
// geometries + materials are disposed by traversing its own group on teardown.
const g = <T extends THREE.BufferGeometry>(x: T): T => x
function glow(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
}
function solid(color: number, emissive: number, ei = 1.4): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: ei, metalness: 0.6, roughness: 0.35 })
}
function disposer(group: THREE.Group, mats: THREE.Material[]) {
  return () => {
    group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose() })
    mats.forEach((m) => m.dispose())
  }
}

// --- forms -------------------------------------------------------------------

function buildDrone(): WarpFormModel {
  const group = new THREE.Group()
  const body = solid(0x10202c, 0x27e7ff, 1.6)
  const eyeMat = glow(0x9fe8ff)
  const disc = new THREE.Mesh(g(new THREE.CylinderGeometry(0.7, 0.85, 0.32, 16)), body)
  disc.position.y = 1.4
  const eye = new THREE.Mesh(g(new THREE.SphereGeometry(0.28, 16, 16)), eyeMat)
  eye.position.set(0, 1.4, 0.6)
  const ringMat = glow(0x27e7ff, 0.8)
  const ring = new THREE.Mesh(g(new THREE.TorusGeometry(0.95, 0.06, 8, 32)), ringMat)
  ring.rotation.x = Math.PI / 2
  ring.position.y = 1.4
  group.add(disc, eye, ring)
  const mats = [body, eyeMat, ringMat]
  return { group, update: (dt) => { disc.rotation.y += dt * 1.5; ring.rotation.z += dt * 2 }, dispose: disposer(group, mats) }
}

function buildWraith(): WarpFormModel {
  const group = new THREE.Group()
  const skin = new THREE.MeshStandardMaterial({ color: 0x2a1140, emissive: 0xb46bff, emissiveIntensity: 1.8, transparent: true, opacity: 0.55, roughness: 0.4 })
  const body = new THREE.Mesh(g(new THREE.ConeGeometry(0.55, 2.0, 12)), skin)
  body.position.y = 1.0
  body.rotation.x = Math.PI // wide at the top, wisp at the bottom
  const head = new THREE.Mesh(g(new THREE.SphereGeometry(0.4, 16, 16)), skin)
  head.position.y = 1.9
  const coreMat = glow(0xe0b6ff)
  const core = new THREE.Mesh(g(new THREE.SphereGeometry(0.18, 12, 12)), coreMat)
  core.position.y = 1.5
  group.add(body, head, core)
  const mats = [skin, coreMat]
  let t = 0
  return { group, update: (dt) => { t += dt; group.rotation.y += dt * 0.6; core.scale.setScalar(1 + Math.sin(t * 5) * 0.25) }, dispose: disposer(group, mats) }
}

function buildFighter(): WarpFormModel {
  const group = new THREE.Group()
  const hull = solid(0x20140a, 0xff8a1e, 1.0)
  const fuse = new THREE.Mesh(g(new THREE.ConeGeometry(0.35, 2.2, 10)), hull)
  fuse.rotation.x = Math.PI / 2
  fuse.position.y = 1.2
  const wing = new THREE.Mesh(g(new THREE.BoxGeometry(2.4, 0.1, 0.7)), hull)
  wing.position.y = 1.1
  const thrustMat = glow(0xffd24a)
  const thrust = new THREE.Mesh(g(new THREE.ConeGeometry(0.25, 0.9, 10)), thrustMat)
  thrust.rotation.x = -Math.PI / 2
  thrust.position.set(0, 1.2, -1.2)
  group.add(fuse, wing, thrust)
  const mats = [hull, thrustMat]
  let t = 0
  return { group, update: (dt) => { t += dt; group.rotation.z = Math.sin(t * 2) * 0.12
    // Thrust pulse: fast 18 rad/s flicker normally; calm it to a slow 4 rad/s, lower-amplitude breathe under reduced motion.
    thrust.scale.z = config.reducedMotion ? 1 + Math.sin(t * 4) * 0.12 : 1 + Math.sin(t * 18) * 0.3 }, dispose: disposer(group, mats) }
}

function buildGolem(): WarpFormModel {
  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: 0x123a32, emissive: 0x6fe8c8, emissiveIntensity: 1.0, metalness: 0.3, roughness: 0.2, flatShading: true })
  const torso = new THREE.Mesh(g(new THREE.IcosahedronGeometry(0.85, 0)), mat)
  torso.position.y = 1.3
  torso.scale.set(1, 1.4, 1)
  const head = new THREE.Mesh(g(new THREE.OctahedronGeometry(0.4, 0)), mat)
  head.position.y = 2.3
  const armL = new THREE.Mesh(g(new THREE.IcosahedronGeometry(0.32, 0)), mat)
  armL.position.set(-0.85, 1.4, 0)
  const armR = armL.clone(); armR.position.x = 0.85
  group.add(torso, head, armL, armR)
  const mats = [mat]
  let t = 0
  return { group, update: (dt) => { t += dt; head.rotation.y += dt; torso.position.y = 1.3 + Math.sin(t * 2) * 0.05 }, dispose: disposer(group, mats) }
}

function buildOrb(): WarpFormModel {
  const group = new THREE.Group()
  const coreMat = glow(0xffd24a)
  const core = new THREE.Mesh(g(new THREE.SphereGeometry(0.55, 20, 20)), coreMat)
  core.position.y = 1.4
  const ringMat = glow(0xffb070, 0.85)
  const ring1 = new THREE.Mesh(g(new THREE.TorusGeometry(0.95, 0.05, 8, 36)), ringMat)
  ring1.position.y = 1.4
  const ring2 = new THREE.Mesh(g(new THREE.TorusGeometry(0.95, 0.05, 8, 36)), ringMat)
  ring2.position.y = 1.4
  ring2.rotation.x = Math.PI / 2
  group.add(core, ring1, ring2)
  const mats = [coreMat, ringMat]
  let t = 0
  return { group, update: (dt) => { t += dt; ring1.rotation.y += dt * 2; ring2.rotation.z -= dt * 2.4
    // Core pulse is already mild (6 rad/s); soften lightly to 4 rad/s under reduced motion.
    core.scale.setScalar(1 + Math.sin(t * (config.reducedMotion ? 4 : 6)) * 0.12) }, dispose: disposer(group, mats) }
}

function buildCube(): WarpFormModel {
  const group = new THREE.Group()
  const outerMat = new THREE.MeshBasicMaterial({ color: 0x9bff4d, wireframe: true, transparent: true, opacity: 0.9, fog: false })
  const outer = new THREE.Mesh(g(new THREE.BoxGeometry(1.3, 1.3, 1.3)), outerMat)
  outer.position.y = 1.4
  const innerMat = glow(0xdfffb0)
  const inner = new THREE.Mesh(g(new THREE.BoxGeometry(0.6, 0.6, 0.6)), innerMat)
  inner.position.y = 1.4
  group.add(outer, inner)
  const mats = [outerMat, innerMat]
  return { group, update: (dt) => { outer.rotation.x += dt * 0.9; outer.rotation.y += dt * 1.2; inner.rotation.x -= dt * 1.6; inner.rotation.z += dt * 1.3 }, dispose: disposer(group, mats) }
}

function buildSaucer(): WarpFormModel {
  const group = new THREE.Group()
  const hull = solid(0x2a0a22, 0xff2bd0, 0.9)
  const disc = new THREE.Mesh(g(new THREE.CylinderGeometry(1.1, 1.4, 0.3, 24)), hull)
  disc.position.y = 1.3
  const domeMat = new THREE.MeshStandardMaterial({ color: 0x90305a, emissive: 0xff8ad0, emissiveIntensity: 1.2, transparent: true, opacity: 0.7, roughness: 0.3 })
  const dome = new THREE.Mesh(g(new THREE.SphereGeometry(0.6, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2)), domeMat)
  dome.position.y = 1.45
  const beamMat = glow(0xff8ad0, 0.4)
  const beam = new THREE.Mesh(g(new THREE.ConeGeometry(0.9, 1.3, 18, 1, true)), beamMat)
  beam.position.y = 0.55
  group.add(disc, dome, beam)
  const mats = [hull, domeMat, beamMat]
  let t = 0
  return { group, update: (dt) => { t += dt; disc.rotation.y += dt * 1.4; (beamMat as THREE.MeshBasicMaterial).opacity = 0.3 + Math.abs(Math.sin(t * 3)) * 0.25 }, dispose: disposer(group, mats) }
}
