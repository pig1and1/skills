# 每条规则背后的真实故障

`SKILL.md` 里的规则不是凭感觉写的。这里记录它们的来源：公开的 bug 报告、设计系统的规范原文、
实践者的经验总结。

**想知道"为什么要有这条规则"，读这里。日常施工不需要它。**

---

## 表格

| 出处 | 症状 | 根因 | 规则 |
|---|---|---|---|
| [`srelens/srelens` #298](https://github.com/srelens/srelens/issues/298) | 滚动时列宽左右跳；**手动拖过一次列宽后永久消失** | `table-layout: auto` + 虚拟滚动，宽度按当前渲染的行推导 | §1 |
| [`nesquena/hermes-webui` #5672](https://github.com/nesquena/hermes-webui/pull/5672) | 移动端滚动跳回；`scrollTop` 被 clamp 或重锚到远处行 | DOM 重建丢失 `content-visibility` 的尺寸记忆，退回写死的 `contain-intrinsic-size` | §1 |
| [`OctoPunkIO/svelte-datatable` #13](https://github.com/OctoPunkIO/svelte-datatable/issues/13) | Safari 17 上虚拟滚动 + 粘性表头快滚时抖 1–2px | WebKit 怪癖，Chrome / Firefox 正常 | §1 |

**规范** —— [Table (Data Table / Data Grid) — Benchmark Spec](https://cdn.jsdelivr.net/npm/@hegemonart/get-design-done@1.60.1/reference/components/table.md)：
从 **Carbon DataTable、Polaris DataTable、Atlassian DynamicTable、Ant Design Table、UUPM
app-interface** 五个系统归纳。§2 的尺寸表、"默认 48px 行高"、无障碍契约、以及两条禁令
（不要动画列宽、不要在表格分区上用 `display: contents`）都出自它。

它的**写法**也值得学：每条断言附来源，每个违规给可 grep 的检测命令，每个反例说明**为什么失败**和**怎么修**。

**实现参考** —— [`openstatusHQ/data-table-filters`](https://github.com/openstatusHQ/data-table-filters)
（2252★ · MIT · TypeScript）：shadcn/ui + TanStack Table。看它的 issue/PR 记录比读代码更快，
例如 [`Refactor/shadcn neutral oklch theme`](https://github.com/openstatusHQ/data-table-filters/issues/102)。

---

## 图表

| 出处 | 症状 | 根因 | 规则 |
|---|---|---|---|
| [`Selftend/selftend` #2347](https://github.com/Selftend/selftend/issues/2347) · [#2346](https://github.com/Selftend/selftend/issues/2346) | 图表/组件**未预留空间**导致布局偏移 | 高度由内容决定 | §5 |
| [`Selftend/selftend` #2341](https://github.com/Selftend/selftend/issues/2341) | 布局偏移是否该进 CI、能断言什么 | **CLS 可测量**，可作验收门槛 | §5 |
| [`BenjaminSRussell/cozy-game` #58](https://github.com/BenjaminSRussell/cozy-game/issues/58) | Retina 上 canvas 模糊 | 未做 `devicePixelRatio` 缩放 | §5 |
| [`askrjs/askr-charts` #30](https://github.com/askrjs/askr-charts/issues/30) | 默认分类色里有一对**相邻的红/绿** | 红绿色盲无法区分 | §11 |
| [`crzyc98/planwise_navigator` #497](https://github.com/crzyc98/planwise_navigator/issues/497) | 调色板**未通过色觉审计**，最后维护两套 | 同上 | §11 |

**规范（正确性）**

- [Carbon — Axes and labels](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/data-visualization/axes-and-labels/index.mdx)
  —— Y 轴基线判据：柱状/面积必须从 0，折线/散点不必。
- [Avoiding Misleading Data Visualizations](https://github.com/LMK89/Machine-Learning-MD/blob/main/Data-Visualization/Avoiding%20Misleading%20Data%20Visualizations.md)
  —— 尺度选择与截断的后果。
- [Carbon Charts](https://github.com/carbon-design-system/carbon-charts)（IBM，D3 + TypeScript）
  —— 明确区分**分类色 / 顺序色 / 发散色**三种用途；**用错类型比选错颜色更糟**。

**实践（手艺层）** —— 正确性之外的部分主要来自这两处：

- [Datawrapper: What to consider when creating line charts](https://www.datawrapper.de/academy/what-to-consider-when-creating-line-charts)
  —— 折线 vs 柱状的判据；用**灰色 + 线宽 + 线型**分出主次；直接标注在窄屏必须退化为图例；
  何时把基线延伸到 0 或 100%；**曲线平滑为什么会歪曲数据**。
- [Datawrapper: How to deal with missing data in line charts](https://www.datawrapper.de/academy/patchy-data)
  —— 缺口处理；**实线 = 采集 / 虚线 = 推测**这条区分的来源；阶梯插值。
- [Claus Wilke, *Fundamentals of Data Visualization*](https://github.com/clauswilke/dataviz)
  （O'Reilly，全书开源）—— *Designing figures without legends*（用**直接标注**取代图例的完整论证）、
  *Common pitfalls of color use*（"定性配色在 **3–5 个类别**时最有效"）。
- [FT Chart Doctor](https://github.com/Financial-Times/chart-doctor)（3341★）—— *Visual Vocabulary*
  用九类关系回答"什么数据用什么图"：deviation · correlation · ranking · distribution ·
  change over time · part-to-whole · magnitude · spatial · flow。

---

## 这个 skill 自己踩过的坑

写它、以及用它做示例的过程中，发现的都是**验证方法本身**的问题，值得单列：

| 现象 | 教训 |
|---|---|
| 检查脚本用 `querySelectorAll('table')[1]` 拿到了错误的元素 | 索引选择器在结构变化时**静默出错**，不会报错 |
| 检查器只认 `getElementById`，漏掉 `el()` 简写 → `referenced=0` | **假通过**比失败危险：失败催你修，假通过让你以为验过了 |
| 断言 `/y2/` 匹配到 SVG 的 `<line y2=…>` | 断言也会**误报**；正则要盯语义不盯字面 |
| 断言写 `font-size:13.5px`，而代码用的是 `font:` 简写 | 同上 |
| `naive` 诊断里手滑写了 `gaps: 0`，导致"未检测缺口"永远不成立 | **一个不可能失败的断言** |
| 变异测试：`boxStats` 关闭下界判定后测试仍全绿 | 用例只有**高端**离群值，**低端判定从未被测到** |
| 变异脚本自己的锚点写错，报 `SKIP` | 连"验证测试的工具"也会错 |
| 框线图渲染层的测试断言写成 `assert.notEqual(display, 'none')`，在**坏实现**下全部通过 | 又一个**不可能失败的断言**。要断言**精确值**（`=== 'block'`），并做变异确认它会红 |
| 参考实现 `line.js` / `bar.js` 用 `tip.style.display = ''` 显示 tooltip，而 `.chart-tip` 在 CSS 里是 `display: none` | **范本里的 bug 会被复制**：同一批新写的三个渲染层里，两个照抄了它。`''` 只是清掉内联值，会**回落到 `none`** → tooltip 永远不出现 —— 而"悬停即读数"正是本 skill 的核心要求，**且只看静态截图发现不了** |
| 这些参考实现的行高曾统一写作 36px，与正文的"常规 48px"冲突，注释还自称"the regular density from the skill" | **AI 会信范本而不是正文**（范本更具体、更能直接抄）。已全部统一为 48px；**改规则时必须同步改范本**，并让范本注明它依据正文的哪一节 |

**结论**：**断言必须能被证伪**——先确认它在坏的实现上真的会变红。
这条比任何一条图表规则都更常救场。
