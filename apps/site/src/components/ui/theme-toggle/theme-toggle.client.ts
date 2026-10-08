// 只写 xid.theme；DOM 由 BaseLayout 首帧脚本统一应用，避免闪白和跨标签页漂移。
import { mount } from '@cloudflare/nimbus-docs/client'
import { isThemeMode, persistThemeMode } from '@xid-kit/web-ui/theme-preference'

declare global {
  interface Window {
    __xidApplyTheme?: () => void
  }
}

function initThemeControl(control: HTMLElement): () => void {
  const controller = new AbortController()
  if (control instanceof HTMLSelectElement) {
    control.addEventListener(
      'change',
      () => {
        if (!isThemeMode(control.value)) return
        persistThemeMode(control.value)
        window.__xidApplyTheme?.()
      },
      { signal: controller.signal },
    )
  } else {
    control.addEventListener(
      'click',
      () => {
        persistThemeMode(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
        window.__xidApplyTheme?.()
      },
      { signal: controller.signal },
    )
  }
  window.__xidApplyTheme?.()
  return () => controller.abort()
}

mount('[data-theme-control]', initThemeControl)
