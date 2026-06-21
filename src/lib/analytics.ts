// Generic, SSR-safe Google Analytics event helper.
// Sends events to whatever GA tag was configured in index.html
// (hostname-aware: G-68V3G2JBXV on unit7.humanoidrobots.com, G-RCCCLCQX95 elsewhere).
// Never throws and never breaks gameplay if gtag is unavailable.

type GtagParamValue = string | number | boolean;

declare global {
    interface Window {
          gtag?: (...args: unknown[]) => void;
          dataLayer?: unknown[];
    }
}

export function trackEvent(
    name: string,
    params?: Record<string, GtagParamValue>
  ): void {
    try {
          if (typeof window === 'undefined') return;
          if (typeof window.gtag !== 'function') return;
          window.gtag('event', name, params || {});
    } catch {
          // Analytics must never break the app.
    }
}
