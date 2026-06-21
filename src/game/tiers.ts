import type { AssetQuality } from './types'
import { isTouchDevice } from './utils'

/**
 * The single source of truth for "how expensive should this run". Every system
 * (renderer, post chain, lights, crowd, sky, materials) reads from one resolved
 * QualityTier object so changing a lever here cascades everywhere instead of
 * being duplicated across files. This is the `QualityTier` config CLAUDE.md asks
 * for. Two presets ship: `high` (desktop) and `low` (mobile). Detection picks
 * one at startup; a manual override (`?tier=high|low` or the `quality` prop)
 * always wins so the other path can be forced for testing.
 */
export interface QualityTier {
  name: AssetQuality

  // --- renderer ---
  /** devicePixelRatio is capped at this. Mobile stays low to save fill rate. */
  pixelRatioCap: number
  /** MSAA samples on the HDR composer target. 0 = none (use AA pass instead). */
  msaaSamples: number

  // --- post-processing ---
  bloom: boolean
  /** Screen-space ambient occlusion. Desktop only - it is fill-rate heavy. */
  ssao: boolean
  /** Cinematic depth of field (subtle). Desktop only. */
  dof: boolean
  /** Cheap post AA (SMAA) - used on the path that has no MSAA. */
  smaa: boolean

  // --- shadows ---
  shadows: boolean
  shadowMapSize: number
  /** PCFSoft (true, nicer) vs PCF (false, cheaper). */
  softShadows: boolean
  /** Let the (many) city buildings cast shadows. Off on mobile - big perf win. */
  buildingShadows: boolean
  /** Max fixed-timestep catch-up steps per frame. Low on mobile so a slow frame
   *  can't trigger a multi-step hitch (it eases into mild slow-mo instead). */
  maxSubSteps: number

  // --- scene density ---
  /** Multiplier applied to the configured crowd/prop counts. */
  densityScale: number
  /** Extra colored point-light fills near neon hotspots. Off on mobile. */
  accentLights: boolean
  /** Starfield point count in the sky dome. */
  starCount: number
  /** Anisotropic filtering on facade/window textures. */
  anisotropy: number
  /** Far plane / fog tuning hint (meters). */
  drawDistance: number

  // --- materials ---
  /** Env-map intensity multiplier; desktop reflects neon harder. */
  envMapIntensity: number
}

export const TIERS: Record<AssetQuality, QualityTier> = {
  high: {
    name: 'high',
    pixelRatioCap: 2,
    msaaSamples: 4,
    bloom: true,
    ssao: true,
    dof: true,
    smaa: false, // MSAA already handles edges on this path
    shadows: true,
    shadowMapSize: 2048,
    softShadows: true,
    buildingShadows: true,
    maxSubSteps: 5,
    densityScale: 1,
    accentLights: true,
    starCount: 1800,
    anisotropy: 8,
    drawDistance: 320,
    envMapIntensity: 1.15,
  },
  low: {
    name: 'low',
    pixelRatioCap: 1.25, // fewer fragments on dense phone screens
    msaaSamples: 0,
    bloom: true, // kept on - it is the whole neon look - but cheaper params
    ssao: false,
    dof: false,
    smaa: false, // skip the extra full-screen AA pass on mobile
    shadows: true,
    shadowMapSize: 1024,
    softShadows: false,
    buildingShadows: false, // only the player/vehicles cast shadows on mobile
    maxSubSteps: 2,
    densityScale: 0.45,
    accentLights: false,
    starCount: 500,
    anisotropy: 2,
    drawDistance: 220,
    envMapIntensity: 1.0,
  },
}

/**
 * Quick GPU/feature probe + touch UA check. Returns the tier name. A manual
 * override (explicit prop or `?tier=` query) short-circuits detection.
 *
 * The probe is conservative: anything that smells like a phone/tablet, a
 * software renderer, or a known mobile GPU family drops to `low`. Desktop
 * dGPUs/iGPUs stay `high`.
 */
export function detectTier(override?: AssetQuality): AssetQuality {
  if (override) return override

  // URL override for testing on any device: ?tier=low / ?tier=high
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search).get('tier')
    if (q === 'low' || q === 'high') return q
  }

  if (isTouchDevice()) return 'low'

  // GPU string probe. Software / mobile families -> low.
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return 'low' // no WebGL at all -> safest cheap path
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') as string
    const r = (renderer || '').toLowerCase()
    const weak = ['swiftshader', 'llvmpipe', 'software', 'apple gpu', 'mali', 'adreno', 'powervr', 'videocore']
    if (weak.some((w) => r.includes(w))) return 'low'
  } catch {
    /* probe failed - fall through to high on a desktop UA */
  }

  // Small viewport on a non-touch device is still treated as desktop-high, but
  // very low core counts hint at a weak machine.
  if ((navigator.hardwareConcurrency ?? 8) <= 2) return 'low'

  return 'high'
}
