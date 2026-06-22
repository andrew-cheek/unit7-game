# Unit 7 - Game Development Guide

This file tells Claude Code how Unit 7 is built and how to work on it. Read it at the start of every session.

## What Unit 7 is

A Three.js sci-fi sandbox game running in the browser. The defining constraint: **it must look great on desktop and run smoothly on mobile.** These two goals pull in opposite directions, so the architecture is built around quality tiers, not a single render path.

Live at https://unit7.humanoidrobots.com. Repo: https://github.com/andrew-cheek/unit7-game.

## The core gameplay loop

The game is structured as a quest chain across four modes. Each mode should be a self-contained scene that the mode manager loads and unloads cleanly. Do not build these as one monolithic scene.

1. **Booster Run** - traversal / movement mode
2. **Rocket Launch minigame** - timing/skill minigame
3. **Magnet Defense** - defensive survival mode
4. **Police Chase** - pursuit mode

The viral loop runs through this chain. Keep transitions between modes fast and seamless. A janky mode switch breaks the whole experience.

## Non-negotiable: quality tiers

Detect the device class on load and pick a tier. Never ship one render path for all devices.

**Desktop (high tier)**
- Full devicePixelRatio (capped at 2)
- Post-processing: bloom, depth of field
- High-res shadow maps
- Full particle counts
- Higher poly LODs

**Mobile (low tier)**
- devicePixelRatio capped lower (1 to 1.5)
- No post-processing, or minimal
- Simplified or disabled shadows
- Reduced particle counts
- Lower poly LODs, aggressive culling

Tier detection should run once at startup using a quick GPU/feature probe plus a mobile user-agent check, with a manual override toggle for testing. Build a single `QualityTier` config object that every system reads from, so changing one value cascades correctly.

## Architecture rules

- **Game loop:** requestAnimationFrame for rendering, fixed timestep for physics and game logic. Physics must never be tied to frame rate. This is the single most important rule for mobile performance and consistency.
- **Physics:** prefer Rapier (Rust/WASM, fast) over Cannon.js unless there's a reason already in the codebase to stay on Cannon.
- **Scene/mode management:** a mode manager owns loading, activating, and disposing each of the four modes. Always dispose Three.js geometries, materials, and textures on mode exit to prevent memory leaks. This bites hard on mobile.
- **Assets:** compress textures to KTX2/Basis. Use LOD meshes. Lazy-load per mode rather than loading everything upfront.
- **State:** keep game state separate from render state. The render layer reads from state; it does not own it.

## Performance targets

- Desktop: lock 60fps
- Mid-range mobile: hold 30fps minimum, target 60 where possible
- No frame-rate-dependent gameplay. Same physics outcome at any frame rate.
- Watch memory on mode switches. Profile for leaks.

## Working style

- Audit before refactoring. Report findings, propose a plan, wait for approval before large changes.
- Make changes in phases, not one giant rewrite.
- After each change that affects rendering or physics, note the mobile-vs-desktop tradeoff.
- Plain commit messages. No filler.

## Stack

- Build: Vite
- Engine: Three.js
- Physics: Rapier (target)
- Deploy: humanoidrobots.com
