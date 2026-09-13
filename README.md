# skills

模型可加载的技能集合。每个子目录是一个独立技能：`SKILL.md` 是技能定义（含
`name` 与 `description` 元数据），`references/` 里的文件按需加载。

技能是纯 Markdown + 参考文件，没有任何构建步骤，也不绑定特定 harness。

## 包含的技能

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
