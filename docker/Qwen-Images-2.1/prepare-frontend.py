#!/usr/bin/env python3
"""去掉 ComfyUI 前端里的「模板」入口（镜像构建阶段运行）。

背景：本镜像的模板库已裁剪为只剩 Qwen-Image-2.1 的文生图 / 图像编辑两条（见
prepare-templates.py），模板入口与「工作流」列表重复，且首开时会自动弹出模板对话框，
容易让用户误入。前端 1.53.x 没有配置项可以关掉模板入口，只能在构建时打补丁：

1. 注入 CSS：隐藏左侧栏的「模板」按钮（组件带 `templates-tab-button` 类）
2. 替换 JS：去掉顶部工作流菜单里的「模板」条目（`Comfy.BrowseTemplates` 命令保留，
   命令面板/快捷键仍可用，只是默认 UI 不再暴露入口）

补丁是幂等的、失败只告警不阻塞构建：前端升级后类名/片段变化时最多是入口重新出现，
不会让界面坏掉。

用法： prepare-frontend.py [--root <前端包目录>] [--dry-run]
"""

import argparse
from pathlib import Path

CSS_MARKER = "adm-hide-templates-entry"

CSS_SNIPPET = f"""
    <!-- ADM: 隐藏侧边栏「模板」入口（模板库已裁剪为仅 Qwen-Image-2.1，统一从「工作流」使用） -->
    <style id="{CSS_MARKER}">
      [class*="templates-tab-button"] {{ display: none !important; }}
    </style>
"""

# 顶部工作流菜单里的模板条目（minified 片段，前后文见 GraphView-*.js）
JS_ENTRY = (
    "{...c(`Comfy.BrowseTemplates`),label:s(`sideToolbar.templates`),icon:`icon-[comfy--template]`},{separator:!0}"
)
JS_ENTRY_REPLACED = "{separator:!0}"


def locate_static(root: Path | None) -> Path | None:
    if root is not None:
        static = root / "static" if (root / "static").is_dir() else root
        return static if static.is_dir() else None
    try:
        import comfyui_frontend_package  # pyright: ignore[reportMissingImports]
    except Exception:  # noqa: BLE001
        return None
    pkg_dir = getattr(comfyui_frontend_package, "__file__", None)
    if not pkg_dir:
        return None
    static = Path(pkg_dir).parent / "static"
    return static if static.is_dir() else None


def patch_index_html(static: Path, dry_run: bool) -> str:
    index = static / "index.html"
    if not index.exists():
        return "index.html 不存在"
    html = index.read_text(encoding="utf-8")
    if CSS_MARKER in html:
        return "CSS 已注入（跳过）"
    if "</head>" not in html:
        return "index.html 结构异常（无 </head>），跳过"
    if dry_run:
        return "将注入 CSS"
    index.write_text(html.replace("</head>", CSS_SNIPPET + "  </head>", 1), encoding="utf-8")
    return "已注入 CSS"


def patch_js_assets(static: Path, dry_run: bool) -> str:
    assets = static / "assets"
    if not assets.is_dir():
        return "assets 目录不存在"
    patched, skipped = 0, 0
    for f in sorted(assets.glob("*.js")):
        text = f.read_text(encoding="utf-8", errors="ignore")
        if JS_ENTRY not in text:
            continue
        if dry_run:
            patched += 1
            continue
        f.write_text(text.replace(JS_ENTRY, JS_ENTRY_REPLACED), encoding="utf-8")
        patched += 1
    if patched == 0:
        skipped = 1
    return f"菜单条目：改写 {patched} 个文件" + ("（未找到片段，跳过）" if skipped else "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", help="前端包目录（默认自动定位已安装的 comfyui_frontend_package）")
    ap.add_argument("--dry-run", action="store_true", help="只报告不写入")
    args = ap.parse_args()

    static = locate_static(Path(str(args.root)) if args.root else None)
    if static is None:
        print("[prepare-frontend] 未找到 comfyui_frontend_package/static，跳过")
        return 0

    css_result = patch_index_html(static, args.dry_run)
    js_result = patch_js_assets(static, args.dry_run)
    print(f"[prepare-frontend] {static}")
    print(f"[prepare-frontend] 侧边栏模板按钮：{css_result}")
    print(f"[prepare-frontend] 顶部菜单模板项：{js_result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
