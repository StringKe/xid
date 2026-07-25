# What is a Rule?

`type: rules` 是 stdagent 最常用的源类型。

## 用途

Rule 是**编码规范 / 操作规则 / 架构铁律**——AI 编辑代码时，按 `applyTo` 匹配按需加载的"参考资料"，不是激活指令。

例子：

- `naming.md`：表名、类名、Repository 命名一致性
- `exception-handling.md`：异常决策树、BizException 三层结构
- `git-conventions.md`：Conventional Commits 格式
- `redis.md`：Redisson PRO 缓存 / 锁的使用规范

## 何时该用 rules

- 规则较短（一般 < 8000 字符），AI 启动 session 时读 manifest 看到 description 就能判断是否相关
- 规则跟代码区域 / 文件类型 / 业务领域绑定（用 applyTo 描述触发条件）
- 规则是"被动参考"而非"主动执行"——AI 编辑 `**/*Service.java` 时该想起来"哦，service.md 里有命名规范"

## frontmatter 字段

```yaml
---
type: rules
name: exception-handling # kebab-case 唯一标识
description: 异常处理规范 # 强烈建议：进 manifest 让 AI 看清单时能判断
priority: high # high / normal / low
applyTo: # gitignore 风格 glob，决定何时该读
  - '**/*Exception.java'
  - '**/*Errors.java'
globs: [...] # applyTo 别名（rulesync / Cursor / Cline 风格），合并去重
claudecode: # target 专属 paths 覆盖
  paths: ['**/*Service.java']
cursor:
  paths: ['src/**/*.ts']
targets: [claude-code, codex] # 白名单（默认所有 enabled target）
exclude_targets: [] # 黑名单（与 targets 二选一）
alwaysApply: false # Cursor always-on 模式
---
正文 Markdown 从这里开始...
```

## 落点

| target       | rule 写到                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| Claude Code  | `.claude/rules/<name>.md`（CLAUDE.md manifest 含 @import 引用）                                                    |
| Codex        | `.codex/memories/<name>.md`（codex CLI 自动加载该目录所有 .md）                                                    |
| Cursor       | `.cursor/rules/<name>.mdc`                                                                                         |
| Copilot      | `.github/copilot-instructions.md` 内联（无 applyTo）或 `.github/instructions/<name>.instructions.md`（有 applyTo） |
| Windsurf     | `.windsurf/rules/<name>.md`（trigger 由 frontmatter 决定）                                                         |
| Gemini       | inline 到 `GEMINI.md`（gemini 无子目录加载）                                                                       |
| Cline        | `.clinerules/<priority-prefix>-<name>.md`                                                                          |
| Continue.dev | `.continue/rules/<name>.md`                                                                                        |
| Antigravity  | `.agents/rules/<name>.md`                                                                                          |

## 跟其他 type 的区别

- 不要把"slash 命令模板"写成 rule -> 用 `type: commands`
- 不要把"按需触发的能力包"写成 rule -> 用 `type: skills`
- 不要把"项目总览"写成 rule -> 写到 `.stdai/standards/root.md`
