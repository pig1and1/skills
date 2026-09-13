# dsh-charts

无依赖的 SVG 图表组件。**计算是纯函数，渲染是薄层** —— 因此图表逻辑可以在 Node 里单测。

它是 [`frontend-tables-and-charts`](../frontend-tables-and-charts/SKILL.md) 技能的参考实现：
每条规则在这里都有对应的代码，而每条规则的理由写在技能里。

```sh
node --test      # 253 个单元测试
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
core.js      比例尺 · 圆整刻度 · 堆叠 · 分箱 · 四分位 · 缺口检测 · 降采样 · 格式化 · 色阶 · SVG 基元
             ↑ 纯函数：数字进、数字出、不碰 DOM
line.js      bar.js       scatter.js
histogram.js boxplot.js   heatmap.js     渲染层：把 core 算出的数字放进 SVG
theme.css    所有颜色都是 token，组件不出现任何具体颜色
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

### 另外四种

```js
import { scatterChart } from './src/scatter.js'
scatterChart(el, {
  points: [{ x: 12.4, y: 0.9, label: 'GET /api/items' }],
  xLabel: '耗时', xUnit: 'ms',
  xFromZero: false, yFromZero: false,   // 只表达位置，不必从 0
  cell: 14, maxMarks: 2000,             // 屏幕空间分箱：重合点聚成一个可读标记，而非一团墨
  onHover(p) { /* 悬停即读数；记录里的数值字段会自动全部列出 */ },
})
```

```js
import { histogramChart } from './src/histogram.js'
histogramChart(el, {
  values: samples,          // 或 { rows, value: r => r.ms }
  label: '响应时间',
  // 箱数默认按 Freedman–Diaconis 自适应（IQR→0 时退回 Sturges，再 clamp 到 [4,60]）；
  // 传 options.bins 可覆盖，但那是政策选择，不是默认
  domain: null,             // 钉住 x 范围以便多图可比；域外值计入 ignored，不会被静默丢弃
})
```

```js
import { boxplotChart } from './src/boxplot.js'
boxplotChart(el, {
  groups: [{ label: '周一', values: [] }, { label: '周二', values: [] }],  // 并排
  // 或 { rows, group: r => r.day, value: r => r.ms }
  minBoxSize: 12,           // n 小于它就改画全部数据点——几个点画出的箱会假装有分布
  iqrFactor: 1.5,           // Tukey 须
  yFromZero: false,         // 箱线图编码位置与离散度，不是数量
})
```

```js
import { heatmapChart } from './src/heatmap.js'
heatmapChart(el, {
  rows: records,            // 长格式：一条记录一个格子
  row: r => r.hour, col: r => r.day, value: r => r.errors,
  binMethod: 'auto',        // 'equal' | 'quantile'；auto 按占用率在两者间选
  colors: null,             // 默认用 theme.css 的顺序色阶；只能传 token
  missingLabel: '无数据',   // 缺失值必须与最小值视觉可分
})
```

**六种图表的轴基线，一句话记住**：图形**面积**代表数量（柱、直方图）→ **必须从 0**；
只代表**位置或分布**（折线、散点、箱线图）→ 不必从 0。热力图用色阶，没有轴基线。

**悬停即读数**：六个渲染层的 tooltip 都用 `display = 'block'` 显示。`.chart-tip` 在
`theme.css` 里是 `display: none`，写成 `''` 会回落到 `none`，**tooltip 永远不出现** ——
本项目在这一行上写错过 **8 次**，而且**看截图发现不了**。
`tests/tokens.test.js` 另会扫出引用了未声明 token 的地方，那是同一类不报错的静默失败。

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
- `--chart-seq-1..7` **顺序色阶**（热力图用）：两个主题下亮度都单调、相邻档可区分，最低档对各自 surface ≥ 3:1。**别拿 `--chart-cat-*` 当色阶** —— 那组色在亮/暗两主题下的亮度顺序互相矛盾，拼不出单调梯子
- `--chart-accent` 唯一的强调色，给"要说的那件事"
- `--chart-grid` / `--chart-axis`：网格淡到几乎看不见，层次是 **数据 > 轴 > 网格**
- 深色模式**不是反转**，是另挑一套（降饱和、拉开明度）

## 已知局限

- **渲染层只有部分自动化测试**。六种图表的**计算**都在 `core.js`（或模块内的具名纯函数）里，
  被直接单测；但**像素位置、CSS 层叠、DPR、真实 `ResizeObserver` 时序**没有回归保护 ——
  `tests/scatter.test.js` 起手写了 DOM 桩，但只能覆盖调用约定，覆盖不到真实布局。
  `complex-test.html` 是浏览器端的补充自检。
- **没有 TypeScript 类型**，也没有发布流程（没有 `dist/`、没有版本策略）。
- `preserveAspectRatio="none"` 意味着绘图区按容器宽度横向缩放。因此**所有文字都必须放在
  HTML 覆盖层里**，不能画进 SVG，否则会被拉伸变形——这是约定，不是可选项。
- **堆叠柱不适合表达"极小占比"**：占比低于 1% 的段在屏幕上不足 1px，既点不中也看不见。
  要看占比就画独立的占比图，不要把段塞进堆叠柱。
