// SignInButton:无样式登录触发按钮(对标 @clerk/vue SignInButton 的 Vue 版)。
// 用 defineComponent + render 函数实现,避免 .vue SFC 引入额外工具链依赖。
// 文案走 lingui runtime descriptor(不硬编码 UI 文案)。

import { defineComponent, h } from 'vue'

import { i18n } from '@lingui/core'

// lingui runtime descriptor(id + message),供 i18n._(descriptor) 渲染。
// 不用 msg macro 避免在 library 包需要 babel 转换才能使用。
const signInMessage = /*i18n*/ {
  id: 'sdk.signIn',
  message: 'Sign in',
}

export type SignInButtonProps = {
  // 登录页路径(Hosted UI)
  signInUrl?: string
  // 登录成功后跳转
  redirectUrl?: string
  // a11y
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
