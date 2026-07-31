// SignOutButton: unstyled sign-out trigger button (Vue port of @clerk/vue SignOutButton).
// Checks the signOut Result before redirecting. Prevents re-entry while signing out.

import { defineComponent, h, ref } from 'vue'

import { i18n } from '@lingui/core'

import { useXidClient } from '../plugin'

// lingui runtime descriptor for i18n._(descriptor) rendering.
const signOutMessage = /*i18n*/ {
  id: 'sdk.signOut',
  message: 'Sign out',
}

export type SignOutButtonProps = {
  // Redirect target URL after sign-out.
  redirectUrl?: string
  // Target a browser-held session; omit to sign out the current active session.
  sessionId?: string
  // Accessibility label.
  ariaLabel?: string
}

export const SignOutButton = defineComponent({
  name: 'SignOutButton',

  props: {
    redirectUrl: {
      type: String,
      default: undefined,
    },
    sessionId: {
      type: String,
      default: undefined,
    },
    ariaLabel: {
      type: String,
      default: undefined,
    },
  },

  setup(props, { slots }) {
    const client = useXidClient()
    const isPending = ref(false)

    async function handleClick(): Promise<void> {
      if (isPending.value) return
      isPending.value = true
      try {
        const result = await client.signOut({
          ...(props.sessionId ? { sessionId: props.sessionId } : {}),
        })
        if (result.ok && props.redirectUrl) {
          window.location.assign(props.redirectUrl)
        }
      } finally {
        isPending.value = false
      }
    }

    return () =>
      h(
        'button',
        {
          type: 'button',
          onClick: handleClick,
          disabled: isPending.value,
          'aria-label': props.ariaLabel,
        },
        slots.default ? slots.default() : i18n._(signOutMessage),
      )
  },
})
