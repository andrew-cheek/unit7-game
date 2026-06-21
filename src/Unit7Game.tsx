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
const RaceLoop = lazy(() => import('./ui/RaceLoop').then((m) => ({ default: m.RaceLoop })))
const MechArena = lazy(() => import('./ui/MechArena').then((m) => ({ default: m.MechArena })))

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
  // Shared-world multiplayer: show the join/username prompt once, unless disabled.
  const [mpJoined, setMpJoined] = useState(false)
  const multiplayer = config?.multiplayer !== false
  // Touch UI shows on touch-capable devices; `?touch` forces it for testing on desktop.
  const touch = useMemo(
    () => isTouchDevice() || (typeof location !== 'undefined' && location.search.includes('touch')),
    [],
  )
  // Portrait phones squeeze the landscape-first HUD into a thin strip; nudge a rotate.
  const [portrait, setPortrait] = useState(false)
  // One-time touch control coach (the desktop control legend is hidden on touch).
  const [coachDone, setCoachDone] = useState(() => {
    try { return localStorage.getItem('u7.touchcoach.v1') === '1' } catch { return true }
  })
  const dismissCoach = () => {
    try { localStorage.setItem('u7.touchcoach.v1', '1') } catch { /* private mode */ }
    setCoachDone(true)
  }

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

  // Track portrait orientation on touch devices so we can prompt a rotate.
  useEffect(() => {
    if (!touch || typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(orientation: portrait)')
    const onChange = () => setPortrait(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [touch])

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
        <HUD
          hud={hud}
          touch={touch}
          onRestart={() => controlsRef.current?.restartIntro()}
          onToggleMute={() => controlsRef.current?.toggleMute()}
          onPause={() => controlsRef.current?.pause()}
        />
      )}
      {touch && hud && !hud.intro && !hud.minigame && !hud.paused && controlsRef.current && (
        <MobileControls controls={controlsRef.current} hud={hud} />
      )}
      {touch && !coachDone && hud && !hud.intro && !hud.minigame && !hud.paused && (mpJoined || !multiplayer) && (
        <TouchCoach onDismiss={dismissCoach} />
      )}
      {multiplayer && !mpJoined && hud && !hud.intro && (
        <JoinWorld
          onJoin={(name) => {
            gameRef.current?.connectMultiplayer(name, config?.multiplayerHost)
            setMpJoined(true)
          }}
          onSolo={() => setMpJoined(true)}
        />
      )}
      {mpJoined && hud && hud.online > 1 && !hud.intro && !hud.minigame && <OnlinePill n={hud.online} />}
      {mpJoined && hud && hud.leaderboard.length > 0 && !hud.intro && !hud.minigame && <Leaderboard rows={hud.leaderboard} />}
      {hud?.intro && <IntroOverlay onSkip={() => controlsRef.current?.skipIntro()} />}
      {hud?.paused && !hud.minigame && <PauseMenu onResume={() => controlsRef.current?.resume()} touch={touch} hud={hud} onToggleMute={() => controlsRef.current?.toggleMute()} />}
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
      {hud?.minigame === 'raceloop' && controlsRef.current && (
        <Suspense fallback={null}>
          <RaceLoop touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
        </Suspense>
      )}
      {hud?.minigame === 'mecharena' && controlsRef.current && (
        <Suspense fallback={null}>
          <MechArena touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
        </Suspense>
      )}
      {/* Rotate-to-landscape nudge (on top of everything except a minigame). */}
      {touch && portrait && hud && !hud.minigame && <OrientationPrompt />}
    </div>
  )
}

function JoinWorld({ onJoin, onSolo }: { onJoin: (name: string) => void; onSolo: () => void }) {
  const [name, setName] = useState('')
  const submit = () => {
    const n = name.trim()
    if (n) onJoin(n)
  }
  return (
    <div style={joinBackdrop}>
      <div style={joinCard}>
        <div style={{ color: '#27e7ff', textShadow: '0 0 16px #27e7ff', font: '800 26px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.16em' }}>
          UNIT 7
        </div>
        <div style={{ fontSize: 12, letterSpacing: '0.28em', color: 'rgba(223,238,255,0.6)', margin: '10px 0 22px' }}>ENTER THE SHARED WORLD</div>
        <input
          autoFocus
          value={name}
          maxLength={16}
          placeholder="CALLSIGN"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          style={joinInput}
        />
        <button style={joinBtn} onClick={submit} disabled={!name.trim()}>
          JOIN WORLD ▸
        </button>
        <button style={joinSolo} onClick={onSolo}>
          play solo
        </button>
      </div>
    </div>
  )
}

function OnlinePill({ n }: { n: number }) {
  return (
    <div style={onlinePill}>
      <span style={{ color: '#4affc1' }}>●</span> {n} ONLINE
    </div>
  )
}

function Leaderboard({ rows }: { rows: { name: string; score: number }[] }) {
  const top = rows.slice(0, 5)
  return (
    <div style={boardBox}>
      <div style={{ color: 'rgba(39,231,255,0.9)', marginBottom: 6, letterSpacing: '0.2em' }}>WORLD SCORES</div>
      {top.map((r, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, opacity: i === 0 ? 1 : 0.82 }}>
          <span style={{ color: i === 0 ? '#ffd24a' : '#dff0ff' }}>
            {i + 1}. {r.name}
          </span>
          <span style={{ color: '#dff0ff' }}>{r.score}</span>
        </div>
      ))}
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

/** Portrait nudge for touch devices. The 3D HUD is built landscape-first, so
 * portrait squeezes the world into a thin strip; this asks the player to rotate. */
function OrientationPrompt() {
  return (
    <div style={orientBackdrop}>
      <div style={orientPhone} />
      <div style={orientTitle}>ROTATE YOUR DEVICE</div>
      <div style={orientSub}>UNIT 7 PLAYS IN LANDSCAPE</div>
    </div>
  )
}

/** One-time touch control coach. The desktop control legend is hidden on touch,
 * so first-time phone players otherwise get no idea what the zones do. */
function TouchCoach({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div style={coachBackdrop} onPointerDown={(e) => { e.stopPropagation(); onDismiss() }}>
      <div style={{ ...coachTag, left: '8%', bottom: '24%' }}>◄ MOVE ►<div style={coachTagSub}>left thumb</div></div>
      <div style={{ ...coachTag, right: '22%', top: '24%' }}>DRAG TO LOOK<div style={coachTagSub}>right side</div></div>
      <div style={{ ...coachTag, right: '8%', bottom: '24%' }}>ACTIONS<div style={coachTagSub}>tap buttons</div></div>
      <div style={coachCenter}>
        <div style={coachTitle}>HOW TO PLAY</div>
        <div style={coachBody}>Follow the green objective to find Portal Plaza. Reach the neon arcade cabinets to launch the mini-games.</div>
        <div style={coachCta}>TAP TO START ▸</div>
      </div>
    </div>
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
const joinBackdrop: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(4,6,12,0.72)',
  backdropFilter: 'blur(4px)',
}
const joinCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: '34px 40px',
  borderRadius: 16,
  background: 'rgba(8,12,24,0.92)',
  border: '1px solid rgba(39,231,255,0.4)',
  boxShadow: '0 0 40px rgba(39,231,255,0.18)',
}
const joinInput: CSSProperties = {
  width: 220,
  padding: '12px 16px',
  textAlign: 'center',
  font: '700 18px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.18em',
  color: '#dff0ff',
  background: 'rgba(5,8,16,0.9)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 10,
  outline: 'none',
}
const joinBtn: CSSProperties = {
  marginTop: 16,
  width: 252,
  padding: '12px 0',
  cursor: 'pointer',
  font: '800 14px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.2em',
  color: '#04121a',
  background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)',
  border: 'none',
  borderRadius: 10,
}
const joinSolo: CSSProperties = {
  marginTop: 12,
  cursor: 'pointer',
  font: '600 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  color: 'rgba(223,238,255,0.55)',
  background: 'transparent',
  border: 'none',
  textDecoration: 'underline',
}
const onlinePill: CSSProperties = {
  position: 'absolute',
  top: 14,
  right: 16,
  zIndex: 14,
  padding: '6px 12px',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: 'rgba(223,238,255,0.92)',
  background: 'rgba(8,12,24,0.7)',
  border: '1px solid rgba(74,255,193,0.4)',
  borderRadius: 999,
  pointerEvents: 'none',
}
const boardBox: CSSProperties = {
  position: 'absolute',
  top: 44,
  right: 16,
  zIndex: 14,
  minWidth: 168,
  padding: '10px 12px',
  font: '700 12px/1.6 ui-monospace, Menlo, monospace',
  color: 'rgba(223,238,255,0.92)',
  background: 'rgba(8,12,24,0.7)',
  border: '1px solid rgba(39,231,255,0.3)',
  borderRadius: 10,
  pointerEvents: 'none',
}
const KEYFRAMES = `@keyframes unit7pulse{0%,100%{opacity:0.4}50%{opacity:1}}@keyframes unit7rotate{0%,15%{transform:rotate(0deg)}55%,78%{transform:rotate(90deg)}100%{transform:rotate(0deg)}}`
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
const orientBackdrop: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 45,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(4,6,12,0.97)',
  pointerEvents: 'auto',
  textAlign: 'center',
  padding: 24,
}
const orientPhone: CSSProperties = {
  width: 64,
  height: 104,
  border: '3px solid #27e7ff',
  borderRadius: 12,
  boxShadow: '0 0 24px rgba(39,231,255,0.5)',
  animation: 'unit7rotate 2.4s ease-in-out infinite',
}
const orientTitle: CSSProperties = {
  marginTop: 28,
  color: '#27e7ff',
  font: '800 20px/1.2 ui-monospace, Menlo, monospace',
  letterSpacing: '0.18em',
  textShadow: '0 0 16px #27e7ff',
}
const orientSub: CSSProperties = {
  marginTop: 10,
  color: 'rgba(223,238,255,0.72)',
  font: '600 12px/1.5 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
}
const coachBackdrop: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 24,
  background: 'rgba(4,6,12,0.8)',
  pointerEvents: 'auto',
  cursor: 'pointer',
}
const coachTag: CSSProperties = {
  position: 'absolute',
  color: '#27e7ff',
  font: '800 13px/1.2 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  textShadow: '0 0 10px #27e7ff',
  textAlign: 'center',
  pointerEvents: 'none',
}
const coachTagSub: CSSProperties = {
  marginTop: 4,
  color: 'rgba(223,238,255,0.75)',
  font: '600 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
}
const coachCenter: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  maxWidth: 320,
  padding: '0 16px',
  textAlign: 'center',
  pointerEvents: 'none',
}
const coachTitle: CSSProperties = {
  color: '#27e7ff',
  font: '800 18px/1.3 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
  textShadow: '0 0 14px #27e7ff',
}
const coachBody: CSSProperties = {
  marginTop: 8,
  color: 'rgba(223,238,255,0.85)',
  font: '600 12px/1.5 ui-monospace, Menlo, monospace',
  letterSpacing: '0.06em',
}
const coachCta: CSSProperties = {
  marginTop: 16,
  color: '#05060b',
  background: '#27e7ff',
  borderRadius: 999,
  padding: '8px 18px',
  font: '800 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  boxShadow: '0 0 18px rgba(39,231,255,0.5)',
}
