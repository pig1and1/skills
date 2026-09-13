# skills

模型可加载的技能集合。每个子目录是一个独立技能：`SKILL.md` 是技能定义（含
`name` 与 `description` 元数据），`references/` 里的文件按需加载。

技能是纯 Markdown + 参考文件，没有任何构建步骤，也不绑定特定 harness。

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

| 文件 | 内容 |
|---|---|
| `table.css` | 样式基线，每段注明它防的是哪个故障，含深浅主题 token |
| `VirtualTable.tsx` | React 固定行高虚拟表格骨架，无第三方依赖 |
| `LineChart.ts` | Canvas 折线图骨架：DPR 正确、容器预留空间、resize 节流 |
| `verify.html` | 自验证页面：滚动前后列宽快照、数字列宽度波动、`content-visibility` 塌陷复现，全部读数值并自动判定 |
| `dashboard.html` | 复杂示例：brush 选择驱动多视图联动、hover 十字准线、序列切换、加载/空态、5000 行虚拟表格与图表共享同一处过滤状态 |
| `dirty-data-cases.html` | 脏数据对跑：9 个病态数据集（全同值、单点、空集、脏值、乱序、时间缺口、离群、类别爆炸、5 万点），朴素实现 vs 加固实现，逐例给出诊断数值 |
| `stacked-bars-average-line.html` | 复合图表：三段堆叠柱 + 同量纲平均折线共用从 0 起的轴；点击选中并保持（区别于悬停）、整柱命中区、图例切换、表行联动 |
| `visual-quality.md` | 手艺层：同一份数据怎么画才不业余 —— 网格与轴的层次、颜色数量、标签密度、空态、强调色只留给"要说的那件事" |
| `chart-correctness.md` | 正确性判据：轴是否从 0、对数轴何时用、双轴为什么撒谎、截断轴的代价、聚合口径（"平均"≠"求和"） |
| `dirty-data.md` | 脏数据处理对照：空洞、脏值、重复时间戳、乱序、恒定段、尖峰、极端量级、恶意标签，每类的显示后果与处置 |
| `composite-charts.md` | 复合图表：多量纲该拆图而不是加第二根轴；堆叠柱 + 折线的同量纲前提与命中区设计 |
| `evidence.md` | 每条规则的公开来源，以及**验证过程本身**的 7 个失误记录（自查脚本比被查对象更常出错） |

## 这些规则从哪来

不是凭空写的。每条稳定性与正确性规则都对应一个**公开的故障记录**，
`SKILL.md` 第 9 节列出了出处，包括：

- `srelens/srelens` #298 —— 虚拟滚动下 `table-layout: auto` 导致列宽漂移
- `nesquena/hermes-webui` #5672 —— DOM 重建丢失 `content-visibility` 的尺寸记忆，
  导致 `scrollHeight` 塌陷与滚动跳回
- `Selftend/selftend` #2347 / #2341 —— 图表未预留空间造成布局偏移；CLS 可作验收门槛
- `BenjaminSRussell/cozy-game` #58 —— Retina 上 canvas 模糊
- Carbon 设计系统 —— Y 轴基线判据

参考实现是**起点而非成品**，未经真实项目运行验证；用之前按自己的列宽、行高与
配色改一遍。

## 其它

### `charts/`

`frontend-tables-and-charts` 技能的可运行参考实现：无依赖 SVG 图表。

```
charts/
├─ src/core.js          纯计算（比例尺/刻度/堆叠/分箱/四分位/色阶/缺口检测/降采样），不碰 DOM
├─ src/line.js          bar.js       scatter.js
├─ src/histogram.js     boxplot.js   heatmap.js    渲染层：只把 core 算出的数字放进 SVG
├─ src/theme.css        主题层：组件不认识颜色，只引用 token
├─ tests/               10 个测试文件、253 个断言（node --test，零依赖）
├─ example.html         90 行脚本调用组件
├─ complex-test.html    浏览器端自检页：把同一批脏数据渲染出来并显示实际读数
└─ serve.js             零依赖静态服务器（模块化脚本不能走 file://）
```

```sh
cd charts
node --test      # 跑测试
node serve.js    # 打开 http://127.0.0.1:4173/example.html
```

**为什么这样分层**：一个图表的数学如果长在渲染函数里，就只能靠看像素来检查 ——
也就是永远不会被检查。分开之后 `core.js` 可以用脏数据直接单测。写它的过程中，
测试抓出了两个真 bug（刻度阶梯取错导致轴塌成 3 格；直方图总数把域外值算了进去）。

**已知局限**：渲染层的像素位置、CSS 层叠与 DPR 没有回归保护；没有类型与发布流程。
`tests/tokens.test.js` 专门盯着"引用了未声明 token"这类**不报错的静默失败**。

## 用法

把想要的技能目录放进你的 harness 的技能根目录即可。以 DSH 为例：

```
<dshHome>/skills/frontend-tables-and-charts/
```

harness 会读取每个技能的 `description` 到模型可见的目录里，正文在需要时才加载。
