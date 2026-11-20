// LSP 状态与修复统一走 admAgent API：
//  - GET /v1/lsp/catalog 提供可安装项、fix/guide
//  - POST /v1/lsp/fix    创建安装/修复 job
//  - GET /v1/lsp/jobs/{id} 轮询进度
//  - POST /v1/workspaces/{id}/lsps/{lsp}/start 启动
import { t as _t } from "../../i18n.js";
import { S } from "./store.js";
import { api } from "./api.js";
import { log } from "./log.js";
import { showInfo, showWarning, showError, reportError } from "./ui.js";
import { getErrorMessage } from "./error.js";
import { loadTools, renderToolsList } from "./tools.js";
import { sendMessageWithText } from "./send.js";

var NOTICE_INTERVAL_MS = 10 * 60 * 1000;
var JOB_POLL_MS = 700;
var JOB_TIMEOUT_MS = 120 * 1000;

var catalog = null;
var catalogLoading = null;
var fixInFlight = {};
var lastNoticeAt = {};

export function isFixInFlight(name) {
  return !!fixInFlight[name];
}

export function ensureFixTargets() {
  if (catalog) return Promise.resolve(catalog);
  if (catalogLoading) return catalogLoading;
  catalogLoading = api("GET", "/v1/lsp/catalog").then(function(resp) {
    var map = {};
    ((resp && resp.servers) || []).forEach(function(entry) {
      if (entry && entry.name) map[entry.name] = entry;
    });
    catalog = map;
    catalogLoading = null;
    renderToolsList();
    return map;
  }).catch(function(e) {
    log.debug("LSP", "获取托管 LSP 目录失败: " + e);
    catalog = {};
    catalogLoading = null;
    renderToolsList();
    return catalog;
  });
  return catalogLoading;
}

export function isLspFixable(name, liveFix) {
  var fix = liveFix || (catalog && catalog[name] && catalog[name].fix);
  return !!(fix && fix.kind && fix.kind !== "none");
}

export function fixTarget(name) {
  var entry = catalog && catalog[name];
  if (!entry) return null;
  var fix = entry.fix || {};
  var labels = {
    install_server: _t("安装"),
    upgrade_server: _t("升级"),
    reinstall: _t("重新安装"),
    repair: _t("重新安装"),
    retry: _t("重试安装"),
    rollback: _t("回滚版本"),
  };
  var label = labels[fix.kind] || fix.kind || "";
  return {
    command: label ? label + (fix.version ? " " + fix.version : "") : "",
    requires: fix.runtime || "",
    fix: fix,
    guide: entry.guide || null,
  };
}

export function guideFor(name, liveGuide) {
  var entry = catalog && catalog[name];
  var guide = liveGuide || (entry && entry.guide);
  if (guide) {
    return { hint: guide.note || guide.command || "", url: guide.url || "" };
  }
  return null;
}

export function onLspStateEvent(name, state, errorText, errorType, liveReason, liveFix, liveGuide) {
  if (!name || state !== 3) return;
  if (!catalog) {
    ensureFixTargets().then(function() { onLspStateEvent(name, state, errorText, errorType, liveReason, liveFix, liveGuide); });
    return;
  }
  var now = Date.now();
  var reason = errorText ? String(errorText) : (liveReason ? String(liveReason) : _t("未知原因"));

  if (errorType === "not_installed") return;
  if (now - (lastNoticeAt[name] || 0) < NOTICE_INTERVAL_MS) return;
  lastNoticeAt[name] = now;
  var hint = _t("（可在「工具」→ LSP 页用「AI 安装」）");
  if (isLspFixable(name, liveFix)) hint = _t("（可在「工具」→ LSP 页一键修复）");
  else if (guideFor(name, liveGuide)) hint = _t("（可在「工具」→ LSP 页查看安装指引）");
  showWarning(name + _t(" 启动失败：") + reason + hint);
}

export async function runLspFix(name) {
  if (!catalog || !catalog[name] || fixInFlight[name]) return false;
  var wsId = S.serverInfo ? S.serverInfo.workspace_id : "";
  if (!wsId) return false;
  fixInFlight[name] = true;
  try {
    var target = fixTarget(name);
    if (!target) target = { command: "", requires: "", fix: null, guide: null };
    var action = (target.fix && target.fix.kind) || "repair";
    if (action === "install_runtime" || action === "upgrade_runtime") {
      showWarning(name + _t(" 需要托管运行时，当前版本尚未支持自动下载，请查看安装指引"));
      return false;
    }
    if (action === "none") return false;
    log.debug("LSP", "修复 " + name + "：API action=" + action);
    var jobResp = await api("POST", "/v1/lsp/fix", {
      workspace_id: wsId,
      name: name,
      action: action,
      confirm: true,
    });
    if (!jobResp || !jobResp.job_id) {
      reportError(new Error("missing job_id"), { prefix: name + _t(" 修复失败：") });
      return false;
    }
    var job = await waitLspJob(wsId, jobResp.job_id, name);
    if (!job) {
      showWarning(name + _t(" 安装仍在后台进行，完成后会自动刷新"));
      return false;
    }
    if (job.status !== "succeeded") {
      // 安装失败的原因（npm/pip 输出、网络错误等）是用户排查的唯一线索，
      // 不能走 reportError——中文界面会把英文细节整段丢弃，只剩"操作失败，任务中断"。
      // 与 index.html 应用升级失败的处理一致：直接展示原始错误文本，并附 job
      // 日志尾行（单行拼接，消息区不支持多行渲染）。
      var msg = job.error || job.reason || _t("安装任务失败");
      var tail = logTailLines(job.log_tail, 3);
      showError(name + _t(" 修复失败：") + getErrorMessage(msg) + (tail ? "｜" + tail : ""));
      return false;
    }
    await startLspByName(wsId, name);
    var started = await waitLspSettled(wsId, name, 6000);
    await loadTools();
    if (started === 2 || started === 1) {
      showInfo(name + _t(" 已修复并启动"));
      return true;
    }
    showWarning(name + _t(" 已安装，但服务尚未就绪；打开对应文件时会再次自动启动"));
    return false;
  } catch (e) {
    reportError(e, { prefix: name + _t(" 修复失败：") });
    return false;
  } finally {
    fixInFlight[name] = false;
  }
}

export function runAiInstall(name, errorText) {
  var prompt = _t("请帮我安装并配置语言服务器「") + name + _t("」，让它能正常启动。当前失败原因：") +
    (errorText ? String(errorText) : _t("未知原因")) +
    _t("。请选择合适的包管理器安装（npm/pip/go/cargo 等），安装完成后验证 LSP 能否正常启动。");
  sendMessageWithText(prompt);
}

async function startLspByName(wsId, name) {
  try {
    await api("POST", "/v1/workspaces/" + wsId + "/lsps/" + encodeURIComponent(name) + "/start", {});
  } catch (e) {
    log.debug("LSP", "按名称启动失败: " + e);
  }
}

async function waitLspJob(wsId, jobId, name) {
  var deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      var job = await api("GET", "/v1/lsp/jobs/" + encodeURIComponent(jobId) + "?workspace_id=" + encodeURIComponent(wsId));
      if (job && (job.status === "succeeded" || job.status === "failed" || job.status === "canceled")) {
        return job;
      }
      // 轮询期间把 phase 进度刷到「安装/修复」按钮上（列表可能被 SSE 重绘，
      // 每次按 data-lsp-name 重查，重绘后也能继续更新）。
      if (job && job.status === "running") {
        var label = job.message || _t("安装中...");
        if (job.percent) label += " " + job.percent + "%";
        updateFixButton(name, label);
      }
    } catch (e) {
      log.debug("LSP", "读取安装 job 失败: " + e);
    }
    await new Promise(function(resolve) { setTimeout(resolve, JOB_POLL_MS); });
  }
  return null;
}

function updateFixButton(name, text) {
  var escaped = window.CSS && window.CSS.escape ? window.CSS.escape(name) : name;
  var btn = document.querySelector('#agent-tools-list .tool-fix-btn[data-lsp-name="' + escaped + '"]');
  if (btn && btn instanceof HTMLButtonElement) {
    btn.textContent = text;
    btn.disabled = true;
  }
}

// 取 job 日志尾的非空行（跳过 "$ npm ..." 命令回显行），单行拼接通用于消息区
function logTailLines(logTail, max) {
  if (!logTail) return "";
  var lines = String(logTail).trim().split("\n");
  var out = [];
  for (var i = lines.length - 1; i >= 0 && out.length < max; i--) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "$") continue;
    out.unshift(line);
  }
  return out.join(" | ");
}

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
