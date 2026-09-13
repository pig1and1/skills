# dsh-charts

无依赖的 SVG 图表组件。**计算是纯函数，渲染是薄层** —— 因此图表逻辑可以在 Node 里单测。

它是 [`frontend-tables-and-charts`](../frontend-tables-and-charts/SKILL.md) 技能的参考实现：
每条规则在这里都有对应的代码，而每条规则的理由写在技能里。

```sh
node --test      # 89 个单元测试，约 300ms
node serve.js    # 打开 http://127.0.0.1:4173/complex-test.html
```

## 测试策略

四层，逐层收紧：

| 层 | 文件 | 针对什么 |
|---|---|---|
| 单元 | `tests/core.test.js` | 每个纯函数的基本契约与退化输入 |
| 敌意数据 | `tests/complex.test.js` | 造出来的九类脏数据：空洞、脏值、重复时间戳、乱序、恒定段、尖峰、极端量级、恶意标签 |
| 流水线 | `tests/pipeline.test.js` | `prepareSeries` 的完整链路与选项语义 |
| 选项矩阵 | `tests/options.test.js` | `zeroBased` × `robust` × `floor` × `maxPoints` 的交叉 |

**还有一层不写在测试里**：`complex-test.html` 是浏览器端自检页，把同一批数据渲染出来并
显示实际读数 —— **纯函数覆盖不到的渲染路径，靠它确认**。

### 断言必须能失败

写测试时最危险的不是失败，而是**通过**。一个永远为真的断言比没有断言更糟，因为它让人
以为验过了。所以这里做了一次**变异测试**：把实现故意改坏，确认断言会变红。

第一轮九个变异体，**八个被捕获，一个存活**：

```
SURVIVED  boxStats 不做离群判定
```

因为那个变异只破坏了**下界**（`fenceLo = -Infinity`），而当时的用例 `[1, 2, 3, 4, 5, 100]`
只有**高端**离群值 —— 低端判定根本没被测到。补上 `[-100, 1, 2, 3, 4, 5]` 之后，同一个
变异立刻被抓住。

**这就是那一层的意义：它找的不是代码的 bug，是测试的盲点。**

## 为什么这样分层

```
core.js     比例尺 · 圆整刻度 · 堆叠 · 分箱 · 四分位 · 缺口检测 · 降采样 · 格式化 · SVG 基元
            ↑ 纯函数：数字进、数字出、不碰 DOM
line.js     把 core 算出的数字放进 SVG
bar.js      同上
theme.css   所有颜色都是 token，组件不出现任何具体颜色
```

一个图表的数学如果长在它的渲染函数里，**就只能靠看像素来检查**，也就是永远不会被检查。
分层之后，`core.js` 的每个函数都能用脏数据直接测——`tests/core.test.js` 里就是这么做的。

## 用法

```html
<link rel="stylesheet" href="./src/theme.css">
<div id="chart"></div>
<script type="module">
  import { lineChart } from './src/line.js'

  const chart = lineChart(document.getElementById('chart'), {
    points: [{ t: Date.parse('2026-08-01'), value: 92.4 }, /* … */],
    height: 260,
    showArea: true,
    label: '健康分',
    onHover(point, index) { /* 悬停读数 —— 不必点击 */ },
    onSelect(point, index) { /* 点击：把当前读数钉住 */ },
    onRender(info) { /* info.rejected / info.sampled / info.domain */ },
  })

  chart.update({ points: next })   // 换数据
  chart.select(3)                  // 程序化钉住
  chart.destroy()                  // 清理监听与 DOM
</script>
```

```js
import { barChart } from './src/bar.js'

barChart(el, {
  rows: [{ t, a, b, c }],
  x: (r) => r.t,
  height: 300,
  series: [
    { key: 'a', label: 'USB 断开', color: 'var(--chart-cat-3)' },
    { key: 'b', label: '传输错误', color: 'var(--chart-cat-2)' },
    { key: 'c', label: '供电欠压', color: 'var(--chart-cat-1)' },
  ],
  // 同量纲的平均线，与柱共用一条从 0 起的轴
  line: { read: (r) => (r.a + r.b + r.c) / 3, label: '平均' },
  onHover(row) { /* … */ },
})
```

**没有第二个 Y 轴选项**，这是刻意的。柱的面积代表数量，线的位置代表数值；两者共用一条轴
就必须同量纲。不同量纲的出路是**拆成上下两张图**，不是加一条右轴——那会画出一个数据里
并不存在的相关性。`line.read` 的存在本身就意味着"同量纲"。

## 内建的数据防御

真实数据是脏的，所以这些不是可选项：

| 情况 | 处理 |
|---|---|
| `NaN` / `null` / 字符串 | 剔除，并通过 `onRender(info).rejected` **报告数量** |
| 时间乱序 | 内部排序 |
| 同一时间戳重复 | **取平均**，不是丢弃 |
| 时间缺口 | **默认断线**（`connectGaps: true` 才连起来）。连续折线等于宣称"这期间一直如此" |
| 全部数值相同 / 只有一个点 | 域居中展开，不做除零 |
| 点数 > `maxPoints`（默认 700） | 按时间桶降采样，`sampled: true` |
| 标签含 HTML | `esc()` 转义（标签来自数据，数据不可信） |
| 容器尺寸变化 | `ResizeObserver` + `requestAnimationFrame`，每帧最多重绘一次 |

## 主题

组件只引用 token，不写死颜色。改主题 = 改 `src/theme.css`：

- `--chart-cat-1..8` 分类色：**同一色系的明度阶梯**，不是彩虹（天然色觉友好，且顺序自带含义）
- `--chart-accent` 唯一的强调色，给"要说的那件事"
- `--chart-grid` / `--chart-axis`：网格淡到几乎看不见，层次是 **数据 > 轴 > 网格**
- 深色模式**不是反转**，是另挑一套（降饱和、拉开明度）

## 已知局限

- **只有 `line` 和 `bar`**。散点、直方图、热力图、箱线图还没做（`core.js` 里已经有
  `histogram` / `boxStats`，但还没有对应的渲染层）。
- **没有针对渲染层的自动化测试**。测试覆盖 `core.js`（纯计算）；`line.js` / `bar.js` 里
  的像素计算是按规则人工核对的，没有回归保护。
- **没有 TypeScript 类型**，也没有发布流程（没有 `dist/`、没有版本策略）。
- `preserveAspectRatio="none"` 意味着绘图区按容器宽度横向缩放。因此**所有文字都必须放在
  HTML 覆盖层里**，不能画进 SVG，否则会被拉伸变形——这是约定，不是可选项。
