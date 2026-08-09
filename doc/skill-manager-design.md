# 技能管理（Skill Manager）设计文档

> 改动目标：**桌面端**（`src/` + `src-tauri/`）。admAgent（`admAgent/`）只读，不修改。
> 相关开发文档见 [skill-development.md](./skill-development.md)。

---

## 1. 概述

在底部导航栏「Agent」按钮旁新增「技能管理」入口，进入独立页面（hash 路由 `#/skills`），提供两个 Tab：

- **技能商店**：从远程 `https://adm.tuduoduo.top/skills.json` 拉取技能列表，卡片展示，支持一键安装（选择安装位置：全局 / 当前项目）。
- **我的技能**：展示本地已安装技能（内置 / 全局 / 当前项目），卡片展示，可查看来源。

安装流程：卡片「安装」→ 弹窗选择位置（全局 / 当前项目）→ 下载 `skill_url` 指向的 zip 包 → 解压到目标 skills 目录 → 删除 zip → 刷新列表标记「已安装」。

---

## 2. 入口与路由

### 2.1 底部导航栏（`src/index.html`）

在 `#agent-btn` 与 `#hw-items` 之间插入：

```html
<div id="skills-btn" onclick="location.hash='#/skills'">
  <span class="btn-icon">🧩</span>
  <span class="btn-text" data-i18n="技能管理">技能管理</span>
</div>
```

同步修改：

| 位置 | 改动 |
|------|------|
| CSS 选择器组 `#home-btn, #settings-btn, #agent-btn` | 追加 `#skills-btn`（hover / active 样式共用） |
| `setActiveNav()` 数组 | 追加 `"skills-btn"` |
| `routes` 对象 | 追加 `"/skills": { load: () => import("./views/skills.js"), nav: "skills-btn" }` |

### 2.2 视图模块（新建 `src/views/skills.js`）

遵循现有视图约定：

```js
export const template = `<style>...</style> ...`;
export function mount(root, params) { ... }   // 绑事件、拉数据
export function unmount() { ... }             // 解绑事件
```

样式隔离：所有选择器带 `skills-` 前缀，不重复定义全局 reset。

---

## 3. 页面布局

```
┌──────────────────────────────────────────────────────┐
│ skills-header（固定）                                  │
│   🧩 技能管理   [ 技能商店 | 我的技能 ]                │
├──────────────────────────────────────────────────────┤
│ skills-body（flex:1，可滚动）                          │
│   ┌─ skills-card-grid（auto-fill, minmax(300px,1fr)） │
│   │ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐  │
│   │ │ 技能卡片     │ │ 技能卡片     │ │ 技能卡片     │  │
│   │ └─────────────┘ └─────────────┘ └─────────────┘  │
│   └──────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────┘
```

- Header 左侧：标题（带 accent 竖条，风格同 `model_list.js` 的 `.page-title`）
- Header 右侧：Tab 切换（风格参考 agent 视图 `.tools-tabs`：圆角胶囊，active 用 accent 背景）
- 主体：`display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:16px`，卡片风格参考 `.model-card`（hover 上浮 + 边框变 accent）

---

## 4. 技能商店 Tab

### 4.1 数据源

```
GET https://adm.tuduoduo.top/skills.json
```

**Rust 端新增命令** `fetch_skill_store`（reqwest GET，避免前端 CORS 问题），返回数组：

```json
[
  {
    "skill_name": "文章去AI味工具",
    "skill_type": "内容创作",
    "skill_url": "http://adm.tuduoduo.top/skills/references.zip",
    "skill_info": "去除文本中的AI写作痕迹……"
  }
]
```

| 字段 | 用途（卡片展示） |
|------|------|
| `skill_name` | 卡片标题；同时作为「已安装」匹配键 |
| `skill_type` | 分类标签（badge） |
| `skill_info` | 描述（最多 2 行省略） |
| `skill_url` | 安装时下载地址（zip 包） |

> **V1 范围**：商店仅按 `skills.json` 的链接展示与安装，**不开放开发者上架**（商店列表由官方维护）。开发者制作的技能通过「本地上传」安装（见 §5）。

### 4.2 卡片结构

```
┌─────────────────────────────────┐
│ 🧩 文章去AI味工具    [内容创作]  │  ← 标题 + 类型 badge
│ 去除文本中的AI写作痕迹，让文字…  │  ← 描述（2 行截断）
│ ──────────────────────────────  │
│         [安装] / [✓ 已安装]     │  ← 底部操作区
└─────────────────────────────────┘
```

- 未安装：主按钮 `安装`（accent 色）
- 已安装（任一位置）：按钮置灰显示 `✓ 已安装`，不可再点

### 4.3 安装流程

点击「安装」→ 弹出确认弹窗（复用 `showShellConfirm` 风格的自绘弹窗，或新建 `skills-confirm` 弹窗）：

```
⚠️ 安装技能「文章去AI味工具」

选择安装位置：
  ○ 全局（所有项目可用）
  ● 当前项目（仅 /path/to/project 可用）

[取消] [确认安装]
```

确认后流程：

```
1. Rust install_skill { skill_url, target: "global" | "project" }
2. 下载 zip 到临时目录（.part 断点续传可选）
3. 校验 zip 包结构（防 zip-slip 路径穿越）
4. 解压到目标 skills 目录
5. 删除 zip 临时文件
6. 返回结果 → 前端刷新列表，按钮变「✓ 已安装」
```

### 4.4 安装位置

| 位置 | 目标目录 | 说明 |
|------|----------|------|
| 全局 | macOS/Linux：`~/.config/admAgent/skills/<skill_name>/`<br>Windows：`%LOCALAPPDATA%\admAgent\skills\<skill_name>\` | 对应 `GlobalSkillsDirs()` 首选路径 |
| 当前项目 | `<workdir>/.agents/skills/<skill_name>/` | 对应 `ProjectSkillsDir()` 首选路径（`<workdir>` 来自 `get_agent_workdir`） |

> 技能目录约定：zip 解压后为 `<skill_name>/SKILL.md` 结构（见 skill-development.md 打包规范）。

### 4.5 安全与健壮性

- **zip-slip 防护**：解压时校验每个 entry 的路径，拒绝 `../` 与绝对路径
- **名称校验**：目录名需匹配 `^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$`（admAgent 发现规则），否则解压失败并提示
- **下载失败**：删除残留 .part / zip，显示错误提示
- **重复安装**：目标目录已存在同名技能 → 弹窗提示「已安装，是否覆盖？」（确认后先删旧目录再解压）

### 4.6 已安装判断

- 安装成功后，前端本地记录：`localStorage["skills_installed_<name>"] = target`
- 同时对照「我的技能」接口返回（见 §6），以服务端为准

---

## 5. 本地上传安装（V1 核心入口）

> 用户可不上商店，直接上传本地技能包（zip）。上传后先做**规则校验**，通过才允许安装。

### 5.1 入口位置

「技能商店」Tab 顶部工具栏右侧新增按钮：`📦 上传技能包`。

点击后流程：

```
1. 打开文件选择器（tauri-plugin-dialog open 对话框，过滤 *.zip）
2. 前端先做基础检查（扩展名 .zip、大小 ≤ 50MB）
3. 调 Rust 命令 install_skill_from_zip { zip_path, target? }
4. Rust 校验技能包规则（见 5.3）
5. 校验失败 → 弹窗显示具体错误原因，流程终止
6. 校验通过 → 弹窗选择安装位置（全局 / 当前项目，同商店安装）
7. 解压到目标目录 → 删除 zip（若 zip 在临时目录）→ 刷新列表
```

> 文件选择器复用现有 `tauri-plugin-dialog`（`src-tauri` 已有该依赖），跨平台一致。

### 5.2 校验失败提示

弹窗展示具体失败原因（对应校验规则序号）：

```
❌ 技能包格式不正确：
   规则 2 未通过 — 目录名不符合命名规则（仅允许小写字母/数字/连字符）
```

### 5.3 技能包校验规则（`install_skill_from_zip` 内实现）

| # | 规则 | 失败示例 |
|---|------|----------|
| 1 | 文件是有效 zip 且根目录唯一（zip 根只有 1 个顶层目录） | 根目录有 2+ 个目录 / zip 损坏 |
| 2 | 顶层目录名匹配 `^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$` | `文章去AI味/`、`My Skill/` |
| 3 | 包内存在 `<顶层目录>/SKILL.md` | 缺 SKILL.md |
| 4 | SKILL.md frontmatter 可解析，`name` 字段存在且**等于目录名**，`description` 存在 | name 缺失 / 与目录名不一致 |
| 5 | `name` ≤64 字符、`description` ≤1024 字符（admAgent 约束） | 超长 |
| 6 | 所有条目路径无 `../`、不以 `/` 开头（zip-slip 防护） | `../../evil.sh` |

全部通过 → 进入安装（选位置 → 解压）。

---

## 6. 我的技能 Tab

### 6.1 数据源

复用 admAgent server 现有接口（前端经 `api("GET", "/v1/workspaces/" + wsId + "/skills")`）：

```json
[
  {
    "id": "skill 文件路径",
    "name": "skill名称",
    "description": "技能描述",
    "label": "user:名称 / project:名称 / system:名称",
    "source": "user | project | system",
    "user_invocable": true
  }
]
```

> `source` 字段区分来源：`system`=内置、`user`=全局、`project`=当前项目（见 admAgent `internal/skills/catalog.go`）。

### 6.2 卡片结构

```
┌─────────────────────────────────┐
│ 🧩 jq                [全局/项目] │  ← 名称 + 来源 badge
│ JSON 处理工具使用指南…           │  ← 描述
│ ──────────────────────────────  │
│ 状态: ● 已加载   [查看] [卸载]  │  ← 底部操作区
└─────────────────────────────────┘
```

- 来源 badge 颜色：`system`=蓝、`user`=绿、`project`=紫
- `查看`：调 `POST /v1/workspaces/{id}/skills/read`，弹窗展示 SKILL.md 内容
- `卸载`：删除对应目录（二次确认弹窗）——**注意：内置（system）技能不显示卸载按钮**
- 空状态：「还没有安装任何技能，去技能商店看看吧」+ 跳转按钮

### 6.3 刷新时机

- 页面 mount 时拉取
- 安装/卸载完成后重新拉取
- agent 视图左侧 Skill 列表已能显示技能状态（`tools.js`），本页数据与其同源

---

## 7. Rust 后端新增命令（`src-tauri/src/pages/skills.rs`）

| 命令 | 入参 | 返回 | 说明 |
|------|------|------|------|
| `fetch_skill_store` | 无 | `[{skill_name, skill_type, skill_url, skill_info}]` | reqwest GET skills.json，超时 10s |
| `install_skill` | `{ skill_url, skill_name, target }` | `{ ok, dir }` | 商店安装：下载 → 校验 → 解压 → 删 zip |
| `install_skill_from_zip` | `{ zip_path, target }` | `{ ok, dir, name }` | 本地上传：校验规则（§5.3）→ 解压 → 删 zip（若为临时副本） |
| `uninstall_skill` | `{ skill_name, target }` | `{ ok }` | 删除技能目录（global/project） |
| `list_installed_skills` | `{ target? }` | `[{name, path, source}]` | 扫描 skills 目录（供「我的技能」兜底，不依赖 agent server） |

依赖：`zip` crate 已存在（`src-tauri/Cargo.toml` 已有 `zip = "0.6"`）；下载复用 `download_model` 的 reqwest 下载模式。

---

## 8. 前端文件清单

| 文件 | 操作 |
|------|------|
| `src/index.html` | 底部按钮 + 路由 + setActiveNav + CSS 选择器 |
| `src/views/skills.js` | 新建：template / mount / unmount + 两个 Tab 渲染与交互 + 上传入口 |
| `src/i18n.js` | 新增词条（见下） |
| `src-tauri/src/pages/skills.rs` | 新建：五个命令 |
| `src-tauri/src/pages/mod.rs` | 注册模块 |
| `src-tauri/src/lib.rs` | 注册 invoke handler |

### i18n 新增词条

```js
"技能管理": "Skills",
"技能商店": "Skill Store",
"我的技能": "My Skills",
"安装": "Install",
"已安装": "Installed",
"卸载": "Uninstall",
"查看": "View",
"全局（所有项目可用）": "Global (all projects)",
"当前项目": "Current project",
"安装位置": "Install Location",
"确认安装": "Confirm Install",
"安装中...": "Installing...",
"安装成功": "Installed successfully",
"安装失败: ": "Install failed: ",
"已存在，是否覆盖？": "already exists. Overwrite?",
"覆盖": "Overwrite",
"确定要卸载此技能吗？": "Uninstall this skill?",
"还没有安装任何技能，去技能商店看看吧": "No skills installed yet. Browse the Skill Store.",
"去商店看看": "Browse Store",
"暂无搜索结果": "No results found",
"搜索技能...": "Search skills...",
"加载技能商店失败: ": "Failed to load skill store: ",
"内置": "Built-in",
"全局": "Global",
"项目": "Project",
"上传技能包": "Upload Skill Pack",
"技能包格式不正确": "Invalid skill pack",
"技能包过大（最大 50MB）": "Skill pack too large (max 50MB)",
"请选择 .zip 格式的技能包": "Please select a .zip skill pack",
"校验失败": "Validation failed",
"选择安装位置": "Choose install location",
"上传的技能包将解压安装到指定位置": "The uploaded skill pack will be extracted to the chosen location",
```

---

## 9. 边界情况

1. **agent server 未启动 / 无 workspace**：「我的技能」拉取失败时，降级用 `list_installed_skills`（Rust 直接扫目录）展示
2. **zip 包结构不符合规范**（无 SKILL.md / 目录名不匹配）：`install_skill_from_zip` 校验阶段即失败（§5.3），清理临时文件，报「技能包格式不正确」+ 具体规则序号；商店安装（`install_skill`）同样复用该校验逻辑
3. **全局安装后切换项目**：「我的技能」按当前 workspace 展示，全局技能始终可见
4. **商店接口不可用**：显示重试按钮 + 错误提示，不影响「我的技能」Tab；本地上传入口仍可用
5. **技能名中文**：商店 `skill_name` 为中文（如「文章去AI味工具」），但 admAgent 发现规则要求目录名 `^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$`——**中文名无法直接作为目录名**。方案：解压时以 zip 包内实际目录名为准（打包规范要求目录名合法），商店展示名仅作显示与匹配用；若 zip 内目录名非法，安装失败并提示联系作者

---

## 10. 实施顺序

1. `src-tauri/src/pages/skills.rs`（Rust 命令：fetch / install / install_skill_from_zip / uninstall / list + 校验逻辑）
2. `src/index.html`（按钮 + 路由）
3. `src/views/skills.js`（页面与交互，含上传入口）
4. `src/i18n.js`（词条）
5. `pnpm typecheck` + `cargo build` 验证
