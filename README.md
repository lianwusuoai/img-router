# ImgRouter

> 智能图像生成网关 — 一个 OpenAI 兼容接口，通过 chat 自动路由多平台 AI 进行绘图服务

[![Deno](https://img.shields.io/badge/Deno-2.x-000000?logo=deno)](https://deno.land/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/lianwusuoai/img-router)

## 特性

- **智能路由** - 根据 API Key 格式自动识别并分发到对应渠道
- **多渠道支持** - 火山引擎、Gitee (模力方舟)、ModelScope (魔搭)、Hugging Face、Pollinations
- **OpenAI 完全兼容** - 支持 `/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits` 接口
- **流式响应** - 支持 SSE 流式输出
- **文生图 & 图生图** - 支持纯文字生成图片，也支持上传参考图片进行图片编辑
- **智能图片处理** - 自动标准化图片格式，支持非标准格式转换
- **Base64 永久保存** - 所有生成的图片自动转换为 Base64 返回，永久有效
- **故障转移** - HuggingFace 渠道支持多 URL 资源池自动切换
- **Docker 部署** - 开箱即用的容器化部署方案
- **详细日志** - 完整的请求/响应日志记录

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      客户端请求                              │
│              POST /v1/chat/completions                      │
└─────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   API Key 检测器                             │
│  ┌─────────────┬─────────────────┬─────────────────────┐    │
│  │ hf_*        │ ms-*            │ UUID 格式            │    │
│  │ → HuggingFace│ → ModelScope   │ → VolcEngine        │    │
│  │             │                 │                     │    │
│  │ pk_* / sk_* │ 30-60位字母数字  │                     │    │
│  │ → Pollinations│ → Gitee       │                     │    │
│  └─────────────┴─────────────────┴─────────────────────┘    │
└─────────────────────┬───────────────────────────────────────┘
                       │
           ┌───────────┼───────────┬───────────┬───────────┐
           ▼           ▼           ▼           ▼           ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
     │VolcEngine│ │  Gitee   │ │ModelScope│ │HuggingFace│ │Pollinations│
     │ (火山)   │ │(模力方舟)│ │  (魔搭)  │ │ (抱抱脸) │ │          │
     └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
           │           │           │           │           │
           └───────────┴───────────┴───────────┴───────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  统一转换为      │
              │  Base64 返回    │
              │  (永久有效)     │
              └─────────────────┘
```

### 各渠道数据流详解

| 渠道 | 功能 | 发送格式 | 接收格式 | 最终返回 |
|------|------|----------|----------|----------|
| **火山引擎** | 文生图 | JSON (prompt) | URL | Base64 |
| **火山引擎** | 图生图 | JSON (URL 数组)¹ | URL | Base64 |
| **Gitee** | 文生图 | JSON (prompt) | Base64 | Base64 |
| **Gitee** | 图片编辑(同步) | FormData (Base64) | Base64 | Base64 |
| **Gitee** | 图片编辑(异步) | FormData (Base64) | URL | Base64 |
| **ModelScope** | 文生图 | JSON (prompt) | URL (异步轮询) | Base64 |
| **ModelScope** | 图生图 | JSON (URL 数组)¹ | URL (异步轮询) | Base64 |
| **HuggingFace** | 文生图 | JSON (Gradio API) | URL (SSE) | Base64 |
| **HuggingFace** | 图生图 | Blob 上传 + JSON | URL (SSE) | Base64 |
| **Pollinations** | 文生图 | GET (URL 参数) | 图片二进制 | Base64 |
| **Pollinations** | 图生图 | JSON (OpenAI 兼容) | URL / Base64 | Base64 |

> ¹ 如果输入是 Base64 图片，会先自动上传到图床转换为 URL 再发送给 API

**图片返回方式：**
- 所有渠道生成的图片都会自动转换为 **Base64 格式**返回
- Base64 嵌入在 Markdown 图片语法中，永久有效，无需担心链接过期

## API 端点

### 1. Chat Completions (推荐)
```
POST /v1/chat/completions
```
通过对话方式生成图片，支持文生图和图生图。

### 2. Images Generations (OpenAI 标准)
```
POST /v1/images/generations
```
标准的 OpenAI 图片生成接口，用于文生图。

### 3. Images Edits (OpenAI 标准)
```
POST /v1/images/edits
```
标准的 OpenAI 图片编辑接口，用于图生图。

> 💡 **提示**: 三个端点功能相同，可根据使用习惯选择。Chat Completions 接口更灵活，支持流式输出。

## 快速开始

### Docker Compose (推荐)

```bash
git clone https://github.com/lianwusuoai/img-router.git
cd img-router
docker-compose up -d
```

### Docker 直接运行

```bash
docker build -t img-router .
docker run -d --name img-router -p 10001:10001 img-router
```

### 本地开发

```bash
# 安装 Deno
# Windows: irm https://deno.land/install.ps1 | iex
# macOS/Linux: curl -fsSL https://deno.land/install.sh | sh

# 开发模式
deno task dev

# 生产模式
deno task start
```

## 自定义配置

所有渠道的模型、分辨率、API 地址等配置都在 `config.ts` 文件中，你可以根据需要自行修改。

### 配置文件结构

```typescript
// config.ts 主要配置项

// 1. 图床配置（用于 Base64 转 URL）
export const ImageBedConfig = {
  baseUrl: "https://your-imgbed.com",
  authCode: "your-auth-code",
  // ...
};

// 2. 各渠道配置
export const VolcEngineConfig = { ... };
export const GiteeConfig = { ... };
export const ModelScopeConfig = { ... };
export const HuggingFaceConfig = { ... };
export const PollinationsConfig = { ... };
```

### 修改默认模型

找到对应渠道的配置，修改 `defaultModel` 字段：

```typescript
// 火山引擎 - 修改默认模型
export const VolcEngineConfig = {
  defaultModel: "doubao-seedream-4-5-251128",  // ← 改这里
  // ...
};

// Gitee - 修改文生图/图片编辑默认模型
export const GiteeConfig = {
  defaultModel: "z-image-turbo",           // 文生图默认
  defaultEditModel: "Qwen-Image-Edit",     // 图片编辑(同步)默认
  defaultAsyncEditModel: "Qwen-Image-Edit-2511", // 图片编辑(异步)默认
  // ...
};
```

### 增删支持的模型

修改 `supportedModels`、`editModels` 等数组：

```typescript
// 火山引擎 - 添加/删除支持的模型
export const VolcEngineConfig = {
  supportedModels: [
    "doubao-seedream-4-5-251128",
    "doubao-seedream-4-0-250828",
    "your-new-model-id",  // ← 添加新模型
  ],
  // ...
};

// Gitee - 添加图片编辑模型
export const GiteeConfig = {
  editModels: [
    "Qwen-Image-Edit",
    "HiDream-E1-Full",
    "your-new-edit-model",  // ← 添加新模型
  ],
  asyncEditModels: [
    "Qwen-Image-Edit-2511",
    // ...
  ],
  // ...
};
```

### 修改默认分辨率    可以调小到64*64 但是不可以再大了，尺寸小生图快

修改 `defaultSize` 和 `defaultEditSize` 字段：

```typescript
// 火山引擎
export const VolcEngineConfig = {
  defaultSize: "2K",      // 文生图默认尺寸
  defaultEditSize: "2K",  // 图生图默认尺寸
  // ...
};

// Gitee
export const GiteeConfig = {
  defaultSize: "2048x2048",        // 文生图
  defaultEditSize: "1024x1024",    // 图片编辑(同步)
  defaultAsyncEditSize: "2048x2048", // 图片编辑(异步)
  // ...
};

// ModelScope
export const ModelScopeConfig = {
  defaultSize: "1024x1024",       // 文生图
  defaultEditSize: "1328x1328",   // 图生图
  // ...
};
```

### 添加 HuggingFace URL 资源池

HuggingFace 支持多 URL 故障转移，可以添加更多备用地址：

```typescript
export const HuggingFaceConfig = {
  // 文生图 URL 资源池（按优先级排序）
  apiUrls: [
    "https://your-space-1.hf.space",
    "https://your-space-2.hf.space",
    // 添加更多备用 URL...
  ],
  // 图生图 URL 资源池
  editApiUrls: [
    "https://your-edit-space.hf.space",
  ],
  // ...
};
```

### 配置 Pollinations 参数

Pollinations 支持多种特有参数，可以在 `config.ts` 中配置：

```typescript
export const PollinationsConfig = {
  // 基础配置
  defaultModel: "flux",              // 文生图默认模型
  defaultEditModel: "gptimage",      // 图生图默认模型
  defaultSize: "1024x1024",          // 文生图默认尺寸
  defaultEditSize: "1024x1024",      // 图生图默认尺寸

  // 图像生成参数
  seed: -1,                          // 随机种子：-1 表示每次随机
  quality: "hd",                     // 质量：low/medium/high/hd
  transparent: false,                // 透明背景
  guidanceScale: undefined,          // 提示词遵循强度(1-20)，不填则使用服务端默认
  
  // 特有参数
  enhance: true,                     // 让 AI 优化 prompt 以获得更好效果
  negativePrompt: "",                // 负面提示词（避免生成的内容）
  private: true,                     // 隐藏图片，不显示在公共 feed
  nologo: true,                      // 移除 Pollinations 水印
  nofeed: false,                     // 不添加到公共 feed
  safe: false,                       // 启用安全内容过滤器
  // ...
};
```

**参数说明：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `seed` | number | -1 | 随机种子，-1 表示每次随机，固定值可复现结果 |
| `quality` | string | "hd" | 图像质量：low/medium/high/hd |
| `transparent` | boolean | false | 生成透明背景图片 |
| `guidanceScale` | number | undefined | 提示词遵循强度 (1-20)，不填使用服务端默认 |
| `enhance` | boolean | true | 让 AI 自动优化你的 prompt 以获得更好的生成效果 |
| `negativePrompt` | string | "" | 负面提示词，指定要避免生成的内容（如 "blurry, low quality"） |
| `private` | boolean | true | 将生成的图片设为私密，不显示在公共 feed 中 |
| `nologo` | boolean | true | 移除 Pollinations 水印（需要有效的 API Key） |
| `nofeed` | boolean | false | 不将图片添加到公共 feed |
| `safe` | boolean | false | 启用安全内容过滤器，过滤不当内容 |

### 修改超时时间

```typescript
// 统一超时时间（毫秒），默认 300 秒
export const API_TIMEOUT_MS = 300000;
```

> ⚠️ **注意**：修改配置后需要重启服务才能生效。Docker 部署时需要重新构建镜像。

## API Key 格式

| 渠道 | 格式 | 示例 |
|------|------|------|
| 火山引擎 | UUID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| Gitee | 30-60位字母数字 | `abc123def456...` |
| ModelScope | `ms-` 开头 | `ms-xxxxxxxxxx` |
| Hugging Face | `hf_` 开头 | `hf_xxxxxxxxxx` |
| Pollinations | `pk_` 或 `sk_` 开头 | `pk_3Ff4YHCp8TkauKXq` 或 `sk_zzqmqZp3Jex...` |

系统根据 API Key 格式自动识别渠道，无需手动指定。

## 支持的模型

### 火山引擎（豆包）

| 模型 | 说明 |
|------|------|
| `doubao-seedream-4-5-251128` | 默认模型，最新版本 |
| `doubao-seedream-4-0-250828` | 旧版本 |

### Gitee（模力方舟）

**文生图：**
| 模型 | 说明 |
|------|------|
| `z-image-turbo` | 默认模型 |

**图片编辑（同步）：**
| 模型 | 说明 |
|------|------|
| `Qwen-Image-Edit` | 默认，通义千问图片编辑 |
| `HiDream-E1-Full` | HiDream 图片编辑 |
| `FLUX.1-dev` | FLUX 系列 |
| `FLUX.2-dev` | FLUX 系列 |
| `FLUX.1-Kontext-dev` | FLUX Kontext |
| `HelloMeme` | Meme 生成 |
| `Kolors` | 上色模型 |
| `OmniConsistency` | 一致性编辑 |
| `InstantCharacter` | 角色生成 |
| `DreamO` | DreamO 模型 |
| `LongCat-Image-Edit` | LongCat 编辑 |
| `AnimeSharp` | 动漫风格 |

**图片编辑（异步）：**
| 模型 | 说明 |
|------|------|
| `Qwen-Image-Edit-2511` | 默认，通义千问最新版 |
| `LongCat-Image-Edit` | LongCat 编辑 |
| `FLUX.1-Kontext-dev` | FLUX Kontext |

### ModelScope（魔搭）

| 模型 | 类型 | 说明 |
|------|------|------|
| `Tongyi-MAI/Z-Image-Turbo` | 文生图 | 默认模型 |
| `Qwen/Qwen-Image-Edit-2511` | 图生图 | 图片编辑模型 |

### Hugging Face

| 模型 | 类型 | 说明 |
|------|------|------|
| `z-image-turbo` | 文生图 | 默认模型 |
| `Qwen-Image-Edit-2511` | 图生图 | 图片编辑模型 |

### Pollinations 模型

| 模型 | 类型 | 说明 |
|------|------|------|
| `flux` | 文生图 | 默认模型，Flux Schnell |
| `turbo` | 文生图 | SDXL Turbo 单步实时 |
| `zimage` | 文生图 | Z-Image Turbo + 2x放大 |
| `kontext` | 文生图/图生图 | FLUX.1 Kontext 编辑 |
| `nanobanana` | 文生图/图生图 | Gemini 2.5 Flash Image |
| `nanobanana-pro` | 文生图/图生图 | Gemini 3 Pro Image (4K) |
| `seedream` | 文生图/图生图 | ByteDance Seedream 4.0 |
| `seedream-pro` | 文生图/图生图 | ByteDance Seedream 4.5 (4K) |
| `gptimage` | 文生图/图生图 | GPT Image Mini（图生图默认） |
| `gptimage-large` | 文生图/图生图 | GPT Image 1.5 高级版 |

> **Pollinations 密钥说明：**
> - `pk_` 开头：公共密钥，有速率限制 (1 pollen/小时/IP)
> - `sk_` 开头：私密密钥，无速率限制，适合服务端使用
>
> **尺寸说明：** 部分模型对尺寸有限制，如 `gptimage-large` 可能会自动调整到最接近的支持尺寸

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `10001` |
| `LOG_LEVEL` | 日志级别 (DEBUG/INFO/WARN/ERROR) | `INFO` |

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
