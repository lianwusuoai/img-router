import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { error } from "../core/logger.ts";

/**
 * 服务器配置接口
 */
export interface ServerConfig {
  /** 服务器监听端口 */
  port: number;
  /** API 请求超时时间（毫秒） */
  apiTimeoutMs: number;
  /** 最大请求体大小（字节） */
  maxRequestBodySize: number;
  /** 全局访问密钥，用于简单的身份验证 */
  globalAccessKey: string;
  /** 压缩配置 */
  compress: {
    /** 触发压缩的大小阈值（KB） */
    threshold: number;
    /** 压缩后的目标大小（KB） */
    target: number;
  };
}

/**
 * API 密钥配置接口
 * 存储各个 AI 服务提供商的认证信息
 */
export interface ApiKeysConfig {
  /** 豆包 (Doubao) 配置 */
  doubao: {
    accessKey: string;
    secretKey: string;
  };
  /** Gitee AI 访问令牌 */
  gitee: string;
  /** ModelScope 访问令牌 */
  modelscope: string;
  /** HuggingFace 访问令牌 */
  huggingface: string;
  /** Pollinations AI (通常不需要密钥) */
  pollinations: string;
}

/**
 * 默认生成参数配置
 */
export interface DefaultsConfig {
  /** 默认使用的模型名称 */
  imageModel: string;
  /** 默认图片尺寸 */
  imageSize: string;
  /** 默认图片质量 */
  imageQuality: string;
  /** 默认生成数量 */
  imageCount: number;
}

/**
 * 基础提供商配置接口
 */
export interface BaseProviderConfig {
  /** 是否启用该提供商 */
  enabled: boolean;
  /** API 基础地址 */
  apiUrl: string;
  /** 默认使用的模型 */
  defaultModel: string;
  /** 默认图片尺寸 */
  defaultSize: string;
  /** 默认生成数量 */
  defaultCount?: number;
  /** 默认编辑生成数量 */
  defaultEditCount?: number;
  /** 支持的融合生图模型列表（可选） */
  blendModels?: string[];
  /** 默认融合生图模型（可选） */
  defaultBlendModel?: string;
  /** 默认融合生图尺寸（可选） */
  defaultBlendSize?: string;
  /** 默认融合生图数量（可选） */
  defaultBlendCount?: number;
  /** 支持的模型列表 */
  textModels: string[];
}

/**
 * 豆包提供商配置
 */
export interface DoubaoConfig extends BaseProviderConfig {
  /** 默认编辑图片的尺寸 */
  defaultEditSize?: string;
}

/**
 * Gitee AI 提供商配置
 */
export interface GiteeConfig extends BaseProviderConfig {
  asyncApiUrl: string;
  /** 图片编辑 API 地址 */
  editApiUrl: string;
  /** 异步图片编辑 API 地址 */
  asyncEditApiUrl: string;
  /** 任务状态查询 API 地址 */
  taskStatusUrl: string;
  /** 默认编辑模型 */
  defaultEditModel: string;
  /** 默认异步编辑模型 */
  defaultAsyncEditModel: string;
  /** 默认编辑尺寸 */
  defaultEditSize: string;
  /** 默认异步编辑尺寸 */
  defaultAsyncEditSize: string;
  asyncTextModels: string[];
  /** 支持的编辑模型列表 */
  editModels: string[];
  /** 支持的异步编辑模型列表 */
  asyncEditModels: string[];
}

/**
 * ModelScope 提供商配置
 */
export interface ModelScopeConfig extends BaseProviderConfig {
  /** 默认编辑模型 */
  defaultEditModel: string;
  /** 默认编辑尺寸 */
  defaultEditSize: string;
  /** 支持的编辑模型列表 */
  editModels: string[];
}

/**
 * HuggingFace 提供商配置
 */
export interface HuggingFaceConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 可用的 API 地址列表（用于负载均衡或备选） */
  apiUrls: string[];
  /** 编辑功能的 API 地址列表 */
  editApiUrls?: string[];
  /** 默认生成模型 */
  defaultModel: string;
  /** 默认编辑模型 */
  defaultEditModel: string;
  /** 默认生成尺寸 */
  defaultSize: string;
  /** 默认编辑尺寸 */
  defaultEditSize: string;
  /** 默认推理步数 */
  defaultSteps?: number;
  /** 支持的生成模型列表 */
  textModels: string[];
  /** 支持的编辑模型列表 */
  editModels: string[];
}

/**
 * Pollinations AI 提供商配置
 */
export interface PollinationsConfig extends BaseProviderConfig {
  /** 图片生成端点路径 */
  imageEndpoint?: string;
  /** 默认编辑模型 */
  defaultEditModel: string;
  /** 默认编辑尺寸 */
  defaultEditSize?: string;
  /** 支持的编辑模型列表 */
  editModels: string[];
  /** 随机种子 */
  seed?: number;
  /** 图片质量 */
  quality?: string;
  /** 是否开启透明背景 */
  transparent?: boolean;
  /** 是否增强提示词 */
  enhance?: boolean;
  /** 负面提示词 */
  negativePrompt?: string;
  /** 是否私有模式 */
  private?: boolean;
  /** 是否移除 Logo */
  nologo?: boolean;
  /** 是否不显示在 Feed 中 */
  nofeed?: boolean;
  /** 是否开启安全滤镜 */
  safe?: boolean;
  /** 引导系数 */
  guidanceScale?: number;
}

/**
 * 图床配置接口
 */
export interface ImageBedConfig {
  /** 图床基础 URL */
  baseUrl: string;
  /** 上传端点 */
  uploadEndpoint: string;
  /** 认证码 */
  authCode: string;
  /** 上传文件夹名称 */
  uploadFolder: string;
  /** 上传渠道 (如 s3) */
  uploadChannel: string;
}

/**
 * 日志配置接口
 */
export interface LoggingConfig {
  /** 日志级别 (如 info, debug, error) */
  level: string;
  /** 是否开启详细日志 */
  verbose: boolean;
  /** 是否记录请求日志 */
  request: boolean;
}

/**
 * 功能开关配置
 */
export interface FeaturesConfig {
  /** 是否启用 CORS */
  cors: boolean;
  /** 是否启用健康检查端点 */
  healthCheck: boolean;
}

/**
 * 运行模式配置
 */
export interface ModesConfig {
  /** 中继模式：转发请求到上游服务 */
  relay: boolean;
  /** 后端模式：处理具体的业务逻辑 */
  backend: boolean;
}

/**
 * 应用主配置接口
 */
export interface AppConfig {
  server: ServerConfig;
  apiKeys: ApiKeysConfig;
  defaults: DefaultsConfig;
  providers: {
    doubao: DoubaoConfig;
    gitee: GiteeConfig;
    modelscope: ModelScopeConfig;
    huggingface: HuggingFaceConfig;
    pollinations: PollinationsConfig;
  };
  imageBed: ImageBedConfig;
  logging: LoggingConfig;
  features: FeaturesConfig;
  modes: ModesConfig;
}

// 运行时/系统配置类型 (与 app.ts 预期一致)

/**
 * 密钥池项接口
 */
export interface KeyPoolItem {
  /** API 密钥 */
  key: string;
  /** 所属提供商 */
  provider: string;
  /** 密钥状态 */
  status: "active" | "disabled" | "rate_limited";
  /** 最后使用时间戳 */
  lastUsed?: number;
  /** 错误计数 */
  errorCount?: number;

  // 扩展字段
  id?: string;
  name?: string;
  enabled?: boolean;
  addedAt?: number;
  successCount?: number;
  totalCalls?: number;
}

/**
 * 提供商任务默认配置
 */
export interface ProviderTaskDefaults {
  model?: string | null;
  size?: string | null;
  quality?: string | null;
  n?: number | null;
  steps?: number | null;
  /** 任务权重 (0-100)，用于路由优先级 */
  weight?: number;
  /** 模型映射配置 (自定义ID) */
  modelMap?: string;
  /** 提示词优化器配置 */
  promptOptimizer?: {
    translate?: boolean;
    expand?: boolean;
  };
}

export type ProviderTaskDefaultsPatch = Partial<ProviderTaskDefaults>;

/**
 * 运行时提供商配置
 */
export interface RuntimeProviderConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 默认推理步数 (HuggingFace 等) */
  defaultSteps?: number;
  /** 文本生成任务默认配置 */
  text?: ProviderTaskDefaults;
  /** 编辑任务默认配置 */
  edit?: ProviderTaskDefaults;
  /** 融合生图任务默认配置 */
  blend?: ProviderTaskDefaults;
}

/**
 * 系统配置接口
 */
export interface SystemConfig {
  globalAccessKey?: string;
  modes?: ModesConfig;
  /** 可扩展的其他系统级动态设置 */
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

/**
 * 提示词优化器全局配置 (用于翻译和扩充 Prompt)
 */
export interface PromptOptimizerConfig {
  /** LLM API 基础地址 (OpenAI 兼容) */
  baseUrl: string;
  /** API Key */
  apiKey: string;
  /** 模型名称 */
  model: string;
  /** 是否启用翻译 */
  enableTranslate?: boolean;
  /** 翻译提示词模板 */
  translatePrompt?: string;
  /** 是否启用扩充 */
  enableExpand?: boolean;
  /** 扩充提示词模板 */
  expandPrompt?: string;
}

/**
 * S3/R2 存储配置
 */
export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  publicUrl?: string; // 可选的公共访问域名
}

/**
 * 运行时完整配置
 */
export interface RuntimeConfig {
  system: SystemConfig;
  providers: Record<string, RuntimeProviderConfig>;
  keyPools: Record<string, KeyPoolItem[]>;
  /** 全局提示词优化器配置 */
  promptOptimizer?: PromptOptimizerConfig;
  /** HuggingFace 模型到 URL 的映射配置 */
  hfModelMap?: Record<string, { main: string; backup?: string }>;
  /** 存储配置 */
  storage?: {
    s3?: S3StorageConfig;
    // 可以在此扩展其他存储配置，如 webdav
  };
}

export type DynamicSystemConfig = SystemConfig; // 别名

// 兼容性类型别名
export type GiteeProviderConfig = GiteeConfig;
export type ModelScopeProviderConfig = ModelScopeConfig;
export type HuggingFaceProviderConfig = HuggingFaceConfig;
export type PollinationsProviderConfig = PollinationsConfig;
export type DoubaoProviderConfig = DoubaoConfig;

// ============================================================================\n// 常量与默认值\n// ============================================================================

/** 支持的图片尺寸列表 */
export const SUPPORTED_SIZES = [
  "256x256",
  "512x512",
  "1024x1024",
  "1024x768",
  "768x1024",
  "2048x2048",
  "2304x1728",
  "1728x2304",
  "2560x1440",
  "1440x2560",
  "2496x1664",
  "1664x2496",
  "3024x1296",
  "4096x4096",
];

/** 宽高比到具体尺寸的映射 */
export const SIZE_MAPPING: Record<string, string> = {
  "1:1": "2048x2048",
  "4:3": "2304x1728",
  "3:4": "1728x2304",
  "16:9": "2560x1440",
  "9:16": "1440x2560",
  "3:2": "2496x1664",
  "2:3": "1664x2496",
  "21:9": "3024x1296",
};

/** ModelScope 支持的尺寸列表 (基于 Qwen-Image 能力) */
export const MODELSCOPE_SIZES = [
  "1024x1024", // 1:1
  "1280x720", // 16:9
  "720x1280", // 9:16
  "1024x768", // 4:3
  "768x1024", // 3:4
  "2048x2048", // 1:1 高清
  "2560x1440", // 16:9 高清
  "1440x2560", // 9:16 高清
];

/**
 * 默认应用配置
 * 包含所有服务的初始设置
 */
const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 10001,
    apiTimeoutMs: 60000,
    maxRequestBodySize: 20971520, // 20MB
    globalAccessKey: "",
    compress: {
      threshold: 10,
      target: 5,
    },
  },
  apiKeys: {
    doubao: {
      accessKey: "",
      secretKey: "",
    },
    gitee: "",
    modelscope: "",
    huggingface: "",
    pollinations: "",
  },
  defaults: {
    imageModel: "doubao-seedream-4-5-251128",
    imageSize: "2048x2048",
    imageQuality: "standard",
    imageCount: 1,
  },
  providers: {
    doubao: {
      enabled: true,
      apiUrl: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
      defaultModel: "doubao-seedream-4-5-251128",
      defaultSize: "2048x2048",
      defaultCount: Number(process.env.DOUBAO_DEFAULT_COUNT) || 1, // 优先读取环境变量，默认为 1
      defaultEditSize: "2048x2048",
      textModels: [
        "doubao-seedream-4-5-251128",
        "doubao-seedream-4-0-250828",
      ],
    },
    gitee: {
      enabled: true,
      apiUrl: "https://ai.gitee.com/v1/images/generations",
      asyncApiUrl: "https://ai.gitee.com/v1/async/images/generations",
      editApiUrl: "https://ai.gitee.com/v1/images/edits",
      asyncEditApiUrl: "https://ai.gitee.com/v1/async/images/edits",
      taskStatusUrl: "https://ai.gitee.com/v1/task",
      defaultModel: "z-image-turbo",
      defaultEditModel: "Qwen-Image-Edit",
      defaultAsyncEditModel: "Qwen-Image-Edit-2511",
      defaultSize: "2048x2048",
      defaultEditSize: "1024x1024",
      defaultAsyncEditSize: "2048x2048",
      textModels: [
        "FLUX.1-dev",
        "Kolors",
        "z-image-turbo",
        "stable-diffusion-3.5-large-turbo",
        "LongCat-Image",
        "flux-1-schnell",
        "Qwen-Image-2512",
        "stable-diffusion-xl-base-1.0",
        "Qwen-Image",
        "HiDream-I1-Full",
        "FLUX.2-dev",
        "HunyuanDiT-v1.2-Diffusers-Distilled",
        "CogView4_6B",
        "stable-diffusion-3-medium",
        "FLUX_1-Krea-dev",
      ],
      asyncTextModels: [
        "FLUX.1-dev",
        "LongCat-Image",
        "flux-1-schnell",
        "Qwen-Image-2512",
        "Qwen-Image",
      ],
      editModels: [
        "Qwen-Image-Edit",
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
      asyncEditModels: [
        "Qwen-Image-Edit-2511",
        "LongCat-Image-Edit",
        "FLUX.1-Kontext-dev",
      ],
    },
    modelscope: {
      enabled: true,
      apiUrl: "https://api-inference.modelscope.cn/v1",
      defaultModel: "Tongyi-MAI/Z-Image-Turbo",
      defaultEditModel: "Qwen/Qwen-Image-Edit",
      defaultSize: "1024x1024",
      defaultEditSize: "1024x1024",
      textModels: [
        "Tongyi-MAI/Z-Image-Turbo",
      ],
      editModels: [
        "Qwen/Qwen-Image-Edit-2511",
        "Qwen/Qwen-Image-Edit-2509",
        "Qwen/Qwen-Image-Edit",
      ],
      blendModels: [
        "Qwen/Qwen-Image-Edit-2511",
        "Qwen/Qwen-Image-Edit-2509",
        "Qwen/Qwen-Image-Edit",
      ],
    },
    huggingface: {
      enabled: true,
      apiUrls: [
        "https://mrfakename-z-image-turbo.hf.space",
        "https://luca115-z-image-turbo.hf.space",
        "https://linoyts-z-image-portrait.hf.space",
        "https://prokofyev8-z-image-portrait.hf.space",
        "https://yingzhac-z-image-nsfw.hf.space",
      ],
      editApiUrls: [
        "https://lenml-qwen-image-edit-2511-fast.hf.space",
      ],
      defaultModel: "z-image-turbo",
      defaultEditModel: "Qwen-Image-Edit-2511",
      defaultSize: "1024x1024",
      defaultEditSize: "1024x1024",
      defaultSteps: 4,
      textModels: [
        "z-image-turbo",
      ],
      editModels: [
        "Qwen-Image-Edit-2511",
      ],
    },
    pollinations: {
      enabled: true,
      apiUrl: "https://image.pollinations.ai",
      imageEndpoint: "/prompt",
      defaultModel: "flux",
      defaultEditModel: "nanobanana-pro",
      defaultSize: "1024x1024",
      defaultEditSize: "1024x1024",
      defaultBlendModel: "nanobanana-pro",
      defaultBlendSize: "1024x1024",
      textModels: [
        "turbo",
        "flux",
        "zimage",
        "nanobanana",
        "gptimage",
        "kontext",
        "seedream",
        "nanobanana-pro",
        "seedream-pro",
        "gptimage-large",
        "veo",
        "seedance",
        "seedance-pro",
      ],
      editModels: [
        "kontext",
        "nanobanana",
        "nanobanana-pro",
        "seedream",
        "seedream-pro",
        "gptimage",
        "gptimage-large",
      ],
      blendModels: [
        "kontext",
        "nanobanana",
        "nanobanana-pro",
        "seedream",
        "seedream-pro",
        "gptimage",
        "gptimage-large",
      ],
      seed: -1,
      quality: "hd",
      transparent: false,
      enhance: true,
      negativePrompt: "",
      private: true,
      nologo: true,
      nofeed: false,
      safe: false,
    },
  },
  imageBed: {
    baseUrl: "https://imgbed.lianwusuoai.top",
    uploadEndpoint: "/upload",
    authCode: "imgbed_xKAGfobLGhsEBEMlt5z0yvYdtw8zNTM6",
    uploadFolder: "img-router",
    uploadChannel: "s3",
  },
  logging: {
    level: "info",
    verbose: true,
    request: true,
  },
  features: {
    cors: true,
    healthCheck: true,
  },
  modes: {
    relay: true,
    backend: false,
  },
};

export const DOUBAO_MODELS = DEFAULT_CONFIG.providers.doubao.textModels;
export const GITEE_MODELS = DEFAULT_CONFIG.providers.gitee.textModels;
export const MODELSCOPE_MODELS = DEFAULT_CONFIG.providers.modelscope.textModels;
export const HUGGINGFACE_MODELS = DEFAULT_CONFIG.providers.huggingface.textModels;
export const POLLINATIONS_MODELS = DEFAULT_CONFIG.providers.pollinations.textModels;
export const ALL_TEXT_MODELS = [
  ...DOUBAO_MODELS,
  ...GITEE_MODELS,
  ...MODELSCOPE_MODELS,
  ...HUGGINGFACE_MODELS,
  ...POLLINATIONS_MODELS,
];

/**
 * 默认运行时配置模板（已移除敏感信息）
 */
const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  system: {
    requestLogging: true,
    healthCheck: true,
    modes: {
      relay: true,
      backend: false
    },
    port: 10001,
    apiTimeout: 60000,
    maxBodySize: 20971520,
    cors: true,
    globalAccessKey: "", // 移除敏感key
    compressThreshold: 5,
    compressTarget: 2
  },
  providers: {
    Doubao: {
      enabled: true,
      text: { weight: 10 },
      edit: { model: "doubao-seedream-4-5-251128", size: "2048x2048", quality: "standard", n: 1 },
      blend: { model: "doubao-seedream-4-5-251128", size: "1024x1024", quality: "standard", n: 1 }
    },
    Gitee: {
      enabled: true,
      text: { weight: 10 },
      edit: { model: "Qwen-Image-Edit", size: "1024x1024", quality: "standard", n: 1 },
      blend: { model: "Qwen-Image-Edit", size: "2048x2048", quality: "standard", n: 1 }
    },
    ModelScope: {
      enabled: true,
      text: { model: "Tongyi-MAI/Z-Image-Turbo", size: "1024x1024", quality: "standard", n: 2 },
      edit: { model: "Qwen/Qwen-Image-Edit", size: "1328x1328", quality: "standard", n: 1 },
      blend: { model: "Qwen/Qwen-Image-Edit-2511", size: "1328x1328", quality: "standard", n: 1 }
    },
    HuggingFace: {
      enabled: true,
      text: { weight: 5 },
      edit: { model: "Qwen-Image-Edit-2511", size: "1024x1024", quality: "standard", n: 1 },
      blend: { model: "z-image-turbo", size: "1024x1024", quality: "standard", n: 1 }
    },
    Pollinations: {
      enabled: true,
      text: { model: "zimage", size: "1024x1024", quality: "standard", n: 2 },
      edit: { model: "nanobanana-pro", size: "1024x1024", quality: "standard", n: 1 },
      blend: { model: "kontext", size: "1024x1024", quality: "standard", n: 1 }
    },
    MockA: {
      text: { model: "sdxl", weight: 100 }
    },
    MockB: {
      text: { model: "mj-v6", weight: 50 }
    }
  },
  keyPools: {
    Doubao: [],
    HuggingFace: [],
    Gitee: []
  },
  promptOptimizer: {
    baseUrl: "https://api.lianwusuoai.top/v1",
    apiKey: "", // 移除敏感key
    model: "翻译",
    enableTranslate: true,
    translatePrompt: "I am a master AI image prompt engineering advisor, specializing in crafting prompts that yield cinematic, hyper-realistic, and deeply evocative visual narratives, optimized for advanced generative models.\\nMy core purpose is to meticulously rewrite, expand, and enhance user's image prompts.\\nI transform prompts to create visually stunning images by rigorously optimizing elements such as dramatic lighting, intricate textures, compelling composition, and a distinctive artistic style.\\nMy generated prompt output will be strictly under 300 words. Prior to outputting, I will internally validate that the refined prompt strictly adheres to the word count limit and effectively incorporates the intended stylistic and technical enhancements.\\nMy output will consist exclusively of the refined image prompt text. It will commence immediately, with no leading whitespace.\\nThe text will strictly avoid markdown, quotation marks, conversational preambles, explanations, or concluding remarks. Please describe the content using prose-style sentences.\\nThe character's face is clearly visible and unobstructed.",
    enableExpand: true,
    expandPrompt: "You are a professional language translation engine.\\nYour sole responsibility is to translate user-provided text into English. Before processing any input, you must first identify its original language.\\nIf the input text is already in English, return the original English text directly without any modification. If the input text is not in English, translate it precisely into English.\\nYour output must strictly adhere to the following requirements: it must contain only the final English translation or the original English text, without any explanations, comments, descriptions, prefixes, suffixes, quotation marks, or other non-translated content."
  }
};

/**
 * 配置管理器类
 * 负责加载、合并和管理应用程序的静态与动态配置
 */
class ConfigManager {
  private config: AppConfig;
  private runtimeConfig: RuntimeConfig;
  private readonly runtimeConfigPath: string;
  private readonly legacyRuntimeConfigPath: string;

  constructor() {
    this.runtimeConfigPath = path.resolve(process.cwd(), "data", "runtime-config.json");
    this.legacyRuntimeConfigPath = path.resolve(process.cwd(), "runtime-config.json");

    // 初始化为默认配置
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.runtimeConfig = this.loadRuntimeConfig();

    const { config: sanitized, changed } = this.sanitizeRuntimeConfig(this.runtimeConfig);
    if (changed) {
      this.runtimeConfig = sanitized;
      this.saveRuntimeConfig();
    }

    // 将运行时配置合并到应用配置中
    this.applyRuntimeOverrides();
  }

  private sanitizeRuntimeConfig(
    config: RuntimeConfig,
  ): { config: RuntimeConfig; changed: boolean } {
    let changed = false;
    const providers: Record<string, RuntimeProviderConfig> = {};

    for (const [name, raw] of Object.entries(config.providers || {})) {
      if (!raw || typeof raw !== "object") {
        changed = true;
        continue;
      }

      const r = raw as Record<string, unknown>;
      const next: RuntimeProviderConfig = {};

      if (typeof r.enabled === "boolean") {
        next.enabled = r.enabled;
      } else if ("enabled" in r) {
        changed = true;
      }

      if (typeof r.defaultSteps === "number") {
        next.defaultSteps = r.defaultSteps;
      } else if ("defaultSteps" in r && r.defaultSteps !== null) {
        // 如果存在但不是数字，或者是 null，视情况处理
        // 这里简单起见，如果是不合法的就丢弃（changed=true）
        changed = true;
      }

      const sanitizeDefaults = (val: unknown): ProviderTaskDefaults | undefined => {
        if (!val || typeof val !== "object") return undefined;
        const v = val as Record<string, unknown>;
        const out: ProviderTaskDefaults = {};

        if (typeof v.model === "string" || v.model === null) out.model = v.model as string | null;
        if (typeof v.size === "string" || v.size === null) out.size = v.size as string | null;
        if (typeof v.quality === "string" || v.quality === null) {
          out.quality = v.quality as string | null;
        }
        if (typeof v.n === "number" || v.n === null) out.n = v.n as number | null;
        if (typeof v.steps === "number" || v.steps === null) out.steps = v.steps as number | null;
        if (typeof v.weight === "number") out.weight = v.weight;

        // 处理 promptOptimizer
        if (v.promptOptimizer && typeof v.promptOptimizer === "object") {
          const po = v.promptOptimizer as Record<string, unknown>;
          out.promptOptimizer = {
            translate: typeof po.translate === "boolean" ? po.translate : undefined,
            expand: typeof po.expand === "boolean" ? po.expand : undefined,
          };
        }

        const allowedKeys = new Set(["model", "size", "quality", "n", "weight", "promptOptimizer", "steps"]);
        for (const k of Object.keys(v)) {
          if (!allowedKeys.has(k)) {
            changed = true;
            break;
          }
        }

        return out;
      };

      const text = sanitizeDefaults(r.text);
      if (text) next.text = text;

      const edit = sanitizeDefaults(r.edit);
      if (edit) next.edit = edit;

      const blend = sanitizeDefaults(r.blend);
      if (blend) next.blend = blend;

      const allowedProviderKeys = new Set(["enabled", "text", "edit", "blend"]);
      for (const k of Object.keys(r)) {
        if (!allowedProviderKeys.has(k)) {
          changed = true;
          break;
        }
      }

      providers[name] = next;
    }

    let promptOptimizer: PromptOptimizerConfig | undefined;
    if (config.promptOptimizer && typeof config.promptOptimizer === "object") {
      const po = config.promptOptimizer as unknown as Record<string, unknown>;
      promptOptimizer = {
        baseUrl: typeof po.baseUrl === "string" ? po.baseUrl : "",
        apiKey: typeof po.apiKey === "string" ? po.apiKey : "",
        model: typeof po.model === "string" ? po.model : "",
        enableTranslate: typeof po.enableTranslate === "boolean" ? po.enableTranslate : undefined,
        translatePrompt: typeof po.translatePrompt === "string" ? po.translatePrompt : undefined,
        enableExpand: typeof po.enableExpand === "boolean" ? po.enableExpand : undefined,
        expandPrompt: typeof po.expandPrompt === "string" ? po.expandPrompt : undefined,
      };
    } else if ("promptOptimizer" in (config as unknown as Record<string, unknown>)) {
      changed = true;
    }

    let storage: RuntimeConfig["storage"] | undefined;
    if (config.storage && typeof config.storage === "object") {
      const s = config.storage as Record<string, unknown>;
      const s3Raw = s.s3;
      if (s3Raw && typeof s3Raw === "object") {
        const s3 = s3Raw as Record<string, unknown>;
        if (
          typeof s3.endpoint === "string" &&
          typeof s3.bucket === "string" &&
          typeof s3.accessKey === "string" &&
          typeof s3.secretKey === "string"
        ) {
          storage = {
            s3: {
              endpoint: s3.endpoint,
              bucket: s3.bucket,
              accessKey: s3.accessKey,
              secretKey: s3.secretKey,
              region: typeof s3.region === "string" ? s3.region : undefined,
              publicUrl: typeof s3.publicUrl === "string" ? s3.publicUrl : undefined,
            },
          };
        } else {
          changed = true;
        }
      }
    } else if ("storage" in (config as unknown as Record<string, unknown>)) {
      changed = true;
    }

    return {
      changed,
      config: {
        system: config.system || {},
        providers,
        keyPools: config.keyPools || {},
        promptOptimizer,
        hfModelMap: config.hfModelMap,
        storage,
      },
    };
  }

  /**
   * 加载运行时配置
   * 从 runtime-config.json 文件读取配置，如果文件不存在则返回空配置
   * @returns {RuntimeConfig} 运行时配置对象
   */
  private loadRuntimeConfig(): RuntimeConfig {
    try {
      // 确保 data 目录存在
      const dataDir = path.dirname(this.runtimeConfigPath);
      if (!fs.existsSync(dataDir)) {
        console.log("创建数据目录:", dataDir);
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // 如果 runtime-config.json 不存在，则使用默认模板创建
      if (!fs.existsSync(this.runtimeConfigPath)) {
        console.log("创建默认 runtime-config.json");
        // 使用深拷贝创建初始配置
        const initialConfig = JSON.parse(JSON.stringify(DEFAULT_RUNTIME_CONFIG));
        fs.writeFileSync(this.runtimeConfigPath, JSON.stringify(initialConfig, null, 2), "utf8");
        return initialConfig;
      }

      if (fs.existsSync(this.runtimeConfigPath)) {
        const content = fs.readFileSync(this.runtimeConfigPath, "utf8");
        const loaded = JSON.parse(content);
        // 基本的迁移/验证逻辑（如果需要）
        return {
          system: loaded.system || {},
          providers: loaded.providers || {},
          keyPools: loaded.keyPools || {},
          promptOptimizer: loaded.promptOptimizer,
          hfModelMap: loaded.hfModelMap,
          storage: loaded.storage,
        };
      }

      if (fs.existsSync(this.legacyRuntimeConfigPath)) {
        const content = fs.readFileSync(this.legacyRuntimeConfigPath, "utf8");
        const loaded = JSON.parse(content);
        return {
          system: loaded.system || {},
          providers: loaded.providers || {},
          keyPools: loaded.keyPools || {},
          promptOptimizer: loaded.promptOptimizer,
          hfModelMap: loaded.hfModelMap,
          storage: loaded.storage,
        };
      }
    } catch (e) {
      error("Config", "加载 runtime-config.json 失败: " + e);
    }
    return {
      system: {},
      providers: {},
      keyPools: {},
      promptOptimizer: undefined,
      hfModelMap: undefined,
      storage: undefined,
    };
  }

  /**
   * 应用运行时覆盖
   * 将动态配置覆盖到静态配置上，优先级：Env Vars > Runtime Config > Default Config
   */
  private applyRuntimeOverrides() {
    // 1. 应用系统配置 (全局密钥, 模式)
    if (this.runtimeConfig.system.globalAccessKey !== undefined) {
      this.config.server.globalAccessKey = this.runtimeConfig.system.globalAccessKey;
    }
    if (this.runtimeConfig.system.modes) {
      this.config.modes = { ...this.config.modes, ...this.runtimeConfig.system.modes };
    }

    // 2. 应用提供商覆盖 (启用状态)
    for (const [providerName, pConfig] of Object.entries(this.runtimeConfig.providers)) {
      if (pConfig.enabled !== undefined) {
        // deno-lint-ignore no-explicit-any
        const appProvider = (this.config.providers as any)[providerName];
        if (appProvider) {
          appProvider.enabled = pConfig.enabled;
        }
      }
    }

    // 3. 应用环境变量 (最高优先级)
    if (process.env.PORT) this.config.server.port = parseInt(process.env.PORT);
    if (process.env.API_TIMEOUT_MS) {
      this.config.server.apiTimeoutMs = parseInt(process.env.API_TIMEOUT_MS);
    }
    if (process.env.LOG_LEVEL) this.config.logging.level = process.env.LOG_LEVEL;
  }

  /**
   * 保存运行时配置到磁盘
   */
  public saveRuntimeConfig() {
    try {
      const runtimeDir = path.dirname(this.runtimeConfigPath);
      if (!fs.existsSync(runtimeDir)) {
        fs.mkdirSync(runtimeDir, { recursive: true });
      }
      fs.writeFileSync(this.runtimeConfigPath, JSON.stringify(this.runtimeConfig, null, 2));
    } catch (e) {
      console.error("保存运行时配置失败", e);
    }
  }

  // ==========================================
  // Getters - 获取具体配置项
  // ==========================================

  get PORT() {
    return this.config.server.port;
  }
  get API_TIMEOUT_MS() {
    return this.config.server.apiTimeoutMs;
  }
  get MAX_REQUEST_BODY_SIZE() {
    return this.config.server.maxRequestBodySize;
  }
  get GLOBAL_ACCESS_KEY() {
    return this.config.server.globalAccessKey;
  }
  get COMPRESS_THRESHOLD() {
    return this.config.server.compress.threshold;
  }
  get COMPRESS_TARGET() {
    return this.config.server.compress.target;
  }

  get LOG_LEVEL() {
    return this.config.logging.level;
  }
  get VERBOSE_LOGGING() {
    return this.config.logging.verbose;
  }
  get ENABLE_CORS() {
    return this.config.features.cors;
  }
  get ENABLE_REQUEST_LOGGING() {
    return this.config.logging.request;
  }
  get ENABLE_HEALTH_CHECK() {
    return this.config.features.healthCheck;
  }

  get DOUBAO_ACCESS_KEY() {
    return this.config.apiKeys.doubao.accessKey;
  }
  get DOUBAO_SECRET_KEY() {
    return this.config.apiKeys.doubao.secretKey;
  }
  get GITEE_AI_API_KEY() {
    return this.config.apiKeys.gitee;
  }
  get MODELSCOPE_API_KEY() {
    return this.config.apiKeys.modelscope;
  }
  get HUGGINGFACE_API_KEY() {
    return this.config.apiKeys.huggingface;
  }
  get POLLINATIONS_API_KEY() {
    return this.config.apiKeys.pollinations;
  }

  get DEFAULT_IMAGE_MODEL() {
    return this.config.defaults.imageModel;
  }
  get DEFAULT_IMAGE_SIZE() {
    return this.config.defaults.imageSize;
  }
  get DEFAULT_IMAGE_QUALITY() {
    return this.config.defaults.imageQuality;
  }
  get DEFAULT_IMAGE_COUNT() {
    return this.config.defaults.imageCount;
  }

  get DoubaoConfig() {
    return this.config.providers.doubao;
  }
  get GiteeConfig() {
    return this.config.providers.gitee;
  }
  get ModelScopeConfig() {
    return this.config.providers.modelscope;
  }
  get HuggingFaceConfig() {
    return this.config.providers.huggingface;
  }
  get PollinationsConfig() {
    return this.config.providers.pollinations;
  }

  get ImageBedConfig() {
    return this.config.imageBed;
  }
  get ModesConfig() {
    return this.config.modes;
  }

  // ==========================================
  // Methods - 配置操作方法
  // ==========================================

  /**
   * 获取系统配置
   * 返回合并后的系统配置，与 app.ts 预期兼容
   */
  public getSystemConfig(): SystemConfig {
    return {
      globalAccessKey: this.config.server.globalAccessKey,
      modes: this.config.modes,
      ...this.runtimeConfig.system,
    };
  }

  /**
   * 获取完整的运行时配置对象
   */
  public getRuntimeConfig(): RuntimeConfig {
    return this.runtimeConfig;
  }

  /**
   * 更新系统配置
   * @param {Partial<SystemConfig>} patch - 要更新的配置项
   */
  public updateSystemConfig(patch: Partial<SystemConfig>) {
    this.runtimeConfig.system = { ...this.runtimeConfig.system, ...patch };
    this.saveRuntimeConfig();
    this.applyRuntimeOverrides();
  }

  /**
   * 替换整个运行时配置
   * @param {RuntimeConfig} newConfig - 新的运行时配置对象
   */
  public replaceRuntimeConfig(newConfig: RuntimeConfig) {
    this.runtimeConfig = newConfig;
    this.saveRuntimeConfig();
    this.applyRuntimeOverrides();
  }

  /**
   * 获取提供商的任务默认配置
   * @param {string} provider - 提供商名称
   * @param {string} [task] - 任务类型 (如 'text', 'edit')
   * @returns {ProviderTaskDefaults} 任务默认配置
   */
  public getProviderTaskDefaults(provider: string, task?: string): ProviderTaskDefaults {
    // 优先尝试精确匹配，然后尝试小写匹配
    let config = this.runtimeConfig.providers[provider];
    if (!config) {
      // 尝试查找小写键
      const lowerProvider = provider.toLowerCase();
      if (this.runtimeConfig.providers[lowerProvider]) {
        config = this.runtimeConfig.providers[lowerProvider];
      }
    }

    if (!config) return {};
    if (task === "text" || task === "edit" || task === "blend") {
      return config[task] || {};
    }
    return config.text || {};
  }

  /**
   * 设置提供商的任务默认配置
   * @param {string} provider - 提供商名称
   * @param {string} task - 任务类型
   * @param {ProviderTaskDefaults} defaults - 默认配置对象
   */
  public setProviderTaskDefaults(provider: string, task: string, defaults: ProviderTaskDefaults) {
    if (!this.runtimeConfig.providers[provider]) {
      this.runtimeConfig.providers[provider] = {};
    }
    if (task === "text" || task === "edit" || task === "blend") {
      this.runtimeConfig.providers[provider][task] = defaults;
    }
    this.saveRuntimeConfig();
  }

  /**
   * 启用或禁用提供商
   * @param {string} provider - 提供商名称
   * @param {boolean} enabled - 是否启用
   */
  public setProviderEnabled(provider: string, enabled: boolean) {
    if (!this.runtimeConfig.providers[provider]) {
      this.runtimeConfig.providers[provider] = {};
    }
    this.runtimeConfig.providers[provider].enabled = enabled;
    this.saveRuntimeConfig();
    this.applyRuntimeOverrides();
  }

  /**
   * 获取提供商的密钥池
   * @param {string} provider - 提供商名称
   * @returns {KeyPoolItem[]} 密钥列表
   */
  public getKeyPool(provider: string): KeyPoolItem[] {
    return this.runtimeConfig.keyPools?.[provider] || [];
  }

  /**
   * 更新提供商的密钥池
   * @param {string} provider - 提供商名称
   * @param {KeyPoolItem[]} keys - 新的密钥列表
   */
  public updateKeyPool(provider: string, keys: KeyPoolItem[]) {
    if (!this.runtimeConfig.keyPools) this.runtimeConfig.keyPools = {};
    this.runtimeConfig.keyPools[provider] = keys;
    this.saveRuntimeConfig();
  }

  /**
   * 获取下一个可用的密钥
   * 从活跃密钥中随机选择一个
   * @param {string} provider - 提供商名称
   * @returns {string | null} 密钥，如果没有可用密钥则返回 null
   */
  public getNextAvailableKey(provider: string): string | null {
    const keys = this.getKeyPool(provider);
    const activeKeys = keys.filter((k) =>
      k.status === "active" || (k.enabled !== false && k.status !== "disabled")
    );
    if (activeKeys.length === 0) return null;
    return activeKeys[Math.floor(Math.random() * activeKeys.length)].key;
  }

  /**
   * 报告密钥错误
   * 增加错误计数，如果超过阈值则禁用该密钥
   * @param {string} provider - 提供商名称
   * @param {string} key - 密钥
   * @param {string} [_reason] - 错误原因
   */
  public reportKeyError(provider: string, key: string, _reason?: string) {
    const keys = this.getKeyPool(provider);
    const item = keys.find((k) => k.key === key);
    if (item) {
      item.errorCount = (item.errorCount || 0) + 1;
      if (item.errorCount > 5) item.status = "disabled";
      this.updateKeyPool(provider, keys);
    }
  }

  /**
   * 报告密钥使用成功
   * 重置错误计数，更新使用统计
   * @param {string} provider - 提供商名称
   * @param {string} key - 密钥
   */
  public reportKeySuccess(provider: string, key: string) {
    const keys = this.getKeyPool(provider);
    const item = keys.find((k) => k.key === key);
    if (item) {
      item.errorCount = 0;
      item.lastUsed = Date.now();
      item.successCount = (item.successCount || 0) + 1;
      item.totalCalls = (item.totalCalls || 0) + 1;
      this.updateKeyPool(provider, keys);
    }
  }

  /**
   * 检查提供商是否已配置且启用
   * @param {string} provider - 提供商名称
   * @returns {boolean}
   */
  public isProviderConfigured(provider: string): boolean {
    // deno-lint-ignore no-explicit-any
    const p = (this.config.providers as any)?.[provider];
    return p && p.enabled !== false;
  }

  /**
   * 根据模型名称查找对应的提供商
   * @param {string} model - 模型名称
   * @returns {string | null} 提供商名称，如果未找到则返回 null
   */
  public getProviderForModel(model: string): string | null {
    for (const [provider, conf] of Object.entries(this.config.providers)) {
      // deno-lint-ignore no-explicit-any
      if ((conf as any).textModels?.includes(model)) return provider;
    }
    return null;
  }
}

// ============================================================================
// 导出
// ============================================================================

export const configManager = new ConfigManager();

// 扁平化导出，方便直接引用
export const PORT = configManager.PORT;
export const API_TIMEOUT_MS = configManager.API_TIMEOUT_MS;
export const MAX_REQUEST_BODY_SIZE = configManager.MAX_REQUEST_BODY_SIZE;
export const GLOBAL_ACCESS_KEY = configManager.GLOBAL_ACCESS_KEY;
export const COMPRESS_THRESHOLD = configManager.COMPRESS_THRESHOLD;
export const COMPRESS_TARGET = configManager.COMPRESS_TARGET;

export const LOG_LEVEL = configManager.LOG_LEVEL;
export const VERBOSE_LOGGING = configManager.VERBOSE_LOGGING;
export const ENABLE_CORS = configManager.ENABLE_CORS;
export const ENABLE_REQUEST_LOGGING = configManager.ENABLE_REQUEST_LOGGING;
export const ENABLE_HEALTH_CHECK = configManager.ENABLE_HEALTH_CHECK;

export const DOUBAO_ACCESS_KEY = configManager.DOUBAO_ACCESS_KEY;
export const DOUBAO_SECRET_KEY = configManager.DOUBAO_SECRET_KEY;
export const GITEE_AI_API_KEY = configManager.GITEE_AI_API_KEY;
export const MODELSCOPE_API_KEY = configManager.MODELSCOPE_API_KEY;
export const HUGGINGFACE_API_KEY = configManager.HUGGINGFACE_API_KEY;
export const POLLINATIONS_API_KEY = configManager.POLLINATIONS_API_KEY;

export const DEFAULT_IMAGE_MODEL = configManager.DEFAULT_IMAGE_MODEL;
export const DEFAULT_IMAGE_SIZE = configManager.DEFAULT_IMAGE_SIZE;
export const DEFAULT_IMAGE_QUALITY = configManager.DEFAULT_IMAGE_QUALITY;
export const DEFAULT_IMAGE_COUNT = configManager.DEFAULT_IMAGE_COUNT;

export const DoubaoConfig = configManager.DoubaoConfig;
export const GiteeConfig = configManager.GiteeConfig;
export const ModelScopeConfig = configManager.ModelScopeConfig;
export const HuggingFaceConfig = configManager.HuggingFaceConfig;
export const PollinationsConfig = configManager.PollinationsConfig;

export const ImageBedConfig = configManager.ImageBedConfig;
export const ModesConfig = configManager.ModesConfig;

export const getSystemConfig = () => configManager.getSystemConfig();
export const getRuntimeConfig = () => configManager.getRuntimeConfig();
export const updateSystemConfig = (patch: Partial<SystemConfig>) =>
  configManager.updateSystemConfig(patch);
export const replaceRuntimeConfig = (newConfig: RuntimeConfig) =>
  configManager.replaceRuntimeConfig(newConfig);

export const getProviderTaskDefaults = (provider: string, task?: string) =>
  configManager.getProviderTaskDefaults(provider, task);
export const setProviderTaskDefaults = (
  provider: string,
  task: string,
  defaults: ProviderTaskDefaults,
) => configManager.setProviderTaskDefaults(provider, task, defaults);
export const setProviderEnabled = (provider: string, enabled: boolean) =>
  configManager.setProviderEnabled(provider, enabled);

export const getPromptOptimizerConfig = (): PromptOptimizerConfig | undefined => {
  const runtime = configManager.getRuntimeConfig();
  const config = runtime.promptOptimizer;

  const envBaseUrl = process.env.PROMPT_OPTIMIZER_BASE_URL;
  const envApiKey = process.env.PROMPT_OPTIMIZER_API_KEY;
  const envModel = process.env.PROMPT_OPTIMIZER_MODEL;

  if (!config && !envBaseUrl && !envApiKey) {
    return undefined;
  }

  return {
    baseUrl: envBaseUrl || config?.baseUrl || "",
    apiKey: envApiKey || config?.apiKey || "",
    model: envModel || config?.model || "",
    enableTranslate: config?.enableTranslate,
    translatePrompt: config?.translatePrompt,
    enableExpand: config?.enableExpand,
    expandPrompt: config?.expandPrompt,
  };
};
export const updatePromptOptimizerConfig = (config: PromptOptimizerConfig) => {
  const runtime = configManager.getRuntimeConfig();
  runtime.promptOptimizer = config;
  configManager.replaceRuntimeConfig(runtime);
};

export const getHfModelMap = () => configManager.getRuntimeConfig().hfModelMap || {};
export const updateHfModelMap = (map: Record<string, { main: string; backup?: string }>) => {
  const runtime = configManager.getRuntimeConfig();
  runtime.hfModelMap = map;
  configManager.replaceRuntimeConfig(runtime);
};

export const getKeyPool = (provider: string) => configManager.getKeyPool(provider);
export const updateKeyPool = (provider: string, keys: KeyPoolItem[]) =>
  configManager.updateKeyPool(provider, keys);
export const getNextAvailableKey = (provider: string) =>
  configManager.getNextAvailableKey(provider);
export const reportKeyError = (provider: string, key: string, reason?: string) =>
  configManager.reportKeyError(provider, key, reason);
export const reportKeySuccess = (provider: string, key: string) =>
  configManager.reportKeySuccess(provider, key);

export const IMAGE_BED_CONFIG = configManager.ImageBedConfig;
