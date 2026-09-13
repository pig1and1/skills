---
name: frontend-tables-and-charts
description: Use when building or restyling a frontend data table OR chart — column widths, alignment, row density, sticky headers, hover/selection/focus states, virtual scrolling, theme tokens, sparklines, line/bar/area charts, axis ranges and baselines, chart sizing, DPR-correct canvas — or when diagnosing table jitter, drifting columns, scroll jump-back, layout shift after a chart loads, blurry charts, or misleading axes. 触发场景：前端表格 / 数据网格 / 图表（折线、柱状、面积、迷你图）的样式与交互实现或改造，尤其是列宽跳动、滚动抖动、粘性表头错位、大列表卡顿、图表加载后页面跳动、高分屏模糊、Y 轴误导，以及"表格或图表不好看、不简洁"这类要求。
---

# 前端表格与图表：好看、简洁、稳定、快

两者的难点是**同一个**：**别抖**。表格抖在列宽和滚动位置，图表抖在加载后的高度和重绘。
剩下的（好看、简洁、快）都是收尾。不先把"不动"做到，怎么调样式都不对。

## 0. 表格：先定规模，再谈方案

**先问：一次最多渲染多少行？** 过度工程和工程不足一样糟。

| 一次渲染的行数 | 方案 |
|---|---|
| ≤ 100 | **普通渲染**，不要虚拟滚动 |
| 100 – 1,000 | 虚拟滚动 + **固定行高** |
| 1,000 – 10,000 | 虚拟滚动 + **服务端分页/排序/过滤** |
| > 10,000 | **服务端承担一切**，或改用内置虚拟化的重量级网格 |

1,000 与 10,000 是两道实测的性能墙。headless 方案（TanStack Table，约 9KB）适合 ≤10k 行
且要自绘 UI；内置虚拟化的网格（AG Grid，约 150KB）适合 100k+ 行。

## 1. 表格稳定：滚动时什么都不跳

| 症状 | 成因 | 对策 |
|---|---|---|
| **列宽随滚动左右跳** | `table-layout: auto` 按**当前渲染的行**推导宽度，虚拟滚动每次换行集就重算 | **`table-layout: fixed`** + 每列显式宽度 |
| 数字列宽度忽宽忽窄 | 比例字形下 `1` 与 `8` 宽度不同 | **`font-variant-numeric: tabular-nums`** |
| 滚动条出现/消失时抖动 | 滚动条占宽度 | **`scrollbar-gutter: stable`** |
| **滚动突然跳回** | `content-visibility: auto` 靠"记住上次尺寸"；DOM 重建时记忆丢失，退回固定的 `contain-intrinsic-size` → 行高塌陷 → `scrollHeight` 变小 → 浏览器强制 clamp `scrollTop` | **固定行高**；且让它与真实行高一致 |
| 数据到达后列宽重排 | 骨架屏与真实内容列宽不同 | 骨架屏**复用同一套列定义** |
| 粘性表头下内容透出 | 表头背景透明 | 表头**必须**不透明底色（深浅两套） |
| Safari 上粘性表头快滚抖 1–2px | WebKit 怪癖（Chrome/Firefox 正常） | 别在 sticky 元素上叠 `transform` |

**两条诊断捷径**：

- **手动拖一下列宽就永久不再抖** → 病根一定是 `table-layout: auto`（拖拽把宽度固定了）。
- **行数少时正常、超过某阈值才开始抖** → 同一处，阈值就是"开始虚拟化"的点。

### `content-visibility` 与虚拟滚动**互斥**

两者都在解决渲染量，叠加零收益却引入上面那条塌陷。要虚拟滚动就别用它；不虚拟化时可用，
但 `contain-intrinsic-size` 必须贴近真实高度。

## 2. 表格：简洁与尺寸

**删掉**：所有竖线、**斑马纹**（用行 hover 代替）、逐格边框、表头下的粗横线。
**保留**：行 hover 底色、极浅的行分隔线或干脆不要、靠**字重 + 字色**区分表头。

| 内容 | 对齐 |
|---|---|
| 文本 | 左 |
| **数字** | **右** |
| 状态 / 标签 / 图标 | 居中 |

| 项 | 紧凑 | **常规（默认）** | 宽松 |
|---|---|---|---|
| 行高 | 32px | **36px** | 40px |
| 单元格纵向 padding | 6px | **8px** | 10px |
| 单元格横向 padding | 10px | **12px** | 16px |

"好看"几乎全部来自**一致的节奏**，不是任何单点装饰。

**色彩走语义 token**（`--table-border` / `--table-header-bg` / `--table-row-hover` /
`--table-row-selected` / `--table-focus`），深浅两套都要给。

## 3. 图表：先问它回答什么问题

**表格给精确值，图表给形状。用错工具，两边都白做。**

| 要回答的问题 | 用 | 注意 |
|---|---|---|
| 精确值是多少 | **表格** | — |
| **趋势 / 走势** | **折线** | 可以从非 0 起（见 §6） |
| 比较大小 | **柱状** | **必须从 0** |
| 部分-整体 / 构成 | 堆叠柱、面积 | **必须从 0** |
| 分布 | 直方图、箱线 | 别用折线画分布 |
| 相关性 | 散点 | — |

**不要用表格表达趋势**（那是把形状塞进格子），**也不要用图表表达精确值**（读不出来）。

## 4. 图表：技术选型

| 方案 | 适用 | 代价 |
|---|---|---|
| CSS / HTML | 进度条、单组简单柱 | 表达力有限 |
| **内联 SVG** | **≤ 1–2k 点**，需要交互或可访问性 | DOM 节点多，几千个后开始卡 |
| **Canvas** | **> 2k 点**、高频重绘 | 无 DOM 语义；**必须自己处理 DPR** |
| 图表库 | 缩放、刷选、联动等复杂交互 | 包体积与配置复杂度 |

**SVG 与 Canvas 的分界在数据点数量**，不在"哪个更现代"。折线图几百个点用 SVG 更好
（可选中、可加 `title`、可打印）；上万点必须 Canvas。

## 5. 图表稳定：**预留空间**

| 症状 | 成因 | 对策 |
|---|---|---|
| **数据到达后整页跳** | 容器高度由内容决定 | **预留空间**：固定高度或 `aspect-ratio`，骨架屏用**同一高度** |
| **高分屏上模糊** | canvas 没乘 `devicePixelRatio` | `canvas.width = cssW * dpr`，再 `ctx.scale(dpr, dpr)`；CSS 尺寸保持 cssW |
| 轴标签位数变化 → 绘图区变宽变窄 | 标签宽度不定 | 轴宽**预留固定值** + `tabular-nums` |
| Y 轴范围随数据变 → 图形跳 | 自动缩放 | 固定域；或对域变化做**平滑过渡** |
| 窗口 resize 时抖 | 每次事件都重建 | `ResizeObserver` + `requestAnimationFrame` 节流 |
| 多个图不同步 | 各自缩放 | **共享 Y 域** |

**验收指标**：布局偏移是**可测量**的（Cumulative Layout Shift）。图表加载后的 CLS 应接近 0 ——
这意味着容器高度在数据到达前就已确定。

## 6. 图表正确：别误导

### Y 轴要不要从 0 —— 两个方向都会错

按 Carbon 设计系统（IBM）的规范：

- **必须从 0**：**柱状图、面积图**（部分-整体、比较）。截断 Y 轴会**放大微小差异**，
  让不重要的差别看起来显著。
- **可以从非 0**：**折线图、散点图**。它们表达**趋势而非相对大小**，对截断不敏感；
  反过来，强行从 0 会把真实波动压成一条平线。

**判据一句话**：**图形面积代表数量 → 从 0；图形只代表位置 → 不必从 0。**

### 其他常见误导

| 不要 | 原因 |
|---|---|
| **双 Y 轴** | 暗示两个序列相关，而相关性是画出来的，不是数据里的 |
| **3D** | 透视让读数失真，无任何信息增益 |
| **饼图超过 5 类** | 人眼分辨小扇区角度很差；改用柱状或堆叠条 |
| 面积图**叠加**比较不同序列 | 下面那条被遮住的部分无法读；要么分组，要么用折线 |
| 分类色超过 **6–8 种** | 颜色不再可区分；换分面或分组 |
| 只靠颜色区分序列 | 色觉差异者读不出；同时用线型、标记或直接标注 |

## 7. 图表：性能与可访问性

**性能**：数据点 > 2k 用 Canvas；**画不出来的点不必画**（先降采样再绘制）；
别在滚动或动画回调里重绘；`ResizeObserver` 里只重设尺寸、不重建数据。

**可访问性**：图表**必须**有文字等价物 —— 最实用的做法是**旁边配一个表格**（表格与图表
在这里正好互补）；不要只靠颜色；如果图表可交互，键盘也要能到达；动画要短（≤200ms）并
尊重 `prefers-reduced-motion`。

## 8. 交付前自检

**表格**
- [ ] 一次最多渲染多少行？方案匹配吗？
- [ ] 列宽**显式**、`table-layout: fixed` 了吗？
- [ ] 数字列右对齐 + `tabular-nums` 了吗？
- [ ] **真机滚动**验证过列宽/行高/滚动条都不动吗？
- [ ] 粘性表头背景不透明、层级明确吗？
- [ ] hover / selected / focus 三态都有且可区分吗？

**图表**
- [ ] 这个数据用图表回答的问题，是**形状**而不是精确值吗？
- [ ] **容器高度在数据到达前就确定**了吗？（CLS 应接近 0）
- [ ] Canvas 乘了 `devicePixelRatio` 吗？高分屏上验过吗？
- [ ] 柱状/面积的 Y 轴**从 0** 了吗？折线的域选择有依据吗？
- [ ] 没有双 Y 轴 / 3D / 超 5 类饼图吗？
- [ ] 有**文字等价物**吗？序列不只靠颜色区分吗？

**共同**
- [ ] 深浅两套主题都验过吗？
- [ ] 1000 行级别滚动、或 >2k 点的图表，掉帧吗？（DevTools 实测，别猜）
- [ ] 键盘能走通吗？

## 9. 已验证的真实故障（对照用）

| 出处 | 症状 | 根因 |
|---|---|---|
| [`srelens/srelens` #298](https://github.com/srelens/srelens/issues/298) | 滚动时列宽左右跳；**拖过一次列宽后永久消失** | `table-layout: auto` + 虚拟滚动 |
| [`nesquena/hermes-webui` #5672](https://github.com/nesquena/hermes-webui/pull/5672) | 移动端滚动跳回 | DOM 重建丢失 `content-visibility` 的尺寸记忆 |
| [`OctoPunkIO/svelte-datatable` #13](https://github.com/OctoPunkIO/svelte-datatable/issues/13) | Safari 17 粘性表头抖 1–2px | WebKit 怪癖 |
| [`Selftend/selftend` #2347](https://github.com/Selftend/selftend/issues/2347) · [#2346](https://github.com/Selftend/selftend/issues/2346) | 图表/组件**未预留空间**导致布局偏移 | 高度由内容决定 → 用 "reserve its space" 修掉 |
| [`Selftend/selftend` #2341](https://github.com/Selftend/selftend/issues/2341) | 布局偏移是否该进 CI、能断言什么 | **CLS 可测量**，可作验收门槛 |
| [`BenjaminSRussell/cozy-game` #58](https://github.com/BenjaminSRussell/cozy-game/issues/58) | Retina 上 canvas 模糊 | 未做 `devicePixelRatio` 缩放 |

**规范来源**：[Carbon — Axes and labels](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/data-visualization/axes-and-labels/index.mdx)（Y 轴基线判据）、
[Avoiding Misleading Data Visualizations](https://github.com/LMK89/Machine-Learning-MD/blob/main/Data-Visualization/Avoiding%20Misleading%20Data%20Visualizations.md)（尺度与截断）。

## 参考实现（按需加载，是起点不是成品）

- `references/table.css` —— 样式基线，每段注明它防的是哪个故障，含深浅主题 token。
- `references/VirtualTable.tsx` —— React 固定行高虚拟表格骨架，无依赖。
- `references/LineChart.ts` —— Canvas 折线图骨架：DPR 正确、容器**预留空间**、`ResizeObserver` 节流。
- `references/verify.html` —— **自验证页面**：滚动前后列宽快照、数字列宽度波动、`content-visibility` 塌陷复现，全部读数值并自动判定。

参考实现均**未经真实项目运行验证**，是为你的项目改写的起点：替换 token、
按真实列宽填 `<colgroup>`、把行高与 `contain-intrinsic-size` 对齐。
