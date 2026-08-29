// 技能选择器（位于工具栏「模型选择器」右侧）
// 职责：
//   1. 列出当前工作区可用的「用户技能」（source=user 或 source=project，且 user_invocable=true）；
//      默认显示全部，不区分全局/项目，但用 badge 标识来源。
//   2. 用户点击技能项 → 调 /skills/read 读 SKILL.md 内容 → 通过 save_attachment_file 落盘为真实文件路径
//      → 作为 markdown 附件加入 S.pendingFiles（沿用 attach.js 的"路径模式"流程）。
//   3. 下一次发送消息时，附件内容会随消息一起被服务端 ingest（与 TUI 的 attachSkill 行为一致）。
//   4. 重复点击同一项：先取消已附加（移除待发送里的对应技能附件），再点击重新附加。
//   5. 选中状态持久化在按钮文案 + 附件预览，发送后自动重置。

import { t as _t } from "../../i18n.js";
import { S, invoke } from "./store.js";
import { api } from "./api.js";
import { escapeHtml } from "./utils.js";
import { showError, showInfo, reportError } from "./ui.js";
import { log } from "./log.js";

const SKILL_ATTACH_PREFIX = "skill:";

/** @type {Array<{id:string,name:string,description:string,source:string,user_invocable:boolean,content_base64:string}>} */
var cachedSkills = [];
var loadingSkills = false;
var skillsLoaded = false; // 是否已成功拉取过（列表为空时避免每次点开都重复请求）

/**
 * 把 base64 字符串解码为 Uint8Array（兼容带不带 data: 前缀、兼容 url-safe 字符）。
 * admAgent 服务端 `ReadSkillResponse.Content` 是 []byte，JSON 编码后是标准 base64。
 */
function decodeBase64(b64) {
  var s = String(b64 || "");
  // 去除可能的 data:xxx;base64, 前缀
  var comma = s.indexOf(",");
  if (s.indexOf("data:") === 0 && comma > 0) s = s.slice(comma + 1);
  // 替换 url-safe 字符 → 标准 base64
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  // atob 不处理补齐
  var pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  var bin = atob(s);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function uint8ToBase64(bytes) {
  var CHUNK = 0x8000;
  var parts = [];
  for (var i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

/** 过滤掉内置（system）技能，只保留用户/项目。
 * 注意：不能按 user_invocable 过滤 —— admAgent 的 Skill.UserInvocable 是 bool，
 * YAML 缺省即 false（与文档"默认 true"不一致），绝大多数本地技能都没写
 * user-invocable: true，会被服务端标为 false 而误过滤。按用户需求
 *「只显示用户技能（全局+项目），默认全部」，只按 source 过滤。 */
function filterUserSkills(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(function(s) {
    if (!s) return false;
    var src = String(s.source || "").toLowerCase();
    if (src !== "user" && src !== "project") return false;
    return !!s.name;
  });
}

/** 把后端返回的项归一化为 { id, name, description, source, user_invocable, content_base64 }。
 *  - 服务端 /skills 返回的字段：id(SkillFilePath), name, description, label, source, user_invocable
 *  - 磁盘扫描 list_installed_skills 返回的字段：name, path(技能目录), source, description,
 *    user_invocable, content_base64（SKILL.md 全量 base64，供快照外的新装技能直接附加）
 * id 必须指向 SKILL.md 的完整文件路径（与 admAgent FindEffective 比较 SkillFilePath 一致）：
 *  - 服务端直接拿 s.id
 *  - 磁盘扫描 s.path 是目录，需拼上 /SKILL.md */
function normalizeSkillItem(s) {
  if (!s) return null;
  var id = s.id || s.skill_file_path || "";
  if (!id && s.path) {
    // 磁盘扫描：path 是技能目录，需拼 SKILL.md
    var sep = /\/|\\/.test(s.path) ? (s.path.indexOf("\\") >= 0 ? "\\" : "/") : "/";
    id = s.path.replace(/[\/\\]+$/, "") + sep + "SKILL.md";
  }
  return {
    id: id,
    name: s.name || "",
    description: s.description || "",
    source: String(s.source || "").toLowerCase(),
    user_invocable: s.user_invocable !== false, // 缺省 true
    content_base64: s.content_base64 || "",
  };
}

/** 已选/已附技能的名称集合（用于下拉高亮）。 */
function getAttachedSkillNames() {
  var out = {};
  (S.pendingFiles || []).forEach(function(f) {
    if (f && f.name && f.name.indexOf(SKILL_ATTACH_PREFIX) === 0) {
      out[f.name.slice(SKILL_ATTACH_PREFIX.length)] = true;
    }
  });
  return out;
}

/** 计算技能项的统一展示名（label 形如 "user:foo" 时去掉前缀，回退 name）。 */
function getSkillDisplayName(s) {
  var label = String(s.label || "");
  var colon = label.indexOf(":");
  if (colon > 0 && colon < label.length - 1 && (label.indexOf("user:") === 0 || label.indexOf("project:") === 0)) {
    return label.slice(colon + 1);
  }
  return s.name;
}

/** 按来源分组：全局在前、项目在后；组内按名称排序。 */
function sortUserSkills(list) {
  return list.slice().sort(function(a, b) {
    var sa = String(a.source || "").toLowerCase();
    var sb = String(b.source || "").toLowerCase();
    if (sa !== sb) return sa === "user" ? -1 : 1; // user(全局) 排前
    return getSkillDisplayName(a).localeCompare(getSkillDisplayName(b));
  });
}

/** 拉取当前工作区的技能列表。
 * 优先用 agent server 的 /skills（权威 + 含 description/user_invocable）；
 * workspace 在创建时就发现技能快照，对"workspace 创建后才安装/卸载"的技能无法感知。
 * 故追加调 `list_installed_skills` 扫描磁盘作为兜底（与 tools.js Skill tab 行为一致），
 * 两边按 name 合并：服务端有以服务端为准（更全的元数据），磁盘补齐新增项。
 */
export async function loadUserSkills() {
  if (!S.serverInfo || !S.serverInfo.workspace_id) {
    cachedSkills = [];
    return [];
  }
  loadingSkills = true;
  renderSkillDropdown(); // 显示 loading 旋转

  // 并行：服务端列表 + 磁盘扫描
  var results = await Promise.allSettled([
    api("GET", "/v1/workspaces/" + S.serverInfo.workspace_id + "/skills"),
    invoke("list_installed_skills"),
  ]);

  // 服务端响应归一化（兼容多种包装格式）
  var serverList = [];
  if (results[0].status === "fulfilled") {
    var resp = results[0].value;
    if (Array.isArray(resp)) serverList = resp;
    else if (resp && Array.isArray(resp.skills)) serverList = resp.skills;
    else if (resp && typeof resp === "object") {
      serverList = Object.values(resp).filter(function(v) {
        return v && typeof v === "object" && (v.name || v.id);
      });
    }
    serverList = serverList.map(normalizeSkillItem).filter(Boolean);
  } else {
    console.warn("[skill-selector] 服务端 /skills 失败:", results[0].reason);
  }

  // 磁盘扫描归一化
  var diskList = [];
  if (results[1].status === "fulfilled" && Array.isArray(results[1].value)) {
    diskList = results[1].value.map(normalizeSkillItem).filter(Boolean);
  } else if (results[1].status === "rejected") {
    console.warn("[skill-selector] list_installed_skills 失败:", results[1].reason);
  }

  // 按 name 合并：服务端优先（保留 description/user_invocable），磁盘补齐缺失项
  var byName = {};
  serverList.forEach(function(s) { if (s.name) byName[s.name] = s; });
  diskList.forEach(function(s) {
    if (!s.name) return;
    if (byName[s.name]) {
      // 服务端已有：仅在服务端缺 description/id 时用磁盘补齐
      if (!byName[s.name].description && s.description) byName[s.name].description = s.description;
      if (!byName[s.name].id && s.id) byName[s.name].id = s.id;
    } else {
      byName[s.name] = s;
    }
  });

  cachedSkills = sortUserSkills(filterUserSkills(Object.values(byName)));
  skillsLoaded = true;
  log.debug("SKILL", "loadUserSkills: server=" + serverList.length + " disk=" + diskList.length + " filtered=" + cachedSkills.length);

  loadingSkills = false;
  renderSkillDropdown();
  return cachedSkills;
}

/** 重渲染下拉（不重新拉数据）。 */
export function renderSkillDropdown() {
  var dropdown = document.getElementById("agent-skill-dropdown");
  if (!dropdown) return;
  dropdown.innerHTML = "";

  var header = document.createElement("div");
  header.className = "skill-dropdown-header";
  header.innerHTML = '<span>🧩 ' + _t("选择技能") + '</span>' +
    '<button class="skill-dropdown-refresh' + (loadingSkills ? " loading" : "") + '" id="agent-skill-refresh" title="' + _t("刷新技能列表") + '">' + (loadingSkills ? "↻" : "⟳") + '</button>';
  dropdown.appendChild(header);

  if (loadingSkills) {
    var empty = document.createElement("div");
    empty.className = "skill-dropdown-empty";
    empty.textContent = _t("加载中…");
    dropdown.appendChild(empty);
    return;
  }

  if (cachedSkills.length === 0) {
    var emptyEl = document.createElement("div");
    emptyEl.className = "skill-dropdown-empty";
    emptyEl.innerHTML =
      '<div class="skill-dropdown-empty-icon">🧩</div>' +
      '<div>' + _t("暂无可用技能") + '</div>' +
      '<div style="margin-top:6px;font-size:11px;">' + _t("请到「技能管理」安装用户/项目技能，或刷新重试") + '</div>';
    dropdown.appendChild(emptyEl);
    return;
  }

  var attachedNames = getAttachedSkillNames();
  cachedSkills.forEach(function(s) {
    var item = document.createElement("div");
    item.className = "skill-item";
    var displayName = getSkillDisplayName(s);
    var isAttached = !!attachedNames[displayName] || !!attachedNames[s.name];
    if (isAttached) item.classList.add("attached");

    var source = String(s.source || "").toLowerCase();
    var sourceLabel = source === "project" ? _t("项目") : _t("全局");
    var desc = s.description || "";
    item.innerHTML =
      '<div class="skill-item-top">' +
        '<span class="skill-item-name">' + escapeHtml(displayName) + '</span>' +
        '<span class="skill-item-source ' + (source === "project" ? "project" : "global") + '">' + escapeHtml(sourceLabel) + '</span>' +
        (isAttached ? '<span class="skill-item-status" title="' + _t("已加入待发送列表") + '">✓</span>' : '') +
      '</div>' +
      (desc ? '<div class="skill-item-desc">' + escapeHtml(desc) + '</div>' : '');
    item.title = desc || displayName;
    item.addEventListener("click", function() { invokeSkill(s); });
    dropdown.appendChild(item);
  });
}

/** 工具栏按钮显示态：根据当前是否已有技能附件切换文案 + 样式。 */
function updateSkillButton() {
  var btn = document.getElementById("agent-skill-btn");
  var nameEl = document.getElementById("agent-skill-name");
  if (!btn || !nameEl) return;

  var attachedSkills = (S.pendingFiles || []).filter(function(f) {
    return f && f.name && f.name.indexOf(SKILL_ATTACH_PREFIX) === 0;
  });

  if (attachedSkills.length === 0) {
    nameEl.textContent = _t("技能");
    btn.classList.remove("has-skill");
    btn.title = _t("选择技能（仅显示用户与项目技能）；选中后将随下一条消息一起发送");
  } else if (attachedSkills.length === 1) {
    var nm = attachedSkills[0].name.slice(SKILL_ATTACH_PREFIX.length);
    nameEl.textContent = "🧩 " + nm;
    btn.classList.add("has-skill");
    btn.title = _t("已附加技能: ") + nm + _t("（点击下拉切换；发送后自动重置）");
  } else {
    nameEl.textContent = "🧩 " + attachedSkills.length + _t(" 项技能");
    btn.classList.add("has-skill");
    btn.title = attachedSkills.map(function(f) { return f.name.slice(SKILL_ATTACH_PREFIX.length); }).join(", ") +
      _t("（点击下拉切换；发送后自动重置）");
  }
}

/**
 * 用户选中某项技能：拉内容 → 落盘 → 加入 pendingFiles → 渲染附件预览 + 按钮态 + 下拉高亮。
 * 若该技能已在 pendingFiles 中：视为"取消附加"，反之则幂等地先移除同名旧项再加新项，
 * 避免重复点击造成多个同名附件。
 */
export async function invokeSkill(skill) {
  if (!skill || !skill.id) return;
  if (!S.serverInfo || !S.serverInfo.workspace_id) {
    showError(_t("Agent 未连接，无法加载技能内容"));
    return;
  }
  var displayName = getSkillDisplayName(skill);
  var attachName = SKILL_ATTACH_PREFIX + displayName;
  // 已附加 → 取消
  var existingIdx = (S.pendingFiles || []).findIndex(function(f) {
    return f && f.name && f.name === attachName;
  });
  if (existingIdx >= 0) {
    S.pendingFiles.splice(existingIdx, 1);
    renderAttachPreviewPublic();
    updateSkillButton();
    renderSkillDropdown();
    showInfo(_t("已取消附加技能: ") + displayName);
    return;
  }

  // 关闭下拉（视觉反馈）
  var dd = document.getElementById("agent-skill-dropdown");
  if (dd) dd.classList.remove("show");

  showInfo(_t("正在加载技能: ") + displayName);
  try {
    // 内容优先级：磁盘扫描项自带 content_base64（workspace 快照外的新装技能，
    // 服务端 /skills/read 会因不在快照而返回 skill not found）；
    // 服务端快照内项走 /skills/read（authoritative）。
    var contentB64 = skill.content_base64 || "";
    if (!contentB64) {
      var resp = await api("POST", "/v1/workspaces/" + S.serverInfo.workspace_id + "/skills/read", {
        skill_id: skill.id
      });
      // Content 是 []byte，JSON 序列化为 base64 字符串
      contentB64 = resp && resp.content ? String(resp.content) : "";
    }
    if (!contentB64) throw new Error(_t("技能内容为空"));
    var bytes = decodeBase64(contentB64);
    var base64Str = uint8ToBase64(bytes);

    // 落盘 → 拿到真实磁盘路径，沿用 attach.js "路径模式"流程
    var realPath = await invoke("save_attachment_file", {
      file_name: displayName + ".md",
      base64_content: base64Str
    });

    // 加入 pendingFiles（type 用 text/markdown，与 TUI attachSkill 一致）
    S.pendingFiles.push({
      name: attachName,
      type: "text/markdown",
      size: bytes.length,
      base64: base64Str,
      dataUrl: "data:text/markdown;base64," + base64Str,
      path: realPath,
      _skill: { id: skill.id, name: displayName, source: skill.source }
    });
    renderAttachPreviewPublic();
    updateSkillButton();
    renderSkillDropdown();
    showInfo(_t("已附加技能: ") + displayName + _t("（随下一条消息发送）"));
  } catch (e) {
    console.error("[skill-selector] invokeSkill 失败:", skill && skill.name, e);
    reportError(e, { prefix: _t("加载技能失败: ") });
  }
}

/** 渲染附件预览（attach.js 的 renderAttachPreview 未导出，复刻其逻辑）。 */
function renderAttachPreviewPublic() {
  var container = document.getElementById("agent-attach-preview");
  if (!container) return;
  container.innerHTML = "";
  (S.pendingFiles || []).forEach(function(f, idx) {
    var item = document.createElement("div");
    item.className = "attach-preview-item";
    if (f.type && f.type.indexOf("image/") === 0 && f.dataUrl) {
      var img = document.createElement("img");
      img.src = f.dataUrl;
      item.appendChild(img);
    } else {
      var icon = document.createElement("span");
      icon.className = "attach-file-icon";
      icon.textContent = f._skill ? "🧩" : "📄";
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
      renderAttachPreviewPublic();
      updateSkillButton();
      renderSkillDropdown();
    });
    item.appendChild(removeBtn);
    container.appendChild(item);
  });
}

/**
 * 发送后清理技能附件：把待发送列表里的技能类附件移除，并把按钮态/下拉刷新。
 * 由 send.js 在消息成功入队后调用（fire-and-forget）。
 * 注意：send.js 的 clearPendingFiles 会先把 pendingFiles 清空，此处用长度对比判断
 * "是否有技能附件被清掉"会恒为 false，必须无条件刷新按钮态（渲染是全量的）。
 */
export function clearAttachedSkillsAfterSend() {
  S.pendingFiles = (S.pendingFiles || []).filter(function(f) {
    return !(f && f.name && f.name.indexOf(SKILL_ATTACH_PREFIX) === 0);
  });
  renderAttachPreviewPublic();
  updateSkillButton();
  renderSkillDropdown();
}

/** 工具栏按钮 + 下拉开关 + 刷新按钮事件绑定（在 agent.js 的 bindEvents 阶段调用一次）。 */
export function bindSkillSelectorEvents() {
  var btn = document.getElementById("agent-skill-btn");
  var dd = document.getElementById("agent-skill-dropdown");
  if (!btn || !dd) return;

  btn.addEventListener("click", function(e) {
    e.stopPropagation();
    var willShow = !dd.classList.contains("show");
    // 互斥：关闭其它下拉
    var modelDd = document.getElementById("agent-model-dropdown");
    if (modelDd) modelDd.classList.remove("show");
    dd.classList.toggle("show", willShow);
    if (willShow) {
      // 首次打开若还没拉取过则拉一次，否则只是重渲染（高亮已附加状态）
      if (!skillsLoaded && !loadingSkills) {
        loadUserSkills();
      } else {
        renderSkillDropdown();
      }
    }
  });

  // 顶部刷新按钮（事件代理，元素每次 renderSkillDropdown 都会重建）
  dd.addEventListener("click", function(e) {
    var target = /** @type {HTMLElement} */ (e.target);
    if (target && target.id === "agent-skill-refresh") {
      e.stopPropagation();
      loadUserSkills();
    }
  });

  // 点击外部关闭（agent.js 已注册全局 click 关闭模型下拉，这里补一个把技能下拉也关掉）；
  // 与 agent.js 大纲面板的 document 监听一致，必须注册进 S.unlisteners，unmount 时统一解绑
  function onDocClickForSkill(ev) {
    var target = /** @type {HTMLElement} */ (ev.target);
    if (!dd.contains(target) && target !== btn) dd.classList.remove("show");
  }
  document.addEventListener("click", onDocClickForSkill);
  if (S.unlisteners) {
    S.unlisteners.push(function() {
      document.removeEventListener("click", onDocClickForSkill);
    });
  }

  // 启动时拉一次（不阻塞 init）——在 init() 末尾调用 initSkillSelector()
  updateSkillButton();
  renderSkillDropdown();
}

/** 在 agent init 末尾调用：异步加载列表，不阻塞 UI。 */
export async function initSkillSelector() {
  await loadUserSkills();
  updateSkillButton();
}