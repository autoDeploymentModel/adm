// 附件处理：选择 / 压缩 / 预览
import { S } from "./state.js";
import { showError } from "./ui.js";

// ===== 附件处理 =====
var ATTACH_MAX_SIZE = 1 * 1024 * 1024;  // 超过此大小的图片进行压缩 (1MB)
var ATTACH_MAX_DIMENSION = 2048;         // 图片最大边长

export function addPendingFiles(fileList) {
  var files = Array.from(fileList);
  files.forEach(function(file) {
    if (file.size > 20 * 1024 * 1024) {
      showError("文件过大: " + file.name + " (最大 20MB)");
      return;
    }
    if (file.type && file.type.indexOf("image/") === 0) {
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
          type: file.type,
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
