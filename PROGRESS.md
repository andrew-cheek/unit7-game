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


## Phase 2 — Third-person follow camera

**Goal:** a camera that trails behind and slightly above the robot, smoothly
follows movement and turning, and never clips through walls/terrain — modern
action-game feel.

### What changed and why

- **`Camera.ts` rewritten** around a new `FollowState` the orchestrator passes
  each frame:
  - **Auto-follow yaw.** When the look input (mouse/touch) has been idle for
    `autoFollowDelay` and the subject is moving, the camera eases `input.yaw`
    toward the subject heading so it trails *behind* the robot (or the vehicle).
    Crucially this also fixes vehicle turning: previously the hovercar/shuttle
    turned with `moveX` but the camera yaw never followed unless you mouse-looked.
    Any manual look instantly reclaims control (we only nudge while idle).
  - **Look-ahead.** The look target leads along movement (scaled by speed) so you
    see more of where you're going; damped so it doesn't jitter.
  - **Speed pull-back.** Camera distance extends ~22% at full speed.
  - **Better collision.** Desktop sweeps a 5-ray cross (center + 4 offsets) from
    the subject to the desired camera spot and takes the nearest blocker, which
    catches thin building edges the old single ray slipped through. Snaps in,
    eases out.
  - **Ground clearance.** A downward ray under the final camera position clamps
    it above terrain so steep downward pitch can't bury the camera underground.
- **`Input`** tracks `lastLookMs` (set on real mouse/touch look) and exposes
  `sinceLook`, which gates auto-follow.
- **`Game.buildFollowState()`** assembles the hints for whichever subject is
  active (robot / plane / vehicle).
- New `config.camera` levers: `autoFollowLambda`, `autoFollowDelay`, `lookAhead`,
  `lookAheadLambda`, `speedPullback`, `returnLambda`, `minGroundClearance`.

### Design decisions made on your behalf

- **Auto-follow is a gentle nudge, not a lock.** Lambda 3.0 with a 0.5s idle
  delay means it eases in only when you stop steering with the mouse, so it never
  fights manual aim. This is the Zelda/GTA-style "camera settles behind you"
  behavior rather than a rigid chase cam.
- **Collision probe count is tier-aware** (5 rays desktop, 1 mobile) so mobile
  doesn't pay for the extra raycasts against every building each frame.

### Build & test results

- `npm run typecheck`: clean. `npm run build`: succeeds.

### Performance notes

- Desktop: 5 collision rays + 1 ground ray per frame against the solids set.
  Cheap relative to the render. Mobile: 1 + 1, essentially the prior cost.

### Needs real-device / browser testing

- The *feel* of auto-follow timing (lambda/delay) and look-ahead distance is
  tuned blind — it compiles and the math is sound, but the exact numbers want a
  human eye. They're all in `config.camera` for quick tweaking.

## Phase 3 — Movement feel

**Goal:** make walking and riding responsive and grounded; fix floatiness; the
camera (Phase 2) already follows naturally.

### What changed and why

- **Robot locomotion (`config.player` + `Player.updateRobot`):**
  - `accel` 46 → 60 and `decel` 34 → 52: quicker to start, much crisper to stop
    (kills the ice-skating slide, especially out of a sprint).
  - `turnLerp` 13 → 16: tighter facing snap toward the movement direction.
  - **Fall gravity multiplier (1.6):** the robot now falls faster than it rises
    and falls harder when not actively thrusting. This is the single biggest
    fix for "floaty" — hops and jumps now have weight and land instead of
    hanging.
  - **Coyote time (0.12s):** the jetpack launch-hop still fires for a brief
    moment after walking off a ledge, so edge jumps don't feel dropped. The hop
    is also guarded to only fire when not already rising.
  - `stepDown` is now a config value (0.55 → 0.6) instead of a magic constant, so
    walking down steps/ramps sticks slightly better.
- **Hovercar riding (`Vehicles.driveHover`):** vertical ground-follow damp 8 → 14
  so the car stays planted on ramps and (Phase-5) loops instead of floating up
  behind the surface; `accel` 34 → 42 for snappier throttle response.

### Design decisions made on your behalf

- I treated "floaty" primarily as **hang-time + slow stops**, and fixed both with
  asymmetric gravity and higher decel rather than changing jump height or speeds,
  so the game's balance/reach is preserved. All values are in `config` for easy
  re-tuning.

### Build & test results

- `npm run typecheck`: clean. `npm run build`: succeeds.

### Needs real-device / browser testing

- Exact accel/decel/gravity numbers are tuned by feel-reasoning, not playtest.
  They're conservative and all live in `config.player` / `config.vehicle`.

## Phase 4 — Engine quality check

**Goal:** confirm the Three.js setup can deliver great desktop and smooth mobile;
rework subsystems / add libraries where it raises quality without breaking the
mobile budget; note the cost.

### Findings (audit)

The renderer/scene setup is solid: ACES tonemapping + sRGB output, HDR HalfFloat
composer target, PMREM IBL probe, proper disposal on teardown. The two real gaps
against CLAUDE.md were (1) no centralized tier object — fixed in Phase 1 — and
(2) **the loop was variable-timestep**, which CLAUDE.md calls out as the single
most important rule to get right ("Physics must never be tied to frame rate…
Same physics outcome at any frame rate").

### What changed and why

- **Fixed-timestep simulation loop (`Engine.loop`).** rAF still drives rendering,
  but simulation now advances in fixed `1/60s` steps via an accumulator, with a
  `maxSubSteps` cap (5) so a hitch can't trigger a spiral of death. Frame time is
  clamped before accumulating. This makes physics/gameplay deterministic and
  identical at 30/60/144 fps, exactly as required.
- **FPS metering moved to `Engine`.** Because the sim dt is now constant, the old
  `1/dt` FPS estimate would have read a flat 60 forever. FPS is now smoothed from
  the *real* pre-clamp frame time in the render loop and exposed as `engine.fps`;
  `Game` reads that for the HUD. Removed the dead `fpsSmooth` plumbing in `Game`.

### Design decisions made on your behalf

- **Did NOT migrate physics to Rapier (the CLAUDE.md "target").** The current
  physics is a lightweight raycast-ground + AABB-pushout system that is cheap and
  already frame-rate-independent now that it runs on a fixed step. Dropping in
  Rapier (Rust/WASM) is a large, risky rewrite of Player/Vehicles/NPC integration
  with a WASM payload cost on mobile — not justified for this pass and not needed
  to hit the quality/cinematic goals. I've left it as the documented future
  target. **If you want it, that's its own dedicated phase.**
- **Left the ~918 kB bundle as one chunk.** Code-splitting Three into its own
  chunk would help repeat-load caching, but the deliverable is a single embedded
  `<Unit7Game/>` component and I didn't want to risk the consumer's bundler
  setup. Recommendation only — see "future work".

### Cost note

- Fixed timestep on a 30 fps device means ~2 sim substeps per rendered frame. The
  per-step logic (a handful of raycasts + integration) is cheap relative to the
  render, so this is well within budget. The substep cap bounds worst case.

### Build & test results

- `npm run typecheck`: clean. `npm run build`: succeeds.

### Needs real-device / browser testing

- Confirm no visible stutter from the accumulator on a real 30 fps mobile device
  (the math is standard fixed-timestep; render interpolation was intentionally
  not added since positions are written straight to the scene graph — see
  future work if you ever see micro-jitter at low fps).
