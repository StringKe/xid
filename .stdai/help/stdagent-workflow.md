# stdagent Workflow

stdagent 是 AI 用的"规则发布器"——AI 写源、stdagent 机械分发到各 AI CLI 工具。

## 第一次（深度迁移）

项目还没有 `.stdai/standards/` 但已有 `CLAUDE.md` / `AGENTS.md` / `.claude/rules/` / `.rulesync/` 等其他工具维护的 AI 配置时：

1. AI 阅读项目里所有现有 AI 配置文件（Read / Glob 扫遍以下位置）：
   - 根：`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.cursorrules` / `.windsurfrules` / `.clinerules`
   - 子目录：`.claude/rules/` / `.claude/shared-rules/` / `.cursor/rules/` / `.windsurf/rules/` / `.clinerules/` / `.continue/rules/` / `.github/instructions/` / `.github/copilot-instructions.md`
   - 其他工具源：`.rulesync/rules/` / `.codex/memories/` / `.codex/AGENTS.md`
   - skill / subagent：`.claude/skills/` / `.claude/agents/` / `.opencode/agents/` / `.agents/skills/`
2. **理解 + 总结**项目的规则体系（不要逐字复制；过时内容如 rulesync 操作流程要**改写**为 stdagent 工作流，不是删除）
3. 按 5 种 type 拆分到 `.stdai/standards/`：
   - 项目总览（含技术栈、模块结构、铁律、AI 配置维护流程） -> `.stdai/standards/root.md`
   - 编码 / 操作规则 -> `.stdai/standards/rules/<name>.md`
   - 能力包 -> `.stdai/standards/skills/<name>/SKILL.md`
   - slash 命令 -> `.stdai/standards/commands/<name>.md`
   - subagent -> `.stdai/standards/subagents/<name>.md`
4. 跑 `stdagent sync`（生成 CLAUDE.md / AGENTS.md / .claude/rules/ / .codex/memories/ 等）
5. 清理旧产物（`rm -rf .rulesync/`、删旧 `.cursorrules` 等）

详见 `.stdai/help/what-is-rules.md` / `what-is-skills.md` / `what-is-commands.md` / `what-is-subagents.md` 各类型详细说明。

## 第二次及之后（轻量日常）

只动 `.stdai/standards/`，不要回到 CLAUDE.md / AGENTS.md / .claude/rules/ 改（这些都是生成产物，sync 会覆盖）。

```bash
# 加规则
$EDITOR .stdai/standards/rules/<新规则名>.md
stdagent sync

# 改规则
$EDITOR .stdai/standards/rules/<已有规则名>.md
stdagent sync

# 删规则
rm .stdai/standards/rules/<旧规则名>.md
stdagent sync
stdagent clean    # 可选：清理 .claude/rules/<旧名>.md 等遗留产物
```

## 命令速查

| 命令               | 用途                                         |
| ------------------ | -------------------------------------------- |
| `stdagent init`    | 初始化 `.stdai/` 骨架（含本 help 目录）      |
| `stdagent sync`    | 把 `.stdai/standards/` 扩散到 enabled target |
| `stdagent status`  | 显示每个 target 的 drift 与最后同步时间      |
| `stdagent fix`     | 等价 sync（drift 修复别名）                  |
| `stdagent clean`   | 删生成产物，保留 `.stdai/` 源                |
| `stdagent budget`  | LLM context 预算检查                         |
| `stdagent intro`   | 输出 AI 助手提示词                           |
| `stdagent upgrade` | 自我升级                                     |

每个命令支持 `--help`。

## 根文件结构（stdagent 自动生成）

stdagent sync 后，CLAUDE.md / AGENTS.md / GEMINI.md / .github/copilot-instructions.md 形态：

```
<root.md body 完整内容>           <- .stdai/standards/root.md，项目总览主体

## Imported Rules / Reference Rules

下列条目由 stdagent 同步生成到 .claude/rules/（或 .codex/memories/ 等），AI 工具读到 @<path> 自动加载：

- @.claude/rules/<name1>.md -- description (applyTo: ...)
- @.claude/rules/<name2>.md -- description
- ...
```

**不要手改这些根文件**——sync 会覆盖。改源 `.stdai/standards/` 然后 sync。

## 常见错误

- 把整段 CLAUDE.md 复制成一个 type=rules 文件 -> 拆成多个聚焦 rule + 一个 root.md
- description 留空 -> AI 看 manifest 时无法判断该读哪个，写好它
- 在 root.md 里手写 rule 索引清单 -> stdagent 自动追加 manifest，手写会重复
- 手改 stdagent 生成的 CLAUDE.md / .claude/rules/ -> sync 覆盖。改源
- 把 commands 写成 rules -> 语义不同（用户主动触发 vs 被动参考）
