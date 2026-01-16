/**
 * @fileoverview Provider 类型定义
 * 
 * 定义图片生成服务提供商的通用类型和接口。
 * 
 * 注意：
 * - Provider 的具体行为接口 IProvider 定义在 src/providers/base.ts 中
 * - 各 Provider 的配置常量定义在 src/config/manager.ts 中
 * - 此文件仅包含被多个模块（如配置、处理程序、日志）共享的基础类型
 */

import type { ImageData } from "./request.ts";

/** 
 * 支持的服务提供商类型枚举 
 */
export type ProviderType =
  | "Doubao"      // 字节跳动豆包
  | "Gitee"       // Gitee AI
  | "ModelScope"  // 阿里魔搭社区
  | "HuggingFace" // Hugging Face Spaces
  | "Pollinations"// Pollinations AI
  | "Unknown";    // 未知提供商

/** 
 * 图片生成结果接口
 * 标准化各提供商的返回数据结构
 */
export interface GenerationResult {
  /** 是否生成成功 */
  success: boolean;
  /** 生成的图片数据列表（URL 或 Base64） */
  images?: ImageData[];
  /** 实际使用的模型名称 */
  model?: string;
  /** 执行生成的提供商名称 */
  provider?: string;
  /** 错误信息（仅在 success 为 false 时存在） */
  error?: string;
  /** 生成过程耗时（毫秒） */
  duration?: number;
  /** 流式响应流 (ReadableStream) */
  stream?: ReadableStream;
}
