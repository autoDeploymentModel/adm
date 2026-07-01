# llama-server CLI 参考文档

> 来源: `llama-server.exe --help`

---

## 通用参数

| 参数 | 说明 |
|---|---|
| `-h`, `--help`, `--usage` | 打印帮助信息并退出 |
| `--version` | 显示版本和构建信息 |
| `--license` | 显示源代码许可和依赖信息 |
| `-cl`, `--cache-list` | 显示缓存中的模型列表 |
| `--completion-bash` | 打印可用于 llama.cpp 的 bash 补全脚本 |
| `-t`, `--threads N` | 生成时使用的 CPU 线程数（默认: -1）<br>环境变量: `LLAMA_ARG_THREADS` |
| `-tb`, `--threads-batch N` | 批处理和提示处理时使用的线程数（默认: 同 `--threads`） |
| `-C`, `--cpu-mask M` | CPU 亲和性掩码（任意长十六进制），与 cpu-range 互补（默认: ""） |
| `-Cr`, `--cpu-range lo-hi` | CPU 亲和性范围，与 `--cpu-mask` 互补 |
| `--cpu-strict <0\|1>` | 使用严格的 CPU 放置（默认: 0） |
| `--prio N` | 设置进程/线程优先级：low(-1), normal(0), medium(1), high(2), realtime(3)（默认: 0） |
| `--poll <0...100>` | 使用轮询级别等待工作（0 = 不轮询，默认: 50） |
| `-Cb`, `--cpu-mask-batch M` | 批处理 CPU 亲和性掩码（默认: 同 `--cpu-mask`） |
| `-Crb`, `--cpu-range-batch lo-hi` | 批处理 CPU 亲和性范围 |
| `--cpu-strict-batch <0\|1>` | 批处理严格 CPU 放置（默认: 同 `--cpu-strict`） |
| `--prio-batch N` | 批处理进程/线程优先级（默认: 0） |
| `--poll-batch <0\|1>` | 批处理使用轮询等待工作（默认: 同 `--poll`） |
| `-c`, `--ctx-size N` | 提示上下文大小（默认: 0，0 = 从模型加载）<br>环境变量: `LLAMA_ARG_CTX_SIZE` |
| `-n`, `--predict`, `--n-predict N` | 预测的 token 数量（默认: -1，-1 = 无限）<br>环境变量: `LLAMA_ARG_N_PREDICT` |
| `-b`, `--batch-size N` | 逻辑最大批处理大小（默认: 2048）<br>环境变量: `LLAMA_ARG_BATCH` |
| `-ub`, `--ubatch-size N` | 物理最大批处理大小（默认: 512）<br>环境变量: `LLAMA_ARG_UBATCH` |
| `--keep N` | 从初始提示中保留的 token 数量（默认: 0，-1 = 全部） |
| `--swa-full` | 使用完整的 SWA 缓存（默认: false）<br>环境变量: `LLAMA_ARG_SWA_FULL` |
| `-fa`, `--flash-attn [on\|off\|auto]` | 设置 Flash Attention 使用（默认: auto）<br>环境变量: `LLAMA_ARG_FLASH_ATTN` |
| `--perf`, `--no-perf` | 是否启用内部 libllama 性能计时（默认: false）<br>环境变量: `LLAMA_ARG_PERF` |
| `-e`, `--escape`, `--no-escape` | 是否处理转义序列（`\n`, `\r`, `\t` 等）（默认: true） |
| `--rope-scaling {none,linear,yarn}` | RoPE 频率缩放方法（默认由模型指定）<br>环境变量: `LLAMA_ARG_ROPE_SCALING_TYPE` |
| `--rope-scale N` | RoPE 上下文缩放因子，将上下文扩展 N 倍<br>环境变量: `LLAMA_ARG_ROPE_SCALE` |
| `--rope-freq-base N` | RoPE 基础频率，用于 NTK 感知缩放（默认: 从模型加载）<br>环境变量: `LLAMA_ARG_ROPE_FREQ_BASE` |
| `--rope-freq-scale N` | RoPE 频率缩放因子，将上下文扩展 1/N 倍<br>环境变量: `LLAMA_ARG_ROPE_FREQ_SCALE` |
| `--yarn-orig-ctx N` | YaRN: 模型的原始上下文大小（默认: 0 = 模型训练上下文大小）<br>环境变量: `LLAMA_ARG_YARN_ORIG_CTX` |
| `--yarn-ext-factor N` | YaRN: 外推混合因子（默认: -1.00，0.0 = 完全插值）<br>环境变量: `LLAMA_ARG_YARN_EXT_FACTOR` |
| `--yarn-attn-factor N` | YaRN: 缩放 sqrt(t) 或注意力强度（默认: -1.00）<br>环境变量: `LLAMA_ARG_YARN_ATTN_FACTOR` |
| `--yarn-beta-slow N` | YaRN: 高校正维度或 alpha（默认: -1.00）<br>环境变量: `LLAMA_ARG_YARN_BETA_SLOW` |
| `--yarn-beta-fast N` | YaRN: 低校正维度或 beta（默认: -1.00）<br>环境变量: `LLAMA_ARG_YARN_BETA_FAST` |
| `-kvo`, `--kv-offload`, `-nkvo`, `--no-kv-offload` | 是否启用 KV 缓存卸载（默认: 启用）<br>环境变量: `LLAMA_ARG_KV_OFFLOAD` |
| `--repack`, `-nr`, `--no-repack` | 是否启用权重重打包（默认: 启用）<br>环境变量: `LLAMA_ARG_REPACK` |
| `--no-host` | 绕过主机缓冲区，允许使用额外缓冲区<br>环境变量: `LLAMA_ARG_NO_HOST` |
| `-ctk`, `--cache-type-k TYPE` | K 的 KV 缓存数据类型。<br>可选: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1（默认: f16）<br>环境变量: `LLAMA_ARG_CACHE_TYPE_K` |
| `-ctv`, `--cache-type-v TYPE` | V 的 KV 缓存数据类型。<br>可选: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1（默认: f16）<br>环境变量: `LLAMA_ARG_CACHE_TYPE_V` |
| `-dt`, `--defrag-thold N` | KV 缓存碎片整理阈值（已弃用）<br>环境变量: `LLAMA_ARG_DEFRAG_THOLD` |
| `--rpc SERVERS` | RPC 服务器列表（逗号分隔，host:port）<br>环境变量: `LLAMA_ARG_RPC` |
| `--mlock` | 强制系统将模型保留在 RAM 中，防止交换或压缩<br>环境变量: `LLAMA_ARG_MLOCK` |
| `--mmap`, `--no-mmap` | 是否对模型使用内存映射（禁用则加载较慢，但可能减少页面换出）（默认: 启用）<br>环境变量: `LLAMA_ARG_MMAP` |
| `-dio`, `--direct-io`, `-ndio`, `--no-direct-io` | 使用 DirectIO（如可用）（默认: 禁用）<br>环境变量: `LLAMA_ARG_DIO` |
| `--numa TYPE` | 针对某些 NUMA 系统的优化尝试。<br>- `distribute`: 均匀分布到所有节点<br>- `isolate`: 仅在启动执行的节点上生成线程<br>- `numactl`: 使用 numactl 提供的 CPU 映射<br>环境变量: `LLAMA_ARG_NUMA` |
| `-dev`, `--device <dev1,dev2,..>` | 用于卸载的设备列表（逗号分隔）（none = 不卸载）<br>使用 `--list-devices` 查看可用设备<br>环境变量: `LLAMA_ARG_DEVICE` |
| `--list-devices` | 打印可用设备列表并退出 |
| `-ot`, `--override-tensor <tensor name pattern>=<buffer type>,...` | 覆盖张量缓冲区类型<br>环境变量: `LLAMA_ARG_OVERRIDE_TENSOR` |
| `-cmoe`, `--cpu-moe` | 将所有 MoE（混合专家）权重保留在 CPU 中<br>环境变量: `LLAMA_ARG_CPU_MOE` |
| `-ncmoe`, `--n-cpu-moe N` | 将前 N 层 MoE 权重保留在 CPU 中<br>环境变量: `LLAMA_ARG_N_CPU_MOE` |
| `-ngl`, `--gpu-layers`, `--n-gpu-layers N` | 存储在 VRAM 中的最大层数，可以是具体数字、`auto` 或 `all`（默认: auto）<br>环境变量: `LLAMA_ARG_N_GPU_LAYERS` |
| `-sm`, `--split-mode {none,layer,row,tensor}` | 跨多个 GPU 分割模型的方式。<br>- `none`: 仅使用一个 GPU<br>- `layer`（默认）: 按层和 KV 分割（流水线）<br>- `row`: 按行分割权重（并行）<br>- `tensor`: 按张量分割权重和 KV（实验性）<br>环境变量: `LLAMA_ARG_SPLIT_MODE` |
| `-ts`, `--tensor-split N0,N1,N2,...` | 每个 GPU 卸载的模型比例，逗号分隔，如 `3,1`<br>环境变量: `LLAMA_ARG_TENSOR_SPLIT` |
| `-mg`, `--main-gpu INDEX` | 用于模型（split-mode=none）或中间结果和 KV（split-mode=row）的 GPU（默认: 0）<br>环境变量: `LLAMA_ARG_MAIN_GPU` |
| `-fit`, `--fit [on\|off]` | 是否调整未设置的参数以适应设备内存（默认: on）<br>环境变量: `LLAMA_ARG_FIT` |
| `-fitt`, `--fit-target MiB0,MiB1,...` | `--fit` 的每个设备目标余量（MiB），逗号分隔，单个值广播到所有设备（默认: 1024）<br>环境变量: `LLAMA_ARG_FIT_TARGET` |
| `-fitc`, `--fit-ctx N` | `--fit` 选项可设置的最小 ctx 大小（默认: 4096）<br>环境变量: `LLAMA_ARG_FIT_CTX` |
| `--check-tensors` | 检查模型张量数据是否有无效值（默认: false） |
| `--override-kv KEY=TYPE:VALUE,...` | 高级选项，按键覆盖模型元数据。类型: int, float, bool, str。<br>示例: `--override-kv tokenizer.ggml.add_bos_token=bool:false` |
| `--op-offload`, `--no-op-offload` | 是否将主机张量操作卸载到设备（默认: true） |
| `--lora FNAME` | LoRA 适配器路径（使用逗号分隔值加载多个适配器） |
| `--lora-scaled FNAME:SCALE,...` | 带自定义缩放的 LoRA 适配器路径（格式: `FNAME:SCALE,...`） |
| `--control-vector FNAME` | 添加控制向量（使用逗号分隔值添加多个） |
| `--control-vector-scaled FNAME:SCALE,...` | 带自定义缩放的添加控制向量（格式: `FNAME:SCALE,...`） |
| `--control-vector-layer-range START END` | 应用控制向量的层范围（起始和结束包含） |
| `-m`, `--model FNAME` | 模型路径<br>环境变量: `LLAMA_ARG_MODEL` |
| `-mu`, `--model-url MODEL_URL` | 模型下载 URL（默认: 未使用）<br>环境变量: `LLAMA_ARG_MODEL_URL` |
| `-dr`, `--docker-repo [<repo>/]<model>[:quant]` | Docker Hub 模型仓库。repo 可选（默认 `ai/`），quant 可选（默认 `:latest`）<br>示例: `gemma3`<br>环境变量: `LLAMA_ARG_DOCKER_REPO` |
| `-hf`, `-hfr`, `--hf-repo <user>/<model>[:quant]` | Hugging Face 模型仓库。quant 可选，默认 `Q4_K_M`。<br>示例: `ggml-org/GLM-4.7-Flash-GGUF:Q4_K_M`<br>环境变量: `LLAMA_ARG_HF_REPO` |
| `-hff`, `--hf-file FILE` | Hugging Face 模型文件。若指定，将覆盖 `--hf-repo` 中的 quant。<br>环境变量: `LLAMA_ARG_HF_FILE` |
| `-hfv`, `-hfrv`, `--hf-repo-v <user>/<model>[:quant]` | 声码器模型的 Hugging Face 仓库<br>环境变量: `LLAMA_ARG_HF_REPO_V` |
| `-hffv`, `--hf-file-v FILE` | 声码器模型的 Hugging Face 文件<br>环境变量: `LLAMA_ARG_HF_FILE_V` |
| `-hft`, `--hf-token TOKEN` | Hugging Face 访问令牌（默认: `HF_TOKEN` 环境变量值）<br>环境变量: `HF_TOKEN` |
| `--log-disable` | 禁用日志 |
| `--log-file FNAME` | 日志输出到文件<br>环境变量: `LLAMA_LOG_FILE` |
| `--log-colors [on\|off\|auto]` | 设置彩色日志（默认: auto）<br>环境变量: `LLAMA_LOG_COLORS` |
| `-v`, `--verbose`, `--log-verbose` | 设置详细级别为无限（记录所有消息，用于调试） |
| `--offline` | 离线模式：强制使用缓存，阻止网络访问<br>环境变量: `LLAMA_OFFLINE` |
| `-lv`, `--verbosity`, `--log-verbosity N` | 设置详细阈值。<br>0: 通用输出, 1: 错误, 2: 警告, 3: 信息, 4: 跟踪, 5: 调试（默认: 3）<br>环境变量: `LLAMA_LOG_VERBOSITY` |
| `--log-prefix`, `--no-log-prefix` | 启用日志消息前缀<br>环境变量: `LLAMA_ARG_LOG_PREFIX` |
| `--log-timestamps`, `--no-log-timestamps` | 启用日志消息时间戳<br>环境变量: `LLAMA_ARG_LOG_TIMESTAMPS` |
| `--spec-draft-type-k`, `-ctkd`, `--cache-type-k-draft TYPE` | 草稿模型 K 的 KV 缓存数据类型（默认: f16）<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_K` |
| `--spec-draft-type-v`, `-ctvd`, `--cache-type-v-draft TYPE` | 草稿模型 V 的 KV 缓存数据类型（默认: f16）<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_CACHE_TYPE_V` |

---

## 采样参数

| 参数 | 说明 |
|---|---|
| `--samplers SAMPLERS` | 用于生成的采样器，以 `;` 分隔。<br>默认: `penalties;dry;top_n_sigma;top_k;typ_p;top_p;min_p;xtc;temperature` |
| `-s`, `--seed SEED` | RNG 种子（默认: -1，-1 使用随机种子） |
| `--sampler-seq`, `--sampling-seq SEQUENCE` | 采样器的简化序列（默认: `edskypmxt`） |
| `--ignore-eos` | 忽略结束符 token 并继续生成（隐含 `--logit-bias EOS-inf`） |
| `--temp`, `--temperature N` | 温度（默认: 0.80） |
| `--top-k N` | top-k 采样（默认: 40，0 = 禁用）<br>环境变量: `LLAMA_ARG_TOP_K` |
| `--top-p N` | top-p 采样（默认: 0.95，1.0 = 禁用） |
| `--min-p N` | min-p 采样（默认: 0.05，0.0 = 禁用） |
| `--top-nsigma`, `--top-n-sigma N` | top-n-sigma 采样（默认: -1.00，-1.0 = 禁用） |
| `--xtc-probability N` | xtc 概率（默认: 0.00，0.0 = 禁用） |
| `--xtc-threshold N` | xtc 阈值（默认: 0.10，1.0 = 禁用） |
| `--typical`, `--typical-p N` | 局部典型采样，参数 p（默认: 1.00，1.0 = 禁用） |
| `--repeat-last-n N` | 考虑惩罚的最后 n 个 token（默认: 64，0 = 禁用，-1 = ctx_size） |
| `--repeat-penalty N` | 惩罚重复 token 序列（默认: 1.00，1.0 = 禁用） |
| `--presence-penalty N` | 重复存在性惩罚（默认: 0.00，0.0 = 禁用） |
| `--frequency-penalty N` | 重复频率惩罚（默认: 0.00，0.0 = 禁用） |
| `--dry-multiplier N` | 设置 DRY 采样乘数（默认: 0.00，0.0 = 禁用） |
| `--dry-base N` | 设置 DRY 采样基值（默认: 1.75） |
| `--dry-allowed-length N` | 设置 DRY 采样允许长度（默认: 2） |
| `--dry-penalty-last-n N` | 设置最后 n 个 token 的 DRY 惩罚（默认: -1，0 = 禁用，-1 = 上下文大小） |
| `--dry-sequence-breaker STRING` | 添加 DRY 采样的序列分隔符，清除默认分隔符（`\n`, `:`, `"`, `*`）。使用 `"none"` 不使用分隔符 |
| `--adaptive-target N` | adaptive-p: 选择接近此概率的 token（范围 0.0~1.0，负数 = 禁用）（默认: -1.00） |
| `--adaptive-decay N` | adaptive-p: 目标随时间适应的衰减率。值越低反应越快，值越高越稳定（范围 0.0~0.99）（默认: 0.90） |
| `--dynatemp-range N` | 动态温度范围（默认: 0.00，0.0 = 禁用） |
| `--dynatemp-exp N` | 动态温度指数（默认: 1.00） |
| `--mirostat N` | 使用 Mirostat 采样（0 = 禁用，1 = Mirostat，2 = Mirostat 2.0） |
| `--mirostat-lr N` | Mirostat 学习率，参数 eta（默认: 0.10） |
| `--mirostat-ent N` | Mirostat 目标熵，参数 tau（默认: 5.00） |
| `-l`, `--logit-bias TOKEN_ID(+/-)BIAS` | 修改 token 在补全中出现的概率。<br>示例: `--logit-bias 15043+1` 增加 token ' Hello' 概率 |
| `--grammar GRAMMAR` | BNF 格式文法约束生成 |
| `--grammar-file FNAME` | 从文件读取文法 |
| `-j`, `--json-schema SCHEMA` | JSON schema 约束生成。<br>示例: `{}` 表示任意 JSON 对象 |
| `-jf`, `--json-schema-file FILE` | 包含 JSON schema 的文件 |
| `-bs`, `--backend-sampling` | 启用后端采样（实验性，默认: 禁用）<br>环境变量: `LLAMA_ARG_BACKEND_SAMPLING` |

---

## 推测解码参数

| 参数 | 说明 |
|---|---|
| `--spec-draft-hf`, `-hfd`, `-hfrd`, `--hf-repo-draft <user>/<model>[:quant]` | 同 `--hf-repo`，但用于草稿模型<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_HF_REPO` |
| `--spec-draft-threads`, `-td`, `--threads-draft N` | 草稿模型生成线程数（默认: 同 `--threads`） |
| `--spec-draft-threads-batch`, `-tbd`, `--threads-batch-draft N` | 草稿模型批处理线程数（默认: 同 `--threads-draft`） |
| `--spec-draft-cpu-mask`, `-Cd`, `--cpu-mask-draft M` | 草稿模型 CPU 亲和性掩码（默认: 同 `--cpu-mask`） |
| `--spec-draft-cpu-range`, `-Crd`, `--cpu-range-draft lo-hi` | 草稿模型 CPU 范围 |
| `--spec-draft-cpu-strict`, `--cpu-strict-draft <0\|1>` | 草稿模型严格 CPU 放置（默认: 同 `--cpu-strict`） |
| `--spec-draft-prio`, `--prio-draft N` | 草稿模型进程/线程优先级（默认: 0） |
| `--spec-draft-poll`, `--poll-draft <0\|1>` | 草稿模型使用轮询等待工作（默认: 同 `--poll`） |
| `--spec-draft-cpu-mask-batch`, `-Cbd`, `--cpu-mask-batch-draft M` | 草稿模型批处理 CPU 亲和性掩码（默认: 同 `--cpu-mask`） |
| `--spec-draft-cpu-strict-batch`, `--cpu-strict-batch-draft <0\|1>` | 草稿模型批处理严格 CPU 放置（默认: `--cpu-strict-draft`） |
| `--spec-draft-prio-batch`, `--prio-batch-draft N` | 草稿模型批处理优先级（默认: 0） |
| `--spec-draft-poll-batch`, `--poll-batch-draft <0\|1>` | 草稿模型批处理轮询等待（默认: `--poll-draft`） |
| `--spec-draft-override-tensor`, `-otd`, `--override-tensor-draft ...` | 覆盖草稿模型张量缓冲区类型 |
| `--spec-draft-cpu-moe`, `-cmoed`, `--cpu-moe-draft` | 草稿模型所有 MoE 权重保留在 CPU<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_CPU_MOE` |
| `--spec-draft-n-cpu-moe`, `-ncmoed`, `--n-cpu-moe-draft N` | 草稿模型前 N 层 MoE 权重保留在 CPU<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_N_CPU_MOE` |
| `--spec-draft-n-max N` | 推测解码的草稿 token 数（默认: 3）<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_N_MAX` |
| `--spec-draft-n-min N` | 推测解码的最小草稿 token 数（默认: 0）<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_N_MIN` |
| `--spec-draft-p-split`, `--draft-p-split P` | 推测解码分割概率（默认: 0.10）<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_P_SPLIT` |
| `--spec-draft-p-min`, `--draft-p-min P` | 最小推测解码概率（贪婪）（默认: 0.00）<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_P_MIN` |
| `--spec-draft-backend-sampling`, `--no-spec-draft-backend-sampling` | 将草稿采样卸载到后端（默认: 启用）<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_BACKEND_SAMPLING` |
| `--spec-draft-device`, `-devd`, `--device-draft <dev1,dev2,..>` | 草稿模型卸载设备列表 |
| `--spec-draft-ngl`, `-ngld`, `--gpu-layers-draft`, `--n-gpu-layers-draft N` | 草稿模型存储在 VRAM 的最大层数（默认: auto）<br>环境变量: `LLAMA_ARG_N_GPU_LAYERS_DRAFT` |
| `--spec-draft-model`, `-md`, `--model-draft FNAME` | 推测解码的草稿模型路径<br>环境变量: `LLAMA_ARG_SPEC_DRAFT_MODEL` |
| `--spec-type ...` | 推测解码类型列表（逗号分隔）。可选: `none`, `draft-simple`, `draft-eagle3`, `draft-mtp`, `ngram-simple`, `ngram-map-k`, `ngram-map-k4v`, `ngram-mod`, `ngram-cache`（默认: none）<br>环境变量: `LLAMA_ARG_SPEC_TYPE` |
| `--spec-ngram-mod-n-min N` | ngram 推测解码最小 token 数（默认: 48） |
| `--spec-ngram-mod-n-max N` | ngram 推测解码最大 token 数（默认: 64） |
| `--spec-ngram-mod-n-match N` | ngram-mod 查找长度（默认: 24） |
| `--spec-ngram-simple-size-n N` | ngram-simple 的 ngram 大小 N（默认: 12） |
| `--spec-ngram-simple-size-m N` | ngram-simple 的 ngram 大小 M（默认: 48） |
| `--spec-ngram-simple-min-hits N` | ngram-simple 最小命中数（默认: 1） |
| `--spec-ngram-map-k-size-n N` | ngram-map-k 的 ngram 大小 N（默认: 12） |
| `--spec-ngram-map-k-size-m N` | ngram-map-k 的 ngram 大小 M（默认: 48） |
| `--spec-ngram-map-k-min-hits N` | ngram-map-k 最小命中数（默认: 1） |
| `--spec-ngram-map-k4v-size-n N` | ngram-map-k4v 的 ngram 大小 N（默认: 12） |
| `--spec-ngram-map-k4v-size-m N` | ngram-map-k4v 的 ngram 大小 M（默认: 48） |
| `--spec-ngram-map-k4v-min-hits N` | ngram-map-k4v 最小命中数（默认: 1） |

> 以下参数已移除，请使用替代参数:
> - `--draft`, `--draft-n`, `--draft-max` → 使用 `--spec-draft-n-max` 或 `--spec-ngram-mod-n-max`
> - `--draft-min`, `--draft-n-min` → 使用 `--spec-draft-n-min` 或 `--spec-ngram-mod-n-min`
> - `--spec-ngram-size-n` → 使用对应的 `--spec-ngram-*-size-n` 或 `--spec-ngram-mod-n-match`
> - `--spec-ngram-size-m` → 使用对应的 `--spec-ngram-*-size-m`
> - `--spec-ngram-min-hits` → 使用对应的 `--spec-ngram-*-min-hits`

---

## 服务器特定参数

| 参数 | 说明 |
|---|---|
| `-lcs`, `--lookup-cache-static FNAME` | 静态查找缓存路径（不被生成更新） |
| `-lcd`, `--lookup-cache-dynamic FNAME` | 动态查找缓存路径（被生成更新） |
| `-ctxcp`, `--ctx-checkpoints`, `--swa-checkpoints N` | 每槽最大上下文检查点数量（默认: 32）<br>环境变量: `LLAMA_ARG_CTX_CHECKPOINTS` |
| `-cpent`, `--checkpoint-every-n-tokens N` | 预填充期间每 n 个 token 创建检查点（-1 禁用）（默认: 8192）<br>环境变量: `LLAMA_ARG_CHECKPOINT_EVERY_NT` |
| `-cram`, `--cache-ram N` | 设置最大缓存大小（MiB）（默认: 8192，-1 = 无限制，0 = 禁用）<br>环境变量: `LLAMA_ARG_CACHE_RAM` |
| `-kvu`, `--kv-unified`, `-no-kvu`, `--no-kv-unified` | 使用跨所有序列共享的单一统一 KV 缓冲区（默认: 槽数自动时启用）<br>环境变量: `LLAMA_ARG_KV_UNIFIED` |
| `--cache-idle-slots`, `--no-cache-idle-slots` | 在新任务时保存和清除空闲槽（默认: 启用，需要 unified KV 和 cache-ram）<br>环境变量: `LLAMA_ARG_CACHE_IDLE_SLOTS` |
| `--context-shift`, `--no-context-shift` | 是否在无限文本生成中使用上下文偏移（默认: 禁用）<br>环境变量: `LLAMA_ARG_CONTEXT_SHIFT` |
| `-r`, `--reverse-prompt PROMPT` | 在 PROMPT 处停止生成，在交互模式下返回控制 |
| `-sp`, `--special` | 启用特殊 token 输出（默认: false） |
| `--warmup`, `--no-warmup` | 是否执行空运行预热（默认: 启用） |
| `--spm-infill` | 使用 Suffix/Prefix/Middle 模式进行 infill（默认: 禁用） |
| `--pooling {none,mean,cls,last,rank}` | 嵌入的池化类型（默认由模型指定）<br>环境变量: `LLAMA_ARG_POOLING` |
| `-np`, `--parallel N` | 服务器槽数（默认: -1，-1 = 自动）<br>环境变量: `LLAMA_ARG_N_PARALLEL` |
| `-cb`, `--cont-batching`, `-nocb`, `--no-cont-batching` | 是否启用连续批处理（默认: 启用）<br>环境变量: `LLAMA_ARG_CONT_BATCHING` |
| `-mm`, `--mmproj FILE` | 多模态投影器文件路径。若使用 `-hf` 可省略<br>环境变量: `LLAMA_ARG_MMPROJ` |
| `-mmu`, `--mmproj-url URL` | 多模态投影器 URL<br>环境变量: `LLAMA_ARG_MMPROJ_URL` |
| `--mmproj-auto`, `--no-mmproj`, `--no-mmproj-auto` | 是否使用多模态投影器文件（如可用，用于 `-hf`）（默认: 启用）<br>环境变量: `LLAMA_ARG_MMPROJ_AUTO` |
| `--mmproj-offload`, `--no-mmproj-offload` | 是否启用多模态投影器的 GPU 卸载（默认: 启用）<br>环境变量: `LLAMA_ARG_MMPROJ_OFFLOAD` |
| `--image-min-tokens N` | 每张图像的最小 token 数（仅用于视觉模型）（默认: 从模型读取）<br>环境变量: `LLAMA_ARG_IMAGE_MIN_TOKENS` |
| `--image-max-tokens N` | 每张图像的最大 token 数（仅用于视觉模型）（默认: 从模型读取）<br>环境变量: `LLAMA_ARG_IMAGE_MAX_TOKENS` |
| `-a`, `--alias STRING` | 设置模型名称别名（逗号分隔，供 API 使用）<br>环境变量: `LLAMA_ARG_ALIAS` |
| `--tags STRING` | 设置模型标签（逗号分隔，仅用于信息，不用于路由）<br>环境变量: `LLAMA_ARG_TAGS` |
| `--embd-normalize N` | 嵌入归一化方式（默认: 2）。-1=无, 0=最大绝对 int16, 1=taxicab, 2=欧几里得, >2=p-范数 |
| `--host HOST` | 监听 IP 地址，或绑定 UNIX socket（地址以 `.sock` 结尾）（默认: 127.0.0.1）<br>环境变量: `LLAMA_ARG_HOST` |
| `--port PORT` | 监听端口（默认: 8080）<br>环境变量: `LLAMA_ARG_PORT` |
| `--reuse-port` | 允许多个 socket 绑定到同一端口（默认: 禁用）<br>环境变量: `LLAMA_ARG_REUSE_PORT` |
| `--path PATH` | 提供静态文件的路径<br>环境变量: `LLAMA_ARG_STATIC_PATH` |
| `--api-prefix PREFIX` | API 前缀路径（末尾不带斜杠）<br>环境变量: `LLAMA_ARG_API_PREFIX` |
| `--ui-config JSON` | 提供默认 UI 设置的 JSON（覆盖 UI 默认值）<br>环境变量: `LLAMA_ARG_UI_CONFIG` |
| `--ui-config-file PATH` | 包含默认 UI 设置的 JSON 文件<br>环境变量: `LLAMA_ARG_UI_CONFIG_FILE` |
| `--ui-mcp-proxy`, `--no-ui-mcp-proxy` | 实验性: 是否启用 MCP CORS 代理（不要在不可信环境中启用）（默认: 禁用）<br>环境变量: `LLAMA_ARG_UI_MCP_PROXY` |
| `--tools TOOL1,TOOL2,...` | 实验性: 是否为 AI 代理启用内置工具（不要在不可信环境中启用）。指定 `"all"` 启用所有工具。<br>可用工具: read_file, file_glob_search, grep_search, exec_shell_command, write_file, edit_file, apply_diff, get_datetime<br>环境变量: `LLAMA_ARG_TOOLS` |
| `--ui`, `--no-ui` | 是否启用 Web UI（默认: 启用）<br>环境变量: `LLAMA_ARG_UI` |
| `--embedding`, `--embeddings` | 限制仅支持嵌入使用场景（仅用于专用嵌入模型）（默认: 禁用）<br>环境变量: `LLAMA_ARG_EMBEDDINGS` |
| `--rerank`, `--reranking` | 在服务器上启用重排序端点（默认: 禁用）<br>环境变量: `LLAMA_ARG_RERANKING` |
| `--api-key KEY` | API 认证密钥（可提供多个，逗号分隔）（默认: 无）<br>环境变量: `LLAMA_API_KEY` |
| `--api-key-file FNAME` | 包含 API 密钥的文件路径 |
| `--ssl-key-file FNAME` | PEM 格式 SSL 私钥文件<br>环境变量: `LLAMA_ARG_SSL_KEY_FILE` |
| `--ssl-cert-file FNAME` | PEM 格式 SSL 证书文件<br>环境变量: `LLAMA_ARG_SSL_CERT_FILE` |
| `--chat-template-kwargs STRING` | 为 JSON 模板解析器设置额外参数，必须是有效的 JSON 对象字符串<br>环境变量: `LLAMA_CHAT_TEMPLATE_KWARGS` |
| `-to`, `--timeout N` | 服务器读写超时（秒）（默认: 600）<br>环境变量: `LLAMA_ARG_TIMEOUT` |
| `--threads-http N` | 处理 HTTP 请求的线程数（默认: -1）<br>环境变量: `LLAMA_ARG_THREADS_HTTP` |
| `--cache-prompt`, `--no-cache-prompt` | 是否启用提示缓存（默认: 启用）<br>环境变量: `LLAMA_ARG_CACHE_PROMPT` |
| `--cache-reuse N` | 尝试通过 KV 偏移重用缓存的最小块大小（需要启用提示缓存）（默认: 0）<br>环境变量: `LLAMA_ARG_CACHE_REUSE` |
| `--metrics` | 启用 Prometheus 兼容的指标端点（默认: 禁用）<br>环境变量: `LLAMA_ARG_ENDPOINT_METRICS` |
| `--props` | 允许通过 POST /props 更改全局属性（默认: 禁用）<br>环境变量: `LLAMA_ARG_ENDPOINT_PROPS` |
| `--slots`, `--no-slots` | 暴露槽监控端点（默认: 启用）<br>环境变量: `LLAMA_ARG_ENDPOINT_SLOTS` |
| `--slot-save-path PATH` | 保存槽 KV 缓存的路径（默认: 禁用） |
| `--media-path PATH` | 加载本地媒体文件的目录；可通过 `file://` URL 使用相对路径访问（默认: 禁用） |
| `--models-dir PATH` | 包含路由器服务器模型的目录（默认: 禁用）<br>环境变量: `LLAMA_ARG_MODELS_DIR` |
| `--models-preset PATH` | 路由器服务器模型预设的 INI 文件路径（默认: 禁用）<br>环境变量: `LLAMA_ARG_MODELS_PRESET` |
| `--models-max N` | 路由器服务器同时加载的最大模型数（默认: 4，0 = 无限制）<br>环境变量: `LLAMA_ARG_MODELS_MAX` |
| `--models-autoload`, `--no-models-autoload` | 路由器服务器是否自动加载模型（默认: 启用）<br>环境变量: `LLAMA_ARG_MODELS_AUTOLOAD` |
| `--jinja`, `--no-jinja` | 是否使用 jinja 模板引擎进行聊天（默认: 启用）<br>环境变量: `LLAMA_ARG_JINJA` |
| `--reasoning-format FORMAT` | 控制思考标签的处理和返回格式。<br>- `none`: 不解析思考内容，保留在 `message.content`<br>- `deepseek`: 将思考内容放入 `message.reasoning_content`<br>- `deepseek-legacy`: 保留 `<think>` 标签在 `content` 中，同时填充 `reasoning_content`<br>（默认: auto）<br>环境变量: `LLAMA_ARG_THINK` |
| `-rea`, `--reasoning [on\|off\|auto]` | 在聊天中使用推理/思考（默认: auto，从模板检测）<br>环境变量: `LLAMA_ARG_REASONING` |
| `--reasoning-budget N` | 思考的 token 预算：-1 无限制，0 立即结束，N>0 为预算（默认: -1）<br>环境变量: `LLAMA_ARG_THINK_BUDGET` |
| `--reasoning-budget-message MESSAGE` | 推理预算耗尽时在结束思考标签前注入的消息（默认: 无）<br>环境变量: `LLAMA_ARG_THINK_BUDGET_MESSAGE` |
| `--chat-template JINJA_TEMPLATE` | 设置自定义 jinja 聊天模板（默认: 从模型元数据获取）<br>环境变量: `LLAMA_ARG_CHAT_TEMPLATE` |
| `--chat-template-file JINJA_TEMPLATE_FILE` | 设置自定义 jinja 聊天模板文件（默认: 从模型元数据获取）<br>环境变量: `LLAMA_ARG_CHAT_TEMPLATE_FILE` |
| `--skip-chat-parsing`, `--no-skip-chat-parsing` | 强制使用纯内容解析器，即使指定了 Jinja 模板（默认: 禁用）<br>环境变量: `LLAMA_ARG_SKIP_CHAT_PARSING` |
| `--prefill-assistant`, `--no-prefill-assistant` | 是否在最后一条消息是助手消息时预填充助手响应（默认: 启用预填充）<br>环境变量: `LLAMA_ARG_PREFILL_ASSISTANT` |
| `-sps`, `--slot-prompt-similarity SIMILARITY` | 请求提示与槽提示匹配以重用该槽的相似度（默认: 0.10，0.0 = 禁用） |
| `--lora-init-without-apply` | 加载 LoRA 适配器但不应用（稍后通过 POST /lora-adapters 应用）（默认: 禁用） |
| `--sleep-idle-seconds SECONDS` | 服务器空闲后休眠的秒数（默认: -1，-1 = 禁用） |
| `-mv`, `--model-vocoder FNAME` | 音频生成的声码器模型（默认: 未使用） |
| `--tts-use-guide-tokens` | 使用引导 token 改善 TTS 单词召回 |
| `--embd-gemma-default` | 使用默认 EmbeddingGemma 模型（可从互联网下载权重） |
| `--fim-qwen-1.5b-default` | 使用默认 Qwen 2.5 Coder 1.5B（可从互联网下载权重） |
| `--fim-qwen-3b-default` | 使用默认 Qwen 2.5 Coder 3B（可从互联网下载权重） |
| `--fim-qwen-7b-default` | 使用默认 Qwen 2.5 Coder 7B（可从互联网下载权重） |
| `--fim-qwen-7b-spec` | 使用 Qwen 2.5 Coder 7B + 0.5B 草稿进行推测解码（可从互联网下载权重） |
| `--fim-qwen-14b-spec` | 使用 Qwen 2.5 Coder 14B + 0.5B 草稿进行推测解码（可从互联网下载权重） |
| `--fim-qwen-30b-default` | 使用默认 Qwen 3 Coder 30B A3B Instruct（可从互联网下载权重） |
| `--gpt-oss-20b-default` | 使用 gpt-oss-20b（可从互联网下载权重） |
| `--gpt-oss-120b-default` | 使用 gpt-oss-120b（可从互联网下载权重） |
| `--vision-gemma-4b-default` | 使用 Gemma 3 4B QAT（可从互联网下载权重） |
| `--vision-gemma-12b-default` | 使用 Gemma 3 12B QAT（可从互联网下载权重） |
| `--spec-default` | 启用默认推测解码配置 |

---

## 内置聊天模板列表

以下为 `--chat-template` 和 `--chat-template-file` 支持的内置模板：

bailing, bailing-think, bailing2, chatglm3, chatglm4, chatml, command-r, deepseek, deepseek-ocr, deepseek2, deepseek3, exaone-moe, exaone3, exaone4, falcon3, gemma, gigachat, glmedge, gpt-oss, granite, granite-4.0, grok-2, hunyuan-dense, hunyuan-moe, hunyuan-vl, kimi-k2, llama2, llama2-sys, llama2-sys-bos, llama2-sys-strip, llama3, llama4, megrez, minicpm, mistral-v1, mistral-v3, mistral-v3-tekken, mistral-v7, mistral-v7-tekken, monarch, openchat, orion, pangu-embedded, phi3, phi4, rwkv-world, seed_oss, smolvlm, solar-open, vicuna, vicuna-orca, yandex, zephyr

> 注意：如果指定了后缀/前缀，模板将被禁用。除非在 `--jinja` 之后设置，否则仅接受常用模板。
