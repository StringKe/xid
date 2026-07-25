---
type: rules
name: code-style
description: 'TypeScript quality baseline: file and function size limits, naming, type safety (no any, no enum, type over interface), named exports, Workers runtime constraints'
priority: high
applyTo:
  - '**/*.ts'
  - '**/*.tsx'
targets: [claude-code]
---

# Code Style and Quality Baseline

Applies to every TS/TSX file. Only a small subset is machine-enforced, so a green lint run is NOT
proof a file is in budget.

## Size and complexity (review-enforced)

- Soft limit 300 lines per file: one file, one primary exported concept.
- Functions <= 50 lines, cyclomatic complexity <= 10, nesting <= 3 -- flatten with early returns.
- Parameters <= 4 (Oxlint warns past 4); beyond that use an options object. **Never use a positional
  boolean** as a behavior switch -- options object or two functions.

## Hard bans

- **No `any`** -- use `unknown` plus narrowing. Oxlint enforces this as an error.
- **No `enum`** -- use an `as const` object plus a union type.
- **Prefer `type` over `interface`**; the only accepted `interface` use is declaration merging.
- **Prefer named exports**; `default` only where a framework requires it.
- Comments explain **why**, never **what**. No bare TODOs.
- Prefer web standard APIs; Node APIs only under the explicit `nodejs_compat` cases.

Naming per symbol kind, full type rules and the exact `interface` exception, module and barrel rules,
comment rules, `tsconfig.base.json` strict flags, Workers runtime constraints, and which lint rules
are actually enforced: reference `code-style-details`.
