var _invoke = window.__adm_invoke;
var LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
var currentLevel = 2;
var queue = [];
var timer = null;
var uiSeq = 0;
var doc = null;

function documentID() {
  if (!doc) {
    try { doc = crypto.randomUUID(); } catch (_) { doc = "doc-" + Date.now() + "-" + Math.random().toString(16).slice(2); }
  }
  return doc;
}

export function setLogEnabled(enabled) { currentLevel = enabled ? 0 : 2; }

function sensitive(key) {
  key = String(key).toLowerCase().replace(/-/g, "_");
  if (["_hash","_bytes","_count","_id","_name","_pct","_tokens","_ms","_code","_reason","_source","_decision","_flags","_total"].some(function(suffix) { return key.slice(-suffix.length) === suffix; })) return false;
  return ["password","passwd","secret","api_key","apikey","authorization","cookie","credential","private_key","access_token","refresh_token","prompt","messages","content","tool_input","command","stdout","stderr","body","raw","config_value"].some(function(part) { return key.indexOf(part) >= 0; });
}
function redact(value, key) {
  if (key && sensitive(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]").slice(0, 2048);
  if (Array.isArray(value)) return value.slice(0, 20).map(function(v) { return redact(v); });
  if (value && typeof value === "object") {
    var out = {};
    Object.keys(value).forEach(function(k) { out[k] = redact(value[k], k); });
    return out;
  }
  return value;
}

function send(entries, flush) {
  if (!_invoke || !entries.length) return;
  var payload = entries.slice();
  entries.length = 0;
  _invoke("agent_debug_log_batch", { entries: payload }).catch(function() {});
}
function schedule(flush) {
  if (timer && !flush) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(function() {
    timer = null;
    if (queue.length >= 50 || flush) send(queue, true);
    else send(queue, false);
  }, flush ? 0 : 100);
}
function write(level, comp, evt, msg, attrs, trace) {
  if (LEVELS[level] < currentLevel) return;
  var entry = {
    ts_ms: Date.now(), ui_seq: ++uiSeq, doc: documentID(), origin: "ui",
    lvl: level, comp: String(comp || "ui"), evt: String(evt || "ui.log"), msg: String(msg || ""),
    attrs: redact(attrs || {}), trace: redact(trace || {})
  };
  queue.push(entry);
  if (level === "warn" || level === "error" || queue.length >= 50) schedule(true);
  else schedule(false);
}

export function flush() {
  if (!queue.length) return Promise.resolve();
  return new Promise(function(resolve) {
    schedule(true);
    setTimeout(resolve, 150);
  });
}

export const log = {
  debug: function(comp, evt, msg, attrs, trace) {
    if (msg === undefined) write("debug", comp, "ui." + comp + ".debug", evt || "");
    else write("debug", comp, evt, msg, attrs, trace);
  },
  info: function(comp, evt, msg, attrs, trace) {
    if (msg === undefined) write("info", comp, "ui." + comp + ".info", evt || "");
    else write("info", comp, evt, msg, attrs, trace);
  },
  warn: function(comp, evt, msg, attrs, trace) {
    if (msg === undefined) write("warn", comp, "ui." + comp + ".warn", evt || "");
    else write("warn", comp, evt, msg, attrs, trace);
  },
  error: function(comp, evt, msg, attrs, trace) {
    if (msg === undefined) write("error", comp, "ui." + comp + ".error", evt || "");
    else write("error", comp, evt, msg, attrs, trace);
  }
};
