import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { Game } from './game/Game'
import { isTouchDevice } from './game/utils'
import { trackEvent } from './lib/analytics'
import type { GameControls, HudState, Unit7Config } from './game/types'
import { loadCallsign, saveCallsign } from './game/storage'
import { WARP_FORMS } from './game/WarpForms'
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
  // Portrait phones squeeze the landscape-first HUD into a thin strip; nudge a rotate.
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
      const message = String((e as Error)?.message || e).slice(0, 300)
      trackEvent('startup_error', { message })
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

  // The welcome panel needs the cursor free (pointer-lock would hide it and
  // swallow clicks), so disable lock while it's up and restore it once the
  // player picks solo / multiplayer. Only touch lock around the panel - never
  // during the intro/drop, which manages the cursor itself.
  const joinPanelVisible = multiplayer && !mpJoined && !!hud && !hud.intro
  const wasPanelRef = useRef(false)
  useEffect(() => {
    if (joinPanelVisible) {
      controlsRef.current?.setCursorLockEnabled(false)
      wasPanelRef.current = true
    } else if (wasPanelRef.current) {
      controlsRef.current?.setCursorLockEnabled(true)
      wasPanelRef.current = false
    }
  }, [joinPanelVisible])

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
          onPause={() => controlsRef.current?.pause()}
          onChallenge={(id) => controlsRef.current?.challengePilot(id)}
          onBuy={(id) => controlsRef.current?.buyCosmetic(id)}
          onEquip={(slot, id) => controlsRef.current?.equipCosmetic(slot, id)}
          onWarp={() => controlsRef.current?.toggleWarp()}
          hideTopCenter={touch && joinPanelVisible}
        />
      )}
      {touch && hud && !hud.intro && !hud.minigame && !hud.match && !hud.paused && controlsRef.current && (
        <MobileControls controls={controlsRef.current} hud={hud} />
      )}
      {touch && !coachDone && hud && !hud.intro && !hud.minigame && !hud.paused && (mpJoined || !multiplayer) && (
        <TouchCoach onDismiss={dismissCoach} />
      )}
      {multiplayer && !mpJoined && hud && !hud.intro && (
        <JoinWorld
          touch={touch}
          onJoin={(name) => {
            saveCallsign(name)
            gameRef.current?.connectMultiplayer(name, config?.multiplayerHost)
            setMpJoined(true)
          }}
          onSolo={() => {
            gameRef.current?.startSolo()
            setMpJoined(true)
          }}
        />
      )}
      {mpJoined && hud && hud.online > 1 && !hud.intro && !hud.minigame && <OnlinePill n={hud.online} />}
      {mpJoined && hud && hud.leaderboard.length > 0 && !hud.intro && !hud.minigame && <Leaderboard rows={hud.leaderboard} />}
      {hud?.intro && hud.drop && (
        <DropOverlay
          drop={hud.drop}
          touch={touch}
          onDeploy={() => controlsRef.current?.dropDeploy()}
          onTrick={() => controlsRef.current?.dropTrick()}
          onJet={(down) => controlsRef.current?.pressAction('jet', down)}
          onSteer={(x, y) => controlsRef.current?.setVirtualMove(x, y)}
        />
      )}
      {hud?.intro && !hud.drop && <IntroOverlay onSkip={() => controlsRef.current?.skipIntro()} />}
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
      {hud?.warp.menu && !hud.match && !hud.minigame && controlsRef.current && (
        <WarpMenu
          warp={hud.warp}
          onPick={(id) => controlsRef.current?.warpInto(id)}
          onRevert={() => controlsRef.current?.warpRevert()}
          onClose={() => controlsRef.current?.toggleWarp()}
        />
      )}
    </div>
  )
}

function WarpMenu({
  warp,
  onPick,
  onRevert,
  onClose,
}: {
  warp: { ready: boolean; active: string | null }
  onPick: (id: string) => void
  onRevert: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Note: R is handled by the engine (toggleWarp) so it both opens and closes;
      // don't also close here or the two toggles cancel out. Escape closes.
      if (e.key === 'Escape') { onClose(); e.preventDefault(); return }
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= WARP_FORMS.length && warp.ready) { onPick(WARP_FORMS[n - 1].id); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPick, onClose, warp.ready])
  const hex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
  return (
    <div style={warpWrap} onClick={onClose}>
      <div style={warpCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ color: '#27e7ff', font: '800 16px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.2em', marginBottom: 4 }}>WARP GATE</div>
        <div style={{ color: 'rgba(223,238,255,0.6)', font: '600 11px/1.4 ui-monospace, Menlo, monospace', marginBottom: 14 }}>
          {warp.ready ? 'Pick a form to teleport into (1-7 or tap).' : 'Charge not ready - keep playing to recharge.'}
        </div>
        <div style={warpGrid}>
          {WARP_FORMS.map((f, i) => (
            <button
              key={f.id}
              style={{ ...warpItem, borderColor: warp.active === f.id ? hex(f.color) : 'rgba(255,255,255,0.14)', opacity: warp.ready ? 1 : 0.4, cursor: warp.ready ? 'pointer' : 'not-allowed' }}
              onClick={() => warp.ready && onPick(f.id)}
            >
              <span style={{ width: 26, height: 26, borderRadius: 7, background: hex(f.color), boxShadow: `0 0 12px ${hex(f.color)}`, flexShrink: 0 }} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ color: '#eaf4ff', fontWeight: 800, fontSize: 11 }}>{i + 1}. {f.name}</span>
                <span style={{ color: 'rgba(223,238,255,0.55)', fontSize: 9 }}>{f.desc}</span>
              </span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'center' }}>
          {warp.active && <button style={warpRevertBtn} onClick={onRevert}>RETURN TO ROBOT</button>}
          <button style={warpCloseBtn} onClick={onClose}>CLOSE</button>
        </div>
      </div>
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

/**
 * Non-blocking welcome panel docked on the LEFT — the game keeps running behind
 * it (no backdrop), so you can already roam. Start with the two choices; picking
 * Multiplayer reveals the callsign entry.
 */
function JoinWorld({ onJoin, onSolo, touch }: { onJoin: (name: string) => void; onSolo: () => void; touch: boolean }) {
  const [mode, setMode] = useState<'choice' | 'name'>('choice')
  const [name, setName] = useState(() => loadCallsign())
  const submit = () => {
    const n = name.trim()
    if (n) onJoin(n)
  }
  // On touch the left-docked panel sits on top of the floating joystick zone, so
  // dock it top-centre there instead (out of both thumbs' way). Desktop keeps the
  // original left dock.
  const panelStyle = touch ? { ...welcomePanel, ...welcomePanelTouch } : welcomePanel
  return (
    <div style={panelStyle}>
      <div style={{ color: '#27e7ff', textShadow: '0 0 16px #27e7ff', font: '800 19px/1.1 ui-monospace, Menlo, monospace', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
        Welcome, Unit 7.
      </div>
      {mode === 'choice' ? (
        <>
          <div style={welcomeSub}>Choose how to play.</div>
          <button style={welcomeBtnPrimary} onClick={onSolo}>ROAM &amp; PLAY SOLO ▸</button>
          <button style={welcomeBtnGhost} onClick={() => setMode('name')}>MULTIPLAYER ▸</button>
        </>
      ) : (
        <>
          <div style={welcomeSub}>Pick a callsign other pilots will see.</div>
          <input
            autoFocus
            value={name}
            maxLength={16}
            placeholder="CALLSIGN"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            style={welcomeInput}
          />
          <button style={welcomeBtnPrimary} onClick={submit} disabled={!name.trim()}>JOIN WORLD ▸</button>
          <button style={welcomeBtnGhost} onClick={() => setMode('choice')}>◂ BACK</button>
        </>
      )}
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
      <button style={skipBtn} onClick={onSkip}>SKIP ▸</button>
    </>
  )
}

type DropState = NonNullable<HudState['drop']>

/**
 * Playable high-altitude drop-in HUD: altimeter + speed + a contextual hint, a
 * DEPLOY button (armed once you're low enough to pop the canopy), and on touch a
 * full-screen drag-to-steer layer behind the buttons (drag forward to nose-dive,
 * back to flatten and slow).
 */
function DropOverlay({ drop, touch, onDeploy, onTrick, onJet, onSteer }: { drop: DropState; touch: boolean; onDeploy: () => void; onTrick: () => void; onJet: (down: boolean) => void; onSteer: (x: number, y: number) => void }) {
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const onDown = (e: ReactPointerEvent) => {
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
  }
  const onMove = (e: ReactPointerEvent) => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.id) return
    // Normalize a small drag into a full steer vector; +y forward is up-drag.
    const x = clampN((e.clientX - d.x) / 90)
    const y = clampN((d.y - e.clientY) / 90)
    onSteer(x, y)
  }
  const onUp = () => { dragRef.current = null; onSteer(0, 0) }

  const phase = drop.phase === 'dive' ? 'NOSE-DIVE' : drop.phase === 'canopy' ? 'CANOPY' : drop.phase === 'crash' ? 'WRECKED' : 'TOUCHDOWN'
  const armed = drop.canDeploy
  return (
    <>
      {/* touch steer pad sits behind the buttons */}
      {touch && (
        <div
          style={{ position: 'absolute', inset: 0, zIndex: 12, touchAction: 'none' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      )}
      <div style={dropReadout}>
        <div style={{ fontSize: 30, fontWeight: 800, color: '#9dff5a', textShadow: '0 0 16px #9dff5a' }}>{drop.alt}m</div>
        <div style={{ fontSize: 13, letterSpacing: '0.2em', color: '#27e7ff', marginTop: 4 }}>{drop.speed} m/s · {phase}</div>
        {drop.place && <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.2em', color: '#ffd24a', textShadow: '0 0 12px #ffd24a', marginTop: 4 }}>PLACE {drop.place}</div>}
        {drop.hint && <div style={{ fontSize: 12, letterSpacing: '0.24em', color: 'rgba(223,238,255,0.75)', marginTop: 6 }}>{drop.hint}</div>}
      </div>

      {drop.result && (
        <div style={{ position: 'absolute', left: '50%', top: '40%', transform: 'translateX(-50%)' }}>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '0.12em', textAlign: 'center', color: drop.result.startsWith('CLEAN') ? '#9dff5a' : drop.result.startsWith('CANOPY') ? '#27e7ff' : '#ff8a1e', textShadow: '0 0 18px currentColor' }}>{drop.result}</div>
        </div>
      )}

      {/* One centered flex row so the action buttons can never overlap (they wrap
          on tiny screens instead). Gaps between them fall through to the steer pad. */}
      <div style={dropBtnBar}>
        {drop.canTrick && drop.phase === 'dive' && (
          <button style={{ ...dropActionBtn, color: '#ffd24a', borderColor: '#ff2bd0' }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onTrick() }}>FLIP</button>
        )}
        {touch && drop.phase === 'dive' && (
          <button
            style={{ ...dropActionBtn, color: '#27e7ff', borderColor: '#27e7ff', touchAction: 'none' }}
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onJet(true) }}
            onPointerUp={() => onJet(false)}
            onPointerCancel={() => onJet(false)}
            onPointerLeave={() => onJet(false)}
          >JET ▲</button>
        )}
        {drop.phase === 'dive' && (
          <button style={{ ...dropActionBtn, opacity: armed ? 1 : 0.5, borderColor: armed ? '#9dff5a' : 'rgba(39,231,255,0.5)', color: armed ? '#9dff5a' : 'rgba(223,238,255,0.92)' }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onDeploy() }}>CHUTE ◉</button>
        )}
        {drop.phase === 'canopy' && (
          <button style={{ ...dropActionBtn, borderColor: '#ff8a1e', color: '#ff8a1e' }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); onDeploy() }}>CUT CHUTE ✂</button>
        )}
      </div>
    </>
  )
}

function clampN(v: number) { return Math.max(-1, Math.min(1, v)) }

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
      <div style={coachCenter}>
        <div style={coachTitle}>HOW TO PLAY</div>
        <div style={coachHints}>
          <div style={coachHint}><span style={coachHintKey}>◄ ►</span> left thumb moves</div>
          <div style={coachHint}><span style={coachHintKey}>DRAG</span> right side looks</div>
          <div style={coachHint}><span style={coachHintKey}>TAP</span> buttons to act</div>
        </div>
        <div style={coachBody}>Follow the green objective to Portal Plaza, then reach the neon arcade to launch the mini-games.</div>
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
const dropReadout: CSSProperties = {
  position: 'absolute',
  top: 18,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 15,
  textAlign: 'center',
  pointerEvents: 'none',
  fontFamily: 'ui-monospace, Menlo, monospace',
}
// One centered bottom bar holding all drop actions. Flexbox lays them out with
// gaps and wraps on narrow screens, so the buttons can never overlap each other
// or anything else. The bar itself ignores pointers; the buttons capture them and
// the gaps fall through to the steer pad behind.
const dropBtnBar: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 'max(20px, env(safe-area-inset-bottom))',
  zIndex: 16,
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'center',
  alignItems: 'center',
  gap: 12,
  padding: '0 14px',
  pointerEvents: 'none',
}
const dropActionBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '13px 26px',
  font: '800 15px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
  whiteSpace: 'nowrap',
  background: 'rgba(8,12,24,0.72)',
  border: '2px solid',
  borderRadius: 999,
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
const welcomePanel: CSSProperties = {
  position: 'absolute',
  left: 16,
  top: '50%',
  transform: 'translateY(-50%)',
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 10,
  width: 244,
  padding: '20px 20px 22px',
  borderRadius: 14,
  background: 'rgba(8,12,24,0.82)',
  border: '1px solid rgba(39,231,255,0.4)',
  boxShadow: '0 0 30px rgba(39,231,255,0.16)',
  pointerEvents: 'auto', // the panel captures clicks; the rest of the screen plays
}
// Touch override: top-centre, clear of the left joystick zone and the right
// button cluster, with a safe-area top inset so it never tucks under a notch.
const welcomePanelTouch: CSSProperties = {
  left: '50%',
  top: 'max(12px, env(safe-area-inset-top))',
  transform: 'translateX(-50%)',
  width: 'min(86vw, 340px)',
}
const welcomeSub: CSSProperties = {
  fontSize: 11,
  letterSpacing: '0.18em',
  color: 'rgba(223,238,255,0.6)',
  margin: '2px 0 6px',
}
const welcomeInput: CSSProperties = {
  padding: '11px 14px',
  textAlign: 'center',
  font: '700 16px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: '#dff0ff',
  background: 'rgba(5,8,16,0.9)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 10,
  outline: 'none',
}
const welcomeBtnPrimary: CSSProperties = {
  padding: '12px 0',
  cursor: 'pointer',
  font: '800 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: '#04121a',
  background: 'linear-gradient(180deg,#5cf0ff,#27e7ff)',
  border: 'none',
  borderRadius: 10,
}
const welcomeBtnGhost: CSSProperties = {
  padding: '11px 0',
  cursor: 'pointer',
  font: '700 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: '#9fe8ff',
  background: 'rgba(39,231,255,0.08)',
  border: '1px solid rgba(39,231,255,0.4)',
  borderRadius: 10,
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
const warpWrap: CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 43,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(2,4,10,0.5)',
}
const warpCard: CSSProperties = {
  width: 'min(440px, 92vw)',
  padding: '20px 22px',
  textAlign: 'center',
  borderRadius: 16,
  background: 'rgba(6,10,22,0.95)',
  border: '1px solid rgba(39,231,255,0.5)',
  boxShadow: '0 0 34px rgba(39,231,255,0.25)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
}
const warpGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
}
const warpItem: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  textAlign: 'left',
  pointerEvents: 'auto',
  padding: '9px 11px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 10,
  font: 'inherit',
}
const warpRevertBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '9px 16px',
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(155,255,77,0.6)',
  borderRadius: 999,
  color: '#9bff4d',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
}
const warpCloseBtn: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '9px 16px',
  background: 'rgba(6,10,22,0.8)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.8)',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
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
const coachCenter: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  width: 'min(86vw, 360px)',
  padding: '22px 22px 20px',
  borderRadius: 16,
  background: 'rgba(8,12,24,0.9)',
  border: '1px solid rgba(39,231,255,0.4)',
  boxShadow: '0 0 34px rgba(39,231,255,0.18)',
  textAlign: 'center',
  pointerEvents: 'none',
}
const coachHints: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  margin: '14px 0 4px',
  width: '100%',
}
const coachHint: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: 'rgba(223,238,255,0.9)',
  font: '600 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.06em',
}
const coachHintKey: CSSProperties = {
  flex: '0 0 56px',
  textAlign: 'center',
  color: '#27e7ff',
  font: '800 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
  padding: '5px 0',
  borderRadius: 7,
  background: 'rgba(39,231,255,0.1)',
  border: '1px solid rgba(39,231,255,0.35)',
  textShadow: '0 0 8px rgba(39,231,255,0.6)',
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
