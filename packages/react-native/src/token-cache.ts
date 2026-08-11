// 安全存储 DI 抽象；iOS Keychain / Android EncryptedSharedPreferences，expo 见 createSecureStoreAdapter。

export type TokenCache = {
  /**
   * 同一底层安全存储的 wrapper 必须使用相同值，供 session mutation 协调。
   * 未提供时仅按当前 TokenCache 对象实例协调。
   */
  readonly coordinationNamespace?: string
  getToken(key: string): Promise<string | null>
  saveToken(key: string, value: string): Promise<void>
  deleteToken(key: string): Promise<void>
}
