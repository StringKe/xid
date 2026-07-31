import { AppError } from '../lib/errors'

export type SamlQueryParameter = {
  value: string
  wireValue: string
}

type SamlBindingParameterName =
  | 'SAMLRequest'
  | 'SAMLResponse'
  | 'RelayState'
  | 'relay_state'
  | 'Signature'
  | 'SigAlg'

function malformedRequest(): never {
  throw new AppError('malformed_request', { httpStatus: 400 })
}

export function readUniqueSamlQueryParameter(
  requestUrl: string,
  name: SamlBindingParameterName,
): SamlQueryParameter | undefined {
  const url = new URL(requestUrl)
  const values = url.searchParams.getAll(name)
  if (values.length > 1) malformedRequest()
  if (values.length === 0) return undefined

  const wireValues: string[] = []
  for (const segment of url.search.slice(1).split('&')) {
    const separator = segment.indexOf('=')
    const wireName = separator === -1 ? segment : segment.slice(0, separator)
    if (wireName !== name) continue
    wireValues.push(separator === -1 ? '' : segment.slice(separator + 1))
  }
  // Encoded parameter names are not the SAML binding's exact wire grammar.
  if (wireValues.length !== 1) malformedRequest()
  return { value: values[0]!, wireValue: wireValues[0]! }
}

export function readUniqueSamlFormField(
  form: FormData,
  name: 'SAMLRequest' | 'SAMLResponse' | 'RelayState',
): FormDataEntryValue | undefined {
  const values = form.getAll(name)
  if (values.length > 1) malformedRequest()
  return values[0]
}
