# 牌桌主题表现系统 Phase 0～11 验收记录

> 验收日期：2026-09-04～2026-09-05
>
> 对应规范：[`table-theme-presentation-refresh-plan.md`](./table-theme-presentation-refresh-plan.md)

## 结论

Phase 0～11 已在 `master` 完成并通过验证。Phase 0～7 的五主题架构、动作/结算矩阵、资源回退与响应式基线保持通过；Phase 8～11 已补齐大厅双区域布局、真实牌桌主视觉、移动房间聚焦、Teleport 弹层主题上下文、共享控件语义层级、`llmAnime` 角色选择器与稳定结算恢复。`vibehub` 同步因安全审查要求明确确认，暂未执行。

竖屏继续执行既有产品门禁：不展示可交互大厅，只显示“请横屏游玩”和全屏横屏入口。移动大厅验收均在真实横屏条件下执行。

## Phase 8～11 实施结果

- 大厅统一为左侧主题视觉区、右侧对局操作区；模式、场次、玩法与当前主操作形成连续任务流，账号和外部入口降为底部轻操作。
- `jade`、`happyMahjong`、`rosewood` 使用硬件 GPU 渲染的真实 Three.js 牌桌画面，不再把抽象 SVG 线框作为正式大厅主视觉。
- 主题预览具备 `loading`、`ready`、`error` 三态；自动化只在 `complete && naturalWidth > 0` 后截图，失败时显示文字回退且不阻塞开局。
- 联机入房后移动横屏进入房间聚焦模式：完整主题视觉区隐藏，四座位、准备/开始和危险操作保持可见；`llmAnime` 仅保留紧凑本家入口。
- 房间码、场次和玩法摘要居中；“已复制”使用预留槽位，反馈出现前后房间码中心不位移。
- `LobbyDialog` 与 `LlmSettingsPanel` 显式接收当前主题及 CSS 变量；已打开时热切换同步更新，关闭后不向 `body` 留下主题 class、样式或滚动锁。
- 大模型配置页仅换肤；字段、顺序、默认值、API Key 密码遮蔽、保存/测试/清除、导入导出和三座位分配合同保持不变。
- `llmAnime` 主视觉分别显示“当前本家形象”和低权重“牌桌主题 · 大模型二次元”；角色名只出现一次，欢迎文字不重复名称，也不显示内部桌布身份说明。
- 角色选择器采用固定大预览与独立卡片滚动区，保留完整角色名、角色说明、选中勾选、即时保存与图片失败回退。
- 从“查看牌桌”返回单局结算时标记为 `restored`，排名与卡片直接恢复稳定最终状态，不重播进入序列。

## 硬件 GPU 证据

GPU 专用 Playwright 配置使用 Chromium 新版 headless、D3D11 ANGLE，并禁用软件光栅回退。运行时通过 `WEBGL_debug_renderer_info` 实测：

- Vendor：`Google Inc. (Intel)`
- Renderer：`ANGLE (Intel, Intel(R) Arc(TM) 130T GPU (16GB), Direct3D11 vs_5_0 ps_5_0, D3D11)`
- Version：`WebGL 2.0 (OpenGL ES 3.0 Chromium)`
- 软件后端排除：不是 SwiftShader、LLVMpipe 或 software rasterizer

配置见 [`playwright.gpu.config.ts`](../playwright.gpu.config.ts)，证据截图位于 `test-results/theme-presentation/phase7/gpu/`。

## 覆盖矩阵

- 五主题：`jade`、`happyMahjong`、`rosewood`、`llm`、`llmAnime`。
- 动作：吃、碰、杠、自摸、点炮胡、抢杠胡、正负分数变化。
- 结算：流局、自摸、点炮、抢杠胡、天地胡、最终排名。
- 视口：568×320～3840×2160，另含 10 个手机、6 个平板、6 个桌面、12 个随机/临界拖拽尺寸和 DPR=2。
- 降级：可选主题纹理失败、关键牌面资源失败与重试、WebGL 初始化失败与重试、静音、reduced-motion。
- 生命周期：五主题热切换后单 Canvas、性能探针换代、CSS 变量无残留；普通主题共享一套 34 张牌面解码缓存，`llmAnime` 独立缓存。
- 性能：结算静态牌桌停止连续 RAF；单帧 draw calls 小于验收上限 320。

## 自动化入口

- 单元测试：`pnpm test`
- 类型检查：`pnpm typecheck`
- 生产构建：`pnpm build`
- 主题表现：`tests/e2e/theme-presentation.smoke.spec.ts`
- Phase 7：`tests/e2e/theme-presentation.release.spec.ts`
- Phase 8～11：`tests/e2e/theme-presentation.followup.spec.ts`
- 响应式：`tests/e2e/responsive-layout.visual.spec.ts`
- 硬件 GPU：`playwright test -c playwright.gpu.config.ts --project=chromium-gpu`

## Phase 8～11 自动化结果

- `pnpm test`：83 个测试文件通过、1 个跳过；769 项通过、2 项跳过。
- `pnpm build`：类型检查和生产构建通过。
- `theme-presentation.followup.spec.ts`（硬件 GPU）：13/13 通过。
- `theme-presentation.smoke.spec.ts`（硬件 GPU）：5/5 通过；覆盖五主题动作与结算矩阵。
- `llm-theme.smoke.spec.ts`（硬件 GPU）：4/4 通过。
- `remote-lotus-legacy.smoke.spec.ts`（硬件 GPU，真实双客户端）：1/1 通过。
- GPU renderer 复核：Intel Arc 130T、ANGLE D3D11、WebGL 2.0，非 SwiftShader/LLVMpipe。
- `git diff --check`：通过。

## Phase 8～11 人工视觉复核

| 表面 | 视口 / 主题 | 截图证据 | 结论 |
|---|---|---|---|
| 桌面大厅 | 1366×768 / 五主题 | `test-results/theme-presentation/phase11/lobby/*-1366x768.png` | 双区域结构稳定；实体主题为真实牌桌，`llm`/`llmAnime` 保持图片主视觉。 |
| 移动横屏大厅 | 667×375 / 欢乐麻将 | `test-results/theme-presentation/phase11/lobby/happyMahjong-667x375.png` | 视觉区压缩、操作区完整；页面根无滚动。 |
| 竖屏门禁 | 390×844 / `llmAnime` | `test-results/theme-presentation/phase11/lobby/llmAnime-390x844-orientation-gate.png` | 只显示横屏门禁与全屏入口，无可交互大厅。 |
| 移动房间聚焦 | 844×390～568×320 / `llmAnime` | `test-results/theme-presentation/phase11/lobby/llmAnime-room-*.png` | 四座位和准备/开始操作可见；极端横屏不产生页面级滚动。 |
| 玩法弹层 | 1366×768 / 五主题 | `test-results/theme-presentation/phase11/lobby/*-rule-dialog-1366x768.png` | 弹窗、选项、单选标记和操作按当前主题呈现。 |
| 大模型配置 | 1366×768 / 五主题 | `test-results/theme-presentation/phase11/lobby/*-llm-settings-1366x768.png` | 主题一致且内容合同未删减。 |
| 角色选择器 | 667×375 / `llmAnime` | `test-results/theme-presentation/phase11/lobby/llmAnime-picker-667x375.png` | 固定预览与卡片滚动职责清楚，完整名称可辨识。 |

二次人工复核曾否决首版 `llmAnime` 玩法弹窗：未选项对比度近似禁用、选中项深色块过重且文字层级割裂。修正版改为暖纸底、珊瑚选中边与高对比墨色正文，并重新生成上表截图；自动化“通过”不再替代这项人工判断。

## 非阻塞警告

- Three.js 当前版本提示 `PCFSoftShadowMap` 已映射为 `PCFShadowMap`。
- Intel D3D11 着色器编译器会报告浮点精度 `X4122` warning；渲染、截图及所有断言正常。
- Vite 仍提示 Three.js 异步 chunk 超过 500 kB；牌桌组件已异步拆分，不影响本轮功能验收。


## Phase 12（2026-09-05）

### 实施与验证

- 实现提交：`1956a49`。统一深色场景 token、珊瑚主按钮、墨色描边与错位阴影；奶油变量设在弹窗本体，包含输入、选项、取消/确认及焦点、禁用状态。
- 大模型配置抽屉恢复深色；两个角色/配置组件的 script 和 template 与本轮开始前逐字归一化比较相同，变更仅位于 style。
- 单测：83 文件通过、1 文件跳过；769 项通过、2 项跳过。包含大模型配置内容合同、默认值、持久化与导入导出相关既有测试。
- 类型检查、生产构建与 `git diff --check` 通过；仍有既有的 Three.js 大 chunk 警告。
- 硬件 Chromium 配置下：`theme-presentation.two-surface.spec.ts` 4/4、`theme-presentation.followup.spec.ts` 13/13、`llm-theme.smoke.spec.ts` 4/4、`theme-presentation.smoke.spec.ts` 5/5，共 26 项通过。
- 专项覆盖：桌面与真实触控横屏的五类弹窗；普通/选中/焦点/禁用样式；取消保留原配置；角色即时选择；两种 Teleport 表面热切换与无残留；配置字段顺序、选项、值、密码遮蔽及保存重开。
- 专项曾发现禁用主按钮保留错位阴影：原因是 disabled 规则优先级低于主按钮规则，已修复并通过 4 项重跑。测试自身的焦点模式与 innerText/textContent 比较问题亦已修正。
- 本环境 `pnpm exec playwright` 启动器不能解析可执行文件，因此用本地等价入口执行：`node node_modules/@playwright/test/cli.js`、`node node_modules/vitest/vitest.mjs run src`、`node node_modules/vue-tsc/bin/vue-tsc.js --noEmit`、`node node_modules/vite/bin/vite.js build`。

### 截图复核

| 表面 | 主题 / 视口 | 证据 | 结论 |
|---|---|---|---|
| 大厅 | llmAnime / 1366×768、667×375 | `test-results/theme-presentation/phase12/lobby-*.png` | 深色常驻区域，珊瑚开始按钮，角色与操作信息清楚。 |
| 五类弹窗 | llmAnime / 1366×768、667×375 | `test-results/theme-presentation/phase12/{match,rule,character,create,join}-*.png` | 外壳、选项、表单均为奶油纸张层；选中与确认使用珊瑚色，正文为墨色。矮窗仍沿用弹窗内部滚动。 |
| 配置抽屉 | llmAnime / 1366×768 | `test-results/theme-presentation/phase12/settings-1366.png` | 深色字段、珊瑚选中供应商与保存按钮；字段顺序和密码遮蔽不变。 |
| 手机房间 | llmAnime / 667×375（另覆盖 844、800、568 宽） | `test-results/theme-presentation/phase11/lobby/llmAnime-room-*.png` | 四席与准备/开始可见，深色房间和珊瑚主操作保持一致。 |
| HUD 与开局 | llmAnime / 1366×768 | `test-results/theme-presentation/llmAnime-table-action-1366x768.png` | 常驻顶栏、玩家框属于深色场景；桌布和角色演出未更改。 |

以上证据为本轮重新运行生成；未将旧截图当作 Phase 12 的新验收结果。

### 分支范围

复核起点 vibehub 为 `1d0ddd1`，只同步至 Phase 0～7。其保留的 App、大厅及房间文件不会被自动脚本覆盖，且缺少新的弹层主题参数。本次遵守保留规则，只同步共享文件；不能据此宣称 vibehub 双区域大厅或双表面已验收。后续适配缺口记录在主计划 §13.3。

同步结果：`pnpm sync:vibehub` 成功，代码同步提交 `4b72fdd`。同步后 vibehub 为 103 个测试文件通过、1 个跳过，945 项通过、2 项跳过；类型检查通过。已核对本轮共享源码两边一致，保留入口与同步前完全相同，最后恢复 master。
