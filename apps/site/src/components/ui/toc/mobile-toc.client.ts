// 移动端 TOC：select 与页面双向同步；阅读带 [10%, 30%]；点击滚动时短暂 suppress 观察以免闪烁。
import { mount } from '@cloudflare/nimbus-docs/client'

const BAND_TOP = 0.1
const ROOT_MARGIN = '-10% 0px -70% 0px'
const SUPPRESS_MS = 1000

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function initMobileToc(root: HTMLElement): () => void {
  const candidate = root.querySelector('[data-nb-mobile-toc-select]')
  if (!(candidate instanceof HTMLSelectElement)) return () => {}
  const select = candidate

  type Heading = { slug: string; el: HTMLElement }
  const headings: Heading[] = Array.from(select.options)
    .map((o) => o.value)
    .filter((v) => v !== '_top')
    .map((slug) => ({ slug, el: document.getElementById(slug) }))
    .filter((h): h is Heading => h.el !== null)

  const controller = new AbortController()

  // 点击跳转滚动期间忽略 observer，避免 select 值回跳。
  let suppress = false
  let suppressTimer: ReturnType<typeof setTimeout> | undefined

  function setActive(slug: string) {
    if (select.value !== slug) select.value = slug
  }

  select.addEventListener(
    'change',
    () => {
      const slug = select.value
      suppress = true
      clearTimeout(suppressTimer)
      suppressTimer = setTimeout(() => {
        suppress = false
      }, SUPPRESS_MS)

      const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
      if (slug === '_top') {
        window.scrollTo({ top: 0, behavior })
        return
      }
      document.getElementById(slug)?.scrollIntoView({ behavior })
    },
    { signal: controller.signal },
  )

  if (headings.length === 0) {
    return () => {
      controller.abort()
      clearTimeout(suppressTimer)
    }
  }

  // 带内多标题时取文档序最前；带外按首尾位置夹到 _top/末项，中间段保持现值。
  const inBand = new Set<number>()

  function resolve() {
    if (suppress) return

    if (inBand.size > 0) {
      setActive(headings[Math.min(...inBand)].slug)
      return
    }

    const bandTop = window.innerHeight * BAND_TOP
    const firstTop = headings[0].el.getBoundingClientRect().top
    const lastTop = headings[headings.length - 1].el.getBoundingClientRect().top
    if (firstTop > bandTop) {
      setActive('_top')
    } else if (lastTop < bandTop) {
      setActive(headings[headings.length - 1].slug)
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const i = headings.findIndex((h) => h.el === entry.target)
        if (i === -1) continue
        if (entry.isIntersecting) inBand.add(i)
        else inBand.delete(i)
      }
      resolve()
    },
    { rootMargin: ROOT_MARGIN, threshold: 0 },
  )

  for (const { el } of headings) observer.observe(el)
  // observer 首回调前先同步一次。
  resolve()

  return () => {
    controller.abort()
    observer.disconnect()
    clearTimeout(suppressTimer)
  }
}

mount('[data-nb-mobile-toc]', initMobileToc)
