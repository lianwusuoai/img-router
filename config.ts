// ================= 图床配置 =================
// CloudFlare ImgBed 图床 - 用于将 Base64 图片转换为 URL
export const ImageBedConfig = {
  // 图床地址
  baseUrl: "https://imgbed.lianwusuoai.top",
  // 上传端点
  uploadEndpoint: "/upload",
  // 上传认证码
  authCode: "imgbed_xKAGfobLGhsEBEMlt5z0yvYdtw8zNTM6",
  // 上传目录
  uploadFolder: "img-router",
  // 上传渠道（telegram、cfr2、s3）
  uploadChannel: "s3",
};

// ================= 渠道配置 =================
// 支持：火山引擎 (VolcEngine/豆包)、Gitee (模力方舟)、ModelScope (魔搭)、Hugging Face

// 渠道配置接口
export interface ProviderConfig {
  apiUrl: string;
  defaultModel: string;
  defaultSize: string;      // 文生图默认尺寸
  defaultEditSize: string;  // 图生图默认尺寸
  supportedModels: string[];
}

// Hugging Face 多 URL 配置接口（支持故障转移）
export interface HuggingFaceProviderConfig {
  apiUrls: string[];  // URL 资源池，按优先级排序
  defaultModel: string;
  defaultSize: string;      // 文生图默认尺寸
  defaultEditSize: string;  // 图生图默认尺寸
  supportedModels: string[];
}

// 火山引擎（豆包）配置
export const VolcEngineConfig: ProviderConfig = {
  apiUrl: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
  defaultModel: "doubao-seedream-4-5-251128",
  defaultSize: "2K",      // 文生图默认尺寸
  defaultEditSize: "2K",  // 图生图默认尺寸
  supportedModels: [
    "doubao-seedream-4-5-251128",
    "doubao-seedream-4-0-250828",
  ],
};

// Gitee（模力方舟）配置 - 支持文生图、图片编辑、图片编辑（异步）
export interface GiteeProviderConfig {
  apiUrl: string;                // 文生图 API
  editApiUrl: string;            // 图片编辑 API（同步）
  asyncEditApiUrl: string;       // 图片编辑 API（异步）
  taskStatusUrl: string;         // 异步任务状态查询 API
  defaultModel: string;          // 文生图默认模型
  defaultEditModel: string;      // 图片编辑默认模型
  defaultAsyncEditModel: string; // 图片编辑（异步）默认模型
  defaultSize: string;           // 文生图默认尺寸
  defaultEditSize: string;       // 图片编辑默认尺寸
  defaultAsyncEditSize: string;  // 图片编辑（异步）默认尺寸
  supportedModels: string[];
  editModels: string[];          // 图片编辑支持的模型
  asyncEditModels: string[];     // 图片编辑（异步）支持的模型
}

export const GiteeConfig: GiteeProviderConfig = {
  apiUrl: "https://ai.gitee.com/v1/images/generations",
  editApiUrl: "https://ai.gitee.com/v1/images/edits",
  asyncEditApiUrl: "https://ai.gitee.com/v1/async/images/edits",
  taskStatusUrl: "https://ai.gitee.com/v1/task",
  defaultModel: "z-image-turbo",
  defaultEditModel: "Qwen-Image-Edit",       // 图片编辑默认模型
  defaultAsyncEditModel: "Qwen-Image-Edit-2511", // 图片编辑（异步）默认模型
  defaultSize: "2048x2048",        // 文生图默认尺寸
  defaultEditSize: "1024x1024",    // 图片编辑默认尺寸
  defaultAsyncEditSize: "2048x2048", // 图片编辑（异步）
  supportedModels: [
    "z-image-turbo",
  ],
  // 图片编辑（同步）
  editModels: [
    "Qwen-Image-Edit",      // 默认
    "HiDream-E1-Full",
    "FLUX.1-dev",
    "FLUX.2-dev",
    "FLUX.1-Kontext-dev",
    "HelloMeme",
    "Kolors",
    "OmniConsistency",
    "InstantCharacter",
    "DreamO",
    "LongCat-Image-Edit",
    "AnimeSharp",
  ],
  // 图片编辑（异步）
  asyncEditModels: [
    "Qwen-Image-Edit-2511", // 默认
    "LongCat-Image-Edit",
    "FLUX.1-Kontext-dev",
  ],
};

// ModelScope（魔搭）配置 - 支持文生图和图生图
export interface ModelScopeProviderConfig {
  apiUrl: string;
  defaultModel: string;           // 文生图默认模型
  defaultEditModel: string;       // 图生图默认模型
  defaultSize: string;            // 文生图默认尺寸
  defaultEditSize: string;        // 图生图默认尺寸
  supportedModels: string[];      // 文生图支持的模型
  editModels: string[];           // 图生图支持的模型
}

export const ModelScopeConfig: ModelScopeProviderConfig = {
  apiUrl: "https://api-inference.modelscope.cn/v1",
  defaultModel: "Tongyi-MAI/Z-Image-Turbo",           // 文生图模型
  defaultEditModel: "Qwen/Qwen-Image-Edit-2511",      // 图生图
  defaultSize: "1024x1024",       // 文生图默认尺寸
  defaultEditSize: "1328x1328",   // 图生图默认尺寸
  supportedModels: [
    "Tongyi-MAI/Z-Image-Turbo",
  ],
  editModels: [
    "Qwen/Qwen-Image-Edit-2511",  // 通义千问图片编辑模型
  ],
};

// Hugging Face 多 URL 配置接口（支持故障转移，区分文生图和图生图）
export interface HuggingFaceProviderConfigExtended {
  apiUrls: string[];           // 文生图 URL 资源池
  editApiUrls: string[];       // 图生图/融合生图 URL 资源池
  defaultModel: string;        // 文生图默认模型
  defaultEditModel: string;    // 图生图默认模型
  defaultSize: string;         // 文生图默认尺寸
  defaultEditSize: string;     // 图生图默认尺寸
  supportedModels: string[];   // 文生图支持的模型
  editModels: string[];        // 图生图支持的模型
}

// Hugging Face 配置 (使用 HF Spaces Gradio API，支持多 URL 故障转移)
export const HuggingFaceConfig: HuggingFaceProviderConfigExtended = {
  // 文生图 URL 资源池：当一个失败时自动切换到下一个
  apiUrls: [
    "https://luca115-z-image-turbo.hf.space",
    "https://linoyts-z-image-portrait.hf.space",
    "https://prokofyev8-z-image-portrait.hf.space",
    "https://yingzhac-z-image-nsfw.hf.space",
  ],
  // 图生图/融合生图 URL 资源池（Qwen-Image-Edit-2511）
  editApiUrls: [
    "https://lenml-qwen-image-edit-2511-fast.hf.space",
  ],
  defaultModel: "z-image-turbo",              // 文生图默认模型
  defaultEditModel: "Qwen-Image-Edit-2511",   // 图生图默认模型
  defaultSize: "1024x1024",                   // 文生图默认尺寸（HF Spaces 免费版限制）
  defaultEditSize: "1024x1024",               // 图生图默认尺寸（HF Spaces 免费版限制）
  supportedModels: [
    "z-image-turbo",
  ],
  editModels: [
    "Qwen-Image-Edit-2511",
  ],
};

// 统一超时时间：300秒（适用于所有渠道的 API 请求，给生图留足时间）
export const API_TIMEOUT_MS = 300000;

// 服务端口
export const PORT = parseInt(Deno.env.get("PORT") || "10001");
