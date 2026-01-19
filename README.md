# ImgRouter

> 智能图像生成网关 — 一个 OpenAI 兼容接口，通过 chat 自动路由多平台 AI 进行绘图服务，并提供 Key 池、权重路由与 Web 管理面板。

[![Deno](https://img.shields.io/badge/Deno-2.x-000000?logo=deno)](https://deno.land/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/lianwusuoai/img-router)

- 文档版本：v1.8.3（对应 [deno.json](deno.json)）
- 最后更新时间：2026-01-19

## 项目概述

ImgRouter 用于将多家 AI 图像服务聚合到一个统一入口，向客户端提供 OpenAI 兼容的接口层，同时在服务端提供可靠性与运维能力：

- **统一接口**：对外暴露 `/v1/*` 兼容端点，屏蔽各 Provider 的参数与返回差异。
- **高可用路由**：支持按 Key 自动识别 Provider（中转模式-接入自用的newapi/gpt-loat等号池），也支持按权重级联故障转移（后端模式-自用少量key号池聚合）。
- **可视化运维**：内置 Web 管理面板（渠道管理、Key 池、提示词优化器、日志、画廊）。
- **存储**：本地 `data/storage/` 持久化；可选同步到 S3/R2（S3 兼容）

## 特性

- **三种图片生成方式** - 文生图（文字生图）+ 图片编辑（图片+文字生图） + 融合生图（带上下文进行生图/改图）
- **双模式运行** - 中转模式（Provider Key 透传）/ 后端模式（Global Key + Key 池路由）
- **智能路由** - API Key 格式识别 + 权重级联路由 + 模型映射（modelMap）
- **多渠道支持** - 豆包（火山引擎）、Gitee（模力方舟）、ModelScope（魔搭）、HuggingFace、Pollinations
- **OpenAI 完全兼容** - 支持 `/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits`、`/v1/images/blend`、`/v1/models`
- **流式响应** - Chat Completions 支持 `stream=true`（SSE）；管理端支持 `/api/logs/stream`（SSE）
- **图片落盘与画廊** - 自动保存生成结果到 `data/storage/`，并提供 `/storage/*` 与 `/api/gallery`
- **图床上传** - 在需要 URL 的场景下可将 Base64 上传到图床（由 `imageBed` 配置驱动），默认自带图床，可改
- **安全防护** - 内置 URL 安全校验与 SSRF 防护策略
- **详细日志** - 请求/响应全链路日志（含 RequestId），并提供实时日志流订阅

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                       客户端请求                             │
│               POST /v1/chat/completions     推介主力         │
│               POST /v1/images/generations                   │
│               POST /v1/images/edits                         │
│               POST /v1/images/blend                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    鉴权 / 运行模式                           │
│                                                             │
│  • 中转模式 Relay：Authorization = Provider Key              │
│  • 后端模式 Backend：Authorization = GlobalAccessKey         │
│                                                             │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                API Key自动路由与执行计划                      │
│                                                             │
│  • hf_* 开头           → HuggingFace (抱抱脸)                │
│  • ms-* 开头           → ModelScope (魔搭)                   │
│  • pk_* / sk_* 开头    → Pollinations                        │
│  • UUID 格式           → Doubao Seedream (火山引擎/豆包)      │
│  • 30-60位字母数字     → Gitee (模力方舟)                     │
│                                                             │
└──────────────────────┬──────────────────────────────────────┘
                       │
           ┌───────────┼───────────┬───────────┬───────────┐
           ▼           ▼           ▼           ▼           ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐
   │  Doubao  │ │  Gitee   │ │ModelScope│ │HuggingFace│ │Pollinations  │
   └──────────┘ └──────────┘ └──────────┘ └───────────┘ └──────────────┘
           │           │           │           │           │
           └───────────┴───────────┴───────────┴───────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    后处理与存储                              │
│     • 格式统一（URL / b64_json / data URI）                  │
│     • 自动落盘 data/storage/；可选同步 S3/R2                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │ OpenAI 兼容响应  │
              └─────────────────┘
```

### API Key 自动识别规则（中转模式）

| 规则 | Provider |
| --- | --- |
| `hf_*` 开头 | HuggingFace |
| `ms-` 开头 | ModelScope |
| `pk_*` / `sk_*` 开头 | Pollinations |
| UUID 格式 | Doubao（火山引擎/豆包） |
| 30-60 位字母数字 | Gitee（模力方舟） |

### 运行模式说明

- **中转模式（Relay）**：客户端直接携带 Provider Key，系统根据 Key 格式识别渠道并透传请求。
- **后端模式（Backend）**：客户端携带系统 GlobalAccessKey；系统根据模型/任务类型生成执行计划，并从 Key 池中选择 Provider Key 执行。

> 默认模式：Relay=开启，Backend=关闭（以实际运行时配置为准）。

### 各渠道数据流（摘要）

| 渠道 | 文生图 | 图生图/编辑 | 融合生图 | 备注 |
| --- | --- | --- | --- | --- |
| **Doubao** | JSON(prompt) → URL/b64_json | JSON(images) → URL/b64_json | JSON(messages/images) → URL/b64_json | 内置尺寸校验与自动修正 |
| **Gitee** | JSON(prompt) → b64_json | FormData/JSON → b64_json | 复用编辑模型 → b64_json | 强制 b64_json（策略约束） |
| **ModelScope** | JSON → 异步轮询 → URL/b64_json | JSON → 异步轮询 → URL/b64_json | JSON → 异步轮询 → URL/b64_json | 原生多为单张，通过并发模拟多张 |
| **HuggingFace** | Space API → URL/b64_json | Space API → URL/b64_json | Space API → URL/b64_json | 支持 HF 模型映射到不同 Space |
| **Pollinations** | GET/参数 → 图片流 → b64_json | GET/参数（需要 URL） | GET/参数 | Base64 输入会先上传图床换短 URL |

## 核心功能

### 1) 功能模块

- **OpenAI 兼容 API**：对外统一提供 `/v1/*` 标准接口。
- **管理 API**：对内提供配置、Key 池、日志、画廊、更新检查等接口（`/api/*`）。
- **Web 管理面板**：SPA 路由（`/admin`、`/setting`、`/channel`、`/keys`、`/pic`、`/prompt-optimizer`、`/update`）。
- **本地存储与画廊**：自动保存生成结果（不阻塞主响应），支持列表与删除。

### 2) 技术实现亮点

- **权重级联路由**：根据 `providers.{name}.{task}.weight` 生成执行序列，并在失败时自动尝试下一渠道。
- **模型映射（modelMap）**：可将“自定义模型 ID”映射到指定渠道的真实模型，实现统一入口与灵活调度。
- **运行时配置热更新**：运行时配置写入 `data/runtime-config.json`，管理面板调用 `/api/runtime-config` 生效。
- **图床上传与 SSRF 防护**：当上游需要 URL 且输入为 Base64 时，自动上传图床并做 URL 安全校验。

### 3) 性能指标与基准测试

当前版本未内置固定的基准测试脚本与官方基准数据（避免文档与环境差异导致误导）。推荐使用以下方式获取真实数据：

- **接口维度**：结合请求日志与 RequestId 统计 P50/P95 延迟、错误率。
- **Key 池维度**：调用 `/api/dashboard/stats` 获取各 Provider 的 Key 池成功率与调用量聚合。
- **容量维度**：服务端请求体大小上限默认 `20MB`，超时默认 `60s`（可配置）。

## 部署指南

### 环境要求与依赖项

- Docker 20.10+
- Docker Compose 2.0+
- 默认端口：`10001`

### 分步部署流程（Docker Compose）

```bash
git clone https://github.com/lianwusuoai/img-router.git
cd img-router

docker-compose up -d
```

访问管理面板：`http://localhost:10001/admin`

### 配置参数说明

配置来源优先级：**环境变量 > 运行时配置（data/runtime-config.json）> 默认配置**。

**常用环境变量**（与实现保持一致）：

- `PORT`：服务端口（默认 10001）
- `API_TIMEOUT_MS`：上游请求超时（默认 60000）
- `LOG_LEVEL`：日志等级（默认 info）
- `DOUBAO_DEFAULT_COUNT`：Doubao 默认生成张数（默认 1）
- `PROMPT_OPTIMIZER_BASE_URL` / `PROMPT_OPTIMIZER_API_KEY` / `PROMPT_OPTIMIZER_MODEL`：提示词优化器（OpenAI 兼容）
- `IMAGE_BED_BASE_URL` / `IMAGE_BED_AUTH_CODE` / `IMAGE_BED_UPLOAD_FOLDER` / `IMAGE_BED_UPLOAD_CHANNEL`：图床上传（若启用）

**运行时配置文件**：`data/runtime-config.json`

- `system.globalAccessKey`：全局访问密钥（后端模式鉴权）
- `system.modes.relay / system.modes.backend`：运行模式开关
- `providers.{Provider}.enabled`：Provider 启用/禁用
- `providers.{Provider}.{task}`：任务默认值与路由权重（task ∈ text/edit/blend）
- `promptOptimizer`：提示词优化器配置
- `hfModelMap`：HuggingFace 模型 → Space URL 映射
- `storage.s3`：S3/R2 兼容存储配置（endpoint/bucket/accessKey/secretKey/region/publicUrl）

## 使用说明

### API 接口文档（对外）

#### 1) Chat Completions（推荐）

```
POST /v1/chat/completions
```

- 用于“对话式生图”（返回内容为 Markdown 图片链接，可能是 URL 或 data URI）
- 支持 `stream=true`（SSE）

示例：

```bash
curl -X POST http://localhost:10001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的Key>" \
  -d '{
    "model": "auto",
    "messages": [{"role":"user","content":"一只赛博朋克猫"}],
    "stream": false
  }'
```

#### 2) Images Generations（OpenAI 标准）

```
POST /v1/images/generations
```

- `response_format`：
  - `url`（默认）：可能返回上游 URL；当上游返回 Base64 时，会以 data URI 形式放入 `url` 字段
  - `b64_json`：尽量返回 Base64（若 URL 转换失败会回退为 URL）

示例：

```bash
curl -X POST http://localhost:10001/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的Key>" \
  -d '{
    "prompt": "A futuristic city skyline at night",
    "model": "auto",
    "n": 1,
    "size": "1024x1024",
    "response_format": "b64_json"
  }'
```

#### 3) Images Edits（图片编辑）

```
POST /v1/images/edits
```

支持 `multipart/form-data` 与 JSON 两种输入形态。

#### 4) Images Blend（多图融合）

```
POST /v1/images/blend
```

用于多图融合生成，返回格式与 Images API 一致。

#### 5) Models（模型列表）

```
GET /v1/models
```

聚合当前启用 Provider 的模型列表。

### 管理面板与管理 API（对内）

- 管理面板（SPA）：`/admin`、`/setting`、`/channel`、`/keys`、`/pic`、`/prompt-optimizer`、`/update`
- 健康检查：`GET /health`（受配置 `healthCheck` 开关影响）
- 系统信息：`GET /api/info`
- 配置快照：`GET /api/config`
- 运行时配置：`GET/POST /api/runtime-config`
- Key 池管理：`GET/POST /api/key-pool?provider=<Provider>`
- 仪表盘统计：`GET /api/dashboard/stats`
- 实时日志：`GET /api/logs/stream?level=INFO`
- 画廊：`GET/DELETE /api/gallery`；图片访问：`/storage/<filename>`
- 更新检查：`GET /api/update/check`
- HF 映射：`GET/POST /api/config/hf-map`

### 最佳实践

- **生产环境优先启用后端模式**：设置 `system.globalAccessKey`，客户端只持有全局 Key；Provider Key 全部放入 Key 池。
- **为限频渠道配置 Key 池**：Gitee/ModelScope/HuggingFace 建议多 Key 轮询，提高并发成功率。
- **合理配置权重**：将更稳定/更便宜的渠道权重提高，作为优先执行目标。
- **配置 S3 publicUrl**：若需公网访问画廊图片，配置 `storage.s3.publicUrl` 以返回可访问链接。

## 开发

```bash
# 开发模式（监听文件变化）
deno task dev

# 生产启动
deno task start
```
