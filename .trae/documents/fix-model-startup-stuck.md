# 修复：模型启动失败后无法重新启动的问题

## 问题描述

模型启动失败（如进程崩溃、参数错误等）后，再次点击"启动"按钮，提示"已有模型在运行中，请先停止当前模型"。

## 当前状态分析

### 启动流程

1. 用户点击"启动" → 前端 `handleStart()` → 调用后端 `start_model` Command
2. `start_model` 先检查 `state.running_process` — 如果不为 `None`，返回错误
3. 验证通过后，spawn llama-server 子进程
4. **如果 spawn 成功**，立即将 PID 写入 `AppState`（`running_process = Some(pid)`）
5. 返回 `Ok(())` 给前端
6. 后台线程开始读取子进程的 stdout/stderr
7. **如果子进程立即崩溃退出** → 后台线程读取到 EOF → 发送 `model-stopped` 事件给前端
8. 前端收到 `model-stopped` → 设置 `runningModelId = null` → 重新渲染表格 → 按钮恢复为"启动"
9. 用户再次点击"启动"
10. `start_model` 检查 `state.running_process` → **仍然为 `Some(pid)`**（从未被清除）
11. 返回错误 `"已有模型在运行中，请先停止当前模型"`

### 根因

**后台线程**在检测到进程退出时，只**给前端发送了 `model-stopped` 事件**（[model_list.rs](file:///f:/trae/adm/src-tauri/src/pages/model_list.rs#L944-L949)），但没有清除 `AppState` 中的 `running_process`、`running_model_id`、`running_port` 字段。

对比 `stop_model`（[model_list.rs#L955-994](file:///f:/trae/adm/src-tauri/src/pages/model_list.rs#L955-L994)）做了完整的清理（将三个字段都设为 `None`），但后台线程没有。

另外，`get_model_status`（[model_list.rs#L996-1024](file:///f:/trae/adm/src-tauri/src/pages/model_list.rs#L996-L1024)）虽然**在查询调用时也会检查进程是否存活并清理**，但用户再次点击启动时并不会自动触发 `get_model_status`，所以状态一直"脏"着。

## 修改方案

只改一个文件：[f:\trae\adm\src-tauri\src\pages\model_list.rs](file:///f:/trae/adm/src-tauri/src/pages/model_list.rs)

### 修改点：后台线程 - 清除 AppState 后发送 model-stopped

**位置**：在后台线程中，读取 stdout/stderr 的循环结束后，在发送 `model-stopped` 事件之前，清除 `AppState` 中的状态。

**具体改动**（[model_list.rs#L944](file:///f:/trae/adm/src-tauri/src/pages/model_list.rs#L944) 之前新增代码块）：

```rust
// 在发送 model-stopped 之前，清除 AppState 中的状态
{
    let state = app_clone.state::<AppState>();
    if let Ok(mut pid_lock) = state.running_process.lock() {
        *pid_lock = None;
    }
    if let Ok(mut model_lock) = state.running_model_id.lock() {
        *model_lock = None;
    }
    if let Ok(mut port_lock) = state.running_port.lock() {
        *port_lock = None;
    }
}

app_clone
    .emit("model-stopped", ...)
    .ok();
```

**为什么可以这样做**：
- Tauri 2.x 的 `AppHandle::state::<T>()` 方法可以在任何线程中安全调用（`AppState` 中的字段都是 `Mutex` 保护的）
- 这与 `stop_model` Command 的清理逻辑完全一致
- 在发送 `model-stopped` 事件前清理状态，确保前端收到事件时后端状态已经干净

### 不需要修改的文件

- `src/model_list.html` — 前端的事件处理逻辑和 UI 渲染逻辑正确，不需要改
- `src-tauri/src/app_state.rs` — 状态结构体定义不需要更改
- 其他文件不受影响

## 验证步骤

1. `pnpm tauri build` 编译通过
2. 启动一个参数配置有问题的模型（如无效的端口），让其启动后立即崩溃
3. 确认按钮恢复为"启动"状态
4. 再次点击"启动"，确认不再弹出"已有模型在运行中"的错误
5. 正常启动一个模型，确认正常运行不受影响
6. 正常停止模型，确认正常停止不受影响

## 可能的风险

- 无。改动与 `stop_model` 中的清理逻辑一致，只增加了一个安全的 Mutex 解锁和 None 赋值操作。
