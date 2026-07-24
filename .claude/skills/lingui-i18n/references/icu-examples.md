# lingui ICU MessageFormat examples

macro imports (lingui v6):

```ts
import { t, plural, select, selectOrdinal, msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
```

These apply to the SPA (`apps/server/src`). The React SDK uses runtime descriptors instead -- see the last section.

## Basics

```tsx
// JSX with interpolation
;<Trans>Welcome back, {firstName}</Trans>

// Imperative (toast / aria-label / alt)
const { t } = useLingui()
const label = t`Sign in with passkey`
```

Worker code has no component context, so it declares lazy messages once and renders them where a request-scoped i18n instance exists. Every `XidErrorCode` already has a descriptor in `packages/i18n/src/messages.ts`:

```ts
// packages/i18n/src/messages.ts
import { msg } from '@lingui/core/macro'

export const errorMessages = {
  validation_failed: msg`Validation failed. Please check your input.`,
  // ...one entry per XidErrorCode
}
```

```ts
// Worker handler: throw the typed error, never a pre-rendered string
import { AppError } from '../lib/errors'

throw new AppError('validation_failed', { meta: { paramName: 'email' } })
```

`apps/server/worker/middleware/error.ts` renders it with the per-request instance: `c.get('i18n')._(errorMessages[code])`.

## Plural

```tsx
// "1 session" / "5 sessions"
;<Trans>{plural(sessionCount, { one: '# session', other: '# sessions' })}</Trans>
```

`#` renders the number itself. Plural categories (one/few/many/other) follow each locale's rules -- do not write `few` or `many` in the `en` source.

## Select

```tsx
<Trans>
  {select(method, {
    passkey: 'Signed in with passkey',
    password: 'Signed in with password',
    sso: 'Signed in via SSO',
    other: 'Signed in',
  })}
</Trans>
```

## Ordinal

```tsx
<Trans>{selectOrdinal(n, { one: '#st', two: '#nd', few: '#rd', other: '#th' })} attempt</Trans>
```

## Nested plural with interpolation

```tsx
<Trans>
  {plural(count, {
    one: '# new login from {city}',
    other: '# new logins from {city}',
  })}
</Trans>
```

## Dates and numbers

For new locale-sensitive formatting prefer lingui's helpers (they wrap `Intl` and follow the active locale):

```ts
const { i18n } = useLingui()
i18n.date(lastActiveAt, { dateStyle: 'medium' })
i18n.number(mauCount)
```

Existing console tables still call `toLocaleDateString()` / `toLocaleString()` directly, which follows the browser locale rather than the activated one. Do not add more of those.

## React SDK: runtime descriptors, not macros

`packages/react` must not import `@lingui/react/macro`. Declare the message and render it through the runtime helpers:

```tsx
// packages/react/src/i18n-runtime.tsx
export const sdkMessages = {
  members: /*i18n*/ { id: 'sdk.members', message: '{count} members' },
} satisfies Record<string, RuntimeMessage>
```

```tsx
import { useLingui } from '@lingui/react'
import { Rt, rt, sdkMessages } from '../../i18n-runtime'

// JSX
;<Rt {...sdkMessages.members} values={{ count }} />

// String (aria-label / alt)
const { _ } = useLingui()
const label = rt(_, sdkMessages.userAvatar)
```

## Anti-patterns (forbidden)

```tsx
// Forbidden: hardcoded copy
<button>Sign in</button>
// Forbidden: string concatenation (breaks plurals and word order)
<span>{count + " devices"}</span>
// Forbidden: hand-written plural branching
{count === 1 ? "1 device" : count + " devices"}
```
