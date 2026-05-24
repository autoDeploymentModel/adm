#!/bin/bash

APP_NAME="ADM"
APP_PATH="src-tauri/target/release/bundle/macos/$APP_NAME.app"
ENTITLEMENTS_PATH="src-tauri/entitlements.plist"

echo "=== macOS 自签名脚本 (支持 macOS 15+) ==="

if [ ! -d "$APP_PATH" ]; then
    echo "错误: 找不到应用程序 $APP_PATH"
    echo "请先运行: pnpm tauri build"
    exit 1
fi

echo "1. 深度清理隔离属性和扩展属性..."
xattr -cr "$APP_PATH"
xattr -cr "$APP_PATH/Contents/MacOS/$APP_NAME" 2>/dev/null || true

echo "2. 查找并签名所有可执行文件和库..."
find "$APP_PATH" -type f -perm +111 -exec codesign --force --sign - --entitlements "$ENTITLEMENTS_PATH" {} \; 2>/dev/null

echo "3. 对应用主程序签名..."
codesign --force --deep --sign - --entitlements "$ENTITLEMENTS_PATH" --options runtime "$APP_PATH"

echo "4. 再次移除隔离属性..."
xattr -cr "$APP_PATH"

echo "5. 验证签名..."
codesign -vvv "$APP_PATH"

echo "6. 检查 Gatekeeper 状态..."
spctl -a -vvv "$APP_PATH" 2>&1 || echo "Gatekeeper 评估完成"

echo ""
echo "=== 签名完成 ==="
echo "应用位置: $APP_PATH"
echo ""
echo "macOS 15+ 用户请按以下步骤操作："
echo "1. 将应用拖到 Applications 文件夹"
echo "2. 右键点击应用 -> 打开（可能需要两次）"
echo "3. 或在终端运行："
echo "   xattr -cr /Applications/$APP_NAME.app"
echo "   spctl --add /Applications/$APP_NAME.app"
