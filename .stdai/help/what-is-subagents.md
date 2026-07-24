# What is a Subagent?

`type: subagents` 是 Claude Code 原生的 **spawnable 子代理**（独立 context）。

## 用途

Subagent 是 main session 用 Task 工具调起的**子进程**，它有自己独立的 context，跟 main agent 隔离。

跟 skill 区别：

| 维度     | skill                                 | subagent                                                   |
| -------- | ------------------------------------- | ---------------------------------------------------------- |
| 执行方式 | main session 内联读 SKILL.md 跟随步骤 | 启动新子进程，独立 context                                 |
| 上下文   | 共享 main 的 context                  | 隔离的子 context                                           |
| 触发     | "调用 X skill" 等显式触发             | main agent 决定 spawn（Task 工具）                         |
| 用途     | 复用流程 / 检查清单                   | 重型计算、需要专门 context 的子任务（深度搜索 / 复杂审查） |

## frontmatter 字段

```yaml
---
type: subagents
name: code-reviewer
description: Reviews code changes for safety and clarity
model: claude-sonnet-4-5 # 可选：指定 subagent 用的模型
allowed_tools: [Read, Grep, Bash] # subagent 可用的工具白名单
---
You are a strict code reviewer ...
（subagent 的系统提示词）
```

body 是 subagent 的 **system prompt**，跟 skill 的"执行步骤"不同。

## 落点

| target      | subagent 写到                                    |
| ----------- | ------------------------------------------------ |
| Claude Code | `.claude/agents/<name>.md`（原生 subagent 支持） |
| 其他 target | 不输出（无对应原生概念）                         |

## 何时不要用 subagent

- 内容是按需读取的"流程清单" -> 用 skill
- 内容是用户主动触发的命令 -> 用 commands
- 内容是被动参考的规则 -> 用 rule
