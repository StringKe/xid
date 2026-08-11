// signOut 成功才 redirect；isPending 防重入。

import { defineComponent, h, ref } from 'vue'

import { i18n } from '@lingui/core'

import { useXidClient } from '../plugin'

// library 包不用 msg macro，避免依赖 babel 转换；/*i18n*/ 供 extract 识别。
const signOutMessage = /*i18n*/ {
  id: 'sdk.signOut',
  message: 'Sign out',
}

export type SignOutButtonProps = {
  redirectUrl?: string
  // 指定浏览器会话；省略则签出当前活跃 session。
  sessionId?: string
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
