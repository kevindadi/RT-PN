# 桌面工具设计方案参考（二进制性能分析工作台重构）

日期：2026-11-19 · 状态：调研 + 建议

## 1. 优秀工具的共同点

| 工具 | 核心模型 | 值得借鉴 | 应避免 |
|---|---|---|---|
| IDA Pro | 数据库 + 文档视图 | 打开文件即建库；左侧 Functions 导航；图中/线性视图切换；结果以覆盖层呈现 | 设置项藏得深；学习曲线陡 |
| Ghidra | Project Manager + CodeBrowser | 工程与工具分离；导入时一次性选择分析选项；可重新 Auto Analyze | 双窗口切换成本；导入向导偏重 |
| Binary Ninja | 分析数据库 + 线性/图形视图 | 侧栏符号导航；xrefs；分析结果热力叠加；设置集中 | 高级选项分散 |
| JetBrains IDE | Project + Editor + Run Configurations + Tool Windows | Run Configuration 是一等对象；结果在 Tool Window；Settings 集中 | 面板过多时认知负担 |
| Compiler Explorer | 源码 + 配置 + 输出 | 配置与结果同屏；显式重跑；状态可复现 | 配置项平铺过多 |
| Chrome DevTools Performance / Firefox Profiler | Recording/Session + 结果视图 | 结果为中心：Summary / Call tree / Bottom-up / 对比；可打开历史记录 | 不能导航源码/CFG |
| OTAWA | Architecture/Platform + 分析流水线 | 架构/平台配置显式；分析链可列；结果可复现 | 纯工具链，无统一交互外壳 |
| VS Code | Workspace + Settings + Tasks/Launch | 命令面板；配置文件是首选项；GUI 只暴露常用项 | 概念多，新手迷路 |

**共同公式**：

> 被分析对象（Database/Project） + 运行配置（Run Configuration） + 不可变结果（Run/Session） + 视图（Documents/Tool Windows）

配置是独立对象，运行是显式动作，结果是只读产物，视图只做投影。

## 2. 三种候选架构

### A. 分析数据库型（IDA / Ghidra / Binary Ninja）

```
打开 ELF → 建库（函数索引/CFG）→ 左侧 Functions/Sections 导航
中间 Documents：反汇编 / CFG / ELF layout
右侧 Inspector：函数/Block/指令属性
分析配置：Settings 对话框或 Analysis Options（不在主界面反复出现）
结果：叠加在 CFG 上（cycles 热力、WCET 路径、cache miss）
```

- 优点：适合“反汇编后性能分析”的对象导航；文档切换快；界面稳定。
- 缺点：WCET/cache 报告需要额外的 Results 文档；配置入口需设计好。
- 实现成本：中（现有函数索引、CFG、inspector 可直接复用）。

### B. Run Configuration + 报告型（JetBrains / Compiler Explorer）

```
工具栏：[cortex-m4-pipeline ▾] [Analyze ▶]
左侧：Image 摘要 / Analyses(run 历史)
中间：Results 文档（Summary / WCET / Cache / Branch / Memory）+ 函数 CFG
配置：Edit Configuration 对话框（CPU、board profile、频率、分析开关）
```

- 优点：迭代实验体验最好；每次运行是命名快照；对比/复现自然。
- 缺点：代码浏览弱于 A；若函数导航不常驻，分析结果无法下钻到代码。
- 实现成本：低—中（已有 Run 历史、A/B 对比、SQLite 工程）。

### C. Profile Session 型（DevTools Performance / Firefox Profiler）

```
启动页：Recent Projects / Sessions
选择 run → 结果仪表盘（Summary / 调用树下钻 / 对比 / 导出）
需要新分析时：New Analysis 向导
```

- 优点：结果展示和对比最强；适合汇报；启动快。
- 缺点：不适合长期浏览反汇编；每次看代码都要切上下文。
- 实现成本：中（需要重做首页与结果视图）。

## 3. 推荐：A 的外壳 + B 的配置模型 + C 的结果视图

### 3.1 布局

```
┌ Menu: File  Analysis  View  Help                     [Run config ▾] [Analyze ▶] [Compare] ┐
├───────────────┬──────────────────────────────────────┬─────────────────────────────────┤
│ NAVIGATOR     │ DOCUMENTS                            │ INSPECTOR                       │
│ ▾ Image       │ [Overview] [start_tasks CFG] [ELF]   │ Function / Block / Instruction  │
│   Sections    │ [Results: run-0007] [Config]         │ timing class, cycles, cache,    │
│   Roots       │                                      │ branch, source, problems        │
│   Functions   │   graph / linear / text / mermaid    │                                 │
│   Concurrency │   (结果覆盖层开关: cycles/cache/WCET) │                                 │
│ ▾ Analyses    │                                      │                                 │
│   run-0007    │                                      │                                 │
│   run-0006    │                                      │                                 │
├───────────────┴──────────────────────────────────────┴─────────────────────────────────┤
│ STATUS / PROBLEMS: elf2tdg cmd, duration, coverage warnings, clickable diagnostics      │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

- 无 stage tabs、无侧栏重复配置；
- 打开 ELF 后默认 `Overview` 文档 + Functions 导航；
- 配置只在两个地方：`Analysis > Edit Configuration…`（对话框）或 `Config` 文档；
- `Analyze` 用当前配置生成不可变 run；结果以 `Results: run-id` 文档打开；
- CFG 文档上的覆盖层按 activeRun 显示，不另开“分析页”。

### 3.2 配置模型（对齐 JetBrains/Ghidra）

`Analysis Configuration` 对话框分四页：

1. **Timing model**：CPU/架构（自动检测建议）、频率、指令 class 表（只读内置 + override 编辑）。
2. **Board profile**：选择内置 TOML / 打开文件 / 原始编辑 / 另存；显示 SHA 与固定 CPU。
3. **Analyses**：icache / dcache / branch / data-memory / WCET 开关与参数、loop bounds。
4. **Review**：命令行、profile SHA、影响预览、保存为命名配置。

规则：
- 配置变更立即显示 `dirty`，但不自动重跑；
- `Analyze` 生成 run 快照；旧 run 永不被覆盖；
- 结果页顶部显示 run 的 config 摘要，点击回到配置。

### 3.3 结果视图（对齐 DevTools/Profiler）

- Summary：模型、coverage、caveats、一次运行的 high-level 指标；
- WCET：roots 表 → 点击路径在 CFG 高亮；
- Cache/Branch/Memory：函数级排序表 → 点击 drill-down 到 CFG/Inspector；
- Compare：选两个 run，差异表 + 可导出；
- Problems：模型未选、未知指令、地址无法解析、profile/CPU 冲突等集中显示。

### 3.4 交互细节

- 快捷键：`F5` Analyze、`Ctrl+,` Configuration、`Ctrl+P` command palette、`Space` graph/linear 切换、`F12` xref；
- 首次使用：启动页 Projects + 3 步提示，不弹多层向导；
- 空状态：每个文档只给一个下一步动作（Configure / Open sample / Analyze）；
- 错误：写入 Problems，提供“打开日志/复制命令”，不要只 toast。

## 4. 落地建议

### Phase 0（纸面/点击原型，1–2 天）

- 画出 3 个文档状态：Overview、CFG、Results；一个 Configuration 对话框；
- 确认导航与配置入口，不改后端。

### Phase 1（外壳，2–3 天）

- 新 shell：Navigator/Documents/Inspector/Status；移除 stage tabs 与侧栏重复配置；
- `activeDocument` + `selectedFunction/selectedRun` 单一状态；
- 保留现有 `analyze_elf` 数据。

### Phase 2（Run Configuration，2–4 天）

- 配置对象/对话框；命名配置保存到工程；
- run 快照与历史（已有 SQLite 基础）；
- 配置 dirty 状态。

### Phase 3（结果文档，3–5 天）

- Summary/WCET/Cache/Branch/Memory/Compare；
- CFG 覆盖层；
- 报告导出带 config/run provenance。

### Phase 4（打磨，1–2 天）

- 命令面板、快捷键、Problems 跳转、最近工程、引导。

## 5. 决策点

1. 接受“Navigator + Documents”作为主界面（推荐）吗？
2. 配置采用模态对话框（Ghidra/JetBrains 风格）还是独立 Config 文档（IDA 风格）？
3. 结果以“run 文档”呈现并在 CFG 上覆盖（推荐），还是保留独立 ANALYSIS 页？
4. 是否需要可停靠面板（docking）？建议先固定布局，后续再评估 `flexlayout-react` 等库。

## 6. 与当前版本的差距

- 已有：函数索引、交互 CFG、指令 inspector、结果卡、A/B、SQLite 工程/run 历史；
- 缺少：单一配置入口、run 快照文档、函数级下钻、Problems 面板、统一导航；
- 因此重构主要是**前端 IA 与状态模型**，后端分析能力不需要推倒重来。
