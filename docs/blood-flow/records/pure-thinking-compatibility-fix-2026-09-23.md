# 纯思考模型实战兼容修复（2026-09-23）

## 复现依据

827604c7回放使用qwen3-vl-235b-a22b-thinking，82次请求全部以“供应商仍返回思考内容，非思考模式验证失败”结束，未采用任何千问模型动作。原文件SHA-256为9ef655eb0e644e658edd4e20a9d1d397e51d9f1db1ceefc0caea7180b79017ec。该局已经在此前分析中完整重放，547条命令、156笔结算均匹配。

问题在共享chat请求链路：reasoningPolicy识别为reasoning-only，但preparedDecision与client只将always-on视为必须接收思考响应。最终合法JSON即使存在，也可能在解析前因推理字段被拒。连接测试原来又允许思考及截断，可能出现探测通过、实战持续回退的差异。

## 修复

- 新增hasMandatoryReasoning，统一识别always-on与reasoning-only。已识别纯思考型号允许响应携带推理字段；仍只从最终content解析合法候选ID，绝不从reasoning_content执行动作。
- 纯思考不再依赖条件增强配额，也不因此被强加条件增强的40秒截止。thinkingRequests正常计数，enhancedReasoningRequests只计真实可选增强；初始及流式进度只显示安全状态短句。
- 保持原有always-on普通调用的展示合同，未通过放宽旧测试掩盖提示语回归。
- 千问纯思考不附加关闭思考参数，也不附加与思考组合不相容的response_format JSON模式；最终JSON仍由提示词约束和客户端白名单解析校验。
- 纯思考普通请求初始输出预算参数8192 tokens，复用既有自适应预算：依据返回推理用量调整，截断后提高下一次预算，请求上限65536。不对截断请求立即重复调用；保留已有的一次语义重试。
- 继续遵守用户配置的超时与取消。preparedDecision实际请求预算取配置、剩余总预算及权威剩余时间的交集；即使用户关闭供应商超时，有限权威截止仍生效。
- 纯思考连接探测也需要最终PING动作JSON通过相同解析器，只有思考、最终动作非法或截断都不能报告成功。普通模型既有探测约定保持不变。

共享改动位于reasoningPolicy、reasoningBudget、client、preparedDecision；没有修改麻将策略、胡牌规则或JEV System One协议。未调用真实供应商、没有付费模型请求或部署。

## 验收

- 新增16项reasoningOnly回归。最初4项（SSE、JSON、完整请求生命周期、纯思考连接探测）修复前均失败，修复后通过。
- 覆盖：最终JSON与推理字段隔离、未知候选拒绝、缺少最终答案拒绝、截断与预算增长、纯思考别名、非思考型号仍严格校验、权威截止、关闭超时、外部取消、连接探测。
- 实际血流控制器调用共享客户端读取模拟SSE，记录source=model与outcome=success，fallbacks=0，返回动作被真实引擎接受。
- 新增浏览器整局：qwen3-vl-235b-a22b-thinking收到模拟reasoning+final content SSE，successes>0、thinkingRequests>0、fallbacks=0；请求不带enable_thinking=false或response_format，给出纯思考输出预算。
- 全量前端：202个测试文件通过、1个原有跳过；2070项通过、2项原有跳过。
- 应用类型检查、生产构建通过；保留既有大chunk提示。
- 8个浏览器目标用例全部通过（含新增纯思考整局、原有3种模型主题/可用性、单机东风/半庄、大厅与规则可用性）。收敛状态提示之后又重跑4个LLM用例，全部通过。

以上证明客户端接入和模拟实战通过，不是对该模型真实速度、费用或麻将牌力的评估。真实供应商仍需返回完整合法最终答案，且遵守实际时限与协议。

基线提交0d34e67。工作区原有docs/blood-flow/design/jev-selfplay.md草稿不属于本次任务，保留且不提交；同步使用临时干净master检出。诊断与验证日志在work/pure-thinking-fix。
