// 只写 localStorage(ui-mode)；DOM 由 BaseLayout 预绘脚本统一应用，避免 FOUC/跨 tab 漂移。
import { mount } from '@cloudflare/nimbus-docs/client'

declare global {
  interface Window {
    __nbApplyTheme?: () => void
  }
}

function initThemeToggle(button: HTMLElement): () => void {
  function handleClick() {
    const isDark = document.documentElement.getAttribute('data-mode') === 'dark'
    try {
      localStorage.setItem('ui-mode', isDark ? 'light' : 'dark')
    } catch {
      // 隐私模式等 storage 失败时仍尝试应用主题。
    }
    window.__nbApplyTheme?.()
  }

  window.__nbApplyTheme?.()
  button.addEventListener('click', handleClick)
  return () => button.removeEventListener('click', handleClick)
}

mount('[data-nb-theme-toggle]', initThemeToggle)
