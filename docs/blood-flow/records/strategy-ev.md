# 血流本地 AI 策略对比（legacy vs 贪婪 EV）

规则：lotus-blood-flow-v1；引擎提交：a1d40c5700d2a94a8c7347e543af0464fc73c162；每策略 100 局、种子 1～100，四席自我对局；另含 ev×2 席 + legacy×2 席混合对局 100 局。已胡后仍接受合法胡；显式关闭 UI 节拍；每动作检查 136 张物理牌与零和，全部结束、无停滞。ev 参数默认值见[策略设计](../design/ai-strategy.md#参数默认值集中在-configts)。

## 自对局

| 策略 | 首次成牌 | 重复胡 | 无胡局 | 硬胡 | 封顶 | 首胡墙长均值 | 分差均值/最大 | 命令均值 | 拒胡 | 拒胡放弃收入 | 改张 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| legacy | 287 | 1525 | 0 | 72 | 0 | 51.89 | 701.90 / 2640 | 108.42 | 0 | 0 | 0 |
| legacy-min40 | 164 | 1100 | 10 | 85 | 0 | 34.12 | 825.50 / 3840 | 123.63 | 1711 | 40250 | 0 |
| ev | 280 | 3757 | 0 | 97 | 0 | 42.94 | 1667.40 / 5130 | 129.54 | 678 | 23370 | 180 |

### legacy

耗时 307.0 秒；硬胡占比 3.97%；封顶占比 0.00%；番型记录：sevenPairs 252、pinghu 1197、mixed-suit 90、shiSanLan 90、qiXing 157、three-concealed-triplets 53、all-triplets 1、four-concealed-triplets 1、big-three-dragons 2、three-kongs 3。

### legacy-min40

耗时 385.2 秒；硬胡占比 6.72%；封顶占比 0.00%；番型记录：sevenPairs 212、three-concealed-triplets 113、pinghu 528、shiSanLan 65、qiXing 149、mixed-suit 234、big-three-dragons 2、all-triplets 6、four-concealed-triplets 4、little-three-dragons 2、three-kongs 4。

### ev

耗时 356.4 秒；硬胡占比 2.40%；封顶占比 0.00%；番型记录：pinghu 2284、mixed-suit 251、sevenPairs 1080、three-concealed-triplets 179、qiXing 203、shiSanLan 85、four-concealed-triplets 31、all-triplets 43、pure-suit 3、little-three-dragons 3。

## 混合对局（ev 席 0/1，legacy 席 2/3）

- ev 两席净变总分 41180，legacy 两席净变总分 -41180；胡记录 ev 2402 / legacy 781；无胡局 0；ev 席拒胡 387 次、改张 86 次；耗时 334.6 秒。

## 口径与边界

- 「拒胡」= 锁手前有胡可选却未选胡；「放弃收入」= 这些拒胡窗口的立即总收（按引擎精确分累计）；「改张」= 拒胡且弃非摸牌位（自摸窗口保留摸牌换听）。
- 这是固定种子小样本分布与守恒验收，不推出策略对抗胜率、LLM 强度或长期平衡结论；反事实「若胡实收」未逐笔重放，仅以放弃收入与终局净分对照。
