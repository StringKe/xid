# What is a Command?

`type: commands` 是 **slash 命令模板**，由用户输入 `/<name>` 触发或 AI 在对话中描述意图调用。

## 用途

Command 是用户**主动**调起的功能，跟 rule（被动参考）和 skill（按需调用）不同。

例子：

- `/review`：触发代码审查流程
- `/release`：执行发布检查
- `/migrate`：生成数据库迁移脚本

## frontmatter 字段

```yaml
---
type: commands
name: review
description: Run code review # 进 manifest，AI 看清单时能判断
argument_hint: '[PR number]' # 触发时的提示
allowed_tools: [Read, Grep] # 可用的工具白名单
model: claude-sonnet-4-5 # 指定模型（可选）
---
# Review Command

## 步骤
1. 读 PR description
2. 检查测试覆盖
3. ...
```

## 落点

| target      | command 写到                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| Claude Code | `.claude/commands/<name>.md`（原生 slash 命令支持）                                                              |
| Cursor      | `.cursor/commands/<name>.md`                                                                                     |
| Copilot     | `.github/prompts/<name>.prompt.md`                                                                               |
| Gemini CLI  | `.gemini/commands/<name>.toml`                                                                                   |
| OpenCode    | `.opencode/commands/<name>.md`                                                                                   |
| Codex       | 降级为 skill：`.agents/skills/cmd-<name>/SKILL.md`（codex 无原生 slash 命令，加 cmd- 前缀避免与同名 skill 冲突） |
| Windsurf    | `.windsurf/workflows/<name>.md`（workflow 概念替代 command）                                                     |

## 何时不要用 command

- 内容是 AI 自动加载的规范 -> 用 rule
- 内容是按需触发的能力包（含完整流程 + 辅助文件）-> 用 skill
