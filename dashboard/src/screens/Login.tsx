/**
 * The gate — the first screen every one of the five devices now sees.
 *
 * Deliberately not a modal over the app. When enforcement is on and we are
 * nobody, every /api/ read is already 401ing, so anything rendered behind a
 * dialog would be empty or stale — and stale-behind-a-dialog is exactly what
 * "up but lying" looks like. Full screen, nothing behind it.
 *
 * Built from the same primitives as `Pulse`, on purpose. The app's identity is
 * an instrument: a hairline bezel of concentric rings, a sonar sweep, the
 * verdict in the display face. A login screen in some other idiom would be the
 * only screen in the product that looks like a web form, and it is the screen
 * seen most often and first. So the radar is live here too — it is the same
 * drawing as `icon.svg`, made of the same rings and sweep, which also means
 * the home-screen tile and the first screen agree with each other.
 *
 * Two details that are function rather than decoration:
 *
 * * **The host is shown.** Five devices reach this box by several names —
 *   `localhost`, a tailnet IP, a MagicDNS name — and which one you are on
 *   decides whether the session cookie can be `Secure`. Printing it turns a
 *   confusing class of failure into a glance.
 * * **Caps Lock is called out.** It is one of the most common causes of a
 *   correct password being rejected, and the server's reply is deliberately
 *   the same for every kind of failure, so it can never tell you.
 *
 * The username field stays even though there is one human today. It is the
 * multi-user-ready shape, it costs one input, and a password-only form would
 * have to be replaced rather than extended the first time there are two people.
 */
import { forwardRef, useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, InputHTMLAttributes, ReactNode } from "react";
import { Eye, EyeOff, KeyRound, LockKeyhole, Share, ShieldAlert, UserRound } from "lucide-react";
import { Button } from "@/ui/Button";
import { LoginError, login } from "@/lib/auth";
import { usePrefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/cn";

/**
 * The instrument mark: a live radar, drawn with the bezel primitives.
 *
 * The sweep is a CSS rotation rather than a Framer tween because Safari
 * suspends rAF in a backgrounded tab, and an interrupted JS tween settles
 * wherever it stopped. A CSS animation resumes correctly and, more to the
 * point, cannot leave the sweep frozen at an arbitrary angle — which on a
 * screen whose whole job is to look alive would read as "the app has hung".
 */
function RadarMark({ size = 88, active }: { size?: number; active: boolean }) {
  const reduced = usePrefersReducedMotion();
  const sweeping = active && !reduced;

  return (
    <div
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {sweeping && (
        <>
          <span
            className="sonar-ping absolute rounded-full border"
            style={{
              width: size * 0.9,
              height: size * 0.9,
              borderColor: "color-mix(in srgb, var(--color-accent) 34%, transparent)",
            }}
          />
          <span
            className="sonar-ping absolute rounded-full border"
            style={{
              width: size * 0.9,
              height: size * 0.9,
              borderColor: "color-mix(in srgb, var(--color-accent) 20%, transparent)",
              animationDelay: "1.4s",
            }}
          />
        </>
      )}

      {/* The bezel: three concentric hairlines, same construction as Pulse. */}
      {[1, 0.68, 0.38].map((f) => (
        <span
          key={f}
          className="absolute rounded-full border-[0.5px]"
          style={{
            width: size * f,
            height: size * f,
            borderColor: f === 1 ? "var(--color-line)" : "var(--color-hairline)",
          }}
        />
      ))}

      {/* The sweep wedge, rotating. */}
      <span
        className={cn("absolute inset-0 rounded-full", sweeping && "radar-sweep")}
        style={{
          background:
            "conic-gradient(from 0deg, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 26%)",
          maskImage: "radial-gradient(circle at 50% 50%, #000 0 49%, transparent 50%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 50%, #000 0 49%, transparent 50%)",
        }}
      />

      {/* The return blip at the centre. */}
      <span
        className="absolute h-[5px] w-[5px] rounded-full bg-accent-lt"
        style={{ boxShadow: "0 0 10px var(--color-accent)" }}
      />
    </div>
  );
}

/**
 * A machined text field: leading icon, accent focus ring, 44px minimum.
 *
 * forwardRef and not a plain component: the username field is autofocused on
 * desktop, and a ref passed to a function component is silently dropped —
 * `userRef.current` would stay null and the focus call would do nothing, with
 * no error to explain why.
 */
const Field = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & {
    icon: ReactNode;
    label: string;
    trailing?: ReactNode;
  }
>(function Field({ icon, label, trailing, ...rest }, ref) {
  return (
    <label className="block">
      <span className="label mb-1.5 block">{label}</span>
      {/* focus-within rather than focus: the ring belongs to the whole field,
          including its icons, or the icon appears to fall outside the control. */}
      <span
        className={cn(
          "group/f relative flex items-center gap-2.5 rounded-sm border-[0.5px] border-line bg-bg/50 px-3",
          "transition-all duration-200 ease-[var(--ease-signature)]",
          "focus-within:border-line-active focus-within:bg-bg/70",
          "focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_22%,transparent),0_8px_28px_-18px_color-mix(in_srgb,var(--color-accent)_70%,transparent)]",
        )}
      >
        <span className="shrink-0 text-fg-muted transition-colors group-focus-within/f:text-accent">
          {icon}
        </span>
        <input
          ref={ref}
          {...rest}
          className="min-h-[44px] w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-muted/60"
        />
        {trailing}
      </span>
    </label>
  );
});

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capsOn, setCapsOn] = useState(false);
  /** Non-null while rate-limited, counting down so the button can say why. */
  const [cooldown, setCooldown] = useState<number | null>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Desktop only. Autofocusing on a phone raises the keyboard over the form
    // before the user has decided to type.
    if (window.matchMedia("(min-width: 1024px)").matches) userRef.current?.focus();
  }, []);

  useEffect(() => {
    if (cooldown === null) return;
    if (cooldown <= 0) {
      setCooldown(null);
      return;
    }
    const t = window.setTimeout(() => setCooldown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || cooldown !== null) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      // Drop the credential from component state on the way out. Not a real
      // defence — it has already been in the DOM — but keeping it in a live
      // React tree after it has served its purpose is gratuitous.
      setPassword("");
      onSignedIn();
    } catch (err) {
      if (err instanceof LoginError) {
        setError(err.message);
        if (err.retryAfter) setCooldown(err.retryAfter);
      } else {
        // A network failure and a wrong password both leave you on this
        // screen, so the difference has to be said out loud.
        setError(
          err instanceof Error
            ? `Could not reach the server: ${err.message}`
            : "Could not reach the server.",
        );
      }
      setBusy(false);
    }
  };

  const blocked = busy || cooldown !== null;
  const host = typeof window === "undefined" ? "" : window.location.host;

  return (
    <div className="relative h-full w-full overflow-y-auto">
      <div className="grid min-h-full place-items-center pl-[max(env(safe-area-inset-left),1.5rem)] pr-[max(env(safe-area-inset-right),1.5rem)] pt-[max(env(safe-area-inset-top),2.5rem)] pb-[max(env(safe-area-inset-bottom),2.5rem)]">
        <form onSubmit={submit} className="w-full max-w-[352px]">
          {/* ── the mark ── */}
          <div className="rise mb-7 flex flex-col items-center text-center" style={{ "--i": 0 } as CSSProperties}>
            <RadarMark active={!blocked} />
            <div className="label mt-5 flex items-center gap-2 text-accent-dim">
              <span className="inline-block h-px w-5 bg-accent-dim/60" />
              tailnet only
              <span className="inline-block h-px w-5 bg-accent-dim/60" />
            </div>
            <h1 className="display mt-3 text-[30px] leading-none text-fg">trainwatch</h1>
            {host && (
              // Which name you reached the box by decides whether the session
              // cookie can be Secure, so it is worth a glance, not a guess.
              <p className="nums mt-2.5 text-[10.5px] text-fg-muted">{host}</p>
            )}
          </div>

          {/* ── the card ── */}
          <div
            className="rise edge-light relative overflow-hidden rounded-md border-[0.5px] border-line bg-card/60 p-6 shadow-[var(--shadow-pop)] backdrop-blur-xl"
            style={{ "--i": 1 } as CSSProperties}
          >
            {/* Accent hairline across the top, fading at both ends — the
                machined edge the cards elsewhere in the app have. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px"
              style={{
                background:
                  "linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-accent) 55%, transparent), transparent)",
              }}
            />

            <div className="flex flex-col gap-4">
              <Field
                ref={userRef}
                icon={<UserRound size={13} strokeWidth={1.9} />}
                label="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />

              <Field
                icon={<KeyRound size={13} strokeWidth={1.9} />}
                label="password"
                type={reveal ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                // getModifierState is the only way to know, and it is only
                // available on a real key event — hence both handlers.
                onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                onKeyDown={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                autoComplete="current-password"
                required
                trailing={
                  <button
                    type="button"
                    onClick={() => setReveal((r) => !r)}
                    aria-label={reveal ? "Hide password" : "Show password"}
                    // 44px so it is a real touch target, negative margin so it
                    // does not inflate the field it sits inside.
                    className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-sm text-fg-muted transition-colors hover:text-fg-dim active:scale-[0.94]"
                  >
                    {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                }
              />

              {capsOn && (
                <p className="label flex items-center gap-2 text-[var(--color-warn)]">
                  <LockKeyhole size={11} />
                  caps lock is on
                </p>
              )}

              {error && (
                // aria-live: the form does not move when this appears, so a
                // screen reader would otherwise never learn the attempt failed.
                <div
                  role="alert"
                  aria-live="polite"
                  className="flex items-start gap-2 rounded-sm border-[0.5px] border-[color-mix(in_srgb,var(--color-bad)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-bad)_10%,transparent)] px-3 py-2.5"
                >
                  <ShieldAlert size={13} className="mt-0.5 shrink-0 text-[var(--color-bad)]" />
                  <p className="text-[11.5px] leading-relaxed text-fg-dim">{error}</p>
                </div>
              )}

              <Button type="submit" variant="primary" className="mt-1 w-full" disabled={blocked}>
                {cooldown !== null ? `locked — ${cooldown}s` : busy ? "signing in…" : "sign in"}
              </Button>
            </div>
          </div>

          <p
            className="rise mt-5 text-center text-[10.5px] leading-relaxed text-fg-muted"
            style={{ "--i": 2 } as CSSProperties}
          >
            Reachable only over the tailnet. There is no public route in.
          </p>
        </form>
      </div>

      {/* The grain lives on the app shell, which is not mounted yet — so the
          gate carries its own, or it would be the one screen without it. */}
      <div
        aria-hidden
        className="grain pointer-events-none fixed inset-0 z-[60] opacity-[0.035] mix-blend-soft-light"
      />
    </div>
  );
}

/**
 * Shown when the server reports `enforcing: false` — no identities enrolled.
 *
 * This is the third boot state, and the one that gets forgotten. Without it the
 * natural implementation shows a login form on a box that has no accounts: a
 * door with no key, guarding a room that was never locked. It is a visible
 * notice rather than silence because "open on the tailnet" is a real posture
 * with real implications, and a posture nobody can see is one nobody changes.
 */
export function OpenNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Banner tone="warn" icon={<ShieldAlert size={13} />} onDismiss={onDismiss} dismissLabel="dismiss">
      No accounts exist, so anything on the tailnet can read and write this. Run{" "}
      <code className="nums text-fg">trainwatch user add</code> to enrol one — the login screen
      appears on its own afterwards.
    </Banner>
  );
}

/**
 * Told once, on the devices it applies to, in the UI rather than a README.
 *
 * The risk is specific and invisible: Safari evicts this app's storage after
 * seven days of non-use unless it lives on the home screen. Nobody reads
 * documentation to discover that their data has a shelf life.
 */
export function InstallHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Banner tone="info" icon={<Share size={13} />} onDismiss={onDismiss} dismissLabel="got it">
      Add trainwatch to your home screen — Share, then{" "}
      <span className="text-fg">Add to Home Screen</span>. In a Safari tab, iOS deletes this
      app&apos;s offline data after 7 days unused; installed apps keep it.
    </Banner>
  );
}

/** One banner, two tones — so the two notices cannot drift apart visually. */
function Banner({
  tone,
  icon,
  children,
  onDismiss,
  dismissLabel,
}: {
  tone: "warn" | "info";
  icon: ReactNode;
  children: ReactNode;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  const colour = tone === "warn" ? "var(--color-warn)" : "var(--color-info)";
  return (
    <div
      className="shrink-0 border-b-[0.5px] py-2 pl-[max(env(safe-area-inset-left),1rem)] pr-[max(env(safe-area-inset-right),1rem)]"
      style={{
        borderColor: `color-mix(in srgb, ${colour} 28%, transparent)`,
        background: `color-mix(in srgb, ${colour} 8%, transparent)`,
      }}
    >
      <div className="mx-auto flex max-w-[900px] items-center gap-3">
        <span className="shrink-0" style={{ color: colour }}>
          {icon}
        </span>
        <p className="flex-1 text-[11px] leading-relaxed text-fg-dim">{children}</p>
        <button
          onClick={onDismiss}
          className="min-h-[32px] shrink-0 px-2 text-[11px] text-fg-muted transition-colors hover:text-fg"
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}
