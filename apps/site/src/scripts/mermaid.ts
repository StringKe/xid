import { sanitizeMermaidSvg } from './sanitize-mermaid-svg'

type MermaidLabels = {
  close: string
  error: string
  expand: string
}

let diagrams: HTMLPreElement[] = []
let dialog: HTMLDialogElement | null = null
let mermaidId = 0
let renderPromise: Promise<void> | null = null
let rerenderRequested = false
let labels: MermaidLabels | null = null
let renderer: typeof import('mermaid').default | null = null
let activeDialogDiagram: { label: string; source: string } | null = null

function readLabels(): MermaidLabels {
  const close = document.body.dataset.mermaidCloseLabel
  const error = document.body.dataset.mermaidErrorLabel
  const expand = document.body.dataset.mermaidExpandLabel
  if (!close || !error || !expand) {
    throw new TypeError('Mermaid labels are missing from the Site layout')
  }
  return { close, error, expand }
}

function nextMermaidId(): string {
  mermaidId += 1
  return `xid-mermaid-${mermaidId}`
}

function captureDiagramSource(diagram: HTMLPreElement): string {
  const captured = diagram.dataset.diagram
  if (captured !== undefined) return captured
  const source = diagram.textContent ?? ''
  diagram.dataset.diagram = source
  return source
}

function showRenderError(diagram: HTMLPreElement): void {
  captureDiagramSource(diagram)
  diagram.textContent = labels?.error ?? ''
  diagram.dataset.error = 'true'
  diagram.dataset.processed = 'true'
}

function closeDialog(): void {
  if (!dialog?.open || dialog.classList.contains('closing')) return

  if (globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.close()
    document.documentElement.style.overflow = ''
    activeDialogDiagram = null
    return
  }

  dialog.classList.add('closing')

  let closed = false
  const finish = (): void => {
    if (closed || !dialog) return
    closed = true
    dialog.classList.remove('closing')
    dialog.close()
    document.documentElement.style.overflow = ''
    activeDialogDiagram = null
  }

  dialog.addEventListener('animationend', finish, { once: true })
  globalThis.setTimeout(finish, 250)
}

function getDialog(): HTMLDialogElement {
  if (dialog) return dialog
  if (!labels) throw new TypeError('Mermaid labels are not initialized')

  dialog = document.createElement('dialog')
  dialog.className = 'mermaid-dialog'

  const body = document.createElement('div')
  body.className = 'mermaid-dialog-body'

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'mermaid-dialog-close'
  close.setAttribute('aria-label', labels.close)
  close.innerHTML = [
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"',
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round"',
    ' stroke-linejoin="round" aria-hidden="true">',
    '<line x1="18" y1="6" x2="6" y2="18"></line>',
    '<line x1="6" y1="6" x2="18" y2="18"></line>',
    '</svg>',
  ].join('')

  dialog.appendChild(body)
  dialog.appendChild(close)
  document.body.appendChild(dialog)

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog()
  })
  body.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('a') || target.closest('.clickable')) closeDialog()
  })
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeDialog()
  })
  close.addEventListener('click', closeDialog)

  return dialog
}

function getDiagramLabel(diagram: HTMLPreElement): string {
  const root = diagram.closest('.docs-content') ?? document.body
  let label = ''
  for (const heading of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4')) {
    if ((heading.compareDocumentPosition(diagram) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
      continue
    }
    const clone = heading.cloneNode(true) as HTMLElement
    clone.querySelectorAll('a').forEach((anchor) => anchor.remove())
    const candidate = clone.textContent?.trim()
    if (candidate) label = candidate
  }
  return label || labels?.expand || ''
}

async function renderMermaidSvg(source: string): Promise<string> {
  if (!renderer) throw new TypeError('Mermaid renderer is not initialized')
  const id = nextMermaidId()
  try {
    return (await renderer.render(id, source)).svg
  } catch (error) {
    document.getElementById(`d${id}`)?.remove()
    throw error
  }
}

async function renderActiveDialog(): Promise<void> {
  if (!dialog?.open || !activeDialogDiagram) return
  const body = dialog.querySelector('.mermaid-dialog-body')
  if (!body) return

  const expanded = document.createElement('pre')
  expanded.className = 'mermaid'
  expanded.dataset.diagram = activeDialogDiagram.source
  expanded.textContent = activeDialogDiagram.source

  const container = document.createElement('div')
  container.className = 'mermaid-container'
  container.appendChild(expanded)
  body.replaceChildren(container)

  try {
    expanded.replaceChildren(sanitizeMermaidSvg(await renderMermaidSvg(activeDialogDiagram.source)))
    expanded.dataset.processed = 'true'
  } catch (error) {
    showRenderError(expanded)
    console.error('Mermaid dialog render failed', error)
  }
}

async function openDiagram(diagram: HTMLPreElement): Promise<void> {
  const targetDialog = getDialog()
  activeDialogDiagram = {
    label: getDiagramLabel(diagram),
    source: captureDiagramSource(diagram),
  }
  targetDialog.setAttribute('aria-label', activeDialogDiagram.label)

  document.documentElement.style.overflow = 'hidden'
  if (!targetDialog.open) targetDialog.showModal()
  await renderActiveDialog()
}

function getFontFamily(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--nb-font-sans').trim()
  return value || 'system-ui, sans-serif'
}

export function isMermaidSupportedColor(value: string): boolean {
  return (
    /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(value) ||
    /^rgba?\(\s*\d+(?:\.\d+)?%?\s*,\s*\d+(?:\.\d+)?%?\s*,\s*\d+(?:\.\d+)?%?(?:\s*,\s*(?:0|1|0?\.\d+|\d+(?:\.\d+)?%))?\s*\)$/iu.test(
      value,
    ) ||
    /^hsla?\(\s*-?\d+(?:\.\d+)?(?:deg|rad|turn)?\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%(?:\s*,\s*(?:0|1|0?\.\d+|\d+(?:\.\d+)?%))?\s*\)$/iu.test(
      value,
    )
  )
}

function getThemeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return isMermaidSupportedColor(value) ? value : fallback
}

function getPageBackground(isDark: boolean): string {
  return getThemeColor('--nb-background', isDark ? '#161616' : '#ffffff')
}

function wrapDiagram(diagram: HTMLPreElement): void {
  if (diagram.parentElement?.classList.contains('mermaid-container')) return
  if (!labels) throw new TypeError('Mermaid labels are not initialized')

  const container = document.createElement('div')
  container.className = 'mermaid-container'
  diagram.parentNode?.insertBefore(container, diagram)
  container.appendChild(diagram)

  const expand = document.createElement('button')
  expand.type = 'button'
  expand.className = 'mermaid-expand'
  expand.setAttribute('aria-label', labels.expand)
  expand.innerHTML = [
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"',
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round"',
    ' stroke-linejoin="round" aria-hidden="true">',
    '<polyline points="15 3 21 3 21 9"></polyline>',
    '<polyline points="9 21 3 21 3 15"></polyline>',
    '<line x1="21" y1="3" x2="14" y2="10"></line>',
    '<line x1="3" y1="21" x2="10" y2="14"></line>',
    '</svg>',
  ].join('')
  expand.addEventListener('click', () => {
    void openDiagram(diagram)
  })
  container.appendChild(expand)
}

async function renderOnce(): Promise<void> {
  diagrams.forEach(captureDiagramSource)

  try {
    ;({ default: renderer } = await import('mermaid'))
  } catch (error) {
    renderer = null
    diagrams.forEach(showRenderError)
    console.error('Mermaid load failed', error)
    return
  }

  const isDark = document.documentElement.getAttribute('data-mode') === 'dark'
  const pageBackground = getPageBackground(isDark)
  const accent = getThemeColor('--nb-border-strong', isDark ? '#737373' : '#a3a3a3')
  const foreground = isDark ? '#f5f5f5' : '#262626'
  const surface = isDark ? '#1f1f1f' : '#ffffff'
  const muted = isDark ? '#292929' : '#f5f5f5'

  try {
    renderer.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        fontFamily: getFontFamily(),
        primaryColor: surface,
        primaryBorderColor: accent,
        primaryTextColor: foreground,
        secondaryColor: muted,
        secondaryBorderColor: accent,
        secondaryTextColor: foreground,
        tertiaryColor: muted,
        tertiaryBorderColor: accent,
        tertiaryTextColor: foreground,
        lineColor: accent,
        textColor: foreground,
        mainBkg: surface,
        edgeLabelBackground: pageBackground,
        labelBackground: pageBackground,
        background: pageBackground,
      },
      flowchart: {
        htmlLabels: true,
        useMaxWidth: true,
        curve: 'linear',
      },
    })
  } catch (error) {
    diagrams.forEach(showRenderError)
    console.error('Mermaid initialize failed', error)
    return
  }

  for (const diagram of diagrams) {
    try {
      const source = captureDiagramSource(diagram)
      diagram.replaceChildren(sanitizeMermaidSvg(await renderMermaidSvg(source)))
      delete diagram.dataset.error
      diagram.dataset.processed = 'true'
      wrapDiagram(diagram)
    } catch (error) {
      showRenderError(diagram)
      console.error('Mermaid render failed', error)
    }
  }

  await renderActiveDialog()
}

function requestRender(): void {
  rerenderRequested = true
  if (renderPromise) return

  renderPromise = (async () => {
    while (rerenderRequested) {
      rerenderRequested = false
      await renderOnce()
    }
  })().finally(() => {
    renderPromise = null
    if (rerenderRequested) requestRender()
  })
}

function setup(): void {
  diagrams = Array.from(document.querySelectorAll<HTMLPreElement>('pre.mermaid'))
  if (diagrams.length === 0) return
  labels = readLabels()
  requestRender()
}

const themeObserver = new MutationObserver(() => {
  if (diagrams.length > 0) requestRender()
})

themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-mode'],
})

setup()
