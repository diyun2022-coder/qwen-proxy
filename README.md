# qwen-proxy

一个轻量级的 HTTP 代理服务，将 **Anthropic Messages API** 格式的请求转发给本地 `qwen` CLI，让你可以用任何支持 Anthropic/Claude API 的工具（如 Claude Code、Cursor、Continue 等）驱动 Qwen 模型。

## 工作原理

```
Claude Code / 其他客户端
        │  POST /v1/messages (Anthropic 格式)
        ▼
   qwen-proxy (localhost:8000)
        │  spawn: qwen <prompt> -m <model> -y [--output-format stream-json]
        ▼
    qwen CLI
        │  Native stream-json / 文本输出
        ▼
   qwen-proxy 转换并回传
        │  SSE (streaming) / JSON (non-streaming)
        ▼
Claude Code / 其他客户端
```

qwen CLI 的 `--output-format stream-json` 输出本身就是标准 Anthropic SSE 事件格式，代理会直接透传 `msg.event`，实现**真正的逐 token 流式输出**。

## 快速开始

### 前置条件

- Node.js 18+
- 已安装并登录 [Qwen Code CLI](https://github.com/QwenLM/qwen-code)（命令：`qwen`）

### 启动代理

```bash
node server.js
# Anthropic-compatible proxy listening on http://localhost:8000
```

### 配置 Claude Code

在 Claude Code 中将 API Base URL 设置为：

```
http://localhost:8000
```

API Key 可填任意字符串（代理不校验）。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8000` | 代理监听端口 |
| `DEFAULT_MODEL` | `qwen3.6-plus` | 请求未指定 model 时的默认模型 |
| `QWEN_BIN` | 自动探测（`which qwen`）| qwen 二进制路径 |

```bash
PORT=9000 DEFAULT_MODEL=qwen-max node server.js
```

## 支持的 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/v1/messages` | Anthropic Messages API，支持流式与非流式 |
| `GET` | `/v1/models` | 返回当前默认模型列表 |

路径匹配支持末尾含前缀的形式（如 `/proxy/v1/messages`）。

## 流式响应

请求体中设置 `"stream": true` 即可启用 SSE 流式输出：

```bash
curl -N http://localhost:8000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{
    "model": "qwen3.6-plus",
    "stream": true,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

底层调用方式：
```
qwen <prompt> -m <model> -y --output-format stream-json --include-partial-messages
```

## 项目结构

```
qwen-proxy/
├── server.js        # 代理主程序
├── interceptor.js   # 调试用拦截器（打印请求并返回假错误）
└── package.json
```

## 常见问题

**Q: Claude Code 里没有任何输出？**  
A: 确认 `qwen` 命令可以在终端直接执行，并已完成登录认证。

**Q: 提示 "requires user approval" / 工具调用被拦截？**  
A: 代理启动 qwen 时已自动附带 `-y`（YOLO 模式），跳过交互式授权确认。

**Q: 如何切换模型？**  
A: 在请求体中指定 `"model"` 字段，或通过 `DEFAULT_MODEL` 环境变量设置默认值。

**Q: 支持 system prompt 吗？**  
A: 支持。Anthropic 格式中的顶级 `system` 字段和 messages 数组内的 `system` 角色均会被解析并转换成 `<System>...</System>` 格式传给 qwen。
