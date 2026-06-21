<div align="center">

# ADM

**Automatic Deployment Model — llama.cpp 图形化管理桌面应用**

![Tauri](https://img.shields.io/badge/Tauri-2.11.2-FFC131?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-2021_edition-000000?style=flat-square&logo=rust)
![Version](https://img.shields.io/badge/version-0.2.9-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)

</div>

---

## 项目简介

ADM (Automatic Deployment Model) 是一款基于 **Tauri 2.x** 构建的 llama.cpp 图形化管理工具。它将 llama.cpp 复杂的 CLI 启动指令通过简洁的 GUI 界面化配置，让用户能够便捷地在本地部署和运行大语言模型。

> 轻量高效 — 基于 Tauri 构建，前端采用原生 HTML/CSS/JS，无重型框架依赖。

---

## 目录

- [功能特性](#功能特性)
- [安装指南](#安装指南)
  - [系统要求](#系统要求)
  - [下载安装](#下载安装)
  - [从源码构建](#从源码构建)
- [使用指南](#使用指南)
  - [模型管理](#模型管理)
  - [启动模型](#启动模型)
  - [文生图](#文生图)
  - [参数配置](#参数配置)
  - [自动更新](#自动更新)
- [项目结构](#项目结构)
- [技术栈](#技术栈)
- [开发命令](#开发命令)
- [贡献指南](#贡献指南)
- [许可证](#许可证)
- [致谢](#致谢)
- [联系方式](#联系方式)

---

## 功能特性

| 特性 | 描述 |
|------|------|
| 图形化界面 | 告别繁琐的命令行，点选即可配置和启动模型 |
| 一键下载 | 支持断点续传、下载进度实时显示，自动替换国内镜像加速 |
| 一键启动 | 可视化配置启动参数，支持推荐模式快速切换采样参数 |
| 硬件监控 | 实时显示内存、显存、CPU 信息 |
| 模型交互 | 内嵌 Web 界面，启动后直接与模型对话，支持接入本地各种 agent 工具 |
| 文生图 | 支持 Stable Diffusion 模型，可视化配置生成参数，生成高质量图片 |
| 断点续传 | 下载中断后自动恢复，无需重新下载 |
| 国内镜像 | 自动替换 HuggingFace 为国内镜像，加速下载 |
| llamacpp 管理 | 自动检测硬件并下载匹配的 llama-server 二进制文件 |
| 自动更新 | 应用版本 / VC++ 运行库(Windows) / llamacpp 二进制三重检查，有序更新 |

---

## 安装指南

### 系统要求

| 平台 | 要求 |
|------|------|
| **Windows** | Windows 10/11 64 位 |
| **Linux** | 支持 GTK3 的桌面环境 |
| **macOS** | macOS 10.15+ |

### 下载安装

从 [Releases](https://github.com/autoDeploymentModel/adm/releases) 页面下载对应平台的安装包：

| 平台 | 安装包 |
|------|--------|
| Windows | `ADM_0.2.9_x64-setup.exe` |
| Linux | `adm_0.2.9_amd64.deb` 或 `adm-0.2.9-x86_64.AppImage` |
| macOS | `ADM_0.2.9_x64.dmg` |

> macOS 安装后，如提示文件损坏，需执行 `xattr -cr /Applications/ADM.app` 后启动应用。

### 从源码构建

#### 前置条件

| 工具 | 版本 | 说明 |
|------|------|------|
| Rust | 1.70+ | [安装指南](https://www.rust-lang.org/tools/install) |
| Node.js | 18+ | [官网下载](https://nodejs.org/) |
| pnpm | 9+ | `npm install -g pnpm` |
| Tauri 系统依赖 | - | [官方文档](https://v2.tauri.app/start/prerequisites/) |

#### 构建步骤

```bash
# 1. 克隆仓库
git clone https://github.com/autoDeploymentModel/adm.git
cd adm

# 2. 安装前端依赖
pnpm install

# 3. 开发模式运行
pnpm tauri dev

# 4. 构建生产版本
pnpm tauri build
```

> llama-server 可执行文件无需手动放置，应用首次运行时自动检测硬件并下载匹配的二进制文件。

---

## 使用指南

### 模型管理

1. 启动应用后，首页自动加载远程模型列表
2. 系统检测硬件配置（内存 + 显存），自动判断模型是否可用
3. **不可用**的模型：下载和启动按钮均被禁用
4. **可用**的模型：
   - 点击 **下载** 按钮开始下载，实时显示进度
   - 下载完成后按钮变为 **已下载**
   - 下载中断后，按钮显示 **继续下载**，支持断点续传

### 启动模型

1. 确保模型已下载完成
2. 点击 **启动** 按钮，系统自动读取保存的启动参数，调用 `llama-server`
3. 启动成功后，按钮变为 **查看模型** + **关闭模型**
4. 点击 **查看模型** 进入聊天交互界面
5. 点击 **关闭模型** 停止 `llama-server` 进程

### 文生图

支持 Stable Diffusion 模型的图形化图片生成：

1. 在模型列表页中，选择支持图片识别的模型
2. 点击 **文生图** 进入图片生成界面
3. 输入提示词，设置图片宽高
4. 系统自动检测并下载 sd-cli 二进制文件（首次使用需等待下载）
5. 点击 **生成图片**，实时查看运行日志
6. 生成完成后可查看并保存图片

### 参数配置

在设置页面中可可视化配置以下参数：

| 参数组 | 说明 |
|--------|------|
| **推荐模式** | 默认（日常聊天）/ 创意写作 / 写代码 — 一键切换采样参数组合 |
| **基础参数** | 上下文大小、预测 token 数、批处理大小、微批次大小 |
| **GPU 参数** | GPU 层数（`auto` / `all` / `0` / 自定义） |
| **性能参数** | 线程数、批处理线程数、Flash Attention、KV 缓存类型、内存锁定/映射 |
| **采样参数** | 温度、Top-K、Top-P、Min-P、重复惩罚、DRY 惩罚、存在惩罚、频率惩罚 |
| **推理参数** | 推理模式（`auto` / `0` / `1` / `2`） |
| **服务参数** | 监听端口、监听地址 |

参数修改后点击 **保存设置**，下次启动模型时自动生效。

### 自动更新

- 应用启动时静默检查更新（3 秒延迟）
- **三重检查机制**：应用版本 / VC++ 运行库(仅 Windows) / llamacpp 二进制版本
- 设置页面支持手动检查新版本及下载/更新 llamacpp

---

## 项目结构

```
adm/
├── doc/                        # 项目文档
│   ├── dev_doc.md              # 开发文档（详细架构与实现）
│   └── llamacpp.txt            # llama.cpp 参数参考
├── scripts/                    # 构建与签名脚本
├── src/                        # 前端资源
│   ├── index.html              # 主框架页
│   ├── model_list.html         # 模型列表页
│   ├── model_chat.html         # 模型对话交互页
│   ├── model_image.html        # 文生图页
│   └── settings.html           # 设置页面
├── src-tauri/                  # Tauri 后端 (Rust)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── lib.rs              # 模块声明 + Command 注册
│       ├── app_state.rs        # 全局状态
│       ├── common/             # 公共模块（类型定义、路径管理、工具函数）
│       └── pages/              # 按页面划分的业务模块
├── website/                    # 项目官网资源
├── AGENTS.md
├── package.json
└── README.md
```

完整开发文档见 [doc/dev_doc.md](./doc/dev_doc.md)，涵盖架构设计、IPC 通信、Command 列表、页面交互、跨平台处理等详细信息。

---

## 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 桌面框架 | [Tauri](https://v2.tauri.app/) | 2.11.2 | 轻量级桌面应用框架 |
| 后端语言 | Rust | 2021 edition | 高性能、内存安全 |
| 前端 | 原生 HTML/CSS/JavaScript | - | 无框架依赖 |
| 页面架构 | iframe 嵌入 + postMessage | - | 主窗口与子页面通信 |
| 硬件检测 | [tauri-plugin-hwinfo](https://github.com/nikolchaa/tauri-plugin-hwinfo) | 0.2.3 | CPU/内存/GPU 信息 |
| 系统信息 | [sysinfo](https://github.com/GuillaumeGomez/sysinfo) | 0.33 | 跨平台系统信息 |
| HTTP 客户端 | [reqwest](https://github.com/seanmonstar/reqwest) | 0.12 | 支持流式下载 |
| 异步运行时 | [tokio](https://github.com/tokio-rs/tokio) | 1.x | 异步 I/O |
| 序列化 | [serde](https://serde.rs/) | 1.x | 高效序列化 |
| 包管理器 | [pnpm](https://pnpm.io/) | 9+ | 快速、节省空间 |

---

## 开发命令

```bash
# 开发模式
pnpm tauri dev

# 构建生产版本
pnpm tauri build

# 清理构建目录
pnpm tauri clean

# 跨平台构建
pnpm tauri:build:windows
pnpm tauri:build:linux
pnpm tauri:build:macos

# 签名与发布
pnpm release:windows
pnpm release:macos

# 修复 macOS 已损坏提示
pnpm fix:macos
```

---

## 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

---

## 许可证

本项目基于 **MIT 许可证** 开源。详见 [LICENSE](./LICENSE) 文件。

---

## 致谢

- [llama.cpp](https://github.com/ggml-org/llama.cpp) — 高性能 LLM 推理框架
- [Tauri](https://v2.tauri.app/) — 轻量级桌面应用框架
- [hf-mirror](https://hf-mirror.com/) — 模型下载镜像支持

---

## 联系方式

- **项目地址**: https://github.com/autoDeploymentModel/adm
- **问题反馈**: [GitHub Issues](https://github.com/autoDeploymentModel/adm/issues)
- **讨论**: [GitHub Discussions](https://github.com/autoDeploymentModel/adm/discussions)
- **微信**: 
![微信](src-tauri/wx.png)

---

<div align="center">

**ADM** — 让本地大模型部署更简单

⭐ 如果这个项目对你有帮助，请给一个 Star！

</div>
