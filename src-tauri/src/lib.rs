mod app_state;
mod common;
mod pages;

use app_state::AppState;
use pages::{agent, index, model_list, model_image, settings};

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_hwinfo::init())
        .manage(AppState::new())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let pid_opt = state.running_process.lock().ok().and_then(|l| *l);
                if let Some(pid) = pid_opt {
                    #[cfg(target_os = "windows")]
                    {
                        let pid_str: String = pid.to_string();
                        let _ = crate::common::utils::platform::create_hidden_command("taskkill")
                            .args(["/PID", &pid_str, "/F"])
                            .spawn();
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        let _ = crate::common::utils::platform::create_hidden_command("kill")
                            .args(["-9", &pid.to_string()])
                            .spawn();
                    }
                }

                // 关闭 Agent 终端会话
                agent::kill_agent_session(&state);
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
            // agent.rs
            agent::get_platform_os,
            agent::prepare_adm_agent_config,
            agent::check_adm_agent,
            agent::download_adm_agent,
            agent::check_adm_agent_update,
            agent::download_adm_agent_update,
            agent::get_agent_workdir,
            agent::set_agent_workdir,
            agent::get_agent_status,
            agent::start_agent_terminal,
            agent::stop_agent_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
