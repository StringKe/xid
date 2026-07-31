<!-- xid-translation source=docs/sdks/distribution.md source-commit=working-tree source-blob=b8ee0625f83fe679584a5e202e68a77692f3ff73 -->

> 本文是 [`docs/sdks/distribution.md`](../../sdks/distribution.md) 的中文翻译,英文版为准。

# SDK 分发

本文区分"可以构建的 release artifact"与"已经发布到外部 registry 的 artifact"。当前仓库只授权
前者。

## TypeScript package graph

npm release candidate 版本为 `0.1.0-alpha.0`,可发布 graph 包含:

- 公开 SDK:`@xid-kit/core`、`backend`、`react`、`nextjs`、`vue`、`nuxt`、`svelte`、
  `angular`、`remix`、`astro`、`solid`、`react-native`、`expo`、`electron`、`tauri`。
- 公开 runtime kernel:`@xid-kit/types`、`crypto`、`protocol`。

3 个 kernel 被纳入是因为公开 SDK artifact 的 runtime 或类型 surface 会 import 它们。如果这些
import 仍指向 private workspace package,npm release 会无法安装。`@xid-kit/db`、`i18n`、
`saml`、`webauthn`、`web-ui` 仍是 private implementation package,不属于发布 graph。

每个可发布 manifest 都有 `private: false`、MIT license、明确的 `files`、仅指向 dist 的
`main`/`module`/`types` 与 conditional exports,以及 `publishConfig.access: public`。源码
manifest 对内部 release edge 使用 `workspace:^`。`pnpm pack` 将其改写为
`^0.1.0-alpha.0`;packed manifest 若含 `workspace:`、`catalog:` 或依赖 private
`@xid-kit/*` package,gate 会 FAIL。

每个 manifest 还必须带 `https://xid.dev/sdks` 下精确的 canonical documentation homepage。
Source contract 会拒绝 credential、port、query string、fragment、非 HTTPS URL,以及与该
package canonical SDK 页面不一致的 homepage。

## 可重复 release artifact gate

只检查源码 contract:

```bash
pnpm run sdk:distribution:contract
```

执行完整 release artifact gate:

```bash
pnpm run sdk:distribution:verify
# 等价的 root entry
pnpm run pack
```

完整 gate 不发布任何内容,只执行:

1. 用 `vp pack` 构建每个 package,包含全部已记录的 subpath entry。
2. 用 `pnpm pack` 创建 18 个 npm tarball。
3. 审计每个 tarball 的 README、MIT license、canonical homepage、runtime entry、declaration
   entry、声明的 export target、dependency version,并确认没有 source 或 test file 泄漏。
4. 对每个输出 `.mjs` 执行 `node --check`。
5. 在 workspace 外创建多个全新临时 consumer。它们把 `@xid-kit` registry 指向不可达地址,因此
   每个已安装 XID package 都必须来自生成的 tarball。
6. 不使用 `--legacy-peer-deps`,按 npm 正常 peer resolution 安装代表性 dependency closure,并用
   `skipLibCheck: false` 的 TypeScript 实际引用 public type,然后 runtime import
   host-independent entry。18 个 tarball 仍全部构建和审计;需要真实 framework host 的 package
   不会被强行安装到同一个虚构应用中。
7. 验证 browser consumer 使用 `@xid-kit/types` 时不安装 Cloudflare ambient type。另一个 Worker
   fixture 显式安装 `@cloudflare/workers-types`,并从 type-only
   `@xid-kit/types/cloudflare` subpath import `Env`。
8. 验证 React Native 与 Expo graph 在 React 19 上正常解析,并确认 React Native-only fixture
   不安装 `react-dom`。

Source-only contract 还会确保 package version 与 `0.1.0-alpha.0` 对齐,包括 Nuxt runtime 的
`moduleMetadata.version`,避免 framework tooling 报告过期 module version。

Gate 完成后删除临时 artifact。手工检查单个 package:

```bash
pnpm --filter @xid-kit/core build
pnpm --dir packages/core pack --pack-destination /tmp/xid-sdk-packs
npm install /tmp/xid-sdk-packs/xid-kit-core-0.1.0-alpha.0.tgz
```

## 发布边界

Gate PASS 表示本地 tarball 可安装,不表示 npm 上已经存在任何 package。这些脚本不会执行 npm
publish、dist-tag mutation、release tag、registry credential 使用或 provenance attestation。

外部发布仍需明确授权和 release owner,并验证 npm organization、package name availability、
version/dist-tag、credential、provenance setting、release notes 与精确 tarball digest。在此之前,
registry availability 是 `UNKNOWN`,README 中按 package name 安装的命令描述的是未来发布后的
路径。

## Native SDK

`sdk/` 下 13 个 SDK 继续保持 source-only。格式支持时,manifest 已包含 package-format identity、
license、repository、README metadata;`pnpm run native:verify` 会检查这些 metadata,并检查每个
README 是否明确写出 `Registry status: UNPUBLISHED`。

当前不声称已发布到 crates.io、PyPI、Maven Central、RubyGems、Packagist、NuGet、CocoaPods、
Swift Package Registry 或 pub.dev。每个 README 现在提供真实可用的 VCS 或 local-path 安装方式。
实际 registry 发布与 package name ownership 在单独授权并验证前保持 `UNKNOWN`。

已有一个明确 coordinate 冲突:`flutter pub publish --dry-run` 报告 pub.dev 上已经存在名为
`xid`、版本为 `1.2.1` 的 package。本仓库没有建立该 package 的 ownership,所以 Flutter registry
name 在明确 rename 或 ownership 决策前处于 blocked 状态。
