import { memo, useState, type CSSProperties } from 'react'
import type { BlipKind, HudState, PlayerProfile } from '../game/types'
import { ACHIEVEMENTS } from '../game/progression'

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
  dim: 'rgba(223,238,255,0.72)',
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
  onPause,
  onChallenge,
  onBuy,
  onEquip,
  onWarp,
  onArcade,
  onSave,
  onChat,
  hideTopCenter,
  hideCorners,
  botMode = false,
}: {
  hud: HudState
  touch: boolean
  onRestart: () => void
  onToggleMute: () => void
  onPause: () => void
  onChallenge?: (id: string) => void
  onBuy?: (id: string) => void
  onEquip?: (slot: 'trail' | 'accent', id: string) => void
  onWarp?: () => void
  onArcade?: () => void
  // Open the kid-safe Save / Restore panel (always available).
  onSave?: () => void
  // Toggle the typed-chat dock. The CHAT button only shows when chat is enabled.
  onChat?: () => void
  // While the one-time join/solo gate is up it occupies the top-centre on touch;
  // suppress the top-centre HUD elements so they don't collide behind it.
  hideTopCenter?: boolean
  // The touch welcome panel also covers the top-left corner controls; hide them
  // until the player has chosen solo / multiplayer.
  hideCorners?: boolean
  // Browser-automation ("bot") sessions drive the engine via synthetic input, so
  // the pointer-capture prompt and the WASD control legend are misleading there;
  // suppress both. Real desktop players are unaffected (defaults to false).
  botMode?: boolean
}) {
  const [rosterOpen, setRosterOpen] = useState(false)
  const [storeOpen, setStoreOpen] = useState(false)
  // Meters + stat readouts are clutter on a phone, so collapse them behind a
  // STATS toggle there (open by default on desktop, where there's room). The map
  // always stays visible.
  const [statsOpen, setStatsOpen] = useState(!touch)
  const [viewing, setViewing] = useState<string | null>(null)
  const [rosterSort, setRosterSort] = useState<'rank' | 'caught'>('rank')
  const profiles = hud.profiles ?? []
  const viewed = viewing === '__self__' ? profiles.find((p) => p.self) : viewing ? profiles.find((p) => p.id === viewing) : null
  return (
    <div style={wrap}>
      {/* top-left controls (restart replays the cinematic; pause is touch-only since desktop has Esc) */}
      {!hideCorners && <div style={touch ? { ...topLeftRow, maxWidth: '92vw' } : topLeftRow}>
        <button style={pillBtn} onClick={onRestart}>RESTART ↺</button>
        {/* Sound toggle is redundant on touch (it lives in the pause menu); keeping it
            in the corner pushed the row to two lines and collided with the meters. */}
        {!touch && <button style={{ ...pillBtn, borderColor: 'rgba(138,92,255,0.5)', boxShadow: '0 0 14px rgba(138,92,255,0.2)' }} onClick={onToggleMute}>{hud.muted ? 'SOUND OFF' : 'SOUND ON'}</button>}
        {/* Quick-warp to the arcade entrance. Desktop only - mobile has it down in
            the touch button cluster (and the top bar gets covered by panels there). */}
        {onArcade && !touch && !hud.minigame && !hud.intro && !hud.onPlatform && hud.zone === 'earth' && (
          <button
            style={{ ...pillBtn, borderColor: 'rgba(255,43,208,0.7)', color: NEON.magenta, boxShadow: '0 0 16px rgba(255,43,208,0.35)', fontWeight: 800 }}
            onClick={onArcade}
          >
            🕹 GAMES{touch ? '' : ' · J'}
          </button>
        )}
        {touch && !hud.paused && (
          <button style={{ ...pillBtn, borderColor: 'rgba(255,43,208,0.5)', boxShadow: '0 0 14px rgba(255,43,208,0.2)' }} onClick={onPause}>PAUSE ❚❚</button>
        )}
        {!hud.minigame && !hud.onPlatform && (
          <button
            style={{ ...pillBtn, borderColor: statsOpen ? 'rgba(155,255,77,0.6)' : 'rgba(39,231,255,0.5)', color: statsOpen ? NEON.lime : 'rgba(223,238,255,0.92)' }}
            onClick={() => setStatsOpen((s) => !s)}
          >
            {statsOpen ? 'STATS ✕' : 'STATS'}
          </button>
        )}
      </div>}

      {/* top-left meters: always-on action/alert chips; full meters behind STATS.
          Hidden during the launch-pad opening to keep it clean. On touch the warp
          chip is gone, so skip the panel entirely when it'd be empty (otherwise an
          empty blurred box hangs under the buttons). */}
      {!hud.onPlatform && (statsOpen || !!hud.powerup || hud.shield || hud.heat.wanted || !touch) && <div style={{ ...panel, ...metersPos }}>
        {hud.powerup && (
          <div style={{ ...chip, color: NEON.cyan, borderColor: NEON.cyan }}>
            {hud.powerup.kind.toUpperCase()} {Math.ceil(hud.powerup.remaining)}s
          </div>
        )}
        {hud.shield && <div style={{ ...chip, color: NEON.purple, borderColor: NEON.purple }}>SHIELD</div>}
        <WantedChip stars={hud.heat.stars} max={hud.heat.max} wanted={hud.heat.wanted} />
        {/* On touch, warp already has its own button + "WARP READY" helper in the
            bottom action cluster, so the top chip is redundant (and used to overlap
            the STATS button). Keep it on desktop where it's the only warp affordance. */}
        {!touch && <WarpChip w={hud.warp} touch={touch} onTap={onWarp} />}
        {statsOpen && (
          <>
            <Logo />
            <PilotProgress p={hud.progress} compact={touch} />
            <Bar label="STAMINA" value={hud.stamina} color={NEON.lime} />
            <Bar label="FUEL" value={hud.fuel} color={NEON.cyan} />
          </>
        )}
      </div>}

      {/* top-right: map + stat readouts. Hidden during the launch-pad opening. */}
      {!hud.onPlatform && <div style={{ ...panel, ...statsPos, alignItems: 'flex-end' }}>
        <Radar hud={hud} />
        {statsOpen && (
          <>
            <div style={statRow}>
              <Stat label="ZONE" value={hud.zone.toUpperCase()} color={NEON.magenta} />
              <Stat label="SCORE" value={String(hud.score)} color={NEON.cyan} />
              <Stat label="CREDITS" value={String(hud.credits)} color={NEON.orange} />
              <Stat label="CAUGHT" value={String(hud.captured)} color={NEON.lime} />
              {hud.shards.total > 0 && <Stat label="SHARDS" value={`${hud.shards.found}/${hud.shards.total}`} color={NEON.purple} />}
            </div>
            <div style={statRow}>
              <Stat label="BEST" value={String(hud.best)} color={NEON.purple} />
              <Stat label="SPEED" value={`${hud.speed.toFixed(0)} m/s`} color={NEON.text} />
              {hud.altitude > 1 && <Stat label="ALT" value={`${hud.altitude.toFixed(0)} m`} color={NEON.text} />}
              <Stat label="FPS" value={String(hud.fps)} color={hud.fps >= 50 ? NEON.lime : hud.fps >= 30 ? NEON.orange : NEON.magenta} />
            </div>
          </>
        )}
      </div>}

      {/* street-race status (top-center, above the objective) */}
      {hud.race && hud.race.state !== 'idle' && !hud.minigame && (
        <div style={raceStyle}>
          {hud.race.state === 'countdown' ? (
            <span style={{ color: NEON.lime }}>RACE STARTS {Math.ceil(hud.race.countdown)}</span>
          ) : hud.race.state === 'done' ? (
            <span style={{ color: NEON.orange }}>FINISH · {hud.race.result.toFixed(1)}s</span>
          ) : (
            <>
              <span style={{ color: NEON.dim, marginRight: 8 }}>RACE</span>
              <span style={{ color: NEON.lime }}>CP {hud.race.cp}/{hud.race.total}</span>
              <span style={{ color: NEON.cyan, marginLeft: 10 }}>{hud.race.time.toFixed(1)}s</span>
              {hud.race.best > 0 && <span style={{ color: NEON.dim, marginLeft: 10 }}>best {hud.race.best}s</span>}
            </>
          )}
        </div>
      )}
      {hud.race && hud.race.near && !hud.minigame && (
        <div style={{ ...promptStyle, bottom: '28%', borderColor: 'rgba(155,255,77,0.6)' }}>
          <span style={{ color: NEON.lime }}>DRIVE THROUGH THE GATE TO RACE</span>
        </div>
      )}

      {/* perf overlay (?debug only): live draw calls + GPU memory. Watch geos/texs
          climb across zone + minigame switches to spot leaks. */}
      {hud.perf && (
        <div style={perfStyle}>
          <span style={{ color: hud.fps >= 50 ? NEON.lime : hud.fps >= 30 ? NEON.orange : NEON.magenta }}>{hud.fps} fps</span>
          <span style={{ color: NEON.text }}>{hud.perf.draws} draws</span>
          <span style={{ color: NEON.dim }}>{(hud.perf.tris / 1000).toFixed(0)}k tris</span>
          <span style={{ color: NEON.text }}>geo {hud.perf.geos}</span>
          <span style={{ color: NEON.text }}>tex {hud.perf.texs}</span>
        </div>
      )}

      {/* capture chain (top-center, under the objective): rapid captures build a
          multiplier; the bar drains over the 2.5s window. */}
      {hud.captureChain && !hud.minigame && (
        <div style={chainStyle}>
          <span style={{ color: NEON.orange, fontWeight: 800, fontSize: 18 }}>CHAIN ×{hud.captureChain.mult.toFixed(1)}</span>
          <div style={{ width: 92, height: 4, marginTop: 4, borderRadius: 2, background: 'rgba(255,255,255,0.15)' }}>
            <div style={{ width: `${Math.round(hud.captureChain.remaining01 * 100)}%`, height: '100%', borderRadius: 2, background: NEON.orange }} />
          </div>
        </div>
      )}

      {/* style combo meter (right-center): climbs while you keep expressive
          traversal going, then banks. Colour ramps with the multiplier. */}
      {hud.combo.active && !hud.minigame && (
        <div style={comboStyle}>
          <span style={{ color: NEON.dim, fontSize: 11, letterSpacing: 2 }}>STYLE</span>
          <span
            style={{
              fontSize: 30,
              fontWeight: 800,
              lineHeight: 1,
              color: hud.combo.mult >= 4 ? NEON.magenta : hud.combo.mult >= 2.5 ? NEON.orange : NEON.cyan,
              textShadow: '0 0 12px currentColor',
            }}
          >
            ×{hud.combo.mult.toFixed(1)}
          </span>
          <span style={{ color: NEON.text, fontSize: 13 }}>{hud.combo.points}</span>
        </div>
      )}

      {/* current objective (top-center, persistent + readable). On touch the corner
          control row wraps to TWO rows on narrow phones (RESTART/SOUND, then PAUSE),
          so drop the objective below both so it never collides with the PAUSE button. */}
      {hud.objective && !hud.minigame && !hideTopCenter && (
        <div style={{ ...objectiveStyle, top: touch ? 'calc(env(safe-area-inset-top) + 84px)' : objectiveStyle.top }}>
          <span style={{ color: NEON.dim, marginRight: 8 }}>OBJECTIVE</span>
          <span style={{ color: NEON.lime }}>{hud.objective}</span>
        </div>
      )}

      {/* city-raid wave tracker (post-skydive assault) */}
      {hud.raid && !hud.minigame && !hideTopCenter && (
        <div style={{ ...raidStyle, top: touch ? 'calc(env(safe-area-inset-top) + 120px)' : '54px' }}>
          <span style={{ color: '#ff5a6a' }}>⚠ CITY RAID</span>
          {hud.raid.boss ? (
            <span style={{ margin: '0 10px', color: '#ffd24a', fontWeight: 700 }}>MOTHERSHIP</span>
          ) : (
            <span style={{ margin: '0 10px', color: NEON.dim }}>WAVE {Math.max(1, hud.raid.wave)}/{hud.raid.waves}</span>
          )}
          <span style={{ color: hud.raid.boss ? '#ffd24a' : hud.raid.incoming ? NEON.orange : '#ff9aa6' }}>
            {hud.raid.boss ? 'HIT THE CORE' : hud.raid.incoming ? 'NEXT WAVE INCOMING' : `${hud.raid.alive} HOSTILE${hud.raid.alive === 1 ? '' : 'S'} LEFT`}
          </span>
          {hud.raid.boss && (
            <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: NEON.dim, fontSize: 10 }}>CORE</span>
              <div style={{ width: 120, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.round((hud.raid.boss.hp / hud.raid.boss.hpMax) * 100)}%`, height: '100%', background: '#ffd24a', boxShadow: '0 0 8px #ff8a3c', transition: 'width 0.15s linear' }} />
              </div>
            </div>
          )}
          <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: NEON.dim, fontSize: 10 }}>SHIELD</span>
            <div style={{ width: 120, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(hud.raid.shield * 100)}%`, height: '100%', background: hud.raid.shield > 0.5 ? NEON.cyan : hud.raid.shield > 0.25 ? NEON.orange : '#ff5a6a', boxShadow: `0 0 8px ${hud.raid.shield > 0.5 ? NEON.cyan : '#ff5a6a'}`, transition: 'width 0.1s linear' }} />
            </div>
          </div>
        </div>
      )}

      {/* contextual prompt - on touch it anchors to the lower-left so it clears the
          action-button cluster (bottom-right) instead of colliding with it. */}
      {hud.prompt && (
        <div style={touch ? { ...promptStyle, left: 'max(12px, env(safe-area-inset-left))', transform: 'none', textAlign: 'left', maxWidth: '50vw', bottom: '26%' } : promptStyle}>
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
      {hud.missionPopup && !hud.minigame && !hideTopCenter && (
        <div style={missionCard}>
          <div style={missionTitle}>{hud.missionPopup.title}</div>
          <div style={missionBody}>{hud.missionPopup.body}</div>
        </div>
      )}

      {/* click-to-look hint (desktop, pointer not yet captured) */}
      {!touch && !botMode && !hud.lookLocked && !hud.paused && !hud.intro && (
        <div style={clickHint}>CLICK TO CAPTURE MOUSE · OR DRAG TO LOOK</div>
      )}

      {/* control hints (desktop). On the launch pad, just the essentials. */}
      {!touch && !botMode && (
        <div style={hints}>
          {hud.onPlatform
            ? 'WASD move · drag to look · walk to the edge and step off'
            : 'WASD move · SPACE fly (tap again = boost) · SHIFT sprint · Q grapple · O chute (tap again = CUT) · C board · G enter/ride · H capture · F boost · T transform · J arcade · ESC = pause + all controls'}
        </div>
      )}

      {/* (the persistent touch legend was removed - it collided with the PILOTS /
          STORE row and the action cluster; first-timers get the one-time touch
          coach overlay instead) */}

      {/* pilots roster: open profiles + stats for yourself and everyone online.
          On touch they move to the bottom-center so they clear the thumb-stick
          (bottom-left) and the action cluster (bottom-right) in any orientation. */}
      {!hud.minigame && !hud.intro && !hud.onPlatform && (
        <button
          style={touch ? { ...pilotsBtn, right: 'auto', left: '50%', bottom: 14, transform: 'translateX(-112%)' } : pilotsBtn}
          onClick={() => { setRosterOpen((v) => !v); setStoreOpen(false) }}
        >
          PILOTS{hud.online > 1 ? ` · ${hud.online}` : ''}
        </button>
      )}
      {!hud.minigame && !hud.intro && !hud.onPlatform && (
        <button
          style={touch ? { ...storeBtn, right: 'auto', left: '50%', bottom: 14, transform: 'translateX(12%)' } : storeBtn}
          onClick={() => { setStoreOpen((v) => !v); setRosterOpen(false) }}
        >
          STORE
        </button>
      )}
      {/* SAVE / RESTORE — always available. CHAT — only when a parent has turned
          typed chat on (hud.chatEnabled). Both sit left of STORE/PILOTS; on touch
          they tuck into the bottom-center cluster clear of the thumb zones. */}
      {onSave && !hud.minigame && !hud.intro && !hud.onPlatform && (
        <button
          style={touch ? { ...saveBtn, right: 'auto', left: '50%', bottom: 14, transform: 'translateX(-212%)' } : saveBtn}
          onClick={onSave}
        >
          SAVE
        </button>
      )}
      {onChat && hud.chatEnabled && !hud.minigame && !hud.intro && !hud.onPlatform && (
        <button
          style={touch ? { ...chatBtn, right: 'auto', left: '50%', bottom: 14, transform: 'translateX(112%)' } : chatBtn}
          onClick={onChat}
        >
          CHAT
        </button>
      )}
      {storeOpen && !hud.minigame && (
        <CosmeticsStore p={hud.progress} onBuy={onBuy} onEquip={onEquip} onClose={() => setStoreOpen(false)} />
      )}
      {rosterOpen && !hud.minigame && (
        <div style={rosterPanel}>
          <div style={rosterHead}>
            <span>PILOTS · {hud.online}</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button style={{ ...sortTab, ...(rosterSort === 'rank' ? sortTabOn : {}) }} onClick={() => setRosterSort('rank')}>RANK</button>
              <button style={{ ...sortTab, ...(rosterSort === 'caught' ? sortTabOn : {}) }} onClick={() => setRosterSort('caught')}>CAUGHT</button>
              <button style={closeX} onClick={() => setRosterOpen(false)}>✕</button>
            </span>
          </div>
          {[...profiles]
            .sort((a, b) => (rosterSort === 'rank' ? b.rating - a.rating : b.aliens - a.aliens))
            .map((p, i) => (
              <button key={p.self ? '__self__' : p.id} style={{ ...rosterRow, ...(p.self ? { borderColor: 'rgba(39,231,255,0.4)' } : {}) }} onClick={() => setViewing(p.self ? '__self__' : p.id)}>
                <span style={{ display: 'flex', gap: 7, alignItems: 'center', minWidth: 0 }}>
                  <span style={{ color: i === 0 ? '#ffd24a' : NEON.dim, fontWeight: 800, width: 16 }}>{i + 1}</span>
                  <span style={{ color: p.self ? NEON.cyan : NEON.text, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}{p.self ? ' (you)' : ''}
                  </span>
                </span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ color: NEON.dim }}>LV{p.level}</span>
                  <span style={{ color: p.duelTierColor, fontWeight: 700 }}>{p.duelTier.replace('CLASS ', '')}</span>
                </span>
              </button>
            ))}
          {hud.online <= 1 && <div style={rosterHint}>Solo right now. Others appear here when they join the shared world.</div>}
        </div>
      )}
      {viewed && (
        <div style={profileOverlay} onClick={() => setViewing(null)}>
          <ProfileCard
            profile={viewed}
            achievements={viewed.self ? hud.progress.achievements : undefined}
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

function ProfileCard({ profile, onClose, onChallenge, achievements }: { profile: PlayerProfile; onClose: () => void; onChallenge?: () => void; achievements?: string[] }) {
  const [showBadges, setShowBadges] = useState(false)
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
        <Stat label="BADGES" value={`${profile.badges}/${ACHIEVEMENTS.length}`} color={NEON.purple} />
      </div>
      {achievements && (
        <button style={{ ...rosterRow, justifyContent: 'center', marginTop: 10, color: NEON.purple, borderColor: 'rgba(138,92,255,0.4)' }} onClick={() => setShowBadges((v) => !v)}>
          {showBadges ? 'HIDE BADGES' : 'VIEW BADGES'}
        </button>
      )}
      {achievements && showBadges && (
        <div style={badgeGrid}>
          {ACHIEVEMENTS.map((a) => {
            const got = achievements.includes(a.id)
            return (
              <div key={a.id} style={{ ...badgeItem, opacity: got ? 1 : 0.32, borderColor: got ? a.color : 'rgba(255,255,255,0.1)' }} title={a.desc}>
                <span style={{ color: got ? a.color : NEON.dim, fontWeight: 800, fontSize: 11 }}>{got ? '★' : '☆'} {a.name}</span>
                <span style={{ color: NEON.dim, fontSize: 9 }}>{a.desc}</span>
              </div>
            )
          })}
        </div>
      )}
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

// Wanted-level chip: filled stars for the current heat, pulsing magenta while
// police are actively chasing, steady orange while heat is just building. Hidden
// at zero. Primitive props -> memo skips it except when the level actually moves.
const WantedChip = memo(function WantedChip({ stars, max, wanted }: { stars: number; max: number; wanted: boolean }) {
  if (stars <= 0) return null
  const color = wanted ? NEON.magenta : NEON.orange
  return (
    <div
      style={{
        ...chip,
        marginTop: 4,
        color,
        borderColor: color,
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        animation: wanted ? 'unit7pulse 0.7s ease-in-out infinite' : undefined,
      }}
    >
      <span>{wanted ? 'WANTED' : 'HEAT'}</span>
      <span style={{ letterSpacing: 1 }}>{'★'.repeat(Math.min(max, stars))}</span>
    </div>
  )
})

function WarpChip({ w, touch, onTap }: { w: HudState['warp']; touch: boolean; onTap?: () => void }) {
  const pct = Math.round(w.charge01 * 100)
  const label = w.active ? `WARPED${touch ? '' : ' · R'}` : w.ready ? `WARP READY${touch ? '' : ' · R'}` : `WARP ${pct}%`
  const color = w.active ? NEON.magenta : w.ready ? NEON.lime : NEON.dim
  return (
    <button
      style={{ ...chip, marginTop: 4, color, borderColor: color, pointerEvents: 'auto', cursor: 'pointer', background: 'transparent', letterSpacing: '0.08em', position: 'relative', overflow: 'hidden', minWidth: 96, textAlign: 'left' }}
      onClick={() => onTap?.()}
    >
      {!w.ready && !w.active && (
        <span style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: 'rgba(155,255,77,0.16)' }} />
      )}
      <span style={{ position: 'relative' }}>⚡ {label}</span>
    </button>
  )
}

function PilotProgress({ p, compact }: { p: HudState['progress']; compact?: boolean }) {
  const frac = p.xpSpan > 0 ? Math.max(0, Math.min(1, p.xpInto / p.xpSpan)) : 0
  const d = p.daily
  const dailyText = (DAILY_LABEL[d.kind] ?? ((t: number) => `Goal ${t}`))(d.target)
  return (
    <div style={{ width: compact ? 134 : 160, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
        <span style={{ ...microLabel, color: NEON.cyan }}>LV {p.level}</span>
        {p.streak > 0 && <span style={{ ...microLabel, color: NEON.orange }}>🔥 {p.streak}d</span>}
        {compact && <span style={{ ...microLabel, color: d.claimed ? NEON.lime : NEON.text }}>{Math.min(d.progress, d.target)}/{d.target}</span>}
      </div>
      <div style={barTrack}>
        <div style={{ width: `${frac * 100}%`, height: '100%', background: NEON.cyan, boxShadow: `0 0 8px ${NEON.cyan}` }} />
      </div>
      {/* On phones the long daily line is dropped to keep the corner clear. */}
      {!compact && (
        <>
          <div style={{ ...microLabel, color: NEON.dim, marginTop: 5, display: 'flex', justifyContent: 'space-between' }}>
            <span>DAILY</span>
            <span style={{ color: d.claimed ? NEON.lime : NEON.text }}>{Math.min(d.progress, d.target)}/{d.target}{d.claimed ? ' ✓' : ''}</span>
          </div>
          <div style={{ font: '600 9px/1.3 ui-monospace, Menlo, monospace', color: d.claimed ? NEON.lime : 'rgba(223,238,255,0.7)', letterSpacing: '0.04em' }}>
            {d.claimed ? 'Daily complete!' : dailyText}
          </div>
        </>
      )}
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

// The HUD parent re-runs ~20x/sec (a fresh hud snapshot each push). These leaves
// take primitive props, so wrapping them in memo means an unchanged value (e.g.
// SCORE between captures) skips its re-render entirely — shallow compare is exact
// for primitives. Cuts the per-frame reconciliation of the always-mounted stat
// readouts, which matters most on the mobile tier.
const Logo = memo(function Logo() {
  return (
    <div style={{ font: '800 15px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.22em', marginBottom: 8 }}>
      <span style={{ color: NEON.cyan, textShadow: `0 0 12px ${NEON.cyan}` }}>UNIT</span>
      <span style={{ color: NEON.magenta, textShadow: `0 0 12px ${NEON.magenta}` }}> 7</span>
    </div>
  )
})

const Bar = memo(function Bar({ label, value, color }: { label: string; value: number; color: string }) {
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
})

const Stat = memo(function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'right', minWidth: 54 }}>
      <div style={{ ...microLabel, color: NEON.dim }}>{label}</div>
      <div style={{ font: '700 14px/1.1 ui-monospace, Menlo, monospace', color }}>{value}</div>
    </div>
  )
})

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
const microLabel: CSSProperties = { font: '600 10px/1 ui-monospace, Menlo, monospace', letterSpacing: '0.14em' }
// Top-left button row + a shared pill style. Anchored with safe-area insets so
// the buttons clear notches / rounded corners in landscape.
const topLeftRow: CSSProperties = {
  position: 'absolute',
  top: 'max(14px, env(safe-area-inset-top))',
  left: 'max(14px, env(safe-area-inset-left))',
  display: 'flex',
  flexWrap: 'wrap',
  maxWidth: '62vw', // wrap to a second line on narrow phones instead of under the map
  gap: 8,
  pointerEvents: 'none',
}
const pillBtn: CSSProperties = {
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
  whiteSpace: 'nowrap',
}
// Panels sit below the button row (left) and in the top-right, both inset-aware.
const metersPos: CSSProperties = {
  top: 'max(52px, calc(env(safe-area-inset-top) + 40px))',
  left: 'max(14px, env(safe-area-inset-left))',
}
const statsPos: CSSProperties = {
  top: 'max(14px, env(safe-area-inset-top))',
  right: 'max(14px, env(safe-area-inset-right))',
}
const barTrack: CSSProperties = {
  width: '100%',
  height: 7,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4,
  overflow: 'hidden',
}
const statRow: CSSProperties = { display: 'flex', gap: 14, marginTop: 4 }
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
const raidStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '5px 16px',
  whiteSpace: 'nowrap',
  background: 'rgba(20,4,8,0.72)',
  border: '1px solid rgba(255,90,106,0.55)',
  borderRadius: 999,
  font: '800 12px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  boxShadow: '0 0 18px rgba(255,60,82,0.32)',
  zIndex: 6,
}

const objectiveStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 'max(16px, env(safe-area-inset-top))',
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
const chainStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '22%',
  transform: 'translateX(-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  font: '700 14px/1 ui-monospace, Menlo, monospace',
  textShadow: '0 0 12px rgba(255,138,30,0.6)',
  pointerEvents: 'none',
}
const perfStyle: CSSProperties = {
  position: 'absolute',
  left: 'max(10px, env(safe-area-inset-left))',
  bottom: 'max(10px, env(safe-area-inset-bottom))',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 10px',
  background: 'rgba(6,10,22,0.7)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  font: '600 11px/1.3 ui-monospace, Menlo, monospace',
  pointerEvents: 'none',
}
const comboStyle: CSSProperties = {
  position: 'absolute',
  right: 'max(16px, env(safe-area-inset-right))',
  top: '42%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 2,
  padding: '8px 14px',
  background: 'rgba(6,10,22,0.55)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 12,
  font: '700 14px/1 ui-monospace, Menlo, monospace',
  pointerEvents: 'none',
}
const raceStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 46,
  transform: 'translateX(-50%)',
  padding: '6px 16px',
  whiteSpace: 'nowrap',
  background: 'rgba(6,10,22,0.74)',
  border: '1px solid rgba(155,255,77,0.5)',
  borderRadius: 999,
  font: '800 13px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.12em',
  boxShadow: '0 0 16px rgba(155,255,77,0.25)',
  zIndex: 16,
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
  bottom: 'max(10px, env(safe-area-inset-bottom))',
  transform: 'translateX(-50%)',
  font: '600 12px/1.3 ui-monospace, Menlo, monospace',
  letterSpacing: '0.06em',
  color: 'rgba(223,238,255,0.82)',
  textAlign: 'center',
  maxWidth: '94vw',
  padding: '7px 14px',
  background: 'rgba(6,10,22,0.62)',
  border: '1px solid rgba(39,231,255,0.22)',
  borderRadius: 10,
  pointerEvents: 'none',
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
  right: 128, // clear of PILOTS (which widens to "PILOTS · N" online)
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
// CHAT sits left of STORE (right:128); SAVE sits left of CHAT. Fixed offsets so
// they never overlap whether or not the (conditional) CHAT button is present.
const chatBtn: CSSProperties = {
  position: 'absolute',
  right: 242,
  bottom: 14,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '7px 14px',
  background: 'rgba(6,10,22,0.72)',
  border: '1px solid rgba(39,231,255,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  boxShadow: '0 0 14px rgba(39,231,255,0.22)',
  zIndex: 24,
}
const saveBtn: CSSProperties = {
  position: 'absolute',
  right: 332,
  bottom: 14,
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '7px 14px',
  background: 'rgba(6,10,22,0.72)',
  border: '1px solid rgba(138,92,255,0.5)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.92)',
  font: '700 11px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.16em',
  boxShadow: '0 0 14px rgba(138,92,255,0.22)',
  zIndex: 24,
}
const swatchGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 6,
  margin: '6px 0',
}
const sortTab: CSSProperties = {
  pointerEvents: 'auto',
  cursor: 'pointer',
  padding: '3px 8px',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 999,
  color: 'rgba(223,238,255,0.55)',
  font: '700 9px/1 ui-monospace, Menlo, monospace',
  letterSpacing: '0.1em',
}
const sortTabOn: CSSProperties = {
  color: '#04121a',
  background: 'rgba(39,231,255,0.85)',
  borderColor: 'transparent',
}
const badgeGrid: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  maxHeight: '34vh',
  overflowY: 'auto',
  marginTop: 8,
  paddingRight: 2,
}
const badgeItem: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 9px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  font: '600 11px/1.2 ui-monospace, Menlo, monospace',
  letterSpacing: '0.03em',
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
