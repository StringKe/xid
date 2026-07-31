---
type: skills
name: frontend-design
description: Design execution rules for building or reworking XID product surfaces (Hosted UI / console / SDK components) -- produce non-templated interfaces inside the existing --xid-* design system and avoid recognizable AI-default patterns
when_to_use: Creating a page or component, reworking a layout, writing UI copy, or when a reviewer says the interface "looks AI-generated" or "too templated"
allowed_tools: [Read, Edit, Write, Glob, Grep, Bash]
metadata:
  category: frontend
  stack: react-stylex
---

# Front-end design: XID anti-AI-default rules

LLM front-end output converges on the statistical median of its training data, and that average is
recognizable. XID already has a complete product design system, so this skill does **not** cover
picking fonts or colors. Product tokens and runtime brand override live in
`packages/web-ui/src/styles/tokens.stylex.ts`. The public surface is a Nimbus documentation site;
its shell and components stay in the Nimbus design system and do not use the XID React product
system. This skill covers the three things that are left:
**layouts that avoid the template, hierarchy expressed through the system, and copy that reads like
a person wrote it.**

## 1. Design input priority (settle this before writing code)

1. A design exists (exported from claude.ai/design, or a chapter of `docs/design/`): match it
   pixel for pixel, no improvising. Glyphs, symbols, and numeric values in the design are the
   truth -- keep them as they are.
2. No design, but a comparable surface already ships: reuse its layout grammar and density.
   Consistency across the product beats uniqueness on one page.
3. New surface with no reference: write a five-line design brief first (purpose and audience /
   layout grammar / density strategy / where motion belongs / relationship to adjacent pages),
   then write code. Do not fall back to a generic dashboard template by default.

## 2. Express hierarchy through the system, no escape hatches

- Color, radius, shadow, and type always come from `tokens['--xid-*']`. Literal `oklch()` or hex
  values MUST NOT appear in a component -- runtime brand
  override and `darkTheme` both work by flipping CSS variables, so a literal value is a color
  incident under dark mode or a white-label tenant. The only exception is content that stays dark
  in both themes, such as a code panel, and it MUST live in a central token definition.
- Build hierarchy from the neutral ramp (`bg` < `sidebar` < `muted`, with `surface` lifted above
  `bg`) plus size and weight -- not by adding a border, a shadow, and a tint everywhere. One panel
  gets at most one level of emphasis.
- Large display sizes take low weight (<= 650): let the size do the work, not the weight. Heading
  line-height 1.06-1.2, body 1.5-1.65.
- Light and dark flip automatically through the tokens and `darkTheme`, applied to
  `documentElement` (see `packages/web-ui/src/theme.tsx`). Components MUST NOT branch on
  `prefers-color-scheme` for color. Express states with StyleX conditional values, never descendant
  selectors.
- Product surfaces have no scroll-entrance choreography. They use the spring presets in
  `packages/web-ui/src/motion/`, and motion only communicates state. New keyframes MUST be
  module-level constants.

## 3. Anti-template checklist (any single hit means rework)

Layout:

- Centered hero with a pill badge above the H1
- Three equal-width "icon on top" feature cards; a 1-2-3 numbered step rail; a stat-number banner
- Copying the hero -> features -> testimonials -> pricing -> FAQ skeleton
- A whole page of vertically centered stacks: at least one composition MUST be asymmetric, span
  columns, or break the grid

Components:

- One universal `radius-lg` + `shadow-lg` + generous-padding card wrapping everything
- Colored left-border cards; check icons on pale circular backgrounds; five-star rating rows;
  gradient "Most popular" pricing pills
- Emoji standing in for icons. Reuse the existing icon system of the current product surface.
- Large colored glows or colored box-shadows; decorative gradients that carry no information

Copy (English source strings, always through lingui macros -- see the i18n-lingui rule):

- No Empower / Unlock / Transform / Supercharge / Seamless openers
- No headline built from two abstract nouns, and no "Built for modern teams" filler that points at
  nothing concrete
- Every screen carries at least one concrete number or concrete noun. Claims MUST NOT exceed the
  support level recorded in `docs/protocols/`; `pnpm run protocols:source-map` enforces this

## 4. Console page skeleton (apps/console)

Every console page composes the shared skeleton from `@xid-kit/web-ui/ui` instead of hand-rolled
header/section styles (the per-app `control-plane.styles` module is deleted):

- `ConsolePage` (title + lead) owns the page frame; feedback goes through `ConsolePageNotice`,
  content through `ConsolePageSection` (single column) and `ConsolePageSplitSection` (5/7
  title+description left, controls right) -- every create/edit form uses the split section.
- Mutation failures render a fixed localized string in `ConsolePageNotice`; the raw
  `error.message` never reaches the page. Query failures are a fixed-copy `Alert`. Success
  feedback is a temporary section-top `Alert`.
- Destructive actions always go through `ConfirmDialog` (`@xid-kit/web-ui/ConfirmDialog`,
  default danger variant), never `window.confirm`.
- Tables use `DataTable` with `isLoading` for pending state. Row-click implicit selection MUST
  pair `onRowClick` with `isRowSelected` and surface the current target in the editing section's
  `meta` via `consoleShell.selectorSummary`.
- Status/pill labels and tones come from `@xid-kit/web-ui/enum-labels` hooks; never map enum
  values to copy by hand.

## 5. Pre-delivery self-check

1. Walk section 3 item by item. Two or more hits means rework, without asking.
2. Delete every decoration that cannot answer "why does this exist". Read the English source copy
   out loud; if it does not sound like a person wrote it, rewrite it.
3. Verify both light and dark. New copy goes through lingui extract -> translate -> compile (see
   the lingui-i18n skill).
4. Gates: `pnpm run check` (it already runs `i18n:audit` and `protocols:source-map`) and
   `pnpm test`. Use `pnpm exec vp check --fix` to auto-fix format and lint. If you touched public
   documentation claims, also run `pnpm run seo:audit`.
