// 统一日志封装 — 所有前端调试日志通过 Rust 端 api_debug_log 写入 adm_api_debug.log
// 格式: {epoch_ms} {HH:MM:SS.mmm 本地时间} UI: [CATEGORY][level] message
// Rust 端 api_debug_log 负责加时间戳，前端只传 [CATEGORY][level] message
//
// 不依赖 store.js：直接用 window.__adm_invoke 避免循环依赖
// （store.js imports log, log 不能同时 import store）

var _invoke = window.__adm_invoke;

var LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
// 默认静默（99），由 agent.js init 中 setLogEnabled(!!S.settings.debug_logging) 开启
// 避免模块加载阶段在未开启调试模式时写日志文件
var currentLevel = 99;

export function setLogEnabled(enabled) {
  currentLevel = enabled ? 0 : 99;
}

function write(level, category, msg) {
  if (LEVELS[level] < currentLevel) return;
  var line = "[" + category + "][" + level + "] " + msg;
  console.log("[agent][" + category + "] " + msg);
  if (_invoke) _invoke("agent_debug_log", { line: line }).catch(function() {});
}

export const log = {
  debug: function(cat, msg) { write("debug", cat, msg); },
  info:  function(cat, msg) { write("info", cat, msg); },
  warn:  function(cat, msg) { write("warn", cat, msg); },
  error: function(cat, msg) { write("error", cat, msg); },
};
