# lingui catalog 约定

## 目录结构(monorepo 单 catalog)

```
packages/i18n/
├── lingui.config.ts            # 也可放仓库根
└── locales/
    ├── en/messages.po          # sourceLocale,extract 自动填 msgid=msgstr
    ├── en/messages.mjs         # compile 产物(运行时 import)
    ├── zh-Hans/messages.po
    ├── zh-Hans/messages.mjs
    ├── ja/messages.po
    └── ...
```

- `.po` 是源(人编辑 + git 提交),`.mjs`/`.ts` 是 compile 产物(也提交,保持 fresh)。
- 运行时 **import compile 产物**,绝不 import `.po`。

## locale 标签(BCP 47)

| 用        | 不用                      |
| --------- | ------------------------- |
| `zh-Hans` | `zh-CN` / `zh`            |
| `zh-Hant` | `zh-TW`                   |
| `pt-BR`   | `pt`                      |
| `en`      | `en-US`(除非要区分 en-GB) |

`lingui.config.ts` 的 `locales` 与 `user.locale` 允许值、语言切换器三处必须一致。

## msgid 生成

- 不手写 `id`,extract 按"源文本 + context"自动生成 hash id。
- 同一英文需不同译文时用 context 消歧:`msg({ message: "Open", context: "verb" })` 与 `msg({ message: "Open", context: "adjective" })`。
- 改源文本会变 id(旧译文标记 obsolete),这是预期行为;大改文案前考虑是否保留 context。

## 翻译占位符规则

- ICU 占位符 `{name}` / `{count, plural, ...}` 在所有 locale **必须保持一致**,只译文字部分。
- 不要在 msgstr 里增删占位符,否则运行时 MessageFormat 报错。
- 复数类别按目标语言规则填(如 en 只有 one/other,而 ru 有 one/few/many/other,ja 只有 other)。

## 分包边界

- catalog 全仓库共用一份(`include: ["apps", "packages"]`),避免每包重复 setup。
- 若 SDK 包(`@xid-kit/react`)要独立发布带自己的译文,可单独建 catalog,但首版统一一份。
