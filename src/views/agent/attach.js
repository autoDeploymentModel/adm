// 附件处理：选择 / 压缩 / 预览
import { S } from "./state.js";
import { showError } from "./ui.js";

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
  var mime = inferMime(file);
  if (!mime) return false;
  if (mime.indexOf("image/") === 0) return true;
  if (mime.indexOf("text/") === 0) return true;
  return ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript"].indexOf(mime) >= 0;
}

export function addPendingFiles(fileList) {
  var files = Array.from(fileList);
  files.forEach(function(file) {
    if (file.size > 20 * 1024 * 1024) {
      showError("文件过大: " + file.name + " (最大 20MB)");
      return;
    }
    if (!isSupportedFile(file)) {
      showError("暂不支持该格式: " + file.name + "（支持文本/图片，如 txt、md、log、json、csv、代码等）");
      return;
    }
    var mime = inferMime(file);
    if (mime && mime.indexOf("image/") === 0) {
      compressImage(file).then(function(result) {
        S.pendingFiles.push(result);
        renderAttachPreview();
      }).catch(function() {
        showError("图片处理失败: " + file.name);
      });
    } else {
      var reader = new FileReader();
      reader.onload = function(e) {
        var dataUrl = String(e.target.result); // readAsDataURL 结果必为 data: URL 字符串
        var base64 = dataUrl.split(",")[1] || "";
        S.pendingFiles.push({
          name: file.name,
          type: mime,
          size: file.size,
          base64: base64,
          dataUrl: dataUrl,
        });
        renderAttachPreview();
      };
      reader.readAsDataURL(file);
    }
  });
}

function compressImage(file) {
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
          resolve({ name: file.name, type: file.type, size: file.size, base64: base64, dataUrl: dataUrl });
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
        resolve({ name: file.name, type: file.type || "image/jpeg", size: compressedSize, base64: base64, dataUrl: compressedDataUrl });
      };
      img.onerror = function() { reject(new Error("图片加载失败")); };
      img.src = dataUrl;
    };
    reader.onerror = function() { reject(new Error("文件读取失败")); };
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
