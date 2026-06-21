import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Game } from './game/Game'
import { isTouchDevice } from './game/utils'
import type { GameControls, HudState, Unit7Config } from './game/types'
import { HUD } from './ui/HUD'
import { PauseMenu } from './ui/PauseMenu'
import { MobileControls } from './ui/MobileControls'

// The arcade minigames are split into their own chunks and only fetched when a
// portal is entered, so the initial city load stays light (important on mobile
// over cellular). Suspense shows nothing while the small chunk streams in.
const BeamWars = lazy(() => import('./ui/BeamWars').then((m) => ({ default: m.BeamWars })))
const DigDuel = lazy(() => import('./ui/DigDuel').then((m) => ({ default: m.DigDuel })))
const Game2048 = lazy(() => import('./ui/Game2048').then((m) => ({ default: m.Game2048 })))
const Invaders = lazy(() => import('./ui/Invaders').then((m) => ({ default: m.Invaders })))
const Snake = lazy(() => import('./ui/Snake').then((m) => ({ default: m.Snake })))

export interface Unit7GameProps {
  config?: Unit7Config
  className?: string
  style?: CSSProperties
}

/**
 * The single component Lovable imports. Everything else (the Three.js engine and
 * subsystems under ./game, the HUD under ./ui) is pulled in by this file. It
 * mounts the engine into a ref'd container in a mount-once effect and tears it
 * down completely on unmount so it survives hot reloads and route changes.
 */
export default function Unit7Game({ config, className, style }: Unit7GameProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Game | null>(null)
  const controlsRef = useRef<GameControls | null>(null)
  const [hud, setHud] = useState<HudState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Touch UI shows on touch-capable devices; `?touch` forces it for testing on desktop.
  const touch = useMemo(
    () => isTouchDevice() || (typeof location !== 'undefined' && location.search.includes('touch')),
    [],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let game: Game
    try {
      game = new Game(container, config ?? {}, setHud)
      gameRef.current = game
      controlsRef.current = game.controls
      game.start()
    } catch (e) {
      // Surface a startup crash on-screen instead of a silent black page.
      console.error('[Unit7] startup failed:', e)
      setErr(String((e as Error)?.stack || (e as Error)?.message || e))
      return
    }

    return () => {
      game.dispose()
      gameRef.current = null
      controlsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the screen awake while playing (mobile). Re-acquire when the tab
  // becomes visible again, since the OS drops the lock on blur. No-op where the
  // Screen Wake Lock API is unavailable.
  useEffect(() => {
    type Sentinel = { release: () => Promise<void> }
    const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<Sentinel> } }).wakeLock
    if (!wl) return
    let sentinel: Sentinel | null = null
    let cancelled = false
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible') sentinel = await wl.request('screen')
      } catch {
        /* lock denied (e.g. low battery) - ignore */
      }
    }
    const onVis = () => { if (!cancelled && document.visibilityState === 'visible' && !sentinel) acquire() }
    acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      sentinel?.release().catch(() => {})
    }
  }, [])

  return (
    <div ref={containerRef} className={className} style={{ ...rootStyle, ...style }}>
      <style>{KEYFRAMES}</style>
      {err && (
        <div style={errStyle}>
          <div style={{ color: '#ff2bd0', fontWeight: 800, marginBottom: 8 }}>UNIT 7 — STARTUP ERROR</div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{err}</pre>
        </div>
      )}
      {hud && !hud.intro && !hud.minigame && (
        <HUD hud={hud} touch={touch} onRestart={() => controlsRef.current?.restartIntro()} />
      )}
      {touch && hud && !hud.intro && !hud.minigame && !hud.paused && controlsRef.current && (
        <MobileControls controls={controlsRef.current} hud={hud} />
      )}
      {hud?.intro && <IntroOverlay onSkip={() => controlsRef.current?.skipIntro()} />}
      {hud?.paused && !hud.minigame && <PauseMenu onResume={() => controlsRef.current?.resume()} touch={touch} />}
      {hud?.minigame === 'beamwars' && controlsRef.current && (
        <Suspense fallback={null}>
          <BeamWars touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
        </Suspense>
      )}
      {hud?.minigame === 'digduel' && controlsRef.current && (
        <Suspense fallback={null}>
          <DigDuel touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
        </Suspense>
      )}
      {hud?.minigame === 'merge2048' && controlsRef.current && (
        <Suspense fallback={null}>
          <Game2048 touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
        </Suspense>
      )}
      {hud?.minigame === 'invaders' && controlsRef.current && (
        <Suspense fallback={null}>
          <Invaders touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
        </Suspense>
      )}
      {hud?.minigame === 'snake' && controlsRef.current && (
        <Suspense fallback={null}>
          <Snake touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
        </Suspense>
      )}
    </div>
  )
}

function IntroOverlay({ onSkip }: { onSkip: () => void }) {
  return (
    <>
      <div style={introTitle}>
        <div style={{ color: '#27e7ff', textShadow: '0 0 16px #27e7ff' }}>UNIT 7</div>
        <div style={{ fontSize: 12, letterSpacing: '0.35em', color: 'rgba(223,238,255,0.6)', marginTop: 8 }}>ASSEMBLY SEQUENCE</div>
      </div>
      <button style={skipBtn} onClick={onSkip}>
        SKIP ▸
      </button>
    </>
  )
}

const rootStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  background: '#05060b',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  touchAction: 'none',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const introTitle: CSSProperties = {
  position: 'absolute',
  left: 28,
  bottom: 28,
  zIndex: 15,
  font: '800 34px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  pointerEvents: 'none',
}
const skipBtn: CSSProperties = {
  position: 'absolute',
  right: 24,
  bottom: 24,
  zIndex: 15,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '10px 22px',
  font: '700 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.2em',
  color: 'rgba(223,238,255,0.92)',
  background: 'rgba(8,12,24,0.7)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 999,
}
const KEYFRAMES = `@keyframes unit7pulse{0%,100%{opacity:0.4}50%{opacity:1}}`
const errStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 50,
  padding: 20,
  overflow: 'auto',
  background: 'rgba(5,6,11,0.96)',
  color: 'rgba(223,238,255,0.92)',
  font: '500 12px/1.5 ui-monospace, Menlo, monospace',
}
