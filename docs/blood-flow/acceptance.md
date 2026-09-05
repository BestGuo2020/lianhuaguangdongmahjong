# 血流验收记录与复测入口

整理日期：2026-09-05。本页索引已存在的证据和待取得的证据；本轮仅整理文档，没有重跑下面的游戏实验、浏览器用例或实听。任务进度只维护在[当前任务](tasks.md)。

## 证据按版本看

| 记录 / 提交 | 已有证据 | 不能据此声称 |
|---|---|---|
| [首版验收快照](records/validation-v1.md) | E02～E09 的评分、守恒、单机、mock P2P、模型回退、主题及分支检查；各次命令和数量保留原记录 | 最新 HEAD 整体验收通过、真实 WebRTC / Relay 或真实模型体验通过 |
| [千局模拟](records/simulation.md)，`757dabc` | 实际 TypeScript 引擎、种子 1～1000、3772 条胡记录；其中独立首次成牌 807 次 | 3772 次独立成牌、AI 对抗强度或长期平衡已经证明 |
| [策略分布](records/strategies.md)，`b0ae8f3` | 三种策略各 100 局自我对局，种子 1～100 | 与千局报告组成 1300 个独立种子，或可推导 LLM 胜率 |
| [渲染测量](records/rendering.md) | 指定 Intel / Chromium 环境下五主题四尺寸的记录 | 其他设备长期帧率、打击感和声音已经达标 |
| E10 `455c411` | 当时记录 9 项导航 / 布局检查及类型、构建通过 | E15 的局末感言呈现已经完成 |
| E11 `5ccbd56` | 同一 cue 时钟、逐席冷却、合并金额和立绘接线检查 | 自动调用正确即代表用户认可观感 |
| E12 `64d0bd3` | 当时记录 7 项 GPU 飞行、来源和跨层检查 | 单张截图能说明完整飞行和落稳过程 |
| E13 `15a5b83` | 三种番型三响、四家收付、杠收支及合并零净值检查 | 卡片上的收入文字可以代替四席动态收付反馈 |
| 动画 / 间隙 `1898559` | 14 / 11 / 8 / 5 / 2 张位置及重建时保留动画的回归；详见原检查记录 | 普通出牌 / 吃碰杠的完整前后节奏已全部对齐 |
| G01 `7ca6dbb` | 7 项浏览器用例覆盖吃碰杠胡过、多吃法和触屏；当时全量单测 1103 通过 / 2 跳过，后增响应边界的 engine 21 条通过；类型和构建通过 | 已恢复听牌提示、普通气泡或其他 G 项 |
| E14 `845e943` | 原阶段记录 22 项 GPU / 实际播声检查通过，效果音与分档实现已提交 | 人耳实听已通过，或用户截图已认可动态冲击感 |

上表为已有记录的归并，没有把不同提交的检查次数加在一起。完整历史命令保留在记录文件和 Git；未来新结果应附新提交。

## 必须补的体验验收

| 范围 | 通过条件 | 记录方式 |
|---|---|---|
| 普通动作与手牌（G01～G04） | 对照非血流的摸打、吃碰杠顺序；同牌多操作同时可选；重复快照不打断选牌和动画；三类听牌提示完整 | 桌面 / 触屏录屏加相关交互断言，注明规则和座位 |
| 字、牌、光、角色的同一批次（E11 / E12 / E14） | 过冲后回弹可读，来源和落点明确，历史牌不重新飞入；获胜立绘匹配席位 | 同事件慢放与正常速度录像；标注录制提交、主题、视口、事件 ID |
| 四家收付（E13） | 一次自摸三付、点炮多响、抢杠及杠分各自对应真实金额；零净值合并仍说明来源 | 同批次从动作前到数字退出的录像和账本向量核对 |
| 画面可读性（E14 / E16） | 主番不与桌心方位 / 倒数相撞；本次结果与下一次预览分清；小屏不遮操作 | 五主题，1280×720 / 844×390 / 568×320；截图用于布局，录像用于时序 |
| 声音（E14-7 / G05 / G07） | 原动作人声与非人声重拍分别实际可听；各自次数正确，静音有效、TTS 不可用能回退；选牌和倒数反馈恢复 | 带音轨样片与实听记录；请求、play 事件及非零音量断言是辅助证据 |
| 发言与结算（E15） | 两个 LLM 主题有正常摸打 / 吃碰杠短句；局内胡牌无自由评价；局末在结算卡可见，回桌重开不再播 | 主题 × 局内 / 局末 × TTS 可用 / 不可用矩阵，包含单机和 P2P |
| P2P 与原玩法（E06 / E16） | 同步后原两模式正常，主题锁定与结算路径保留；真实链路独立验收 | 分别记录 master、vibehub、mock 与真实 SDK 的提交 / 环境 / 结果 |

用户最近两张截图的判断已记入[任务页的截图反馈](tasks.md#截图反馈如何落到-e14--e16)。它们不构成动态或实听通过记录。

## 复测入口

命令在相应分支的仓库根目录运行。这里只列入口，执行者应先确认服务、工作区及本次变更范围。文档整理本身只检查迁移、链接和路径，不需重新运行千局模拟。

| 范围 | 命令 / 用例 |
|---|---|
| 全量前端 | `pnpm test`；`pnpm build`（包含类型检查） |
| 规则与响应 | `node node_modules/vitest/vitest.mjs run src/game/variants/lotus/bloodFlow/engine.test.ts src/game/variants/lotus/bloodFlow/ai.test.ts` |
| 按钮与间隙 | `tests/e2e/blood-flow.claim-actions.spec.ts`、`blood-flow.common-hand-gap.spec.ts` |
| 结算与布局 | `tests/e2e/blood-flow.settlement-navigation.spec.ts`、`blood-flow.presentation.spec.ts` |
| 飞牌与收付 | `tests/e2e/blood-flow.flights.spec.ts`、`blood-flow.payments.spec.ts` |
| 光效与声音 | `tests/e2e/blood-flow.effects.spec.ts`、`blood-flow.audio.spec.ts` |
| 单机与模型 | `tests/e2e/blood-flow.local.spec.ts`、`blood-flow.llm.spec.ts` |
| 千局报告 | `node node_modules/vitest/vitest.mjs run --dir scripts blood-flow.sim.test.ts`，更新 `records/simulation.md` |
| 策略报告 | `node node_modules/vitest/vitest.mjs run --dir scripts blood-flow.strategies.test.ts`，更新 `records/strategies.md` |
| 分支同步 | master 提交后 `pnpm sync:vibehub`；源和目标工作区须干净，随后在 P2P 分支复测 |

只复测前端浏览器时，先启动前端开发服务，再复用该服务，避免自动拉起本轮范围以外的后端。例如服务已在 4173：

```powershell
$env:E2E_REUSE_ONLY='1'
$env:E2E_PORT='4173'
node node_modules/@playwright/test/cli.js test tests/e2e/blood-flow.claim-actions.spec.ts --workers=1
```

## 新结果的记录格式

每批追加：日期 / 任务编号 / master 提交 / vibehub 提交与同步结果 / 命令与退出结果 / 样本与环境 / 证据位置 / 视觉或实听人及结论 / 未验证范围。

`work/`、`test-results/`、`docs/evidence/` 是被忽略的本地产物区，路径存在不表示文件随 Git 交付。受控文档保留摘要、生成方法和实际提交；外部原视频只读引用，不因整理文档上传或移动。

## 本次文档整理校验

2026-09-05：13 份原文档 / 补丁已迁移，4 个常用旧入口保留跳转；新目录含 16 份 Markdown 与原补丁。118 个本地链接及锚点检查通过，E00～E16 任务条目、16 个番型定义、历史实验表格和原补丁均保留。两个报告生成脚本仅调整 Markdown 输出路径；没有改变模拟逻辑或实验数字。文档差异空白检查通过，未重跑游戏测试。
