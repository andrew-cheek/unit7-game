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

  // --- ambient FX (world events, exploration sparkle, extra background motion) ---
  /** Multiplier on particle/event element counts. Scaled down on weaker tiers. */
  fxScale: number
}

export const TIERS: Record<AssetQuality, QualityTier> = {
  high: {
    name: 'high',
    pixelRatioCap: 2,
    msaaSamples: 4,
    bloom: true,
    // SAO + DoF sample the scene depth buffer, which is now logarithmic (to fix
    // distance z-fighting) — they misread it and would reintroduce artifacts, so
    // they're off. Dropping them also removes the soft/"blurry" look and lifts
    // frame rate; bloom + colour grade + MSAA carry the desktop look.
    ssao: false,
    dof: false,
    smaa: false, // MSAA already handles edges on this path
    shadows: true,
    shadowMapSize: 3072,
    softShadows: true,
    buildingShadows: true,
    maxSubSteps: 5,
    densityScale: 1.25, // busier streets on desktop (more crowd / traffic / drones)
    accentLights: true,
    starCount: 2600,
    anisotropy: 16,
    drawDistance: 560, // see further across the bigger district on desktop
    envMapIntensity: 1.22,
    fxScale: 1,
  },
  // Mid preset for capable laptops / tablets: desktop look, lighter post + density.
  medium: {
    name: 'medium',
    pixelRatioCap: 1.5,
    msaaSamples: 0,
    bloom: true,
    ssao: false,
    dof: false,
    smaa: true, // cheap AA in place of MSAA
    shadows: true,
    shadowMapSize: 1536,
    softShadows: true,
    buildingShadows: false,
    maxSubSteps: 3,
    densityScale: 0.82,
    accentLights: true,
    starCount: 1400,
    anisotropy: 8,
    drawDistance: 340,
    envMapIntensity: 1.12,
    fxScale: 0.65,
  },
  low: {
    name: 'low',
    pixelRatioCap: 1.2, // fewer fragments on dense phone screens
    msaaSamples: 0,
    bloom: true, // kept on - it is the whole neon look - but cheaper params
    ssao: false,
    dof: false,
    smaa: false, // skip the extra full-screen AA pass on mobile
    shadows: true,
    shadowMapSize: 512, // small contact-shadow map; only the player/vehicles cast
    softShadows: false,
    buildingShadows: false, // only the player/vehicles cast shadows on mobile
    maxSubSteps: 2,
    densityScale: 0.38, // fewer crowd/traffic/prop draws -> steadier mobile frame rate
    accentLights: false,
    starCount: 320,
    anisotropy: 2,
    drawDistance: 210,
    envMapIntensity: 1.0,
    fxScale: 0.4,
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
    if (q === 'low' || q === 'medium' || q === 'high') return q
  }

  // Capable tablets — most notably the iPad Pro/Air — are powerful enough for the
  // 'medium' preset, but the blanket touch check used to lump them in with phones at
  // 'low'. Probe for an Apple-GPU, tablet-class, multi-core device and give it
  // 'medium'; phones and weaker tablets still fall through to 'low'.
  if (isTouchDevice()) return detectTabletTier()

  // GPU string probe. Software / mobile families -> low.
  try {
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return 'low' // no WebGL at all -> safest cheap path
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') as string
    const r = (renderer || '').toLowerCase()
    // Note: NO 'apple gpu' here - this branch only runs for NON-touch devices
    // (touch already returned 'low' above), so "Apple GPU" here means an Apple
    // Silicon Mac, which is high-capable. Phones/tablets are caught by the touch
    // check, not the renderer string.
    const weak = ['swiftshader', 'llvmpipe', 'software', 'mali', 'adreno', 'powervr', 'videocore']
    if (weak.some((w) => r.includes(w))) return 'low'
  } catch {
    /* probe failed - fall through to high on a desktop UA */
  }

  // Small viewport on a non-touch device is still treated as desktop-high, but
  // very low core counts hint at a weak machine.
  if ((navigator.hardwareConcurrency ?? 8) <= 2) return 'low'

  return 'high'
}

/**
 * Touch-device sub-classifier. Capable tablets (iPad Pro/Air/mini on Apple silicon)
 * comfortably run the 'medium' preset and look far better for it; the old blanket
 * `touch -> low` left them on the phone-grade path. We require a tablet-class
 * viewport, enough logical cores, and an Apple GPU before promoting to 'medium' —
 * phones (small viewport) and weaker tablets stay at 'low'. SSR/feature-safe: any
 * probe failure falls back to 'low'. Adaptive resolution still protects the frame
 * rate at runtime, so a borderline device degrades sharpness rather than hitching.
 */
function detectTabletTier(): AssetQuality {
  try {
    if (typeof screen === 'undefined' || typeof navigator === 'undefined') return 'low'
    const minEdge = Math.min(screen.width || 0, screen.height || 0) // CSS px; phones are < ~700
    const cores = navigator.hardwareConcurrency ?? 0
    if (minEdge < 740 || cores < 5) return 'low' // phone-sized or low-core -> stay cheap
    const canvas = document.createElement('canvas')
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return 'low'
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = ((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') as string || '').toLowerCase()
    // "Apple" GPU on a tablet-class device == an iPad on Apple silicon -> 'medium'.
    if (renderer.includes('apple')) return 'medium'
  } catch {
    /* probe failed - stay on the safe cheap path */
  }
  return 'low'
}

/**
 * Resolves the full QualityTier object to run with, layering an optional
 * "lite / potato" path on top of the detected preset.
 *
 * Lite mode is the cheapest path for the weakest hardware. It is requested when:
 *  - the `?lite` URL param is present (manual override for testing on any phone), OR
 *  - the device auto-trips as very weak: `navigator.hardwareConcurrency <= 2`
 *    (<= 2 logical cores) or `navigator.deviceMemory <= 2` (<= 2 GB RAM).
 *
 * It does NOT introduce a new AssetQuality value — it returns the existing
 * 'low'-named tier (so the rest of the codebase keeps working unchanged) but
 * with all post-processing and shadows stripped out and density/draw distance
 * pulled in. That is the right lever for fill-rate- and draw-call-bound low-end
 * phones: bloom/SSAO/DoF/SMAA and the shadow pass are the most expensive things
 * on those GPUs, so cutting them (plus capping DPR at 1 and thinning the scene)
 * buys the biggest frame-rate headroom.
 *
 * Non-lite devices get the detected preset (`base`) returned unchanged.
 */
export function resolveTier(override?: AssetQuality): QualityTier {
  const name = detectTier(override)
  const base = TIERS[name]

  // Guard location/navigator for SSR, same defensive style as detectTier.
  const hasLiteParam =
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).has('lite')

  const cores =
    typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 8) : 8
  const mem =
    typeof navigator !== 'undefined'
      ? ((navigator as any).deviceMemory ?? 8)
      : 8

  const lite = hasLiteParam || cores <= 2 || mem <= 2

  if (!lite) return base

  return {
    ...base,
    name: base.name,
    bloom: false,
    ssao: false,
    dof: false,
    smaa: false,
    shadows: false,
    buildingShadows: false,
    softShadows: false,
    accentLights: false,
    maxSubSteps: 2,
    pixelRatioCap: Math.min(base.pixelRatioCap, 1),
    densityScale: base.densityScale * 0.55,
    drawDistance: Math.round(Math.min(base.drawDistance, 150)),
    starCount: Math.round(Math.min(base.starCount, 120)),
    fxScale: base.fxScale * 0.5,
    anisotropy: 1,
    shadowMapSize: 256,
    envMapIntensity: base.envMapIntensity,
  }
}
