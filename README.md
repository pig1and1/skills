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

## 用法

把想要的技能目录放进你的 harness 的技能根目录即可。以 DSH 为例：

```
<dshHome>/skills/frontend-tables-and-charts/
```

harness 会读取每个技能的 `description` 到模型可见的目录里，正文在需要时才加载。
