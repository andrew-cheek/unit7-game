# Unit 7 - Game Development Guide

This file tells Claude Code how Unit 7 is built and how to work on it. Read it at the start of every session.

## What Unit 7 is

A browser sci-fi sandbox built on vanilla Three.js (r160). You drop into a neon city as a robot and free-roam it with WASD: run, jump, hold to fly a jetpack, ride a hoverboard, pilot vehicles and battle mechs, capture aliens, travel off-world, and step into a walk-in arcade of cabinet minigames. Single-player by default, with an optional shared multiplayer world (usernames, other players visible).

The defining constraint: it must look great on desktop and run smoothly on mobile. Those two goals pull in opposite directions, so the architecture is built around quality tiers, not a single render path.

Live at https://unit7.humanoidrobots.com. Repo: https://github.com/andrew-cheek/unit7-game. A React shell hosts the canvas and the minigame overlays; everything in `src/game` is framework-free.

## The core experience

There is no fixed level sequence. The world is the content, with a light guided objective chain layered on top so first-time players have direction.

1. **Opening.** An interactive orbital drop-in over the city (thread the rings, time the chute), or a scripted factory intro. Both are skippable and hand off to free roam.
2. **Free roam (Earth).** A neon city with a day/night cycle, NPC crowds, patrols, traffic, ambient world events, races, dance floors and trampolines. Capture roaming aliens with the net gun; earn XP, credits and daily objectives.
3. **Guided objective chain** (`config.missions`, one active at a time, with a beacon + distance guide): reach Portal Plaza, pilot a battle mech, travel to the Moon, travel to Mars, capture aliens, play an arcade game, then free roam. Each step pays escalating XP/credits.
4. **Off-world zones.** Moon and Mars, reached through walk-through portals or the rocket gate, each with its own gravity and atmosphere.
5. **Arcade.** A walk-in building near spawn whose doors launch 8 self-contained cabinet minigames (Beam Wars, Snake, Invaders, Race Loop, Dig Duel, Mech Arena, 2048, Drive Frenzy), entered through a short transport-beam beat.
6. **Multiplayer (optional).** A PartyKit-backed shared world: other players appear as tinted robots with name tags, and a server-owned alien swarm is shared. No-ops cleanly when playing solo.

Keep transitions (zone changes, minigame enter/exit, drop-in hand-off) fast and clean. A janky transition breaks the experience.

## Non-negotiable: quality tiers

Detect the device class on load and pick a tier (`tiers.ts`: high / medium / low). Never ship one render path for all devices. A single QualityTier object (`config.tier`) is what every system reads, so changing one value cascades correctly.

**Desktop (high)**: full devicePixelRatio (capped at 2), post-processing (bloom + depth of field), shadows, full particle/light counts, accent lights on.

**Mobile (low)**: lower DPR cap, minimal or no post, simplified or disabled shadows, reduced particles, accent lights off, aggressive culling.

Tier detection runs once at startup. Adaptive resolution (`renderScale` in Engine) then trades sharpness for frame rate at runtime to hold the floor.

## Architecture

- **Engine (`Engine.ts`).** Owns the renderer, EffectComposer (bloom at half-res, optional bokeh DoF on desktop), the rAF loop, adaptive resolution and the FPS readout. Exposes two hooks: `onUpdate` (fixed-timestep sim) and `onRender` (once per rendered frame, just before the composer).
- **Game loop.** rAF drives rendering; a clamped fixed-timestep accumulator drives simulation and physics, so gameplay is identical at any frame rate. The follow camera and pointer-look are driven in `onRender` (per rendered frame, with frame-rate-independent damping), NOT the fixed step, so they stay smooth on 120/144Hz displays.
- **Physics (`Physics.ts`).** Custom, not a physics library: a downward raycast for terrain/ramp/platform ground-following, plus AABB capsule resolution against building colliders. Rapier/Cannon were never adopted; do not add one without a strong reason.
- **`Game.ts`** is the orchestrator. Keep extracting cohesive systems out of it rather than growing it. Existing systems: `MissionSystem`, `ArcadeSystem`, `Landmarks`, `World`, `Camera`, `Vehicles`, `Player`, `Input`, `NPC`, `Patrols`, `Events`, `WorldEvents`, `Sky`, `Zones`, `RobotFactory`, `DropIn`, `Intro`, multiplayer (`Net`, `RemotePlayers`, `SharedAliens`), `progression`/`storage`, `procedural` (geometry), `tiers`/`config`.
- **Disposal.** Dispose Three.js geometries, materials and textures on zone/minigame exit. Prefer pooling reused objects (see Missiles' ring pool and ArcadeSystem's single transport beam) over per-event allocation. Leaks bite hard on mobile.
- **Assets.** Procedural-first: geometry and textures are generated in code (`procedural.ts`), not loaded as heavy art. Minigames lazy-load per entry.
- **State** lives apart from render state. The render layer reads from state; it does not own it.

## Performance targets

- Desktop: 60fps, smooth render up to the display refresh.
- Mid-range mobile: hold 30fps minimum, target 60 where possible.
- No frame-rate-dependent gameplay. Same physics outcome at any frame rate.
- Avoid per-frame heap allocation in update loops; reuse scratch vectors/colors.
- Watch memory on zone/minigame switches. Profile for leaks.

## Working style

- Audit before refactoring. Report findings, propose a plan, wait for approval before large changes.
- Make changes in phases, not one giant rewrite.
- After each change that affects rendering or physics, note the mobile-vs-desktop tradeoff.
- Verify before claiming done: `npm run typecheck`, `npm run build`, and exercise it in the browser.
- Plain commit messages. No filler.

## Debugging

- `window.__UNIT7__` is the Engine (present in prod). `window.__unit7` is the Game, exposed in dev or in prod with `?debug`. Use these to inspect and drive systems from the console.

## Stack

- Build: Vite (`npm run build` = `tsc -b` + `vite build`)
- Engine: Three.js r160
- UI shell + minigames: React 18 (`src/ui`)
- Physics: custom raycast + AABB (`Physics.ts`)
- Multiplayer: PartyKit (`party/server.ts`; `npm run party:deploy`)
- Deploy: Netlify, auto-deploys on push to `main`; live at unit7.humanoidrobots.com
