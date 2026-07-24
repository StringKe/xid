---
type: rules
name: testing
description: 测试规范:vitest/AAA/描述性命名/必测关键路径(协议/隔离/密码/token/越权)/重点测边界与负路径/不测占位
priority: normal
applyTo:
  - '**/*.test.ts'
  - '**/*.spec.ts'
targets: [claude-code, codex]
---

# 测试规范

vitest(`vp test` 驱动)。

## 结构

- 测试文件 `<name>.test.ts` 与被测同目录(就近)或 `__tests__/`。
- AAA:Arrange / Act / Assert,空行分隔三段。
- 描述性测试名:`it('rejects PKCE plain challenge', ...)`,说清场景与期望,不写 `it('works')`。
- 每个 `it` 单一断言主题;共享 setup 用 `beforeEach`,不跨用例共享可变状态。

## 必测(关键路径,安全敏感)

- 协议正确性:PKCE S256 校验、redirect_uri 精确匹配、refresh rotation + family 重放吊销、WebAuthn 四验证、jti 防重放。
- 租户隔离越权:org A 上下文访问 org B 资源断言 403/404 不泄露存在性(见 tenant-isolation rule)。
- 密码:Argon2id 哈希/验证、HIBP、重置 token 一次性。
- token:签发/验签、过期、撤销准实时(DO)。
- 枚举防护:错误响应模糊一致、constant-time。

## 重点测边界与负路径

- 失败/边界:空输入、超长、过期、并发、克隆 sign_count、时钟偏差。
- 不可信输入的 valibot 校验失败路径(见 error-handling rule)。

## 不测

- 占位 / 纯类型 / 框架样板;不为覆盖率数字写无意义测试。
- 第三方库行为(信任其自身测试)。
