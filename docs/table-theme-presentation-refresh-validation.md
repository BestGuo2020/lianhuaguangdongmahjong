# 牌桌主题表现系统 Phase 7 验收记录

> 验收日期：2026-09-04
>
> 对应规范：[`table-theme-presentation-refresh-plan.md`](./table-theme-presentation-refresh-plan.md)

## 结论

Phase 0～7 完成。五个保留主题在共享业务组件和响应式骨架上形成连续视觉语言；废弃主题兼容、动作/结算状态、资源失败、WebGL 失败、主题切换、静音、reduced-motion 与完整视口范围均通过自动化验证。

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
- 响应式：`tests/e2e/responsive-layout.visual.spec.ts`
- 硬件 GPU：`playwright test -c playwright.gpu.config.ts --project=chromium-gpu`

## 非阻塞警告

- Three.js 当前版本提示 `PCFSoftShadowMap` 已映射为 `PCFShadowMap`。
- Intel D3D11 着色器编译器会报告浮点精度 `X4122` warning；渲染、截图及所有断言正常。
- Vite 仍提示 Three.js 异步 chunk 超过 500 kB；牌桌组件已异步拆分，不影响本轮功能验收。
