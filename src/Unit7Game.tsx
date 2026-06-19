import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Game } from './game/Game'
import { isTouchDevice } from './game/utils'
import type { GameControls, HudState, Unit7Config } from './game/types'
import { HUD } from './ui/HUD'
import { PauseMenu } from './ui/PauseMenu'
import { MobileControls } from './ui/MobileControls'
import { BeamWars } from './ui/BeamWars'

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
  // Touch UI shows on touch-capable devices; `?touch` forces it for testing on desktop.
  const touch = useMemo(
    () => isTouchDevice() || (typeof location !== 'undefined' && location.search.includes('touch')),
    [],
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const game = new Game(container, config ?? {}, setHud)
    gameRef.current = game
    controlsRef.current = game.controls
    game.start()

    return () => {
      game.dispose()
      gameRef.current = null
      controlsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={containerRef} className={className} style={{ ...rootStyle, ...style }}>
      <style>{KEYFRAMES}</style>
      {hud && !hud.intro && !hud.minigame && <HUD hud={hud} touch={touch} />}
      {touch && hud && !hud.intro && !hud.minigame && !hud.paused && controlsRef.current && (
        <MobileControls controls={controlsRef.current} hud={hud} />
      )}
      {hud?.intro && <IntroOverlay onSkip={() => controlsRef.current?.skipIntro()} />}
      {hud?.paused && !hud.minigame && <PauseMenu onResume={() => controlsRef.current?.resume()} touch={touch} />}
      {hud?.minigame === 'beamwars' && controlsRef.current && (
        <BeamWars touch={touch} onExit={() => controlsRef.current?.exitMinigame()} />
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
