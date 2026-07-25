export const SAML_POST_PAGE = `<!doctype html>
<html>
  <body>
    <script>
      void (async () => {
        const response = await fetch('/saml-post-payload', { cache: 'no-store' })
        if (!response.ok) {
          document.body.textContent = 'SAML response unavailable'
          return
        }

        const payload = await response.json()
        const form = document.createElement('form')
        form.method = 'post'
        form.action = payload.acsUrl

        const addHiddenInput = (name, value) => {
          const input = document.createElement('input')
          input.type = 'hidden'
          input.name = name
          input.value = value
          form.append(input)
        }

        addHiddenInput('SAMLResponse', payload.samlResponse)
        if (payload.relayState !== null) addHiddenInput('RelayState', payload.relayState)
        document.body.append(form)
        form.submit()
      })()
    </script>
  </body>
</html>`

export function createSamlPostPayload({ acsUrl, expectedAcsUrl, samlResponse, relayState }) {
  if (acsUrl !== expectedAcsUrl) return null
  return { acsUrl: expectedAcsUrl, samlResponse, relayState }
}
