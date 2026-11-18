# 二进制性能分析工作台重构方案

日期：2026-11-18 · 目标版本：0.2.x · 状态：提案（未实现）

## 0. 先回答两个具体问题

### 0.1 为什么会出现 “No instruction timing model is available for this architecture in M0.”？

这条 caveat 来自 elf2tdg 的 `TimingInfo`，不是“Cortex-M0 没有时序表”。这里的 **M0 是项目里程碑编号**，原文的完整含义是：
“当前分析在 M0 里程碑范围内，还没有该架构的指令时序模型”。

触发条件（`elf2tdg/crates/elf2tdg/src/analysis.rs`）：

- 编译器/分析器没有选中任何 `TimingModel`（`self.timing == None`）；
- 只保留了频率信息，于是走 `frequency_only_timing_info()`，固定返回这条 caveat；
- 自动选型 `TimingModel::auto()` 只在 **thumb + ELF 能给出可识别的 CPU 名称** 时成功；
  - aarch64/x86-64 有意不做自动选型（不同核差异太大，必须显式 `--cpu`）；
  - bundled 示例 ELF 的 `arm_cpu` 不一定存在，因此普通 Import 不带 `--cpu` 时就会落到“无模型”状态；
- 该 caveat 会被后端 `timing_caveats()` 收进 `ElfWorkflow.caveats`，ANALYSIS 页直接展示。

**当前 UI 的误导点**：分析还没运行（没有选 CPU/profile）时，这条“模型未选择”的信息被当成“分析结果的 caveat”展示，用户不知道下一步。新方案里它应该变成
“Timing model: not selected → 选择 CPU/配置” 的状态提示，而不是报告末尾的 caveat。

### 0.2 现在在哪里能配置指令时间？

目前只有两层，UI 都没有结构化编辑：

1. **CPU 内置时序表**（sidebar → ANALYSIS PROFILE → CPU）：`cortex-m0` / `cortex-m0plus` / `cortex-m3` / `cortex-m4` / `cortex-m7` / `cortex-m33` / `riscv32` / `riscv64` / `aarch64` / `x86-64`。
   选 CPU 才会启用内置的指令分类周期（ALU/load/store/branch/...）。
2. **Board profile TOML**（ANALYSIS 页底部 → BOARD PROFILE EDITOR，默认只读载入，`SAVE AS` 后可改）：
   - `[[instruction_costs]]`：按 `class` 或 `mnemonic` 覆盖周期，例如
     ```toml
     [[instruction_costs]]
     class = "divide"
     cycles = { min = 2, max = 12 }

     [[instruction_costs]]
     mnemonic = "ldr"
     cycles = { min = 2, max = 3 }
     ```
   - 内置 class：`load`, `store`, `push-pop`, `ldm-stm`, `branch`, `call`, `return`,
     `multiply`, `divide`, `barrier`, `nop`, `alu`, `other`；
   - `[pipeline]`：Cortex-M4 in-order 资源/依赖模型（issue width、branch penalty、
     `[[pipeline.instructions]]` 的 resources/latency/occupancy）；
   - `[[memory]]`：区域 fetch wait states、data read/write wait states、宽度；
   - `[instruction_cache]`、`[data_cache]`、`[branch_prediction]`、`[wcet]`；
   - profile 会**固定 cpu 型号**，必须与 sidebar 选择的 `--cpu` 及 ELF 架构一致；
   - 未识别 mnemonic 走 `other` 回退，并产生 `timing-unknown-instruction` 诊断。

限制：没有 OTAWA 那样的“指令分类表 / 寄存器 vs 内存操作 / 地址模式”结构化编辑器；
没有 coverage 报告（哪些指令用了内置表、哪些 fallback）；也没有 profile 模板库。

---

## 1. 现状诊断

当前二进制工作区把“阶段”当成了“工作流”：

```
OVERVIEW → ELF → FUNCTIONS → CFG → ANALYSIS
```

同时存在多套并行控制：

- 顶部 stage tabs；
- 左侧新增的 ANALYSIS stage 按钮（与 tabs 重复）；
- 顶部 RUN / IMPORT；
- 侧栏 RUN WITH PROFILE；
- OVERVIEW 的 APPLY PRESET & RUN；
- ANALYSIS 的 PROFILE A/B 里又一次运行分析；
- 每个 stage 又有自己的 PREVIEW / RELOAD / EXPORT。

结果是：

1. **没有唯一“当前对象”**：用户不知道自己在看“某个 ELF 数据库”还是“某次分析结果”；
2. **没有唯一“运行配置”**：CPU/board/freq 分散在侧栏，修改后不会自动形成一次可复现的 run；
3. **视图与运行耦合**：切换视图可能触发重新读取，按钮禁用条件难以理解（例如
   `RUN WITH PROFILE` 依赖 `currentPath`，此前的 bug 就源于此）；
4. **caveat/模型状态混在结果里**：未配置时序模型时也显示 ANALYSIS CAVEATS；
5. **函数级工作流不连贯**：FUNCTIONS → CFG → ANALYSIS 之间没有“选中函数”的持久上下文，
   分析结果不能直接叠加到 CFG 上。

---

## 2. 参考产品的工作流

### IDA Pro

- 打开文件后先构建 **数据库**（auto-analysis 是后台动作，可取消）；
- 左侧 **Functions / Names / Sections** 是可导航的数据库视图；
- 中间是 **document**：反汇编、图形视图（Space 切换）、文本视图；
- 右侧/底部是 xrefs、inspector、输出窗口；
- **分析是数据库的属性**，不是逐步向导；视图只是数据库的投影。

### OTAWA

- 先描述 **architecture / platform**（核心、内存、缓存、流水线）；
- 再选择 **analysis pipeline**（cache、branch、WCET 等）；
- 每次分析有明确的配置、输入、输出和报告；
- 强调 **模型可配置 + 结果可复现**（脚本/配置文件驱动）。

### JetBrains 性能工具

- **Run Configuration** 是独立对象：程序、参数、采样/插桩方式一次配置；
- 运行产生 **session/snapshot**，结果是独立的工具窗口（summary → 详情 → 时间线）；
- 多次 run 可以 **对比**，配置和结果都可导出；
- 工具栏只有少数动作：Run / Attach / Stop / Compare。

### 共同模式

> **Database（被分析对象） + Run Configuration（怎么分析） + Immutable Result（结果） + Views（怎么看）**

工作流不是“依次点击 5 个 stage”，而是：

```
Open ELF → (自动) 建立数据库 → 配置一次分析 → Run → 在数据库/结果中导航
```

---

## 3. 目标信息架构

### 3.1 布局

```
┌──────────────────────────────────────────────────────────────────────┐
│ Menu: File  Analysis  View  Help          [Run config ▾] [Analyze ▶] │
├───────────────┬────────────────────────────────────┬─────────────────┤
│ NAVIGATOR     │ DOCUMENTS                          │ INSPECTOR       │
│               │                                    │                 │
│ ▾ Image       │ [start_tasks CFG] [ELF layout]     │ Function        │
│   Entry       │ [Analysis: wcet-m4-pipeline]       │  address/size   │
│   Sections    │                                    │  timing/coverage│
│   Roots       │  ┌ graph / text / mermaid / asm ┐  │ Block           │
│   Functions   │  │                             │  │  cycles, cache  │
│   Concurrency │  │   selected function CFG     │  │ Instruction     │
│               │  │                             │  │  class/cost/src │
│ ▾ Analyses    │  └─────────────────────────────┘  │ Issues          │
│   run-0007    │                                    │  (caveats)      │
│   run-0006    │                                    │                 │
├───────────────┴────────────────────────────────────┴─────────────────┤
│ STATUS/LOG: elf2tdg cmd, 1.2 s, 8 functions, 3 warnings   [Issues 3] │
└──────────────────────────────────────────────────────────────────────┘
```

- 顶部菜单只保留 **File / Analysis / View / Help**；
- 工具栏只保留 **Run configuration 选择器 + Analyze 按钮**（外加取消/进度）；
- 左侧 Navigator 分两类：**Image**（不可变数据库）与 **Analyses**（run 列表）；
- 中间 Documents 是标签页，不再有“stage tab”与侧栏 stage 按钮两套导航；
- 右侧 Inspector 永远显示当前选中对象（函数/block/指令/root）的属性与问题；
- 底部 Status/Log 显示最近一次 elf2tdg 调用、耗时、错误和可点击 diagnostics。

### 3.2 核心对象模型

```ts
interface ImageDatabase {
  id: string;
  elfPath: string;
  sha256: string;
  arch: string;
  entry: string;
  sections: Section[];
  functions: FunctionIndexEntry[];
  roots: Root[];
  concurrencySites: ConcurrencySite[];
  // CFG 按需加载，但索引常驻
}

interface AnalysisConfig {
  id: string;
  name: string;              // "cortex-m4-pipeline"
  cpu: TimingModelId;        // cortex-m4 / ...
  frequencyHz?: number;
  boardProfile?: { path: string; sha256: string; sourceText?: string };
  instructionCosts: InstructionCostRow[];   // UI 编辑的结构化行
  pipeline?: PipelineConfig;
  caches?: CacheConfig;
  branchPrediction?: BranchConfig;
  dataMemory?: DataMemoryConfig;
  wcet?: WcetConfig;
  enabledAnalyses: AnalysisKind[];
}

interface AnalysisRun {
  id: string;                // run-0007
  imageId: string;
  config: AnalysisConfig;
  startedAt: string;
  durationMs: number;
  status: "ok" | "partial" | "failed" | "cancelled";
  artifacts: { cfgJson?: string; mmd?: string; report?: string };
  summary: RunSummary;       // coverage、caveats、模型信心
  wcet?: WcetResult;
  cache?: CacheResult;
  branch?: BranchResult;
  dataMemory?: DataMemoryResult;
  diagnostics: Diagnostic[];
}
```

**关键约束**

1. `ImageDatabase` 只由 Open ELF 产生一次；切函数/切视图不重新解析 ELF；
2. `AnalysisConfig` 是唯一配置入口；sidebar 不再直接改全局 options；
3. 每次 Analyze 生成不可变 `AnalysisRun`；现有视图通过 `activeRunId` 读取；
4. 所有 caveat/diagnostic 属于 **run** 或 **image**，不再是散落的字符串；
5. CFG 视图的叠加层（热力/周期/缓存 miss/分支误预测/WCET 路径）由
   `activeRun` + 选中函数派生。

---

## 4. 新工作流（从打开 ELF 开始）

### 4.1 Open

1. `File → Open ELF` 或拖拽/示例；
2. 构建数据库：loader、sections、symbols、functions 索引、roots、concurrency；
3. 左右显示 **Image Navigator**，中间默认打开 `Overview` 文档；
4. 此时没有 run，Overview 显示：
   - 架构检测结果；
   - “Timing model: auto-detected / not selected”；
   - 一个主 CTA：**Configure analysis…**。

### 4.2 Configure analysis（配置一次，而不是散落按钮）

打开 `Run Configuration` 文档/面板（类似 JetBrains Run Configuration）：

- **CPU / timing model**：自动检测建议值；列出现有模型；未选择时明确提示；
- **Frequency / clocks**；
- **Instruction timing**：
  - 内置分类表（只读参考，来自 elf2tdg timing table）；
  - 可编辑覆盖行（class / mnemonic / cycles min-max）；
  - 地址模式/操作数类型（若后端支持，见 §6）；
- **Board profile**：选择示例 TOML / 导入 / 在编辑器中编辑；显示 SHA；
- **Pipeline / caches / branch / data memory / WCET**：可选分析开关及参数；
- **Validation 面板**：profile 的 cpu/arch 与当前选择是否冲突；
- 底部 `Analyze`；`Save configuration` 命名保存。

### 4.3 Run

- Analyze 执行一次 elf2tdg（按需一次或多次子调用），显示进度与可取消；
- 完成后生成 `run-0007`，加入左侧 Analyses；
- 失败时错误进入 Status/Log 与 Problems，而不是 toast 一闪。

### 4.4 Navigate & Results

- 左侧 Functions 始终可用；双击函数 → 打开 CFG 文档（默认 GRAPH）；
- CFG 文档的视图切换：**Graph / Text / Mermaid / Disassembly**（同一 document，不再有 PREVIEW 模态框）；
- 若存在 activeRun，CFG 上可切换叠加层：
  - block cycles/时间；
  - cache miss / branch mispredict / data-memory wait；
  - WCET 最长路径高亮；
- 右侧 Inspector 显示选中 block/instruction 的：
  - 指令分类、命中/回退（builtin class vs fallback）、周期范围、来源；
  - cache/branch/memory 的本地结果；
  - source file:line；
- 左侧 Analyses 选中某个 run → 打开 **Results** 文档：
  - Summary：模型/覆盖/unknown/confidence/caveats；
  - WCET：roots 表 + 路径 viewer + 展开到 CFG；
  - Cache / Branch / Data memory：函数级明细表（可排序、可过滤）；
  - Coverage：每个指令类使用次数、fallback mnemonic 列表；
  - Report：导出 MD/JSON，带 config SHA 和复现命令。

### 4.5 Compare & Report

- `Analysis → Compare runs`：选两个 run（同一 image），差异视图：
  - WCET root 级 Δ、cache/branch 计数 Δ、配置 diff；
  - 导出对比报告；
- `File → Export report`：image + run + config + artifacts + reproduce command。

---

## 5. 去除冗余的具体清单

| 现状 | 处理 |
|---|---|
| 顶部 stage tabs（OVERVIEW/ELF/FUNCTIONS/CFG/ANALYSIS） | 删除；替换为 Documents 标签页（CFG/ELF/Results/Overview） |
| 左侧新增 stage 按钮 | 删除；左侧改为 Image Navigator + Analyses |
| 顶部 IMPORT 与侧栏 IMPORT ELF | 保留一个（顶部菜单/工具栏） |
| RUN WITH PROFILE / APPLY PRESET & RUN / ANALYSIS A/B RUN | 统一为 Run Configuration + Analyze；A/B 改为 Compare runs |
| CFG 的 RELOAD SLICE | 删除；Slice 按需缓存，配置变更后自动失效 |
| CFG 视图 GRAPH/TEXT/MMD 放在工具栏 | 保留为 document 视图切换（位置合理），去掉整程序 PREVIEW 按钮 |
| ELF stage 的 PREVIEW 模态框 | 改为 ELF Layout document 的 “Rendered image” 标签页（懒加载 + 大小限制） |
| ANALYSIS 页的 PROFILE EDITOR | 移入 Run Configuration → Instruction timing / Board profile |
| 多个 caveat 区块 | 统一进 Problems 面板 + Summary 的模型状态 |

---

## 6. 指令时序编辑器（回应“找不到在哪设置/像 OTAWA 那样分类”）

### 6.1 两层配置

1. **Timing model 层**（CPU 内置表）：选择 core 后展示只读的 class 周期表；
2. **Override 层**（用户/board 特定）：
   - `class` 覆盖：ALU/load/store/branch/...；
   - `mnemonic` 覆盖：单个指令；
   - `pipeline.instructions`（Cortex-M4）：resources/latency/occupancy；
   - 内存区域 wait states、cache、branch、WCET loop bounds。

### 6.2 UI 设计

```
Instruction timing
Model: cortex-m4 (built-in, statistical)     [duplicate as custom profile]

class            cycles      used by        fallback?
alu              1            1240 insns     -
load             2–3          311 insns      -
store            1–2          180 insns      -
branch           1–3          95 insns       -
divide           2–12         6 insns        -
other            1            3 insns        3 unknown mnemonics ⚠

[+ add override]  (class ▾ / mnemonic / min / max / note)
Coverage: 99.4% instructions mapped, 3 unknown mnemonics
```

- 行内编辑，改完实时校验（min≤max、非负）；
- “unknown mnemonics” 可展开查看并一键补 override；
- 切换 CPU 时提示“保留/重置覆盖”；
- 保存为 board profile TOML（导出文本），保持与 elf2tdg 完全兼容；
- 若需要 OTAWA 式“寄存器 vs 内存操作/地址模式”分类，需要 elf2tdg 扩展：
  - 在 CFG JSON 的 instruction 上增加 `timing_class`、`addressing_mode`、`operands_kind`；
  - timing table 支持按 `(class, addressing_mode)` 选择成本；
  - UI 增加对应列。这是后端工作量，建议放到 Phase C 之后。

### 6.3 现阶段可立即做的“轻量版”

- 在 ANALYSIS 页把 “No instruction timing model …” 替换为用户可理解的：
  “未选择时序模型，无法计算指令周期。选择 CPU 或应用示例配置。”
  + 按钮 `Configure timing model`；
- 在 Analysis Profile 的 CPU 选择器下显示一行状态：
  `Model: cortex-m4 · built-in table · confidence statistical`；
- Board profile 编辑器增加 TOML 语法提示 + 常用片段（instruction_costs/pipeline/wcet）按钮；
- 提供 3 个内置示例 profile 模板（M4 pipeline / M7 cache+WCET / M0 basic）。

---

## 7. 前端/后端改造要点

### 7.1 Tauri 命令拆分

| 命令 | 作用 |
|---|---|
| `open_image(path) -> ImageIndex` | 只解析 ELF 元数据/functions 索引/roots，不含逐函数指令 |
| `load_function(imageId, selector) -> FunctionCfg` | 按需加载函数 CFG（可复用，带缓存） |
| `run_analysis(imageId, config) -> AnalysisRun` | 一次分析运行，返回完整结果 + 复现信息 |
| `cancel_analysis(runId)` | 取消（`spawn_blocking` + 取消标记） |
| `export_report(runId, format)` | MD/JSON |
| `list_profiles()` / `read_profile()` / `save_profile(path, text)` | profile 管理 |

当前 `analyze_elf` 一次返回整包 `ElfWorkflow`，导致打开即跑全部内容、状态耦合；
拆分后 Open 与 Run 解耦，加载性能也可控。

### 7.2 前端状态

```ts
interface WorkbenchState {
  workflow: "none" | "binary" | "spec";
  image: ImageIndex | null;
  runs: AnalysisRun[];
  activeRunId: string | null;
  activeDocument: DocumentTab | null;   // overview | elf | function | results
  selectedFunction: string | null;
  selectedBlock: string | null;
  problems: Diagnostic[];
  runConfigDraft: AnalysisConfig;
}
```

- 所有写入集中在 reducer/store；
- 视图只读派生，不再各自 `useEffect` 触发分析；
- `open_image` 与 `run_analysis` 是仅有的两个异步入口。

### 7.3 文件结构建议

```
src/
  workbench/
    BinaryWorkbench.tsx
    Navigator.tsx
    DocumentTabs.tsx
    Inspector.tsx
    StatusBar.tsx
  documents/
    OverviewDocument.tsx
    ElfDocument.tsx
    FunctionCfgDocument.tsx
    AnalysisResultsDocument.tsx
    RunConfigDocument.tsx
  analysis/
    InstructionTimingEditor.tsx
    CoveragePanel.tsx
    WcetTable.tsx
    CacheTables.tsx
  state/workbenchStore.ts
```

---

## 8. 分阶段实施计划

### Phase A — 信息架构清理（1–2 天，可先做）

- 新 shell：Menu + Navigator + Documents + Inspector + Status/Log；
- 删除 stage tabs 与侧栏 stage 按钮，建立 `activeDocument`；
- 统一唯一 Analyze/Run 入口；删除 RUN WITH PROFILE / APPLY PRESET & RUN；
- 保持 backend 不变（仍用现有 analyze 命令），先把 UI 骨架与选中对象打通；
- 修掉 “模型未选择” caveat 文案与 CTA。

**验收**：打开 ELF 后只有一个主 CTA；切换函数/文档不触发重复分析；所有按钮语义单一。

### Phase B — Run Configuration + 指令时序编辑器（2–4 天）

- `AnalysisConfig` 对象 + Run Configuration 文档；
- CPU/frequency/board profile 集中；
- 结构化 instruction timing 编辑器（轻量版）：内置 class 表只读 + override 行编辑 + coverage；
- 保存/加载 profile TOML；
- 后端命令拆分为 `open_image` / `load_function` / `run_analysis`（可先复用现有 payload）。

**验收**：用户能在 UI 内完成“选核 → 看内置指令表 → 改 class/mnemonic 周期 → 保存 profile → 运行”，
且不用手动找文件。

### Phase C — 结果工作区 + 对比 + 报告（2–3 天）

- Results 文档：Summary / WCET / Cache / Branch / Memory / Coverage；
- CFG 叠加层（cycles/cache/branch/WCET 路径）；
- Compare runs（配置 diff + WCET/计数 delta）；
- Report 导出带 config SHA 与复现命令。

**验收**：分析结果不再只是卡片，可从函数/指令级钻取；两次 run 可对比。

### Phase D — 打磨（1–2 天）

- 首次使用引导（3 步以内）、示例配置、最近打开；
- Problems 面板点击跳转；
- 键盘快捷键（F5 Run、Space 视图切换、F12 定义跳转等）；
- 错误日志导出/诊断信息。

**风险**：elf2tdg 没有地址模式分类和 per-class coverage 输出，完整 OTAWA 式编辑器需要引擎新增字段；
Phase B 先做“内置表 + override + coverage（由现有 diagnostics/未知 mnemonic 推导）”，
地址模式放到引擎升级后。

---

## 9. 与当前版本的兼容策略

- 保留 `.rtpn`/profile TOML 格式；
- 现有 `analyze_elf` 命令暂不删除，新 UI 通过适配层调用；Phase B 后再切换到拆分命令；
- 版本号 0.2.0 标记这次重构；旧工作流在 0.1.x 保持可用，避免一次性 break。

## 10. 建议先确认的三个决策

1. **文档式布局**（IDA 风格）是否接受，即“没有 stage 进度条，只有 Navigator + Documents”；
2. Run Configuration 是否采用“保存命名配置 + 多次 run 可对比”的 JetBrains 思路；
3. 指令时序编辑器先做“轻量版”（内置表 + override + coverage），地址模式等引擎扩展放到后续。
