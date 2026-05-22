<div align="center">

# ADM

**Automatic Deployment Model — llama.cpp 图形化管理桌面应用**

![Tauri](https://img.shields.io/badge/Tauri-2.11.2-FFC131?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-2021_edition-000000?style=flat-square&logo=rust)
![Version](https://img.shields.io/badge/version-0.1.2-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)

[简体中文](./README.md) | [English](./README_EN.md)

</div>

---

## 📖 项目简介

ADM (Automatic Deployment Model) 是一款基于 **Tauri 2.x** 构建的 llama.cpp 图形化管理工具。它将 llama.cpp 复杂的 CLI 启动指令通过简洁的 GUI 界面化配置，让用户能够便捷地在本地部署和运行大语言模型。

> 💡 **轻量高效** — 基于 Tauri 构建，前端采用原生 HTML/CSS/JS，无重型框架依赖，AI时代，原生才是最高效的，启动速度快。

### 核心特性

| 特性 | 描述 |
|------|------|
| 🖥️ **图形化界面** | 告别繁琐的命令行，点选即可配置和启动模型 |
| 📥 **一键下载** | 支持断点续传、下载进度实时显示 |
| 🚀 **一键启动** | 可视化配置启动参数 |
| 📊 **硬件监控** | 实时显示内存、显存、CPU 信息 |
| 💬 **模型交互** | 内嵌 Web 界面，启动后直接与模型对话，支持接入本地各种agent工具，信息安全有保证 |
| 🔄 **断点续传** | 下载中断后自动恢复，无需重新下载 |
| 🌐 **国内镜像** | 自动替换 HuggingFace 为国内镜像，加速下载 |
| 📦 **自动更新** | 静默检查更新，有新版本时提示下载 |

---

## 📸 界面预览

```
┌──────────────────────────────────────────────────────────────┐
│  ADM                                                  _ □ X  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────── 模型列表 ────────────────────────────────────────┐ │
│  │ 模型名称    │ 大小   │ 内存  │ 工具 │ 推理 │ 图片 │ 状态 │ │
│  │─────────────┼────────┼───────┼──────┼──────┼──────┼──────│ │
│  │ Qwen3.5-9B  │ 5.6GB  │ 32GB  │ 支持 │ 支持 │ 不支持 │可用│ │
│  │ ...         │ ...    │ ...   │ ...  │ ...  │ ...   │ ...│ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ☰首页 │ ⚙设置 │ 内存 32GB │ 显存 11GB(RTX 4090) │ CPU 8C/16T │
└──────────────────────────────────────────────────────────────┘
```

---

## 🚀 快速开始

### 系统要求

| 平台 | 要求 |
|------|------|
| **Windows** | Windows 10/11 64位 |
| **Linux** | 支持 GTK3 的桌面环境 |
| **macOS** | macOS 10.15+ |

### 下载安装

从 [Releases](https://github.com/your-username/adm/releases) 页面下载对应平台的安装包：

| 平台 | 安装包 |
|------|--------|
| Windows | `ADM_0.1.2_x64-setup.exe` |
| Linux | `adm_0.1.2_amd64.deb` 或 `adm-0.1.2-x86_64.AppImage` |
| macOS | `ADM_0.1.2_x64.dmg` |

> ✅ **提示**：`llama-server` 可执行文件已打包在安装包内，无需额外下载。

### 从源码构建

#### 前置条件

| 工具 | 版本 | 说明 |
|------|------|------|
| Rust | 1.70+ | [安装指南](https://www.rust-lang.org/tools/install) |
| Node.js | 18+ | [官网下载](https://nodejs.org/) |
| pnpm | 8+ | `npm install -g pnpm` |
| Tauri 系统依赖 | - | [官方文档](https://v2.tauri.app/start/prerequisites/) |

#### 构建步骤

```bash
# 1. 克隆仓库
git clone https://github.com/autoDeploymentModel/adm.git
cd adm

# 2. 安装前端依赖
pnpm install

# 3. 放置 llama-server 可执行文件
#    从 https://github.com/ggml-org/llama.cpp/releases 下载预编译版本
#    放入对应目录：
#      src-tauri/llamacpp/windows/llama-server.exe
#      src-tauri/llamacpp/linux/llama-server
#      src-tauri/llamacpp/mac/llama-server

# 4. 开发模式运行
pnpm tauri dev

# 5. 构建生产版本
pnpm tauri build
```

---

## 🎯 功能指南

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

### 参数配置

在设置页面中可以可视化配置以下参数：

| 参数组 | 参数 | 说明 |
|--------|------|------|
| **基础参数** | 上下文大小、预测 token 数、批处理大小、微批次大小 | 影响推理性能 |
| **GPU 参数** | GPU 层数 | `auto` / `all` / `0` / 自定义数字 |
| **性能参数** | 线程数、Flash Attention、KV 缓存类型、内存锁定/映射 | 优化运行效率 |
| **采样参数** | 温度、Top-K、Top-P、Min-P、重复惩罚 | 控制输出质量 |
| **服务参数** | 监听端口、监听地址 | 网络配置 |

参数修改后点击 **保存设置**，下次启动模型时自动生效。

### 自动更新

- 应用启动时静默检查更新（3 秒延迟）
- 有新版本时弹出更新提示，显示当前版本、最新版本、更新说明
- 设置页面支持手动点击"检查新版本"

---

## 📂 项目结构

```
adm/
├── doc/                              # 项目文档
│   ├── dev_doc.md                    # 开发文档（详细架构与实现）
│   ├── llamacpp.txt                  # llama.cpp 参数参考
│   └── progect_doc.txt               # 需求文档
├── src/                              # 前端资源
│   ├── index.html                    # 主框架页（外壳容器 + iframe + 硬件信息栏）
│   ├── model_list.html               # 模型列表页
│   ├── model_chat.html               # 模型对话交互页
│   └── settings.html                 # 设置页面
├── src-tauri/                        # Tauri 后端
│   ├── Cargo.toml                    # Rust 依赖配置
│   ├── tauri.conf.json               # Tauri 核心配置
│   ├── tauri.windows.conf.json       # Windows 平台配置
│   ├── tauri.linux.conf.json         # Linux 平台配置
│   ├── tauri.macos.conf.json         # macOS 平台配置
│   ├── capabilities/
│   │   └── default.json              # 权限配置
│   ├── icons/                        # 应用图标
│   ├── llamacpp/                     # llama.cpp 可执行文件
│   │   ├── windows/llama-server.exe
│   │   ├── linux/llama-server
│   │   └── mac/llama-server
│   └── src/
│       ├── main.rs                   # 入口（仅包含 run() 调用）
│       └── lib.rs                    # 核心逻辑（AppState、Commands）
├── models/                           # 模型文件存放目录（运行时创建）
│   ├── {model_id}.gguf               # 已下载的模型文件
│   └── {model_id}.gguf.part          # 下载未完成的临时文件
├── config.json                       # 启动参数配置文件（运行时创建）
├── package.json
├── pnpm-lock.yaml
├── AGENTS.md
└── .gitignore
```

---

## 🛠️ 技术栈

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
| 包管理器 | [pnpm](https://pnpm.io/) | - | 快速、节省空间 |

---

## 📋 开发文档

详细开发文档见 [doc/dev_doc.md](./doc/dev_doc.md)，涵盖：

- ✅ 架构设计与数据流
- ✅ 前后端 IPC 通信机制
- ✅ Rust Command 完整列表与实现要点
- ✅ 页面设计与交互逻辑
- ✅ Tauri 配置与权限管理
- ✅ 跨平台处理方案
- ✅ 安全考虑与性能优化
- ✅ 调试技巧与常见问题
- ✅ 未来规划

---

## 📦 核心 Command 列表

| Command | 功能 | 说明 |
|---------|------|------|
| `get_system_info` | 获取系统硬件信息 | 内存、显存、CPU |
| `scan_local_models` | 扫描本地已下载模型 | 返回 model_id 列表 |
| `scan_part_files` | 扫描未完成的下载 | 支持断点续传 |
| `fetch_model_list` | 获取远程模型列表 | `https://adm.tuduoduo.top/model.json` |
| `download_model` | 下载模型 | 支持断点续传、进度事件 |
| `start_model` | 启动模型 | 拼接 CLI 参数，隐藏控制台 |
| `stop_model` | 停止模型 | 终止 llama-server 进程 |
| `get_model_status` | 获取当前运行状态 | 检查进程是否存活 |
| `save_settings` | 保存启动参数配置 | 写入 `config.json` |
| `load_settings` | 加载启动参数配置 | 读取 `config.json` |
| `get_app_version` | 获取应用版本 | 从 `tauri.conf.json` |
| `get_llamacpp_version` | 获取 llama.cpp 版本 | 执行 `--version` |
| `check_update` | 检查更新 | 版本号比较 |

---

## 🐛 常见问题

### Q: llama-server 找不到？

**A**: 确保 `llama-server` 可执行文件已放置到对应平台目录：
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

---

## 🤝 贡献指南

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
pnpm tauri build --target x86_64-pc-windows-msvc   # Windows
pnpm tauri build --target x86_64-unknown-linux-gnu # Linux
pnpm tauri build --target x86_64-apple-darwin      # macOS
```

---

## 📄 许可证

本项目基于 **MIT 许可证** 开源。详见 [LICENSE](./LICENSE) 文件。

```
MIT License

Copyright (c) 2024 ADM

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

---

## 🙏 致谢

- [llama.cpp](https://github.com/ggml-org/llama.cpp) — 高性能 LLM 推理框架
- [Tauri](https://v2.tauri.app/) — 轻量级桌面应用框架
- [hf-mirror](https://hf-mirror.com/) — 模型下载镜像支持

---

## 📞 联系方式

- **项目地址**: https://github.com/autoDeploymentModel/adm
- **问题反馈**: [GitHub Issues](https://github.com/autoDeploymentModel/adm/issues)
- **讨论**: [GitHub Discussions](https://github.com/autoDeploymentModel/adm/discussions)

---

<div align="center">

**ADM** — 让本地大模型部署更简单

⭐ 如果这个项目对你有帮助，请给一个 Star！

</div>
