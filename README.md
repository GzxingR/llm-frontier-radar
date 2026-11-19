# Frontier Radar

> 前沿模型雷达 —— 找出「能用但站点没公布」和「公布了其实不能用」的模型。

[![Pages](https://img.shields.io/badge/demo-GitHub%20Pages-111827)](https://gzxingr.github.io/llm-frontier-radar/)
[![License](https://img.shields.io/badge/license-MIT-3ddc84)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-5b9bff)](https://nodejs.org)

中转站和聚合网关常见两种状态，官方页面都不告诉你：

1. **隐藏可用** —— 模型能真实调用，但 `/v1/models` 和价目表里没有
2. **公布但坏** —— 站点列了模型，实际 404、停用接口、或者根本不出字

Frontier Radar 拿一份干净的候选模型池，逐站逐模型去撞，把「宣称」和「实际」做差集。

## 它长什么样

一张矩阵：行是候选模型，列是站点。

| 模型 | 星驰 | AnyRouter | HappyCoding |
|---|---|---|---|
| gpt-6.1-sol | 可用 | 可用 | 分组没有 |
| gpt-6-astra | 分组没有 | **隐藏** | 不存在 |
| claude-opus-5-5 | 无权限 | 不存在 | 不存在 |

金色「隐藏」就是站点没公布、但确实能用的模型。

## 判定不是二分，是十一种

雷达最容易做错的地方是把「这个 key 用不了」当成「模型不存在」。所以每种结论都要求证据强度：**只有 `exists===true && strong===true` 才叫确实可用。**

| 标签 | 含义 | 证据要求 |
|---|---|---|
| `隐藏可用` | 能用，但站点没列 | 真实返回内容，或模型级参数校验 |
| `已公布可用` | 站点列了，也确实能用 | 同上 + 在站点列表里 |
| `疑似可用` | 有点像能，但证据不足 | 只报了请求体形状错误，需 L3 确认 |
| `公布但坏` | 站点列了，但不可用 | 明确的 `model_not_found` |
| `不存在` | 站点没列，也确实没有 | 明确的 `model_not_found` |
| `分组没有` | 这个 key 的分组没有该模型 | 站点的分组提示 |
| `客户端被拦` | 站点只放行特定客户端 | 200 里是拒绝话术，或 403 |
| `被 WAF 拦` | 前置 WAF 回了挑战页 | 响应是 HTML/JS 挑战 |
| `路径不存在` | base URL 填错 | `Invalid URL` |
| `密钥失效` / `限流` | 401 / 429 | HTTP 状态码 |
| `待确认` | 超时、5xx、413、空响应 | **证据不足，不判死** |

### 两个真实踩过的坑

**假成功**：有的站对不认识的客户端返回 `HTTP 200`，正文却是一句「本站仅限 Coding 客户端」。只看状态码会把它当成可用模型，实际上一个都没跑。所以 200 也必须检查正文内容。

**假存在**：有的站先校验 `messages` 是否为空，再查模型。这意味着「400 messages required」并不能证明模型存在，只能说请求体形状被拒。这类只能标 `疑似可用`。

## 三级探测，成本递增

| 级别 | 手法 | 成本 | 默认 |
|---|---|---|---|
| **L1 存在性** | 空 `messages` 打 `/chat/completions`，让参数校验拦下 | 0 token | 开 |
| **L2 协议自适应** | L1 报「本站停用 chat 接口」时，自动换 `/v1/responses` 再试 | 0 token | 开 |
| **L3 真实性** | `max_tokens: 1` 的真实小请求 | 会花 token | **关** |

L2 是必需的：有些站悄悄停用了 `/v1/chat/completions`，只留 `/v1/responses`。不自动换协议，会把好模型误判成坏的。

## 防 WAF

密集 404 请求看起来就像扫描器。所以：

- 同站**串行**，不同站之间也留间隔
- 每个请求间隔默认 1500ms，带 **±40% 随机抖动**
- 站间间隔默认 4000ms
- 定时扫描最小间隔按小时计，不提供秒级循环

这些都能在设置里调。**别把间隔调到 0**，被 WAF 拉黑比慢更麻烦。

## 快速开始

```bash
git clone https://github.com/GzxingR/llm-frontier-radar.git
cd llm-frontier-radar
cp config.example.json config.local.json
node server.js
```

打开 `http://127.0.0.1:5199`，点「设置」加站点和 key，再点「开始扫描」。

零运行时依赖，Node 20+。

## 配置

```json
{
  "server": { "host": "127.0.0.1", "port": 5199 },
  "scan": {
    "intervalHours": 0,
    "delayMs": 1500,
    "siteGapMs": 4000,
    "timeoutMs": 30000,
    "deep": false
  },
  "sites": [
    {
      "id": "my-relay",
      "name": "我的公益站",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-...",
      "headers": { "User-Agent": "DeepSeek-Harness/1.0" },
      "proxy": "",
      "enabled": true
    }
  ]
}
```

`intervalHours` 是自动扫描的小时数，`0` 表示只手动。界面上会显示倒计时。

`headers` 很关键 —— 很多中转站按客户端 UA 放行，不带就是 403。

## 候选池

`pool.js` 是一份手写的模型基础名清单，按家族分组。

规则：**只写基础名，不带任何参数后缀**。不写 `-1017`、`@256k`、`-fast`、`-cc-format`、`-preview`。

原因是雷达要在不同站点之间比较同一个模型。带参数的名字是某个站自己的方言，跨站不可比。启动时会检查池子里有没有混入带参数的名字。

加模型就往 `pool.js` 对应家族里加一行。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/pool` | 候选池 |
| GET | `/api/config` | 配置（密钥脱敏） |
| POST | `/api/config` | 保存配置 |
| POST | `/api/scan?deep=0\|1` | 开始扫描 |
| GET | `/api/status` | 进度、下次扫描、倒计时 |
| GET | `/api/results` | 矩阵数据 |
| GET | `/api/export` | CSV |

## 已知边界

- **403 可能是客户端白名单**，不是没权限。带上正确的 `User-Agent` 再判断。
- **200 可能是拒绝话术**，正文必须看。
- **502/超时/413 不判死**，一律「待确认」，下次扫描再看。
- **WAF 挑战页**用 HTML+JS 返回，HTTP 可能还是 200。要么换出口 IP，要么给站点配 `proxy`。
- **Responses-only 站点**的 L2 可能真的打到上游（`input: []` 有的站不校验），所以别对这类站开 L3 反复跑。
- **探测会消耗站点侧日志配额**，请求多了站点也能看到。保持间隔，别刷。
- 这些结论都是**某时刻的观测**，不是承诺。

## 实测调过的配置

不同站点的「正确打开方式」差别很大，这些是跑出来的经验：

| 情况 | 现象 | 处理 |
|---|---|---|
| 有的站校验客户端 | 默认 UA 一律 `403 client_not_allowed` | 配 `headers.User-Agent`，如 `DeepSeek-Harness/1.0` |
| 有的站用 200 软拦截 | 200 + `本站仅限 Coding 客户端` | 换编程客户端 UA，如 `codex_cli_rs/0.1.0` |
| base URL 不一定是 `/v1` | `Invalid URL (POST /v1/chat/completions)` | 去掉 `/v1`，用根域 + `/chat/completions` |
| 前置 WAF | 200 + HTML JS 挑战 | 配 `proxy`，或换网络出口 |

## 和别的项目什么关系

不想重复造轮子，所以先说清楚差异：

- [api-probe](https://github.com/xydadada/api-probe) 有更好的单站多协议探测，本项目的协议回退思路参考了它
- [API-Check](https://github.com/ssrsgaga/API-Check) 有 N×M 矩阵测活界面
- [ChannelMonitor](https://github.com/DullJZ/ChannelMonitor) 是给自己的 one-api / new-api 读数据库做渠道监控
- [cuihuan/modelprobe](https://github.com/cuihuan/modelprobe) 是单网关可用性探针

它们都只探测**站点已经公布的模型**。Frontier Radar 的差别是那份固定候选池 —— 目的是发现站点没说的东西。

## License

MIT
