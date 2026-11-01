# dsh-letterbox

> 会话级收件箱：Agent 把「你必须知道」的信息投进来，只有你点「已读」才算读过；Agent 回话前先查回执，不再替你假设。

## 它解决什么

主代理带几十个子代理时，子代理的回报是插话式的：一条条冲进主线，你看漏了风险，Agent 也不会知道。它以为你看到了，你以为它没说——两边都基于错误的前提继续往下聊。

dsh-letterbox 给每个会话挂一个收件箱：

1. **Agent 写**：`letterbox_add` 把风险、待你拍板的决定、需要你接手的交接记成一条。
2. **你点已读**：只有面板上的「已读」按钮能把一条标成读过，任何工具都改不了回执。
3. **Agent 查**：`letterbox_status` 在回话前告诉你哪些没被确认；系统提示里写死「没读到的必须点名说明，不许当成已经讨论过」。

## 安装

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-letterbox
```

桌面端请在应用自己的「设置 → 插件」里安装，那个 profile 归应用的插件管理器所有。

装完重载窗口（客户端半边）或重启 dsh（宿主半边），输入框上方出现「📬 收件箱」一栏。

## 用法

Agent 侧（模型可见的三个工具）：

| 工具 | 作用 |
| --- | --- |
| `letterbox_add` | 写入一条：`text`（必填）、`kind`（risk / note / decision / handoff）、`priority`（high / normal）、`source`、`scope`（session / global，默认 session） |
| `letterbox_list` | 列出当前会话的条目与回执，可只列未读 |
| `letterbox_status` | 回话前核对：还有几条没被确认 |

人这一侧：输入框工具条右侧有一颗 📬 图标按钮（有未读时右上角带数字），点击展开左侧抽屉：左栏先选「会话 / 全局」，再是「未读 / 历史」两个 tab 的列表，右栏是选中条目的详情与「标记为已读」；点抽屉外部、Esc 或再点按钮都能收起。侧边栏导航列里还有独立一项「收件箱」（inbox 图标，排在「自动化任务」之后）：点击把主区切到整页收件箱，布局与抽屉相同、只是不再浮动，也没有遮罩，选别的导航项即离开。主列表只放未读，点过已读的那条立刻离开；有新条目时左下角弹一张 8 秒卡片（悬停暂停，点它或「查看」直接定位），卡片消失不代表已读。

历史 tab 收所有已读条目（带「已读 HH:MM」时间），按分页加载：顶部显示「共 N 条」，搜索框按正文 / 来源 / 类型做不区分大小写的匹配（输入停 250ms 后查询），一次 20 条，底部「加载更多（还剩 N 条）」继续翻页；结果只读，不再有「已读」按钮。

空箱时入口同样在：未读为空显示「没有未读」，历史为空显示「还没有历史」，按钮不会消失。

### 两个箱子：会话 / 全局

- 每条笔记有 `scope`：`session`（默认）只属于当前会话；`global` 放进跨会话共享的全局箱。
- 只有用户明确说「发到全局 / 全局记一下」，或该事实明显不绑定当前任务（长期偏好、跨会话知识、通用规则），才用 `global`；其余一律 `session`。
- 抽屉左栏顶部用「会话 / 全局」切换，两个箱子的未读、历史、搜索、分页各自独立；入口按钮的数字只算会话未读，全局未读写在按钮的 tooltip 里，也不计入「漏核对」（漏核对只按会话未读记账）。

Agent 侧有两条硬约定：宿主每轮都会在系统提示里注入一行 `Letterbox:` 回执，Agent 照它行动——有未读时必须调用 `letterbox_status` 并逐条点名（漏一轮记一次 miss），没有未读时不必查；每轮里「人必须知悉」的事要用 `letterbox_add` 发进收件箱，不能只写在回复正文里。

当所有条目都被点过已读，注入的那行会说「the human has acknowledged all N filed note(s)」：Agent 视它们为双方共享的知识背景，从这些结论说话，不再重复解释，也不问「你看到了吗」。

## 数据在哪

`$DSH_HOME/letterbox.json`，按 `sessionId` 分区。写入是「临时文件 + rename」，重启不丢。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `letterbox` 这一行（patch 会替换整块 config，想保留的字段要重述）：

```yaml
- id: letterbox
  config:
    enabled: true
    requireCheckBeforeReply: true
    maxItemsPerSession: 200
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册工具、不注入提示词 |
| `requireCheckBeforeReply` | `true` | 提示词里把「有未读就必须查」写成硬要求；关掉后只说「注入的回执有未读时再查」 |
| `enforcement` | `strict` | `strict` 时有未读、本轮却没调用 `letterbox_status` 的正常回合记一次 miss；没有未读的回合不记。`warn` 只提示不记账 |
| `maxItemsPerSession` | `200` | 单会话上限，超出时先丢最旧的已读条目 |

### 核对（checkpoint）与漏检记账

- `letterbox_status` 不只是查询：它会把「本轮查过了」写进会话账本（`checkedAt` / `checkedTurn`），客户端据此显示「上次核对 HH:MM」。
- 每个 `turn/start` 由宿主生成一个 turn id；`turn/end` 若是正常完成、仍有未读、且本轮没调用过 `letterbox_status`，就记一次 miss（`misses` 累加），面板显示「Agent 漏核对 N 轮」。没有未读的回合不记。
- 每轮宿主还会往 Agent 的系统提示里注入一行 `Letterbox:` 回执，按当前账本三选一：有未读（要求查并点名）、全部已读（不必查，视为共同背景）、本会话还没有条目（提示用 `letterbox_add` 写入）。它逐 Agent 注册、每轮装配时求值，所以永远反映此刻的账本。
- 这是宿主侧事实，不依赖模型自述；中断/取消的回合不计 miss。

## 边界

- 它不是通知中心：没有桌面通知、没有声音，只有会话里的未读栏。
- 它不是待办清单：条目的生命周期是「未读 → 已读」，没有完成态。
- 回执只能由人写入：工具侧没有 `letterbox_mark_read`，这是设计约束，不是遗漏。
- 目前只做单会话维度；跨会话汇总留给别的插件。

## 开发

```sh
npm test     # store 单元测试
```

验证五道门（G1 清单 / G2 形状 / G3 安装 / G4 组合 / G5 激活）可用标准命令复现：`dsh plugin --profile <tmp> add .` → `dsh --profile <tmp> --dump-config` → `dsh --profile <tmp>`（退出码 0 且无 `plugin tree failed to load`）。客户端半边（`client.js`）不参与启动梯子，必须在浏览器里重载页面验证。