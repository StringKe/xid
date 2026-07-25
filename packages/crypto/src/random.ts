export type RandomValues = (bytes: Uint8Array) => void

function fillWithWebCrypto(bytes: Uint8Array): void {
  crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>)
}

export function randomString(
  length: number,
  alphabet: string,
  randomValues: RandomValues = fillWithWebCrypto,
): string {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('length must be a non-negative safe integer')
  }
  if (alphabet.length < 2 || alphabet.length > 256) {
    throw new RangeError('alphabet length must be between 2 and 256')
  }

  const acceptanceLimit = 256 - (256 % alphabet.length)
  let result = ''
  while (result.length < length) {
    const remaining = length - result.length
    const bytes = new Uint8Array(Math.min(65_536, Math.max(32, remaining)))
    randomValues(bytes)
    for (const byte of bytes) {
      if (byte >= acceptanceLimit) continue
      result += alphabet[byte % alphabet.length]
      if (result.length === length) break
    }
  }
  return result
}
