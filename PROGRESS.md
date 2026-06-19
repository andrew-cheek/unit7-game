# Unit 7 — Autonomous Work Log (PROGRESS.md)

This is the running log for the multi-phase quality + cinematic work requested.
Read top to bottom. Honest notes, decisions made on your behalf, and what still
needs real-device testing are all called out.

**Model used:** `claude-opus-4-8[1m]` (Opus, the most capable available). Selected
as requested.

---

## Pre-flight: branch state

- The prompt referenced a branch `refactor/mode-system-and-tiers`. **That branch
  does not exist** on origin or locally. The only branches are `main`,
  `origin/main`, and the assigned working branch
  `claude/unit7-quality-cinematic-mi6bkw`.
- The prior work (mode system, quality flag, dt-clamped loop, factory intro) is
  already committed on `main` and present on the working branch.
- **Build + typecheck both pass on the working branch as-is.** Nothing was
  broken, so no pre-fix was needed. I proceeded straight to the five phases,
  developing on `claude/unit7-quality-cinematic-mi6bkw` as instructed. `main`
  was never touched.

### Verification method + its limits (important)

This environment is a headless container with **no browser and no GPU**. I
cannot literally open the game and watch it run, and I cannot measure real FPS.
So "verify it runs" is satisfied here by:

1. `npm run typecheck` (tsc, strict) — must be clean.
2. `npm run build` (tsc -b + vite production build) — must succeed.
3. Careful static reasoning about runtime paths (init order, disposal, null
   guards, tier branches).

Anything that genuinely needs a real browser/GPU/touch device is listed under
**"Needs real-device testing"** at the bottom. I did not claim those work.

---

## Phase 1 — Performance & graphics (tier system)

**Goal:** raise desktop quality as far as the engine allows while keeping mobile
on a simpler, smooth path; extend the tier system where levers were missing.

### What changed and why

- **New `src/game/tiers.ts`** — a single `QualityTier` object with two presets
  (`high`/`low`) plus `detectTier()`. This is the centralized config CLAUDE.md
  asks for: renderer pixel cap, MSAA samples, post toggles (bloom/ssao/dof/smaa),
  shadow size + softness, scene `densityScale`, accent lights, star count,
  anisotropy, draw distance, and `envMapIntensity`. Every system now reads from
  `config.tier` instead of branching on a bare `'high'|'low'` string in five
  different files.
- **`detectTier()`** — manual override first (`quality` prop or `?tier=` query),
  then touch-UA check, then a WebGL `UNMASKED_RENDERER` probe that drops known
  mobile/software GPU families (Mali/Adreno/PowerVR/Apple GPU/SwiftShader/
  llvmpipe) to `low`, plus a low-core-count fallback. Conservative: anything
  uncertain that looks weak goes `low`.
- **`Engine`** now takes the resolved `QualityTier` and builds a tier-driven post
  chain: RenderPass → (SAO/SSAO, desktop) → Bloom → (Bokeh DoF, desktop) →
  OutputPass → (SMAA, mobile path that has no MSAA). Shadow map type follows
  `softShadows`. Added `setFocusDistance()` so gameplay drives the DoF focus to
  the camera subject each frame.
- **`World`** reads shadows/shadowMapSize/accentLights/starCount/anisotropy/
  envMapIntensity from the tier. Mobile drops accent point-lights entirely and
  leans on emissive + IBL.
- **`Events`** crowd/drone/traffic counts and **`Game`** NPC count now scale by
  `tier.densityScale` (1.0 desktop, 0.5 mobile).

### Design decisions made on your behalf

- **Bloom stays ON for mobile** (slightly reduced strength). It *is* the neon
  identity of the game; killing it would make mobile look broken rather than
  "simpler". SSAO and DoF are the passes that get cut on mobile, because they are
  the genuinely fill-rate-heavy ones.
- **DoF is deliberately subtle** (tiny aperture/maxblur). It reads as a lens, not
  a blur, and won't fight gameplay readability. If you want it stronger, raise
  `aperture`/`maxblur` in `Engine`.
- **SSAO intensity is low (0.012)** on purpose — since I can't eyeball it on a
  GPU here, I tuned it to "adds contact depth" rather than "risk darkening the
  whole frame". Safe to push up once you see it.

### Build & test results

- `npm run typecheck`: clean.
- `npm run build`: succeeds. Bundle grew 832 kB → 918 kB (raw) / 229 → 272 kB
  gzip, from the three extra post-processing passes (SAO/Bokeh/SMAA). Acceptable;
  see "future work" about code-splitting the mobile path.

### Performance notes

- **Desktop (high):** MSAA 4x on an HDR HalfFloat target, SSAO + subtle DoF,
  2048 soft shadows, anisotropy 8, full crowd. This is a meaningful step up in
  fidelity over the old bloom-only path.
- **Mobile (low):** no SSAO/DoF, no MSAA (SMAA instead), 1024 hard shadows, no
  accent point-lights, half crowd density, fewer stars, pixel ratio capped at
  1.5. The expensive passes are provably *not constructed* on this path (guarded
  by `tier.*` booleans), so they cost nothing rather than being created and
  skipped.

