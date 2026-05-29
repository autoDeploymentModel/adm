# 设置页面 - 推荐模式下拉列表实现计划

## 需求分析

在设置页面的"模型启动参数"栏顶部增加一个推荐模式下拉列表，包含三个选项：
- **默认（日常聊天）**：平衡参数
- **创意写作**：适合创意写作的参数配置
- **写代码 / 编程**：防复读、代码稳定的参数配置

下拉列表修改后自动保存，无需点击保存按钮。

## 实现步骤

### 1. 修改 Rust 后端

**文件**: `src-tauri/src/common/types.rs`

#### 1.1 添加缺失的参数字段

在 `LaunchParams` 结构体中添加以下字段：

```rust
pub presence_penalty: Option<f64>,
pub frequency_penalty: Option<f64>,
pub dry_allowed_length: Option<i32>,
pub dry_penalty_last_n: Option<i32>,
pub preset_mode: Option<String>,
```

#### 1.2 更新 Default 实现

在 `Default` 实现中添加对应的默认值：

```rust
presence_penalty: None,
frequency_penalty: None,
dry_allowed_length: None,
dry_penalty_last_n: None,
preset_mode: None,
```

### 2. 修改前端

**文件**: `src/settings.html`

#### 2.1 添加推荐模式下拉列表

在"模型启动参数"面板顶部（`panel-title` 之后）添加：

```html
<div class="param-group" style="margin-bottom: 28px;">
  <div class="param-group-title">推荐模式</div>
  <div class="param-row">
    <div class="param-label">
      选择模式
      <div class="param-key">快速配置</div>
    </div>
    <div class="param-input">
      <select id="preset_mode" onchange="onPresetModeChange()">
        <option value="default">默认（日常聊天）</option>
        <option value="creative">创意写作</option>
        <option value="code">写代码 / 编程（推荐）</option>
      </select>
      <div class="param-desc">选择后自动填充并保存采样参数，可手动微调后点保存</div>
    </div>
  </div>
</div>
```

#### 2.2 添加新的采样参数输入框

在"采样参数"组中添加以下输入框：

```html
<div class="param-row">
  <div class="param-label">
    DRY 允许长度
    <div class="param-key">--dry-allowed-length</div>
  </div>
  <div class="param-input">
    <input type="number" id="dry_allowed_length" value="2" step="1" min="1">
    <div class="param-desc">DRY 采样允许的重复长度，代码模式建议设为 1</div>
  </div>
</div>

<div class="param-row">
  <div class="param-label">
    DRY 惩罚窗口
    <div class="param-key">--dry-penalty-last-n</div>
  </div>
  <div class="param-input">
    <input type="number" id="dry_penalty_last_n" value="-1" step="1">
    <div class="param-desc">DRY 惩罚的最后 n 个 token，-1 表示使用上下文大小</div>
  </div>
</div>

<div class="param-row">
  <div class="param-label">
    存在惩罚
    <div class="param-key">--presence-penalty</div>
  </div>
  <div class="param-input">
    <input type="number" id="presence_penalty" value="0.0" step="0.05" min="0">
    <div class="param-desc">重复 alpha 存在惩罚，0.0 表示禁用</div>
  </div>
</div>

<div class="param-row">
  <div class="param-label">
    频率惩罚
    <div class="param-key">--frequency-penalty</div>
  </div>
  <div class="param-input">
    <input type="number" id="frequency_penalty" value="0.0" step="0.05" min="0">
    <div class="param-desc">重复 alpha 频率惩罚，0.0 表示禁用</div>
  </div>
</div>
```

#### 2.3 添加预设参数配置

在 `<script>` 中添加三个模式的参数预设：

```javascript
const PRESET_MODES = {
  default: {
    temperature: 0.7,
    top_k: 40,
    top_p: 0.95,
    min_p: 0.0,
    repeat_penalty: 1.1,
    repeat_last_n: -1,
    dry_penalty: 0.8,
    dry_allowed_length: 2,
    dry_penalty_last_n: -1,
    presence_penalty: 0.0,
    frequency_penalty: 0.0,
    reasoning: "auto",
  },
  creative: {
    temperature: 0.9,
    top_k: 60,
    top_p: 0.95,
    min_p: 0.0,
    repeat_penalty: 1.15,
    repeat_last_n: -1,
    dry_penalty: 0.9,
    dry_allowed_length: 2,
    dry_penalty_last_n: -1,
    presence_penalty: 0.1,
    frequency_penalty: 0.1,
    reasoning: "auto",
  },
  code: {
    temperature: 0.2,
    top_k: 25,
    top_p: 0.85,
    min_p: 0.0,
    repeat_penalty: 1.1,
    repeat_last_n: -1,
    dry_penalty: 0.7,
    dry_allowed_length: 1,
    dry_penalty_last_n: -1,
    presence_penalty: 0.05,
    frequency_penalty: 0.05,
    reasoning: "auto",
  },
};
```

#### 2.4 添加自动保存函数

```javascript
async function onPresetModeChange() {
  const mode = document.getElementById("preset_mode").value;
  const preset = PRESET_MODES[mode];
  if (!preset) return;
  
  fillSamplingFromPreset(preset);
  await saveParams();
}

function fillSamplingFromPreset(preset) {
  document.getElementById("temperature").value = preset.temperature;
  document.getElementById("top_k").value = preset.top_k;
  document.getElementById("top_p").value = preset.top_p;
  document.getElementById("min_p").value = preset.min_p;
  document.getElementById("repeat_penalty").value = preset.repeat_penalty;
  document.getElementById("repeat_last_n").value = preset.repeat_last_n;
  document.getElementById("dry_penalty").value = preset.dry_penalty;
  document.getElementById("dry_allowed_length").value = preset.dry_allowed_length;
  document.getElementById("dry_penalty_last_n").value = preset.dry_penalty_last_n;
  document.getElementById("presence_penalty").value = preset.presence_penalty;
  document.getElementById("frequency_penalty").value = preset.frequency_penalty;
  document.getElementById("reasoning").value = preset.reasoning;
}
```

#### 2.5 修改 `fillFormFromParams` 函数

在现有函数末尾添加对 `preset_mode` 的处理，设置下拉列表选中值。

#### 2.6 修改 `getParamsFromForm` 函数

添加新参数到返回对象中：

```javascript
presence_penalty: parseFloat(document.getElementById("presence_penalty").value) || 0.0,
frequency_penalty: parseFloat(document.getElementById("frequency_penalty").value) || 0.0,
dry_allowed_length: parseInt(document.getElementById("dry_allowed_length").value) || 2,
dry_penalty_last_n: parseInt(document.getElementById("dry_penalty_last_n").value) || -1,
preset_mode: document.getElementById("preset_mode").value,
```

### 3. 参数值设计依据

参考 `doc/llamacpp.txt` 中的采样参数默认值：

| 参数                 | llamacpp 默认 | 默认（日常聊天） | 创意写作 | 写代码/编程 |
| -------------------- | ------------- | ---------------- | -------- | ----------- |
| `--temp`             | 0.80          | 0.7              | 0.9      | 0.2         |
| `--top-k`            | 40            | 40               | 60       | 20~30       |
| `--top-p`            | 0.95          | 0.95             | 0.95     | 0.85~0.9    |
| `--min-p`            | 0.05          | 0.0              | 0.0      | 0.0         |
| `--repeat-penalty`   | 1.00          | 1.1              | 1.15     | 1.08~1.1    |
| `--repeat-last-n`    | 64            | -1               | -1       | -1          |
| `--dry-multiplier`   | 0.00          | 0.8              | 0.9      | 0.6~0.8     |
| `--dry-allowed-length` | 2           | 2                | 2        | 1           |
| `--dry-penalty-last-n` | -1          | -1               | -1       | -1          |
| `--presence-penalty` | 0.00          | 0.0              | 0.1      | 0.05        |
| `--frequency-penalty`| 0.00          | 0.0              | 0.1      | 0.05        |

**写代码模式设计要点**：
- 低温度 (0.2)：输出更确定、更稳定
- 低 top-k (25)：减少随机性
- min_p=0.0：必须关闭
- repeat_penalty=1.1：保留重复惩罚防止复读
- dry_allowed_length=1：代码极怕重复
- reasoning=auto：保留推理能力，便于理解复杂逻辑

**创意写作模式设计要点**：
- 较高温度 (0.9)：增加创意和多样性
- 高 top-k (60)：扩大采样范围
- 较高 repeat_penalty (1.15)：适度防止复读
- 较高 dry_multiplier (0.9)：进一步防止重复
- presence/frequency_penalty=0.1：增加多样性

### 4. 文件修改清单

| 文件                              | 修改内容                                           |
| --------------------------------- | -------------------------------------------------- |
| `src-tauri/src/common/types.rs`   | 添加 presence_penalty, frequency_penalty, dry_allowed_length, dry_penalty_last_n, preset_mode 字段 |
| `src/settings.html`               | 添加下拉列表 UI + 新输入框 + 预设逻辑 + 自动保存  |

### 5. 验证方式

1. 运行 `pnpm tauri dev` 启动应用
2. 进入设置页面，确认下拉列表显示三个选项
3. 切换选项，确认参数自动填充
4. 刷新页面，确认选择被保存
5. 选择"写代码"模式，确认 dry_allowed_length=1、min_p=0.0
