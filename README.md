# skills

模型可加载的技能集合。每个子目录是一个独立技能：`SKILL.md` 是技能定义（含
`name` 与 `description` 元数据），`references/` 里的文件按需加载。

技能本身是 Markdown + 参考文件，没有构建步骤，也不绑定特定 harness；
`references/` 里另有一批零依赖的 `*-check.mjs`（纯 ESM，用 CDP 驱动本机 Edge），
用来把参考实现**真跑一遍** —— 见下面的「怎么验证」。

## 包含的技能

### `github-operations`

用 GitHub 做检索与反馈的通用做法（平台与 harness 无关）：

- **检索优先**：先假设别人已经遇到并讨论过。用**锚点**而不是整句报错 ——
  两个技术专有名词是甜点；加 `is:closed` 既减量又提质；整句报错 0 命中不代表方法错
- **知识分层**：源码给"实现"，Issues/Discussions 给"坑图谱"，
  PR review 给"决策档案" —— 后两者文档里没有
- **反馈渠道**：先读 `CONTRIBUTING`，不少项目不收外部 PR；不收时用
  fork + commit 链接，而不是提一个不会被看的 PR
- **非交互纪律**：`GIT_TERMINAL_PROMPT=0`，别让凭据提示挂死无人值守会话
- **两个陷阱**：GraphQL 与 REST 的返回层级不同；`git push` 可能成功却以非零码退出
- 含可直接复制的 `curl` + `jq` 检索命令

### `frontend-tables-and-charts`

前端表格与图表：好看、简洁、稳定、快。

**表格**

- 先按行数定方案（≤100 普通渲染；100–1k 固定行高虚拟滚动；1k–1w 加服务端分页）
- 稳定性清单：`table-layout: fixed` + 显式列宽（防列宽漂移）、`tabular-nums`
  （防数字列宽度跳动）、`scrollbar-gutter: stable`（防滚动条出现时抖动）、
  粘性表头不透明、`content-visibility` 与虚拟滚动互斥
- 两条诊断捷径：手动拖列宽后不再抖 → 病根是 `table-layout: auto`

**图表**

- 先问图表回答什么问题：表格给精确值，图表给形状
- Y 轴基线判据：**柱状/面积必须从 0**（面积代表数量），**折线/散点不必从 0**
  （只代表位置，强行从 0 会压平波动）
- 稳定性：容器**预留空间**（布局偏移 CLS 可测量，应接近 0）、
  canvas 必须乘 `devicePixelRatio`、`ResizeObserver` 节流
- 误导清单：双 Y 轴、3D、超 5 类饼图、叠加面积图、超 8 种分类色
- 技术选型按**数据点数量**分界：≤1–2k 用内联 SVG，更多用 Canvas

**参考实现**（`frontend-tables-and-charts/references/`）

⚠️ **完整清单不在这里抄一份。** 它在 `SKILL.md` 的「参考实现」一节，而
`tools/check-skills.mjs` 会核对那份清单与目录是否一致（引用了不存在的文件、
存在却没被索引的文件，都会报红）。本 README 只说它大致怎么分层：

- **代码骨架** —— `table.css`（样式基线，每段注明它防的是哪个故障，含深浅主题 token）、
  `VirtualTable.tsx`（React 固定行高虚拟表格，无第三方依赖）、
  `LineChart.ts`（Canvas 折线图：DPR 正确、容器预留空间、resize 节流，**两条轴都有标签**）
- **专题说明**（判据与依据，动手前先读）—— `visual-quality.md`、`chart-correctness.md`、
  `dirty-data.md`、`composite-charts.md`、`evidence.md`（每条规则的公开来源，
  **以及验证过程本身的失误记录**）
- **成品示例**（是答案不是读本）—— `dashboard.html`（brush 联动、十字准线、5000 行虚拟表格
  与图表共享过滤状态）、`dirty-data-cases.html`（9 个病态数据集对跑，朴素实现 vs 加固实现）、
  `stacked-bars-average-line.html`、`query-console.html`，以及两个 `*-probe.html`
- **可执行检查** —— `reference-smoke.mjs`（把每个 HTML 真跑一遍，只断言"没有未捕获异常"）、
  各 `*-check.mjs`，以及一次跑完所有的 `run-all-checks.mjs`

> **为什么这里不抄一份完整清单**：抄一份就会有两份，而两份迟早不一致 ——
> 这个 README 原先就漏掉了 **10 个**参考文件，还把「踩过的坑」表的行数写成 **7**（实际 **36**）。
> **同一件事写两遍，第二遍一定和第一遍不一样。**

## 这些规则从哪来

不是凭空写的。每条稳定性与正确性规则都对应一个**公开的故障记录**，
出处记在 `SKILL.md` 的「**参照标准**」一节与 `references/evidence.md`（含 A/B/C/D 证据等级），包括：

- `srelens/srelens` #298 —— 虚拟滚动下 `table-layout: auto` 导致列宽漂移
- `nesquena/hermes-webui` #5672 —— DOM 重建丢失 `content-visibility` 的尺寸记忆，
  导致 `scrollHeight` 塌陷与滚动跳回
- `Selftend/selftend` #2347 / #2341 —— 图表未预留空间造成布局偏移；CLS 可作验收门槛
- `BenjaminSRussell/cozy-game` #58 —— Retina 上 canvas 模糊
- Carbon 设计系统 —— Y 轴基线判据

参考实现是**起点而非成品**，未经真实项目运行验证；用之前按自己的列宽、行高与
配色改一遍。它们现在有**可执行的检查**（见「怎么验证」），但那些检查只保证
"页面是活的、声称的动作真的会发生"，**不保证它适合你的场景**。

## 其它

### `charts/`

`frontend-tables-and-charts` 技能的可运行参考实现：无依赖 SVG 图表。

```
charts/
├─ src/core.js          纯计算（比例尺/刻度/堆叠/分箱/四分位/色阶/缺口检测/降采样），不碰 DOM
├─ src/line.js          bar.js       scatter.js
├─ src/histogram.js     boxplot.js   heatmap.js    渲染层：只把 core 算出的数字放进 SVG
├─ src/theme.css        主题层：组件不认识颜色，只引用 token
├─ tests/               11 个测试文件、264 条断言（node --test，零依赖）
├─ example.html         90 行脚本调用组件
├─ complex-test.html    浏览器端自检页：把同一批脏数据渲染出来并显示实际读数
├─ renderers.html       六个渲染器的并排总览（browser-check 就是打开它）
├─ showcase.html        更完整的演示页
├─ browser-check.mjs    浏览器检查：74 项，CDP 驱动 headless Edge
└─ serve.js             零依赖静态服务器（模块化脚本不能走 file://）
```

```sh
cd charts
node --test              # 264 条断言
node serve.js            # 起服务：http://127.0.0.1:4173/renderers.html
node browser-check.mjs   # 74 项浏览器检查（需要上面的服务在跑）
```

**为什么这样分层**：一个图表的数学如果长在渲染函数里，就只能靠看像素来检查 ——
也就是永远不会被检查。分开之后 `core.js` 可以用脏数据直接单测。写它的过程中，
测试抓出了两个真 bug（刻度阶梯取错导致轴塌成 3 格；直方图总数把域外值算了进去）。

**已知局限**：渲染层的像素位置、CSS 层叠与 DPR 没有回归保护；没有类型与发布流程。
`tests/tokens.test.js` 专门盯着"引用了未声明 token"这类**不报错的静默失败**。

## 怎么验证

两层，都是零依赖的（除了要有本机 Edge）：

```sh
node tools/check-skills.mjs .        # 仓库级静态检查

cd frontend-tables-and-charts/references
node run-all-checks.mjs              # 把每个 HTML 与 TS 骨架真跑一遍
```

`check-skills.mjs` 查的是**文本的性质**：引用的文件是否存在、有没有文件存在却没被索引、
`§N` 交叉引用有没有落点、HTML 是否自包含、字号是否都在阶梯上、`description` 里的每项声称
在正文里有没有落点。

`run-all-checks.mjs` 查的是**行为**：页面加载有没有未捕获异常、canvas 上有没有真的画出东西、
交互是否按声称工作。它按**三种**结果归类 —— 通过 / 失败 / **未校验**
（例如机器上没有 `tsc` 时，TS 骨架那一条就是未校验）。**它不把「未校验」算成通过。**

> **为什么两层都要**：静态检查全绿**不代表页面是活的**。这个项目里出现过
> 一个"推荐为复杂示例"的页面**加载即抛异常、三个图表一个都没画**，而当时所有静态检查都通过；
> 也出现过工具页**打印"漂移是预期结果"、而它自己刚量到零漂移**。
> 这两种都只有真跑一遍才看得见。

## 用法

把想要的技能目录放进你的 harness 的技能根目录即可。以 DSH 为例：

```
<dshHome>/skills/frontend-tables-and-charts/
```

harness 会读取每个技能的 `description` 到模型可见的目录里，正文在需要时才加载。
