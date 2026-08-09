# Skill 开发文档（Agent Skills）

本文档面向**技能开发者**：如何编写一个可被 ADM / admAgent 识别并安装的技能，以及如何打包上架到技能商店。

> 技能系统遵循 Agent Skills 开放标准（[agentskills.io](https://agentskills.io)），与 Claude Code 等工具的技能格式兼容。

---

## 1. 技能是什么

一个技能 = **一个目录** + 目录内必需的 `SKILL.md` 文件。

```
my-skill/
└── SKILL.md          ← 必需：frontmatter + 技能说明正文
```

`SKILL.md` 是技能的核心，前半部分是 YAML frontmatter（技能元信息），后半部分是 Markdown 正文（给 Agent 的完整使用说明）。

**目录名 = 技能名**，必须匹配：`^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$`

| 规则 | 说明 | 示例 |
|------|------|------|
| 只允许小写字母、数字、连字符 | 不允许空格、下划线、中文 | ✅ `de-ai-rewriter` |
| 必须以字母/数字开头结尾 | 不允许首尾连字符 | ❌ `-foo` / `foo-` |
| 连字符后必须有字母/数字 | 不允许连续连字符 | ❌ `foo--bar` |

> ⚠️ 中文名（如「文章去AI味工具」）不能作为技能**目录名**，技能目录名必须为英文（本地上传安装会强制校验）。

---

## 2. SKILL.md 格式

### 2.1 frontmatter（YAML）

```yaml
---
name: de-ai-rewriter                    # 必填：技能名，必须与目录名一致
description:                             # 必填：技能描述（≤1024 字符）
  Use when the user wants to remove AI-sounding phrasing...
user-invocable: true                     # 可选：是否可由用户主动调用（默认 true）
disable-model-invocation: false          # 可选：禁止模型自动调用（默认 false）
license: MIT                             # 可选：许可证
compatibility:                           # 可选：兼容性声明（≤500 字符）
  This skill works with the ADM desktop app.
metadata:                                # 可选：自定义键值对
  author: litai686
  version: 1.0.0
---
```

| 字段 | 必填 | 约束 | 说明 |
|------|------|------|------|
| `name` | ✅ | ≤64 字符，匹配 `^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$` | 技能名，必须等于目录名 |
| `description` | ✅ | ≤1024 字符 | 描述技能用途，Agent 据此决定何时加载 |
| `user-invocable` | — | 布尔 | `true`=用户可在 UI 主动调用 |
| `disable-model-invocation` | — | 布尔 | `true`=模型不会自动调用，仅用户手动触发 |
| `license` | — | 字符串 | 许可证标识 |
| `compatibility` | — | ≤500 字符 | 兼容性说明 |
| `metadata` | — | 键值对 | 自定义元信息（作者、版本等） |

### 2.2 正文（Markdown）

正文是技能的完整使用指南，Agent 调用技能时会把**整个 SKILL.md 正文**注入上下文。建议结构：

```markdown
# De-AI Rewriter

## 用途
（这个技能解决什么问题、什么时候用）

## 使用步骤
（step-by-step 操作流程）

## 示例
（输入 → 输出示例）

## 注意事项
（边界、禁忌、常见错误）
```

**编写要点**：

- **description 是触发器的关键**：Agent 靠它判断何时加载技能，要写明"当用户要求 X、提到 Y、需要做 Z 时使用"
- 正文要**完整自包含**：不要假设 Agent 已经了解上下文
- 引用外部脚本/资源时，说明它们位于技能目录的相对位置

---

## 3. 技能目录结构（可带附属资源）

```
my-skill/
├── SKILL.md               ← 必需
├── scripts/               ← 可选：配套脚本
│   └── rewriter.py
├── references/            ← 可选：参考资料
│   └── style-guide.md
└── assets/                ← 可选：静态资源
    └── template.txt
```

附属资源与 SKILL.md 放在**同一目录**下，Agent 按相对路径引用（如 `scripts/rewriter.py`）。

---

## 4. 打包与安装

### 4.1 zip 打包规范

1. **zip 根目录直接是技能目录**（不是外层再包一层）：

```
my-skill.zip
└── my-skill/
    └── SKILL.md
```

2. 目录名必须匹配命名规则（§1）
3. 压缩包内不允许 `../` 路径穿越条目（安装端会做 zip-slip 校验）
4. 打包命令示例（Linux/macOS）：

```bash
cd /path/to/ && zip -r my-skill.zip my-skill/
```

### 4.2 安装方式

V1 阶段**暂不开放开发者上架到技能商店**（商店列表 `skills.json` 由官方维护）。开发者 / 用户通过**本地上传技能包**安装：

1. 将技能目录打成 zip（打包规范见 §4.1）
2. 在 ADM「技能管理 → 技能商店 → 📦 上传技能包」选择该 zip
3. 应用**校验规则**（见 §4.3），校验通过后选择安装位置（全局 / 当前项目）
4. 安装到本地 skills 目录，自动解压并删除 zip

安装位置与发现机制见 §5。

### 4.3 本地上传校验规则（安装前强制检查）

上传的 zip 必须先通过以下校验，全部通过才允许安装：

| # | 规则 | 失败示例 |
|---|------|----------|
| 1 | 有效 zip 且根目录唯一（zip 根只有 1 个顶层目录） | 根目录有 2+ 个目录 / zip 损坏 |
| 2 | 顶层目录名匹配 `^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$` | `文章去AI味/`、`My Skill/` |
| 3 | 包内存在 `<顶层目录>/SKILL.md` | 缺 SKILL.md |
| 4 | SKILL.md frontmatter 可解析，`name` 存在且**等于目录名**，`description` 存在 | name 缺失 / 与目录名不一致 |
| 5 | `name` ≤64 字符、`description` ≤1024 字符 | 超长 |
| 6 | 所有条目路径无 `../`、不以 `/` 开头（zip-slip 防护） | `../../evil.sh` |

> 打包前用 §6 的校验清单自查，可避免安装被拒。

---

## 5. 安装位置与发现机制

安装时用户可选择两个位置（详见 skill-manager-design.md）：

| 位置 | 目录 | 生效范围 |
|------|------|----------|
| 全局 | macOS/Linux：`~/.config/admAgent/skills/<name>/`<br>Windows：`%LOCALAPPDATA%\admAgent\skills\<name>\` | 所有项目 |
| 当前项目 | `<项目根>/.agents/skills/<name>/` | 仅当前项目 |

admAgent 启动/创建 workspace 时会扫描以下目录（自动发现，无需配置）：

- 全局：`$ADMAGENT_SKILLS_DIR`（若设置）、`~/.config/admAgent/skills`、`~/.agents/skills`、`~/.claude/skills`（Windows 额外含 `%LOCALAPPDATA%\admAgent\skills` 等）
- 项目：`<workdir>/.agents/skills`、`.admAgent/skills`、`.claude/skills`、`.cursor/skills`（含 git 仓库根目录同名子目录）

> 技能发现发生在 workspace 创建时。**安装/卸载技能后需重启 Agent 服务（或切换工作目录重进）才能生效**——这一限制后续版本再优化。

---

## 6. 校验清单（提交前自查）

- [ ] 目录名匹配 `^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$`
- [ ] `SKILL.md` frontmatter 含 `name`（=目录名）与 `description`
- [ ] zip 根目录直接是技能目录
- [ ] zip 内无 `../` 路径条目
- [ ] description 写明触发场景（"当用户……时使用"）
- [ ] 正文自包含、步骤清晰
- [ ] 本地验证：把解压后的目录放到 `~/.agents/skills/` 下，重启 ADM 后在 Agent 页左侧 Skill 列表能看到、状态为「已加载」
