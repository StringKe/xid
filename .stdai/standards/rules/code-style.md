---
type: rules
name: code-style
description: 通用 TS 代码质量基线:文件/函数大小、命名、类型安全(禁 any/enum,统一 type)、named export、Workers 运行时约束
priority: high
applyTo:
  - '**/*.ts'
  - '**/*.tsx'
targets: [claude-code, codex]
---

# 代码风格与质量基线

适用全仓库 TS/TSX。机器可检的项由根 `vite.config.ts` 的 Oxlint 强制(阈值见下),本 rule 是判断类约定 + 阈值说明。

## 大小与复杂度(Oxlint 强制 + 判断)

- 单文件 soft 300 行(超 Oxlint warn):一个文件一个主导出概念,超了按主题拆。
- 函数 <= 50 行;圈复杂度 <= 10;嵌套 <= 3 层 -> 用 early return / guard clause 拍平。
- 参数 <= 4;超过用 options 对象;**禁 boolean 位置参数**当行为开关(`doThing(true)` 不可读)-> options 对象或拆两个函数。

## 命名

- 文件:kebab-case(`tenant-context.ts`);React 组件文件可 PascalCase(随生态)。
- type / class / 组件:PascalCase。
- 函数 / 变量:camelCase。
- 模块级真常量:SCREAMING_SNAKE_CASE(`const MAX_PASSKEYS = 10`);局部 const 用 camelCase。
- 布尔:`is/has/should/can` 前缀(`isVerified`、`hasMfa`)。
- 避免缩写(除通用 `id/url/db/jwt/api`);不用单字母(除迭代器 i/x)。

## 类型(统一 type,禁 any/enum)

- **禁 `any`**:用 `unknown` + 类型收窄(typeof / in / 判别字段);第三方无类型用局部 `type` 或 `declare`。
- **禁 `enum`**:用 `as const` 对象 + union:
  ```ts
  const Role = { Admin: 'admin', Member: 'member' } as const
  type Role = (typeof Role)[keyof typeof Role]
  ```
- **统一用 `type` 别名**:对象 / union / 交叉都用 `type`,不用 `interface`(风格统一)。
- 公共导出函数显式写返回类型(内部局部可推断)。
- 不可变优先:`readonly` 字段、`ReadonlyArray`、`as const` 字面量。
- 边界数据用 `satisfies` 校验字面量符合类型且保留窄类型。

## 模块与导出

- **named export 优先**;`default` 仅在框架要求处(React 路由组件、Workers entry `export default`、vite config)。
- 禁循环依赖;一个文件聚焦一个职责。
- import 顺序与格式由 Oxfmt/Oxlint 管,不手动纠结。
- barrel(`index.ts` re-export)仅用于包对外入口,不在包内层层 barrel(伤 tree-shaking)。

## 控制流与注释

- early return 消除 else 嵌套;失败前置校验(guard clause)。
- 注释解释"为什么"(权衡、非显然约束),不解释"是什么"(代码自明)。
- 不为不存在的场景写注释 / 错误处理 / 兼容 shim;不给未改动代码补注释。
- TODO 带责任人或 issue 链接,不留裸 TODO。

## Workers 运行时约束

- Web 标准 API 优先(`fetch` / `Request` / `crypto.subtle` / `URL`);Node API 仅在 `nodejs_compat` 明确场景(见 crypto-boundary rule)。
- 关注 bundle 体积与冷启动:避免大依赖,能用平台原生就不引库(见 00 章自研边界)。

## Oxlint 强制阈值(根 vite.config.ts)

`max-lines` 300 / `max-lines-per-function` 50 / `complexity` 10 / `max-params` 4 / `max-depth` 3 / `no-explicit-any` error / `no-floating-promises` error。改阈值改根 `vite.config.ts` 的 `lint.rules`。
