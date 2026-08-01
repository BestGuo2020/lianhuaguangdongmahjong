# 莲花广麻

一款参考传统 PC 麻将房视觉制作的 Vue 单机四人麻将游戏。

## 运行

```bash
npm install
npm run dev
```

生产构建与规则测试：

```bash
npm run build
npm test
```

## 已实现规则

- 只碰、杠，不吃牌
- 仅自摸和抢杠胡，不支持普通点炮
- 白板作为癞子，可代替任意牌
- 庄家 ×2，无癞子 ×2
- 红中自动开杠，并从牌墙尾部补摸
- 四张红中立即自摸，额外 ×4
- 胡后摸 8 张马牌，每张 1、5、9 或红中加 1 番

点击手牌进行选择，再次点击同一张牌即可快速打出；也可使用右侧“出牌”按钮。超时后会自动托管出牌。

## 示例头像

测试头像由 [DiceBear Adventurer](https://www.dicebear.com/styles/adventurer/) 生成，原始设计作者为 Lisa Wischofsky，采用 CC BY 4.0 许可。
