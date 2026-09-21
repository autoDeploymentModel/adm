#!/bin/sh
# 克隆 GitHub 仓库，直连失败时自动回退国内镜像（镜像构建阶段使用）
#
# 用法： clone-repo.sh <git-ref> <目标目录> <主 URL>
# 环境变量：
#   GIT_MIRROR_PREFIXES  镜像前缀列表（空白分隔，形如 https://ghfast.top/），
#                        最终地址为 <前缀><主 URL>；设置后替换内置列表
#
# 内置镜像实测可用（git smart HTTP 可协商成功）：ghfast.top / ghproxy.net / gh-proxy.com；
# 实测不可用未收录：gitclone.com（空响应）、kkgithub.com（证书不匹配）。
set -eu

REF="$1"
DEST="$2"
PRIMARY_URL="$3"
MIRROR_PREFIXES="${GIT_MIRROR_PREFIXES:-https://ghfast.top/ https://ghproxy.net/ https://gh-proxy.com/}"

try_clone() {
    url="$1"
    echo "[git-clone] 尝试: $url（分支 $REF）"
    rm -rf "$DEST"
    mkdir -p "$(dirname "$DEST")"
    # lowSpeedLimit/Time：连接建立后 30 秒内速率低于 1KB/s 即中止，避免在坏镜像上死等
    if git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 \
        clone --depth 1 --single-branch --branch "$REF" "$url" "$DEST"; then
        return 0
    fi
    # 区分“分支不存在”（如 fork 默认分支改名）与“网络错误”：前者改用远端默认分支重试
    if ls_out="$(git ls-remote --heads "$url" "$REF" 2>/dev/null)"; then
        if [ -n "$ls_out" ]; then
            return 1
        fi
        echo "[git-clone] 远端没有分支 $REF，改用默认分支重试: $url" >&2
        rm -rf "$DEST"
        mkdir -p "$(dirname "$DEST")"
        git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 \
            clone --depth 1 --single-branch "$url" "$DEST"
        return $?
    fi
    return 1
}

set -- "$PRIMARY_URL"
for prefix in $MIRROR_PREFIXES; do
    set -- "$@" "$prefix$PRIMARY_URL"
done

ok=0
for url in "$@"; do
    [ -n "$url" ] || continue
    if try_clone "$url"; then
        ok=1
        break
    fi
    echo "[git-clone] 失败，尝试下一个地址…" >&2
done

if [ "$ok" != "1" ]; then
    echo "[git-clone] 所有地址均克隆失败: $PRIMARY_URL" >&2
    echo "[git-clone] 可改用 --build-arg COMFYUI_REPO / COMFYUI_GGUF_REPO 指定可用仓库地址，或 --build-arg GIT_MIRROR_PREFIXES 换镜像前缀" >&2
    exit 1
fi
