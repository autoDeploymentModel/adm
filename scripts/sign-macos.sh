#!/bin/bash

APP_NAME="ADM"
APP_PATH="src-tauri/target/release/bundle/macos/$APP_NAME.app"
ENTITLEMENTS_PATH="src-tauri/entitlements.plist"

echo "=== macOS 自签名脚本 ==="

if [ ! -d "$APP_PATH" ]; then
    echo "错误: 找不到应用程序 $APP_PATH"
    echo "请先运行: pnpm tauri build"
    exit 1
fi

echo "1. 移除隔离属性..."
xattr -cr "$APP_PATH"

echo "2. 使用 entitlements.plist 进行自签名..."
codesign --force --deep --sign - --entitlements "$ENTITLEMENTS_PATH" "$APP_PATH"

echo "3. 验证签名..."
codesign -vvv "$APP_PATH"

echo ""
echo "=== 签名完成 ==="
echo "应用位置: $APP_PATH"
echo ""
echo "如果仍有问题，可以尝试："
echo "  右键点击应用 -> 打开"
echo "  或运行: xattr -cr /Applications/$APP_NAME.app"
