<div align="center">

# ADM

**Automatic Deployment Model — llama.cpp 图形化管理桌面应用**

![Tauri](https://img.shields.io/badge/Tauri-2.11.2-FFC131?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-2021_edition-000000?style=flat-square&logo=rust)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)

简体中文

</div>

---

## 📖 项目简介

ADM (Automatic Deployment Model) 是一款基于 Tauri 2.x 构建的 llama.cpp 图形化管理工具。它将 llama.cpp 复杂的 CLI 启动指令通过简洁的 GUI 界面化配置，让用户能够便捷地在本地部署和运行大语言模型。

**核心特性：**
- 🖥️ **图形化界面** — 告别繁琐的命令行，点选即可配置和启动模型
- 📥 **一键下载** — 支持断点续传、下载进度实时显示
- 🚀 **一键启动** — 可视化配置启动参数，自动拼接 CLI 指令
- 📊 **硬件监控** — 实时显示内存、显存、CPU 信息
- 💬 **模型交互** — 内嵌 Web 界面，启动后直接与模型对话
- 🔄 **断点续传** — 下载中断后自动恢复，无需重新下载
- 🌐 **国内镜像** — 自动替换 HuggingFace 为国内镜像，加速下载

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
| Windows | Windows 10/11 64位 |
| Linux | 支持 GTK3 的桌面环境 |
| macOS | macOS 10.15+ |

### 下载安装

从 [Releases](https://github.com/your-username/adm/releases) 页面下载对应平台的安装包：

- **Windows**: `ADM_0.1.0_x64-setup.exe`
- **Linux**: `adm_0.1.0_amd64.deb` 或 `adm-0.1.0-x86_64.AppImage`
- **macOS**: `ADM_0.1.0_x64.dmg`

> **提示**：llama-server 可执行文件已打包在安装包内，无需额外下载。

### 从源码构建

#### 前置条件

- [Rust](https://www.rust-lang.org/) (推荐使用 rustup 安装)
- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)

#### 构建步骤

```bash
# 1. 克隆仓库
git clone https://github.com/your-username/adm.git
cd adm

# 2. 安装前端依赖
pnpm install

# 3. 放置 llama-server 可执行文件
# 将 llama-server 放入以下对应目录：
#   src-tauri/llamacpp/windows/llama-server.exe
#   src-tauri/llamacpp/linux/llama-server
#   src-tauri/llamacpp/mac/llama-server

# 4. 开发模式运行
pnpm tauri dev

# 5. 构建生产版本
pnpm tauri build
```

> **注意**：llama-server 可执行文件需要自行从 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) 下载，并将其放置到 `src-tauri/llamacpp/{platform}/` 目录下。

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
3. 系统自动读取保存的启动参数，调用 llama-server
4. 启动成功后，按钮变为 **查看模型** + **关闭模型**
5. 点击 **查看模型** 进入聊天交互界面
6. 点击 **关闭模型** 停止 llama-server 进程

### 参数配置

在设置页面中可以可视化配置以下参数：

- **基础参数**：上下文大小、预测 token 数、批处理大小等
- **GPU 参数**：GPU 层数（支持 auto/all/数字/自定义）
- **性能参数**：线程数、Flash Attention、KV 缓存类型等
- **采样参数**：温度、Top-K/Top-P/Min-P、重复惩罚
- **服务参数**：监听端口、监听地址

参数修改后点击 **保存设置**，下次启动模型时自动生效。

---

## 📂 项目结构

```
adm/
├── doc/                              # 项目文档
│   ├── dev_doc.md                    # 开发文档
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
│   ├── capabilities/
│   │   └── default.json              # 权限配置
│   └── src/
│       ├── main.rs                   # 入口
│       └── lib.rs                    # 核心逻辑（AppState、Commands）
├── models/                           # 模型文件存放目录（运行时创建）
├── package.json
├── AGENTS.md
└── .gitignore
```

---

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | [Tauri](https://v2.tauri.app/) 2.11.2 |
| 后端语言 | Rust 2021 edition |
| 前端 | 原生 HTML/CSS/JavaScript |
| 页面架构 | iframe 嵌入 + postMessage 通信 |
| 硬件检测 | [tauri-plugin-hwinfo](https://github.com/nikolchaa/tauri-plugin-hwinfo) 0.2.3 |
| 系统信息 | [sysinfo](https://github.com/GuillaumeGomez/sysinfo) 0.33 |
| HTTP 下载 | [reqwest](https://github.com/seanmonstar/reqwest) 0.12 |
| 异步运行时 | [tokio](https://github.com/tokio-rs/tokio) 1.x |
| 包管理器 | [pnpm](https://pnpm.io/) |

---

## 📋 开发文档

详细开发文档见 [doc/dev_doc.md](./doc/dev_doc.md)，涵盖：

- 架构设计与数据流
- 前后端 IPC 通信机制
- Rust Command 完整列表与实现要点
- 页面设计与交互逻辑
- Tauri 配置与权限管理
- 跨平台处理方案
- 安全考虑与性能优化

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

# 查看构建产物
pnpm tauri build && ls src-tauri/target/release/bundle/
```

---

## 📄 许可证

本项目基于 MIT 许可证开源。详见 [LICENSE](./LICENSE) 文件。

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
- [Modelscope](https://modelscope.cn/) — 模型下载镜像支持