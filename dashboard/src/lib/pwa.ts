/**
 * Service-worker registration, and knowing whether we are installed.
 *
 * "Installed" is not a cosmetic distinction on iOS. Safari evicts
 * script-writable storage — IndexedDB, Cache Storage, service worker
 * registrations — after seven days without interaction with a site in a tab,
 * and home-screen web apps are exempt. So an uninstalled app on the iPhone or
 * iPad loses the device's entire dataset after a fortnight's neglect, with no
 * prompt and no warning, and the user's reasonable conclusion is that the app
 * lost their data — which it did.
 *
 * That is why `isStandalone()` exists and why the app says something about it
 * on the affected devices. A warning in a README protects nobody.
 */

/** Whether the app is running as an installed app rather than in a tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // display-mode covers Android/Chrome and modern iOS. navigator.standalone
  // is the old iOS-only flag and is still the reliable one on older Safari,
  // so both are checked rather than assuming the modern path.
  const byMedia = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  const byLegacy = (navigator as { standalone?: boolean }).standalone === true;
  return byMedia || byLegacy;
}

/** iOS and iPadOS Safari, which is the only place the eviction rule applies. */
export function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop Mac UA, so the touch-point count is what
  // distinguishes an iPad from a MacBook. Checking the UA alone would miss
  // every modern iPad — which is one of the five devices this has to work on.
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iOS && webkit;
}

/**
 * Register the worker, quietly.
 *
 * Failure is not fatal and must not be loud: the app works fine without a
 * worker, just without offline and without Chrome's install prompt. It is
 * logged rather than surfaced, because there is nothing the user can do.
 *
 * Guarded on production because a worker in `vite dev` caches the module
 * graph and serves stale code through HMR, which produces edits that appear
 * to do nothing — an hour of debugging the wrong file.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  if (!import.meta.env.PROD) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("service worker registration failed; offline is unavailable", err);
    });
  });
}

const HINT_KEY = "tw.install-hint.dismissed";

/**
 * Whether to tell this device to install the app.
 *
 * Only on iOS Safari, only in a tab, and only once — the message is about a
 * real risk of data loss, but a banner that reappears forever is a banner
 * that gets dismissed without reading.
 */
export function shouldShowInstallHint(): boolean {
  if (isStandalone()) return false;
  if (!isIosSafari()) return false;
  try {
    return localStorage.getItem(HINT_KEY) !== "1";
  } catch {
    // Private browsing can throw on localStorage. Showing the hint again is
    // a smaller failure than crashing the shell on boot.
    return true;
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    /* nothing to do; the hint will reappear, which is the harmless direction */
  }
}
