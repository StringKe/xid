// i18n runtime helpers for @xid-kit/solid.
// SolidJS has no @lingui/solid binding, so we use @lingui/core directly.
// Components call i18n._() with a descriptor object to get translated strings.
// The same message catalog and IDs as @xid-kit/react are reused.

import { i18n } from '@lingui/core'

type RuntimeMessage = {
  readonly id: string
  readonly message: string
}

// Shared catalog IDs mirror @xid-kit/react sdkMessages exactly so that the same
// .po catalog (packages/i18n/locales/) covers both packages.
export const sdkMessages = {
  signIn: { id: 'sdk.signIn', message: 'Sign in' },
  signOut: { id: 'sdk.signOut', message: 'Sign out' },
} as const satisfies Record<string, RuntimeMessage>

// Translate a descriptor using the shared lingui i18n instance.
// Falls back to the English message string if no catalog is activated.
export function t(descriptor: RuntimeMessage): string {
  return i18n._(descriptor)
}
