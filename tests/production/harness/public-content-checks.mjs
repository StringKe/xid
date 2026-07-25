function normalizedContentLines(body) {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

function markdownLinkTargets(lines) {
  const targets = new Set()
  for (const line of lines) {
    const targetStart = line.indexOf('](')
    if (targetStart === -1) continue
    const targetEnd = line.indexOf(')', targetStart + 2)
    if (targetEnd === -1) continue
    targets.add(line.slice(targetStart + 2, targetEnd))
  }
  return targets
}

function hasOriginPath(targets, pathname) {
  for (const target of targets) {
    let url
    try {
      url = new URL(target)
    } catch {
      continue
    }
    if (url.origin !== 'https://xid.dev') continue
    if (url.pathname === pathname || url.pathname.startsWith(`${pathname}/`)) return true
  }
  return false
}

export function llmsOk(body) {
  const lines = normalizedContentLines(body)
  const lineSet = new Set(lines)
  const targets = markdownLinkTargets(lines)
  return (
    lineSet.has('# XID') &&
    targets.has('https://xid.dev/') &&
    targets.has('https://xid.dev/docs') &&
    targets.has('https://xid.dev/sitemap.xml') &&
    targets.has('https://xid.dev/robots.txt') &&
    targets.has('https://xid.dev/llms-full.txt') &&
    lineSet.has(
      '- [WebMCP tools](https://xid.dev/) (Chrome origin trial; read-only public docs tools on marketing and /docs)',
    ) &&
    !hasOriginPath(targets, '/docs/design') &&
    !hasOriginPath(targets, '/console')
  )
}

export function llmsFullOk(body) {
  const lines = normalizedContentLines(body)
  const lineSet = new Set(lines)
  const targets = markdownLinkTargets(lines)
  return (
    lineSet.has('# XID: full public documentation index') &&
    lineSet.has('- Concise index: https://xid.dev/llms.txt') &&
    targets.has('https://xid.dev/docs/oidc-oauth') &&
    targets.has('https://xid.dev/docs/sdks/react') &&
    lineSet.has('- `/docs/oidc` -> `/docs/oidc-oauth`') &&
    !hasOriginPath(targets, '/docs/design')
  )
}
