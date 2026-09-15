/**
 * Re-exported, not re-implemented.
 *
 * This app already has an animated counter in `@/lib/motion`, and it is the
 * stronger of the two: it honours `prefers-reduced-motion`, it renders an
 * em-dash instead of `NaN` for a value that is not finite, and it records
 * where an interrupted tween actually reached — which matters here, because a
 * live run pushes a new value every 2s over a 0.8s tween, and the source
 * version would restart each one from a stale origin and visibly snap
 * backwards before climbing again.
 *
 * Shipping a second copy in the kit would mean two counters drifting apart,
 * so the kit's name simply points at the app's. Props are identical; only the
 * default `duration` differs (0.8s here, 0.9s in the source).
 */
export { CountUp } from "@/lib/motion";
