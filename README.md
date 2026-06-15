# Unit 7

A polished, futuristic third-person sci-fi browser game built in plain Three.js (r160), packaged as a single self-contained React component, `<Unit7Game />`, that drops into any React + Vite + TypeScript project (such as Lovable).

It runs immediately on hand-built procedural art (robot, neon city, NPCs, vehicles, starfield sky) and automatically upgrades to real CC0 GLB/HDR/PBR assets when you add them, so it is always runnable with zero asset files present.

## Highlights

- Third-person robot controller with acceleration/deceleration, sprint + stamina, and a springy pointer-lock orbit camera that avoids clipping through walls.
- Capsule-vs-AABB collision (hard-blocks buildings, slides along walls) plus a downward ground raycast so the player and vehicles follow terrain and **drive smoothly up ramps**, with vehicle pitch aligned to the slope.
- Jetpack (hold-to-fly + fuel meter), a visible **parachute** with gravity-damped descent clamped to terminal velocity (never teleports), an animated robot to plane **morph**, and a **net** that captures NPCs/aliens with a projected arc.
- Three distinct vehicles: a sleek hovercar, a saucer/shuttle spaceship, and a rocket with a launch sequence.
- Earth (neon city), Mars (red, low gravity) and Moon (gray, cratered, lower gravity) zones with their own skyboxes and gravity, reachable by walk-through portals or the rocket.
- Live world: window-lit towers, holographic billboards, a neon road grid, wet reflective roads, hovering drones, hovercar traffic, boids-driven android crowds, scattered powerups (speed / shield / fuel / score), and periodic spaceships that land and release wandering aliens.
- Skippable factory-assembly intro cinematic, an ESC pause menu that never leaves the page, full desktop + touch controls, bloom + ACES tone mapping, and clean teardown on unmount.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:5173 (this repo runs it on 5183)
```

`npm run build` produces a production bundle; `npm run preview` serves it.

## Drop it into a Lovable (React + Vite + TS) project

Copy `src/game/`, `src/ui/`, and `src/Unit7Game.tsx` into your project's `src/`, copy the `public/unit7/` folder into your `public/`, run `npm i three` (version pinned below), and render the component on a page inside a sized container:

```tsx
import Unit7Game from './Unit7Game'

export default function Page() {
  // The component fills its parent, so give it a sized box.
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Unit7Game />
    </div>
  )
}
```

That is the whole integration. Notes:

- **One default export.** `Unit7Game` imports everything it needs; nothing leaks to the host's global scope (the only `window` reference is a dev-only debug handle gated by `import.meta.env.DEV`, which is stripped from production builds).
- **No global CSS, no singletons, no Vite config changes.** All styling is inline/scoped; assets are loaded at runtime from `/unit7/`, so you do not need `assetsInclude` or any other build tweak. (The `vite.config.ts` here only contains the standard React plugin plus an optional `assetsInclude` that this component does not rely on.)
- **Self-contained teardown.** The engine mounts in a mount-once `useEffect` and fully tears down on unmount: it disposes the renderer, geometries, materials and textures, cancels `requestAnimationFrame`, releases the WebGL context, and removes every event listener. It survives React StrictMode double-mounting and Lovable hot reloads / route changes.

## Component API

```tsx
<Unit7Game
  config={{
    startInIntro: true,      // play the factory cinematic first (default true)
    quality: 'high',         // 'high' | 'low'; default: 'low' on touch devices, else 'high'
    initialZone: 'earth',    // 'earth' | 'mars' | 'moon' (default 'earth')
  }}
  className="..."            // optional, passed to the root div
  style={{ ... }}            // optional, merged onto the root div
/>
```

All props are optional. `quality: 'low'` reduces texture/shadow resolution, pixel ratio, MSAA, and crowd/ambient counts for lower-end and mobile devices.

## Controls

**Desktop:** WASD move, Shift sprint, Space/J jetpack (hold), F boost, G enter/exit vehicle, H net, T morph robot/plane, O parachute, Esc pause. Click the canvas to capture the mouse for look. All game keys call `preventDefault`, so Space never scrolls the page and Esc only opens the pause menu.

**Mobile / touch:** a left thumb-stick for movement, a right-side drag area for the camera, and a compact bottom-right action cluster (Jet hold, Boost hold, Sprint toggle, Net, G, Morph, Chute). The touch UI auto-appears on touch devices; append `?touch` to the URL to force it on desktop for testing.

## Assets: procedural now, real assets when you want

The game ships with everything procedural, so it always runs. To use the recommended CC0 assets:

1. Drop files into `public/unit7/<path>` using the paths listed in `public/unit7/manifest.json`.
2. Set `"useAssets": true` in `public/unit7/manifest.json`.

Anything listed but missing or failing to load silently falls back to its procedural placeholder, so the game keeps running while you fill assets in. `src/game/AssetLoader.ts` does the loading via `GLTFLoader` / `RGBELoader` / `TextureLoader`.

**Asset folder used:** `public/unit7/` (served statically at runtime; no import URLs and no Vite config required). The `src/assets/` folders are also scaffolded if you prefer to bundle via imports instead.

Expected files and sources (all CC0 / commercial-safe):

| File (under `public/unit7/`) | Use | Source |
| --- | --- | --- |
| `env/night_city.hdr` | IBL + skybox + reflections | Poly Haven night HDRI (e.g. Dikhololo Night), 4K |
| `textures/asphalt|metal|concrete/*` | Roads, trims, structures (albedo/normal/rough) | Poly Haven Textures, 2K, glTF download |
| `models/town/*.glb`, `models/streets/*.glb` | Modular city + roads/ramps | Quaternius Cyberpunk / Downtown MegaKit; Kenney City Kit |
| `models/player_robot.glb` | Rigged animated player (idle/walk/run/jump) | Quaternius Animated Robot Pack |
| `models/npc_men.glb`, `models/npc_women.glb` | Rigged townspeople | Quaternius Ultimate Modular Men/Women |
| `models/alien.glb` | Rigged alien | Quaternius Animated Alien Pack |
| `models/vehicle_hovercar.glb`, `models/spaceship.glb`, `models/rocket.glb` | Three distinct vehicles | Quaternius Cars + Ultimate Spaceships; Kenney Car Kit |
| `anim/universal_animations.glb` | Shared clips to retarget | Quaternius Universal Animation Library |

The two reference GIFs (`unit7-asset-sources-tour.gif`, `unit7-asset-examples.gif`) are a visual guide to grabbing these from polyhaven.com, quaternius.com and kenney.nl.

## Project structure

```
src/
  Unit7Game.tsx        the ONLY component Lovable imports; mounts canvas + HUD
  App.tsx, main.tsx    local dev harness (not used by Lovable)
  game/
    Engine.ts          renderer, scene, camera, EffectComposer + UnrealBloom, loop, dispose
    Game.ts            orchestrator: wires all subsystems, pause, zone travel, HUD
    Player.ts          controller + states (robot / plane / parachute / vehicle)
    Physics.ts         capsule+AABB collision, downward ground raycast, slopes
    Camera.ts          spring follow + pointer-lock orbit + wall-collision raycast
    Input.ts           unified keyboard / pointer-lock mouse / touch
    NPC.ts             boids separation + per-agent walk animation + net capture
    Vehicles.ts        hovercar (ground-follow) + spaceship (fly) + rocket
    World.ts           city, ground/ramps, neon skyline, sky, fog, lights
    Zones.ts           Earth / Mars / Moon (gravity + terrain + skybox swap) + portals
    Events.ts          landing spaceships, aliens, powerups, drones, traffic
    Intro.ts           factory assembly cinematic (skippable)
    config.ts          tunables
    AssetLoader.ts     GLB/HDR/texture loading with procedural fallbacks
    procedural.ts      all procedural models + sky + facade textures
    utils.ts, types.ts
  ui/
    HUD.tsx            meters, score, radar, prompts, control hints
    MobileControls.tsx joystick + touch look + action bar
    PauseMenu.tsx      in-game pause menu
public/unit7/          runtime assets + manifest.json (procedural until filled)
```

`src/game/` is plain Three.js with no React imports, so it stays portable.

## Tech stack (pinned)

| Package | Version |
| --- | --- |
| three | 0.160.0 |
| @types/three | 0.160.0 |
| react / react-dom | 18.2.0 |
| @vitejs/plugin-react | 4.2.1 |
| vite | 5.2.11 |
| typescript | 5.4.5 |

Addons used from `three/examples/jsm`: `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `OutputPass`, `RGBELoader`, `GLTFLoader`, `PointerLockControls`.

## Performance

Targets 60fps desktop and 30+ mobile. Techniques in use: capped pixel ratio and quality tiers, MSAA only on `high`, the sun's shadow frustum follows the player for crisp shadows over a small area, fog-capped draw distance, the crowd does not cast shadows, frustum culling, and crowd/ambient counts scale down on `low`/touch. The bundle is dominated by Three.js (~230kB gzipped).

Note on instancing: NPCs and aliens are individually transformed meshes (so each can animate its own walk cycle) with frustum culling and quality-scaled counts, rather than GPU-instanced. With real rigged GLB characters you would switch to `InstancedMesh` / instanced-skinning; that swap is the natural next optimization and is isolated to `NPC.ts` / `Events.ts`.
