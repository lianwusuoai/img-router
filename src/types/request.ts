/**
 * @fileoverview 请求/响应类型定义
 * 
 * 定义了符合 OpenAI API 标准的请求和响应数据结构。
 * 同时也包含了一些为了兼容其他格式（如 Cherry Studio）而定义的扩展类型。
 */

/** 
 * 文本内容项 
 * 用于多模态消息中的文本部分
 */
export interface TextContentItem {
  type: "text";
  text: string;
}

/** 
 * 图片 URL 内容项 
 * 标准 OpenAI 格式，用于传递图片链接
 */
export interface ImageUrlContentItem {
  type: "image_url";
  image_url?: { url: string };
}

/** 
 * 非标准图片内容项 
 * 兼容部分客户端（如 Cherry Studio）直接传递 Base64 的格式
 */
export interface NonStandardImageContentItem {
  type: "image";
  /** 纯 Base64 数据（无 data URI 前缀） */
  image: string;
  /** 媒体类型 (例如 "image/png") */
  mediaType?: string;
}

/** 
 * 消息内容项联合类型 
 * 消息内容可以是纯文本，也可以是多模态数组
 */
export type MessageContentItem =
  | TextContentItem
  | ImageUrlContentItem
  | NonStandardImageContentItem;

/** 
 * 聊天消息接口 
 */
export interface Message {
  /** 角色 (system, user, assistant) */
  role: string;
  /** 消息内容（字符串或多模态数组） */
  content: string | MessageContentItem[];
}

/** 
 * Chat Completions (聊天补全) 请求格式 
 * 对应 POST /v1/chat/completions
 */
export interface ChatRequest {
  /** 模型名称 */
  model?: string;
  /** 消息列表 */
  messages: Message[];
  /** 是否流式输出 */
  stream?: boolean;
  /** 期望的图片尺寸（自定义扩展字段） */
  size?: string;
  /** 允许其他任意扩展字段 */
  [key: string]: unknown;
}

/** 
 * OpenAI Images (文生图) 请求格式 
 * 对应 POST /v1/images/generations
 */
export interface ImagesRequest {
  /** 模型名称 */
  model?: string;
  /** 图片生成的提示词 */
  prompt: string;
  /** 生成数量 */
  n?: number;
  /** 图片尺寸 (如 "1024x1024") */
  size?: string;
  /** 响应格式 ("url" 或 "b64_json") */
  response_format?: "url" | "b64_json";
  /** 是否流式输出 */
  stream?: boolean;
  /** 允许其他任意扩展字段 */
  [key: string]: unknown;
}

/** 
 * OpenAI Images Edit (图生图/修图) 请求格式 
 * 对应 POST /v1/images/edits
 */
export interface ImagesEditRequest {
  /** 模型名称 */
  model?: string;
  /** 图片编辑的提示词 */
  prompt: string;
  /** 原始图片（支持 File, Blob 或 Base64 字符串） */
  image: File | Blob | string;
  /** 遮罩图片（可选，支持 File, Blob 或 Base64 字符串） */
  mask?: File | Blob | string;
  /** 生成数量 */
  n?: number;
  /** 图片尺寸 */
  size?: string;
  /** 响应格式 */
  response_format?: "url" | "b64_json";
  /** 是否流式输出 */
  stream?: boolean;
  /** 允许其他任意扩展字段 */
  [key: string]: unknown;
}

/** 
 * 图片数据接口 
 * 响应中单张图片的数据结构
 */
export interface ImageData {
  /** 图片 URL */
  url?: string;
  /** 图片 Base64 数据 */
  b64_json?: string;
}

/** 
 * Chat Completions (聊天补全) 响应格式 
 */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 
 * Chat Completions 流式响应块格式 (SSE) 
 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }[];
}

/** 
 * Images API 标准响应格式 
 */
export interface ImagesResponse {
  created: number;
  data: ImageData[];
}

/** 
 * 内部图片生成请求对象 
 * 经过标准化的请求数据，供 Provider 内部使用
 */
export interface ImageGenerationRequest {
  /** 提示词 */
  prompt: string;
  /** 输入图片数组（URL 或 Base64，用于图生图） */
  images: string[];
  /** 模型名称 */
  model?: string;
  /** 生成数量 */
  n?: number;
  /** 图片尺寸 */
  size?: string;
  /** 响应格式 */
  response_format?: "url" | "b64_json";
  /** 对话上下文（用于融合生图） */
  messages?: Message[];
  /** 是否流式输出 */
  stream?: boolean;
  /** 允许其他任意扩展字段 */
  [key: string]: unknown;
}

/** 
 * 融合生图请求格式 (自定义)
 * 对应 POST /v1/images/blend
 * 支持携带对话上下文和图片
 */
export interface ImagesBlendRequest {
  /** 模型名称 */
  model?: string;
  /** 对话历史（包含文本和图片） */
  messages: Message[];
  /** 提示词（可选，如果 messages 中已包含） */
  prompt?: string;
  /** 生成数量 */
  n?: number;
  /** 图片尺寸 */
  size?: string;
  /** 响应格式 */
  response_format?: "url" | "b64_json";
  /** 允许其他任意扩展字段 */
  [key: string]: unknown;
}
