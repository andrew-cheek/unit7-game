import { useEffect, type CSSProperties } from 'react'

/**
 * Shared UI motion + focus helpers for the Unit 7 React overlay.
 *
 * The UI is styled entirely with inline `CSSProperties`, so two things can't be
 * expressed inline and have to live in a real stylesheet:
 *   1. `:focus-visible` rings (keyboard focus only, not mouse clicks), and
 *   2. a `@media (prefers-reduced-motion: reduce)` block that neutralizes every
 *      UI keyframe animation + transition.
 *
 * Rather than each panel injecting its own `<style>`, we inject ONE global block
 * (deduped by id, matching the pattern ChatPanel already used). It also defines
 * the shared panel-enter keyframes so every modal animates in the same way.
 *
 * Resting-state safety: every enter keyframe animates FROM hidden TO visible and
 * is NOT `forwards`, so once it finishes (or if it's disabled under
 * reduced-motion) the element's normal painted state is fully visible. Nothing
 * is ever left stuck invisible.
 */

const STYLE_ID = 'unit7-ui-style'

// Palette cyan, reused for the keyboard focus ring.
const FOCUS_CYAN = '#27e7ff'

const GLOBAL_CSS = `
/* ---- shared panel / backdrop enter animations ---- */
@keyframes u7panelIn { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes u7fadeIn  { from { opacity: 0; } to { opacity: 1; } }
/* slide-up sheet (ChatPanel) — kept identical in feel to the old unit7chatIn */
@keyframes unit7chatIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
/* pulse + spinner used elsewhere in the UI */
@keyframes unit7pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
@keyframes u7spin { to { transform: rotate(360deg); } }

/* ---- keyboard focus rings (inline styles can't express :focus-visible) ---- */
/* Mouse / touch users keep the clean outline:none look... */
.u7-ui :focus:not(:focus-visible),
.u7-ui button:focus:not(:focus-visible),
.u7-ui input:focus:not(:focus-visible) { outline: none; }
/* ...but keyboard users get a clear neon ring. */
.u7-ui button:focus-visible,
.u7-ui input:focus-visible,
.u7-ui [tabindex]:focus-visible {
  outline: 2px solid ${FOCUS_CYAN};
  outline-offset: 2px;
  box-shadow: 0 0 0 2px rgba(5,8,16,0.9), 0 0 12px rgba(39,231,255,0.7);
}

/* ---- honor the OS "reduce motion" setting (engine already respects it) ---- */
@media (prefers-reduced-motion: reduce) {
  .u7-ui *,
  .u7-ui *::before,
  .u7-ui *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    animation-delay: 0ms !important;
    transition-duration: 0.001ms !important;
    transition-delay: 0ms !important;
  }
}
`

/**
 * Inject the global UI stylesheet once. Idempotent (deduped by element id) so
 * it's safe to call from every panel that mounts. Panels using the shared
 * animations / focus rings must sit under an element carrying the `u7-ui` class
 * (see `U7_UI_CLASS`).
 */
export function useUnit7UiStyles(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = GLOBAL_CSS
    document.head.appendChild(el)
    // Intentionally not removed on unmount: shared across all panels, cheap,
    // and re-injection is guarded by the id check above.
  }, [])
}

/** Class that scopes the focus-ring + reduced-motion rules. Put it on a panel root. */
export const U7_UI_CLASS = 'u7-ui'

/** Standard modal/panel enter: fade + small scale/slide-up. Snappy, ease-out. */
export const panelEnter: CSSProperties = {
  animation: 'u7panelIn 0.18s ease-out',
}

/** Standard backdrop fade-in. */
export const backdropEnter: CSSProperties = {
  animation: 'u7fadeIn 0.15s ease-out',
}
