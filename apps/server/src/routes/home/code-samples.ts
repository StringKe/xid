// landing 字面代码样本(类型化 token,供 CodePanel 手工着色)。
// 真实 SDK 调用与协议报文,不是伪代码;代码文本不本地化(标识符/协议语法)。

import type { CodeLine, Token } from './CodePanel'

const k = (text: string): Token => ({ text, kind: 'keyword' })
const s = (text: string): Token => ({ text, kind: 'string' })
const f = (text: string): Token => ({ text, kind: 'fn' })
const p = (text: string): Token => ({ text, kind: 'punctuation' })
const pr = (text: string): Token => ({ text, kind: 'property' })
const c = (text: string): Token => ({ text, kind: 'comment' })
const ok = (text: string): Token => ({ text, kind: 'ok' })
const x = (text: string): Token => ({ text })

// 集成区:React 托管登录 drop-in。
export const REACT_SAMPLE: readonly CodeLine[] = [
  [
    k('import'),
    x(' { '),
    f('SignIn'),
    x(', '),
    f('useUser'),
    x(' }'),
    k(' from'),
    s(" '@xid-kit/react'"),
  ],
  [],
  [k('export function'), f(' Account'), p('() {')],
  [k('  const'), x(' { user, isSignedIn } '), p('='), f(' useUser'), p('()')],
  [k('  if'), p(' (!'), x('isSignedIn'), p(')')],
  [k('    return'), p(' <'), f('SignIn'), pr(' redirectUrl'), p('='), s('"/app"'), p(' />')],
  [k('  return'), p(' <p>{'), x('user.'), pr('primaryEmailAddress'), p('}</p>')],
  [p('}')],
]

// 集成区:Worker 无网络验证。
export const BACKEND_SAMPLE: readonly CodeLine[] = [
  [k('import'), x(' { '), f('authenticateRequest'), x(' }'), k(' from'), s(" '@xid-kit/backend'")],
  [],
  [c('// signature + expiry checked at the edge')],
  [k('const'), x(' state '), p('='), k(' await'), f(' authenticateRequest'), p('(')],
  [x('  req'), p(', { '), pr('jwtKey'), p(': '), x('env.'), pr('XID_JWKS'), p(' })')],
  [p(')')],
  [k('if'), p(' (!'), x('state.'), pr('isSignedIn'), p(')')],
  [
    k('  return'),
    p(' new '),
    f('Response'),
    p('('),
    s("'401'"),
    p(', { '),
    pr('status'),
    p(': '),
    x('401'),
    p(' })'),
  ],
]

// 集成区:原生 SDK 声明式重定向。
export const NATIVE_SAMPLE: readonly CodeLine[] = [
  [k('import'), x(' { '), f('useSignIn'), x(' }'), k(' from'), s(" '@xid-kit/react-native'")],
  [],
  [c('// issuer + client_id live on XidProvider')],
  [k('const'), x(' { '), f('signIn'), x(' } '), p('='), f(' useSignIn'), p('()')],
  [],
  [
    k('await'),
    f(' signIn'),
    p('({ '),
    pr('redirectUri'),
    p(': '),
    s("'com.acme.app:/callback'"),
    p(' })'),
  ],
]

// 工作原理步进器:request -> issue -> verify 三块面板。
export const HOW_PANELS: readonly (readonly CodeLine[])[] = [
  [
    [p('GET'), f(' /authorize')],
    [pr('  ?client_id'), p('='), x('app_web')],
    [pr('  &code_challenge'), p('='), x('…'), p(' · '), s('S256')],
    [pr('  &scope'), p('='), s('openid profile email')],
    [c('// passkey conditional UI, no layout shift')],
    [ok('← 302 · code issued')],
  ],
  [
    [p('{')],
    [pr('  "iss"'), p(': '), s('"https://xid.dev"'), p(',')],
    [pr('  "sub"'), p(': '), s('"usr_8f24"'), p(',')],
    [pr('  "org_id"'), p(': '), s('"org_xk2"'), p(',')],
    [pr('  "exp"'), p(': '), x('now + 60s'), c('  // alg ES256')],
    [p('}')],
  ],
  [
    [k('const'), x(' state '), p('='), k(' await'), f(' authenticateRequest'), p('(')],
    [x('  req'), p(', { '), pr('jwtKey'), p(': '), x('env.'), pr('XID_JWKS'), p(' })')],
    [p(')'), c('  // cached JWKS · no round trip')],
  ],
]

// 复制按钮取纯文本。
export function snippetText(lines: readonly CodeLine[]): string {
  return lines.map((line) => line.map((token) => token.text).join('')).join('\n')
}
