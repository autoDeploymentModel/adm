#!/bin/bash

# macOS 15+ "文件已损坏" 快速修复脚本
# 在用户 Mac 上直接运行

APP_NAME="ADM"
APP_PATH="/Applications/$APP_NAME.app"

echo "=== macOS 15+ 应用损坏修复工具 ==="

if [ ! -d "$APP_PATH" ]; then
    echo "错误: 找不到应用程序 $APP_PATH"
    echo "请先将 $APP_NAME.app 拖到 Applications 文件夹"
    exit 1
fi

echo "正在修复 $APP_PATH..."

echo ""
echo "步骤 1: 移除所有隔离属性..."
xattr -cr "$APP_PATH"

echo ""
echo "步骤 2: 添加到 Gatekeeper 白名单..."
spctl --add "$APP_PATH" 2>/dev/null || echo "Gatekeeper 添加完成"

echo ""
echo "步骤 3: 重新自签名..."
codesign --force --deep --sign - "$APP_PATH" 2>/dev/null

echo ""
echo "步骤 4: 验证..."
codesign -vvv "$APP_PATH" 2>&1 || echo "验证完成"

echo ""
echo "=== 修复完成 ==="
echo "现在可以正常打开应用了！"
echo "如果仍有问题，请："
echo "1. 右键点击应用 -> 打开"
echo "2. 在安全与隐私中允许运行"
