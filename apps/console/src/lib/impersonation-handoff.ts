export type ImpersonationHandoff = {
  action: string
  method: 'POST'
  fields: {
    grantId: string
    secret: string
  }
}

export type ImpersonationStartResponse = {
  handoff: ImpersonationHandoff
  expiresAt: string
}

export type ImpersonationEndResponse = {
  ok: true
  redirectUrl: string
}

const OPAQUE_FIELD = /^[A-Za-z0-9_-]{20,128}$/

function isAllowedHandoffUrl(url: URL): boolean {
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  return (
    (url.protocol === 'https:' || (loopback && url.protocol === 'http:')) &&
    url.pathname === '/auth/impersonation/handoff' &&
    url.search === '' &&
    url.hash === ''
  )
}

export function submitImpersonationHandoff(handoff: ImpersonationHandoff): boolean {
  let target: URL
  try {
    target = new URL(handoff.action)
  } catch {
    return false
  }
  if (
    handoff.method !== 'POST' ||
    !isAllowedHandoffUrl(target) ||
    !OPAQUE_FIELD.test(handoff.fields.grantId) ||
    !OPAQUE_FIELD.test(handoff.fields.secret)
  ) {
    return false
  }

  const form = document.createElement('form')
  form.method = 'POST'
  form.action = target.toString()
  form.referrerPolicy = 'no-referrer'
  form.hidden = true
  for (const [name, value] of Object.entries(handoff.fields)) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  document.body.appendChild(form)
  try {
    form.submit()
  } catch {
    form.remove()
    return false
  }
  form.remove()
  return true
}

export function returnFromImpersonation(
  redirectUrl: string,
  navigate: (url: string) => void = (url) => globalThis.location.assign(url),
): boolean {
  let target: URL
  try {
    target = new URL(redirectUrl)
  } catch {
    return false
  }
  const loopback =
    target.hostname === 'localhost' ||
    target.hostname === '127.0.0.1' ||
    target.hostname === '[::1]'
  if (
    (target.protocol !== 'https:' && !(loopback && target.protocol === 'http:')) ||
    target.pathname !== '/console/platform/users' ||
    target.search !== '' ||
    target.hash !== ''
  ) {
    return false
  }
  navigate(target.toString())
  return true
}
