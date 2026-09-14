# 每条规则背后的真实故障

`SKILL.md` 里的规则不是凭感觉写的。这里记录它们的来源：公开的 bug 报告、设计系统**源码**、
实践者教材，以及**若干二手归纳**。**每条都标了证据等级与 stars，但"有出处"不等于"已核实"**
—— 读的时候请连着等级一起读。

**想知道"为什么要有这条规则"，读这里，但先读下面那张等级表。**

## 先看证据等级，再看结论

这里的每个来源都**可追溯**，但**可追溯不等于已核实** —— 这条区别值得写在最前面，因为
本 skill 曾经栽在它上面：我在正文里写过"**四个**系统（Carbon / Polaris / Atlassian / Ant Design）
在默认 48px 行高上一致"，而那句话来自一份自称归纳了**五家**的第三方文档（它还多算了 UUPM
app-interface），我**一家都没核**。后来真去查：其中一项连仓库都不存在。

| 等级 | 含义 | 怎么用 |
|---|---|---|
| **A · 源码核实** | 我读过上游源码里那一行 | 可以直接照做 |
| **B · 一手文档** | 权威方自己写的规范/教材 | 可以照做，留意版本 |
| **C · 二手归纳** | 别人转述多家系统 | **只当起点**，用前自己核一遍 |
| **D · 故障证据** | 某个项目的 issue/PR 里发生过 | 现象可信；**普适性要单独判断** |

**D 类（故障证据）的 stars 普遍不高** —— 本页从 **0★**（`svelte-datatable`）到 **18.3k★**
（`hermes-webui`）都有。**stars 低不降低它的价值**：一条 issue 只要现象可复现就是硬证据。
但它改变了措辞 —— 不是"很多人踩过"，而是"某个几乎无人使用的项目踩过"。**两类来源判据不同**：

- **规范 / 实现参考** → **stars + fork 与否 + 最近提交**，衡量**可信度**
  （Ant Design 99.5k★、MUI 99.0k★、Fluent 20.3k★、Primer 13.0k★、Carbon 9.5k★、
  Polaris 6.2k★ 属此列；**fork 要追溯到父仓** —— 本页曾误把一个 0★ fork 列进"3k 以上"）
- **故障证据** → **不设 stars 门槛**，改问"这是浏览器/平台原理，还是该项目的特殊性？"
  （"未做 `devicePixelRatio` 缩放会模糊"是原理，普适；"Safari 快滚时粘性表头抖 1–2px"
  是 WebKit 怪癖，不普适）

**参照标准节里的五类来源，对应到这里的四级**：

| 参照标准里的类型 | 对应等级 | 判据 |
|---|---|---|
| 标准原文（W3C ARIA / WCAG / APG） | **B** | 权威性；**stars 无关**（WCAG 仅 1.5k★ 也是标准） |
| 设计系统 | **A**（能读源码时）/ **B** | stars + 最近提交 |
| 教材 / 实践者 | **B** | 作者声誉 + stars |
| 二手归纳 | **C** | 只当起点 |
| 故障证据 | **D** | 普适性单独判断 |

---

## 表格

**D 级 · 故障证据**。**D 类不设 stars 门槛** —— 看的是现象是否可复现、是否普适，
不是仓库有多少 star（下表里从 0 到 18.3k 都有，判断依据和 star 无关）。

| 出处 | stars | 症状 | 根因 | 规则 |
|---|---|---|---|---|
| [`srelens/srelens` #298](https://github.com/srelens/srelens/issues/298) | 167 | 滚动时列宽左右跳；**手动拖过一次列宽后永久消失** | `table-layout: auto` + 虚拟滚动，宽度按当前渲染的行推导 | §1 |
| [`nesquena/hermes-webui` #5672](https://github.com/nesquena/hermes-webui/pull/5672) | 18.3k | 移动端滚动跳回；`scrollTop` 被 clamp 或重锚到远处行 | DOM 重建丢失 `content-visibility` 的尺寸记忆，退回写死的 `contain-intrinsic-size` | §1 |
| [`OctoPunkIO/svelte-datatable` #13](https://github.com/OctoPunkIO/svelte-datatable/issues/13) | **0** | Safari 17 上虚拟滚动 + 粘性表头快滚时抖 1–2px | WebKit 怪癖，Chrome / Firefox 正常 —— **不普适，别当通则** | §1 |
| [`AvaloniaUI/Avalonia` #21788](https://github.com/AvaloniaUI/Avalonia/issues/21788) | **31.5k** | 宽表横向滚动时看不到行标识 | 表头固定了列的含义，**行的身份没人管** | §1 |
| [`elettro/stashbox` #399](https://github.com/elettro/stashbox/pull/399) | 1 | 要求冻结 Song Analytics 的首列 | 同上 | §1 |
| [`pablogranate/basket` #47](https://github.com/pablogranate/basket/issues/47) | **0** | 要求把两列冻结成 pinned left block | 同上 | §1 |
| [`mateuszwu/football_app` #229](https://github.com/mateuszwu/football_app/issues/229) | **0** | 横向内容被藏住 → 统计表不可用 | 同上 | §1 |
| [`HarperFast/studio` #1692](https://github.com/HarperFast/studio/pull/1692) | 5 | 把宽表的横向滚动**关在表格自己里面**（已关闭 = 已修） | 同上 | §1 |

> **最后五行是一组很好的 D 类样本**：stars 从 **0 到 31.5k** 都有。
> 一个主流 UI 框架把它做成了一等 API（`FrozenColumnCount`），四个小项目各自撞上同一个问题 ——
> **五条独立记录描述同一个现象，这才是"普适"的依据，不是任何一条的 star 数。**
> 反过来，如果只有 Avalonia 一条，那可能只是框架设计者的偏好。

**C 级 · 二手归纳（用前自己核）** ——
[Table (Data Table / Data Grid) — Benchmark Spec](https://cdn.jsdelivr.net/npm/@hegemonart/get-design-done@1.60.1/reference/components/table.md)：
**一个 npm 包里的 markdown，没有 stars 可查**（所以它过不了"可信度"这道门槛）。它**自称**
从 **Carbon DataTable、Polaris DataTable、Atlassian DynamicTable、Ant Design Table、UUPM
app-interface** 五个系统归纳。§2 尺寸表的**起点**来自它。

**核实结果（2026-09-13 查源码）**：Carbon 的表头是 `block-size: $spacing-09`、单元格是
`padding-block: $spacing-05`，且**分多档 header size** —— 注意**48px 是按 Carbon 的 spacing
体系推断的**（`$spacing-09` 的实际值定义在构建产物 `packages/layout/scss/generated/` 里，
那个目录不在仓库中，**我没有从源码确认它等于 48px**）；Ant Design 是
**三档**（`cellPaddingBlock` / `…MD` / `…SM`，注释写明 *"large size by default"*），
**根本没有"默认 48px"**；**"Atlassian"那一项，`atlassian/design-system` 仓库不存在**。
所以它那句"五家一致"**不能当结论用**，只能当一个待核实的线索。

它的**写法**仍值得学：每条断言附来源，每个违规给可 grep 的检测命令，每个反例说明
**为什么失败**和**怎么修** —— 这个 skill 的自检命令就是照它学的。

**实现参考** —— [`openstatusHQ/data-table-filters`](https://github.com/openstatusHQ/data-table-filters)
（2252★ · MIT · TypeScript）：shadcn/ui + TanStack Table。看它的 issue/PR 记录比读代码更快，
例如 [`Refactor/shadcn neutral oklch theme`](https://github.com/openstatusHQ/data-table-filters/issues/102)。

---

## 图表

**D 级 · 故障证据**（同上，不设 stars 门槛）。下面几条标了「普适 / 不普适」——
那是 D 类**真正要判断的东西**：这个现象是平台原理，还是那个项目的特殊性。

| 出处 | stars | 症状 | 根因 | 规则 |
|---|---|---|---|---|
| [`Selftend/selftend` #2347](https://github.com/Selftend/selftend/issues/2347) · [#2346](https://github.com/Selftend/selftend/issues/2346) | **1** | 图表/组件**未预留空间**导致布局偏移 | 高度由内容决定 | §5 |
| [`Selftend/selftend` #2341](https://github.com/Selftend/selftend/issues/2341) | **1** | 布局偏移是否该进 CI、能断言什么 | **CLS 可测量**，可作验收门槛 | §5 |
| [`BenjaminSRussell/cozy-game` #58](https://github.com/BenjaminSRussell/cozy-game/issues/58) | **0** | Retina 上 canvas 模糊 | 未做 `devicePixelRatio` 缩放 —— **原理问题，普适** | §5 |
| [`askrjs/askr-charts` #30](https://github.com/askrjs/askr-charts/issues/30) | **1** | 默认分类色里有一对**相邻的红/绿** | 红绿色盲无法区分 —— **普适** | §11 |
| [`crzyc98/planwise_navigator` #497](https://github.com/crzyc98/planwise_navigator/issues/497) | **0** | 调色板**未通过色觉审计**，最后维护两套 | 同上 | §11 |

**规范（正确性）** —— 等级 B，**stars 只作参考**：标准原文和官方规范的 star 往往不高，
因为它们不是给人 star 的项目。

- [Carbon — Axes and labels](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/data-visualization/axes-and-labels/index.mdx)
  （**Carbon 本体 9.5k★**）—— Y 轴基线判据：柱状/面积必须从 0，折线/散点不必。
- [Carbon Charts](https://github.com/carbon-design-system/carbon-charts)（1.0k★，IBM，D3 + TypeScript）
  —— 明确区分**分类色 / 顺序色 / 发散色**三种用途；**用错类型比选错颜色更糟**。
- [WAI-ARIA APG — Grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)（**标准原文**）——
  表格键盘契约（`role="grid"` 的方向键导航）出自这里。
- [W3C ARIA](https://github.com/w3c/aria)（**752★**）· [WCAG](https://github.com/w3c/wcag)（**1.5k★**）
  —— **判据用权威性，与 stars 无关**。
- [GoogleChrome/web-vitals](https://github.com/GoogleChrome/web-vitals)（**8.6k★**）——
  CLS 的定义与阈值。**§5 把"CLS 接近 0"当验收门槛，应引这里（一手文档），而不是某条 issue。**

**设计系统**（等级 A/B，**stars + 最近提交 + 非 fork** 衡量可信度）：

- [Ant Design](https://github.com/ant-design/ant-design) **99.5k★** · [MUI](https://github.com/mui/material-ui) **99.0k★**
- [Fluent UI](https://github.com/microsoft/fluentui) **20.3k★** · [Primer](https://github.com/primer/css) **13.0k★**
- [Carbon](https://github.com/carbon-design-system/carbon) **9.5k★** · [Polaris](https://github.com/Shopify/polaris) **6.2k★**
- 实现参考：[TanStack Table](https://github.com/TanStack/table) **28.4k★** · [d3](https://github.com/d3/d3) **113.7k★**

> **已移除的一条（自纠，写在这里因为它正是本页等级表要防的错误）**：
> 原先此处列了 `LMK89/Machine-Learning-MD`，称它覆盖"尺度选择与截断的后果"。
> 实测 **0★ 且是 fork**（父仓 `xbeat/Machine-Learning` 只有 626★）—— 却被我列进了
> "都在 3k 以上"。该主题现由 Carbon 与 Datawrapper 覆盖。

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

## 页面级状态

**B 级 · 一手规范** —— 无障碍部分出自 [W3C WCAG](https://github.com/w3c/wcag) 的 SC 源文件
（`guidelines/sc/20/*.html`、`guidelines/sc/21/*.html`）。**原文逐字摘录，不是转述**：

| SC | 等级 | 原文（截取） |
|---|---|---|
| **4.1.3** Status Messages | AA | status messages can be **programmatically determined through role or properties** such that they can be presented to the user by assistive technologies **without receiving focus** |
| **3.3.1** Error Identification | **A** | the item that is in error is identified and the error is **described to the user in text** |
| **3.3.3** Error Suggestion | AA | if suggestions for correction are known, then the suggestions are provided to the user |
| **3.3.2** Labels or Instructions | **A** | Labels or instructions are provided when content requires user input |
| **3.2.2** On Input | **A** | Changing the setting of any user interface component does not automatically cause a change of context |

> **一个边界**：4.1.3 要求"用 role 或属性让状态可被程序化识别"，
> 而 `role="status"` / `aria-live="polite"` / `aria-busy="true"` 是**WAI-ARIA 的具体机制**。
> SC 原文没有点名这三个名字 —— 所以"用它们"是**实现选择**，不是规范的字面要求。
> 别把机制当成规范原文引用。

**B 级 · 一手规范（续）—— 进度指示**：

| 来源 | 原文（截取） |
|---|---|
| WCAG 2.1 [Understanding SC 4.1.3](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html)（`w3c/wcag` 的 `understanding/21/status-messages.html`） | a status message … provides information to the user on the success or results of an action, **on the waiting state of an application, on the progress of a process**, or on the existence of errors —— 例子里有 *"a dynamic progress bar to indicate the status of an upgrade"* |
| WAI-ARIA [`progressbar`](https://github.com/w3c/aria)（`w3c/aria` 的 `index.html`） | **displays the progress status for tasks that take a long time** … Authors MAY set `aria-valuemin` and `aria-valuemax` to indicate the minimum and maximum progress indicator values |

> **等级要分两半说，别混。**
> **B 级（规范要求）**：4.1.3 把"一个过程的**进度**"算作状态消息，WAI-ARIA 给了它
> 对应的角色与取值属性 —— 所以**进度指示是状态消息的一种，不是"可选的好看"**。
> **③ 经验默认值（不是规范要求）**：**"知道总量就别只转圈"**。
> 4.1.3 只要求可被程序化识别，**没有任何一条 SC 要求"可测量时必须用确定进度"**。
> 把它写成规范要求，就是又一次"给经验编一个出处"。

**怎么判断"可不可测"**（这是**定义**，不需要出处 —— 它由"总量是否已知"直接决定）：

- 遍历一个已知长度的集合（导入 N 行里的第 k 行）→ 可测量；
- 等待一个没有长度概念的操作（一次可能慢也可能快的请求）→ **不可测量**。
- **不可测量时画百分比，就是在编** —— 进度条会冲到一个数然后长时间不动，甚至往回跳。

> 判断"可不可测"看的是**知不知道总量**，不是"这个操作久不久"。久但没总量，
> 依然该用不确定态；短但有总量，依然该给数字。
>
> **注意轴不要混**：本文件的 `A/B/C/D` 是**证据等级**，而主文件里的 `①②③` 是
> **"数字分三种"**（有出处 / 平台常量 / 经验默认值）。一个讲"这条有多可信"，
> 一个讲"这条是哪一类"。上一条标了 ③，那是三分法；它同时是 B 级，那是等级法。

**③ 经验默认值（无规范可引）—— 播报节流**：

- **故障**：一个 19 批的导入，每批都往 live region 写一次，读屏会**排队播报 19 次**；
  等它念完，真正要听的信息已经被淹掉了。**视觉上完全正常**，只有用读屏才发现。
- **判据**：播报频率对齐**阶段**（4 次），不对齐**数据变化**（19 次）。
- **为什么这条没有出处**：WCAG 4.1.3 只要求状态消息**可被程序化识别**，一个字都没提频率。
  把它写成"引 4.1.3"，就是又一次**给经验编出处**。
- 唯一算机制性依据的是：`aria-live="polite"` 的语义是**排队**而非打断，写入越频繁、队列越长。

**D 级 · 故障证据** —— 过期异步响应覆盖更新的那一次。**四条同形状的公开记录**：

| 仓库 | 现象 |
|---|---|
| [`juspay/xyne-spaces` #677](https://github.com/juspay/xyne-spaces/pull/677) | 搜索的 **stale / out-of-order** 响应竞态，导致黑屏 |
| [`alexander-bain/bainluck` #1469](https://github.com/alexander-bain/bainluck/issues/1469) | typeahead 的 stale-response 与取消竞态加固 |
| [`traceroot-ai/traceroot` #1802](https://github.com/traceroot-ai/traceroot/pull/1802) | 防止过期的会话历史覆盖当前会话 |
| [`SiLioLabs/PayFlow` #870](https://github.com/SiLioLabs/PayFlow/issues/870) | 把 empty / error 做成 **race-safe** |

> **D 级的 stars 普遍很低，这不降低它们的价值**：四家独立地把同一个竞态当成缺陷来修，
> 说明**这不是某个项目的特殊性，而是一个通用故障形状**。
> 判断依据是"四个独立来源描述同一现象"，不是"某个来源有多少 star"。

**③ 经验默认值**（**没有权威可引，明说是经验**）：

- **表单值跨刷新保留**（`sessionStorage` 一类）—— 产品决定；
- **提交中禁用按钮 + 改文案** —— 产品决定。注意它与 3.2.2 不冲突：禁用是控件状态，不是上下文变化。

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
| **§14 的范本自己违反了 §14**：`query-console.html` 在 `finally` 里调 `setBusy(false)`，把刚写好的"查询失败"抹成空串，`role="status"` 于是永远没内容 | **"设置了"和"留到了"是两件事**。live region 的内容不能在收尾逻辑里被清空 —— 否则那条 WCAG 4.1.3 的规则在实现上是空的。**这是写规则的那一轮埋下的，隔一轮才被检查器抓到** |
| 竞态检查用 `#go.click()` 发第二次提交，而提交中该按钮是 `disabled` —— **disabled 按钮的 `click()` 是空操作** | **断言测的是"按钮被禁用"，不是"竞态被防住"**。拿掉 `AbortController` 之后它依然全绿。改成直接派发 `submit` 事件才真的造成重叠。**变异测试是唯一能让这种断言现形的办法** |
| 同一次竞态检查里还留着一条与它重复的旧断言，名字写的是"最终结果是宽条件那次的" | 清理时漏删。**它和另一条同真同假**，等于多了一条不会独立失败的断言。互补的一对应当是：坏掉 A → 只有 ① 红；坏掉 B → 只有 ② 红。**做不到就说明两条在测同一件事** |
| `min-width` 探针第一版用了 60 字符（约 432px），而 `1fr` 分到 438px —— **内容没宽过容器**，`min-width: auto` 根本没机会生效，四种情形测出来一模一样 | **"测了但没测到触发条件"和"没测"一样危险**：它给你一个"已验证"的错觉。**做反例时先确认反例真的会失败** —— 后来把内容加宽到约 120 字符，对照组当场差出 408px |
| §14 的检查器**在出厂摆放里根本跑不起来**：`load()` 的 URL 硬编码成 `/index.html`，而 `QC_PAGE` 只决定 patch 哪个文件 —— 于是它 patch `query-console.html` 却去加载 `index.html` | **我"验证通过"的那次，是在临时目录里把页面改名成 `index.html` 之后跑的。**换句话说，**验证用的配置不是会被交付的那个配置**，而这个差异恰好把缺陷盖住了。改成用同一个 `PAGE` 拼 URL 之后，才第一次在真实出厂摆放（目录里只有 `query-console.html`）里跑通。**验证必须在交付的那个配置里做；"为了跑通先改一下环境"是最贵的省事。** |
| **两个互不相干的人，写出了同一类不可能失败的竞态断言。** 我这边：用 `#go.click()` 发第二次提交，而提交中该按钮是 `disabled`，`click()` 是空操作。子代理那边：快慢顺序写反 + 判据窗口只有 260ms | **这不是巧合，是这类断言的结构性陷阱**：竞态测试的"通过"和"什么都没发生"长得一模一样。**两边都是靠变异测试才发现的。** 所以竞态断言必须先回答一句：**"如果那个保护被拿掉，我会看到什么不同？"** 答不上来，它就没在测竞态。 |
| **施工路径从来没提到 §2 §7 §13 §14** —— 它们只能靠通读全文找到。§13/§14 是后加的，加的那一轮没有回头看路径 | **导航可达性是可验证的属性**：照着"第 1 步 → 第 8 步"走完，如果某一节**始终没被要求读过**，那一节等于不存在 —— 写得再对也不会被用上。已固化为检查器的第 7 项；拿上一个提交回放，它当场报出这四节。**新增一节，必须同时把它挂到某一步上。** |
| 同一次检查里我先说不可达的是 **§0** §2 §7 §13 §14，后来才去逐个核对 —— 而 §0 **一直都在第 1 步的问题表里** | **不要从抽样推广**：我只量了 §13/§14，却把结论说成了 5 节。基于这个错数，我还在第 2 步加了一句与第 1 步重复的话，事后已撤。**先量全再下结论；说"我检查过了"时必须说得清检查的边界。** |
| 检查器把 `meta/environment.md` §12 判成"悬空的内部节号"（文件名被反引号包着，正则只允许中间是空白） | **检查器报 FAIL 时，第一个假设应该是"检查器错了"**，然后手工去核实那个所谓的缺陷（这里 `environment.md` 的 §12 确实存在，引用是对的）。这是同一个检查器的第 4 次误报，四次同一个毛病：**靠字面匹配去认语义**。跨文件引用现在被列为"未校验"，而不是静默放过或假报失败。 |
| **§13 引用「§9 的长标签截断 + `title`」，而 §9 里根本没有这条规则** —— 它只是「类别爆炸」那一行表格里的一句半话（讲的是图表类别标签），真正的写法（`overflow` / `nowrap` / `ellipsis`）**散在四个参考实现里**，正文从没把它立成规则 | **检查器只验"§9 存在"，不验"§9 真讲了这件事"** —— 交叉引用可以全部解析成功、却指向一段不存在的内容。这是继"冻结首列"之后**第二次**发现"规则只活在范本里"。**"引用能解析"和"引用有内容"是两件事。** |
| 我在给施工路径挂 §号时，把「列宽显式」挂到了 **§2** —— 而 §2 全节没有一处讲列宽（它讲的是简洁、行高/内边距/字号、对齐、色彩、无障碍），列宽在 **§1** | **挂 §号时不能凭小节标题猜**：「简洁与尺寸」听起来像包含列宽，实际不含。**这是我自己在"修导航"那一轮引入的错误** —— 修一个缺陷时引入另一个，所以修完必须回头复核**每一个新加的指针分别指向什么**。 |
| 描述里写着 **sparklines / 迷你图**，而正文、`references/`、以及 6 个渲染器里**一处都没有**（全库搜"迷你图\|sparkline"，唯一命中就是描述自己那行） | **描述是触发条件，不是愿望清单。** 这条是"把描述里每句'我能处理 X'抽出来、逐个去正文找对应的节"那条判据**第一次被真正执行**时抓到的 —— 它写在知识库里放了好几轮，**执行一次就有一条违规**。**写下来的判据不执行，等于没有。** 已删掉"迷你图 / sparklines"两处。 |
| 我在 §13 新写的"反例 2"里，把 `min-width: auto` 当成了"盒子宽度由内容决定"的例子 —— 而**同一次编辑里我刚引进去的一手规范**说：`overflow` 是 `hidden` 时自动最小值**变成 0**，那个情形下省略号**是会出现**的。写反了，复核时才发现 | **规范原文和它的推论可以出现在同一段文字里，而推论仍然是反的。** 我手里有原文，还是写错了 —— 可见**"引了原文"不产生"我理解了"**。复核的办法是：把规则里每一个条件代回规范原句，看能不能对上。 |

**B 级 · 一手规范** —— §13 的机制出自 W3C CSS 工作组的源仓库
[`w3c/csswg-drafts`](https://github.com/w3c/csswg-drafts)（原文，非转述）：

| 文件 | 原文（截取） |
|---|---|
| [`css-grid-1/Overview.bs`](https://github.com/w3c/csswg-drafts/blob/main/css-grid-1/Overview.bs) | the used value of its **automatic minimum size** in a given axis is the **content-based minimum size** if all of the following are true: its computed value `overflow` is **not** a scrollable overflow value |
| [`css-flexbox-1/Overview.bs`](https://github.com/w3c/csswg-drafts/blob/main/css-flexbox-1/Overview.bs) | *Automatic Minimum Size of Flex Items* —— `min-width/auto` … **is the new initial value** of the `min-width` and `min-height` properties |

> **条件挂在 `overflow` 上，这一点值得单独记住**：默认的 `overflow: visible` 下自动最小值是
> 内容的 `min-content`；一旦 `overflow` 不是 `visible`，规范说自动最小值**变成 0**。
> 所以 `min-width: 0` 与 `overflow: hidden` **不是两种方案，是同一个机制的两条路径** ——
> 实测三者（`min-width:0` / `overflow:hidden` / `overflow:auto`）的 track 宽度**完全相同**。

**B 级 · 一手规范（续）—— 截断**：`text-overflow` 的定义在
[`css-overflow-3/Overview.bs`](https://github.com/w3c/csswg-drafts/blob/main/css-overflow-3/Overview.bs)
（规范自己注明它 reproduces the definition of the `text-overflow` property previously defined in
`[[CSS-UI-3]]`, with no addition or modification）：

| 项目 | 原文 |
|---|---|
| 属性定义 | `Name: text-overflow` / `Value: clip \| ellipsis` / `Initial: clip` / `Applies to: block containers` / `Inherited: no` |
| **生效前提** | This property specifies rendering when inline content **overflows its end line box edge** in the inline progression direction of its block container element ("the block") **that has `overflow` other than `visible`**. |
| 溢出的成因 | Text can overflow for example when it is prevented from wrapping (e.g. due to `white-space: nowrap` or a single word is too long to fit). |
| 示例都给了宽度 | 规范的每个示例都显式写了宽度（`width: 9ch`、`width: 3.1em`、`width: 15em`） |

> **"盒子要有确定宽度"不是规范里的一句独立要求，而是"溢出"这个前提的必然结果** ——
> 盒子宽度由内容决定时，内容没有溢出可言。**这是本条里唯一属于推读的部分**；
> 其余两条（`overflow` 必须不是 `visible`、`nowrap` 是溢出的成因）都是规范原句。

**结论**：**断言必须能被证伪**——先确认它在坏的实现上真的会变红。
这条比任何一条图表规则都更常救场。

> **补一条量化**：上面第 3 条那对竞态断言，是在**变异测试跑出"25/25 全绿"之后**才被发现的。
> 也就是说，**检查器报全绿的那一次，恰恰是最不可信的一次。**
