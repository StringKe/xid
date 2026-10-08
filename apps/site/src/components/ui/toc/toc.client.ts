// 目录 scroll-spy：阅读带内最深的标题为当前项；滚到底时取最后一项；点击后钉住直到用户手动滚动。
import { mount } from '@cloudflare/nimbus-docs/client'

const READING_BAND = 0.25
const BOTTOM_EPSILON = 2
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

function initToc(root: HTMLElement): () => void {
  const links = Array.from(root.querySelectorAll<HTMLElement>('[data-nb-toc-link]'))
  const headings = links.map((link) => document.getElementById(link.dataset.nbSlug ?? ''))
  if (links.length === 0 || headings.every((heading) => heading === null)) return () => {}

  let current = -1
  let pinned: number | null = null

  const setCurrent = (index: number) => {
    if (index === current) return
    links[current]?.removeAttribute('aria-current')
    links[index]?.setAttribute('aria-current', 'true')
    current = index
  }

  const resolve = () => {
    if (pinned !== null) {
      setCurrent(pinned)
      return
    }
    const scroller = document.scrollingElement ?? document.documentElement
    const maxScroll = scroller.scrollHeight - window.innerHeight
    if (maxScroll > BOTTOM_EPSILON && scroller.scrollTop >= maxScroll - BOTTOM_EPSILON) {
      setCurrent(links.length - 1)
      return
    }
    const bandBottom = window.innerHeight * READING_BAND
    let index = 0
    headings.forEach((heading, headingIndex) => {
      if (heading && heading.getBoundingClientRect().top <= bandBottom) index = headingIndex
    })
    setCurrent(index)
  }

  let ticking = false
  const onScroll = () => {
    if (ticking) return
    ticking = true
    requestAnimationFrame(() => {
      ticking = false
      resolve()
    })
  }
  const release = () => {
    pinned = null
  }

  const controller = new AbortController()
  const { signal } = controller
  root.addEventListener(
    'click',
    (event) => {
      const link = (event.target as Element).closest<HTMLElement>('[data-nb-toc-link]')
      if (!link) return
      pinned = links.indexOf(link)
      resolve()
    },
    { signal },
  )
  window.addEventListener('wheel', release, { passive: true, signal })
  window.addEventListener('touchmove', release, { passive: true, signal })
  window.addEventListener(
    'keydown',
    (event) => {
      if (SCROLL_KEYS.has(event.key)) release()
    },
    { signal },
  )
  window.addEventListener('scroll', onScroll, { passive: true, signal })
  window.addEventListener('resize', onScroll, { passive: true, signal })
  resolve()

  return () => controller.abort()
}

mount('[data-nb-toc]', initToc)
