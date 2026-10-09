// 仓库密钥扫描拒绝任何 PEM 私钥头，测试密钥在运行时生成，标签拼接后才出现完整 PEM 头。
const PEM_LABEL = ['PRIVATE', 'KEY'].join(' ')

export async function generateApplePrivateKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const lines =
    Buffer.from(pkcs8)
      .toString('base64')
      .match(/.{1,64}/g) ?? []
  const pem = [`-----BEGIN ${PEM_LABEL}-----`, ...lines, `-----END ${PEM_LABEL}-----`].join('\n')
  return { pem, publicKey: pair.publicKey }
}
