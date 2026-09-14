// LSP 启动失败检测与修复（三层）：
//  T1 自动安装：命令白名单在 Rust 端（agent_lsp_fix），目标列表由 agent_lsp_fix_targets 提供
//  T2 安装指引：不可自动安装的服务器（二进制发行版 / 系统包管理器 / 随 SDK）给出推荐命令 + 文档
//  T3 AI 安装：把安装任务交给当前会话的 agent（bash + 网络）兜底任意语言
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { api } from "./api.js";
import { log } from "./log.js";
import { showInfo, showWarning, reportError } from "./ui.js";
import { loadTools, renderToolsList } from "./tools.js";
import { sendMessageWithText } from "./send.js";

// T2：推荐安装方式与官方文档（Rust 白名单之外的常见服务器）
var LSP_GUIDES = {
  clangd: { hint: "winget install LLVM.LLVM / brew install llvm / apt install clangd", url: "https://clangd.llvm.org/installation" },
  lua_ls: { hint: "brew install lua-language-server / scoop install lua-language-server（或下载 GitHub Releases）", url: "https://luals.github.io/" },
  zls: { hint: "下载 GitHub Releases（版本需与 Zig 匹配）", url: "https://github.com/zigtools/zls" },
  dartls: { hint: "安装 Dart SDK 后自带 dart 分析器", url: "https://dart.dev/get-dart" },
  elixirls: { hint: "下载 GitHub Releases（需 Erlang/Elixir 环境）", url: "https://github.com/elixir-lsp/elixir-ls" },
  metals: { hint: "cs install metals（需先安装 coursier）", url: "https://scalameta.org/metals/docs/editors/new-editor/" },
  kotlin_language_server: { hint: "下载 GitHub Releases 并加入 PATH", url: "https://github.com/fwcd/kotlin-language-server" },
  omnisharp: { hint: "下载 GitHub Releases（或随 VS Code C# 扩展安装）", url: "https://github.com/OmniSharp/omnisharp-roslyn" },
  sourcekit: { hint: "macOS 随 Xcode 命令行工具提供", url: "https://github.com/swiftlang/sourcekit-lsp" },
  phpactor: { hint: "composer global require phpactor/phpactor", url: "https://phpactor.readthedocs.io/" },
  nil_ls: { hint: "nix profile install nixpkgs#nil", url: "https://github.com/oxalica/nil" },
  lemminx: { hint: "下载 GitHub Releases（需 Java 运行时）", url: "https://github.com/eclipse-lemminx/lemminx" },
};

// 触发 /lsps/start 的探测文件扩展名（需能被 DetectLanguage 识别为该语言）
var LSP_PROBE_EXT = {
  rust_analyzer: ".rs",
  gopls: ".go",
  vtsls: ".ts",
  pyright: ".py",
  basedpyright: ".py",
  pylsp: ".py",
  bashls: ".sh",
  svelte: ".svelte",
  vue_ls: ".vue",
  intelephense: ".php",
  dockerls: ".dockerfile",
  sqlls: ".sql",
  sqls: ".sql",
  emmet_ls: ".html",
  taplo: ".toml",
  texlab: ".tex",
  cmake: ".cmake",
  solargraph: ".rb",
};

var AUTO_FIX_KEY = "agent_lsp_auto_fix";
var AUTO_FIX_INTERVAL_MS = 30 * 60 * 1000;
var NOTICE_INTERVAL_MS = 10 * 60 * 1000;

var fixTargets = null;        // name -> { command, requires }（来自 Rust 端白名单）
var fixTargetsLoading = null;
var fixInFlight = {};
var lastFixAttemptAt = {};
var lastNoticeAt = {};

/** 拉取 Rust 端可自动安装的 LSP 列表（缓存，只失败时重试） */
export function ensureFixTargets() {
  if (fixTargets) return Promise.resolve(fixTargets);
  if (fixTargetsLoading) return fixTargetsLoading;
  fixTargetsLoading = invoke("agent_lsp_fix_targets").then(function(list) {
    var map = {};
    (list || []).forEach(function(t) {
      if (t && t.name) map[t.name] = { command: t.command || "", requires: t.requires || "" };
    });
    fixTargets = map;
    fixTargetsLoading = null;
    // 首屏 loadTools 早于本列表返回：补一次重绘，否则「修复」按钮要等下次刷新才出现
    renderToolsList();
    return map;
  }).catch(function(e) {
    log.debug("LSP", "获取自动修复目标失败: " + e);
    fixTargets = {};
    fixTargetsLoading = null;
    renderToolsList();
    return fixTargets;
  });
  return fixTargetsLoading;
}

export function isLspFixable(name) {
  return !!(fixTargets && fixTargets[name]);
}

export function fixTarget(name) {
  return (fixTargets && fixTargets[name]) || null;
}

export function guideFor(name) {
  return LSP_GUIDES[name] || null;
}

export function isLspAutoFixEnabled() {
  try { return localStorage.getItem(AUTO_FIX_KEY) === "1"; } catch (_) { return false; }
}

export function setLspAutoFixEnabled(on) {
  try { localStorage.setItem(AUTO_FIX_KEY, on ? "1" : "0"); } catch (_) {}
}

/** LSP 状态事件入口（sse.js 在 lsp_event/state_changed 时调用）；state: 3=错误。
 *  errorType 为服务端分类：not_installed 表示二进制未安装（工具面板已隐藏该
 *  条目）。该分类不影响自动安装开关（开启时仍会安装缺失的二进制），只是不再
 *  弹"启动失败"提示——未安装不是故障；startup_failed 才提示。 */
export function onLspStateEvent(name, state, errorText, errorType) {
  if (!name || state !== 3) return;
  if (!fixTargets) {
    ensureFixTargets().then(function() { onLspStateEvent(name, state, errorText, errorType); });
    return;
  }
  var now = Date.now();
  var reason = errorText ? String(errorText) : _t("未知原因");

  if (isLspFixable(name) && isLspAutoFixEnabled()) {
    if (fixInFlight[name]) return;
    if (now - (lastFixAttemptAt[name] || 0) < AUTO_FIX_INTERVAL_MS) return;
    // 记录尝试时间由 runLspFix 统一维护：修复失败会把时间戳归零，下次报错即可重试
    showInfo(name + _t(" 启动失败，正在自动安装修复…"));
    runLspFix(name, { auto: true });
    return;
  }

  // 未安装且未开启自动修复：条目已从列表隐藏，不打扰用户
  if (errorType === "not_installed") return;

  if (now - (lastNoticeAt[name] || 0) < NOTICE_INTERVAL_MS) return;
  lastNoticeAt[name] = now;
  var hint = _t("（可在「工具」→ LSP 页用「AI 安装」）");
  if (isLspFixable(name)) hint = _t("（可在「工具」→ LSP 页一键修复）");
  else if (guideFor(name)) hint = _t("（可在「工具」→ LSP 页查看安装指引）");
  showWarning(name + _t(" 启动失败：") + reason + hint);
}

/** T1：执行自动修复（安装 → 触发启动 → 刷新面板） */
export async function runLspFix(name, opts) {
  opts = opts || {};
  if (!isLspFixable(name) || fixInFlight[name]) return false;
  fixInFlight[name] = true;
  try {
    var target = fixTarget(name) || {};
    log.debug("LSP", "修复 " + name + "：执行 " + (target.command || ""));
    await invoke("agent_lsp_fix", { lspName: name });
    var started = await triggerLspStart(name);
    await loadTools();
    if (started) {
      // 修复成功后抑制本会话内的重复自动安装（避免误判反复重装）
      lastFixAttemptAt[name] = Date.now();
      showInfo(name + _t(" 已修复并启动"));
    } else {
      // 未就绪（安装失败 / 服务端未在探测窗口内就绪）：清零时间戳，下次报错可重试
      lastFixAttemptAt[name] = 0;
      showWarning(name + _t(" 已安装，但服务尚未就绪；打开对应文件时会再次自动启动"));
    }
    return started;
  } catch (e) {
    lastFixAttemptAt[name] = 0;
    reportError(e, { prefix: name + _t(" 修复失败：") });
    return false;
  } finally {
    fixInFlight[name] = false;
  }
}

/** T3：把安装任务交给当前会话的 agent（兜底任意语言/任意安装方式） */
export function runAiInstall(name, errorText) {
  var prompt = _t("请帮我安装并配置语言服务器「") + name + _t("」，让它能正常启动。当前失败原因：") +
    (errorText ? String(errorText) : _t("未知原因")) +
    _t("。请选择合适的包管理器安装（npm/pip/go/cargo 等），安装完成后验证 LSP 能否正常启动。");
  sendMessageWithText(prompt);
}

/** 触发 LSP 启动并等待就绪：覆盖服务端"启动失败后 30s 内不再尝试"的冷却窗口 */
async function triggerLspStart(name) {
  var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
  if (!wsId) return false;
  var dir = (S.workspaceInfo && S.workspaceInfo.path) || "";
  var canProbe = !!dir && dir !== "默认";
  var ext = LSP_PROBE_EXT[name] || "";
  var sep = dir.indexOf("\\") >= 0 ? "\\" : "/";

  for (var i = 0; i < 4; i++) {
    if (canProbe) {
      var probePath = dir + sep + "__lsp_start__" + ext;
      try {
        await api("POST", "/v1/workspaces/" + wsId + "/lsps/start", { path: probePath });
      } catch (e) {
        log.debug("LSP", "触发启动失败: " + e);
      }
    }
    var state = await waitLspSettled(wsId, name, 6000);
    if (state === 2 || state === 1) return true;
    await new Promise(function(resolve) { setTimeout(resolve, 3000); });
  }
  return false;
}

/** 轮询目标 LSP 状态：ready(2) 立即返回，starting(1)/未知 继续等，超时返回最后状态 */
async function waitLspSettled(wsId, name, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  var last = null;
  while (Date.now() < deadline) {
    last = await readLspState(wsId, name);
    if (last === 2) return 2;
    if (last !== 1 && last !== null) return last;
    await new Promise(function(resolve) { setTimeout(resolve, 1000); });
  }
  return last;
}

async function readLspState(wsId, name) {
  try {
    var states = await api("GET", "/v1/workspaces/" + wsId + "/lsps");
    if (states && states[name]) return states[name].state;
  } catch (_) {}
  return null;
}
