// 四验证在 server;此处仅 base64url 与 assertion 序列化。
export function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let idx = 0; idx < binary.length; idx++) bytes[idx] = binary.charCodeAt(idx)
  return bytes
}

export function bufferToB64url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replaceAll('=', '')
}

export type PasskeyVerifyBody = {
  sessionId: string
  id: string
  rawId: string
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle: string | null
  }
  type: string
}

export type PasskeyRegistrationOptions = {
  challenge: string
  rp: PublicKeyCredentialRpEntity
  user: {
    id: string
    name: string
    displayName: string
  }
  pubKeyCredParams: PublicKeyCredentialParameters[]
  authenticatorSelection?: AuthenticatorSelectionCriteria
  attestation?: AttestationConveyancePreference
  timeout?: number
  excludeCredentials?: Array<{
    id: string
    type: PublicKeyCredentialType
    transports?: AuthenticatorTransport[]
  }>
}

export type PasskeyRegistrationVerifyBody = {
  id: string
  rawId: string
  response: {
    clientDataJSON: string
    attestationObject: string
  }
  transports?: AuthenticatorTransport[]
  deviceName?: string
}

export function registrationOptionsToPublicKey(
  options: PasskeyRegistrationOptions,
): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: b64urlToBytes(options.challenge),
    user: {
      ...options.user,
      id: b64urlToBytes(options.user.id),
    },
    excludeCredentials: options.excludeCredentials?.map((credential) => ({
      ...credential,
      id: b64urlToBytes(credential.id),
    })),
  }
}

export function serializeRegistration(
  credential: PublicKeyCredential,
  deviceName?: string,
): PasskeyRegistrationVerifyBody {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      attestationObject: bufferToB64url(response.attestationObject),
    },
    transports: response.getTransports?.() as AuthenticatorTransport[] | undefined,
    ...(deviceName ? { deviceName } : {}),
  }
}

export function serializeAssertion(
  credential: PublicKeyCredential,
  sessionId: string,
): PasskeyVerifyBody {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    sessionId,
    id: credential.id,
    rawId: bufferToB64url(credential.rawId),
    response: {
      clientDataJSON: bufferToB64url(response.clientDataJSON),
      authenticatorData: bufferToB64url(response.authenticatorData),
      signature: bufferToB64url(response.signature),
      userHandle: response.userHandle ? bufferToB64url(response.userHandle) : null,
    },
    type: credential.type,
  }
}
