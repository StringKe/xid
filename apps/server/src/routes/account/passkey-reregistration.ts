// 自定义域名迁移提示:服务端只知道域名需要重新注册,不知道用户是否已在新域名注册,关闭状态按浏览器记住。

import { useState } from 'react'

function storageKey(): string {
  return `xid.passkey-reregistration-dismissed:${globalThis.location?.host ?? ''}`
}

function readDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(storageKey()) === '1'
  } catch {
    return false
  }
}

function writeDismissed(): void {
  try {
    globalThis.localStorage?.setItem(storageKey(), '1')
  } catch {
    // 存储不可用(隐私模式、站点数据被禁用)时只在本次页面内隐藏。
  }
}

export function usePasskeyReregistrationNotice(required: boolean): {
  visible: boolean
  dismiss: () => void
} {
  const [dismissed, setDismissed] = useState(readDismissed)
  return {
    visible: required && !dismissed,
    dismiss: () => {
      writeDismissed()
      setDismissed(true)
    },
  }
}
