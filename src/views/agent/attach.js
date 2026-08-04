// 附件处理：选择 / 压缩 / 预览
import { t as _t } from "../../i18n.js";
import { S, invoke } from "./state.js";
import { showError, showInfo } from "./ui.js";
import { getErrorMessage } from "./error.js";

// ===== 附件处理 =====
var ATTACH_MAX_SIZE = 1 * 1024 * 1024;  // 超过此大小的图片进行压缩 (1MB)
var ATTACH_MAX_DIMENSION = 2048;         // 图片最大边长

// 扩展名 → MIME 推断：部分文件（如 .log/.md/.txt）浏览器可能上报空或
// application/octet-stream，按扩展名补齐文本类型，后端才能把内容内联进 prompt
var EXT_MIME = {
  "txt": "text/plain",
  "log": "text/plain",
  "md": "text/markdown",
  "markdown": "text/markdown",
  "json": "application/json",
  "csv": "text/csv",
  "xml": "text/xml",
  "yaml": "text/yaml",
  "yml": "text/yaml",
  "ini": "text/plain",
  "conf": "text/plain",
  "env": "text/plain",
  "sql": "text/plain",
  "js": "text/javascript",
  "mjs": "text/javascript",
  "ts": "text/plain",
  "py": "text/x-python",
  "go": "text/x-go",
  "rs": "text/x-rust",
  "java": "text/x-java",
  "c": "text/x-c",
  "h": "text/x-c",
  "cpp": "text/x-c++",
  "hpp": "text/x-c++",
  "cs": "text/plain",
  "php": "text/plain",
  "rb": "text/plain",
  "sh": "text/x-sh",
  "bat": "text/plain",
  "ps1": "text/plain",
  "html": "text/html",
  "css": "text/css",
  "scss": "text/x-scss",
  "pdf": "application/pdf",
};

function inferMime(file) {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  var ext = (file.name.split(".").pop() || "").toLowerCase();
  return EXT_MIME[ext] || file.type || "application/octet-stream";
}

// 是否支持作为附件（模型能读取内容）：图片 / 文本类 / 常见文本型 application 类型
function isSupportedFile(file) {
  return isSupportedMime(inferMime(file));
}

export function addPendingFiles(fileList) {
  var files = Array.from(fileList);
  files.forEach(function(file) {
    if (file.size > 20 * 1024 * 1024) {
      showError(_t("文件过大: ") + file.name + _t(" (最大 20MB)"));
      return;
    }
    if (!isSupportedFile(file)) {
      showError(_t("该格式无法分析（工具仅支持文本与图片）: ") + file.name);
      return;
    }
    var mime = inferMime(file);
    if (mime && mime.indexOf("image/") === 0) {
      // WebView2 可能给 File 注入 .path：有真实路径时压缩结果保留，发送时直接走路径模式
      var realPath = (typeof file["path"] === "string" && file["path"]) ? file["path"] : null;
      compressImage(file, realPath).then(function(result) {
        S.pendingFiles.push(result);
        renderAttachPreview();
      }).catch(function() {
        showError(_t("图片处理失败: ") + file.name);
      });
    } else {
      var reader = new FileReader();
      reader.onload = function(e) {
        var dataUrl = String(e.target.result); // readAsDataURL 结果必为 data: URL 字符串
        var base64 = dataUrl.split(",")[1] || "";
        // WebView2 可能给 File 注入 .path；有真实路径时超长文本可走"路径模式"
        var realPath = (typeof file["path"] === "string" && file["path"]) ? file["path"] : null;
        S.pendingFiles.push({
          name: file.name,
          type: mime,
          size: file.size,
          base64: base64,
          dataUrl: dataUrl,
          path: realPath,
        });
        renderAttachPreview();
      };
      reader.readAsDataURL(file);
    }
  });
}

function compressImage(file, keepPath) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var dataUrl = String(e.target.result); // readAsDataURL 结果必为 data: URL 字符串
      var img = new Image();
      img.onload = function() {
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (w <= ATTACH_MAX_DIMENSION && h <= ATTACH_MAX_DIMENSION && file.size <= ATTACH_MAX_SIZE) {
          var base64 = dataUrl.split(",")[1] || "";
          resolve({ name: file.name, type: file.type, size: file.size, base64: base64, dataUrl: dataUrl, path: keepPath || null });
          return;
        }
        var scale = Math.min(ATTACH_MAX_DIMENSION / w, ATTACH_MAX_DIMENSION / h, 1);
        var tw = Math.round(w * scale);
        var th = Math.round(h * scale);
        var canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, tw, th);
        var quality = file.size > ATTACH_MAX_SIZE ? 0.7 : 0.85;
        var compressedDataUrl = canvas.toDataURL(file.type || "image/jpeg", quality);
        var base64 = compressedDataUrl.split(",")[1] || "";
        var compressedSize = Math.round(base64.length * 3 / 4);
        console.log("[agent] 图片压缩: " + file.name + " " + w + "x" + h + " -> " + tw + "x" + th + ", " + (file.size / 1024).toFixed(0) + "KB -> " + (compressedSize / 1024).toFixed(0) + "KB");
        resolve({ name: file.name, type: file.type || "image/jpeg", size: compressedSize, base64: base64, dataUrl: compressedDataUrl, path: keepPath || null });
      };
      img.onerror = function() { reject(new Error(_t("图片加载失败"))); };
      img.src = dataUrl;
    };
    reader.onerror = function() { reject(new Error(_t("文件读取失败"))); };
    reader.readAsDataURL(file);
  });
}

function renderAttachPreview() {
  var container = document.getElementById("agent-attach-preview");
  if (!container) return;
  container.innerHTML = "";
  S.pendingFiles.forEach(function(f, idx) {
    var item = document.createElement("div");
    item.className = "attach-preview-item";
    if (f.type && f.type.indexOf("image/") === 0 && f.dataUrl) {
      var img = document.createElement("img");
      img.src = f.dataUrl;
      item.appendChild(img);
    } else {
      var icon = document.createElement("span");
      icon.className = "attach-file-icon";
      icon.textContent = "📄";
      item.appendChild(icon);
    }
    var name = document.createElement("span");
    name.className = "attach-name";
    name.textContent = f.name;
    item.appendChild(name);
    var removeBtn = document.createElement("button");
    removeBtn.className = "attach-remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", function() {
      S.pendingFiles.splice(idx, 1);
      renderAttachPreview();
    });
    item.appendChild(removeBtn);
    container.appendChild(item);
  });
}

export function clearPendingFiles() {
  S.pendingFiles = [];
  renderAttachPreview();
}

// ===== 粘贴文件路径支持 =====
// 浏览器剪贴板对"复制的文件"只提供 file:// 路径（text/uri-list），内容需经 Tauri 后端读取。
// 解析 uri-list → 本地路径数组（file:///C:/... → C:/...，多文件换行分隔）
export function parseUriListPaths(uriList) {
  if (!uriList) return [];
  var out = [];
  uriList.split(/\r?\n/).forEach(function(line) {
    line = line.trim();
    if (!line || line.indexOf("#") === 0) return;
    var p = line;
    if (p.indexOf("file://") === 0) {
      p = p.slice(7);
      try { p = decodeURIComponent(p); } catch (_) {}
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // file:///C:/... → C:/...
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) {
      return; // http(s) 等网络 URL 不是本地文件路径，跳过
    }
    if (p) out.push(p);
  });
  return out;
}

// 判断一段文本是否形如文件路径（Windows 盘符路径 / 绝对路径 / file:// URL），
// 用于 text/plain 兜底时避免把普通复制文本误判为文件
export function looksLikeFilePath(text) {
  if (!text) return false;
  text = text.trim();
  if (text.indexOf("file://") === 0) return true;
  // 单行：盘符 + 分隔符 + 至少一个路径段（带扩展名或目录）
  if (text.indexOf("\n") >= 0 || text.indexOf("\r") >= 0) {
    // 多行：每行都像路径才接受（Windows 多文件复制常见）
    var lines = text.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
    return lines.length > 1 && lines.every(function(l) { return looksLikeFilePath(l); });
  }
  // Windows 盘符路径：要求至少两个路径段，或根级文件名带扩展名（如 C:\a.txt），
  // 避免把 "C:\notes" 这类普通文本误判为文件路径
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    var rest = text.slice(2);
    if (rest.indexOf("\\") < 0 && rest.indexOf("/") < 0) {
      return /^[A-Za-z]:[\\/][^\\/]*\.[^\\/]+$/.test(text);
    }
    return true;
  }
  // Unix 绝对路径：至少两个路径段（避免 "/usr" 之类误判）
  if (/^[\\/]/.test(text)) {
    return text.split(/[\\/]/).filter(Boolean).length >= 2;
  }
  return false;
}

// 常见图片扩展名（走压缩流程；浏览器剪贴板图片直读不走这里）
var IMAGE_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, svg: 1, avif: 1 };

// 粘贴文件路径 → 读内容加入待发送附件（文本/图片均支持；白名单校验同选择器）
export async function addPastedPaths(paths) {
  for (var i = 0; i < paths.length; i++) {
    var path = paths[i];
    var ext = (path.split(".").pop() || "").toLowerCase();
    var mime = EXT_MIME[ext];
    // 先按扩展名拦截不支持格式，避免无谓读取（与选择器白名单一致）
    if (!(mime && isSupportedMime(mime)) && !IMAGE_EXT[ext]) {
      // 目录：把路径作为文本插入输入框（复制文件夹后粘贴的常见场景），
      // 方便直接告知模型文件所在目录；普通不支持的文件仍报错
      var isDir = false;
      try { isDir = !!(await invoke("is_directory", { path: path })); } catch (_) {}
      if (isDir) {
        insertPathText(path);
        continue;
      }
      showError(_t("该格式无法分析（工具仅支持文本与图片）: ") + path);
      continue;
    }
    var res;
    try {
      res = await invoke("read_attachment_file", { path: path });
    } catch (e) {
      showError(_t("读取文件失败: ") + path + " (" + getErrorMessage(e) + ")");
      continue;
    }
    if (!res || !res.base64) {
      showError(_t("读取文件失败: ") + path);
      continue;
    }
    var base64 = res.base64;
    var size = Math.round(base64.length * 3 / 4);
    if (size > 20 * 1024 * 1024) {
      showError(_t("文件过大: ") + (res.name || path) + _t(" (最大 20MB)"));
      continue;
    }
    if (mime && isSupportedMime(mime)) {
      // 文本类：加入（后端内联进 prompt；若文件很大，send.js 会改走"路径模式"，
      // 用真实 path 让 Agent 通过 view 工具分段读取，避免触发上下文守卫）
      var dataUrl = "data:" + mime + ";base64," + base64;
      S.pendingFiles.push({ name: res.name || path, type: mime, size: size, base64: base64, dataUrl: dataUrl, path: path });
      renderAttachPreview();
    } else if (IMAGE_EXT[ext]) {
      // 图片：走压缩流程（与选择器一致）
      var dataUrl2 = "data:image/" + (ext === "jpg" ? "jpeg" : ext) + ";base64," + base64;
      var blob;
      try {
        var bin = atob(base64);
        var u8 = new Uint8Array(bin.length);
        for (var b = 0; b < bin.length; b++) u8[b] = bin.charCodeAt(b);
        blob = new Blob([u8], { type: dataUrl2.split(";")[0].slice(5) });
      } catch (_) {
        blob = null;
      }
      if (blob) {
        var f = new File([blob], res.name || path, { type: dataUrl2.split(";")[0].slice(5) });
        // 粘贴路径场景持有真实磁盘路径：压缩结果保留 path，发送时直接走路径模式（不再重复落盘）
        compressImage(f, path).then(function(result) {
          S.pendingFiles.push(result);
          renderAttachPreview();
        }).catch(function() {
          showError(_t("图片处理失败: ") + (res.name || path));
        });
      } else {
        S.pendingFiles.push({ name: res.name || path, type: dataUrl2.split(";")[0].slice(5), size: size, base64: base64, dataUrl: dataUrl2, path: path });
        renderAttachPreview();
      }
    } else {
      showError(_t("该格式无法分析（工具仅支持文本与图片）: ") + (res.name || path));
    }
  }
}

// 把目录路径作为文本插入输入框，让用户直接告诉模型文件所在目录
function insertPathText(path) {
  var input = /** @type {HTMLTextAreaElement} */ (document.getElementById("agent-input"));
  if (!input) return;
  var cur = input.value;
  var sep = cur && !/\s$/.test(cur) ? " " : "";
  input.value = cur + sep + path;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  showInfo(_t("已把文件夹路径插入输入框: ") + path);
}

// MIME 是否作为文本附件支持（与 isSupportedFile 对文本的判定一致）
function isSupportedMime(mime) {
  if (!mime) return false;
  if (mime.indexOf("image/") === 0) return true;
  if (mime.indexOf("text/") === 0) return true;
  return ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript"].indexOf(mime) >= 0;
}
