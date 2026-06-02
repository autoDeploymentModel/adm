<div align="center">

# ADM

**Automatic Deployment Model — llama.cpp 图形化管理桌面应用**

![Tauri](https://img.shields.io/badge/Tauri-2.11.2-FFC131?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-2021_edition-000000?style=flat-square&logo=rust)
![Version](https://img.shields.io/badge/version-0.2.6-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)

[简体中文](./README.md) | [English](./README_EN.md)

</div>

---

## 项目简介

ADM (Automatic Deployment Model) 是一款基于 **Tauri 2.x** 构建的 llama.cpp 图形化管理工具。它将 llama.cpp 复杂的 CLI 启动指令通过简洁的 GUI 界面化配置，让用户能够便捷地在本地部署和运行大语言模型。

> 轻量高效 — 基于 Tauri 构建，前端采用原生 HTML/CSS/JS，无重型框架依赖，AI时代，原生才是最高效的，启动速度快。

### 核心特性

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

## 界面预览

```
┌──────────────────────────────────────────────────────────────┐
│  ADM                                                  _ □ X  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────── 模型列表 ────────────────────────────────────────┐ │
│  │ 模型名称    │ 大小   │ 内存  │ 工具 │ 推理 │ 图片 │ 状态 │ │
│  │─────────────┼────────┼───────┼──────┼──────┼──────┼──────│ │
│  │ Qwen3.5-9B  │ 5.6GB  │ 32GB  │ 支持 │ 支持 │ 支持 │可下载│ │
│  │ ...         │ ...    │ ...   │ ...  │ ...  │ ...  │ ... │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ☰首页 │ ⚙设置 │ 🖼文生图 │ 内存 32GB │ 显存 11GB(RTX 4090) │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 系统要求

| 平台 | 要求 |
|------|------|
| **Windows** | Windows 10/11 64位 |
| **Linux** | 支持 GTK3 的桌面环境 |
| **macOS** | macOS 10.15+ |

### 下载安装

从 [Releases](https://github.com/autoDeploymentModel/adm/releases) 页面下载对应平台的安装包：

| 平台 | 安装包 |
|------|--------|
| Windows | `ADM_0.2.6_x64-setup.exe` |
| Linux | `adm_0.2.6_amd64.deb` 或 `adm-0.2.6-x86_64.AppImage` |
| macOS | `ADM_0.2.6_x64.dmg` |

> macOS 安装后，如提示文件损坏，需打开终端执行 `xattr -cr /Applications/ADM.app` 后启动应用。

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

# 3. 开发模式运行（llama-server 将在首次启动时自动下载）
pnpm tauri dev

# 4. 构建生产版本
pnpm tauri build
```

> llama-server 可执行文件无需手动放置，应用首次运行时自动检测硬件并下载匹配的二进制文件。

---

## 功能指南

### 模型管理

1. 启动应用后，首页自动加载远程模型列表
2. 系统会检测你的硬件配置（内存 + 显存），自动判断模型是否可用
3. **不可用**的模型：下载和启动按钮均被禁用
4. **可用**的模型：
   - 点击 **下载** 按钮开始下载，实时显示进度
   - 下载完成后按钮变为 **已下载**
   - 下载中断后，按钮显示 **继续下载**，支持断点续传

### 启动模型

1. 确保模型已下载完成
2. 点击 **启动** 按钮
3. 系统自动读取保存的启动参数，调用 `llama-server`
4. 启动成功后，按钮变为 **查看模型** + **关闭模型**
5. 点击 **查看模型** 进入聊天交互界面
6. 点击 **关闭模型** 停止 `llama-server` 进程

### 文生图

支持 Stable Diffusion 模型的图形化图片生成：

1. 在模型列表页中，选择支持图片识别的模型
2. 点击 **文生图** 进入图片生成界面
3. 输入提示词，设置图片宽高
4. 系统自动检测并下载 sd-cli 二进制文件（首次使用需等待下载）
5. 点击 **生成图片**，实时查看运行日志
6. 生成完成后可查看并保存图片

### 参数配置

在设置页面中可以可视化配置以下参数：

| 参数组 | 参数 | 说明 |
|--------|------|------|
| **推荐模式** | 默认（日常聊天）/ 创意写作 / 写代码 | 一键切换采样参数组合 |
| **基础参数** | 上下文大小、预测 token 数、批处理大小、微批次大小 | 影响推理性能 |
| **GPU 参数** | GPU 层数 | `auto` / `all` / `0` / 自定义数字 |
| **性能参数** | 线程数、批处理线程数、Flash Attention、KV 缓存类型、内存锁定/映射 | 优化运行效率 |
| **采样参数** | 温度、Top-K、Top-P、Min-P、重复惩罚、DRY 惩罚、存在惩罚、频率惩罚 | 控制输出质量 |
| **推理参数** | 推理模式 | `auto` / `0` / `1` / `2` |
| **服务参数** | 监听端口、监听地址 | 网络配置 |

参数修改后点击 **保存设置**，下次启动模型时自动生效。

### 自动更新

- 应用启动时静默检查更新（3 秒延迟）
- **三重检查机制**：
  1. 检查应用版本更新
  2. 检查 VC++ 运行库是否安装（仅 Windows）
  3. 检查 llamacpp 版本并自动下载匹配的二进制文件
- 设置页面支持手动点击"检查新版本"及"下载/更新 llamacpp"

---

## 项目结构

```
adm/
├── doc/                              # 项目文档
│   ├── dev_doc.md                    # 开发文档（详细架构与实现）
│   ├── llamacpp.txt                  # llama.cpp 参数参考
├── scripts/                          # 构建与签名脚本
│   ├── build.mjs                     # Node.js 构建入口脚本
│   ├── fix-macos-damaged.sh          # macOS 修复损坏应用标记
│   ├── sign-macos.sh                 # macOS 代码签名
│   └── sign-windows.ps1              # Windows 代码签名
├── src/                              # 前端资源（Tauri frontendDist）
│   ├── index.html                    # 主框架页（外壳容器 + iframe + 底部硬件信息栏）
│   ├── model_list.html               # 模型列表页（表格展示/下载/启动/停止）
│   ├── model_chat.html               # 模型对话交互页（内嵌 WebUI + 日志面板）
│   ├── model_image.html              # 文生图页（文本输入/宽高设置/图片生成/日志）
│   └── settings.html                 # 设置页面（导航分栏 + 参数表单 + 版本/关于）
├── src-tauri/                        # Tauri 后端 (Rust)
│   ├── Cargo.toml                    # Rust 依赖配置
│   ├── build.rs                      # Tauri 构建脚本（含 Windows 子系统配置）
│   ├── tauri.conf.json               # Tauri 核心配置
│   ├── capabilities/
│   │   └── default.json              # 权限配置（Tauri 2.x capability 系统）
│   ├── entitlements.plist            # macOS 沙盒授权
│   ├── icons/                        # 应用图标
│   └── src/
│       ├── main.rs                   # 入口（Windows 隐藏控制台 + run() 调用）
│       ├── lib.rs                    # 模块声明 + tauri::Builder 配置 + command 注册
│       ├── app_state.rs              # AppState 全局状态定义
│       ├── common/
│       │   ├── mod.rs
│       │   ├── types.rs              # 公共数据结构体（SystemInfo/LaunchParams/RemoteModel 等）
│       │   ├── config.rs             # 路径管理函数（目录/文件查找）
│       │   └── utils/
│       │       ├── mod.rs
│       │       ├── platform.rs       # 跨平台工具（隐藏窗口命令、GPU 检测）
│       │       └── archive.rs        # 压缩包解压（ZIP + TAR.GZ）
│       └── pages/                    # 按前端页面划分的业务模块
│           ├── mod.rs
│           ├── index.rs              # index.html 逻辑：硬件信息、更新检查、llamacpp 下载
│           ├── model_list.rs         # model_list.html 逻辑：模型扫描/下载/启停/状态
│           ├── model_chat.rs         # model_chat.html 逻辑（无独立 command，事件驱动）
│           ├── model_image.rs        # model_image.html 逻辑：sd-cli 下载/检测/生成/停止
│           └── settings.rs           # settings.html 逻辑：配置持久化、版本查询
├── website/                          # 项目官网资源
│   ├── index.html
│   └── images/
├── AGENTS.md                         # 项目技术栈说明
├── package.json
├── pnpm-lock.yaml
├── README.md
└── .gitignore
```

---

## 技术栈

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 桌面框架 | [Tauri](https://v2.tauri.app/) | 2.11.2 | 轻量级桌面应用框架 |
| 后端语言 | Rust | 2021 edition | 高性能、内存安全 |
| 前端 | 原生 HTML/CSS/JavaScript | - | 无框架依赖，轻量高效 |
| 页面架构 | iframe 嵌入 + postMessage | - | 主窗口与子页面通信 |
| 硬件检测 | [tauri-plugin-hwinfo](https://github.com/nikolchaa/tauri-plugin-hwinfo) | 0.2.3 | CPU/内存/GPU 信息 |
| 系统信息 | [sysinfo](https://github.com/GuillaumeGomez/sysinfo) | 0.33 | 跨平台系统信息 |
| HTTP 客户端 | [reqwest](https://github.com/seanmonstar/reqwest) | 0.12 | 支持流式下载 |
| 异步运行时 | [tokio](https://github.com/tokio-rs/tokio) | 1.x | 异步 I/O |
| 序列化 | [serde](https://serde.rs/) | 1.x | 高效序列化 |
| 压缩解压 | zip + tar + flate2 | - | 纯 Rust 解压 ZIP/TAR.GZ |
| 数据编码 | base64 | 0.22 | Base64 编码 |
| 对话框 | tauri-plugin-dialog | 2.x | 系统原生对话框 |
| 包管理器 | [pnpm](https://pnpm.io/) | 9+ | 快速、节省空间 |

---

## 开发文档

详细开发文档见 [doc/dev_doc.md](./doc/dev_doc.md)，涵盖：

- 架构设计与数据流
- 前后端 IPC 通信机制
- Rust Command 完整列表与实现要点
- 页面设计与交互逻辑
- Tauri 配置与权限管理
- 跨平台处理方案
- 安全考虑与性能优化
- 调试技巧与常见问题
- 未来规划

---

## 核心 Command 列表

| Command | 功能 | 说明 |
|---------|------|------|
| `get_system_info` | 获取系统硬件信息 | 内存、显存、CPU |
| `scan_local_models` | 扫描本地已下载模型 | 返回 model_id 列表 |
| `scan_part_files` | 扫描未完成的下载 | 支持断点续传 |
| `fetch_model_list` | 获取远程模型列表 | `https://adm.tuduoduo.top/model.json` |
| `download_model` | 下载模型 | 支持断点续传、进度事件，含主模型/diffusion/vae 多文件连续下载 |
| `start_model` | 启动模型 | 拼接 CLI 参数，隐藏控制台 |
| `stop_model` | 停止模型 | 终止 llama-server 进程 |
| `get_model_status` | 获取当前运行状态 | 检查进程是否存活 |
| `get_downloading_models` | 获取下载中模型进度 | 页面切换后恢复进度显示 |
| `get_downloading_phases` | 获取下载阶段 | 获取模型当前下载的阶段性文件 |
| `save_settings` | 保存启动参数配置 | 写入 `config.json` |
| `load_settings` | 加载启动参数配置 | 读取 `config.json` |
| `get_app_version` | 获取应用版本 | 从 `tauri.conf.json` |
| `get_llamacpp_version` | 获取 llama.cpp 版本 | 执行 `--version` |
| `delete_llamacpp` | 删除 llamacpp 目录 | 重新下载时清理旧文件 |
| `check_update` | 检查更新 | 应用/VC++ 运行库/llamacpp 三重检查 |
| `download_and_extract_llamacpp` | 下载并解压 llamacpp | 自动检测硬件并下载匹配版本 |
| `get_sd_status` | 检测 sd-cli 状态 | 检查 sd-cli 可执行文件是否存在 |
| `download_and_extract_sd` | 下载并解压 sd-cli | 自动检测 GPU 型号下载匹配版本 |
| `start_sd_generation` | 启动文生图 | 调用 sd-cli 生成图片 |
| `stop_sd` | 停止文生图 | 终止 sd-cli 进程 |
| `save_sd_image_as` | 保存生成的图片 | 弹出系统对话框选择保存路径 |

---

## 常见问题

### Q: llama-server 找不到？

**A**: 应用会自动检测硬件并下载匹配的 llamacpp 二进制文件。也可在设置页手动点击"下载/更新 llamacpp"。如需手动放置，各平台路径为：
- Windows: `src-tauri/llamacpp/windows/llama-server.exe`
- Linux: `src-tauri/llamacpp/linux/llama-server`
- macOS: `src-tauri/llamacpp/mac/llama-server`

### Q: 下载中断后无法续传？

**A**: 检查 `.part` 文件是否损坏，或删除 `.part` 文件重新下载。确保服务器支持 Range 请求（HTTP 206）。

### Q: 模型启动后前端无响应？

**A**:
1. 查看 `model-log` 事件输出（浏览器 Console）
2. 检查端口 8080 是否被占用
3. 手动运行 `llama-server -m model.gguf --port 8080` 测试

### Q: 如何更换模型下载镜像？

**A**: 应用会自动将 `huggingface.co` 替换为 `hf-mirror.com`，无需手动配置。

### Q: macOS 提示"已损坏"？

**A**: 运行 `xattr -cr /Applications/ADM.app` 移除扩展属性即可。

---

## 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

### 开发命令

```bash
# 启动开发模式
pnpm tauri dev

# 构建生产版本
pnpm tauri build

# 清理构建目录
pnpm tauri clean

# 跨平台构建
pnpm tauri:build:windows   # Windows
pnpm tauri:build:linux     # Linux
pnpm tauri:build:macos     # macOS

# 签名与发布
pnpm release:windows       # Windows 签名发布
pnpm release:macos         # macOS 签名发布

# 修复 macOS 已损坏提示
pnpm fix:macos
```

---

## 许可证

本项目基于 **MIT 许可证** 开源。详见 [LICENSE](./LICENSE) 文件。

```
MIT License

Copyright (c) 2024 ADM

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, and to permit persons to whom the Software is
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

---

<div align="center">

**ADM** — 让本地大模型部署更简单

⭐ 如果这个项目对你有帮助，请给一个 Star！

</div>
