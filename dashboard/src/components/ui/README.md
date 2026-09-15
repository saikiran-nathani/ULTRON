# `components/ui` — the ported component kit

Twenty-one primitives brought across from the desktop app's kit, retuned for a
PWA that has to hold up on a phone and an iPad as well as on a desktop.

Nothing in here names a colour. Every surface, rule, text tone and accent is a
theme token from `src/theme.css`, so re-palletting the app stays a one-file
change. If a component needs a colour the theme does not define, it takes it as
a prop (`color`, `tone`, `track`) and the caller passes a token var — it does
not invent a value.

Import from the barrel:

```ts
import { Card, Button, Tabs, type TabDef } from "@/components/ui";
```

## What each one is for

| Component | For | Tokens it consumes |
| --- | --- | --- |
| `Card` | Base surface. `active` draws the accent left-rule, `interactive` adds lift + a cursor-tracked sheen. | `card`, `line`, `line-active`, `accent`, `--shadow-card`, `--radius-md`, `--ease-signature` |
| `Button` | Four variants — `primary`, `ghost`, `subtle`, `danger` — in `sm`/`md`. | `accent`, `accent-lt`, `bg`, `card`, `card-hover`, `fg`, `fg-dim`, `line`, `line-active`, `--color-bad`, `--shadow-glow`, `--shadow-card` |
| `IconButton` | A bare icon action in a dense row. | `card`, `card-hover`, `line`, `fg`, `fg-dim`, `fg-muted`, `--color-bad`, `--radius-xs` |
| `Chip` | Pill badge, accent-tinted or tinted to any token passed as `color`. | `accent` (default), plus whatever the caller passes |
| `Stat` | Micro-label over a large tabular number. | `fg` (default), `fg-muted`, `.label`/`.nums` type voices |
| `CountUp` | A number that eases to its new value. Re-exports the app's own hardened counter from `@/lib/motion`. | none directly — inherits the caller's colour |
| `ProgressBar` | Horizontal 0–100 fill. Also exports `clampPct`, shared with the ring. | `subtle`, `accent` (default) |
| `ProgressRing` | Circular 0–100 arc with a centred `children` readout. | `subtle` (track), `accent` (default), `--ease-signature` |
| `Sparkline` | Inline trend line with optional area fill and end dot. Geometry is split out as `sparklineGeometry` and unit-tested. | `accent` (default) |
| `InlineEdit` | Tap-to-edit text in place. Enter/blur commits, Esc cancels. | `card-hover`, `fg-muted`, plus everything `inputCls` uses |
| `EmptyState` | The finish on an empty list — icon, title, hint, action. | `card`, `line`, `accent-dim`, `fg-dim`, `fg-muted`, `--radius-md` |
| `ScrollList` | Height-capped scroller for long record lists. | none — layout only |
| `StatBand` | Auto-fitting row of stat cards; a cell with `onClick` is a real control. | via `Card`, plus `fg` (default), `fg-muted` |
| `Callout` | Highlighted insight card with a toned header and left rule. | via `Card`, plus `accent` (default `tone`), `fg-dim` |
| `ExpandableCard` | Card whose body reveals on a chevron toggle. Controlled or not. | via `Card`, plus `line`, `fg-muted` |
| `SegmentedControl` | Multi-state selector; the active segment takes a fill. | `line`, `bg`, `fg-dim`, `fg-muted`, `accent` (default fill), `--radius-xs`, `--radius-sm` |
| `Tabs` | Tab strip with an underline that glides between tabs. | `line`, `accent`, `accent-lt`, `fg-dim`, `fg-muted` |
| `Modal` | Centred dialog — header, scrolling body, optional footer. Esc and the scrim both close it. | `panel`, `line`, `line-active`, `fg`, `fg-muted`, `--radius-lg` |
| `Field` | `inputCls` / `labelCls`, the shared form styling, plus a labelled wrapper. | `bg`, `line`, `line-strong`, `fg`, `fg-muted` |
| `FormModal` | Config-driven create/edit form. `formInitialValues` and `coerceFormValues` are exported and unit-tested. | via `Modal`, `Button`, `Field`, plus `accent` (checkbox), `fg-dim` |
| `ConfirmDialog` | Destructive-action confirmation. | via `Modal` and `Button` |

Type voices (`.display`, `.nums`, `.label`) and radii, shadows and easing all
come from `theme.css` as well; the table lists colours only where a component
names one.

## Two things to know before adding to this kit

**Touch targets go on `pointer-coarse`, not on a breakpoint.** Width is a bad
proxy for input device: an iPad in landscape is 1024px wide and driven by a
thumb, while a narrow desktop window is not. The source kit used
`min-h-11 md:min-h-0`, which handed the 44px floor back on exactly the device
that needed it. Here the floor is `pointer-coarse:min-h-[44px]` — a fine
pointer matches no rule at all, so desktop metrics stay padding-driven and
identical to the desktop app's. Prefer `min-h`/`min-w` over larger `h`/`w`:
a minimum clamps an explicit size instead of competing with it, so there is no
variant-order race.

**Pointer-hover may decorate an action; it may never be the only way to find
one.** Remaining hover styling in this directory is lift, brightening, a sheen
sweep — all of it on controls that are fully visible and tappable at rest.
Where the source used hover as the affordance itself (`InlineEdit`'s editable
text, `IconButton`'s missing resting surface), the coarse-pointer branch now
draws that affordance permanently. If you find yourself reaching for
`opacity-0` plus a group-hover reveal, the control is about to become invisible
on three of this app's five target devices.

## Overlap with `src/ui`

`src/ui/` holds nine primitives of its own — `Button`, `Card`, `Chip`,
`EmptyState`, `Ring`, `Stat`, `Tabs`, `Chart`, `CopyButton` — several sharing
names with this kit and differing in props and metrics (that `Button` takes a
gradient fill and an unconditional 44px floor; that `Tabs` takes per-tab
counts; that `Chip` takes a `dot`). Both directories are token-driven and
neither is wrong, but two `Button`s will drift. Which one survives is a call
for whoever owns the screens; until then, prefer this kit for ported screens
and `src/ui` for screens already written against it, and do not mix the two
within one screen.
