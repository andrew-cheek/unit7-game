import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Game } from './game/Game'
import { isTouchDevice } from './game/utils'
import type { GameControls, HudState, Unit7Config } from './game/types'
import { loadCallsign, saveCallsign } from './game/storage'
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
const DriveMad = lazy(() => import('./ui/DriveMad').then((m) => ({ default: m.DriveMad })))
const BeamWarsLive = lazy(() => import('./ui/BeamWarsLive').then((m) => ({ default: m.BeamWarsLive })))

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
      {hud && !hud.intro && !hud.minigame && !hud.match && (
        <HUD
          hud={hud}
          touch={touch}
          onRestart={() => controlsRef.current?.restartIntro()}
          onToggleMute={() => controlsRef.current?.toggleMute()}
          onChallenge={(id) => controlsRef.current?.challengePilot(id)}
          onBuy={(id) => controlsRef.current?.buyCosmetic(id)}
          onEquip={(slot, id) => controlsRef.current?.equipCosmetic(slot, id)}
        />
      )}
      {touch && hud && !hud.intro && !hud.minigame && !hud.match && !hud.paused && controlsRef.current && (
        <MobileControls controls={controlsRef.current} hud={hud} />
      )}
      {multiplayer && !mpJoined && hud && !hud.intro && (
        <JoinWorld
          onJoin={(name) => {
            saveCallsign(name)
            gameRef.current?.connectMultiplayer(name, config?.multiplayerHost)
            setMpJoined(true)
          }}
          onSolo={() => setMpJoined(true)}
        />
      )}
      {mpJoined && hud && hud.online > 1 && !hud.intro && !hud.minigame && <OnlinePill n={hud.online} />}
      {mpJoined && hud && hud.leaderboard.length > 0 && !hud.intro && !hud.minigame && <Leaderboard rows={hud.leaderboard} />}
      {hud?.intro && <IntroOverlay onSkip={() => controlsRef.current?.skipIntro()} />}
      {hud?.paused && !hud.minigame && <PauseMenu onResume={() => controlsRef.current?.resume()} touch={touch} hud={hud} onToggleMute={() => controlsRef.current?.toggleMute()} onCycleNeon={() => controlsRef.current?.cycleNeon()} />}
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
      {hud?.minigame === 'drivemad' && controlsRef.current && (
        <Suspense fallback={null}>
          <DriveMad touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
        </Suspense>
      )}
      {hud?.match && controlsRef.current && (
        <Suspense fallback={null}>
          <BeamWarsLive
            match={hud.match}
            touch={touch}
            onDir={(dx, dy) => controlsRef.current?.matchDir(dx, dy)}
            onQuit={() => controlsRef.current?.quitMatch()}
            onRematch={() => controlsRef.current?.rematch()}
          />
        </Suspense>
      )}
      {hud?.challenge && !hud.match && !hud.minigame && controlsRef.current && (
        <ChallengePopup
          name={hud.challenge.name}
          onAccept={() => controlsRef.current?.acceptChallenge()}
          onDecline={() => controlsRef.current?.declineChallenge()}
        />
      )}
    </div>
  )
}

function ChallengePopup({ name, onAccept, onDecline }: { name: string; onAccept: () => void; onDecline: () => void }) {
  // Keyboard accept/decline so it works even while the mouse pointer is locked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') { onAccept(); e.preventDefault() }
      else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { onDecline(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAccept, onDecline])
  return (
    <div style={challengeWrap}>
      <div style={challengeCard}>
        <div style={{ color: '#ff2bd0', font: '800 14px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', marginBottom: 8 }}>DUEL CHALLENGE</div>
        <div style={{ color: '#dff0ff', font: '700 16px/1.4 ui-monospace, Menlo, monospace', marginBottom: 16 }}>
          <span style={{ color: '#27e7ff' }}>{name}</span> wants to face you in Beam Wars
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button style={challengeAccept} onClick={onAccept}>ACCEPT ▸</button>
          <button style={challengeDecline} onClick={onDecline}>DECLINE</button>
        </div>
        <div style={{ marginTop: 10, color: 'rgba(223,238,255,0.45)', font: '600 10px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em' }}>
          press Y to accept · N to decline
        </div>
      </div>
    </div>
  )
}

function JoinWorld({ onJoin, onSolo }: { onJoin: (name: string) => void; onSolo: () => void }) {
  const [name, setName] = useState(() => loadCallsign())
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
const challengeWrap: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 90,
  transform: 'translateX(-50%)',
  zIndex: 42,
  pointerEvents: 'auto',
}
const challengeCard: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  padding: '18px 24px',
  maxWidth: '88vw',
  borderRadius: 14,
  background: 'rgba(8,12,24,0.94)',
  border: '1px solid rgba(255,43,208,0.5)',
  boxShadow: '0 0 30px rgba(255,43,208,0.25)',
}
const challengeAccept: CSSProperties = {
  cursor: 'pointer',
  padding: '10px 20px',
  font: '800 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: '#04121a',
  background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)',
  border: 'none',
  borderRadius: 10,
}
const challengeDecline: CSSProperties = {
  cursor: 'pointer',
  padding: '10px 18px',
  font: '700 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
  color: 'rgba(223,238,255,0.8)',
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 10,
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
