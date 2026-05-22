# 项目技术栈

## tauri 版本
- **2.11.2**

## 中文文档地址
- 官方文档: https://www.tauri.net.cn/

## 开发模式
tauri + 原生HTML/CSS/JS 
单窗口模式
路由采用html+js原生哈希路由+iframe
用的是pnpm作为包管理器

## 调试脚本命令
~~~
pnpm tauri dev
~~~

## 构建脚本命令
~~~
pnpm tauri build
~~~

## 清理构建目录
~~~
pnpm tauri clean
~~~

## 获取硬件信息插件
tauri-plugin-hwinfo 0.2.3
文档地址: https://github.com/nikolchaa/tauri-plugin-hwinfo#readme


提醒，构建用pnpm命令，后面不用加任何参数 ，直接pnpm tauri build即可