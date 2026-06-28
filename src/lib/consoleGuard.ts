// Defensive console guard. Two jobs, zero gameplay impact:
//   1. A self-XSS warning for anyone who opens the devtools console.
//   2. A harmless "tamper canary" on a tempting fake admin hook that quietly
//      reports (via analytics) when someone pokes at it.
// Everything here is best-effort and must never throw.

import { trackEvent } from './analytics';

let installed = false;
let canaryFired = false;

export function installConsoleGuard(): void {
    try {
        if (typeof window === 'undefined') return;
        if (installed) return;
        installed = true;

        // --- Self-XSS warning ---------------------------------------------
        console.log(
            '%cHOLD UP.',
            'font-size:36px;font-weight:800;color:#ff2e63;text-shadow:0 1px 0 #000;',
        );
        console.log(
            '%cIf someone told you to paste code in here to get free credits, hack the ' +
                'game, or unlock a skin: they are lying to you and trying to steal your ' +
                'account. There is no secret command. Close this tab.',
            'font-size:14px;color:#e0e0e0;',
        );

        // --- Tamper canary ------------------------------------------------
        // A fake admin hook that looks pokeable. Reading it fires one analytics
        // ping and hands back a joke value. Defined as a getter so we learn the
        // moment a curious (or not-so-curious) visitor touches it.
        Object.defineProperty(window, '__unit7_admin', {
            configurable: true,
            get() {
                if (!canaryFired) {
                    canaryFired = true;
                    try {
                        trackEvent('tamper_probe', { hook: 'admin' });
                    } catch {
                        // Analytics must never break anything.
                    }
                }
                return 'nice try. the only admin here is the raccoon in the server closet.';
            },
        });
    } catch {
        // A broken guard is worse than no guard. Swallow everything.
    }
}
