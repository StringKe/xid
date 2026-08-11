// 无手动 trigger 时从 TabItem 面板合成；有 trigger 则 manual 模式。
import { mount, initTabs } from '@cloudflare/nimbus-docs/client'

const TRIGGER_CLASS =
  'shrink-0 cursor-pointer px-4 py-2 text-sm font-medium leading-6 whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground aria-selected:text-primary focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px]'

let counter = 0

function initTabContainer(container: HTMLElement): () => void {
  const id = `nb-tabs-${counter++}`
  const syncKey = container.dataset.nbSyncKey
  const tablist = container.querySelector<HTMLElement>('[role=tablist]')
  const indicator = container.querySelector<HTMLElement>('[data-nb-tabs-indicator]')

  // 限定本容器，避免嵌套 Tabs 的 trigger/panel 互相干扰。
  const existingTriggers = Array.from(container.querySelectorAll('[data-nb-tabs-trigger]')).filter(
    (t) => (t as HTMLElement).closest('[data-nb-tabs]') === container,
  )
  const synthesize = existingTriggers.length === 0

  if (synthesize && tablist) {
    const panels = Array.from(
      container.querySelectorAll<HTMLElement>('[data-nb-tabs-content]'),
    ).filter((p) => p.closest('[data-nb-tabs]') === container)

    panels.forEach((panel, i) => {
      const label = panel.dataset.nbTabLabel ?? 'Tab'
      const btn = document.createElement('button')
      btn.role = 'tab'
      btn.type = 'button'
      btn.className = TRIGGER_CLASS
      btn.textContent = label
      btn.setAttribute('data-nb-tabs-trigger', '')

      const panelId = `${id}-panel-${i}`
      const tabId = `${id}-tab-${i}`
      btn.id = tabId
      btn.setAttribute('aria-controls', panelId)
      panel.id = panelId
      panel.setAttribute('aria-labelledby', tabId)

      if (indicator) {
        tablist.insertBefore(btn, indicator)
      } else {
        tablist.appendChild(btn)
      }
    })
  }

  const instance = initTabs({
    container,
    tabSelector: '[data-nb-tabs-trigger]',
    panelSelector: '[data-nb-tabs-content]',
    boundarySelector: '[data-nb-tabs]',
    indicator,
    sync: syncKey ? { key: `ui-synced-tabs__${syncKey}` } : undefined,
    // 每次 activate 用 scrollLeft 把 active tab 滚入可视区；勿用 scrollIntoView（会连带滚页面）。
    onActivate: (index) => {
      if (!tablist) return
      const trigger = tablist.querySelectorAll<HTMLElement>('[data-nb-tabs-trigger]')[index]
      if (!trigger) return
      const left = trigger.offsetLeft
      const right = left + trigger.offsetWidth
      if (left < tablist.scrollLeft) {
        tablist.scrollLeft = left
      } else if (right > tablist.scrollLeft + tablist.clientWidth) {
        tablist.scrollLeft = right - tablist.clientWidth
      }
    },
  })

  // 跨实例同步按 label；重复 label 会 first-match 错 panel，dev 下告警。
  if (import.meta.env.DEV && syncKey && tablist) {
    const labels = Array.from(tablist.querySelectorAll<HTMLElement>('[data-nb-tabs-trigger]'))
      .filter((t) => t.closest('[data-nb-tabs]') === container)
      .map((t) => (t.textContent ?? '').trim())
    const dupes = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))]
    if (dupes.length) {
      console.warn(
        `[nimbus] <Tabs syncKey="${syncKey}"> has duplicate tab labels (${dupes
          .map((d) => `"${d}"`)
          .join(', ')}). Sync is keyed by label, so a duplicate activates the ` +
          `first match. Give each tab a unique label.`,
      )
    }
  }

  return () => {
    instance.destroy()
    // 拆掉合成 trigger，避免 remount 重复。
    if (synthesize && tablist) {
      tablist.querySelectorAll('[data-nb-tabs-trigger]').forEach((b) => b.remove())
    }
  }
}

mount('[data-nb-tabs]', initTabContainer)
