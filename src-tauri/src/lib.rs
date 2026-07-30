mod app_state;
mod common;
mod pages;

use app_state::AppState;
use pages::{agent, index, model_list, model_image, settings, ilink};

use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

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
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
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
        .manage(ilink::IlinkManaged::default())
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
                            if window.is_minimized().unwrap_or(false) {
                                // 最小化在任务栏：恢复显示并带到前台
                                show_main_window(app);
                            } else if window.is_visible().unwrap_or(false) {
                                // 隐藏到托盘（macOS 不调 set_skip_taskbar，避免 Accessory 策略）
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

            // iLink 微信 Bot：已绑定且启用时自动恢复桥接（内部等待 admAgent 就绪）
            ilink::auto_start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    let _api = api; // 标记为未用
                    // macOS：点击关闭一律退出，不最小化到托盘
                    // 注意：不需要 api.prevent_close()，正常退出即可
                    cleanup_processes(window.app_handle());
                }
                #[cfg(not(target_os = "macos"))]
                {
                    // Windows/Linux：拦截关闭，隐藏到系统托盘（模型继续运行）
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.set_skip_taskbar(true);
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
            // ilink.rs - 微信 Bot 桥接
            ilink::start_ilink_login,
            ilink::cancel_ilink_login,
            ilink::submit_ilink_verify_code,
            ilink::get_ilink_status,
            ilink::start_ilink_bridge,
            ilink::stop_ilink_bridge,
            ilink::unbind_ilink,
            ilink::set_ilink_follow,
            ilink::set_ilink_current_session,
            // lib.rs (index.rs)
            index::minimize_to_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
