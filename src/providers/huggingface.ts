/**
 * HuggingFace Provider 实现 (V5 - 使用 Gradio Client)
 *
 * 核心升级：
 * 1. **使用官方 Gradio JavaScript Client**：替代手动 HTTP 请求和 SSE 解析
 * 2. **Token 池与匿名混合模式**：优先使用 Token，耗尽后尝试匿名，支持每日重置
 * 3. **并发多图生成**：支持通过并发请求方式生成最多 16 张图片
 * 4. **简化错误处理**：Gradio Client 自动处理连接和轮询
 */

import {
  BaseProvider,
  type GenerationOptions,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderName,
} from "./base.ts";
import type { GenerationResult, ImageGenerationRequest } from "../types/index.ts";
import { getHfModelMap, getRuntimeConfig, HuggingFaceConfig } from "../config/manager.ts";
import { info } from "../core/logger.ts";
import { keyManager } from "../core/key-manager.ts";
import { Client } from "@gradio/client";

// ==========================================
// Provider 实现
// ==========================================

export class HuggingFaceProvider extends BaseProvider {
  readonly name: ProviderName = "HuggingFace";

  readonly capabilities: ProviderCapabilities = {
    textToImage: true,
    imageToImage: true,
    multiImageFusion: true,
    asyncTask: true,
    maxInputImages: 1,
    maxOutputImages: 16, // 支持最多 16 张图并发生成
    maxEditOutputImages: 16, // 支持最多 16 张图编辑
    maxBlendOutputImages: 16, // 支持最多 16 张图融合
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
   * 支持并发生成多张图片 (n > 1 时)
   */
  generate(
    _apiKey: string, // 忽略传入的 apiKey，使用 KeyManager 管理
    request: ImageGenerationRequest,
    _options?: GenerationOptions,
  ): Promise<GenerationResult> {
    const { n = 1 } = request;

    // 如果需要生成多张图，使用并发策略
    if (n > 1) {
      return this.generateMultiple(request, _options);
    }

    // 单张图生成逻辑
    return this.generateSingle(request, _options);
  }

  /**
   * 单张图生成方法 (使用 Gradio Client)
   */
  private generateSingle(
    request: ImageGenerationRequest,
    _options?: GenerationOptions,
  ): Promise<GenerationResult> {
    const { model, prompt, size } = request;
    // 使用配置中的默认尺寸作为兜底
    const defaultWidth = this.config.defaultSize
      ? parseInt(this.config.defaultSize.split("x")[0])
      : 1024;
    const defaultHeight = this.config.defaultSize
      ? parseInt(this.config.defaultSize.split("x")[1])
      : 1024;

    const [width, height] = size ? size.split("x").map(Number) : [defaultWidth, defaultHeight];

    // 1. 确定 Space 名称和 API 端点
    let spaceName = "luca115/z-image-turbo"; // 默认 Space
    const apiName = "/generate_image"; // 默认 API 端点名称

    // V5 升级：从动态配置读取 Space 映射
    const runtimeMap = getHfModelMap();

    if (model && runtimeMap[model]) {
      // 从 URL 提取 Space 名称 (格式: https://user-space.hf.space -> user/space)
      const url = runtimeMap[model].main;
      const match = url.match(/https:\/\/([^.]+)\.hf\.space/);
      if (match) {
        spaceName = match[1].replace(/-/g, "/");
      }
    } else if (model?.includes("flux") && model?.includes("schnell")) {
      spaceName = "black-forest-labs/flux-1-schnell";
    } else if (model?.includes("z-image")) {
      spaceName = "luca115/z-image-turbo";
    }

    // 2. 构造请求参数
    const seed = typeof request.seed === "number" ? request.seed : Math.floor(Math.random() * 1000000);
    
    const runtimeConfig = getRuntimeConfig();
    const hfRuntime = runtimeConfig.providers[this.name] || {};
    const defaultSteps = hfRuntime.defaultSteps || this.config.defaultSteps || 9;
    const steps = typeof request.steps === "number" ? request.steps : defaultSteps;

    // 3. 执行带重试的请求
    return this.runWithTokenRetry(async (token) => {
      info(
        "HuggingFace",
        `连接到 Space: ${spaceName}, 端点: ${apiName} (Token: ${token ? "Yes" : "Anonymous"})`,
      );

      try {
        // 使用 Gradio Client 连接到 Space
        // token 已通过 detectApiKey 验证，确保是 hf_ 开头
        const client = await Client.connect(spaceName, token ? {
          hf_token: token as `hf_${string}`,
        } : undefined);

        info(
          "HuggingFace",
          `调用 ${apiName} - prompt: "${prompt.substring(0, 50)}...", size: ${width}x${height}`,
        );

        // 调用 predict API
        // 参数顺序：[prompt, height, width, num_inference_steps, seed, randomize_seed]
        const result = await client.predict(apiName, {
          prompt: prompt,
          height: height,
          width: width,
          num_inference_steps: steps,
          seed: seed,
          randomize_seed: false,
        });

        // 解析结果
        if (!result || !result.data) {
          throw new Error("No data in response");
        }

        const resultData = result.data;
        if (!Array.isArray(resultData) || resultData.length === 0) {
          throw new Error("No image URL found in response");
        }

        const imgItem = resultData[0];
        let imageUrl = "";

        if (imgItem && typeof imgItem === "object" && "url" in imgItem) {
          const url = (imgItem as Record<string, unknown>).url;
          if (typeof url === "string") imageUrl = url;
        } else if (typeof imgItem === "string") {
          imageUrl = imgItem;
        }

        if (!imageUrl) {
          throw new Error("No image URL found in response");
        }

        info("HuggingFace", `图片生成成功: ${imageUrl.substring(0, 80)}...`);

        return {
          success: true,
          images: [{ url: imageUrl }],
          model: model || "unknown",
          provider: this.name,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        
        // 检查是否是限流错误
        if (message.includes("429") || message.includes("rate limit") || message.includes("quota")) {
          throw new Error("429 Too Many Requests");
        }
        
        // 其他错误直接抛出
        throw new Error(`Gradio Client Error: ${message}`);
      }
    });
  }

  /**
   * 并发生成多张图片
   * 采用分批并发策略，避免触发 429 限流
   */
  private async generateMultiple(
    request: ImageGenerationRequest,
    options?: GenerationOptions,
  ): Promise<GenerationResult> {
    const { n = 1, model } = request;
    const MAX_CONCURRENT = 3; // 每批最多并发 3 个请求

    info(
      "HuggingFace",
      `开始并发生成 ${n} 张图片 (模型: ${model}, 批次大小: ${MAX_CONCURRENT})`,
    );

    const results: GenerationResult[] = [];
    const errors: string[] = [];

    // 分批处理
    for (let i = 0; i < n; i += MAX_CONCURRENT) {
      const batchSize = Math.min(MAX_CONCURRENT, n - i);
      const batchNumber = Math.floor(i / MAX_CONCURRENT) + 1;
      const totalBatches = Math.ceil(n / MAX_CONCURRENT);

      info(
        "HuggingFace",
        `处理第 ${batchNumber}/${totalBatches} 批，包含 ${batchSize} 个请求`,
      );

      // 创建当前批次的请求
      const batchPromises = Array.from({ length: batchSize }, (_, index) => {
        const imageIndex = i + index + 1;
        return this.generateSingle({ ...request, n: 1 }, options)
          .then((result) => {
            info("HuggingFace", `图片 ${imageIndex}/${n} 生成成功`);
            return result;
          })
          .catch((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            info("HuggingFace", `图片 ${imageIndex}/${n} 生成失败: ${errorMsg}`);
            errors.push(`图片 ${imageIndex}: ${errorMsg}`);
            return null;
          });
      });

      // 等待当前批次完成
      const batchResults = await Promise.all(batchPromises);

      // 收集成功的结果
      for (const result of batchResults) {
        if (result && result.success) {
          results.push(result);
        }
      }

      // 在批次之间添加短暂延迟，避免触发限流
      if (i + MAX_CONCURRENT < n) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // 汇总结果
    if (results.length === 0) {
      throw new Error(
        `所有图片生成失败。错误信息:\n${errors.join("\n")}`,
      );
    }

    const successCount = results.length;
    const failCount = n - successCount;

    info(
      "HuggingFace",
      `并发生成完成: 成功 ${successCount}/${n} 张${failCount > 0 ? `, 失败 ${failCount} 张` : ""}`,
    );

    // 过滤掉 undefined 的结果
    const images = results.flatMap((r) => r.images).filter((img): img is NonNullable<typeof img> => img !== undefined);

    return {
      success: true,
      images,
      model: model || "unknown",
      provider: this.name,
    };
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
        const isRateLimit = message.includes("429") || message.includes("rate limit") || message.includes("quota");

        if (isRateLimit) {
          info("HuggingFace", `Key ...${token?.slice(-4) || "Anon"} rate limited. Switching...`);
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

export const huggingFaceProvider = new HuggingFaceProvider();
