// PDF 附件 → 图片：pdf.js 按页范围渲染 JPEG（配合 pdf_batch.js 的分批发送）
// 说明：
// - pdf.js 静态资源在 src/vendor/pdfjs（前端无构建流程，运行时动态 import，
//   非 PDF 场景不加载；jsconfig 已排除该目录的类型检查）；
// - worker / cmaps / 标准字体用基于 import.meta.url 的绝对 URL：worker 内
//   发起 fetch 时相对路径以 worker 位置为基准，与文档基准不同，必须绝对化；
// - 对外三个入口：附加时解析页数（不渲染）、发送时读取源字节、按页范围渲染；
//   分批策略（批大小、何时发下一批）在 pdf_batch.js；
// - PDF 对服务端是"不支持的 MIME"，必须在桌面端转成图片再发（见 send.js）。
import { t as _t, getLanguage } from "../../i18n.js";
import { invoke } from "./store.js";

var PDFJS_API_URL = "../../vendor/pdfjs/pdf.min.mjs";
var PDFJS_WORKER_URL = new URL("../../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
var PDFJS_CMAPS_URL = new URL("../../vendor/pdfjs/cmaps/", import.meta.url).href;
var PDFJS_FONTS_URL = new URL("../../vendor/pdfjs/standard_fonts/", import.meta.url).href;

// 渲染最长边 / 缩放兜底 / JPEG 质量
var PDF_MAX_DIMENSION = 2048;
var PDF_MAX_SCALE = 3;
var PDF_JPEG_QUALITY = 0.85;

/** @type {any} */
var pdfjsLib = null;

/** 懒加载 pdf.js 并配置 worker（只执行一次） */
function loadPdfJs() {
  if (pdfjsLib) return Promise.resolve(pdfjsLib);
  var url = PDFJS_API_URL; // 变量形式：避免类型检查器解析 vendor 目录
  return import(url).then(function(mod) {
    mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    pdfjsLib = mod;
    return mod;
  });
}

/** 创建加载任务（调用方负责 loadingTask.destroy；v6 无 doc.destroy） */
function openPdf(pdfjs, bytes) {
  return pdfjs.getDocument({
    data: bytes,
    cMapUrl: PDFJS_CMAPS_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_FONTS_URL,
  });
}

/**
 * 解析页数（附加时调用；只加载文档头，不渲染）。
 * @param {Uint8Array} bytes PDF 文件内容
 * @returns {Promise<number>}
 */
export async function parsePdfPageCount(bytes) {
  var pdfjs = await loadPdfJs();
  var loadingTask = openPdf(pdfjs, bytes);
  try {
    var doc = await loadingTask.promise;
    return doc.numPages || 0;
  } finally {
    try { await loadingTask.destroy(); } catch (_) {}
  }
}

/**
 * File → Uint8Array（FileReader 兼容性优于 Blob.arrayBuffer）
 * @param {File} file
 * @returns {Promise<Uint8Array>}
 */
function readFileBytes(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      resolve(new Uint8Array(/** @type {ArrayBuffer} */ (e.target.result)));
    };
    reader.onerror = function() { reject(new Error(_t("文件读取失败"))); };
    reader.readAsArrayBuffer(file);
  });
}

/** base64 → Uint8Array */
export function base64ToBytes(b64) {
  var bin = atob(b64);
  var u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * 读取 PDF 源字节：优先用浏览器 File（选择/拖拽），其次按磁盘路径经 Tauri 读取
 * （粘贴路径 / 剪贴板文件场景无 File 对象）。
 * @param {{file?: File|null, path?: string|null}} source
 * @returns {Promise<Uint8Array>}
 */
export async function loadPdfSourceBytes(source) {
  if (source && source.file) return readFileBytes(source.file);
  if (source && source.path) {
    var res = await invoke("read_attachment_file", { path: source.path });
    if (!res || !res.base64) throw new Error(_t("文件读取失败"));
    return base64ToBytes(res.base64);
  }
  throw new Error(_t("PDF 源文件不可用"));
}

/**
 * 渲染 [firstPage, lastPage] 页为 JPEG 附件项（逐页失败隔离；整段全部失败时抛首个错误）。
 * @param {string} name 原 PDF 文件名（用于生成页图片名）
 * @param {Uint8Array} bytes PDF 文件内容
 * @param {number} firstPage 起始页（1-based）
 * @param {number} lastPage 结束页（含；超出总页数自动截断）
 * @param {{ onPage?: (item: {name: string, type: string, size: number, base64: string, dataUrl: string, path: null}, pageNumber: number) => void }} [opts]
 * @returns {Promise<{ totalPages: number, firstPage: number, lastPage: number,
 *                     items: Array<{name: string, type: string, size: number, base64: string, dataUrl: string, path: null}>,
 *                     failed: number }>}
 */
export async function renderPdfPageRange(name, bytes, firstPage, lastPage, opts) {
  var pdfjs = await loadPdfJs();
  var loadingTask = openPdf(pdfjs, bytes);
  var from = Math.max(1, firstPage | 0);
  var items = [];
  var failed = 0;
  var firstError = null;
  var totalPages = 0;
  var to = from - 1;
  try {
    var doc = await loadingTask.promise;
    totalPages = doc.numPages || 0;
    to = Math.min(lastPage | 0, totalPages);
    for (var i = from; i <= to; i++) {
      try {
        var item = await renderPageToImage(doc, i, name);
        items.push(item);
        if (opts && opts.onPage) opts.onPage(item, i);
      } catch (e) {
        // 单页失败不拖垮整段，继续渲染其余页；全部失败时抛首个错误
        failed++;
        if (!firstError) firstError = e;
        console.warn("[agent] PDF 第 " + i + " 页渲染失败:", e);
      }
    }
    if (items.length === 0 && firstError) throw firstError;
    return { totalPages: totalPages, firstPage: from, lastPage: Math.max(to, from - 1), items: items, failed: failed };
  } finally {
    try { await loadingTask.destroy(); } catch (_) {}
  }
}

/** 渲染单页为 JPEG 附件项 */
async function renderPageToImage(doc, pageNumber, pdfName) {
  var page = await doc.getPage(pageNumber);
  var base = page.getViewport({ scale: 1 });
  var scale = Math.min(PDF_MAX_SCALE, PDF_MAX_DIMENSION / Math.max(base.width, base.height));
  if (!(scale > 0)) scale = 1;
  var viewport = page.getViewport({ scale: scale });
  var canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  var ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(_t("画布初始化失败"));
  // JPEG 无透明通道：先铺白底，避免透明区域导出成黑块
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas, canvasContext: ctx, viewport: viewport }).promise;
  page.cleanup();
  var dataUrl = canvas.toDataURL("image/jpeg", PDF_JPEG_QUALITY);
  // 主动释放画布位图：单页 2048px 的 canvas 内存占用大，不能等 GC 回收
  canvas.width = 0;
  canvas.height = 0;
  var base64 = dataUrl.split(",")[1] || "";
  return {
    name: pdfName + " 第" + pageNumber + "页.jpg",
    type: "image/jpeg",
    size: Math.round(base64.length * 3 / 4),
    base64: base64,
    dataUrl: dataUrl,
    path: null,
  };
}

/** PDF 转换异常 → 可读提示（优先按异常类名映射；未命中给兜底文案，原始英文只进 console 日志） */
export function friendlyPdfError(e) {
  var errName = e && e.name;
  if (errName === "PasswordException") return _t("PDF 已加密，需要密码");
  if (errName === "InvalidPDFException") return _t("不是有效的 PDF 文件");
  if (errName === "ResponseException") return _t("PDF 内容读取失败");
  if (errName === "AbortException") return _t("PDF 转换已中断");
  var raw = (e && e.message) || String(e || "");
  if (raw) console.warn("[agent] PDF 转换错误详情:", raw);
  // vendor 资源缺失/未随包分发时，动态 import 失败——给可操作提示
  if (/dynamically imported module|module script failed|importing a module/i.test(raw)) {
    return _t("PDF 组件加载失败，请重试或重新安装");
  }
  // 中文界面不暴露原始英文报错（见 error.js 约定）；英文界面附上原始信息
  var base = _t("PDF 处理失败");
  return getLanguage() === "zh" ? base : base + ": " + raw;
}
