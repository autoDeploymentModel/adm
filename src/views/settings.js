// @ts-nocheck -- 历史视图暂未类型化（jsconfig checkJs 全局开启，新代码请勿加此标记）
import { t as _t, setLanguage, getLanguage } from "../i18n.js";
const template = `
<style>
  /* 样式隔离约定：选择器限定在本视图容器内（id/class 带 settings- 前缀），
     全局 reset（*）与 body 样式由 index.html 壳层统一提供，视图内不得重复定义 */

  #settings-app { display: flex; flex-direction: column; height: 100%; }

  #settings-header {
    display: flex;
    align-items: center;
    padding: 10px 16px;
    background: var(--c-panel-2);
    border-bottom: 1px solid var(--c-border-soft);
    flex-shrink: 0;
    gap: 12px;
  }

  .back-btn {
    background: var(--c-overlay);
    border: none;
    color: var(--c-text);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    transition: background 0.2s;
  }
  .back-btn:hover { background: var(--c-overlay-strong); }

  #settings-header .title { font-size: 16px; font-weight: 600; color: var(--c-text-hi); }

  #settings-layout { display: flex; flex: 1; overflow: hidden; }

  #settings-nav {
    width: 180px;
    background: var(--c-panel);
    border-right: 1px solid var(--c-border-soft);
    padding: 12px 0;
    flex-shrink: 0;
    overflow-y: auto;
  }

  .nav-item {
    padding: 10px 20px;
    cursor: pointer;
    font-size: 14px;
    color: var(--c-text-2);
    transition: all 0.2s;
    border-left: 3px solid transparent;
  }
  .nav-item:hover { background: rgba(var(--c-accent-rgb), 0.08); color: var(--c-text); }
  .nav-item.active {
    background: rgba(var(--c-accent-rgb), 0.12);
    color: var(--c-accent);
    border-left-color: var(--c-accent);
    font-weight: 500;
  }

  #settings-content { flex: 1; overflow-y: auto; padding: 20px 24px; }

  .panel { display: none; }
  .panel.active { display: block; }

  .panel-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--c-text-hi);
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .panel-title::before {
    content: "";
    display: inline-block;
    width: 4px;
    height: 16px;
    background: var(--c-accent);
    border-radius: 2px;
  }

  .param-group { margin-bottom: 24px; }

  .param-group-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--c-accent);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--c-border);
  }

  .param-row { display: flex; align-items: center; margin-bottom: 10px; gap: 12px; }

  .param-label { width: 160px; font-size: 13px; color: var(--c-text-2); flex-shrink: 0; }
  .param-label .param-key { font-size: 11px; color: var(--c-text-4); margin-top: 2px; }

  .param-input { flex: 1; max-width: 300px; }
  .param-input input, .param-input select {
    width: 100%;
    padding: 7px 12px;
    background: var(--c-panel-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text);
    font-size: 13px;
    outline: none;
    transition: border-color 0.2s;
  }
  .param-input input:focus, .param-input select:focus { border-color: var(--c-accent); }
  .param-input select { cursor: pointer; }
  .param-input select option { background: var(--c-panel-2); color: var(--c-text); }
  .param-input .checkbox-wrap { display: flex; align-items: center; gap: 8px; }
  .param-input input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--c-accent); }

  .param-desc { font-size: 11px; color: var(--c-text-4); margin-top: 2px; }

  /* ===== 主题卡片 ===== */
  .theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; max-width: 660px; }
  .theme-card {
    border: 2px solid var(--c-border);
    border-radius: 10px;
    padding: 10px;
    cursor: pointer;
    background: var(--c-panel);
    transition: border-color 0.2s, transform 0.1s;
  }
  .theme-card:hover { border-color: var(--c-accent); transform: translateY(-2px); }
  .theme-card.active { border-color: var(--c-accent); box-shadow: 0 0 0 1px var(--c-accent); }
  .theme-card .theme-preview { display: flex; height: 46px; border-radius: 6px; overflow: hidden; border: 1px solid var(--c-border-soft); }
  .theme-card .theme-preview span { flex: 1; }
  .theme-card .theme-name { font-size: 13px; color: var(--c-text); margin-top: 8px; display: flex; align-items: center; gap: 6px; }
  .theme-card .theme-check { color: var(--c-accent); font-weight: 700; visibility: hidden; }
  .theme-card.active .theme-check { visibility: visible; }

  .btn-reset {
    background: var(--c-overlay);
    color: var(--c-text);
    border: none;
    padding: 10px 28px;
    border-radius: 8px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.2s;
    margin-top: 16px;
    margin-left: 12px;
  }
  .btn-reset:hover { background: var(--c-overlay-strong); }

  .btn-delete-llamacpp {
    background: #d32f2f;
    color: #fff;
    border: none;
    padding: 3px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    transition: background 0.2s;
    vertical-align: middle;
  }
  .btn-delete-llamacpp:hover { background: #b71c1c; }

  .version-table { width: 100%; max-width: 500px; }
  .version-table tr { border-bottom: 1px solid var(--c-border-soft); }
  .version-table td { padding: 12px 0; font-size: 14px; }
  .version-table td:first-child { color: var(--c-text-2); width: 140px; }
  .version-table td:last-child { color: var(--c-text); font-weight: 500; }

  .about-content { max-width: 500px; }
  .about-content h3 { font-size: 20px; color: var(--c-text-hi); margin-bottom: 8px; }
  .about-content .about-subtitle { font-size: 13px; color: var(--c-accent); margin-bottom: 20px; }
  .about-content p { font-size: 14px; color: var(--c-text-2); line-height: 1.8; margin-bottom: 12px; }
  .about-content a { color: var(--c-accent); text-decoration: none; }
  .about-content a:hover { text-decoration: underline; }

  .save-toast {
    position: fixed;
    top: 20px;
    right: 20px;
    background: #2e7d32;
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 1000;
    animation: slideIn 0.3s ease;
  }

  .error-toast {
    position: fixed;
    top: 20px;
    right: 20px;
    background: #c62828;
    color: #fff;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 1000;
    animation: slideIn 0.3s ease;
  }

  @keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  .confirm-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 9999;
    justify-content: center;
    align-items: center;
  }
  .confirm-overlay.show { display: flex; }
  .confirm-dialog {
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: 12px;
    padding: 28px 32px;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    text-align: center;
  }
  .confirm-dialog .confirm-title { font-size: 18px; font-weight: 600; color: var(--c-text-hi); margin-bottom: 12px; }
  .confirm-dialog .confirm-message { font-size: 14px; color: var(--c-text-2); line-height: 1.6; margin-bottom: 24px; white-space: pre-line; }
  .confirm-dialog .confirm-buttons { display: flex; gap: 12px; justify-content: center; }
  .confirm-dialog .btn-confirm { background: #d32f2f; color: #fff; border: none; padding: 8px 28px; border-radius: 8px; font-size: 14px; cursor: pointer; transition: background 0.2s; }
  .confirm-dialog .btn-confirm:hover { background: #b71c1c; }
  .confirm-dialog .btn-cancel { background: var(--c-overlay); color: var(--c-text); border: none; padding: 8px 28px; border-radius: 8px; font-size: 14px; cursor: pointer; transition: background 0.2s; }
  .confirm-dialog .btn-cancel:hover { background: var(--c-overlay-strong); }
</style>
<div id="settings-app">
  <div id="settings-header">
    <button class="back-btn" id="back-btn">&#8592; ${_t("返回")}</button>
    <span class="title">${_t("设置")}</span>
  </div>
  <div id="settings-layout">
    <nav id="settings-nav">
      <div class="nav-item active" data-panel="launch-params" id="nav-launch-params">${_t("模型启动参数")}</div>
      <div class="nav-item" data-panel="appearance" id="nav-appearance">${_t("外观主题")}</div>
      <div class="nav-item" data-panel="wxbot" id="nav-wxbot">${_t("微信 Bot")}</div>
      <div class="nav-item" data-panel="version" id="nav-version">${_t("系统版本号")}</div>
      <div class="nav-item" data-panel="about" id="nav-about">${_t("关于")}</div>
    </nav>
    <div id="settings-content">
      <div id="panel-launch-params" class="panel active">
        <div class="panel-title">${_t("模型启动参数")}</div>

        <div class="param-group" style="margin-bottom: 28px;">
          <div class="param-group-title">${_t("推荐模式")}</div>
          <div class="param-row">
            <div class="param-label">${_t("选择模式")}<div class="param-key">${_t("快速配置")}</div></div>
            <div class="param-input">
              <select id="preset_mode">
                <option value="default">${_t("默认（日常聊天）")}</option>
                <option value="creative">${_t("创意写作")}</option>
                <option value="code">${_t("写代码 / 编程（推荐）")}</option>
              </select>
              <div class="param-desc">${_t("选择后自动填充并保存采样参数，可手动微调后自动保存")}</div>
            </div>
          </div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("基础参数")}</div>
          <div class="param-row">
            <div class="param-label">${_t("上下文大小")}<div class="param-key">-c, --ctx-size</div></div>
            <div class="param-input"><input type="number" id="ctx_size" value="25600" min="0"><div class="param-desc" id="ctx-floor-hint"></div></div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("预测 token 数")}<div class="param-key">-n, --n-predict</div></div>
            <div class="param-input"><input type="number" id="n_predict" value="-1"><div class="param-desc">${_t("-1 表示无限")}</div></div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("批处理大小")}<div class="param-key">-b, --batch-size</div></div>
            <div class="param-input"><input type="number" id="batch_size" value="2048" min="1"></div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("微批次大小")}<div class="param-key">-ub, --ubatch-size</div></div>
            <div class="param-input"><input type="number" id="ubatch_size" value="512" min="1"></div>
          </div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("GPU 参数")}</div>
          <div class="param-row">
            <div class="param-label">${_t("GPU 层数")}<div class="param-key">-ngl, --n-gpu-layers</div></div>
            <div class="param-input">
              <select id="n_gpu_layers">
                <option value="auto">${_t("auto (自动)")}</option>
                <option value="all">${_t("all (全部)")}</option>
                <option value="0">${_t("0 (仅 CPU)")}</option>
                <option value="1">1</option>
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="30">30</option>
                <option value="40">40</option>
                <option value="50">50</option>
                <option value="custom">${_t("自定义")}</option>
              </select>
            </div>
          </div>
          <div class="param-row" id="custom_ngl_row" style="display:none;">
            <div class="param-label">${_t("自定义 GPU 层数")}</div>
            <div class="param-input"><input type="number" id="n_gpu_layers_custom" value="0" min="0"></div>
          </div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("性能参数")}</div>
          <div class="param-row">
            <div class="param-label">${_t("线程数")}<div class="param-key">-t, --threads</div></div>
            <div class="param-input"><input type="number" id="threads" value="" placeholder="${_t("自动")}"><div class="param-desc">${_t("留空为自动")}</div></div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("批处理线程数")}<div class="param-key">-tb, --threads-batch</div></div>
            <div class="param-input"><input type="number" id="threads_batch" value="" placeholder="${_t("同线程数")}"></div>
          </div>
          <div class="param-row">
            <div class="param-label">Flash Attention<div class="param-key">-fa, --flash-attn</div></div>
            <div class="param-input">
              <select id="flash_attn"><option value="on">on</option><option value="off">off</option></select>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("KV 缓存类型 K")}<div class="param-key">-ctk, --cache-type-k</div></div>
            <div class="param-input">
              <select id="cache_type_k"><option value="f16">f16</option><option value="f32">f32</option><option value="q8_0">q8_0</option><option value="q4_0">q4_0</option><option value="q4_1">q4_1</option><option value="q5_0">q5_0</option><option value="q5_1">q5_1</option></select>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("KV 缓存类型 V")}<div class="param-key">-ctv, --cache-type-v</div></div>
            <div class="param-input">
              <select id="cache_type_v"><option value="f16">f16</option><option value="f32">f32</option><option value="q8_0">q8_0</option><option value="q4_0">q4_0</option><option value="q4_1">q4_1</option><option value="q5_0">q5_0</option><option value="q5_1">q5_1</option></select>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("内存锁定")}<div class="param-key">--mlock</div></div>
            <div class="param-input"><div class="checkbox-wrap"><input type="checkbox" id="mlock"><span>${_t("强制模型驻留 RAM")}</span></div></div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("内存映射")}<div class="param-key">--mmap</div></div>
            <div class="param-input"><div class="checkbox-wrap"><input type="checkbox" id="mmap" checked><span>${_t("启用内存映射")}</span></div></div>
          </div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("采样参数")}</div>
          <div class="param-row"><div class="param-label">${_t("温度")}<div class="param-key">--temp</div></div><div class="param-input"><input type="number" id="temperature" value="0.8" step="0.05" min="0"></div></div>
          <div class="param-row"><div class="param-label">Top-K<div class="param-key">--top-k</div></div><div class="param-input"><input type="number" id="top_k" value="40" min="0"></div></div>
          <div class="param-row"><div class="param-label">Top-P<div class="param-key">--top-p</div></div><div class="param-input"><input type="number" id="top_p" value="0.95" step="0.01" min="0" max="1"></div></div>
          <div class="param-row"><div class="param-label">Min-P<div class="param-key">--min-p</div></div><div class="param-input"><input type="number" id="min_p" value="0.05" step="0.01" min="0" max="1"></div></div>
          <div class="param-row"><div class="param-label">${_t("重复惩罚")}<div class="param-key">--repeat-penalty</div></div><div class="param-input"><input type="number" id="repeat_penalty" value="1.1" step="0.05" min="0"></div></div>
          <div class="param-row"><div class="param-label">${_t("重复窗口")}<div class="param-key">--repeat-last-n</div></div><div class="param-input"><input type="number" id="repeat_last_n" value="-1" step="1"><div class="param-desc">${_t("重复惩罚的上下文窗口大小，-1 表示使用 ctx_size")}</div></div></div>
          <div class="param-row"><div class="param-label">${_t("DRY 乘数")}<div class="param-key">--dry-multiplier</div></div><div class="param-input"><input type="number" id="dry_multiplier" value="0.8" step="0.05" min="0"><div class="param-desc">${_t("DRY 采样乘数，0.0 表示禁用")}</div></div></div>
          <div class="param-row"><div class="param-label">${_t("DRY 允许长度")}<div class="param-key">--dry-allowed-length</div></div><div class="param-input"><input type="number" id="dry_allowed_length" value="2" step="1" min="1"><div class="param-desc">${_t("DRY 采样允许的重复长度，代码模式建议设为 1")}</div></div></div>
          <div class="param-row"><div class="param-label">${_t("DRY 惩罚窗口")}<div class="param-key">--dry-penalty-last-n</div></div><div class="param-input"><input type="number" id="dry_penalty_last_n" value="-1" step="1"><div class="param-desc">${_t("DRY 惩罚的最后 n 个 token，-1 表示使用上下文大小")}</div></div></div>
          <div class="param-row"><div class="param-label">${_t("存在惩罚")}<div class="param-key">--presence-penalty</div></div><div class="param-input"><input type="number" id="presence_penalty" value="0.0" step="0.05" min="0"><div class="param-desc">${_t("重复 alpha 存在惩罚，0.0 表示禁用")}</div></div></div>
          <div class="param-row"><div class="param-label">${_t("频率惩罚")}<div class="param-key">--frequency-penalty</div></div><div class="param-input"><input type="number" id="frequency_penalty" value="0.0" step="0.05" min="0"><div class="param-desc">${_t("重复 alpha 频率惩罚，0.0 表示禁用")}</div></div></div>
          <div class="param-row"><div class="param-label">${_t("推理/思考")}<div class="param-key">--reasoning</div></div><div class="param-input"><select id="reasoning"><option value="auto">${_t("auto (自动检测)")}</option><option value="on">${_t("on (开启)")}</option><option value="off">${_t("off (关闭)")}</option></select><div class="param-desc">${_t("控制模型是否启用推理/思考模式")}</div></div></div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("服务参数")}</div>
          <div class="param-row"><div class="param-label">${_t("监听端口")}<div class="param-key">--port</div></div><div class="param-input"><input type="number" id="port" value="5678" min="1" max="65535"></div></div>
          <div class="param-row"><div class="param-label">${_t("监听地址")}<div class="param-key">--host</div></div><div class="param-input"><select id="host"><option value="127.0.0.1">${_t("127.0.0.1 (本地)")}</option><option value="0.0.0.0">${_t("0.0.0.0 (所有接口)")}</option></select></div></div>
        </div>

        <button class="btn-reset" id="reset-btn">${_t("恢复默认")}</button>
      </div>

      <div id="panel-appearance" class="panel">
        <div class="panel-title">${_t("外观主题")}</div>
        <div class="param-group">
          <div class="param-group-title">${_t("语言 / Language")}</div>
          <div class="param-row">
            <div class="param-label">${_t("界面语言")}<div class="param-key">language</div></div>
            <div class="param-input">
              <select id="ui-lang-select">
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
              <div class="param-desc">${_t("切换后立即生效")}</div>
            </div>
          </div>
          <div class="param-group-title">${_t("主题配色")}</div>
          <div class="param-desc" style="margin-bottom:14px;">${_t("选择界面配色，风格参考主流 VS Code 主题，点击即可一键切换（立即生效）")}</div>
          <div id="theme-grid" class="theme-grid"></div>
        </div>
      </div>

      <div id="panel-wxbot" class="panel">
        <div class="panel-title">${_t("微信 Bot（iLink）")}</div>

        <div class="param-group">
          <div class="param-group-title">${_t("绑定状态")}</div>
          <div class="param-row">
            <div class="param-label">${_t("状态")}</div>
            <div class="param-input"><span id="wxbot-state" style="font-size:13px;color:var(--c-text-2);">${_t("加载中…")}</span></div>
          </div>
          <div class="param-row">
            <div class="param-label">Bot ID</div>
            <div class="param-input"><span id="wxbot-botid" style="font-size:13px;color:var(--c-text-2);">-</span></div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("主人微信")}</div>
            <div class="param-input">
              <span id="wxbot-owner" style="font-size:13px;color:var(--c-text-2);">-</span>
              <div class="param-desc">${_t("首个给 Bot 发消息的微信号自动成为主人，其余人消息忽略")}</div>
            </div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("消息统计")}</div>
            <div class="param-input"><span id="wxbot-stats" style="font-size:13px;color:var(--c-text-2);">${_t("收 ")}0 ${_t(" / 发 ")}0</span></div>
          </div>
          <div class="param-row">
            <div class="param-label"></div>
            <div class="param-input" style="display:flex;gap:10px;max-width:none;">
              <button id="wxbot-bind-btn" style="background:var(--c-accent);color:#fff;border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("绑定微信")}</button>
              <button id="wxbot-toggle-btn" style="display:none;background:var(--c-overlay);color:var(--c-text);border:none;padding:8px 20px;border-radius:8px;font-size:13px;cursor:pointer;">${_t("暂停")}</button>
              <button id="wxbot-unbind-btn" class="btn-delete-llamacpp" style="display:none;padding:8px 20px;border-radius:8px;font-size:13px;">${_t("解绑")}</button>
            </div>
          </div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("Bot 行为")}</div>
          <div class="param-row">
            <div class="param-label">${_t("工作目录")}</div>
            <div class="param-input"><span style="font-size:13px;color:var(--c-text-2);">${_t("跟随 Agent 页工作目录")}</span><div class="param-desc">${_t("微信 Bot 与 Agent 页使用同一工作目录，在 Agent 页修改")}</div></div>
          </div>
          <div class="param-row">
            <div class="param-label">${_t("模式")}</div>
            <div class="param-input"><span style="font-size:13px;color:var(--c-text-2);">${_t("跟随 Agent 页模式设置")}</span><div class="param-desc">${_t("执行模式直接执行修改；Plan 模式只读调研并产出计划，不修改任何文件")}</div></div>
          </div>
        </div>

        <div class="param-group">
          <div class="param-group-title">${_t("最近活动")}</div>
          <div id="wxbot-activity" style="font-size:12px;color:var(--c-text-3);line-height:1.8;max-height:200px;overflow-y:auto;background:var(--c-panel-2);border:1px solid var(--c-border);border-radius:6px;padding:10px 12px;">${_t("暂无活动")}</div>
        </div>
      </div>

      <div id="panel-version" class="panel">
        <div class="panel-title">${_t("系统版本号")}</div>
        <table class="version-table">
          <tr><td>${_t("ADM 版本")}</td><td id="v-adm">${_t("检测中...")} <span id="update-badge" style="display:none;color:#4caf50;font-size:12px;margin-left:6px;">${_t("✓ 最新")}</span></td></tr>
          <tr>
            <td style="padding-top:20px;" colspan="2">
              <button class="btn-save" id="check-update-btn" style="margin-top:0;font-size:13px;padding:8px 20px;">${_t("检查新版本")}</button>
              <span id="update-status" style="font-size:12px;color:var(--c-text-3);margin-left:12px;"></span>
            </td>
          </tr>
          <tr><td>${_t("Tauri 版本")}</td><td>2.11.2</td></tr>
          <tr>
            <td>${_t("llama.cpp 版本")}</td>
            <td><span id="v-llamacpp" style="margin-right:8px;">${_t("检测中...")}</span><button class="btn-delete-llamacpp" id="delete-llamacpp-btn">${_t("删除")}</button></td>
          </tr>
          <tr><td>${_t("admAgent 版本")}</td><td id="v-admagent">${_t("检测中...")}</td></tr>
          <tr><td>${_t("操作系统")}</td><td id="v-os">${_t("检测中...")}</td></tr>
        </table>
      </div>

      <div id="panel-about" class="panel">
        <div class="panel-title">${_t("关于")}</div>
        <div class="about-content">
          <h3>ADM</h3>
          <div class="about-subtitle">Automatic Deployment Model</div>
          <p>${_t("ADM 是一个大模型部署图形化管理工具，让用户能够便捷地在本地部署和运行大语言模型。")}</p>
          <p>${_t("如需定制服务 联系方式：微信: litai686")}</p>
          <p>${_t("项目官网：")}<a href="https://adm.tuduoduo.top/" target="_blank">https://adm.tuduoduo.top/</a></p>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="confirm-overlay" id="confirm-overlay">
  <div class="confirm-dialog">
    <div class="confirm-title" id="confirm-title">${_t("删除提示")}</div>
    <div class="confirm-message" id="confirm-message"></div>
    <div class="confirm-buttons">
      <button class="btn-cancel" id="confirm-cancel-btn">${_t("取消")}</button>
      <button class="btn-confirm" id="confirm-ok-btn">${_t("确定")}</button>
    </div>
  </div>
</div>

<div class="confirm-overlay" id="wxbot-qr-overlay">
  <div class="confirm-dialog">
    <div class="confirm-title">${_t("微信扫码绑定")}</div>
    <div id="wxbot-qr-box" style="display:flex;justify-content:center;align-items:center;min-height:220px;width:220px;background:#fff;border-radius:8px;margin:0 auto 16px;">
      <span style="color:#333;font-size:13px;">${_t("二维码加载中…")}</span>
    </div>
    <div class="confirm-message">${_t("使用微信「扫一扫」确认开启 Bot 功能")}</div>
    <div class="confirm-buttons">
      <button class="btn-cancel" id="wxbot-qr-cancel-btn">${_t("取消")}</button>
    </div>
  </div>
</div>

<div class="confirm-overlay" id="wxbot-code-overlay">
  <div class="confirm-dialog">
    <div class="confirm-title">${_t("输入配对码")}</div>
    <div class="confirm-message" id="wxbot-code-hint">${_t("请输入微信手机端显示的配对数字：")}</div>
    <input id="wxbot-code-input" type="text" inputmode="numeric" autocomplete="off" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid var(--c-overlay-strong);background:rgba(255,255,255,0.06);color:#fff;font-size:16px;letter-spacing:2px;text-align:center;margin-bottom:16px;">
    <div class="confirm-buttons">
      <button class="btn-cancel" id="wxbot-code-cancel-btn">${_t("取消")}</button>
      <button class="btn-confirm" id="wxbot-code-ok-btn">${_t("确定")}</button>
    </div>
  </div>
</div>
`;

const PRESET_MODES = {
  default: { ctx_size: 25600, temperature: 1.0, top_k: 20, top_p: 0.95, min_p: 0.0, repeat_penalty: 1.0, repeat_last_n: -1, dry_multiplier: 0.0, dry_allowed_length: 2, dry_penalty_last_n: -1, presence_penalty: 1.5, frequency_penalty: 0.0, reasoning: "auto" },
  creative: { ctx_size: 25600, temperature: 1.0, top_k: 20, top_p: 0.95, min_p: 0.0, repeat_penalty: 1.0, repeat_last_n: -1, dry_multiplier: 0.0, dry_allowed_length: 2, dry_penalty_last_n: -1, presence_penalty: 1.5, frequency_penalty: 0.0, reasoning: "auto" },
  code: { ctx_size: 128000, temperature: 0.6, top_k: 20, top_p: 0.95, min_p: 0.0, repeat_penalty: 1.0, repeat_last_n: -1, dry_multiplier: 0.0, dry_allowed_length: 2, dry_penalty_last_n: -1, presence_penalty: 0.0, frequency_penalty: 0.0, reasoning: "off" },
};

const MODE_MIN_CTX = { default: 25600, creative: 25600, code: 128000 };

const invoke = () => window.__adm_invoke;

// HTML 转义：远端 update.json 下发的版本号 / 地址会拼进弹窗 innerHTML，需真实转义防注入
function escHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function switchPanel(panelId) {
  console.log("[settings] 切换面板:", panelId);
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((el) => el.classList.remove("active"));
  document.querySelector('[data-panel="' + panelId + '"]').classList.add("active");
  document.getElementById("panel-" + panelId).classList.add("active");
}

function showToast(message, isError) {
  const existing = document.querySelector(".save-toast, .error-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = isError ? "error-toast" : "save-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function fillSamplingFromPreset(preset) {
  document.getElementById("ctx_size").value = preset.ctx_size;
  applyCtxFloor();
  document.getElementById("temperature").value = preset.temperature;
  document.getElementById("top_k").value = preset.top_k;
  document.getElementById("top_p").value = preset.top_p;
  document.getElementById("min_p").value = preset.min_p;
  document.getElementById("repeat_penalty").value = preset.repeat_penalty;
  document.getElementById("repeat_last_n").value = preset.repeat_last_n;
  document.getElementById("dry_multiplier").value = preset.dry_multiplier;
  document.getElementById("dry_allowed_length").value = preset.dry_allowed_length;
  document.getElementById("dry_penalty_last_n").value = preset.dry_penalty_last_n;
  document.getElementById("presence_penalty").value = preset.presence_penalty;
  document.getElementById("frequency_penalty").value = preset.frequency_penalty;
  document.getElementById("reasoning").value = preset.reasoning;
}

function applyCtxFloor() {
  const mode = document.getElementById("preset_mode").value;
  const floor = MODE_MIN_CTX[mode] || 1;
  const ctxEl = document.getElementById("ctx_size");
  ctxEl.min = floor;
  const v = parseInt(ctxEl.value) || 0;
  if (v < floor) {
    ctxEl.value = floor;
    showToast(_t("当前模式上下文大小不能低于 ") + floor, false);
  }
  const hint = document.getElementById("ctx-floor-hint");
  if (hint) hint.textContent = floor > 1 ? (_t("当前模式最小 ") + floor) : "";
}

async function onPresetModeChange() {
  const mode = document.getElementById("preset_mode").value;
  const preset = PRESET_MODES[mode];
  if (!preset) return;
  fillSamplingFromPreset(preset);
  await saveParams();
}

function getParamsFromForm() {
  const nglSelect = document.getElementById("n_gpu_layers").value;
  let nglValue = nglSelect;
  if (nglSelect === "custom") nglValue = document.getElementById("n_gpu_layers_custom").value;
  const threadsVal = document.getElementById("threads").value;
  const threadsBatchVal = document.getElementById("threads_batch").value;
  let ctxSize = parseInt(document.getElementById("ctx_size").value) || 0;
  const ctxFloor = MODE_MIN_CTX[document.getElementById("preset_mode").value] || 1;
  if (ctxSize < ctxFloor) ctxSize = ctxFloor;
  return {
    ctx_size: ctxSize,
    n_predict: parseInt(document.getElementById("n_predict").value) || -1,
    batch_size: parseInt(document.getElementById("batch_size").value) || 2048,
    ubatch_size: parseInt(document.getElementById("ubatch_size").value) || 512,
    n_gpu_layers: nglValue,
    threads: threadsVal ? parseInt(threadsVal) : null,
    threads_batch: threadsBatchVal ? parseInt(threadsBatchVal) : null,
    flash_attn: document.getElementById("flash_attn").value,
    cache_type_k: document.getElementById("cache_type_k").value,
    cache_type_v: document.getElementById("cache_type_v").value,
    mlock: document.getElementById("mlock").checked,
    mmap: document.getElementById("mmap").checked,
    temperature: parseFloat(document.getElementById("temperature").value) || 1.0,
    top_k: parseInt(document.getElementById("top_k").value) || 20,
    top_p: parseFloat(document.getElementById("top_p").value) || 0.95,
    min_p: parseFloat(document.getElementById("min_p").value) || 0.0,
    repeat_penalty: parseFloat(document.getElementById("repeat_penalty").value) || 1.0,
    repeat_last_n: parseInt(document.getElementById("repeat_last_n").value) || -1,
    dry_multiplier: parseFloat(document.getElementById("dry_multiplier").value) || 0.0,
    dry_allowed_length: parseInt(document.getElementById("dry_allowed_length").value) || 2,
    dry_penalty_last_n: parseInt(document.getElementById("dry_penalty_last_n").value) || -1,
    presence_penalty: parseFloat(document.getElementById("presence_penalty").value) || 1.5,
    frequency_penalty: parseFloat(document.getElementById("frequency_penalty").value) || 0.0,
    reasoning: document.getElementById("reasoning").value,
    port: parseInt(document.getElementById("port").value) || 5678,
    host: document.getElementById("host").value,
    preset_mode: document.getElementById("preset_mode").value,
  };
}

function fillFormFromParams(params) {
  function getParam(key) { return params[key] ?? params[camelCase(key)]; }
  function camelCase(snake) { return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
  document.getElementById("ctx_size").value = getParam("ctx_size") ?? 25600;
  document.getElementById("n_predict").value = getParam("n_predict") ?? -1;
  document.getElementById("batch_size").value = getParam("batch_size") ?? 2048;
  document.getElementById("ubatch_size").value = getParam("ubatch_size") ?? 512;
  const nglValue = getParam("n_gpu_layers") ?? "auto";
  const nglSelect = document.getElementById("n_gpu_layers");
  const options = Array.from(nglSelect.options).map((o) => o.value);
  if (options.includes(nglValue)) {
    nglSelect.value = nglValue;
    document.getElementById("custom_ngl_row").style.display = "none";
  } else {
    nglSelect.value = "custom";
    document.getElementById("n_gpu_layers_custom").value = nglValue;
    document.getElementById("custom_ngl_row").style.display = "flex";
  }
  document.getElementById("threads").value = getParam("threads") ?? "";
  document.getElementById("threads_batch").value = getParam("threads_batch") ?? "";
  document.getElementById("flash_attn").value = getParam("flash_attn") ?? "on";
  document.getElementById("cache_type_k").value = getParam("cache_type_k") ?? "f16";
  document.getElementById("cache_type_v").value = getParam("cache_type_v") ?? "f16";
  document.getElementById("mlock").checked = getParam("mlock") ?? false;
  document.getElementById("mmap").checked = getParam("mmap") !== false;
  document.getElementById("temperature").value = getParam("temperature") ?? 1.0;
  document.getElementById("top_k").value = getParam("top_k") ?? 20;
  document.getElementById("top_p").value = getParam("top_p") ?? 0.95;
  document.getElementById("min_p").value = getParam("min_p") ?? 0.0;
  document.getElementById("repeat_penalty").value = getParam("repeat_penalty") ?? 1.0;
  document.getElementById("repeat_last_n").value = getParam("repeat_last_n") ?? -1;
  document.getElementById("dry_multiplier").value = getParam("dry_multiplier") ?? 0.0;
  document.getElementById("dry_allowed_length").value = getParam("dry_allowed_length") ?? 2;
  document.getElementById("dry_penalty_last_n").value = getParam("dry_penalty_last_n") ?? -1;
  document.getElementById("presence_penalty").value = getParam("presence_penalty") ?? 1.5;
  document.getElementById("frequency_penalty").value = getParam("frequency_penalty") ?? 0.0;
  document.getElementById("reasoning").value = getParam("reasoning") ?? "auto";
  document.getElementById("port").value = getParam("port") ?? 5678;
  document.getElementById("host").value = getParam("host") ?? "127.0.0.1";
  const presetMode = getParam("preset_mode") ?? "default";
  document.getElementById("preset_mode").value = PRESET_MODES[presetMode] ? presetMode : "default";
}

async function saveParams() {
  const params = getParamsFromForm();
  console.log("[settings] 保存参数:", JSON.stringify(params).substring(0, 200));
  try {
    // 加载当前设置以保留其他字段（如 agent_workdir / language）
    let current = {};
    try { current = await invoke()("load_settings"); } catch (_) {}
    const settings = {
      launch_params: params,
      agent_workdir: current.agent_workdir || current.agentWorkdir || "",
      // 保留原值（可为空 = 跟随系统语言检测）；用户显式切换时由语言选择器写入
      language: current.language || "",
    };
    await invoke()("save_settings", { settings: settings });
    console.log("[settings] 保存成功");
    showToast(_t("设置已保存，重启模型后生效"));
  } catch (e) {
    console.error("[settings] 保存失败:", e);
    showToast(_t("保存失败: ") + e, true);
  }
}

function resetParams() {
  const defaults = {
    ctx_size: 25600, n_predict: -1, batch_size: 2048, ubatch_size: 512,
    n_gpu_layers: "auto", threads: null, threads_batch: null,
    flash_attn: "on", cache_type_k: "f16", cache_type_v: "f16",
    mlock: true, mmap: true, temperature: 1.0, top_k: 20, top_p: 0.95, min_p: 0.0,
    repeat_penalty: 1.0, repeat_last_n: -1, dry_multiplier: 0.0, dry_allowed_length: 2,
    dry_penalty_last_n: -1, presence_penalty: 1.5, frequency_penalty: 0.0, reasoning: "auto",
    port: 5678, host: "127.0.0.1",
  };
  fillFormFromParams(defaults);
  applyCtxFloor();
  autoSave();
}

function autoSave() { saveParams(); }

function setupAutoSave() {
  var paramIds = [
    "ctx_size", "n_predict", "batch_size", "ubatch_size",
    "n_gpu_layers_custom", "threads", "threads_batch",
    "flash_attn", "cache_type_k", "cache_type_v",
    "mlock", "mmap",
    "temperature", "top_k", "top_p", "min_p",
    "repeat_penalty", "repeat_last_n",
    "dry_multiplier", "dry_allowed_length", "dry_penalty_last_n",
    "presence_penalty", "frequency_penalty",
    "reasoning", "port", "host"
  ];
  for (var i = 0; i < paramIds.length; i++) {
    var el = document.getElementById(paramIds[i]);
    if (el) el.addEventListener("change", autoSave);
  }
}

async function loadVersionInfo() {
  try {
    const admVersion = await invoke()("get_app_version");
    document.getElementById("v-adm").innerHTML = admVersion + ' <span id="update-badge" style="display:none;color:#4caf50;font-size:12px;margin-left:6px;">' + _t("✓ 最新") + '</span>';
  } catch (e) {
    document.getElementById("v-adm").textContent = _t("未知");
  }
  try {
    const version = await invoke()("get_llamacpp_version");
    document.getElementById("v-llamacpp").textContent = version || _t("未知");
  } catch (e) {
    document.getElementById("v-llamacpp").textContent = _t("未安装或无法检测");
  }
  try {
    const agentVersion = await invoke()("get_adm_agent_version");
    document.getElementById("v-admagent").textContent = agentVersion || _t("未知");
  } catch (e) {
    document.getElementById("v-admagent").textContent = _t("未知");
  }
  const platform = navigator.platform || navigator.userAgent;
  let osName = _t("未知");
  if (platform.includes("Win")) osName = "Windows";
  else if (platform.includes("Mac")) osName = "macOS";
  else if (platform.includes("Linux")) osName = "Linux";
  document.getElementById("v-os").textContent = osName;
}

let _confirmResolve = null;

function showConfirmDialog(message) {
  const overlay = document.getElementById("confirm-overlay");
  document.getElementById("confirm-message").textContent = message;
  overlay.classList.add("show");
  return new Promise((resolve) => { _confirmResolve = resolve; });
}

function closeConfirmDialog(result) {
  document.getElementById("confirm-overlay").classList.remove("show");
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}

async function deleteLlamacpp() {
  const confirmed = await showConfirmDialog(_t("确定要删除 llamacpp 文件夹吗？\n删除后需要重新下载才能使用 llama.cpp 相关功能。"));
  if (!confirmed) return;
  try {
    await invoke()("delete_llamacpp");
    document.getElementById("v-llamacpp").textContent = _t("未安装");
    showToast(_t("llamacpp 文件夹已删除"), false);
  } catch (e) {
    showToast(_t("删除失败: ") + e, true);
  }
}

async function checkUpdateNow() {
  const statusEl = document.getElementById("update-status");
  const badgeEl = document.getElementById("update-badge");
  statusEl.textContent = _t("检查中...");
  badgeEl.style.display = "none";
  try {
    const result = await invoke()("check_update");
    if (result.has_update) {
      statusEl.textContent = _t("发现新版本 v") + result.remote_version;
      statusEl.style.color = "#ff9800";
      const html = `
        <div class="update-icon" style="font-size:40px;text-align:center;margin-bottom:12px;">📥</div>
        <div class="update-title" style="font-size:20px;font-weight:600;color:#fff;text-align:center;margin-bottom:8px;">${_t("发现新版本")}</div>
        <div class="update-desc" style="font-size:14px;color:var(--c-text-2);text-align:center;margin-bottom:20px;line-height:1.6;">${_t("有新版本可用，是否前往下载？")}</div>
        <div class="update-info-row" style="display:flex;justify-content:center;gap:24px;margin-bottom:20px;font-size:13px;">
          <div class="info-item" style="text-align:center;"><div class="info-label" style="color:var(--c-text-3);font-size:11px;">${_t("当前版本")}</div><div class="info-value" style="color:var(--c-text);font-weight:500;margin-top:2px;">v${escHtml(result.current_version)}</div></div>
          <div class="info-item" style="text-align:center;"><div class="info-label" style="color:var(--c-text-3);font-size:11px;">${_t("最新版本")}</div><div class="info-value" style="color:var(--c-text);font-weight:500;margin-top:2px;">v${escHtml(result.remote_version)}</div></div>
        </div>
        <div class="update-buttons" style="display:flex;gap:12px;justify-content:center;">
          <button class="update-btn-primary" style="background:var(--c-accent);color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;" onclick="window.ADM.hideUpdateDialog();window.openUrl('${escHtml(result.download_url)}')">${_t("下载更新")}</button>
          <button class="update-btn-secondary" style="background:var(--c-overlay);color:var(--c-text);border:none;padding:10px 28px;border-radius:8px;font-size:14px;cursor:pointer;" onclick="window.ADM.hideUpdateDialog()">${_t("稍后再说")}</button>
        </div>`;
      window.ADM.showUpdateDialog(html);
    } else {
      statusEl.textContent = _t("已是最新版本");
      statusEl.style.color = "#4caf50";
      badgeEl.style.display = "inline";
    }
  } catch (e) {
    statusEl.textContent = _t("检查失败: ") + e;
    statusEl.style.color = "#f44336";
  }
  setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = "var(--c-text-3)"; }, 5000);
}

function goBack() { location.hash = "#/list"; }

// ===== 外观主题 =====

function renderThemeGrid() {
  const grid = document.getElementById("theme-grid");
  if (!grid) return;
  const themes = window.__ADM_THEMES || [];
  const current = (typeof window.getTheme === "function" ? window.getTheme() : "default");
  grid.innerHTML = themes.map(function (t) {
    const active = t.id === current ? " active" : "";
    const sw = (t.colors || []).map(function (c) {
      return '<span style="background:' + escHtml(c) + ';"></span>';
    }).join("");
    return '<div class="theme-card' + active + '" data-theme-id="' + escHtml(t.id) + '">' +
             '<div class="theme-preview">' + sw + '</div>' +
             '<div class="theme-name"><span class="theme-check">\u2714</span>' + escHtml(_t(t.name)) + '</div>' +
           '</div>';
  }).join("");
  grid.querySelectorAll(".theme-card").forEach(function (card) {
    card.addEventListener("click", function () {
      const id = card.dataset.themeId;
      if (typeof window.applyTheme === "function") window.applyTheme(id);
      grid.querySelectorAll(".theme-card").forEach(function (c) { c.classList.remove("active"); });
      card.classList.add("active");
      showToast(_t("已切换主题"));
    });
  });
}

// ===== 微信 Bot（iLink） =====

let wxbotUnlistens = [];
let wxbotActivities = [];

function renderWxbotStatus(s) {
  const stateEl = document.getElementById("wxbot-state");
  if (!stateEl) return;
  const map = {
    stopped: s.bound ? _t("已暂停") : _t("未绑定"),
    waiting_scan: _t("等待扫码…"),
    running: _t("运行中"),
    error: _t("错误"),
  };
  stateEl.textContent = (map[s.state] || s.state) + (s.error ? "：" + s.error : "");
  stateEl.style.color = s.state === "running" ? "#4caf50" : (s.state === "error" ? "#f44336" : "var(--c-text-2)");
  document.getElementById("wxbot-botid").textContent = s.bot_id || "-";
  document.getElementById("wxbot-owner").textContent = s.owner || "-";
  document.getElementById("wxbot-stats").textContent = _t("收 ") + (s.msg_in || 0) + _t(" / 发 ") + (s.msg_out || 0);
  const bindBtn = document.getElementById("wxbot-bind-btn");
  const toggleBtn = document.getElementById("wxbot-toggle-btn");
  const unbindBtn = document.getElementById("wxbot-unbind-btn");
  bindBtn.textContent = s.bound ? _t("重新扫码") : _t("绑定微信");
  toggleBtn.style.display = s.bound ? "" : "none";
  toggleBtn.textContent = s.state === "running" ? _t("暂停") : _t("启动");
  toggleBtn.dataset.running = s.state === "running" ? "1" : "0";
  unbindBtn.style.display = s.bound ? "" : "none";
}

async function refreshWxbotStatus() {
  try {
    const s = await invoke()("get_ilink_status");
    renderWxbotStatus(s);
  } catch (e) {
    console.error("[settings] 获取微信 Bot 状态失败:", e);
  }
}

function showWxbotQr(payload) {
  const overlay = document.getElementById("wxbot-qr-overlay");
  const box = document.getElementById("wxbot-qr-box");
  overlay.classList.add("show");
  const img = payload && payload.qrcode_img ? String(payload.qrcode_img) : "";
  const url = payload && payload.qrcode_url ? String(payload.qrcode_url) : "";
  if (img) {
    // qrcode_img_content 可能是 data URL / 图片地址 / 裸 base64
    const src = img.startsWith("data:") ? img : (img.startsWith("http") ? img : "data:image/png;base64," + img);
    box.innerHTML = '<img alt="二维码" style="width:200px;height:200px;" src="' + escHtml(src) + '">';
  } else if (url) {
    box.innerHTML = '<span style="color:#333;font-size:12px;word-break:break-all;padding:8px;">' + escHtml(url) + "</span>";
  } else {
    box.innerHTML = '<span style="color:#333;font-size:13px;">' + _t("二维码加载中…") + '</span>';
  }
}

function hideWxbotQr() {
  const overlay = document.getElementById("wxbot-qr-overlay");
  if (overlay) overlay.classList.remove("show");
}

function showWxbotCode(retry) {
  hideWxbotQr();
  const overlay = document.getElementById("wxbot-code-overlay");
  if (!overlay) return;
  const hint = document.getElementById("wxbot-code-hint");
  if (hint) hint.textContent = retry ? _t("配对码错误，请重新输入微信手机端显示的数字：") : _t("请输入微信手机端显示的配对数字：");
  const input = document.getElementById("wxbot-code-input");
  if (input) input.value = "";
  overlay.classList.add("show");
  if (input) setTimeout(function () { input.focus(); }, 50);
}

function hideWxbotCode() {
  const overlay = document.getElementById("wxbot-code-overlay");
  if (overlay) overlay.classList.remove("show");
}

async function submitWxbotCode() {
  const input = document.getElementById("wxbot-code-input");
  const code = input ? String(input.value || "").trim() : "";
  if (!code) {
    showToast(_t("请先输入配对码"), true);
    return;
  }
  try {
    await invoke()("submit_ilink_verify_code", { code: code });
    hideWxbotCode();
  } catch (e) {
    showToast(_t("提交配对码失败: ") + e, true);
  }
}

function pushWxbotActivity(p) {
  wxbotActivities.unshift(p);
  if (wxbotActivities.length > 50) wxbotActivities.pop();
  const el = document.getElementById("wxbot-activity");
  if (!el) return;
  el.innerHTML = wxbotActivities.map(function (a) {
    const t = new Date(a.ts || Date.now());
    const hh = ("0" + t.getHours()).slice(-2) + ":" + ("0" + t.getMinutes()).slice(-2) + ":" + ("0" + t.getSeconds()).slice(-2);
    const dir = a.direction === "in" ? _t("⬅️ 收") : (a.direction === "out" ? _t("➡️ 发") : "⚠️");
    return "<div>[" + hh + "] " + dir + " " + escHtml(a.summary || "") + "</div>";
  }).join("");
}

async function setupWxbotPanel() {
  document.getElementById("wxbot-bind-btn").addEventListener("click", async function () {
    try {
      showWxbotQr(null);
      await invoke()("start_ilink_login");
    } catch (e) {
      hideWxbotQr();
      showToast(_t("启动绑定失败: ") + e, true);
    }
  });
  document.getElementById("wxbot-qr-cancel-btn").addEventListener("click", async function () {
    hideWxbotQr();
    try { await invoke()("cancel_ilink_login"); } catch (_) {}
  });
  document.getElementById("wxbot-code-ok-btn").addEventListener("click", submitWxbotCode);
  document.getElementById("wxbot-code-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") submitWxbotCode();
  });
  document.getElementById("wxbot-code-cancel-btn").addEventListener("click", async function () {
    hideWxbotCode();
    try { await invoke()("cancel_ilink_login"); } catch (_) {}
  });
  document.getElementById("wxbot-toggle-btn").addEventListener("click", async function () {
    const running = this.dataset.running === "1";
    try {
      if (running) {
        await invoke()("stop_ilink_bridge");
        showToast(_t("微信 Bot 已暂停"));
      } else {
        await invoke()("start_ilink_bridge");
        showToast(_t("微信 Bot 已启动"));
      }
    } catch (e) {
      showToast(_t("操作失败: ") + e, true);
    }
    refreshWxbotStatus();
  });
  document.getElementById("wxbot-unbind-btn").addEventListener("click", async function () {
    const ok = await showConfirmDialog(_t("确定要解绑微信 Bot 吗？\n解绑将删除登录凭据与会话映射，需重新扫码才能使用。"));
    if (!ok) return;
    try {
      await invoke()("unbind_ilink");
      showToast(_t("已解绑微信 Bot"));
    } catch (e) {
      showToast(_t("解绑失败: ") + e, true);
    }
    refreshWxbotStatus();
  });

  // 事件订阅（unmount 时统一释放，防重复绑定）
  try {
    const un1 = await window.__adm_listen("ilink-status", function (ev) {
      const p = ev.payload || {};
      if (p.state === "waiting_scan") {
        showWxbotQr(p);
      } else if (p.state === "waiting_verify_code") {
        showWxbotCode(!!p.retry);
      } else {
        hideWxbotQr();
        hideWxbotCode();
        if (p.state === "running") showToast(_t("微信 Bot 已连接"));
        if (p.state === "error" && p.error) showToast(_t("微信 Bot: ") + p.error, true);
      }
      refreshWxbotStatus();
    });
    wxbotUnlistens.push(un1);
    const un2 = await window.__adm_listen("ilink-activity", function (ev) {
      pushWxbotActivity(ev.payload || {});
    });
    wxbotUnlistens.push(un2);
  } catch (e) {
    console.error("[settings] 订阅微信 Bot 事件失败:", e);
  }
  refreshWxbotStatus();
}

export default {
  template,
  mount(root) {
    console.log("[settings] mount()");
    root.innerHTML = template;

    // 禁用页面右键（屏蔽浏览器默认菜单；#confirm-overlay / #wxbot-qr-overlay 是 #settings-app 的兄弟节点，需各自绑定）
    ["settings-app", "confirm-overlay", "wxbot-qr-overlay", "wxbot-code-overlay"].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("contextmenu", function(e) { e.preventDefault(); });
    });

    document.getElementById("back-btn").addEventListener("click", goBack);
    document.querySelectorAll(".nav-item").forEach(function(el) {
      el.addEventListener("click", function() { switchPanel(el.dataset.panel); });
    });
    document.getElementById("preset_mode").addEventListener("change", onPresetModeChange);
    document.getElementById("n_gpu_layers").addEventListener("change", function() {
      const customRow = document.getElementById("custom_ngl_row");
      if (this.value === "custom") customRow.style.display = "flex";
      else customRow.style.display = "none";
      autoSave();
    });
    document.getElementById("ctx_size").addEventListener("change", function() { applyCtxFloor(); autoSave(); });
    document.getElementById("reset-btn").addEventListener("click", resetParams);
    document.getElementById("check-update-btn").addEventListener("click", checkUpdateNow);
    document.getElementById("delete-llamacpp-btn").addEventListener("click", deleteLlamacpp);
    document.getElementById("confirm-cancel-btn").addEventListener("click", function() { closeConfirmDialog(false); });
    document.getElementById("confirm-ok-btn").addEventListener("click", function() { closeConfirmDialog(true); });

    // 语言切换：保存到 Settings.language + localStorage，并立即重建当前视图生效
    const langSelect = document.getElementById("ui-lang-select");
    if (langSelect) {
      langSelect.value = getLanguage();
      langSelect.addEventListener("change", async function () {
        const lang = this.value;
        try {
          let current = {};
          try { current = await invoke()("load_settings"); } catch (_) {}
          await invoke()("save_settings", Object.assign({}, current, { language: lang }));
        } catch (_) {}
        setLanguage(lang);
        location.reload();
      });
    }

    setupAutoSave();
    setupWxbotPanel();
    renderThemeGrid();

    (async function() {
      try {
        const settings = await invoke()("load_settings");
        console.log("[settings] 加载设置成功, keys:", Object.keys(settings));
        const params = settings.launch_params || settings.launchParams;
        if (settings && params) fillFormFromParams(params);
        applyCtxFloor();
      } catch (e) {
        console.error("加载设置失败:", e);
      }
      loadVersionInfo();
    })();
  },
  unmount() {
    console.log("[settings] unmount()");
    // 释放微信 Bot 事件监听，防止重复绑定泄漏
    wxbotUnlistens.forEach(function (un) {
      try { un(); } catch (_) {}
    });
    wxbotUnlistens = [];
    wxbotActivities = [];
  }
};
