---
name: github-operations
description: Use when an agent needs to work with GitHub — searching all public repositories for prior art before solving a problem from scratch, reading or filing Discussions and Issues, handling repositories whose CONTRIBUTING forbids external pull requests, or scripting the REST/GraphQL API without hanging on an interactive credential prompt. 触发场景：用 GitHub 检索前人是否已解决同一问题、读写 Discussion / Issue、向上游反馈缺陷、用 API 批量检索或查询。
---

# GitHub 操作

平台与 harness 无关的通用做法。命令用 `curl` + `jq`，可换成任何 HTTP 客户端。

## 0. 先检索：别人大概率已经遇到

遇到"这个报错 / 这个行为是怎么回事"，**先假设公开仓库里已经有人讨论过**。
GitHub 的 Issues / Discussions / PR review 里存的是**判断**（为什么这样、为什么不那样），
而那正是文档不含的部分 —— 文档只写"是什么"。

### 用锚点，不要用句子

| 查询 | 命中 | 质量 |
|---|---|---|
| `"windowsHide" "SW_HIDE"` | 33 | 前面基本相关 |
| `is:closed "windowsHide" "SW_HIDE"` | 23 | **几乎全中，质量最高** |
| `"windowsHide" explorer` | 80 | 开始混入无关帖 |
| `"cannot create standard input pipe for remote-https"` | 0 | 环境特有，无人遇到 |

规律：

- **两个技术专有名词是甜点**。只给一个会被噪音淹没。
- 加 `is:closed` **既减量又提质** —— 被关闭意味着被解决了。
- **整句报错常常 0 命中，这不代表方法错**，只代表这个问题没有公开受众 ——
  越是环境特有的错误越如此。**换锚点，别放弃检索。**
- **代码搜索需要更强的锚点**：`windowsHide language:typescript` 有 75776 命中，等于没搜。
  必须加 `repo:` 或更多限定词。

### 语法速查

```
is:issue is:closed "锚点A" "锚点B"     closed = 已被解决，优先看
repo:owner/name "锚点"                 锁定你正在用的那个库
is:pr is:merged "锚点"                 找已经落地的修复
comments:>10 "锚点"                    讨论充分的才值得读
in:title "锚点"                        只在标题里找
created:>2024-01-01                    限定时间
```

### 找到一条之后：顺藤摸瓜

点它的 **linked PR**、看**谁引用了它** —— GitHub 的引用关系本身就是一张知识图谱。
一条相关 issue 往往能带出一整组。

## 1. 知识分层：先想清楚你要哪一种

| 你想要 | 去哪 | 性质 |
|---|---|---|
| 这个 API / 模式怎么写 | 源码、Code Search | **实现** |
| **别人踩过这个坑没有** | **Issues / Discussions** | **坑图谱** |
| **为什么这样设计、为什么不那样** | **PR 的 review、commit message** | **决策档案** |
| 官方说法 | README / docs / CHANGELOG | 权威，但有立场 |

**文档只记录"是什么"；第二、三列记录"为什么"** —— 那是别处拿不到的。

## 2. 用 API 检索：可直接复制的命令

```sh
# Issues 与 PR 全站全文搜索
curl -sS -G https://api.github.com/search/issues \
  -H "Accept: application/vnd.github+json" \
  ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
  --data-urlencode 'q=is:issue is:closed "windowsHide" "SW_HIDE"' \
  --data-urlencode 'per_page=10' \
| jq -r '.total_count as $t | "hits: \($t)", (.items[] | "\(.repository_url | sub(".*/repos/"; ""))  #\(.number)  \(.title)")'
```

```sh
# 代码搜索：看别人实际怎么用这个 API
# 需要 text-match 才会返回匹配片段
curl -sS -G https://api.github.com/search/code \
  -H "Accept: application/vnd.github.text-match+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  --data-urlencode 'q=windowsHide repo:owner/name' \
| jq -r '.items[] | "\(.repository.full_name)  \(.path)"'
```

**未认证的搜索限流很严，认证后宽得多**；`code` 搜索必须认证。

> 如果本机把 GitHub 域名指向了别处（hosts、DNS 或加速器），**网页抓取会失败而 API 仍可能通**。
> API 是更稳的那条路，不必依赖页面渲染。

## 3. 反馈：先读 CONTRIBUTING，别默认能提 PR

**不少活跃项目不接受外部 PR**。"提了再说"会浪费双方时间，也让补丁停在一个不会被看的
PR 里。动手前先读：

```sh
curl -sS https://raw.githubusercontent.com/OWNER/REPO/HEAD/CONTRIBUTING.md | head -40
```

典型措辞是 *"we cannot accept external pull requests at the moment"*，并指明官方渠道
（常见为 **Discussions**，有时明确排除 Issue）。

**当对方不收 PR 时，仍然有办法把补丁交出去**：

1. 在**自己的 fork** 上建分支、提交；
2. 在 Discussion 里给出 **commit 或 compare 链接**，对方点开就是完整 diff；
3. **不要**只往正文里贴一大段代码 —— 链接更可靠，也便于对方 `git am`。

## 4. 非交互纪律：别把无人值守的会话挂死

凭据提示一旦弹出 GUI，自动化就**静默挂住** —— 没有报错，只是停在那里。

```sh
export GIT_TERMINAL_PROMPT=0      # 需要凭据时直接失败，而不是等待输入
export GIT_ASKPASS=/bin/true      # 阻止任何交互式 askpass
```

- 用**令牌**，不要用密码或交互式登录；
- **不要把 `git credential fill` 放进管道**：结尾空行被吃掉时它会一直等 stdin；
- 令牌**只申请需要的 scope**（读写 Discussion 需要相应权限，删除仓库需要 `delete_repo`）；
- 提交前先做**本地检查**（凭据是否存在、helper 指向哪里）—— 这些不联网，任何环境都能跑，
  因而是最可靠的排查起点。

## 5. 输出纪律：只取需要的字段

一个 Discussion 的完整 JSON 常有 **5 KB**，几个就能挤爆上下文。**永远只提取需要的字段**：

```sh
jq -r '.number, .title, .state' <<<"$response"     # 好
echo "$response"                                    # 坏：不要把整个响应打进对话
```

在查询里就把字段写窄（GraphQL 尤其），不要拉回来再挑。写操作通常只需确认成功。

## 6. 两个容易误判的陷阱

### GraphQL 与 REST 的返回层级不同

GraphQL 返回 `{ "data": { … } }`，而不少客户端封装**已经剥掉了 `data` 层**：

```
$r.data.repository   ← 可能永远为空
$r.repository        ← 取决于你的封装
```

**先打印顶层键再往下取**，不要假设。

### 命令以非零退出码结束，但操作其实成功了

`git push` 把进度写 **stderr**；某些 shell 会把子进程 stderr 当作错误，于是整条命令
以非零码结束，看起来像失败。

**别只看退出码**，用一条独立查询确认：

```sh
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/branches | jq -r '.[].name'
```

`pre-push` 之类的 hook 输出同样会污染 stderr。

## 7. 一个真实的检索战果（示例）

用 `"windowsHide" "SW_HIDE"` 一次拿到同一底层问题的四种表现：

| 仓库 | 现象 | 方向 |
|---|---|---|
| 某 GUI 启动器插件 | 子进程窗口被设为隐藏 → 窗口永不出现 | 该显的没显 |
| 某守护进程 | 父进程失去控制台 → 它的子进程弹出终端窗 | 该隐的没隐 |
| 某 IDE 扩展 | 14 个 console 子进程未隐藏 → 抢走焦点 | 该隐的没隐 |
| 某代码审查标准 | 规则没区分 GUI 与 console 子进程 | 规则本身错 |

**同一个参数的两个反面都有人记录** —— 这种"双向坑图谱"官方文档永远不会写，
因为文档只描述设计意图，不描述它在真实组合下怎么害人。

而真正修正判断的那条线索，来自其中一个 issue 里的一句引用
（"与 discussion #1564 的结论一致"）—— **顺着引用走下去，比重新推导快得多**。
