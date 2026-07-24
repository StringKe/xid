---
type: skills
name: lingui-i18n
description: lingui 全套 i18n 工作流(setup / extract / translate / compile / 加新 locale),含可执行脚本与 ICU 示例
when_to_use: 新增或修改 UI 文案、加新语言、初始化 lingui、catalog 不同步、CI i18n 校验失败时
allowed_tools: [Read, Edit, Write, Bash, Glob, Grep]
metadata:
  category: i18n
  stack: lingui
---

# lingui i18n 工作流

XID 多语言统一用 lingui,覆盖 React Router Hosted UI + admin + React SDK + Workers API 错误。常驻编码约定见 `i18n-lingui` rule;本 skill 是操作流程。邮件模板不在此范围(用 Mustache + R2,见 07 章)。

## 1. 初始化(仅首次)

```bash
pnpm add @lingui/core @lingui/react
pnpm add -D @lingui/cli @lingui/conf @lingui/vite-plugin @lingui/babel-plugin-lingui-macro
```

在仓库根写 `lingui.config.ts`(见 `i18n-lingui` rule 的配置块)。catalog 路径 `packages/i18n/locales/{locale}/messages`,format `po`,sourceLocale `en`。

Vite(React Router / Vite SPA)启用 macro 与 .po 导入:`@lingui/vite-plugin` 加进 `vite.config.ts` 的 plugins,并配 babel/swc macro 插件。

## 2. 写文案

按 `i18n-lingui` rule 的编码约定:JSX 用 `<Trans>`,命令式用 `t`,复数用 `plural`,惰性消息用 `msg`。不要手写 id。ICU 用法见 `references/icu-examples.md`。catalog 命名与目录见 `references/catalog-conventions.md`。

## 3. 抽取消息

```bash
bash .stdai/standards/skills/lingui-i18n/scripts/extract.sh
```

等价 `lingui extract`。把源码里的 macro 消息抽到各 locale 的 `.po`。新消息在 sourceLocale 自动填,其他 locale 留空待翻译。检查输出的 `Missing` / `Total` 计数。

## 4. 翻译

编辑 `packages/i18n/locales/<locale>/messages.po`,填 `msgstr`。保留 ICU 占位符(`{name}` / `{count, plural, ...}`)不可改。机翻占位可接受,但 sourceLocale(en)必须人审。

## 5. 编译

```bash
bash .stdai/standards/skills/lingui-i18n/scripts/compile.sh
```

等价 `lingui compile`。把 `.po` 编译成运行时 import 的产物(`messages.mjs` / `.ts`)。**运行时 import 的是 compile 产物,不是 .po**。compile 产物随提交保持 fresh。

## 6. 加新 locale

1. 在 `lingui.config.ts` 的 `locales` 数组加 BCP 47 标签(如 `it`、`zh-Hant`)。
2. 跑 extract(自动建新 locale 目录与空 .po)。
3. 翻译 .po。
4. compile。
5. 在 Hosted UI / SDK 的语言切换器与 `user.locale` 允许值里登记。

## 7. CI 校验

```bash
lingui extract --fail-on-warning    # 有未提取消息则失败
lingui compile --strict             # 有未翻译消息则失败(按需开启)
```

PR 前确保:无未提取消息、compile 产物与源码同步(git diff 干净)。

## 检查清单

- [ ] 无硬编码 UI 文案(grep 检查可见字符串)
- [ ] 新增文案已 extract,各 locale .po 含对应条目
- [ ] ICU 占位符在所有 locale 一致
- [ ] compile 产物已更新并提交
- [ ] 新 locale 已在 config + 语言切换器登记
- [ ] locale 检测优先级符合 07 章(`?locale=` -> user.locale -> Accept-Language -> 租户默认 -> en)
