// Safari 在 list-style:none 时剥离列表语义；补 role=list 让 VoiceOver 再报项数。
import { mount } from '@cloudflare/nimbus-docs/client'

function initSteps(root: HTMLElement): () => void {
  const lists = root.querySelectorAll<HTMLOListElement>('ol')
  if (
    import.meta.env.DEV &&
    lists.length === 0 &&
    root.querySelector('[data-step]') === null &&
    root.children.length > 0
  ) {
    console.warn(
      '[nimbus] <Steps> expects an ordered list (`1.` items) or <Step> ' +
        'children. A bullet list renders with no numbers or connectors — ' +
        'use an ordered list.',
    )
  }
  lists.forEach((ol) => ol.setAttribute('role', 'list'))

  return () => {
    lists.forEach((ol) => ol.removeAttribute('role'))
  }
}

mount('[data-steps]', initSteps)
