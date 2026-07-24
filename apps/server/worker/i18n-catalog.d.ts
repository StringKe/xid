// lingui compile 产物(@xid-kit/i18n/locales/{locale}/messages.mjs)无随包 .d.ts。
// 这里为这些 catalog 子路径声明模块形状,避免 import 时 TS7016 implicit any。
// 形状对应 lingui compile 输出(compileNamespace: 'es'):export const messages = {...}。
declare module '@xid-kit/i18n/locales/*/messages.mjs' {
  export const messages: Record<string, string | string[]>
}
