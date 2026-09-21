#!/usr/bin/env python3
"""整理 ComfyUI 自带的官方工作流模板（镜像构建阶段运行）。

做两件事：
1. **裁剪模板库**：只保留 Qwen-Image-2.1 的「文生图 / 图像编辑（图生图）」两个模板，
   其余模板（Z-Image、Flux、Krea、各类 API 模型、视频/3D…）的工作流 JSON、预览图
   与演示媒体一并删除 —— 那些模型文件不在镜像里，留着只会让用户看到「缺失模型 / 无效输入」。
2. **改写保留的模板**：官方模板引用 Comfy-Org 的 safetensors 版扩散模型，改成
   ComfyUI-GGUF 的 `UnetLoaderGGUF` 节点并指向镜像内置的 `qwen-image-2.1-Q4_K_M.gguf`，
   同时清掉节点上的官方模型登记信息（否则界面仍会提示"缺失模型"并可点击下载）。

模板在 pip 里是拆成多个包发布的（comfyui-workflow-templates ≥ 0.11 起）：
    comfyui_workflow_templates_core   —— manifest.json：所有模板的登记表（id / bundle / 资源清单）
    comfyui_workflow_templates_json   —— templates/<id>.json：工作流本体
    comfyui_workflow_templates_media_* —— templates/<name>-N.webp：预览图与演示媒体
所以裁剪以 manifest 为准：先按保留清单筛出条目，再删掉各包里没被引用的文件。

保留清单见 KEEP_IDS；用法：prepare-templates.py [--root <site-packages 目录>]（--root 仅本地测试用）。
失败不阻塞构建：调用方用 `|| echo warn` 兜底。
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

GGUF = "qwen-image-2.1-Q4_K_M.gguf"
TEXT_ENCODER = "qwen3vl_8b_int8_convrot.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"

# 只保留这两个（Qwen-Image-2.1 文生图 / 图像编辑）
KEEP_IDS = ("image_qwen_image_2_1_t2i", "image_qwen_image_2_1_image_edit")

CORE_PACKAGE = "comfyui_workflow_templates_core"
JSON_PACKAGE = "comfyui_workflow_templates_json"
BUNDLE_PACKAGES = {
    "media-api": "comfyui_workflow_templates_media_api",
    "media-video": "comfyui_workflow_templates_media_video",
    "media-image": "comfyui_workflow_templates_media_image",
    "media-other": "comfyui_workflow_templates_media_other",
    "media-assets-01": "comfyui_workflow_templates_media_assets_01",
    "media-assets-02": "comfyui_workflow_templates_media_assets_02",
}
# 与模板无关、但界面还要用的 JSON（模板分类 logo 索引）
KEEP_EXTRA_JSON = ("index_logo.json",)

NOTE_PREFIX = (
    "## 本镜像内置模型（ADM Docker 镜像）\n"
    f"- 扩散模型：`{GGUF}`（GGUF 量化，由 Unet Loader (GGUF) 节点加载）\n"
    f"- 文本编码器：`{TEXT_ENCODER}`（CLIPLoader，type = qwen_image）\n"
    f"- VAE：`{VAE}`\n\n"
)


# ===== 一、改写保留的模板 =====

def iter_nodes(wf: "dict[str, Any]"):
    """遍历顶层节点与所有子图内的节点"""
    for node in wf.get("nodes", []):
        yield node
    for sg in (wf.get("definitions") or {}).get("subgraphs", []):
        for node in sg.get("nodes", []):
            yield node


def patch_loaders(wf) -> int:
    """UNETLoader → UnetLoaderGGUF，并清掉官方的 safetensors 模型登记信息"""
    changed = 0
    for node in iter_nodes(wf):
        if node.get("type") != "UNETLoader":
            continue
        node["type"] = "UnetLoaderGGUF"
        node["properties"] = {"Node name for S&R": "UnetLoaderGGUF"}
        node["widgets_values"] = [GGUF]
        node["widgets_values_named"] = {"unet_name": GGUF}
        changed += 1
    return changed


def patch_subgraph_widgets(wf) -> int:
    """子图实例上暴露的 unet_name（widgets_values / widgets_values_named 两处）"""
    changed = 0
    for node in wf.get("nodes", []):
        named = node.get("widgets_values_named")
        if not isinstance(named, dict) or "unet_name" not in named:
            continue
        named["unet_name"] = GGUF
        idx = list(named.keys()).index("unet_name")
        values = node.get("widgets_values")
        if isinstance(values, list) and idx < len(values):
            values[idx] = GGUF
        changed += 1
    return changed


def patch_notes(wf) -> int:
    """MarkdownNote：补充内置模型清单，并把官方 safetensors 条目换成内置 gguf"""
    official_links = (
        "- [qwen_image_2.1_bf16.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_bf16.safetensors)\n"
        "- [qwen_image_2.1_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors)"
    )
    official_tree = "│   │   ├── qwen_image_2.1_bf16.safetensors\n│   │   └── qwen_image_2.1_int8_convrot.safetensors"

    changed = 0
    for node in wf.get("nodes", []):
        if node.get("type") != "MarkdownNote":
            continue
        title = node.get("title") or ""

        def convert(text: str) -> str:
            text = text.replace(official_links, f"- {GGUF}（本镜像内置的 GGUF 量化）")
            text = text.replace(official_tree, f"│   │   └── {GGUF}")
            return text

        named = node.get("widgets_values_named")
        if isinstance(named, dict) and isinstance(named.get("text"), str):
            text = convert(named["text"])
            if title == "Note: Usage" and NOTE_PREFIX not in text:
                text = NOTE_PREFIX + text
            named["text"] = text
        values = node.get("widgets_values")
        if isinstance(values, list):
            new_values = []
            for v in values:
                if isinstance(v, str):
                    v = convert(v)
                    if title == "Note: Usage" and NOTE_PREFIX not in v:
                        v = NOTE_PREFIX + v
                new_values.append(v)
            node["widgets_values"] = new_values
        changed += 1
    return changed


def verify(wf) -> "str | None":
    """图里不能残留官方 safetensors 扩散模型引用（注记文本不参与校验）"""
    chunks = []
    for node in iter_nodes(wf):
        chunks.append(json.dumps(node.get("widgets_values") or [], ensure_ascii=False))
        chunks.append(json.dumps(node.get("widgets_values_named") or {}, ensure_ascii=False))
        chunks.append(json.dumps((node.get("properties") or {}).get("models") or [], ensure_ascii=False))
    dump = "\n".join(chunks)
    for name, want in (("gguf 扩散模型", GGUF), ("文本编码器", TEXT_ENCODER), ("VAE", VAE)):
        if want not in dump:
            return f"{name} 未引用内置文件 {want}"
    if "qwen_image_2.1_int8_convrot.safetensors" in dump or "qwen_image_2.1_bf16.safetensors" in dump:
        return "仍引用官方 safetensors 扩散模型"
    return None


# ===== 二、定位各 bundle 包 =====

def find_site_packages(root: "Path | None") -> "Path | None":
    """返回 site-packages 目录（默认从已安装的模板包反查）"""
    if root is not None:
        return root if root.is_dir() else None
    for pkg in (CORE_PACKAGE, JSON_PACKAGE, "comfyui_workflow_templates"):
        try:
            module = __import__(pkg)
        except Exception:  # noqa: BLE001
            continue
        if getattr(module, "__file__", None):
            return Path(module.__file__).parent.parent
    return None


def templates_dir(site_packages: Path, package: str) -> Path:
    return site_packages / package / "templates"


# ===== 三、裁剪模板库（只留 KEEP_IDS） =====

def prune(site_packages: Path) -> "tuple[int, int, list[dict[str, Any]]]":
    """按 manifest 裁剪模板库，返回 (删除文件数, 保留模板数, 保留条目)"""
    manifest_path = site_packages / CORE_PACKAGE / "manifest.json"
    if not manifest_path.exists():
        print(f"[prepare-templates] 未找到模板登记表 {manifest_path}，跳过裁剪")
        return 0, 0, []

    manifest: "dict[str, Any]" = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = manifest.get("templates") or []
    kept = [e for e in entries if e.get("id") in KEEP_IDS]
    if not kept:
        print(f"[prepare-templates] 登记表里没有 Qwen-Image-2.1 模板（{len(entries)} 条），跳过裁剪")
        return 0, 0, []

    # 保留清单：JSON 包按 <id>.json，媒体包按登记的资源文件名
    keep: "dict[str, set[str]]" = {JSON_PACKAGE: {f"{e['id']}.json" for e in kept} | set(KEEP_EXTRA_JSON)}
    for entry in kept:
        package = BUNDLE_PACKAGES.get(str(entry.get("bundle") or ""))
        if not package:
            continue
        keep.setdefault(package, set()).update(
            a["filename"] for a in entry.get("assets") or [] if a.get("filename")
        )

    removed = 0
    for package in (JSON_PACKAGE, *BUNDLE_PACKAGES.values()):
        d = templates_dir(site_packages, package)
        if not d.is_dir():
            continue
        names = keep.get(package, set())
        for f in sorted(d.iterdir()):
            # 只删文件：logo/ 之类的子目录保留（index_logo.json 引用的品牌图标，共约 1MB）
            if not f.is_file() or f.name in names or f.name.startswith("__"):
                continue
            f.unlink()
            removed += 1

    manifest["templates"] = kept
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False) + "\n", encoding="utf-8")
    return removed, len(kept), kept


def rewrite(site_packages: Path, entry: "dict[str, Any]") -> str:
    """把保留的模板改写成使用内置 GGUF 模型"""
    path = templates_dir(site_packages, JSON_PACKAGE) / f"{entry['id']}.json"
    if not path.exists():
        return f"缺失 {path.name}，跳过"
    wf = json.loads(path.read_text(encoding="utf-8"))
    n_unet = patch_loaders(wf)
    n_widget = patch_subgraph_widgets(wf)
    n_note = patch_notes(wf)
    problem = verify(wf)
    if problem:
        return f"校验失败：{problem}"
    path.write_text(json.dumps(wf, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return f"已改写（UNETLoader→UnetLoaderGGUF {n_unet} 处, 子图参数 {n_widget} 处, 注记 {n_note} 处）"


def selfcheck(site_packages: Path) -> "str | None":
    """用模板包自己的 API 复验：能列出的模板只剩保留项，且资源都能取到"""
    try:
        from comfyui_workflow_templates import get_asset_path, iter_templates  # pyright: ignore[reportMissingImports]
    except Exception:  # noqa: BLE001 - 本地 --root 测试时可能没装该包
        return None
    try:
        templates = list(iter_templates())
    except Exception as exc:  # noqa: BLE001
        return f"列举模板失败：{exc}"
    ids = sorted(t.template_id for t in templates)
    if ids != sorted(KEEP_IDS):
        return f"模板清单异常：{ids}"
    for t in templates:
        for a in t.assets:
            try:
                get_asset_path(t.template_id, a.filename)
            except Exception as exc:  # noqa: BLE001
                return f"{t.template_id} 的资源 {a.filename} 无法解析：{exc}"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", help="site-packages 目录（默认自动定位已安装的模板包）")
    args = ap.parse_args()

    site_packages = find_site_packages(Path(str(args.root)) if args.root else None)
    if site_packages is None:
        print("[prepare-templates] 未找到 comfyui_workflow_templates 各 bundle 包，跳过")
        return 0
    print(f"[prepare-templates] 模板包目录：{site_packages}")

    removed, n_kept, kept = prune(site_packages)
    if not kept:
        return 0
    print(f"[prepare-templates] 模板裁剪：删除 {removed} 个模板资源文件，保留 {n_kept} 个模板")

    failed = 0
    for entry in kept:
        result = rewrite(site_packages, entry)
        print(f"[prepare-templates] {entry['id']}: {result}")
        if "失败" in result or "缺失" in result:
            failed += 1

    problem = selfcheck(site_packages)
    if problem:
        print(f"[prepare-templates] 复验失败：{problem}", file=sys.stderr)
        failed += 1
    else:
        print(f"[prepare-templates] 复验通过：模板库只剩 {n_kept} 个 Qwen-Image-2.1 模板，资源齐全")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
