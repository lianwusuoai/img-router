import { debug, warn } from "../core/logger.ts";
import { getAiChatConfig } from "../config/manager.ts";

export class AiChatService {
  private static instance: AiChatService;

  private constructor() {}

  public static getInstance(): AiChatService {
    if (!AiChatService.instance) {
      AiChatService.instance = new AiChatService();
    }
    return AiChatService.instance;
  }

  /**
   * 处理 Prompt (翻译/扩充)
   */
  public async processPrompt(
    prompt: string,
    options: { translate?: boolean; expand?: boolean },
  ): Promise<string> {
    if (!prompt) return "";

    const config = getAiChatConfig();
    // 优先使用 options 中的配置，如果未定义则回退到全局配置
    const shouldTranslate = options.translate ?? config?.enableTranslate ?? false;
    const shouldExpand = options.expand ?? config?.enableExpand ?? false;

    let result = prompt;

    // 1. 翻译
    if (shouldTranslate) {
      result = await this.translatePrompt(result);
    }

    // 2. 扩充
    if (shouldExpand) {
      result = await this.expandPrompt(result);
    }

    return result;
  }

  private translatePrompt(prompt: string): Promise<string> {
    const config = getAiChatConfig();
    const system = config?.translatePrompt ||
      "You are a professional prompt engineer and translator. Translate the user's image generation prompt into English. Only output the translated text, no explanation.";
    return this.callLLM(system, prompt, "Prompt Translation");
  }

  private expandPrompt(prompt: string): Promise<string> {
    const config = getAiChatConfig();
    const system = config?.expandPrompt ||
      "You are a professional prompt engineer. Expand the user's short prompt into a detailed, high-quality image generation prompt. Keep it descriptive and aesthetic. Output ONLY the expanded prompt in English.";
    return this.callLLM(system, prompt, "Prompt Expansion");
  }

  /**
   * 测试连接
   */
  public async testConnection(config: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
    return await this.callLLM(
      "You are a helpful assistant.",
      "Hello, this is a connection test. Reply with 'Connection Successful'.",
      "Test Connection",
      config
    );
  }

  /**
   * 获取模型列表
   */
  public async fetchModels(config: { baseUrl: string; apiKey: string }): Promise<string[]> {
    if (!config.baseUrl || !config.apiKey) {
      throw new Error("Missing Base URL or API Key");
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const url = this.buildModelsUrl(config.baseUrl);
      
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to fetch models (${response.status}): ${text}`);
      }

      const data = await response.json();
      // OpenAI 格式: { data: [{ id: "model-id", ... }, ...] }
      if (Array.isArray(data.data)) {
        // deno-lint-ignore no-explicit-any
        return data.data.map((m: any) => m.id);
      } else if (Array.isArray(data)) {
        // 某些兼容接口可能直接返回数组
        // deno-lint-ignore no-explicit-any
        return data.map((m: any) => (typeof m === "string" ? m : m.id));
      }
      
      return [];
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  private async callLLM(
    system: string, 
    user: string, 
    context: string, 
    overrideConfig?: { baseUrl: string; apiKey: string; model: string }
  ): Promise<string> {
    const globalConfig = getAiChatConfig();
    const config = overrideConfig || globalConfig;

    if (!config || !config.baseUrl || !config.apiKey) {
      warn("AiChat", "AI Chat service not configured (missing URL or Key). Skipping.");
      return user;
    }

    try {
      debug("AiChat", `Starting ${context}...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s 超时 (给翻译/扩充留出更多时间)

      const url = this.buildChatCompletionsUrl(config.baseUrl);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          model: config.model || "gpt-3.5-turbo", // 默认模型
          temperature: 0.7,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content;

      if (!text) {
        throw new Error("Empty response from LLM");
      }

      debug("AiChat", `${context} result: ${text.substring(0, 50)}...`);
      return text.trim();
    } catch (e) {
      warn(
        "AiChat",
        `${context} failed: ${e instanceof Error ? e.message : String(e)}. Using original text.`,
      );
      return user; // 回退到原始文本
    }
  }

  private buildModelsUrl(baseUrl: string): string {
    let b = baseUrl.replace(/\/+$/, "");
    if (b.endsWith("/v1/chat/completions")) b = b.replace("/chat/completions", "");
    if (b.endsWith("/chat/completions")) b = b.replace("/chat/completions", "");

    if (b.endsWith("/v1/models") || b.endsWith("/models")) return b;
    if (b.endsWith("/v1")) return `${b}/models`;
    return `${b}/v1/models`;
  }

  private buildChatCompletionsUrl(baseUrl: string): string {
    const b = baseUrl.replace(/\/+$/, "");
    if (b.endsWith("/v1/chat/completions") || b.endsWith("/chat/completions")) return b;
    if (b.endsWith("/v1")) return `${b}/chat/completions`;
    return `${b}/v1/chat/completions`;
  }
}

export const aiChatService = AiChatService.getInstance();
