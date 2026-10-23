# Solas — Design System

A working specification. Values are a starting point. They are tuned in M1 by
looking at real screens in both themes, and this document is updated to match
what ships.

## 1. Character

Solas should feel like a quiet, precise instrument for getting work done: calm
surfaces, crisp type, deliberate spacing, and color used for meaning. The
reference products set the *bar for care*, not the look. Nothing here should
be recognisable as someone else's product.

**Do**
- Neutral surfaces with one restrained accent
- Hierarchy through type weight, size, and spacing before color or boxes
- Hairline borders; very soft shadows only for floating layers
- Dense but breathable layouts suited to daily use
- Honest empty states that say what exists and what doesn't yet
- Status that is always readable as text, not just color

**Don't**
- Neon or multi-stop gradients, glows, heavy glassmorphism
- Oversized cards, decorative illustrations, mascots, "AI sparkle" icons
- Fake charts, placeholder metrics, invented activity
- Motion that doesn't explain a change of state

## 2. Theming

Two first-class themes, **Light** and **Dark**, plus **System** (default),
which follows the OS.

- The preference is stored in `localStorage`. The resolved theme is applied as
  `data-theme="light" | "dark"` on `<html>` by an inline script in `<head>`
  that runs before first paint, so there is no flash.
- On **System**, the app follows `prefers-color-scheme` changes live.
- Tailwind's `dark:` variant is bound to the attribute:
  `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));`
- Components rarely need `dark:`. They use semantic tokens that change per
  theme.
- `color-scheme` is set per theme so native controls and scrollbars match.

Dark mode is designed, not inverted. Surfaces get lighter as they rise,
borders carry more of the structure, and the accent is re-tuned for contrast.

## 3. Color tokens

Semantic CSS custom properties, defined on `:root, [data-theme="light"]` and
`[data-theme="dark"]`, exposed to Tailwind via `@theme inline` (`bg-surface`,
`text-muted`, `border-border`, …). Values are OKLCH for even perceptual steps.

| Token | Role | Light | Dark |
| --- | --- | --- | --- |
| `--background` | App canvas | `oklch(0.985 0.002 260)` | `oklch(0.165 0.005 260)` |
| `--surface` | Sidebar, panels, inputs | `oklch(1 0 0)` | `oklch(0.195 0.006 260)` |
| `--surface-raised` | Menus, dialogs, popovers | `oklch(1 0 0)` | `oklch(0.225 0.007 260)` |
| `--surface-hover` | Hover / selected fill | `oklch(0.962 0.003 260)` | `oklch(0.245 0.007 260)` |
| `--border` | Default hairline | `oklch(0.912 0.004 260)` | `oklch(0.28 0.008 260)` |
| `--border-strong` | Inputs, emphasis | `oklch(0.855 0.005 260)` | `oklch(0.35 0.01 260)` |
| `--foreground` | Primary text | `oklch(0.2 0.01 260)` | `oklch(0.95 0.003 260)` |
| `--muted` | Secondary text | `oklch(0.47 0.012 260)` | `oklch(0.72 0.01 260)` |
| `--subtle` | Tertiary text, meta | `oklch(0.54 0.01 260)` | `oklch(0.62 0.01 260)` |
| `--accent` | Primary action, focus, selection | `oklch(0.5 0.13 255)` | `oklch(0.68 0.12 255)` |
| `--accent-foreground` | Text on accent | `oklch(0.99 0 0)` | `oklch(0.16 0.01 260)` |
| `--accent-subtle` | Soft highlight | `oklch(0.95 0.02 255)` | `oklch(0.27 0.04 255)` |
| `--danger` | Destructive, failed | `oklch(0.55 0.19 25)` | `oklch(0.68 0.16 25)` |
| `--warning` | Needs approval, caution | `oklch(0.7 0.14 75)` | `oklch(0.78 0.13 75)` |
| `--success` | Succeeded, healthy | `oklch(0.55 0.12 150)` | `oklch(0.7 0.12 150)` |
| `--focus-ring` | Keyboard focus | `= --accent` | `= --accent` |

Rules:
- Text meets **WCAG AA**: 4.5:1 for body text, 3:1 for large text and UI
  boundaries. Ratios are computed in M1 against `--background`, `--surface`,
  and `--surface-hover`, and re-checked whenever a value changes.
- Status color is always paired with a label or icon.
- No raw color values in components. A missing color becomes a token here first.

## 4. Typography

**Geist Sans** for UI, **Geist Mono** for code, IDs, timestamps in logs, and
key hints. Both are already loaded via `next/font` (self-hosted, no layout
shift, no new dependency). This may change during brand work.

Base UI size is **14px** for a dense working tool. Agent output and long text
use **15px** with generous leading.

| Token | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `text-xs` | 12 / 16 | 400–500 | Meta, timestamps, badges |
| `text-sm` | 13 / 18 | 400–500 | Secondary UI, nav, table cells |
| `text-base` | 14 / 20 | 400 | Default UI text |
| `text-reading` | 15 / 24 | 400 | Messages, agent output, instructions |
| `text-lg` | 16 / 24 | 500–600 | Section titles, wordmark |
| `text-xl` | 20 / 28 | 600 | Page titles |
| `text-2xl` | 24 / 32 | 600 | Rare: onboarding headings |

- Weights 400 / 500 / 600 only.
- Titles use `-0.015em` to `-0.02em` tracking; small text uses none.
- `tabular-nums` for counts, durations, and times.
- Reading width: max ~72 characters (conversation column ≈ 720px).

## 5. Spacing and layout

- **4px grid.** Steps: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Inside components: 8–12px. Related items: 8px. Groups: 16–24px. Page
  sections: 32–48px.
- **Shell:**
  - Sidebar 240px, collapsible to a 56px icon rail (persisted). Below 768px it
    becomes a drawer opened from a 48px top bar.
  - Page header: title, one-line description, primary action on the right.
  - Content max width 1040px for management pages; conversation column 720px.
- **Breakpoints:** Tailwind defaults. Design at 375, 768, and 1280px.
- Mobile gutter at least 16px; never a horizontal page scroll.

## 6. Shape, elevation, borders

| Token | Value | Use |
| --- | --- | --- |
| `--radius-sm` | 4px | Badges, small controls |
| `--radius-md` | 6px | Buttons, inputs, nav items |
| `--radius-lg` | 8px | Panels, lists, menus |
| `--radius-xl` | 12px | Dialogs |

- 1px borders with `--border`. Prefer a border *or* a shadow, rarely both.
- Shadows only for floating layers (menus, dialogs, toasts). In dark mode,
  rely on lighter surfaces more than shadows.

## 7. Motion

- 100ms for hover/press, 150ms for menus, 200ms for dialogs and the drawer.
- Easing `cubic-bezier(0.2, 0, 0, 1)`. Animate opacity and transform only.
- `prefers-reduced-motion: reduce` makes transitions instant.
- Theme switches apply instantly; transitions are paused for that frame.
- Agent output appears as it arrives. No fake typing effects, no spinners when
  a precise status ("Waiting for approval", "Running · 0:42") is available.

## 8. Iconography

- One outline style: 24px grid, 1.5px stroke, `currentColor`; drawn at 16px
  in dense UI and 20px in headers.
- A small hand-drawn set lives in `src/components/icons.tsx`. Consider a
  library only if the set grows large (that would need approval).
- Icons are decorative. Icon-only buttons always have an accessible name and
  a tooltip.

## 9. Wordmark (temporary)

The word **Solas** in Geist Sans, weight 600, 16px, tracking `-0.02em`,
`--foreground`. No symbol, gradient, or custom lettering. Replaced during
brand work.

## 10. Components

Each component is built when a milestone needs it. Each has its variants,
sizes, states (default, hover, active, focus-visible, disabled, loading), both
themes, and keyboard behavior.

| Component | Notes | Milestone |
| --- | --- | --- |
| Button / IconButton | `primary`, `secondary`, `ghost`; 28px / 32px; icon-only requires a label, optional `shortcut` | M1 ✓ |
| Nav item | Icon + label; active = neutral fill + foreground text; `aria-current="page"`; tooltip in rail mode | M1 ✓ |
| Theme selector | Native radio group: compact segments (sidebar) and preview cards (Settings) | M1 ✓ |
| Badge | Dot + text: `neutral`, `success` (more tones when needed) | M1 ✓ |
| Page header, Empty state | Title, one sentence, optional status and action | M1 ✓ |
| Input | `default` and `bare` (inside a styled container); focus ring on `:focus-visible` | M1 ✓ |
| Dialog | Native `<dialog>` + `showModal()`; focus moved in and restored; `Esc` and backdrop close; state-driven `open` | M1 ✓ |
| Kbd, Skeleton | Key hints; loading placeholders (pulse stops under reduced motion) | M1 ✓ |
| Top bar | Sidebar toggle, breadcrumbs, search trigger (desktop); menu, wordmark, search icon (mobile) | M1 ✓ |
| Command menu | ⌘K; ARIA combobox: focus stays in the input, ↑/↓ move, ↵ runs; selected row uses `foreground` at 7% so it reads on raised dark surfaces | M1 ✓ |
| Field, Textarea, Select | Visible label, hint, error linked by `aria-describedby` | M2 |
| Confirm dialog | Built on Dialog; destructive action requires explicit confirm | M2 |
| Menu | Arrow-key navigation; native Popover API first | M2 |
| Toast | Polite live region for results of actions | M2 |
| Agent row / card | Name, role, model, tool profile, status, last run | M2 |
| Run status | `Queued`, `Running`, `Waiting for approval`, `Succeeded`, `Failed`, `Cancelled`; text always shown | M4 |
| Run timeline | Ordered events: text, tool calls, results, errors; collapsible details in mono | M4–M6 |
| Message, Composer | Agent vs. owner styling; markdown; `Enter` sends, `Shift+Enter` newline; stop button while running | M5 |
| Approval card | What the agent wants to do, why, exact inputs, Approve / Deny; `--warning` accent | M7 |
| Task row, Schedule editor | Status, next run, last result; human-readable cron preview | M8 |

## 11. Accessibility

- Semantic HTML first: landmarks, real buttons and links, ordered headings.
- Everything is reachable by keyboard, with a visible `:focus-visible` ring
  (2px `--focus-ring`, 2px offset).
- A "Skip to content" link in the shell.
- Live regions: polite for streaming agent output and run status, assertive
  only for errors that block the owner.
- Target size at least 24px; at least 40px for primary touch targets.
- Checked every milestone: keyboard-only pass, both themes, 200% zoom, 375px,
  VoiceOver spot check.

## 12. Keyboard shortcuts (planned)

| Shortcut | Action | Milestone |
| --- | --- | --- |
| `Enter` / `Shift+Enter` | Send / newline in the composer | M5 |
| `Esc` | Close dialog, menu, drawer; stop a running reply | M2–M5 |
| `[` | Collapse / expand the sidebar | M1 ✓ |
| `⌘K` / `Ctrl+K` | Command menu: go to a page, switch theme, toggle sidebar | M1 ✓ |

Shortcuts never override browser or screen-reader defaults and are ignored
while typing in a field.

## 13. Review checklist (every UI change)

- [ ] Intentional in light **and** dark
- [ ] Tokens only; no raw colors
- [ ] Works at 375, 768, and 1280px
- [ ] Keyboard-only usable; focus visible; logical order
- [ ] Text contrast meets AA
- [ ] Empty, loading, error, and long-content states considered
- [ ] No fake data; no decoration without purpose
