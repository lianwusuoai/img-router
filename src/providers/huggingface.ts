/**
 * HuggingFace Provider 实现 (V4 升级版)
 *
 * 核心升级：
 * 1. **Token 池与匿名混合模式**：优先使用 Token，耗尽后尝试匿名，支持每日重置。
 * 2. **模型适配器 (Adapters)**：针对 FLUX, SDXL, Qwen 等不同 Space 的参数格式进行动态适配。
 * 3. **精细化 SSE 解析**：精准识别 429 限流、参数错误和服务端错误。
 */

import {
  BaseProvider,
  type GenerationOptions,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderName,
} from "./base.ts";
import type { GenerationResult, ImageGenerationRequest } from "../types/index.ts";
import {
  getHfModelMap,
  getRuntimeConfig,
  HuggingFaceConfig,
} from "../config/manager.ts";
import { fetchWithTimeout } from "../utils/index.ts";
import {
  info,
  warn,
} from "../core/logger.ts";
import { keyManager } from "../core/key-manager.ts";

// ==========================================
// 1. 模型适配器定义
// ==========================================

interface HFModelAdapter {
  constructPayload(prompt: string, params: AdapterParams): unknown[];
}

type AdapterParams = {
  width: number;
  height: number;
  seed?: number;
  steps?: number;
};

const FluxAdapter: HFModelAdapter = {
  constructPayload: (prompt, { width, height, seed, steps }) => {
    // FLUX Space 通常参数: [prompt, seed, randomize_seed, width, height, num_inference_steps]
    // 参考: black-forest-labs/FLUX.1-schnell
    return [
      prompt,
      seed || Math.floor(Math.random() * 1000000),
      !seed, // randomize_seed
      width,
      height,
      steps, // Schnell 默认 4 步
    ];
  },
};

const ZImageAdapter: HFModelAdapter = {
  constructPayload: (prompt, { width, height, seed, steps }) => {
    // Z-Image Turbo 参数: [prompt, height, width, steps, seed, randomize_seed]
    return [
        prompt,
        height,
        width,
        steps,
        seed || Math.floor(Math.random() * 1000000),
        !seed
    ];
  }
};

const GenericAdapter: HFModelAdapter = {
  constructPayload: (prompt, { width, height, seed, steps }) => {
    // 默认通用格式 (兼容旧版): [prompt, negative_prompt, seed, width, height, guidance_scale, steps]
    // 但很多简单的 space 只是 [prompt]
    // 这里保留原 img-router 的通用猜想: [prompt, height, width, steps, seed, false]
    return [
      prompt,
      height,
      width,
      steps,
      seed || Math.floor(Math.random() * 1000000),
      !seed,
    ];
  },
};

function getAdapter(model: string): HFModelAdapter {
  const m = model.toLowerCase();
  if (m.includes("flux")) return FluxAdapter;
  if (m.includes("z-image") || m.includes("turbo")) return ZImageAdapter;
  return GenericAdapter;
}

// ==========================================
// 2. SSE 解析工具
// ==========================================

interface SSEEvent {
    type: string;
    data?: unknown;
}

function parseSSEData(sseText: string): SSEEvent[] {
    const events: SSEEvent[] = [];
    const lines = sseText.split('\n');
    let currentType = '';

    for (const line of lines) {
        if (line.startsWith('event:')) {
            currentType = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
            const dataStr = line.substring(5).trim();
            if (currentType === 'error') {
                 // 抛出包含特定标识的错误，以便上层捕获
                 throw new Error(`HF_SSE_ERROR: ${dataStr}`);
            }
            if (currentType === 'complete') {
                try {
                    events.push({ type: 'complete', data: JSON.parse(dataStr) });
                } catch (e) {
                    warn(
                      "HuggingFace",
                      `SSE JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            }
        }
    }
    return events;
}

// ==========================================
// 3. Provider 实现
// ==========================================

export class HuggingFaceProvider extends BaseProvider {
  readonly name: ProviderName = "HuggingFace";

  readonly capabilities: ProviderCapabilities = {
    textToImage: true,
    imageToImage: true,
    multiImageFusion: true,
    asyncTask: true,
    maxInputImages: 1,
    maxOutputImages: 1,
    maxEditOutputImages: 1,
    maxBlendOutputImages: 1,
    outputFormats: ["url", "b64_json"],
  };

  readonly config: ProviderConfig = {
    apiUrl: HuggingFaceConfig.apiUrls[0] || "", // 默认 URL，实际会使用 model 对应的 URL 或配置列表
    textModels: HuggingFaceConfig.textModels,
    defaultModel: HuggingFaceConfig.defaultModel,
    defaultSize: HuggingFaceConfig.defaultSize,
    editModels: HuggingFaceConfig.editModels,
    defaultEditModel: HuggingFaceConfig.defaultEditModel,
    defaultEditSize: HuggingFaceConfig.defaultEditSize,
    defaultSteps: HuggingFaceConfig.defaultSteps,
  };

  detectApiKey(key: string): boolean {
    return key.startsWith("hf_");
  }

  /**
   * 核心生成方法 (带 Token 轮询与重试)
   */
  generate(
    _apiKey: string, // 忽略传入的 apiKey，使用 KeyManager 管理
    request: ImageGenerationRequest,
    _options?: GenerationOptions,
  ): Promise<GenerationResult> {
    const { model, prompt, size, n: _n } = request;
    // 使用配置中的默认尺寸作为兜底
    const defaultWidth = this.config.defaultSize ? parseInt(this.config.defaultSize.split("x")[0]) : 1024;
    const defaultHeight = this.config.defaultSize ? parseInt(this.config.defaultSize.split("x")[1]) : 1024;
    
    const [width, height] = size ? size.split("x").map(Number) : [defaultWidth, defaultHeight];

    // 1. 确定 API URL
    // 优先使用 model 对应的 Space URL (这里简化为硬编码或从配置读取)
    // 实际项目中建议建立 model -> url 的映射表
    let apiUrl = this.config.apiUrl;
    
    // V4 升级：从动态配置读取 URL 映射
    // 动态获取映射
    const runtimeMap = getHfModelMap();
    
    if (model && runtimeMap[model]) {
        apiUrl = runtimeMap[model].main;
        // 备份 URL 逻辑可以在重试时使用，暂时只用 main
    } else if (model?.includes("flux") && model?.includes("schnell")) {
        apiUrl = "https://black-forest-labs-flux-1-schnell.hf.space";
    } else if (model?.includes("z-image")) {
        apiUrl = "https://luca115-z-image-turbo.hf.space";
    }
    // ... 更多映射

    // 2. 选择适配器构造 Payload
    const adapter = getAdapter(model || "");
    const seed = typeof request.seed === "number" ? request.seed : undefined;

    const runtimeConfig = getRuntimeConfig();
    const hfRuntime = runtimeConfig.providers[this.name] || {};

    const defaultSteps = hfRuntime.defaultSteps || this.config.defaultSteps || 4;
    const steps = typeof request.steps === "number" ? request.steps : defaultSteps;
    const payload = {
        data: adapter.constructPayload(prompt, { width, height, seed, steps }),
    };

    // 3. 执行带重试的请求
    return this.runWithTokenRetry(async (token) => {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        }

        info("HuggingFace", `Calling ${apiUrl} with model ${model} (Token: ${token ? 'Yes' : 'Anonymous'})`);

        // Step A: Initiate Prediction
        const predictUrl = `${apiUrl}/gradio_api/call/predict`; // 部分 Space 是 call/infer
        const response = await fetchWithTimeout(predictUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });

        if (response.status === 429) {
            throw new Error("429 Too Many Requests");
        }
        if (!response.ok) {
            throw new Error(`HF API Error: ${response.status} ${await response.text()}`);
        }

        const { event_id } = await response.json();
        
        // Step B: Poll Result
        const resultUrl = `${apiUrl}/gradio_api/call/predict/${event_id}`;
        const resultResponse = await fetchWithTimeout(resultUrl, {
            method: "GET",
            headers, // 保持相同的 Auth
        });

        if (resultResponse.status === 429) {
             throw new Error("429 Too Many Requests (Polling)");
        }

        const sseText = await resultResponse.text();
        
        // Step C: Parse SSE
        try {
            const events = parseSSEData(sseText);
            const completeEvent = events.find(e => e.type === 'complete');
            
            if (completeEvent && completeEvent.data) {
                // 解析结果
                // 通常结果在 data[0].url
                const resultData = completeEvent.data;
                if (!Array.isArray(resultData) || resultData.length === 0) {
                  throw new Error("No image URL found in response");
                }

                const imgItem = resultData[0];
                
                let imageUrl = "";
                if (imgItem && typeof imgItem === "object" && "url" in imgItem) {
                    const url = (imgItem as Record<string, unknown>).url;
                    if (typeof url === "string") imageUrl = url;
                } else if (typeof imgItem === 'string') {
                    imageUrl = imgItem; // 有些直接返回 URL 字符串
                }

                if (!imageUrl) {
                    throw new Error("No image URL found in response");
                }

                return {
                    success: true,
                    images: [{ url: imageUrl }],
                    model: model || "unknown",
                    provider: this.name,
                };
            }
             throw new Error("No complete event received");
        } catch (e) {
            if (e instanceof Error && e.message.includes("HF_SSE_ERROR")) {
                 // 服务端返回的明确错误
                 // 如果包含 quota/rate limit 相关的词，抛出 429
                 if (e.message.includes("quota") || e.message.includes("rate limit")) {
                     throw new Error("429 Quota Exhausted (SSE)");
                 }
                 // 否则视为不可重试的参数错误
                 throw new Error(`Generation Failed: ${e.message}`);
            }
            throw e;
        }
    });
  }

  /**
   * 通用重试包装器
   */
  private async runWithTokenRetry<T>(operation: (token: string | null) => Promise<T>): Promise<T> {
      let lastError: unknown;
      
      // 尝试逻辑：
      // 1. 获取 Key (KeyManager 会处理是否返回 null/匿名)
      // 2. 失败判断：如果是 429，标记 Key 并重试
      // 3. 最大尝试次数：3次 (避免死循环)
      
      for (let i = 0; i < 3; i++) {
          const token = keyManager.getNextKey(this.name);
          
          try {
              return await operation(token);
          } catch (e) {
              lastError = e;
              const message = e instanceof Error ? e.message : String(e);
              const status = getErrorStatus(e);
              const isRateLimit = message.includes("429") || status === 429;
              
              if (isRateLimit) {
                  warn("HuggingFace", `Key ...${token?.slice(-4) || 'Anon'} rate limited. Switching...`);
                  if (token) {
                      keyManager.markKeyExhausted(this.name, token);
                  }
                  // Continue to next attempt
                  continue;
              }
              
              // 非 429 错误，直接抛出 (如参数错误)
              throw e;
          }
      }
      
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function getErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  if (!("status" in err)) return undefined;
  const status = (err as Record<string, unknown>).status;
  return typeof status === "number" ? status : undefined;
}

export const huggingFaceProvider = new HuggingFaceProvider();
