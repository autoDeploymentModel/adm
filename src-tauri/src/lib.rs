mod app_state;
mod common;
mod pages;

use app_state::AppState;
use pages::{agent, index, model_list, model_image, settings};

use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

/// 读取用户设置：是否启用"关闭窗口时最小化到系统托盘"。
/// 读取失败时默认返回 false（禁用），以提供更好的开箱体验（在 macOS 上直接退出）。
fn read_minimize_to_tray(app: &tauri::AppHandle) -> bool {
    use crate::common::config;
    use crate::common::types::Settings;

    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return false,
    };
    let config_path = data_dir.join("config.json");
    if !config_path.exists() {
        return false;
    }
    let json = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let settings: Settings = match serde_json::from_str(&json) {
        Ok(s) => s,
        Err(_) => return false,
    };
    settings.minimize_to_tray
}

/// 显示主窗口并带到前台（跨平台）。
///
/// macOS 关键点：`set_skip_taskbar(true)` 在 macOS 上会切换到 `Accessory` 激活策略
/// （隐藏 Dock 图标），之后单纯 `show()` + `set_focus()` 无法把窗口带到前台。
/// 因此 macOS 上需要先显式恢复 `Regular` 激活策略，再 `show` + `set_focus`。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "macos")]
        {
            // macOS：先恢复 Regular 策略（Dock 图标 + 菜单栏），再显示窗口
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            let _ = window.show();
            let _ = window.set_focus();
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window.set_skip_taskbar(false);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// 隐藏主窗口到系统托盘（跨平台）。
///
/// macOS 不调用 `set_skip_taskbar(true)`，避免切换到 `Accessory` 策略导致
/// 后续无法从托盘恢复窗口；Dock 图标保持可见（符合 macOS 习惯）。
fn hide_main_window(window: &tauri::Window) {
    let _ = window.hide();
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_skip_taskbar(true);
    }
}

/// 清理所有子进程（模型 / SD / Agent / admAgent）。
/// 从原 `on_window_event(CloseRequested)` 提取，供托盘"退出"和正常关闭复用。
fn cleanup_processes(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();

    // 强杀记录中的模型/SD 进程（整棵进程树）
    let pid_opt = state.running_process.lock().ok().and_then(|l| *l);
    if let Some(pid) = pid_opt {
        crate::common::utils::platform::kill_process_tree(pid);
    }
    // 兜底：按进程名清理任何残留的 llama-server / SD 子进程
    #[cfg(target_os = "windows")]
    {
        crate::common::utils::platform::kill_process_by_name("llama-server.exe");
        crate::common::utils::platform::kill_process_by_name("sd-cli.exe");
    }
    #[cfg(not(target_os = "windows"))]
    {
        crate::common::utils::platform::kill_process_by_name("llama-server");
        crate::common::utils::platform::kill_process_by_name("sd-cli");
    }

    // 关闭 Agent 会话
    agent::kill_agent_session(&state);

    // Windows 平台：关闭 admAgent 进程
    #[cfg(target_os = "windows")]
    {
        crate::common::utils::platform::kill_process_by_name("admAgent.exe");
    }
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 单实例：第二个实例启动时，让第一个实例显示窗口
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_hwinfo::init())
        .manage(AppState::new())
        .setup(|app| {
            // ===== 系统托盘 =====
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 ADM", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("ADM")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "quit" => {
                        cleanup_processes(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Windows 上单击会触发两次 Click（Down + Up），
                    // 仅在鼠标释放（Up）时处理，避免 show→hide 闪一下又消失
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                // 隐藏到托盘（与 hide_main_window 逻辑一致）
                                let _ = window.hide();
                                #[cfg(not(target_os = "macos"))]
                                {
                                    let _ = window.set_skip_taskbar(true);
                                }
                            } else {
                                show_main_window(app);
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();

            // 点击右上角最小化按钮：直接隐藏到系统托盘
            if let tauri::WindowEvent::Resized(_) = event {
                if read_minimize_to_tray(app) && window.is_minimized().unwrap_or(false) {
                    let _ = window.unminimize();
                    hide_main_window(window);
                }
                return;
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    let _api = api; // 标记为未用
                    // macOS：点击关闭一律退出，不最小化到托盘
                    // 注意：不需要 api.prevent_close()，正常退出即可
                    cleanup_processes(app);
                }
                #[cfg(not(target_os = "macos"))]
                {
                    if read_minimize_to_tray(app) {
                        // 最小化到托盘：拦截关闭，隐藏窗口
                        api.prevent_close();
                        hide_main_window(window);
                        // 通知前端显示提示
                        let _ = app.emit("window-minimized-to-tray", ());
                        return;
                    }
                    // 未启用托盘：执行进程清理，窗口正常关闭 → 应用退出
                    cleanup_processes(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // index.rs
            index::get_system_info,
            index::check_update,
            index::download_and_extract_llamacpp,
            // model_list.rs
            model_list::scan_local_models,
            model_list::scan_part_files,
            model_list::fetch_model_list,
            model_list::download_model,
            model_list::start_model,
            model_list::stop_model,
            model_list::get_model_status,
            model_list::is_model_running,
            model_list::delete_local_model,
            model_list::get_downloading_models,
            model_list::get_downloading_phases,
            // model_image.rs
            model_image::get_sd_status,
            model_image::download_and_extract_sd,
            model_image::start_sd_generation,
            model_image::stop_sd,
            model_image::save_sd_image_as,
            // settings.rs
            settings::save_settings,
            settings::load_settings,
            settings::get_app_version,
            settings::get_llamacpp_version,
            settings::delete_llamacpp,
            // agent.rs - server mode
            agent::get_platform_os,
            agent::get_platform_arch,
            agent::prepare_adm_agent_config,
            agent::check_adm_agent,
            agent::get_adm_agent_version,
            agent::download_adm_agent,
            agent::check_adm_agent_update,
            agent::download_adm_agent_update,
            agent::get_agent_workdir,
            agent::set_agent_workdir,
            agent::pick_workdir_folder,
            agent::add_cloud_provider,
            agent::list_cloud_providers,
            agent::update_cloud_provider,
            agent::delete_cloud_provider,
            agent::start_agent_server,
            agent::stop_agent_server,
            agent::get_agent_server_status,
            agent::agent_http_request,
            agent::agent_subscribe_events,
            agent::agent_unsubscribe_events,
            agent::get_adm_agent_logs,
            agent::export_agent_logs,
            // lib.rs (index.rs)
            index::minimize_to_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
