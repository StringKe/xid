# lingui ICU MessageFormat 示例

macro 导入(lingui v6):

```ts
import { t, plural, select, selectOrdinal, msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
```

## 基础

```tsx
// JSX,带插值
;<Trans>Welcome back, {firstName}</Trans>

// 命令式(toast / aria-label / alt)
const { t } = useLingui()
const label = t`Sign in with passkey`

// 纯 .ts / Workers handler:惰性消息 + i18n._
const E_EMAIL_REQUIRED = msg`Email is required`
throw new XidAPIError({ code: 'email_required', message: i18n._(E_EMAIL_REQUIRED) })
```

## 复数(plural)

```tsx
// "1 device" / "5 devices"
;<Trans>{plural(count, { one: '# device', other: '# devices' })}</Trans>

// 命令式
const msg = plural(n, { one: '# active session', other: '# active sessions' })
```

`#` 渲染为数字本身。复数类别(one/few/many/other)按各 locale 规则,不要在 en 里写 few/many。

## 选择(select)

```tsx
// 按枚举值选词
<Trans>
  {select(method, {
    passkey: 'Signed in with passkey',
    password: 'Signed in with password',
    sso: 'Signed in via SSO',
    other: 'Signed in',
  })}
</Trans>
```

## 序数(selectOrdinal)

```tsx
// "1st" / "2nd" / "3rd attempt"
<Trans>{selectOrdinal(n, { one: '#st', two: '#nd', few: '#rd', other: '#th' })} attempt</Trans>
```

## 嵌套(plural + 插值)

```tsx
<Trans>
  {plural(count, {
    one: '# new login from {city}',
    other: '# new logins from {city}',
  })}
</Trans>
```

## 日期 / 数字格式

用 lingui 的 `i18n.date()` / `i18n.number()`(底层 Intl),不要手写 toLocaleString 散落各处:

```ts
const { i18n } = useLingui()
i18n.date(lastActiveAt, { dateStyle: 'medium' })
i18n.number(mauCount)
```

## 反例(禁止)

```tsx
// 禁止:硬编码
<button>Sign in</button>
// 禁止:字符串拼接(无法正确翻译复数/语序)
<span>{count + " devices"}</span>
// 禁止:if/else 手写复数
{count === 1 ? "1 device" : count + " devices"}
```
