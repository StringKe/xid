export function escapeHtmlAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function buildSamlPostForm({ acsUrl, samlResponse, relayState }) {
  const relayInput =
    relayState === null
      ? ''
      : `<input type="hidden" name="RelayState" value="${escapeHtmlAttribute(relayState)}">`
  return [
    '<!doctype html><html><body>',
    `<form method="post" action="${escapeHtmlAttribute(acsUrl)}">`,
    `<input type="hidden" name="SAMLResponse" value="${escapeHtmlAttribute(samlResponse)}">`,
    relayInput,
    '</form>',
    '<script>document.forms[0].submit()</script>',
    '</body></html>',
  ].join('')
}
