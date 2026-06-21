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

## Phase 5 — Opening cinematic

**Goal:** a skippable, self-contained, sci-fi neon opening that fits the
mode-system, hitting every requested beat and handing off to the follow camera.

### What changed and why

- **`Intro.ts` fully rewritten** from the old factory-assembly sequence into the
  requested multi-beat cinematic. It stays architecturally clean: owns a single
  `THREE.Group` + the camera while `done` is false, exposes `fade` (0..1) for the
  orchestrator to drive the black overlay, and disposes all geometry/materials on
  exit — exactly the contract the mode manager already used.
- **Beats (timeline in seconds, total ~23.4, skippable at any point):**
  1. **0–5 Plane interior assembly.** A ribbed neon fuselage; the robot's parts
     (torso, legs, arms, jetpack, head) fly in from offsets and lock into the
     silhouette one by one with spark bursts + a weld light, then a power-on
     flash reveals the polished rigged robot. Deliberate, staged — not instant.
  2. **5–7 Cargo hatch** lowers open at the rear; the robot walks to the edge.
  3. **7–8 Leap** into open sky.
  4. **8–12.5 Freefall** with upward-drifting speed streaks, belly-to-earth
     spread pose, city far below.
  5. **12.5–14.5 Canopy descent** that blends the robot precisely onto the live
     position of the moving bike seat.
  6. **14.5–16.5 Lands exactly on the moving hover-bike** (verified: the freefall
     target equals the bike seat at the landing instant).
  7. **16.5–22.6 Two full vertical loops** on a sci-fi tube track with glowing
     rails and support pylons (Hot Wheels style, neon not plastic), side-chase
     camera.
  8. **22.6–end** camera settles into a third-person trail behind the bike,
     matching the gameplay follow-cam framing, fades to black.
- **Handoff:** `Game.finishIntro()` now fades back in from black (reuses the
  zone-transition 'in' phase) as it snaps the player in behind the follow camera,
  so cinematic→gameplay reads as one continuous shot. `introFocus` moved to the
  cinematic's airspace so the star/sky dome surrounds it.

### How it was verified (given no browser)

- `npm run typecheck` + `npm run build`: clean.
- **Standalone math check** (`scratchpad/introcheck.mjs`) replicated the track
  path + scripted `bikeS(t)` and confirmed: the bike distance is continuous and
  monotonic (no teleport/reverse), the loop apex is exactly 2·R, the whole track
  stays at z ≤ -306 (the city begins at z > -220, so nothing intersects), and the
  robot's freefall target equals the bike seat at the landing beat (precise
  landing, by construction).

### Design decisions made on your behalf

- **The track is built so vertical loops don't advance Z** (a loop returns to its
  entry z), which is what keeps the entire stage in its own pocket of space clear
  of the city. Two loops with a short straight between them.
- **Assembly uses fly-in proxies + a flash reveal of the real rig**, rather than
  scaling the production robot part-by-part (which isn't individually
  addressable). Reads as "parts converge and lock", then the hero robot powers
  on. Reused the existing `createRobot()` rig for the skydive/ride poses so the
  jointed animation is consistent with gameplay.
- **The landing is scripted, not physically simulated.** "Lands precisely on a
  moving bike" is guaranteed by interpolating the robot onto the live seat
  transform — robust and exact, where a physics toss would be flaky.
- **Bike rides on top of a thin deck tube** (radius 0.7) with the seat above it,
  so it doesn't clip inside the track.

### Build & test results

- `npm run typecheck`: clean. `npm run build`: succeeds. Bundle ~924 kB.

### Needs real-device / browser testing

- **This is the phase most needing a human eye.** The math/geometry is verified
  but camera framing, pacing, and the assembly readability are tuned blind. All
  timing constants are named at the top of `Intro.ts` (`T_ASSEMBLE`, `T_HATCH`,
  `T_JUMP`, `T_CHUTE`, `T_LAND`, `T_LOOP1/2`, `DURATION`) for quick adjustment.
  Watch specifically: (a) does the robot read clearly during freefall against the
  sky; (b) loop side-camera distance (offset `(20,5,-4)` in `updateCamera`); (c)
  the fuselage interior framing during assembly. The cinematic is fully
  skippable, so it can never block play if pacing feels off.

---

## Final summary (read this first when you land)

All five phases are complete, each committed separately on
`claude/unit7-quality-cinematic-mi6bkw`. `main` was never touched. The branch
builds and typechecks clean at every commit.

| Phase | What | State |
|---|---|---|
| 1 | Centralized `QualityTier` + SSAO/DoF/SMAA post chain | done, verified build + headless tier check |
| 2 | Modern third-person follow camera (auto-trail, look-ahead, collision sweep) | done, verified build |
| 3 | Grounded movement feel (fall gravity, coyote time, snappier accel/decel) | done, verified build |
| 4 | Fixed-timestep simulation loop + engine audit | done, verified build |
| 5 | New opening cinematic (plane → assemble → jump → freefall → land on bike → loops) | done, verified build + headless path math |

### Verification summary

- Every phase: `npm run typecheck` clean, `npm run build` succeeds.
- Tier gating proven headlessly: `detectTier('high'|'low')` resolves correctly;
  SSAO/DoF/MSAA on high, off on low (SMAA instead), density 1.0 vs 0.5. The
  Engine only *constructs* the heavy passes when the tier flag is set, so the
  mobile path doesn't allocate them at all.
- Cinematic track + timeline math proven headlessly: continuous, monotonic bike
  motion; loop apex = 2·R; track clear of the city; exact landing on the bike.

### Consolidated "needs real-device / browser testing" (I did NOT verify these)

Because this was a headless container (no browser, no GPU), the following are
implemented correctly but want a human/device to confirm:

1. **Real FPS / thermal behavior** on a mid-range phone (low tier) and desktop
   (high tier). The budgets are designed, not measured.
2. **Touch input on hardware** (the on-screen stick + buttons) — only forced-on
   desktop emulation was reasonable here.
3. **Look/feel tuning** that's inherently visual:
   - Camera auto-follow timing + look-ahead (`config.camera`).
   - Movement weight (`config.player` fall gravity / accel / decel).
   - SSAO/DoF strength (`Engine`) — kept conservative to avoid blind over-darkening.
   - The whole cinematic's framing + pacing (`Intro.ts` timeline constants).
4. **Mode-switch memory** on mobile over a long session (CLAUDE.md's leak
   concern). Disposal paths look correct and unchanged, but profile to be sure.

### Things I deliberately did NOT do (with rationale)

- **No Rapier migration.** The existing raycast/AABB physics is cheap and is now
  frame-rate-independent on the fixed step. Rapier is a large, risky rewrite with
  a WASM cost on mobile; left as the documented future target — its own phase.
- **No bundle code-splitting.** The deliverable is a single embedded component;
  splitting Three into its own chunk would help caching but risks the consumer's
  bundler. Recommendation only. Current bundle ~924 kB (272 kB gzip).

### Quick dev testing recipe (when you're back)

- `npm run dev`, then:
  - `?intro` — watch the opening cinematic (Skip button works).
  - `?tier=low` — force the mobile path; confirm no SSAO/DoF and lighter scene.
  - `?tier=high` — force desktop quality.
  - `?touch` — show the touch controls on desktop.

## Feature batch: Titan mech, sunrise, commuter buses + offices, brighter sky highway

Five gameplay/atmosphere additions on top of the environment pass.

- **Original player robot restored.** Reverted `createRobot` (procedural.ts) from
  the "Blue Titan" restyle back to the slim original (thin legs/arms, purple
  accent, chest core). The Blue Titan look moved to its own pilotable mech.
- **Blue Titan mech (pilotable).** New `createTitan()` builds a ~4.5m blue
  armored walker as a `VehicleModel`. Wired into `Vehicles.ts` as a `'titan'`
  kind parked by the arcade portals (2,16); `config.vehicle.titan` gives it its
  own heavy stats. Camera pulls back further (`distanceScale 2.8`) to frame it.
  Power: CAPTURE becomes a **STOMP** ground-pound (`Game.titanStomp`) that
  captures every target in a 10m radius; mobile shows a STOMP button in the
  Titan.
- **Gradual sunrise (Earth).** `World.update` runs an 8s-delayed, 16s eased
  dawn: the sun climbs from the horizon while sky gradient, fog, ambient, hemi
  and sun color/intensity lerp night -> warm dawn (`applyDawn`). Earth only;
  Mars/Moon untouched.
- **Commuter buses + offices.** `createBus()` model + a bus system in `Events.ts`
  that loops the avenues, pauses at three office stops and lets out pedestrian
  commuters who walk into the building and vanish. `World.buildOffices()` adds
  glass-fronted ground-floor offices at those stops with desks and seated worker
  robots at glowing monitors. Shared `OFFICE_ANCHORS` keep stops/doors/offices
  aligned. Bus count + commuter cap scale with tier.
- **Brighter sky highway.** `Sky.buildHighway` lowered (y~40) and made more
  solid: wider translucent deck, thicker brighter rails, a centre line, and ~30
  proper car-shaped vehicles (body + glass cabin + head/tail lights) running in
  two lanes instead of plain boxes.

Mobile-vs-desktop: bus count (2 high / 1 low) and highway car count scale with
`tier.densityScale`; offices and the Titan are static/cheap. Sunrise is a few
per-frame color lerps, negligible cost.

## Three pilotable battle-mechs with missiles

Replaced the single Titan with three sized, flyable mechs and a missile system.

- **createMechSuit(opts)** (procedural.ts): one parametrized humanoid mech rig
  (armor/trim/core colors + `scale`) with shoulder missile tubes, a cockpit, and
  additive back/foot thrusters that flare with speed (flight pose tucks the legs).
- **Three vehicles** (Vehicles.ts + config.vehicle.mechM/L/XL): MECH-M (blue,
  size 1.4), MECH-L (crimson, size 2.6) and MECH-XL (green, building-sized,
  size 6). They park standing on the ground in a row by the arcade portals so
  you see them at spawn, and lift off (drive: 'fly') when piloted. Bigger =
  taller, slower turn, higher top speed.
- **Missiles** (Missiles.ts): CAPTURE/FIRE (H key, or FIRE button on mobile)
  launches a pair of missiles from the shoulder pods that arc out, glow, and
  detonate into a shockwave; `Game.detonate` captures every target in the blast
  radius for score. 0.45s cooldown.
- Camera pulls back proportionally to mech size and frames the torso; HUD/mobile
  hints updated (Space/J fly, H fire, G exit). Missiles hidden off-Earth and
  disposed with the game.

## City variety, drivable low highway, day cycle + sunrise alien invasion

- **More building types** (World.addBuilding): expanded facade palette and added
  roof variety - ziggurat setbacks, 4-sided pyramid/crystal caps, glowing crown
  rings, and rooftop water-tank/utility clusters (new shared geos).
- **Drivable elevated highway** (World.buildDriveHighway): a low (~9m) straight
  deck over the south avenue with down-ramps at both ends, glowing rails, a
  centre line and support pillars. The deck + ramps are in the physics ground
  meshes, so the hover-cars drive up the ramp and along it. Two drivable cars
  park up on it; the rocket pad moved clear of the deck. Decorative sky highway
  lowered to ~24m so it reads near the rooftops.
- **Day cycle** (World): sun now rises starting at 5s (full day ~10s) then sets
  over ~12s back to night, a slow fade. Exposed `dayFactor`.
- **Sunrise alien invasion** (Events + WaterBalloons): when the sun finishes
  rising, dropships descend around the player and release "invader" aliens that
  chase you and lob arcing water balloons; a hit bursts into a splash and flashes
  SOAKED. Invaders are worth more on capture. New WaterBalloons projectile system
  (ballistic arc + splash). Triggers once, Earth only.

## Mobile-focused performance + retention pass

- **Adaptive resolution** (Engine): a 1s-cadence controller scales the drawing-
  buffer pixel ratio down (floor 0.6) when smoothed FPS dips below 30 and back up
  past 52, so weak devices hold a steady frame rate instead of dropping frames.
- **Code-split minigames** (Unit7Game): BeamWars + DigDuel are `React.lazy`
  dynamic imports (now ~9KB/13KB chunks fetched on portal entry) instead of being
  bundled into the initial download. `base: './'` in preview keeps the chunk URLs
  relative so they load on the githack subpath.
- **Instanced skyline** (World.buildSkyline): the ~150-mesh distant city ring is
  now two InstancedMeshes (bodies + per-instance-colored neon caps), a big draw-
  call cut on the far field.
- **Persistence** (storage.ts): localStorage profile (best score, lifetime
  captures, credits). HUD shows BEST; best saves live, lifetime/credits on exit.
- **Haptics**: navigator.vibrate on net capture, missile kills and getting soaked.
- **Screen wake lock**: keeps the phone screen awake while playing, re-acquired on
  tab focus. All guarded for unsupported devices.

## Transforming colossus mech

- **MECH-XL is now a ~50m colossus** (size 6 -> 10) that towers over the local
  skyline, with a wider boarding radius so you can climb in at its feet. Parked
  further out (60,60) for clearance but visible from the portals.
- **Transform** (createMechSuit.setMorph): all mechs can morph between robot
  stance and a horizontal jet/flight form - body tips forward, legs stream back
  as a tail, arms sweep back like wings, thrusters flare. Jet form flies ~2.4x
  faster and turns tighter. Toggle with the T key or a new MORPH button on the
  mech control cluster (mobile). Banner + haptic on transform.

## Brighter day cycle, central space elevator, mechs + life off-world

- **Daylight by default** (World): replaced the quick rise/set with a long
  day/night loop - dark for 5s, sunrise to full day by ~13s, holds bright for
  ~2min, brief dusk + night, repeat. Daytime palette is a bright blue sky, light
  haze and strong ambient/hemi/sun, and lit building windows dim toward noon so
  the city reads as actual daytime instead of "night with a glow". Invasion still
  fires at the first sunrise.
- **Central space elevator** (World.buildSpaceElevator): a colossal centerpiece
  near the middle of the map - tapering megastructure base, a tether climbing to
  ~640m, riding climber cars, and a slowly rotating orbital ring/station. Upper
  parts are fog-immune so it anchors the skyline from anywhere; base is solid +
  on radar.
- **Pilot your mech off-world** (Vehicles.setZone): traveling to Mars/Moon now
  lines the three mechs up at the spawn (cars stay parked on Earth) so you can
  stomp/fly/transform your giant robot on other planets. Vehicles update in every
  zone; boarding ignores hidden vehicles.
- **Alien-world life** (Zones): drifting bioluminescent spore-jellies bobbing
  over Mars, and hovering mining drones with survey beams circling the Moon.

## Three more arcade portals: 2048, Invaders, Snake

- Added `merge2048`, `invaders`, `snake` to MinigameKind; five portals now sit in
  a neon arc in front of spawn.
- **Game2048.tsx**: clean-room 2048 (DOM grid, swipe/arrows). Slide/merge logic
  unit-tested. Per-device high score.
- **Invaders.tsx**: neon alien-wave shooter on a fixed virtual field letterboxed
  to the canvas (resolution-independent). Drag/arrows to move, auto-fire, lives,
  escalating waves. High score persisted.
- **Snake.tsx**: classic snake (canvas, swipe/arrows), speeds up as it grows.
- All three are React.lazy chunks (~6KB each), styled to match, with
  START/REPLAY/RETURN buttons and touch + keyboard controls.

## Upgrade brief pass (objectives, plaza, mech hangar, camera, HUD, balance)

- Objective chain (config.missions): one active goal at a time with HUD pill +
  "OBJECTIVE COMPLETE" banners. Find Plaza -> Pilot mech -> Mars -> Moon ->
  Capture 3 -> Arcade.
- Portal Plaza: Mars/Moon portals moved to flank the 5 arcade portals in one row
  in front of spawn; all now have floating neon labels.
- Mech Hangar landmark framing the colossus (warning-stripe pad, frame pillars +
  gantry, bobbing repair bots).
- Mech boot-up moment: "MECH-XL ONLINE" banner + camera shake on entering.
- Player readability: a soft hero fill light follows the subject.
- Camera: higher GTA-style start angle.
- HUD: objective pill, faster banner fades, mobile buttons renamed
  (JET->JETPACK, RUN->SPRINT, MORPH->TRANSFORM).
- Comedy balance: invasion + water-balloon spam cut hard (few invaders, ~24m
  stand-off, 12-24s throw cooldown, max 2 balloons aloft, brief SPLASH banner).

## Spaceport, mech weight FX, perf pass (pooling + culling)

- Spaceport landmark (World.buildSpaceport): control tower with a sweeping
  beacon, lit landing pads, parked freighters, stacked cargo, pulsing warning
  lights, and a ship that periodically lifts off. On radar.
- Mech weight: pooled ground-ring shockwaves - dust rings + a tiny shake under
  each foot while striding low, and a big shockwave + shake when landing from
  height (Missiles.shockwave ring pool; Game.updateMechFx).
- Performance: object pooling for the ring/shockwave effects (no per-event
  alloc), and distance culling for NPCs (135m) + ambient drones/traffic/commuters
  (150m) - far actors skip both render and animation.

## Audio + Race Loop + Mech Arena

- Audio (Audio.ts): synthesized WebAudio engine (no asset files) - ambient pad +
  one-shot SFX for capture, missile fire, explosion, mech online, footstep/land,
  splash, portal/zone, objective. Unlocks on first gesture; mute toggle persisted;
  SOUND ON/OFF button in HUD.
- Race Loop minigame (RaceLoop.tsx): top-down neon oval lap racer, auto-throttle
  + steer, boost arrows, 60s time attack, best-laps persisted.
- Mech Arena minigame (MechArena.tsx): top-down arena, drag/WASD move, auto-fire
  at nearest drone, escalating waves, 3 lives, score persisted.
- Two new labeled portals flank the plaza row; both lazy-loaded chunks.

## Reward/unlock loop + guided objective beacon

- Credits are now a live spendable currency (earned ~half the score value per
  capture, persisted). HUD shows CREDITS.
- Mech unlocks: MECH-M is free; MECH-L (400) and MECH-XL (1200) are bought with
  credits at the mech. Locked-mech prompt shows the cost; first G unlocks
  (deducts + persists), next G boards. Unlocks persist per device.
- Guided beacon: a tall glowing column drops on the current objective's target
  (plaza / nearest unlocked mech / Mars or Moon portal / nearest arcade portal),
  plus a bright objective blip on the radar, so you always know where to go.

## Moon research base + minigame sound

- Moon research base (Zones.buildMoonBase): glowing habitat domes linked by a
  tube, a comms dish on a mast, a lit landing pad, blinking perimeter lights, and
  two rovers patrolling a loop. Domes are solid; animated lights + rovers.
- Minigame sound (ui/miniSound.ts): a tiny shared WebAudio blip engine the arcade
  games call for start/score/shoot/hit/lap/gameover. Respects the global mute.
  Wired into Snake, 2048, Invaders, Mech Arena and Race Loop.

## Polish batch: full minigame sound, objective distance, capture juice, pause stats, hover train

- Sound now in all seven minigames (added Beam Wars + Dig Duel via miniSound).
- Objective HUD pill shows live distance to the goal ("Find Portal Plaza · 42m").
- Capture juice: a cyan ring pops where a target is netted.
- Pause menu: live stats (score/best/credits/caught), updated control list, and a
  SOUND ON/OFF toggle.
- Hover-train: a sleek multi-car maglev loops a glowing rail at rooftop height for
  living background motion + a landmark.

## Sci-fi building facelift

- Rewrote createWindowTexture: dark glass with a per-tower neon accent hue,
  brighter lit windows, glowing neon mullions (vertical + horizontal), full-width
  "data band" signage strips, and bright edge pillars so tiled facades show
  vertical neon seams. Higher-res (128x192).
- addBuilding: neon roofline trim on most towers (brighter), plus a glowing
  vertical neon spine up tall towers. Window glow raised (1.7 night).

## Animated news-ticker signage

- buildNewsTickers: five big neon billboards around the plaza/avenues that scroll
  humanoid-robot headlines. Strip rendered to a canvas once; the sign advances the
  texture offset each frame (cheap, no per-frame redraw). Per-sign color, rotated
  headline order, glowing frame.

## Ticker upgrades + more building detail

- News tickers: headlines moved to config.news; a fixed "NEWS" tag tab on each
  sign; reactive BREAKING headlines (red) injected at runtime via
  World.pushHeadline - fired on objective complete, mech unlock, and zone arrival.
- Buildings: stacked horizontal neon light-bands wrapping tall towers (Coruscant
  look), on top of the earlier window-texture/spine/roof-trim facelift.

## Building facade research pass

Researched neon-city techniques (threejs SynthCity, procedural skyscraper
generators). Key finding applied: per-window hue + brightness variety with a few
"hot" near-white windows that bloom is the biggest realism factor.
- createWindowTexture: windows now vary widely in hue (tower accent + other neon +
  warm), ~8% are hot near-white (bloom), lit windows get a brighter inner core;
  mullions toned down so windows read.
- Blinking red rooftop aircraft-warning beacons on antenna towers (animated).

## Cinematic grade, wet-road reflections, facade de-tiling

- Engine: final colour-grade + vignette ShaderPass (cool neon-noir tint, gentle
  contrast S-curve, darkened corners). Runs on all tiers, one texture read.
- Wetter Earth roads (lower roughness, higher metalness + envMapIntensity) so neon
  reflects off the tarmac.
- Facade de-tiling: 8 window-texture variants + per-building texture offset so
  neighbouring towers don't share the same lit pattern.
- (Held back the full custom GLSL facade shader: can't visually verify a shader in
  this environment and a compile error would black out the city.)

## Upgrade-prompt pass (camera, HUD, plaza, minimap, perf)

- Camera: lowered start pitch (0.38->0.16) so it looks toward the horizon/city
  instead of down at blank ground; closer distance (8.5) + bigger look-ahead so
  the robot reads big and you see where you're going.
- HUD readability: dark translucent panel backings behind the meter + stat groups
  so text reads over the brighter daytime sky.
- Portal Plaza hero hub: big spinning central rings + a 220m sky beam + neon
  ground-ring marking at the plaza centre.
- Minimap declutter: capped NPC (8) / alien (6) / landmark (14) markers; objective
  + portals always shown.
- Mobile buttons contextual: CAPTURE only when a target is in net range; BOOST/CHUTE
  only when airborne.
- Performance: gated decorative per-building neon (spines, light-bands, blinking
  beacons) to the high tier so mobile keeps the window-texture look at far fewer
  draw calls.

## Finish first-30s: intro mission card + neon route trail

- Intro mission card (hud.missionPopup): a styled sci-fi panel "UNIT 7 ONLINE -
  Portal Plaza detected. Follow the neon route." shown ~5s after the intro ends.
- Neon route trail: a glowing dotted line from spawn to Portal Plaza whose light
  pulses toward the plaza - an unmissable navigation cue (cheap, ~10 quads).
