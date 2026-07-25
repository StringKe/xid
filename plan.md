# GitHub Security 全量修复计划

## 基线

- 日期：2026-07-25
- 基线提交：`7c801679ee46862c450de34bf10dcb0169ba558a`
- 分支：`codex/security-alert-remediation-20260725`
- Dependabot：34 条开放告警，24 个独立安全公告
- CodeQL：26 条开放告警
- Scorecard：6 条开放告警
- Secret Scanning：4 条开放告警
- 总计：70 条开放告警

数据源：

- https://github.com/StringKe/xid/security/dependabot
- https://github.com/StringKe/xid/security/code-scanning
- https://github.com/StringKe/xid/security/secret-scanning

## 冻结范围

- 修复 npm、Rust、Go、Composer 的全部已知易受攻击依赖链。
- 修复 26 条 CodeQL 告警的根因，并搜索全库相同模式。
- 恢复 CodeQL 工作流，使当前提交能够重新扫描。
- 增加真实的属性测试和 fuzzing CI gate。
- 替换 Secret Scanning 命中的测试夹具，不改写公开 Git 历史。
- 通过正常 PR 审批满足 Scorecard Code-Review。
- 对无法由代码立即关闭的治理信号保留可验证说明，不伪造完成状态。

## Todo List

- [x] T1 建立当前依赖图、告警和 CI 基线证据。
- [x] T2 修复 npm、Rust、Go、Composer 依赖告警并更新锁文件。
- [x] T3 修复随机数偏差、ReDoS、URL 规范化、XSS、堆栈泄露和 HTML 过滤根因。
- [x] T4 恢复 CodeQL，增加 fuzzing gate，替换测试密钥夹具。
- [x] T5 运行格式化、类型、测试、构建、原生 SDK 和依赖审计门禁。
- [x] T6 创建 DCO 签名提交，推送分支并创建 PR。
- [~] T7 等待 GitHub 检查和重扫，处理失败并核对全部 70 条告警状态。

## 完成定义

- `pnpm audit --json` 报告 0 个漏洞。
- Rust 锁文件不含受影响或未进入实际依赖图的陈旧包。
- Go 和 Composer 安全公告对应版本已升级并通过测试。
- 全库不再存在 CodeQL 指出的同类危险模式。
- `pnpm run check`、`pnpm test`、`pnpm build` 全部 PASS。
- 原生 SDK 的受影响语言测试和构建全部 PASS。
- GitHub required checks 和 CodeQL 全部 PASS。
- 34 条 Dependabot 告警关闭。
- 26 条 CodeQL 告警关闭。
- 4 条 Secret Scanning 告警以 `used_in_tests` 关闭。
- Scorecard 的 SAST、Vulnerabilities、Fuzzing、Code-Review 信号关闭。
- Scorecard Maintained 在仓库达到 90 天前保持外部时间约束说明。
- Scorecard CII-Best-Practices 保持仓库所有者外部登记约束说明。

## 状态

进行中。
