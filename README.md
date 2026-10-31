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
| `letterbox_add` | 写入一条：`text`（必填）、`kind`（risk / note / decision / handoff）、`priority`（high / normal）、`source` |
| `letterbox_list` | 列出当前会话的条目与回执，可只列未读 |
| `letterbox_status` | 回话前核对：还有几条没被确认 |

人这一侧：输入框上方的收件箱栏显示未读数，展开后逐条点「已读」。已读之后条目不会消失，只是从「未读」里移除。

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
| `requireCheckBeforeReply` | `true` | 提示词里要求回话前必须查一次未读 |
| `maxItemsPerSession` | `200` | 单会话上限，超出时先丢最旧的已读条目 |

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