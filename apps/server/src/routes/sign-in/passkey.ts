// passkey 工具:base64url 编解码 + assertion 序列化(用于 /auth/passkey/verify 请求体)。
// 密码学验证在 server 侧(四验证,见 webauthn rule);此处仅做格式编解码(crypto-boundary:格式编解码自研)。

// base64url -> Uint8Array(challenge 解码)。
export function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let idx = 0; idx < binary.length; idx++) bytes[idx] = binary.charCodeAt(idx)
  return bytes
}

// ArrayBuffer -> base64url(rawId/clientDataJSON/authenticatorData/signature 编码)。
export function bufferToB64url(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replaceAll('=', '')
}

// /auth/passkey/verify 请求体(server 据此做四验证)。
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

// /auth/passkey/register/options 响应体 -> 浏览器 navigator.credentials.create 入参。
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

// 把浏览器返回的 attestation 序列化为 register/verify 请求体。
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

// 把浏览器返回的 assertion 序列化为 verify 请求体。
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
