// 技能管理（Skill Manager）：
//   fetch_skill_store          — 拉取远程技能商店列表
//   install_skill              — 商店安装（下载 zip → 校验 → 解压 → 删 zip）
//   install_skill_from_zip     — 本地上传安装（校验规则 §5.3 → 解压 → 清理临时副本）
//   uninstall_skill            — 卸载技能（删除 global/project 目录）
//   list_installed_skills      — 扫描已安装技能（「我的技能」兜底，不依赖 agent server）
// 校验规则遵循 skill-development.md §4.3（规则 1-6）。
// 打包兼容两种方式：包内含唯一顶层目录（压缩目录本身）；或根级直接是 SKILL.md（压缩目录内容，
// 此时目录名取 SKILL.md frontmatter 的 name 自动创建）。
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::bail;
use crate::common::config;
use crate::common::error::AppError;
use crate::common::utils::download::download_with_resume;
use crate::pages::agent::api_debug_log;

/// 技能商店数据源
const STORE_URL: &str = "https://adm.tuduoduo.top/skills.json";
/// 下载超时
const DOWNLOAD_TIMEOUT_SECS: u64 = 300;

// ===== 返回结构 =====

#[derive(Serialize, Deserialize)]
pub struct SkillStoreItem {
    skill_name: String,
    skill_type: String,
    skill_url: String,
    skill_info: String,
}

#[derive(Serialize)]
pub struct InstallResult {
    ok: bool,
    dir: String,
    /// zip 包内实际技能目录名（商店展示名可能是中文，目录名以包内为准）
    name: Option<String>,
}

#[derive(Serialize)]
pub struct InstalledSkill {
    name: String,
    path: String,
    /// user=全局（含 ~/.claude/skills 等兼容目录）、project=当前项目
    source: String,
}

// ===== 目录解析 =====

/// 全局技能安装目录（GlobalSkillsDirs 首选路径）：
/// Windows: %LOCALAPPDATA%\admAgent\skills；macOS/Linux: ~/.config/admAgent/skills
fn global_skills_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir().map(|d| d.join("admAgent").join("skills"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        dirs::config_dir().map(|d| d.join("admAgent").join("skills"))
    }
}

/// 全局技能发现目录（安装目录 + 兼容目录），卸载/列表扫描用
fn global_skills_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(base) = global_skills_dir() {
        dirs.push(base);
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".agents").join("skills"));
        dirs.push(home.join(".claude").join("skills"));
    }
    dirs
}

/// 当前项目技能安装目录（ProjectSkillsDir 首选路径）：<workdir>/.agents/skills
fn project_skills_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let workdir = load_agent_workdir(app);
    if workdir.is_empty() {
        return None;
    }
    Some(PathBuf::from(workdir).join(".agents").join("skills"))
}

/// 读取 config.json 中的 agent_workdir（与 agent.rs 的 load_agent_workdir 同源）
fn load_agent_workdir(app: &tauri::AppHandle) -> String {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    let config_path = data_dir.join("config.json");
    if let Ok(json) = std::fs::read_to_string(&config_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
            if let Some(w) = value.get("agent_workdir").and_then(|v| v.as_str()) {
                return w.to_string();
            }
        }
    }
    String::new()
}

// ===== 错误码前缀 =====
//
// 给前端分支判断用的机器可识别前缀。后端在错误消息开头加 `[skill:<code>]`，
// 前端 parseSkillError() 按前缀分支（不再依赖中文文案是否改动），剥离前缀后展示。
//   exists  — 技能已安装，前端弹「是否覆盖」确认
//   invalid — 校验规则失败（zip 结构 / frontmatter / 大小 / 名称不一致），前端以「格式不正确」展示
fn skill_err(code: &str, msg: impl std::fmt::Display) -> AppError {
    AppError::msg(format!("[skill:{}] {}", code, msg))
}

// ===== 名称校验 =====

/// 技能目录名规则：^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$
/// 只允许字母/数字/连字符，首尾必须字母数字，不允许连续连字符
fn is_valid_skill_name(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let bytes = s.as_bytes();
    // expect_alpha_num=true 表示当前位置期待字母/数字（连字符之后）
    let mut expect_alpha_num = true;
    for (i, &b) in bytes.iter().enumerate() {
        if expect_alpha_num {
            if !b.is_ascii_alphanumeric() {
                return false;
            }
            expect_alpha_num = false;
        } else if b == b'-' {
            if i + 1 >= bytes.len() {
                return false; // 末尾连字符
            }
            expect_alpha_num = true;
        } else if !b.is_ascii_alphanumeric() {
            return false;
        }
    }
    !expect_alpha_num // 必须以字母/数字结尾
}

// ===== frontmatter 解析（轻量实现，仅用于校验） =====

/// 解析 SKILL.md 的 YAML frontmatter（`---` 包裹），返回 key → value。
/// 支持：单行值、缩进续行（多行 description）、行内注释、引号包裹值。
fn parse_frontmatter(content: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return map;
    }

    let mut key: Option<String> = None;
    let mut val = String::new();
    let flush = |map: &mut HashMap<String, String>, key: &mut Option<String>, val: &mut String| {
        if let Some(k) = key.take() {
            map.insert(k, clean_yaml_value(val));
        }
        val.clear();
    };

    for line in lines.iter().skip(1) {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(colon) = line.find(':') {
            let k = line[..colon].trim();
            // 冒号前是合法 key（小写字母/数字/连字符/下划线，无空格）才算新键，
            // 避免正文里的冒号被误判
            if !k.is_empty()
                && k.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
            {
                flush(&mut map, &mut key, &mut val);
                key = Some(k.to_string());
                val.push_str(line[colon + 1..].trim());
                continue;
            }
        }
        if key.is_some() {
            // 缩进续行（多行 description）
            if !val.is_empty() {
                val.push(' ');
            }
            val.push_str(trimmed);
        }
    }
    flush(&mut map, &mut key, &mut val);
    map
}

/// 去除 YAML 值首尾引号与行内注释
fn clean_yaml_value(v: &str) -> String {
    let v = v.trim();
    if v.is_empty() || v.starts_with('#') {
        return String::new();
    }
    // 行内注释（" #" 分隔）
    let v = match v.find(" #") {
        Some(i) => v[..i].trim(),
        None => v,
    };
    let bytes = v.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return v[1..v.len() - 1].to_string();
        }
    }
    v.to_string()
}

// ===== zip 校验与解压 =====

/// 技能包校验结果
struct ValidatedPack {
    /// 技能目录名（已通过命名校验；情况 1 = zip 文件名，情况 2 = 包内顶层目录名）
    name: String,
    /// 情况 1：zip 根级无顶层目录，解压时需包一层 name/ 目录
    needs_wrap: bool,
}

/// 校验技能包 zip（skill-development.md §4.3 规则 1-6），
/// 任一规则失败返回带「规则 N 未通过」的错误，供前端展示具体原因。
/// 兼容两种打包方式：
///   - 包内含唯一顶层目录（压缩了技能目录本身）→ 目录名以包内为准
///   - 包根级直接是 SKILL.md（压缩了目录内容而非目录本身）→ 目录名取 frontmatter 的 name
fn validate_skill_zip(zip_path: &Path) -> Result<ValidatedPack, AppError> {
    // 规则 1: 有效 zip
    let file = std::fs::File::open(zip_path)
        .map_err(|e| AppError::msg(format!("规则 1 未通过 — 无法打开 zip 文件: {}", e)))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::msg(format!("规则 1 未通过 — 文件不是有效的 zip 包: {}", e)))?;

    // 第一遍：收集顶层目录 + 根级 SKILL.md + zip-slip 检查（规则 1 / 6）
    // 顶层目录 = 目录条目 或 含子路径的条目首段；根级散文件（如 README.txt）不算顶层目录
    let mut top_dirs: Vec<String> = Vec::new();
    let mut root_has_skill_md = false;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::msg(format!("读取 zip 条目失败: {}", e)))?;
        let raw_name = entry.name().to_string();
        // 忽略 macOS 打包副产品
        if raw_name.starts_with("__MACOSX") || raw_name.ends_with(".DS_Store") {
            continue;
        }
        // 规则 6: enclosed_name 返回 None 说明路径含 ../ 或以 / 开头（路径穿越）
        let safe = entry.enclosed_name().ok_or_else(|| {
            AppError::msg("规则 6 未通过 — 包内存在非法路径（../ 或绝对路径）")
        })?;
        let comps: Vec<_> = safe.components().collect();
        if comps.len() == 1 {
            // 根级条目：SKILL.md 标记为情况 1；根级目录算顶层目录
            let top = comps[0].as_os_str().to_string_lossy().to_string();
            if top == "SKILL.md" {
                root_has_skill_md = true;
            } else if entry.is_dir() && !top_dirs.contains(&top) {
                top_dirs.push(top);
            }
        } else if let Some(first) = comps.first() {
            let top = first.as_os_str().to_string_lossy().to_string();
            if !top_dirs.contains(&top) {
                top_dirs.push(top);
            }
        }
    }

    // 情况 1: 根级有 SKILL.md → 用户压缩了目录内容而非目录本身，
    //         目录名以 frontmatter 的 name 为准（zip 文件名不可靠，可能为中文/随意命名），
    //         读取后与 SKILL.md 内容一起复用，解压时包一层
    // 情况 2: 根目录唯一 → 用户压缩了技能目录本身，目录名以包内为准
    let mut root_skill_content: Option<String> = None;
    let (name, needs_wrap) = if root_has_skill_md {
        let mut content = String::new();
        let mut skill_md = archive.by_name("SKILL.md").map_err(|_| {
            AppError::msg("规则 3 未通过 — 缺少 zip 根级的 SKILL.md")
        })?;
        std::io::Read::read_to_string(&mut skill_md, &mut content)
            .map_err(|e| AppError::msg(format!("规则 3 未通过 — 读取 SKILL.md 失败: {}", e)))?;
        let fm = parse_frontmatter(&content);
        let fm_name = fm
            .get("name")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::msg("规则 4 未通过 — SKILL.md frontmatter 缺少 name 字段"))?;
        root_skill_content = Some(content);
        (fm_name.to_string(), true)
    } else if top_dirs.len() == 1 {
        (top_dirs[0].clone(), false)
    } else {
        bail!("规则 1 未通过 — zip 根目录必须唯一（当前 {} 个顶层目录）", top_dirs.len());
    };

    // 规则 2: 目录名匹配命名规则
    if !is_valid_skill_name(&name) {
        bail!("规则 2 未通过 — 目录名「{}」不符合命名规则（仅允许小写字母/数字/连字符）", name);
    }

    // 规则 3: 包内存在 SKILL.md（情况 1 已在判定时读取，情况 2 读 <顶层目录>/SKILL.md）
    let fm = match root_skill_content {
        Some(c) => parse_frontmatter(&c),
        None => {
            let skill_md_name = format!("{}/SKILL.md", name);
            let mut skill_md = archive
                .by_name(&skill_md_name)
                .map_err(|_| AppError::msg(format!("规则 3 未通过 — 缺少 {}/SKILL.md", skill_md_name)))?;
            let mut content = String::new();
            std::io::Read::read_to_string(&mut skill_md, &mut content)
                .map_err(|e| AppError::msg(format!("规则 3 未通过 — 读取 SKILL.md 失败: {}", e)))?;
            parse_frontmatter(&content)
        }
    };

    // 规则 4: frontmatter 可解析，name/description 存在；
    // 情况 1 目录名即 name（判定时已取用），情况 2 需与顶层目录名一致
    let fm_name = fm
        .get("name")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg("规则 4 未通过 — SKILL.md frontmatter 缺少 name 字段"))?;
    let desc = fm
        .get("description")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg("规则 4 未通过 — SKILL.md frontmatter 缺少 description 字段"))?;
    if !needs_wrap && fm_name != name {
        bail!("规则 4 未通过 — frontmatter 的 name（{}）与目录名（{}）不一致", fm_name, name);
    }

    // 规则 5: name ≤64 字符、description ≤1024 字符
    if fm_name.chars().count() > 64 {
        bail!("规则 5 未通过 — name 超过 64 字符");
    }
    if desc.chars().count() > 1024 {
        bail!("规则 5 未通过 — description 超过 1024 字符");
    }

    Ok(ValidatedPack { name, needs_wrap })
}

/// 解压 zip 到目标目录（保留目录结构；enclosed_name 已做 zip-slip 防护）。
/// wrap 为 Some(name) 时（情况 1 无顶层目录的包），全部内容解压到 dest_root/<name>/ 下。
fn extract_zip_safe(zip_path: &Path, dest_root: &Path, wrap: Option<&str>) -> Result<(), AppError> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| AppError::msg(format!("打开 zip 文件失败: {}", e)))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::msg(format!("解析 zip 文件失败: {}", e)))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::msg(format!("读取 zip 条目失败: {}", e)))?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        // 跳过 macOS 打包副产品（与 validate_skill_zip 保持一致，避免残留垃圾目录）
        if raw_name.starts_with("__MACOSX") || raw_name.ends_with(".DS_Store") {
            continue;
        }
        let outpath = entry
            .enclosed_name()
            .ok_or_else(|| AppError::msg("解压失败: 包内存在非法路径"))?;
        let dest = match wrap {
            Some(name) => dest_root.join(name).join(outpath),
            None => dest_root.join(outpath),
        };
        if !dest.starts_with(dest_root) {
            bail!("解压失败: 路径越界 {}", outpath.display());
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::msg(format!("创建目录失败: {}", e)))?;
        }
        let mut outfile = std::fs::File::create(&dest)
            .map_err(|e| AppError::msg(format!("创建文件失败: {}", e)))?;
        std::io::copy(&mut entry, &mut outfile)
            .map_err(|e| AppError::msg(format!("写入文件失败: {}", e)))?;
    }
    Ok(())
}

// ===== 安装公共流程 =====

/// 校验 → 解压（暂存目录 → 原子 rename）→ 清理 zip。
/// target: "global" | "project"；overwrite=true 时先删旧目录再安装。
/// expected_name: 商店传入的 skill_name（本地上传为 None）。不为 None 时要求
/// 商店名、zip 顶层目录名、SKILL.md frontmatter 的 name 三方一致，否则拒绝安装。
async fn install_zip_common(
    app: &tauri::AppHandle,
    zip_path: &Path,
    target: &str,
    overwrite: bool,
    delete_zip: bool,
    expected_name: Option<&str>,
) -> Result<InstallResult, AppError> {
    // 1. 校验技能包（规则 1-6），失败即返回带 [skill:invalid] 前缀的错误（供前端分支）
    let pack = validate_skill_zip(zip_path).map_err(|e| skill_err("invalid", e))?;
    let name = pack.name;
    // 2. 商店名强一致：skill_name == zip 顶层目录名 == SKILL.md 的 name
    if let Some(expect) = expected_name {
        if expect != name.as_str() {
            api_debug_log(|| {
                format!("Skills ! 名称不一致: 商店名={} 包内目录名={}", expect, name)
            });
            return Err(skill_err(
                "invalid",
                format!(
                    "规则 4 未通过 — 商店名「{}」与包内目录名「{}」不一致（SKILL.md 的 name 必须与两者相同）",
                    expect, name
                ),
            ));
        }
    }

    // 2. 目标目录
    let skills_root = match target {
        "global" => global_skills_dir().ok_or_else(|| AppError::msg("无法确定全局技能目录"))?,
        "project" => project_skills_dir(app)
            .ok_or_else(|| AppError::msg("未配置项目工作目录，无法安装到当前项目"))?,
        other => bail!("无效的安装位置: {}", other),
    };

    // 3. 重复安装检查
    let final_dir = skills_root.join(&name);
    if final_dir.exists() && !overwrite {
        api_debug_log(|| format!("Skills ! 安装冲突: 目录已存在 {}", final_dir.display()));
        return Err(skill_err("exists", "已存在，是否覆盖？"));
    }

    // 4. 解压到暂存目录后原子改名，避免失败留下半成品目录
    std::fs::create_dir_all(&skills_root)
        .map_err(|e| AppError::msg(format!("创建技能目录失败: {}", e)))?;
    let staging = skills_root.join(format!(".adm_skill_tmp_{}_{}", std::process::id(), name));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| AppError::msg(format!("创建暂存目录失败: {}", e)))?;
    if let Err(e) = extract_zip_safe(zip_path, &staging, pack.needs_wrap.then_some(name.as_str())) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if overwrite && final_dir.exists() {
        std::fs::remove_dir_all(&final_dir)
            .map_err(|e| AppError::msg(format!("删除旧技能目录失败: {}", e)))?;
    }
    if final_dir.exists() {
        // 非覆盖模式下到这里说明目录被并发创建，直接报错
        let _ = std::fs::remove_dir_all(&staging);
        api_debug_log(|| format!("Skills ! 安装冲突(并发): 目录已存在 {}", final_dir.display()));
        return Err(skill_err("exists", "已存在，是否覆盖？"));
    }
    // extract_zip_safe 在两种情况都将技能内容放到 staging/<name>/ 下：
    //   needs_wrap=true  — wrap 参数包一层 <name>
    //   needs_wrap=false — zip 本身顶层目录即 <name>
    // 因此移动 staging/<name> → final_dir，而非 staging → final_dir（后者会导致
    // skills_root/<name>/<name>/SKILL.md 双层嵌套，list_installed_skills 扫描不到）
    let content_dir = staging.join(&name);
    if !content_dir.is_dir() {
        let _ = std::fs::remove_dir_all(&staging);
        bail!("解压失败: 未找到技能目录「{}」", name);
    }
    std::fs::rename(&content_dir, &final_dir).map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        AppError::msg(format!("移动到目标目录失败: {}", e))
    })?;
    // 清理暂存目录中可能残留的其他内容
    let _ = std::fs::remove_dir_all(&staging);
    api_debug_log(|| format!("Skills: 安装成功 name={} dir={} overwrite={}", name, final_dir.display(), overwrite));

    // 5. 删除 zip 临时文件
    if delete_zip {
        let _ = std::fs::remove_file(zip_path);
    }

    Ok(InstallResult {
        ok: true,
        dir: final_dir.to_string_lossy().to_string(),
        name: Some(name),
    })
}

// ===== Tauri 命令 =====

/// 拉取远程技能商店列表（10s 超时，避免 CORS 走 Rust 端）
#[tauri::command]
pub async fn fetch_skill_store() -> Result<Vec<SkillStoreItem>, AppError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get(STORE_URL)
        .send()
        .await
        .map_err(|e| format!("加载技能商店失败: {}", e))?;
    if !response.status().is_success() {
        bail!("加载技能商店失败，服务器返回: {}", response.status());
    }
    let items = response
        .json::<Vec<SkillStoreItem>>()
        .await
        .map_err(|e| AppError::msg(format!("解析技能商店数据失败: {}", e)))?;
    api_debug_log(|| format!("Skills: fetch_skill_store OK count={}", items.len()));
    Ok(items)
}

/// 商店安装：下载 zip（.part 断点续传）→ 校验 → 解压 → 删 zip
#[tauri::command]
pub async fn install_skill(
    app: tauri::AppHandle,
    skill_url: String,
    skill_name: String,
    target: String,
    overwrite: Option<bool>,
) -> Result<InstallResult, AppError> {
    // 下载到进程内临时目录
    let tmp_dir = std::env::temp_dir().join(format!("adm_skill_dl_{}", std::process::id()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| AppError::msg(format!("创建临时目录失败: {}", e)))?;
    let zip_path = tmp_dir.join("skill.zip");
    let part_path = tmp_dir.join("skill.zip.part");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let dl_result = download_with_resume(&client, &skill_url, &zip_path, &part_path, |_, _, _| {})
        .await;
    let result = match dl_result {
        Ok(()) => {
            let size = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
            api_debug_log(|| format!("Skills: install_skill 下载完成 url={} bytes={}", skill_url, size));
            // 商店名必须与包内目录名/SKILL.md name 一致，否则拒绝安装
            install_zip_common(
                &app,
                &zip_path,
                &target,
                overwrite.unwrap_or(false),
                true,
                Some(&skill_name),
            )
            .await
        }
        Err(e) => {
            api_debug_log(|| format!("Skills ! install_skill 下载失败 url={} err={}", skill_url, e));
            let _ = std::fs::remove_file(&zip_path);
            let _ = std::fs::remove_file(&part_path);
            Err(e)
        }
    };
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// 本地上传安装：校验规则（§5.3）→ 解压 → 清理临时副本（不改动用户原文件）。
/// target 为 None 时仅做规则校验（供前端先校验、通过后再弹位置选择）。
#[tauri::command]
pub async fn install_skill_from_zip(
    app: tauri::AppHandle,
    zip_path: String,
    target: Option<String>,
    overwrite: Option<bool>,
) -> Result<InstallResult, AppError> {
    let src = PathBuf::from(&zip_path);
    if !src.exists() {
        bail!("技能包文件不存在: {}", zip_path);
    }
    // 大小上限 50MB（设计文档 §5.1）
    let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
    if size > 50 * 1024 * 1024 {
        api_debug_log(|| format!("Skills ! install_skill_from_zip 过大 zip={} bytes={}", zip_path, size));
        return Err(skill_err("invalid", "技能包过大（最大 50MB）"));
    }

    // 先校验（两段式流程第一步：校验通过后前端才弹安装位置选择）
    let pack = validate_skill_zip(&src).map_err(|e| skill_err("invalid", e))?;
    let Some(target) = target else {
        api_debug_log(|| format!("Skills: install_skill_from_zip 校验通过(仅校验) zip={} name={}", zip_path, pack.name));
        return Ok(InstallResult {
            ok: true,
            dir: String::new(),
            name: Some(pack.name),
        });
    };
    api_debug_log(|| format!("Skills: install_skill_from_zip 校验通过 zip={} name={} target={}", zip_path, pack.name, target));

    // 复制到进程内临时目录，校验/解压全程操作副本，用户原文件不受影响
    let tmp_dir = std::env::temp_dir().join(format!("adm_skill_upload_{}", std::process::id()));
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| AppError::msg(format!("创建临时目录失败: {}", e)))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp_zip = tmp_dir.join(format!("pack_{}.zip", stamp));
    std::fs::copy(&src, &tmp_zip)
        .map_err(|e| AppError::msg(format!("复制技能包失败: {}", e)))?;

    let result = install_zip_common(&app, &tmp_zip, &target, overwrite.unwrap_or(false), true, None)
        .await;
    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// 卸载技能：删除对应目录（system 内置技能不在此列，前端不显示卸载按钮）
#[tauri::command]
pub async fn uninstall_skill(
    app: tauri::AppHandle,
    skill_name: String,
    target: String,
) -> Result<bool, AppError> {
    if !is_valid_skill_name(&skill_name) {
        bail!("无效的技能名称");
    }

    let mut removed = false;
    match target.as_str() {
        "global" => {
            for dir in global_skills_dirs() {
                let p = dir.join(&skill_name);
                if p.exists() {
                    std::fs::remove_dir_all(&p)
                        .map_err(|e| AppError::msg(format!("删除技能目录失败: {}", e)))?;
                    api_debug_log(|| format!("Skills: uninstall_skill 已删除 dir={}", p.display()));
                    removed = true;
                }
            }
        }
        "project" => {
            if let Some(dir) = project_skills_dir(&app) {
                let p = dir.join(&skill_name);
                if p.exists() {
                    std::fs::remove_dir_all(&p)
                        .map_err(|e| AppError::msg(format!("删除技能目录失败: {}", e)))?;
                    api_debug_log(|| format!("Skills: uninstall_skill 已删除 dir={}", p.display()));
                    removed = true;
                }
            }
        }
        other => bail!("无效的安装位置: {}", other),
    }
    if !removed {
        api_debug_log(|| format!("Skills ! uninstall_skill 未找到技能 name={} target={}", skill_name, target));
        bail!("未找到技能「{}」", skill_name);
    }
    Ok(true)
}

/// 扫描已安装技能目录（「我的技能」兜底数据源，不依赖 agent server）。
/// target: "global" | "project" | None（全部）
#[tauri::command]
pub async fn list_installed_skills(
    app: tauri::AppHandle,
    target: Option<String>,
) -> Result<Vec<InstalledSkill>, AppError> {
    let mut out: Vec<InstalledSkill> = Vec::new();

    let scan = |dirs: Vec<PathBuf>, source: &str, out: &mut Vec<InstalledSkill>| {
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string())
                else {
                    continue;
                };
                if !is_valid_skill_name(&name) {
                    continue;
                }
                if !path.join("SKILL.md").exists() {
                    continue;
                }
                out.push(InstalledSkill {
                    name,
                    path: path.to_string_lossy().to_string(),
                    source: source.to_string(),
                });
            }
        }
    };

    match target.as_deref() {
        Some("global") => scan(global_skills_dirs(), "user", &mut out),
        Some("project") => {
            if let Some(dir) = project_skills_dir(&app) {
                scan(vec![dir], "project", &mut out);
            }
        }
        None => {
            scan(global_skills_dirs(), "user", &mut out);
            if let Some(dir) = project_skills_dir(&app) {
                scan(vec![dir], "project", &mut out);
            }
        }
        Some(other) => bail!("无效的安装位置: {}", other),
    }
    api_debug_log(|| format!("Skills: list_installed_skills OK count={}", out.len()));
    Ok(out)
}
