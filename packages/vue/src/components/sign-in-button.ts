// 用 defineComponent + render，避免 library 包引入 .vue SFC 工具链。

import { defineComponent, h } from 'vue'

import { i18n } from '@lingui/core'

// library 包不用 msg macro，避免依赖 babel 转换；/*i18n*/ 供 extract 识别。
const signInMessage = /*i18n*/ {
  id: 'sdk.signIn',
  message: 'Sign in',
}

export type SignInButtonProps = {
  signInUrl?: string
  redirectUrl?: string
  ariaLabel?: string
}

export const SignInButton = defineComponent({
  name: 'SignInButton',

  props: {
    signInUrl: {
      type: String,
      default: '/sign-in',
    },
    redirectUrl: {
      type: String,
      default: undefined,
    },
    ariaLabel: {
      type: String,
      default: undefined,
    },
  },

  setup(props, { slots }) {
    function handleClick(): void {
      const base = props.signInUrl ?? '/sign-in'
      const target = props.redirectUrl
        ? `${base}?redirect_url=${encodeURIComponent(props.redirectUrl)}`
        : base
      window.location.assign(target)
    }

    return () =>
      h(
        'button',
        {
          type: 'button',
          onClick: handleClick,
          'aria-label': props.ariaLabel,
        },
        slots.default ? slots.default() : i18n._(signInMessage),
      )
  },
})
