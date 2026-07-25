# What is a Skill?

`type: skills` 是按需触发的"能力包"，与 rule 区别在于它含**完整执行步骤**。

## 用途

Skill 是 AI 能调用的"完整流程"，比如：

- `code-review`：审查 PR 的步骤序列（读 description -> 检查测试 -> 给反馈）
- `db-migration`：写 Liquibase 迁移文件的完整流程（包括 baseline 检查 / 增量 changelog 命名 / 测试）
- `release-checklist`：发版前要跑的检查项

跟 rule 区别：

| 维度     | rule                              | skill                                               |
| -------- | --------------------------------- | --------------------------------------------------- |
| 触发方式 | 按 applyTo 匹配代码区域时被动加载 | 用户/AI 显式调用（"帮我跑 code-review skill"）      |
| 内容形态 | 简短规范条目                      | 完整执行流程 + 检查清单                             |
| 配套文件 | 单 markdown 文件                  | 目录形：SKILL.md + scripts/ + references/ + assets/ |

## SKILL package 结构

skill 是**目录**不是单文件：

```
.stdai/standards/skills/code-review/
├── SKILL.md                # 必须有 frontmatter，type=skills
├── checklist.md            # 辅助参考
├── scripts/
│   └── lint.sh             # skill 用的脚本
└── examples/
    └── good-pr.md          # 示例
```

## frontmatter 字段

```yaml
---
type: skills
name: code-review
description: 代码审查 skill # 进 manifest，让 AI 判断何时调用
when_to_use: PR review 触发 # Claude Code 专属：触发线索
model: claude-sonnet-4-5 # 可选：指定模型
allowed_tools: [Read, Grep, Bash] # subagent / 工具白名单
license: MIT # agentskills 标准字段
metadata: # 自由 map（YAML 嵌套）
  author: foo
  category: review
---
# Code Review Skill

## 步骤
1. ...
2. ...
```

## 落点

| target             | skill 写到                                                      |
| ------------------ | --------------------------------------------------------------- |
| Claude Code        | `.claude/skills/<name>/SKILL.md` + 同目录辅助文件               |
| Codex              | `.agents/skills/<name>/SKILL.md` + 辅助文件（agentskills 标准） |
| Cursor             | `.cursor/skills/<name>/SKILL.md` + 辅助文件                     |
| Windsurf           | `.windsurf/skills/<name>/SKILL.md`                              |
| Copilot / OpenCode | 单文件 skill（无 SKILL package 概念）；含辅助文件时输出 WARN    |

其他 target 无原生 skills 概念，stdagent 不输出。

## 何时不要用 skill

- 内容只是"规则"（被动参考）-> 用 rule
- 内容是 slash 命令模板（用户输入 `/<name>` 触发）-> 用 commands
- 内容是项目总览说明 -> 写到 `.stdai/standards/root.md`
