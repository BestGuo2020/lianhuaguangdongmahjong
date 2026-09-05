# 血流硬件 GPU 渲染测量

日期：2026-09-05；规则：lotus-blood-flow-v1。

按用户要求，两个 Playwright 配置均采用 channel: chromium 与 --enable-gpu。使用完整 Chromium 的新 headless 模式；保留 P2P 原有后台计时策略。验收断言 renderer 不为空且不含 SwiftShader、llvmpipe、software 或 Basic Render，禁止悄悄回退软件渲染。

实测浏览器：Chromium 151.0.7922.34；显卡：Intel Arc 130T GPU (16GB)；ANGLE / Direct3D11，驱动 32.0.101.6554。20 个样本全部使用 Intel 硬件渲染。

采样：每个主题四种尺寸，屏幕宽度小于 900 使用低画质，其余高画质；四家各 80 条公开展示记录，再追加一次演出。每场收集 44 个 requestAnimationFrame 间隔。单位 ms，记录主线程帧间隔，包含调度及掉帧，不等同于 GPU draw-call 时间。

| 主题 | 尺寸 | 中位数 | P95 | 最大间隔 |
|---|---|---:|---:|---:|
| jade | 568×320 | 16.70 | 16.80 | 16.80 |
| jade | 844×390 | 16.70 | 16.80 | 16.80 |
| jade | 1280×720 | 16.70 | 16.80 | 16.80 |
| jade | 1920×1080 | 16.70 | 16.70 | 16.80 |
| rosewood | 568×320 | 16.70 | 16.80 | 16.80 |
| rosewood | 844×390 | 16.70 | 16.80 | 16.80 |
| rosewood | 1280×720 | 16.70 | 16.80 | 16.80 |
| rosewood | 1920×1080 | 16.70 | 16.80 | 17.00 |
| happyMahjong | 568×320 | 16.70 | 16.80 | 16.80 |
| happyMahjong | 844×390 | 16.70 | 16.80 | 16.80 |
| happyMahjong | 1280×720 | 16.70 | 16.70 | 16.80 |
| happyMahjong | 1920×1080 | 16.70 | 16.80 | 16.80 |
| llm | 568×320 | 16.70 | 16.80 | 17.00 |
| llm | 844×390 | 16.70 | 16.80 | 16.80 |
| llm | 1280×720 | 16.70 | 16.80 | 17.50 |
| llm | 1920×1080 | 16.70 | 16.80 | 16.80 |
| llmAnime | 568×320 | 16.70 | 16.70 | 16.80 |
| llmAnime | 844×390 | 16.70 | 16.70 | 16.80 |
| llmAnime | 1280×720 | 16.70 | 16.70 | 16.80 |
| llmAnime | 1920×1080 | 16.70 | 16.80 | 16.80 |

样本较短，不代表长期帧率或所有玩家设备。应用/操作边界、预览卡和演出交叠、历史恢复不补播均另外断言，不用帧率数值代替正确性。

## 先前软件渲染记录（单列，不作为硬件性能结论）

此前 headless-shell 使用 ANGLE Vulkan SwiftShader。软件渲染检查也通过，但存在数百毫秒帧间隔，不能据此判断真实 GPU 性能；该因素已经从本次硬件测量中排除。原 JSON 汇总保留在忽略的 work/blood-flow-software-rendering.json，不混入上表。

配置依据：[Playwright 新 headless 模式](https://playwright.dev/docs/browsers#chromium-new-headless-mode)、[Chromium headless GPU 文档](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/using-gpu-hardware-in-headless-chrome.md)。

复测：启动前端开发服务后，设置 E2E_REUSE_ONLY=1 和 E2E_PORT，在 master 运行 node node_modules/@playwright/test/cli.js test tests/e2e/blood-flow.validation.spec.ts --workers=1。每次记录实际 renderer，软件渲染环境会明确失败，需在可访问硬件 GPU 的会话重跑。
