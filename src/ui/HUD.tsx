import { useState, type CSSProperties } from 'react'
import type { BlipKind, HudState, PlayerProfile } from '../game/types'

// Friendly labels for the per-game W/L lines on a profile card.
const GAME_LABELS: Record<string, string> = {
  beamwars: 'BEAM WARS',
  digduel: 'DIG DUEL',
  merge2048: '2048',
  invaders: 'INVADERS',
  snake: 'SNAKE',
  raceloop: 'RACE LOOP',
  mecharena: 'MECH ARENA',
  drivemad: 'DRIVE FRENZY',
}

const NEON = {
  cyan: '#27e7ff',
  magenta: '#ff2bd0',
  purple: '#8a5cff',
  orange: '#ff8a1e',
  lime: '#9bff4d',
  text: 'rgba(223,238,255,0.92)',
  dim: 'rgba(223,238,255,0.55)',
}

const BLIP_COLOR: Record<BlipKind, string> = {
  building: 'rgba(150,170,200,0.5)',
  npc: NEON.lime,
  vehicle: NEON.orange,
  portal: NEON.purple,
  powerup: NEON.cyan,
  alien: NEON.magenta,
  ship: '#ffffff',
  objective: NEON.lime,
}

export function HUD({
  hud,
  touch,
  onRestart,
  onToggleMute,
  onChallenge,
  onBuy,
  onEquip,
}: {
  hud: HudState
  touch: boolean
  onRestart: () => void
  onToggleMute: () => void
  onChallenge?: (id: string) => void
  onBuy?: (id: string) => void
  onEquip?: (slot: 'trail' | 'accent', id: string) => void
}) {
  const [rosterOpen, setRosterOpen] = useState(false)
  const [storeOpen, setStoreOpen] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const profiles = hud.profiles ?? []
  const viewed = viewing === '__self__' ? profiles.find((p) => p.self) : viewing ? profiles.find((p) => p.id === viewing) : null
  return (
    <div style={wrap}>
      {/* top-left restart (replays the opening cinematic) */}
      <button style={restartBtn} onClick={onRestart}>RESTART ↺</button>
      <button style={muteBtn} onClick={onToggleMute}>{hud.muted ? 'SOUND OFF' : 'SOUND ON'}</button>

      {/* top-left meters */}
      <div style={{ ...panel, top: 52, left: 14 }}>
        <Logo />
        <PilotProgress p={hud.progress} />
        <Bar label="STAMINA" value={hud.stamina} color={NEON.lime} />
        <Bar label="FUEL" value={hud.fuel} color={NEON.cyan} />
        {hud.powerup && (
          <div style={{ ...chip, color: NEON.cyan, borderColor: NEON.cyan }}>
            {hud.powerup.kind.toUpperCase()} {Math.ceil(hud.powerup.remaining)}s
          </div>
        )}
        {hud.shield && <div style={{ ...chip, color: NEON.purple, borderColor: NEON.purple }}>SHIELD</div>}
      </div>

      {/* top-right stats + radar */}
      <div style={{ ...panel, top: 14, right: 14, alignItems: 'flex-end' }}>
        <Radar hud={hud} />
        <div style={statRow}>
          <Stat label="ZONE" value={hud.zone.toUpperCase()} color={NEON.magenta} />
          <Stat label="SCORE" value={String(hud.score)} color={NEON.cyan} />
          <Stat label="CREDITS" value={String(hud.credits)} color={NEON.orange} />
          <Stat label="CAUGHT" value={String(hud.captured)} color={NEON.lime} />
        </div>
        <div style={statRow}>
          <Stat label="BEST" value={String(hud.best)} color={NEON.purple} />
          <Stat label="SPEED" value={`${hud.speed.toFixed(0)} m/s`} color={NEON.text} />
          {hud.altitude > 1 && <Stat label="ALT" value={`${hud.altitude.toFixed(0)} m`} color={NEON.text} />}
          <Stat label="FPS" value={String(hud.fps)} color={hud.fps >= 50 ? NEON.lime : hud.fps >= 30 ? NEON.orange : NEON.magenta} />
        </div>
      </div>

      {/* current objective (top-center, persistent + readable) */}
      {hud.objective && !hud.minigame && (
        <div style={objectiveStyle}>
          <span style={{ color: NEON.dim, marginRight: 8 }}>OBJECTIVE</span>
          <span style={{ color: NEON.lime }}>{hud.objective}</span>
        </div>
      )}

      {/* contextual prompt */}
      {hud.prompt && (
        <div style={promptStyle}>
          <span style={{ color: NEON.cyan }}>{hud.prompt}</span>
        </div>
      )}

      {/* zone-transition / launch fade + banner */}
      {hud.fade > 0.001 && (
        <div style={{ position: 'absolute', inset: 0, background: '#000', opacity: hud.fade, transition: 'opacity 0.08s linear' }} />
      )}
      {hud.banner && (
        <div style={bannerStyle}>{hud.banner}</div>
      )}

      {/* intro / mission card */}
      {hud.missionPopup && !hud.minigame && (
        <div style={missionCard}>
          <div style={missionTitle}>{hud.missionPopup.title}</div>
          <div style={missionBody}>{hud.missionPopup.body}</div>
        </div>
      )}

      {/* click-to-look hint (desktop, pointer not yet captured) */}
      {!touch && !hud.lookLocked && !hud.paused && !hud.intro && (
        <div style={clickHint}>CLICK TO CAPTURE MOUSE · OR DRAG TO LOOK</div>
      )}

      {/* control hints (desktop) */}
      {!touch && (
        <div style={hints}>
          WASD move · SHIFT sprint · SPACE/J jetpack · H capture/fire · G enter · F boost · T transform · O chute · ESC pause
        </div>
      )}

      {/* pilots roster: open profiles + stats for yourself and everyone online */}
      {!hud.minigame && !hud.intro && (
        <button style={pilotsBtn} onClick={() => { setRosterOpen((v) => !v); setStoreOpen(false) }}>
          PILOTS{hud.online > 1 ? ` · ${hud.online}` : ''}
        </button>
      )}
      {!hud.minigame && !hud.intro && (
        <button style={storeBtn} onClick={() => { setStoreOpen((v) => !v); setRosterOpen(false) }}>
          STORE
        </button>
      )}
      {storeOpen && !hud.minigame && (
        <CosmeticsStore p={hud.progress} onBuy={onBuy} onEquip={onEquip} onClose={() => setStoreOpen(false)} />
      )}
      {rosterOpen && !hud.minigame && (
        <div style={rosterPanel}>
          <div style={rosterHead}>
            <span>PILOTS ONLINE · {hud.online}</span>
            <button style={closeX} onClick={() => setRosterOpen(false)}>✕</button>
          </div>
          {profiles.map((p) => {
            const bw = p.games.find((g) => g.game === 'beamwars')
            return (
              <button key={p.self ? '__self__' : p.id} style={rosterRow} onClick={() => setViewing(p.self ? '__self__' : p.id)}>
                <span style={{ color: p.self ? NEON.cyan : NEON.text, fontWeight: 800 }}>
                  {p.name}{p.self ? ' (you)' : ''}
                </span>
                <span style={{ color: NEON.dim }}>
                  BW {bw ? `${bw.won}-${bw.lost}` : '0-0'} · {p.aliens} caught
                </span>
              </button>
            )
          })}
          {hud.online <= 1 && <div style={rosterHint}>Solo right now. Others appear here when they join the shared world.</div>}
        </div>
      )}
      {viewed && (
        <div style={profileOverlay} onClick={() => setViewing(null)}>
          <ProfileCard
            profile={viewed}
            onClose={() => setViewing(null)}
            onChallenge={
              !viewed.self && viewed.id && onChallenge
                ? () => {
                    onChallenge(viewed.id)
                    setViewing(null)
                    setRosterOpen(false)
                  }
                : undefined
            }
          />
        </div>
      )}
    </div>
  )
}

function ProfileCard({ profile, onClose, onChallenge }: { profile: PlayerProfile; onClose: () => void; onChallenge?: () => void }) {
  const games = [...profile.games].filter((g) => g.played > 0).sort((a, b) => b.played - a.played)
  const totalWon = games.reduce((s, g) => s + g.won, 0)
  const totalLost = games.reduce((s, g) => s + g.lost, 0)
  const rate = totalWon + totalLost > 0 ? Math.round((totalWon / (totalWon + totalLost)) * 100) : 0
  return (
    <div style={profileCard} onClick={(e) => e.stopPropagation()}>
      <div style={profileHead}>
        <span style={{ color: NEON.cyan, font: '800 18px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.12em' }}>
          {profile.name}{profile.self ? ' (you)' : ''}
        </span>
        <button style={closeX} onClick={onClose}>✕</button>
      </div>
      <div style={statRow}>
        <Stat label="PILOT LV" value={String(profile.level)} color={NEON.cyan} />
        <Stat label="DUEL RANK" value={profile.duelTier.replace('CLASS ', '')} color={profile.duelTierColor} />
        <Stat label="CAUGHT" value={String(profile.aliens)} color={NEON.magenta} />
      </div>
      <div style={statRow}>
        <Stat label="W / L" value={`${totalWon} / ${totalLost}`} color={NEON.lime} />
        <Stat label="WIN RATE" value={`${rate}%`} color={NEON.orange} />
      </div>
      <div style={{ ...microLabel, color: NEON.dim, marginTop: 12, marginBottom: 4 }}>BY GAME</div>
      {games.length === 0 && <div style={rosterHint}>No games played yet.</div>}
      {games.map((g) => (
        <div key={g.game} style={profileGameRow}>
          <span style={{ color: NEON.text, fontWeight: 700 }}>{GAME_LABELS[g.game] ?? g.game.toUpperCase()}</span>
          <span style={{ color: NEON.dim }}>
            {g.won}W · {g.lost}L{g.best > 0 ? ` · best ${g.best}` : ''}
          </span>
        </div>
      ))}
      {onChallenge && (
        <button style={challengeBtn} onClick={onChallenge}>
          ⚔ CHALLENGE TO BEAM WARS
        </button>
      )}
    </div>
  )
}

const DAILY_LABEL: Record<string, (t: number) => string> = {
  capture: (t) => `Capture ${t} aliens`,
  play: (t) => `Play ${t} arcade games`,
  duelWins: (t) => `Win ${t} duels`,
}

function PilotProgress({ p }: { p: HudState['progress'] }) {
  const frac = p.xpSpan > 0 ? Math.max(0, Math.min(1, p.xpInto / p.xpSpan)) : 0
  const d = p.daily
  const dailyText = (DAILY_LABEL[d.kind] ?? ((t: number) => `Goal ${t}`))(d.target)
  return (
    <div style={{ width: 160, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
        <span style={{ ...microLabel, color: NEON.cyan }}>PILOT LV {p.level}</span>
        {p.streak > 0 && <span style={{ ...microLabel, color: NEON.orange }}>🔥 {p.streak}d</span>}
      </div>
      <div style={barTrack}>
        <div style={{ width: `${frac * 100}%`, height: '100%', background: NEON.cyan, boxShadow: `0 0 8px ${NEON.cyan}` }} />
      </div>
      <div style={{ ...microLabel, color: NEON.dim, marginTop: 5, display: 'flex', justifyContent: 'space-between' }}>
        <span>DAILY</span>
        <span style={{ color: d.claimed ? NEON.lime : NEON.text }}>{Math.min(d.progress, d.target)}/{d.target}{d.claimed ? ' ✓' : ''}</span>
      </div>
      <div style={{ font: '600 9px/1.3 ui-monospace, Menlo, monospace', color: d.claimed ? NEON.lime : 'rgba(223,238,255,0.7)', letterSpacing: '0.04em' }}>
        {d.claimed ? 'Daily complete!' : dailyText}
      </div>
    </div>
  )
}

const COSMETIC_SWATCHES: { id: string; name: string; css: string; cost: number }[] = [
  { id: 'cyan', name: 'Cyan', css: '#27e7ff', cost: 0 },
  { id: 'lime', name: 'Lime', css: '#9bff4d', cost: 300 },
  { id: 'magenta', name: 'Magenta', css: '#ff2bd0', cost: 300 },
  { id: 'orange', name: 'Ember', css: '#ff8a1e', cost: 500 },
  { id: 'purple', name: 'Violet', css: '#8a5cff', cost: 500 },
  { id: 'gold', name: 'Gold', css: '#ffd24a', cost: 900 },
  { id: 'white', name: 'Pure', css: '#ffffff', cost: 1200 },
  { id: 'red', name: 'Crimson', css: '#ff5c5c', cost: 1500 },
]

function CosmeticsStore({
  p,
  onBuy,
  onEquip,
  onClose,
}: {
  p: HudState['progress']
  onBuy?: (id: string) => void
  onEquip?: (slot: 'trail' | 'accent', id: string) => void
  onClose: () => void
}) {
  return (
    <div style={rosterPanel}>
      <div style={rosterHead}>
        <span>COLORS · {p.credits}c</span>
        <button style={closeX} onClick={onClose}>✕</button>
      </div>
      <div style={rosterHint}>Your trail color shows in duels; your accent recolors your robot.</div>
      <div style={swatchGrid}>
        {COSMETIC_SWATCHES.map((c) => {
          const owned = p.cosmetics.owned.includes(c.id)
          const equipped = p.cosmetics.trail === c.id || p.cosmetics.accent === c.id
          return (
            <button
              key={c.id}
              style={{ ...swatch, borderColor: equipped ? c.css : 'rgba(255,255,255,0.14)', boxShadow: equipped ? `0 0 12px ${c.css}` : 'none' }}
              onClick={() => (owned ? onEquip?.('trail', c.id) : onBuy?.(c.id))}
              onContextMenu={(e) => { e.preventDefault(); if (owned) onEquip?.('accent', c.id) }}
            >
              <span style={{ width: 22, height: 22, borderRadius: 6, background: c.css, boxShadow: `0 0 8px ${c.css}` }} />
              <span style={{ color: NEON.text, fontWeight: 700, fontSize: 10 }}>{c.name}</span>
              <span style={{ color: owned ? (equipped ? NEON.lime : NEON.dim) : NEON.orange, fontSize: 9 }}>
                {owned ? (equipped ? 'EQUIPPED' : 'tap: trail') : `${c.cost}c`}
              </span>
            </button>
          )
        })}
      </div>
      <div style={rosterHint}>Tap to buy / equip as trail. Right-click (or long-press) an owned color to set it as your robot accent.</div>
    </div>
  )
}

function Logo() {
  return (
    <div style={{ font: '800 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.22em', marginBottom: 8 }}>
      <span style={{ color: NEON.cyan, textShadow: `0 0 12px ${NEON.cyan}` }}>UNIT</span>
      <span style={{ color: NEON.magenta, textShadow: `0 0 12px ${NEON.magenta}` }}> 7</span>
    </div>
  )
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  const v = Math.max(0, Math.min(1, value))
  return (
    <div style={{ marginBottom: 6, width: 160 }}>
      <div style={{ ...microLabel, color: NEON.dim }}>{label}</div>
      <div style={barTrack}>
        <div
          style={{
            width: `${v * 100}%`,
            height: '100%',
            background: color,
            boxShadow: `0 0 10px ${color}`,
            borderRadius: 3,
            transition: 'width 0.12s linear',
          }}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'right', minWidth: 54 }}>
      <div style={{ ...microLabel, color: NEON.dim }}>{label}</div>
      <div style={{ font: '700 14px/1.1 ui-monospace, Menlo, monospace', color }}>{value}</div>
    </div>
  )
}

function Radar({ hud }: { hud: HudState }) {
  const R = 52
  const size = R * 2
  return (
    <svg width={size} height={size} style={{ marginBottom: 8, filter: 'drop-shadow(0 0 6px rgba(39,231,255,0.4))' }}>
      <circle cx={R} cy={R} r={R - 1} fill="rgba(6,10,22,0.6)" stroke="rgba(39,231,255,0.35)" strokeWidth={1} />
      <circle cx={R} cy={R} r={(R - 1) * 0.6} fill="none" stroke="rgba(39,231,255,0.15)" strokeWidth={1} />
      <line x1={R} y1={6} x2={R} y2={size - 6} stroke="rgba(39,231,255,0.12)" strokeWidth={1} />
      <line x1={6} y1={R} x2={size - 6} y2={R} stroke="rgba(39,231,255,0.12)" strokeWidth={1} />
      {hud.radar.map((b, i) => {
        const x = R + b.x * (R - 4)
        const y = R - b.y * (R - 4)
        const r = b.kind === 'objective' ? 4 : b.kind === 'building' ? 1.6 : 2.6
        return <circle key={i} cx={x} cy={y} r={r} fill={BLIP_COLOR[b.kind]} />
      })}
      {/* player + forward indicator */}
      <polygon points={`${R},${R - 6} ${R - 4},${R + 4} ${R + 4},${R + 4}`} fill={NEON.cyan} />
    </svg>
  )
}

const wrap: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  zIndex: 5,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: NEON.text,
}
const panel: CSSProperties = {
  position: 'absolute',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '8px 12px',
  background: 'rgba(5,10,25,0.62)',
  border: '1px solid rgba(90,255,255,0.28)',
  borderRadius: 12,
  boxShadow: '0 0 16px rgba(0,255,255,0.12)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  textShadow: '0 0 6px rgba(0,0,0,0.85)',
}
const microLabel: CSSProperties = { font: '600 9px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em' }
const barTrack: CSSProperties = {
  width: '100%',
  height: 7,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4,
  overflow: 'hidden',
}
const statRow: CSSProperties = { display: 'flex', gap: 14, marginTop: 4 }
const restartBtn: CSSProperties = {
  position: 'absolute',
  top: 14,
  left: 14,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '6px 12px',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
  boxShadow: '0 0 14px rgba(39,231,255,0.25)',
}
const muteBtn: CSSProperties = {
  position: 'absolute',
  top: 14,
  left: 110,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '6px 12px',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(138,92,255,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
  boxShadow: '0 0 14px rgba(138,92,255,0.2)',
}
const chip: CSSProperties = {
  marginTop: 4,
  alignSelf: 'flex-start',
  padding: '2px 8px',
  border: '1px solid',
  borderRadius: 10,
  font: '700 10px/1.4 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
}
const promptStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: '22%',
  transform: 'translateX(-50%)',
  padding: '8px 18px',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 999,
  font: '700 14px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
  boxShadow: '0 0 20px rgba(39,231,255,0.25)',
}
const objectiveStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 16,
  transform: 'translateX(-50%)',
  padding: '6px 16px',
  maxWidth: '70vw',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(155,255,77,0.45)',
  borderRadius: 999,
  font: '700 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.1em',
  boxShadow: '0 0 16px rgba(155,255,77,0.2)',
}
const bannerStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '38%',
  transform: 'translate(-50%,-50%)',
  font: '800 30px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.3em',
  color: '#fff',
  textShadow: '0 0 24px rgba(39,231,255,0.7)',
  pointerEvents: 'none',
  zIndex: 30,
}
const missionCard: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '24%',
  transform: 'translateX(-50%)',
  maxWidth: '82vw',
  padding: '14px 22px',
  textAlign: 'center',
  background: 'rgba(5,10,25,0.78)',
  border: '1px solid rgba(90,255,255,0.5)',
  borderRadius: 14,
  boxShadow: '0 0 26px rgba(0,255,255,0.25)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  zIndex: 22,
  pointerEvents: 'none',
}
const missionTitle: CSSProperties = {
  font: '800 20px/1.1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.18em',
  color: '#27e7ff',
  textShadow: '0 0 14px rgba(39,231,255,0.7)',
  marginBottom: 6,
}
const missionBody: CSSProperties = {
  font: '600 12px/1.4 ui-monospace, Menlo, monospace',
  color: 'rgba(223,238,255,0.92)',
  letterSpacing: '0.04em',
}
const clickHint: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  font: '600 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: 'rgba(223,238,255,0.7)',
  textShadow: '0 0 10px rgba(0,0,0,0.9)',
  animation: 'unit7pulse 2s ease-in-out infinite',
}
const hints: CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 12,
  transform: 'translateX(-50%)',
  font: '600 10px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.08em',
  color: 'rgba(223,238,255,0.45)',
  whiteSpace: 'nowrap',
  maxWidth: '96vw',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const pilotsBtn: CSSProperties = {
  position: 'absolute',
  right: 14,
  bottom: 14,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '7px 14px',
  background: 'rgba(6,10,22,0.72)',
  border: '1px solid rgba(155,255,77,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  boxShadow: '0 0 14px rgba(155,255,77,0.22)',
  zIndex: 24,
}
const storeBtn: CSSProperties = {
  position: 'absolute',
  right: 110,
  bottom: 14,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '7px 14px',
  background: 'rgba(6,10,22,0.72)',
  border: '1px solid rgba(255,138,30,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  boxShadow: '0 0 14px rgba(255,138,30,0.22)',
  zIndex: 24,
}
const swatchGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 6,
  margin: '6px 0',
}
const swatch: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  pointerEvents: 'auto',
  cursor: 'pointer',
  textAlign: 'left',
  padding: '8px 10px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 8,
  font: '600 10px/1.2 ui-monospace, Menlo, monospace',
}
const rosterPanel: CSSProperties = {
  position: 'absolute',
  right: 14,
  bottom: 54,
  width: 280,
  maxHeight: '52vh',
  overflowY: 'auto',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 12,
  background: 'rgba(5,10,25,0.88)',
  border: '1px solid rgba(90,255,255,0.4)',
  borderRadius: 12,
  boxShadow: '0 0 26px rgba(0,255,255,0.18)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  zIndex: 25,
}
const rosterHead: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  font: '800 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  color: NEON.cyan,
  marginBottom: 6,
}
const rosterRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  pointerEvents: 'auto',
  cursor: 'pointer',
  textAlign: 'left',
  padding: '7px 9px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  font: '600 11px/1.2 ui-monospace, Menlo, monospace',
  letterSpacing: '0.04em',
}
const rosterHint: CSSProperties = {
  font: '600 10px/1.4 ui-monospace, Menlo, monospace',
  color: 'rgba(223,238,255,0.5)',
  letterSpacing: '0.04em',
  padding: '4px 2px',
}
const closeX: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  color: 'rgba(223,238,255,0.7)',
  font: '800 14px/1 ui-monospace, Menlo, monospace',
}
const profileOverlay: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(2,4,10,0.55)',
  zIndex: 40,
}
const profileCard: CSSProperties = {
  width: 'min(360px, 88vw)',
  padding: '18px 20px',
  background: 'rgba(5,10,25,0.94)',
  border: '1px solid rgba(90,255,255,0.5)',
  borderRadius: 16,
  boxShadow: '0 0 32px rgba(0,255,255,0.28)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
}
const profileHead: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 14,
}
const profileGameRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '5px 0',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  font: '600 11px/1.2 ui-monospace, Menlo, monospace',
  letterSpacing: '0.04em',
}
const challengeBtn: CSSProperties = {
  marginTop: 16,
  width: '100%',
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '11px 0',
  background: 'linear-gradient(180deg,#ff5cc6,#ff2bd0)',
  border: 'none',
  borderRadius: 10,
  color: '#100410',
  font: '800 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.14em',
  boxShadow: '0 0 18px rgba(255,43,208,0.35)',
}
