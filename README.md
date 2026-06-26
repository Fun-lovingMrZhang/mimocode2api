<div align="center">

# MiMoCode2API

[![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](https://docker.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MiMo Auto](https://img.shields.io/badge/MiMo%20Auto-free-success)](https://github.com/XiaomiMiMo/MiMo-Code)

**将 [MiMoCode](https://github.com/XiaomiMiMo/MiMo-Code) CLI 转换为 OpenAI 兼容 API 网关**

免费使用 `mimo-auto` 模型，接入任何支持 OpenAI API 的客户端

</div>

---

## 📖 简介

MiMoCode2API 是一个轻量级代理服务，将小米 MiMoCode CLI 封装为标准 OpenAI 兼容 API。它自动管理 MiMoCode 后端生命周期，对外暴露 `/v1/chat/completions` 接口，支持流式/非流式响应、多轮对话、图片输入和工具调用。

**适用场景：** 在 Hermes Agent、ChatBox、Open WebUI 等客户端中免费使用 MiMo Auto 模型。

## ✨ 特性

- **OpenAI 兼容** — 零配置接入任何 OpenAI API 客户端
- **免费模型** — `mimo/mimo-auto`，1M 上下文窗口，零成本
- **流式响应** — SSE 实时输出，自动回退到轮询
- **思维链输出** — 通过 `reasoning_content` 字段返回模型推理过程
- **工具调用** — 外部工具桥接，支持 Hermes Agent 等多工具场景
- **多模态** — 支持图片输入（data URI / URL）
- **Docker 一键部署** — 自动管理后端启停

## 🚀 快速开始

### Docker 部署（推荐）

```bash
git clone https://github.com/Sliverkiss/mimocode2api.git
cd mimocode2api

# 配置环境变量
cp .env.example .env
# 编辑 .env，设置 API_KEY 和端口

# 启动
docker compose up -d
```

### 本地运行

```bash
# 前置：安装 MiMoCode CLI
npm install -g @mimo-ai/cli

# 安装依赖
npm install

# 启动 MiMo 后端（终端 A）
mimo serve --hostname 127.0.0.1 --port 10001

# 启动代理（终端 B）
MIMOCODE_SERVER_URL=http://127.0.0.1:10001 \
API_KEY=your-key \
node index.js
```

## 📡 使用

代理启动后，将客户端的 API 地址指向 `http://<host>:<port>/v1`：

```bash
curl http://localhost:10002/v1/chat/completions \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo/mimo-auto",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 接入 Hermes Agent

在 Hermes 配置中添加自定义 Provider：

```yaml
custom_providers:
  - name: mimo
    base_url: http://localhost:10002/v1
    api_key: your-key
    model: mimo/mimo-auto
    api_mode: chat_completions
```

## 🏗️ 架构

```
客户端 (OpenAI API 格式)
    │
    ▼
┌── Node.js 代理层 ───────────────────────────────┐
│  Express 服务器                                  │
│                                                  │
│  /v1/chat/completions  → 消息转换 + 会话管理      │
│  /v1/models            → 模型列表                │
│  /health               → 健康检查                │
│                                                  │
│  · 消息格式转换 (OpenAI → MiMo parts)            │
│  · SSE 事件流优先，轮询回退                       │
│  · 工具调用解析 (<function_calls> → tool_calls)   │
│  · 思维链分离 (reasoning_content)                │
│  · 请求互斥锁 (单会话并发安全)                    │
└──────────────────────────────────────────────────┘
    │
    ▼
┌── MiMoCode 后端 (内部端口) ─────────────────────┐
│  @mimo-ai/cli headless server                    │
│  MIMOCODE_MIMO_ONLY=true (仅免费通道)             │
│  默认模型: mimo/mimo-auto                         │
└──────────────────────────────────────────────────┘
```

## ⚙️ 配置

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MIMOCODE_PROXY_PORT` | `10000` | 代理对外端口 |
| `MIMOCODE_SERVER_PORT` | `10001` | MiMo 后端内部端口 |
| `MIMOCODE_SERVER_URL` | `http://127.0.0.1:10001` | MiMo 后端地址（非 Docker 模式使用） |
| `API_KEY` | (空) | 代理鉴权密钥（空 = 不鉴权） |
| `MIMOCODE_SERVER_PASSWORD` | (自动) | MiMo 后端鉴权（Docker 自动生成） |
| `DISABLE_TOOLS` | `true` | 禁用工具调用（纯 API 模式） |
| `MIMOCODE_PROXY_DEBUG` | `false` | 启用调试日志 |
| `MIMOCODE_PROXY_REQUEST_TIMEOUT_MS` | `180000` | 请求超时（毫秒） |
| `MIMOCODE_PROXY_MANAGE_BACKEND` | `true` | 自动启停 MiMo 后端（Docker 模式） |
| `PUID` / `PGID` | `1000` | 容器内进程用户/组 ID |

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/models` | 获取可用模型列表 |
| `POST` | `/v1/chat/completions` | 对话补全（支持流式和非流式） |

## 🔧 工具调用

代理通过虚拟桥接支持外部工具调用。后端内置工具会被禁用，客户端定义的工具通过 system prompt 传递给模型。模型以 `<function_calls>` XML 块输出工具调用，代理解析后转换为 OpenAI `tool_calls` 格式返回。

**实现细节：**

- 当工具激活时，content 流被缓冲而非立即发送，避免模型在工具调用前输出的解释性文本泄漏给客户端
- 工具调用解析完成后，如有有效调用则抑制缓冲内容，无调用则正常输出
- 参数类型自动转换：模型输出 `"180"` 字符串会自动修正为 `180` 整数
- 非流式轮询等待内容完整后才返回，避免 `info.finish` 提前触发导致空响应

## 📄 许可证

[MIT](LICENSE)

## ⚠️ 免责声明

本项目仅供学习和研究目的。MiMo Auto 是小米提供的限时免费通道，使用时请遵守其服务条款和速率限制。
