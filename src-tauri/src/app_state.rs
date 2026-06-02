use std::collections::HashMap;
use std::sync::Mutex;
use sysinfo::System;

pub struct AppState {
    pub running_process: Mutex<Option<u32>>,
    pub running_model_id: Mutex<Option<String>>,
    pub running_port: Mutex<Option<u16>>,
    pub downloading_progress: Mutex<HashMap<String, u8>>,
    pub downloading_phase: Mutex<HashMap<String, String>>,
    pub sd_downloading: Mutex<bool>,
    pub sd_download_progress: Mutex<u8>,
    pub sd_download_status: Mutex<String>,
    pub sys: Mutex<System>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            running_process: Mutex::new(None),
            running_model_id: Mutex::new(None),
            running_port: Mutex::new(None),
            downloading_progress: Mutex::new(HashMap::new()),
            downloading_phase: Mutex::new(HashMap::new()),
            sd_downloading: Mutex::new(false),
            sd_download_progress: Mutex::new(0),
            sd_download_status: Mutex::new("".to_string()),
            sys: Mutex::new(System::new_all()),
        }
    }

    #[allow(dead_code)]
    pub fn get_running_pid(&self) -> Option<u32> {
        self.running_process.lock().map(|g| g.clone()).unwrap_or(None)
    }

    #[allow(dead_code)]
    pub fn set_running_pid(&self, pid: u32) {
        *self.running_process.lock().unwrap() = Some(pid);
    }

    #[allow(dead_code)]
    pub fn clear_running(&self) {
        *self.running_process.lock().unwrap() = None;
        *self.running_model_id.lock().unwrap() = None;
        *self.running_port.lock().unwrap() = None;
    }
}
