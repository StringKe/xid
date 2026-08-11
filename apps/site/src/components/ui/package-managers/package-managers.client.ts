// sessionStorage 键 ui-pm-tab 与 <nb-pm-restore> 首屏元素共用，避免导航闪烁。
import { mount, initTabs } from '@cloudflare/nimbus-docs/client'

function cloneIcon(tpl: HTMLTemplateElement | null): Node {
  return tpl ? tpl.content.cloneNode(true) : document.createTextNode('')
}

function initPackageManager(container: HTMLElement): () => void {
  const copyTpl = container.querySelector<HTMLTemplateElement>('[data-nb-pm-icon-copy]')
  const checkTpl = container.querySelector<HTMLTemplateElement>('[data-nb-pm-icon-check]')

  const tabs = initTabs({
    container,
    tabSelector: '[data-nb-pm-tab]',
    panelSelector: '[data-nb-pm-panel]',
    rovingTabindex: true,
    sync: { key: 'ui-pm-tab', storage: 'session' },
  })

  const copyHandlers: Array<{ btn: HTMLButtonElement; handler: () => void; timer?: number }> = []

  container.querySelectorAll<HTMLButtonElement>('[data-nb-pm-copy]').forEach((btn) => {
    const handlerInfo: { btn: HTMLButtonElement; handler: () => void; timer?: number } = {
      btn,
      handler: async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.nbCommand ?? '')
        } catch {
          return
        }
        btn.replaceChildren(cloneIcon(checkTpl))
        if (handlerInfo.timer) window.clearTimeout(handlerInfo.timer)
        handlerInfo.timer = window.setTimeout(() => {
          btn.replaceChildren(cloneIcon(copyTpl))
        }, 1500)
      },
    }
    btn.addEventListener('click', handlerInfo.handler)
    copyHandlers.push(handlerInfo)
  })

  return () => {
    tabs.destroy()
    copyHandlers.forEach(({ btn, handler, timer }) => {
      btn.removeEventListener('click', handler)
      if (timer) window.clearTimeout(timer)
    })
  }
}

mount('[data-nb-pm]', initPackageManager)
