<div align="center">

# ADM

**Automatic Deployment Model — llama.cpp 图形化管理桌面应用**

基于 Tauri 2.x 构建，将 llama.cpp 复杂的命令行启动指令通过简洁的图形界面呈现，让你在本地轻松部署、运行大语言模型，并内置 **Agent 终端** 把本地模型接入智能体工作流。

![Tauri](https://img.shields.io/badge/Tauri-2.11.2-FFC131?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-2021_edition-000000?style=flat-square&logo=rust)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)

</div>

---

## 项目介绍

ADM（Automatic Deployment Model）是一款基于 **Tauri 2.x** 的 llama.cpp 图形化管理工具。它把 llama.cpp 繁琐的 CLI 启动参数做成可视化配置，配合一键下载、断点续传、国内镜像加速，让本地大模型的部署和运行变得简单：

- **图形化界面** — 告别命令行，点选即可配置和启动模型
- **一键下载** — 支持断点续传、进度实时显示，自动替换为国内镜像加速
- **模型交互** — 内嵌对话界面，启动后直接与原生模型对话
- **文生图** — 支持 Stable Diffusion 模型的可视化图片生成
- **硬件监控** — 实时显示内存、显存、CPU 信息
- **自动更新** — 应用版本 / VC++ 运行库 / llamacpp 二进制三重检查

轻量高效：基于 Tauri 构建，前端采用原生 HTML/CSS/JS，无重型框架依赖。

### ⭐ 核心亮点：Agent

**专门针对本地模型优化的 Agent 工具上线** —— 60K 小体量上下文照样不断言，出现幻觉自动修复，让本地模型真正成为生产力工具。

ADM 不只是模型启动器，更内置了开箱即用的 **Agent**，把你的本地模型直接变成可用的智能体：

- **为本地模型而生** — 针对本地小上下文场景深度优化，即便只有 60K 上下文也能稳定工作，不轻易断言、不乱下结论
- **幻觉自修复** — 模型出现幻觉时自动检测并修复，输出更可信、更可用
- **内置 Agent** — 底部栏一键进入，自动拉起本地 `admAgent` 服务，无需手动配置环境
- **模型即 Agent** — 已启动的本地模型可一键接入 `admAgent`，以智能体方式调用工具、执行任务，上下文窗口自动同步
- **一键安装与升级** — 首次进入自动下载 `admAgent`，支持版本检查 / 增量更新，全程进度可视
- **跨平台** — Windows / macOS 均可使用，服务模式运行，进程自动管理

> 启动模型 → 点击 Agent → 你的本地大模型立刻变成一个能跑工具、自动纠错的智能体生产力工具。

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

### 生产构建

```bash
# 当前平台构建
pnpm tauri build

# 指定平台构建
pnpm tauri:build:windows   # Windows x64（NSIS 安装包）
pnpm tauri:build:macos     # macOS
pnpm tauri:build:linux     # Linux x64
```

构建产物位于 `src-tauri/target/<target>/release/bundle/` 目录。

### 签名与发布

```bash
# 构建 + 自签名一条龙
pnpm release:windows   # = tauri:build:windows + sign:windows
pnpm release:macos     # = tauri:build:macos + sign:macos

# macOS 用户提示「已损坏」时的修复脚本
pnpm fix:macos
```

### CI 自动发布

CI 配置见 `.github/workflows/build.yml`，推送 `v*` 标签即自动构建并发布 GitHub Release（Windows `x64-setup.exe` + macOS `aarch64.dmg`，均含自签名）：

```bash
git tag v0.1.2
git push origin v0.1.2
```

---

## 联系方式

- **项目地址**：https://github.com/autoDeploymentModel/adm
- **问题反馈**：[GitHub Issues](https://github.com/autoDeploymentModel/adm/issues)
- **讨论交流**：欢迎扫码添加微信交流

<img src="src-tauri/wx.png" alt="微信" width="240" />

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
