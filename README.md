<div align="center">

# ADM

**Automatic Deployment Model — llama.cpp 图形化管理桌面应用**

基于 Tauri 2.x 构建，把 llama.cpp 复杂的命令行启动指令做成图形界面，让你在本地轻松部署、运行大语言模型，并内置 **Agent 工作台** 把本地模型接入智能体工作流。

![Tauri](https://img.shields.io/badge/Tauri-2.11.5-FFC131?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-2021_edition-000000?style=flat-square&logo=rust)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)

</div>

---

## 联系方式

- **项目地址**：https://github.com/autoDeploymentModel/adm
- **问题反馈**：[GitHub Issues](https://github.com/autoDeploymentModel/adm/issues)
- **讨论交流**：欢迎扫码添加微信交流

<img src="src-tauri/wx.png" alt="微信" width="240" />

---

## 项目介绍

ADM（Automatic Deployment Model）是一款基于 **Tauri 2.x** 的 llama.cpp 图形化管理工具。它把 llama.cpp 繁琐的 CLI 启动参数做成可视化配置，配合一键下载、断点续传、国内镜像加速，让本地大模型的部署和运行变得简单：

- **图形化界面** — 告别命令行，点选即可配置和启动模型
- **一键下载** — 支持断点续传、进度实时显示，HuggingFace 链接自动切换国内镜像加速
- **多卡分载** — 按层 / 按行 / 按张量并行分载到多张 GPU，可指定各卡比例、主卡与设备列表
- **文生图** — 支持 ComfyUI 容器化的图片生成模型（自动装 Docker Desktop、拉镜像、起容器）
- **硬件监控** — 实时显示内存、显存、CPU、磁盘信息
- **自动更新** — 应用版本 / VC++ 运行库 / llamacpp 二进制三重检查
- **多语言与主题** — 界面语言切换 + 多套 VS Code 风格主题

轻量高效：前端采用原生 HTML/CSS/JS，无重型框架、无打包工具。

### ⭐ 核心亮点：Agent 工作台

ADM 不只是模型启动器，还内置了开箱即用的 **Agent 工作台**，把你的本地模型直接变成可用的智能体：

- **为本地模型而生** — 针对小上下文场景深度优化，即便只有 60K 上下文也能稳定工作，不轻易断言、不乱下结论
- **幻觉自修复** — 模型出现幻觉、空转、假完成时自动检测并纠正，输出更可信
- **模型即 Agent** — 已启动的本地模型可一键接入，也可切换到已配置的云端模型
- **多工作区并行** — 每个工作目录独立会话、独立数据库，切换 tab 不打断正在跑的 Agent
- **工具生态** — 内置文件 / Shell / LSP / MCP / 技能（Skills）体系，支持工具调用审批与权限模式
- **会话管理** — 会话重命名、上下文压缩、项目记忆（持久约束与决策）
- **附件管线** — 图片、PDF（自动分批转图）、文件路径粘贴全平台可用
- **决策模式** — 单轮结构化决策输出（选择 / 布尔 / 打分），结果以卡片呈现并回灌上下文
- **微信 Bot** — 绑定微信后可在手机端把消息投进当前工作区的 Agent
- **网络代理** — 可为 admAgent 配置 HTTP / SOCKS5 代理，本地地址自动绕过
- **内置分发** — `admAgent` 二进制随安装包内置，开箱即用，无需另行下载

> 启动模型 → 点击 Agent → 你的本地大模型立刻变成一个能跑工具、自动纠错的智能体生产力工具。

---

## 项目结构

| 目录 | 说明 |
| --- | --- |
| `src/` + `src-tauri/` | Tauri 桌面端（原生 JS 前端 + Rust 后端） |
| `admAgent/` | Go 编写共享后端服务与 TUI，两端共用同一 server |
| `doc/` | 服务端 API 文档、llama-server 参数说明、方案文档 |
| `scripts/` | 构建、签名、图标等工具脚本 |
| `website/` | 营销网站 |

---

## 编译与部署

### 环境准备

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| [Rust](https://www.rust-lang.org/tools/install) | stable | Tauri 后端编译 |
| [Node.js](https://nodejs.org/) | 22+ | 前端工具链 |
| [pnpm](https://pnpm.io/) | 9+ | 包管理器（不要使用 npm / yarn） |

> Windows 还需安装 [Visual Studio C++ 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（MSVC）；macOS 需安装 Xcode Command Line Tools（`xcode-select --install`）。

### 开发调试

```bash
# 安装依赖
pnpm install

# 热重载开发模式
pnpm tauri dev

# 前端类型检查（tsc --noEmit）
pnpm typecheck
```

前端为原生 HTML/CSS/JS（无框架、无打包工具），源码位于 `src/`，修改后刷新即生效；Rust 后端源码位于 `src-tauri/src/`。

`admAgent` 为 Go 项目，在 `admAgent/` 目录下单独构建：

```bash
go build ./...                          # 编译检查
go test ./internal/... -count=1         # 单元测试
```

编译产物会写入 `adm-binaries/`，桌面端构建时由 `scripts/prepare-agent-binary.mjs` 自动选版并打进安装包。

### 生产构建

```bash
# 当前平台构建
pnpm tauri build

# 指定平台构建
pnpm tauri:build:windows   # Windows x64（NSIS 安装包）
pnpm tauri:build:macos     # macOS arm64（DMG）
pnpm tauri:build:linux     # Linux x64（deb / AppImage）
```

构建产物位于 `src-tauri/target/<target>/release/bundle/` 目录。

### 签名与发布

```bash
# 构建 + 自签名一条龙
pnpm release:windows   # = tauri:build:windows + sign:windows
pnpm release:macos     # = tauri:build:macos + sign:macos

# macOS 用户提示「已损坏」时的修复脚本
pnpm fix:macos

# 推送最新 admAgent 二进制到 adm-binaries 仓库
pnpm agent:push
```

### CI 自动发布

CI 配置见 `.github/workflows/build.yml`，推送 `v*` 标签即自动构建并发布 GitHub Release（Windows `x64-setup.exe` + macOS `aarch64.dmg`，均含自签名）：

```bash
git tag v0.7.3
git push origin v0.7.3
```

### 运行要求

- **LLM（GGUF）**：任意支持 llama.cpp 的平台；图片生成模型需要 **Windows + NVIDIA 显卡 + Docker Desktop**（依赖 WSL2 与 nvidia-container-toolkit），应用会提前检测并给出明确原因。
- **admAgent**：随安装包内置，Windows / macOS / Linux 均可运行。

---

## 许可证

本项目基于 **MIT 许可证** 开源。

```
MIT License

Copyright (c) 2026 ADM

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
