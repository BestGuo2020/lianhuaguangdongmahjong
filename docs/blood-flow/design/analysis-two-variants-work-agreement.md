# 并行开发约定：分析记录扩展到「莲花广麻」与「莲花麻将·翻精癞子」

> 配套方案：`analysis-recording-other-variants-plan.md`（任务分解、验收标准、坑）。
> 本文只回答一件事：**两个玩法同时做时，怎么分工、哪些文件不许动、冲突怎么办**。
> 分叉点：master 上的「公共地基」提交（见 §4，本文件与它同批提交）。

## 1. 角色与所有权

| 会话 | 玩法 | 分支 | 工作树 | 只许改这些路径 |
|---|---|---|---|---|
| **A** | 莲花广麻 `lotus-classic` | `feat/analysis-lotus-classic` | `work/analysis-classic` | `src/game/replay/analysis/lotusClassicAdapter.ts(+test)`、`src/game/core/local/useGame.ts`、`tests/e2e/fixtures/analysis-lotus-classic.{html,ts}`、`tests/e2e/analysis-lotus-classic.spec.ts`、`docs/blood-flow/design/analysis-lotus-classic.md` |
| **B** | 莲花麻将·翻精癞子 `lotus-legacy` | `feat/analysis-lotus-legacy` | `work/analysis-legacy` | `src/game/replay/analysis/lotusLegacyAdapter.ts(+test)`、`src/game/variants/lotus/lotusGame.ts`、`tests/e2e/fixtures/analysis-lotus-legacy.{html,ts}`、`tests/e2e/analysis-lotus-legacy.spec.ts`、`docs/blood-flow/design/analysis-lotus-legacy.md` |

**A 的额外成本（重要）**：`src/game/core/local/useGame.ts` 是 vibehub 的 **keep 文件**（vibehub 保留自己的版本，
同步时不会被 master 覆盖）。所以 A 在这份文件里的改动**必须手动镜像到 vibehub 的同一份文件**（见 §6）。
B 的 `lotusGame.ts` 是共享文件，不需要镜像。

## 2. 分叉点

两条分支都从 **"公共地基"提交**（master，本文件同批）切出。命令：

```powershell
git worktree add -b feat/analysis-lotus-classic work\analysis-classic master
git worktree add -b feat/analysis-lotus-legacy  work\analysis-legacy  master
New-Item -ItemType Junction -Path work\analysis-classic\node_modules -Target D:\vueprojects\lianhua_guangma\node_modules
New-Item -ItemType Junction -Path work\analysis-legacy\node_modules  -Target D:\vueprojects\lianhua_guangma\node_modules
# tmp 不要 junction：各自留自己的 tmp，e2e 证据不互相覆盖
```

master 已被主工作区检出 ⇒ 只能以 master 为基点建**新分支**，不要再检出 master 本身。

## 3. 公共改动的唯一通道

以下文件是**冻结清单**，两条分支都**不许改**：

```
src/App.vue
src/game/llm/llmController.ts
src/game/llm/runtime.ts
src/game/replay/analysis/{session,storage,recorder,status,types,codec,export,import}.ts
docs/blood-flow/design/replay-analysis-reproduction-status.md
docs/blood-flow/design/analysis-recording-other-variants-plan.md
docs/blood-flow/design/analysis-two-variants-work-agreement.md   （本文件）
```

确需改动时，唯一通道是：

1. 在 **master**（主工作区）单独提一个「公共改动」提交（只含这次公共改动，不带玩法代码）；
2. `pnpm typecheck && pnpm test` 通过；
3. `pnpm sync:vibehub`（master 树必须干净）；
4. 通知另一边 `git merge master` 后继续（不 rebase，避免两边历史分叉）。

不允许"我在自己分支里改一下公共文件，回头让对方解决冲突"。

### 3.1 `App.vue` 的引擎端口传递：单写者（协调者）+ 固定顺序

两条分支都需要在 `App.vue` 里给自己那个引擎加一行 `analysis: analysis.port`（`localGame` 给 A、`lotusGame` 给 B）。
这一行**由协调者统一做**（App.vue 是冻结文件，只允许单写者；两行一次提交也避免两条分支抢同一处）：

1. A/B 先在自己的引擎文件里把**选项字段**加好并提交
   （A：`src/game/core/local/useGame.ts` 的 `UseGameOptions.analysis?`；B：`src/game/variants/lotus/lotusGame.ts` 的 `UseLotusGameOptions.analysis?`）——
   这是各自分支的文件，字段类型照抄血流：`analysis?: AnalysisRecorder | null`；
2. 把"字段已就绪"的提交 sha 报给协调者；
3. 协调者在 master 上加 `App.vue` 的那一行（两条分支都就绪就一次加两行）→ `pnpm typecheck && pnpm test` → `pnpm sync:vibehub`；
4. A/B `git merge master` 继续（这一行是"真实 App 路径"的最后一块）。

**关键：这一步不阻塞 A/B 的其它工作**。e2e fixture 应该像血流的 `tests/e2e/fixtures/analysis-probe.ts` 那样
**自己构造引擎 + 自己注入 recorder/session**（传 recorder 与传 null 各跑一遍即可验证"记录不影响对局"），
完全不需要 App.vue 那一行；App.vue 那一行只用于"真实 App 里的整链验收"。

§7.4 的"就地解"只是**合并时意外撞车的兜底**，不是"谁都可以先改冻结文件"的许可。

## 4. 已定好的公共地基（分叉前已完成，不要再动）

| 项 | 内容 |
|---|---|
| 能力表 | `src/App.vue` 里 `ANALYSIS_CAPABLE_RULESETS = ['lotus-blood-flow', 'lotus-classic', 'lotus-legacy']`：分析场次按这张表开；**两个新玩法已在表内**，所以两条分支都不需要再改这段 |
| 未接线期的显示口径 | `status.ts`：`analysisRecorded === true` 但库里这场没有记录 ⇒ 显示「分析：**未记录到任何数据**」（此前会显示「缺少决策分析记录」，那是"数据丢了"的意思，会误导） |
| LLM 钩子接口 | 见 §5（由 A 先实现并尽早合并；B 在 A 合并前不要碰这两个文件） |

## 5. LLM 钩子接口规范（A 负责实现，B 按此接口编码）

在 `src/game/llm/llmController.ts` 的 `LlmControllerHooks` 里**新增两个可选钩子**（现有的 4 个不动），
并在真正发请求/收回答的地方调用（`llmController.ts` 约 119/130/155 行、`runtime.ts` 约 122–160 行）：

```ts
export interface LlmControllerHooks {
  // …现有 onLlmMessage / onLlmFallback / onLlmStatus / onReset 保持不变
  /** 一次真实请求开始：候选、推荐、提示词引用（§3.3、§4）。不传时一个分支都不进。 */
  onDecisionRequest?(input: {
    seat: number; requestId: string; windowId: string
    legalActions: AnalysisLegalAction[]
    candidates: Array<{ id: string; label?: string; summary?: string; action: unknown }>
    recommended?: { candidateId: string; note?: string }
    promptTemplateId: string; promptVariables: unknown
    provider: string; model: string; sentAt: number
  }): void
  /** 一次请求结束：原话回答、解析结果、失败与回退、用量。 */
  onDecisionAnswer?(input: {
    requestId: string; raw: string; choice: string | null
    outcome: 'success' | 'invalid' | 'timeout' | 'error'
    fallback?: { reason: string }; usage?: unknown; responseModel?: string; completedAt: number
  }): void
}
```

判据（写进 A 的单测，B 复用同一套断言思路）：

- 不传钩子时：零调用、零行为变化（对局结果、动作数完全不变）；
- 传钩子时：`promptVariables` 与**实际发给模型的变量**逐字相等；`promptTemplateId` 相同的模板只存一次；
  变量里不得出现 API Key / Authorization；
- `outcome: 'error' | 'timeout'` 必须如实上报，并带 `fallback.reason`（回退到本地策略时决策来源要变成 `model-fallback`）。

## 6. vibehub 镜像清单（合并到 master 之后）

`pnpm sync:vibehub` 会保留 vibehub 自己的联机层文件，因此下列改动**不会自动过去**，必须手动镜像
（在 vibehub 工作区改、单独提交）：

| 文件 | 谁会需要 | 说明 |
|---|---|---|
| `src/App.vue` | 公共地基（能力表已是共享？**不是**：App.vue 是 keep 文件 ⇒ 地基里的能力表也要镜像一次） | 地基提交后必须同步镜像，否则 vibehub 站点按老条件只开血流场次 |
| `src/game/core/local/useGame.ts` | A（莲花广麻） | 选项 + 记录调用点两边各写一份 |
| `src/game/variants/lotus/lotusGame.ts` | B（翻精癞子） | **也是 keep 文件**（脚本 `$vibehubKeep` 里就有它 —— 2026-09-21 由 B 核实并纠正，我原先写成"共享文件"是错的）：B 的改动同样要手动镜像 |

联机侧（vibehub）改动是**串行**的：vibehub 工作区一次只能检出一条分支 ⇒ 约定「谁先合并到 master 谁先做镜像」。

### 6.1 镜像 keep 文件的正确姿势（2026-09-21 实战）

1. **顺序**：先 `pnpm sync:vibehub`（把 master 的共享文件带过来、keep 文件原样保留），**再**做镜像并提交 ——
   反过来的话，下一次同步会把镜像覆盖掉。
2. **手法：三方合并**，不要手工重放几百行：
   - `base` = 合并前的 master 版本（`git show <A 合并前的 sha>:<路径>`）
   - `ours` = vibehub 当前文件
   - `theirs` = 合并后的 master 版本
   - `git merge-file -p ours base theirs > merged`，检查无 `<<<<<<<` 后写回。
3. **行尾陷阱**：vibehub 工作区是 **CRLF**，而 `git show` 输出是 **LF** ⇒ 不先统一行尾，
   `git merge-file` 会把**每一行**都判成冲突（实测得到 1258 行冲突块）。先把 `ours` 转成 LF 再合并，
   写回时再转回 CRLF。
4. **验收**：`git diff --stat` 应显示"master 侧那点改动量"（例如 `+365/-3`），**不是**整文件重写；
   然后 `pnpm typecheck` + `pnpm test`（vibehub 全量）。

## 7. 合并与同步协议

1. 分支完成（DoD 见 §9）后：`git merge master`（把对方与公共改动并进来）→ 跑 `pnpm typecheck && pnpm test` + 自己的 e2e → 合并到 master（`--no-ff`，保留分支痕迹）。
2. 合并到 master 后立刻 `pnpm sync:vibehub`（master 树必须干净；别人的未提交文件会挡住脚本，遇到就找对方提交或等）。
3. 第二个分支合并前**必须**先 `git merge master`（不要 rebase 到公共分支上，避免两边历史打架）。
4. 冲突处理：只可能出在 `App.vue` 的"引擎端口传递"那一两行与文档登记表；就地解，然后把解法和原因写进提交信息。

## 8. 资源约定

- dev server 端口各占一个：**A = 4174，B = 4176**，都加 `--force`（两个工作树共享 `node_modules/.vite` 依赖缓存）。
- 重活错峰：不要同时跑 `pnpm test` 全量 / Playwright（各自还会起 Chromium），错开 2–3 分钟。
- e2e 证据写各自的 `tmp/`（不 junction），文件名带玩法前缀，互不覆盖。

## 9. 完成定义（DoD，两条分支同一套）

**P0（本轮范围）**：

- [ ] `pnpm typecheck` 通过；`pnpm test` 在**自己的干净工作树**上全绿（报告要说清是哪棵树）。
- [ ] `analysis/<variant>Adapter.test.ts`：前态投影的**字段形状 + 遮蔽**（别家暗手为空数组只给张数）、
      窗口 ID 在同一局面稳定且跨局不重复、`legalActionId` 与合法动作一一对应、结算四家变化之和为 0。
- [ ] `tests/e2e/analysis-<variant>.spec.ts`：跑完整场 → 从分析库读回 → 断言 `parts` 形状、
      行内状态「分析：完整」、导出包自包含（记录 + 被引用配置 + 展示回放）；开关关掉后**零写入**。
- [ ] 记录不得影响对局：同一场在"开关开/关"两种设置下的**结束分数与动作数完全一致**（这是本特性的硬护栏）。
- [ ] LLM 座位：先记 `source: 'unknown'`（不接钩子）；接钩子后改为 `model` / `model-fallback` 并补单测。
- [ ] 文档：`docs/blood-flow/design/analysis-<variant>.md` 写清字段口径、窗口 ID 规则、未做的部分。
- [ ] 提交信息里写明"验证在哪棵树、跑了哪些命令、观察到什么数字"。

**P1（§6 复现）**：不在本轮范围，单独排期（见方案文档 §4）。

## 10. 冲突/僵局处理

- 谁动了冻结清单：谁负责把它挪回 master 的「公共改动」提交，并通知对方 merge。
- 两边的 adapter 都想要同一段公共工具（例如窗口 ID 生成器）：**先各写一份**，等两边都合并后
  再在 master 提「公共改动」抽取——不要在地基里预造抽象。
- 一方卡住（例如 LLM 钩子实现不顺）：另一方**不受阻**，P0 的第一半（人类 + 本地 AI 座位）本来就不依赖钩子。

## 11. 协调者与交接（2026-09-21 起）

**协调者 = 主工作区（`D:\vueprojects\lianhua_guangma`，检出 master）里的那个会话**。它负责：

1. 把 A/B 完成的分支合并进 master（`--no-ff`）并跑门控（typecheck + 全量测试）；
2. 每次合并后 `pnpm sync:vibehub`，核对共享文件一致、keep 文件没被覆盖；
3. 需要"公共改动"时在 master 上单独提交（冻结清单里的文件只能这样改）；
4. 处理两条分支之间的冲突与顺序（先合谁、B 何时 merge master）；
5. 需要镜像 vibehub 的改动（§6）由它落实。

**A/B 的交接方式**：分支做到 DoD 后，向协调者报告三件事——
「分支名 + 期望合并的提交 sha + 门控结果（在哪棵树跑的、数字）」；协调者合并后再通知另一边 `git merge master`。
**不要**自己往 master 上推、也不要动别的工作树。

**工作树里的注意事项**：

- `node_modules` 是指向主工作区的 **junction**：**不要在工作树里跑 `pnpm install`**（会写穿到主工作区的依赖）；真要隔离就先把 junction 删掉再装。
- 各自的 dev server 端口见 §8；`E2E_SKIP_WEBSERVER=1` 复用它，别让 Playwright 自己再起一个。
- 开工第一步先 `git merge master`，把最新的约定与公共改动拿进来。

## 12. 两条会话的开场提示（直接粘贴）

**A（莲花广麻）**：

> 你在为本仓库实现「莲花广麻」玩法的 AI 分析记录（P0，不含赛后复现）。
> 先读：`docs/blood-flow/design/analysis-recording-other-variants-plan.md` 与
> `docs/blood-flow/design/analysis-two-variants-work-agreement.md`（你是 A）。
> 工作树 `work/analysis-classic`，分支 `feat/analysis-lotus-classic`（已从 master 的公共地基切出）。
> 开工先 `git merge master` 拿最新约定与公共改动（本文件 §11 是协调者与交接规则）。
> 只许改 §1 里属于 A 的路径。`LlmControllerHooks` 的两个可选钩子由你实现（§5），做完**尽早报告协调者合并到 master**
> 再继续，因为 B 在等它。参考实现：`src/game/replay/analysis/bloodFlowAdapter.ts` 与
> `src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts` 的记录调用点。DoD 见约定 §9。
> 注意 `useGame.ts` 是 vibehub keep 文件：改动要镜像（§6）；**不要在工作树里 `pnpm install`**（node_modules 是 junction）。

**B（莲花麻将·翻精癞子）**：

> 你在为本仓库实现「莲花麻将·翻精癞子」玩法的 AI 分析记录（P0，不含赛后复现）。
> 先读：`docs/blood-flow/design/analysis-recording-other-variants-plan.md` 与
> `docs/blood-flow/design/analysis-two-variants-work-agreement.md`（你是 B）。
> 工作树 `work/analysis-legacy`，分支 `feat/analysis-lotus-legacy`（已从 master 的公共地基切出）。
> 开工先 `git merge master` 拿最新约定与公共改动（本文件 §11 是协调者与交接规则）。
> 只许改 §1 里属于 B 的路径。**不要**动 `src/game/llm/*`（A 正在实现钩子）：先做人类座位 + 本地 AI 座位的
> 完整闭环（记录形状、遮蔽、窗口 ID、结算折算、e2e），LLM 座位先记 `source: 'unknown'`；
> 等 master 上出现 A 的钩子提交后 `git merge master` 再接钩子。参考实现同上。DoD 见约定 §9。
> **不要在工作树里 `pnpm install`**（node_modules 是 junction）。
