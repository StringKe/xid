<!-- xid-translation source=docs/sdks/distribution.md source-commit=working-tree source-blob=92266490e982efe51eba6ae4540dc26eb271dd2c -->

> 本文是 [`docs/sdks/distribution.md`](../../sdks/distribution.md) 的中文翻译,英文版为准。

# SDK 分发

XID 不向 npm 或任何其他 package registry 发布 package。所有 SDK,包括 `packages/` 下的
TypeScript `@xid-kit/*` package 与 `sdk/` 下的 13 个原生 SDK,都以源码形式在 XID 仓库中分发。
应用从仓库 checkout 中使用 SDK:通过 pnpm workspace、vendor 本地构建的 tarball,或使用原生
工具链的 Git 或 local-path dependency。

每个 `packages/*/package.json` 都是 `"private": true` 且没有 `publishConfig`,因此
`npm publish` 与 `pnpm publish` 会拒绝执行。`pnpm run sdk:distribution:contract` 是
`pnpm check` 的第一步,任何 package 移除其中一项保护时都会失败。没有任何 CI workflow 或脚本向
registry 发布。

## TypeScript package

所有 TypeScript SDK 的源码版本都是 `0.1.0-alpha.0`。请固定构建所用的仓库 commit;仅凭版本号
无法确定一次构建。

| Package                                              | 用途                              |
| ---------------------------------------------------- | --------------------------------- |
| `@xid-kit/core`                                      | 浏览器 client                     |
| `@xid-kit/backend`                                   | 服务端 token 与请求验证           |
| `@xid-kit/react`、`nextjs`、`vue`、`nuxt`、`svelte`  | Web 框架绑定                      |
| `@xid-kit/angular`、`remix`、`astro`、`solid`        | Web 框架绑定                      |
| `@xid-kit/react-native`、`expo`、`electron`、`tauri` | 移动端与桌面端绑定                |
| `@xid-kit/types`、`crypto`、`protocol`               | 上述 SDK import 的 runtime kernel |

`@xid-kit/db`、`i18n`、`saml`、`webauthn`、`web-ui` 是 XID Core 与 Console 的内部 package,不供
应用使用。

每个 SDK `package.json` 的 `main`、`module`、`types`、`exports` 都指向 `dist/`。`dist/` 不提交
到仓库,因此下面每种使用方式都要先通过 package 的 `build` 脚本用 `vp pack` 构建。

### 在 XID workspace 内

位于本仓库内的应用或示例通过 workspace protocol 依赖 SDK:

```json
{
  "dependencies": {
    "@xid-kit/core": "workspace:^"
  }
}
```

把 consumer 与其 SDK dependency 一起构建。turbo 会先构建每个 dependency:

```bash
pnpm install
pnpm --filter <your-app>... build
```

### 在 XID workspace 外:vendor tarball

其他仓库中的应用 vendor 从固定 XID commit 构建的 tarball。

1. 在 checkout 中构建 SDK 并打包其 dependency closure:

   ```bash
   git clone https://github.com/StringKe/xid.git
   cd xid
   git checkout <commit>
   pnpm install --frozen-lockfile
   pnpm --filter @xid-kit/backend... build
   for pkg in types crypto backend; do
     pnpm --dir "packages/$pkg" pack --pack-destination /path/to/your-app/vendor/xid
   done
   ```

   `pnpm pack` 会把内部 `workspace:^` dependency 改写为 `^0.1.0-alpha.0`,每个 tarball 只保留
   `dist/`、`README.md` 与 `package.json`。

2. 在应用的 `package.json` 中引用 closure 中的每个 tarball:

   ```json
   {
     "dependencies": {
       "@xid-kit/types": "file:vendor/xid/xid-kit-types-0.1.0-alpha.0.tgz",
       "@xid-kit/crypto": "file:vendor/xid/xid-kit-crypto-0.1.0-alpha.0.tgz",
       "@xid-kit/backend": "file:vendor/xid/xid-kit-backend-0.1.0-alpha.0.tgz"
     }
   }
   ```

3. 用你的 package manager 安装(`npm install`、`pnpm install` 或 `yarn install`),并把 tarball
   与应用一起提交。

必须列出完整 closure。每个 tarball 内的 `^0.1.0-alpha.0` range 会解析到你 `package.json` 中列出
的 tarball;缺少任何一项,package manager 就会去 registry 查找,而 registry 上不存在这些 package。

| SDK                     | 需要 vendor 的 tarball(`packages/<dir>`)                            |
| ----------------------- | ------------------------------------------------------------------- |
| `@xid-kit/types`        | `types`                                                             |
| `@xid-kit/crypto`       | `types`、`crypto`                                                   |
| `@xid-kit/protocol`     | `types`、`crypto`、`protocol`                                       |
| `@xid-kit/core`         | `types`、`crypto`、`protocol`、`core`                               |
| `@xid-kit/backend`      | `types`、`crypto`、`backend`                                        |
| `@xid-kit/react`        | `types`、`crypto`、`protocol`、`core`、`react`                      |
| `@xid-kit/vue`          | `types`、`crypto`、`protocol`、`core`、`vue`                        |
| `@xid-kit/angular`      | `types`、`crypto`、`protocol`、`core`、`angular`                    |
| `@xid-kit/solid`        | `types`、`crypto`、`protocol`、`core`、`solid`                      |
| `@xid-kit/electron`     | `types`、`crypto`、`protocol`、`core`、`electron`                   |
| `@xid-kit/tauri`        | `types`、`crypto`、`protocol`、`core`、`tauri`                      |
| `@xid-kit/svelte`       | `types`、`crypto`、`protocol`、`core`、`backend`、`svelte`          |
| `@xid-kit/astro`        | `types`、`crypto`、`protocol`、`core`、`backend`、`astro`           |
| `@xid-kit/nextjs`       | `types`、`crypto`、`protocol`、`core`、`backend`、`react`、`nextjs` |
| `@xid-kit/remix`        | `types`、`crypto`、`protocol`、`core`、`backend`、`react`、`remix`  |
| `@xid-kit/nuxt`         | `types`、`crypto`、`protocol`、`core`、`backend`、`vue`、`nuxt`     |
| `@xid-kit/react-native` | `types`、`crypto`、`protocol`、`react-native`                       |
| `@xid-kit/expo`         | `types`、`crypto`、`protocol`、`react-native`、`expo`               |

`react`、`vue`、`expo` 等框架 peer 照常从你平时使用的 registry 安装。

### Vendoring 验证

执行 manifest 检查:

```bash
pnpm run sdk:distribution:contract
```

执行完整 vendoring 检查:

```bash
pnpm run sdk:distribution:verify
# 等价的 root entry
pnpm run pack
```

完整检查执行以下步骤,不访问任何 XID package registry:

1. 用 `vp pack` 构建每个 SDK,包含全部已记录的 subpath entry。
2. 用 `pnpm pack` 创建 18 个 tarball。
3. 审计每个 tarball 的 README、MIT license、canonical homepage、runtime entry、declaration
   entry、声明的 export target、`"private": true`、dependency version,并确认不含 source 或
   test file。
4. 对每个输出的 `.mjs` 文件执行 `node --check`。
5. 在 workspace 外创建全新的临时 consumer,通过 `file:` 引用依赖 tarball。它们的 `@xid-kit`
   scope 指向不可达地址,因此每个已安装的 XID package 都必须来自 tarball。
6. 不使用 `--legacy-peer-deps`,按 npm 正常 peer resolution 安装代表性 dependency closure,用
   `skipLibCheck: false` 的 TypeScript 解析 public type,并 runtime import host-independent
   entry。只能在真实框架 host 中运行的 package 会被构建和审计,但不会被一起安装到同一个虚构
   应用中。
7. 验证 browser consumer 使用 `@xid-kit/types` 时不需要安装 Cloudflare ambient type。另一个
   Worker fixture 显式依赖 `@cloudflare/workers-types`,并从 type-only 的
   `@xid-kit/types/cloudflare` subpath import `Env`。
8. 验证 React Native 与 Expo 的 dependency graph 在 React 19 上正常解析,且 React Native-only
   fixture 不安装 `react-dom`。

Manifest 检查还确保 package version 与 `0.1.0-alpha.0` 对齐,包括 Nuxt runtime 的
`moduleMetadata.version`,避免 framework tooling 报告过期的 module version。检查结束后删除临时
consumer 与 tarball。

## 原生 SDK

`sdk/` 下的 13 个 SDK 使用各自工具链的源码依赖机制。每个 README 给出确切命令。

| SDK           | 应用的使用方式                                                                       |
| ------------- | ------------------------------------------------------------------------------------ |
| Go            | 从 Git 仓库获取 Go module:`go get github.com/StringKe/xid/sdk/go@<commit>`           |
| Rust、Linux   | Cargo `path` dependency,指向 checkout 中的 `sdk/rust` 或 `sdk/linux`                 |
| Python        | 从 Git 仓库 `pip install`,带 `#subdirectory=sdk/python`                              |
| Ruby          | Gemfile `path` dependency,或在 checkout 中 `gem build` 后 `gem install`              |
| PHP           | Composer `path` repository,指向 `sdk/php`                                            |
| Java          | 在 `sdk/java` 中 `mvn install`,再从本地 Maven 使用 `dev.xid:xid-sdk-java` coordinate |
| Android       | 引入 `sdk/android` 的 Gradle project                                                 |
| .NET、Windows | `ProjectReference` 指向 checkout 中的 `.csproj`                                      |
| iOS、macOS    | Swift Package Manager local package path                                             |
| Flutter       | pub `git` dependency,带 `path: sdk/flutter`                                          |

格式支持时,每个 manifest 都包含 package-format identity、MIT license、repository 与 README
metadata。`pnpm run native:verify` 检查这些 metadata,以及每个原生 README 开头的源码分发说明。
