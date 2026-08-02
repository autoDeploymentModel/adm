// 全局类型声明 —— 仅供编辑器与 `pnpm typecheck`（tsc --noEmit）使用，不参与运行时。
// 前端不编译：这里只描述 index.html 暴露的全局与 Tauri IPC 的形状。

export {};

declare global {
  /** 微信 Bot（iLink）状态（get_ilink_status 命令返回 / ilink-status 事件 payload 子集） */
  interface IlinkStatus {
    state: "stopped" | "waiting_scan" | "running" | "error";
    bound: boolean;
    enabled: boolean;
    bot_id: string;
    owner: string;
    error: string;
    msg_in: number;
    msg_out: number;
    /** 微信跟随模式：开启时微信消息注入桌面当前打开的会话 */
    follow: boolean;
  }

  interface Window {
    /** Tauri invoke（index.html 初始化时暴露给所有视图模块） */
    __adm_invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
    /** Tauri event.listen（返回 unlisten 函数的 Promise） */
    __adm_listen: (event: string, handler: (event: { payload: any }) => void) => Promise<() => void>;
    /** 跨视图共享状态（systemInfo / runningModelId / modelList 等） */
    __adm_state: {
      systemInfo: any;
      runningModelId: string | null;
      runningModelPort: number | null;
      localModels: any[];
      partFiles: Record<string, any>;
      downloadingModels: Record<string, any>;
      downloadingMmproj: Record<string, any>;
      downloadingDiffusion: Record<string, any>;
      downloadingVae: Record<string, any>;
      modelList: any[];
      modelTypes: any[];
      currentTypeFilter: string;
      [key: string]: any;
    };
    /** index.html 暴露的更新弹窗控制 + i18n */
    ADM: {
      showUpdateDialog: (html: string) => void;
      hideUpdateDialog: () => void;
      checkForUpdate: (silent?: boolean) => Promise<void>;
      i18n?: {
        t: (str: string) => string;
        tV: (str: string, vars?: Record<string, string | number>) => string;
        setLanguage: (l: string) => void;
        getLanguage: () => string;
        syncLanguageFromSettings: (settings: any) => void;
        applyToDOM: (root: any) => void;
      };
    };
    __TAURI__?: any;
    __TAURI_INTERNALS__?: any;
    goAgent: () => Promise<void>;
    openUrl: (url: string) => void;
  }
}
