/**
 * Every `var(--color-*)` the app references must be defined by the theme.
 *
 * The break this catches has no symptom. A missing CSS custom property is not
 * an error — `color-mix(in srgb, var(--nope) 10%, transparent)` resolves to
 * nothing, so the chip renders invisible, the build passes, the types pass,
 * and the only way to notice is to look at that exact chip on that exact
 * screen.
 *
 * It had already happened. Replacing the theme deleted `--color-copper`,
 * `--color-copper-lt` and `--color-amber`, which `lib/nexus/constants.ts`
 * still named for fragment types and moods. A grep for hex literals — the
 * check the component kit passes — cannot see this: these are token
 * references, which is exactly what a hex-literal check asks you to write.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `fileURLToPath`, not `.pathname`: this repo lives under "MacBook Pro", and
// a URL pathname is percent-encoded, so `.pathname` hands `readdirSync` a
// directory called "MacBook%20Pro" that does not exist. The same space has
// now broken a systemd unit, an ExecStart and this.
const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

describe("theme tokens", () => {
  const files = sources(SRC);
  const theme = readFileSync(join(SRC, "theme.css"), "utf8");
  const defined = new Set([...theme.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]!));

  it("defines every palette token the app references", () => {
    // Scoped to `--color-*`, and that scope is the point rather than laziness.
    // A component may legitimately reference a variable it sets itself at
    // runtime — `Card` writes `--mx`/`--my` for its cursor sheen and
    // `--card-accent` for a per-card hue, each with a fallback. Those are not
    // theme tokens and the theme should not define them. The palette namespace
    // is the one where a missing definition is always a bug, because nothing
    // else writes into it.
    const missing = new Map<string, string[]>();
    for (const f of files) {
      if (f.endsWith("theme.css") || f.endsWith("theme.test.ts")) continue;
      for (const m of readFileSync(f, "utf8").matchAll(/var\((--color-[a-z0-9-]{2,}?)\s*[),]/g)) {
        const name = m[1]!;
        if (!defined.has(name)) {
          const where = missing.get(name) ?? [];
          where.push(f.slice(SRC.length));
          missing.set(name, where);
        }
      }
    }
    expect(
      Object.fromEntries(missing),
      "these tokens are referenced but never defined; a missing custom property " +
        "renders as nothing rather than failing",
    ).toEqual({});
  });

  it("found a real corpus to check, not an empty one", () => {
    // Without this the test above passes when the walk breaks or the regex
    // stops matching — a green assertion over no input, which is the failure
    // it exists to prevent wearing a different hat.
    expect(files.length).toBeGreaterThan(40);
    expect(defined.size).toBeGreaterThan(30);
  });
});
