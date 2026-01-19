import { debug, error, info } from "../core/logger.ts";
import { getPromptOptimizerConfig } from "../config/manager.ts";

export class PromptOptimizerService {
  private static instance: PromptOptimizerService;

  private constructor() {}

  public static getInstance(): PromptOptimizerService {
    if (!PromptOptimizerService.instance) {
      PromptOptimizerService.instance = new PromptOptimizerService();
    }
    return PromptOptimizerService.instance;
  }

  /**
   * 处理 Prompt (翻译/扩充)
   */
  public async processPrompt(
    prompt: string,
    options: { translate?: boolean; expand?: boolean },
  ): Promise<string> {
    if (!prompt) return "";

    const config = getPromptOptimizerConfig();
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
    const config = getPromptOptimizerConfig();
    const system = config?.translatePrompt ||
      "You are a professional prompt engineer and translator. Translate the user's image generation prompt into English. Only output the translated text, no explanation.";
    return this.callLLM(system, prompt, "Prompt Translation");
  }

  private expandPrompt(prompt: string): Promise<string> {
    const config = getPromptOptimizerConfig();
    const system = config?.expandPrompt ||
      "You are a professional prompt engineer. Expand the user's short prompt into a detailed, high-quality image generation prompt. Keep it descriptive and aesthetic. Output ONLY the expanded prompt in English.";
    return this.callLLM(system, prompt, "Prompt Expansion");
  }

  /**
   * 测试连接
   */
  public async testConnection(
    config: { baseUrl: string; apiKey: string; model: string },
  ): Promise<{ reply: string; url: string; model: string }> {
    const url = this.buildChatCompletionsUrl(config.baseUrl);
    const reply = await this.callLLM(
      "You are a helpful assistant.",
      "Hello, this is a connection test. Reply with 'Connection Successful'.",
      "Test Connection",
      config,
      { strict: true },
    );

    if (!/connection successful/i.test(reply)) {
      throw new Error(`连接测试未通过：LLM返回内容不符合预期：${reply}`);
    }

    return { reply, url, model: config.model };
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
    overrideConfig?: { baseUrl: string; apiKey: string; model: string },
    options?: { strict?: boolean },
  ): Promise<string> {
    const globalConfig = getPromptOptimizerConfig();
    const config = overrideConfig || globalConfig;

    if (!config || !config.baseUrl || !config.apiKey) {
      if (options?.strict) {
        throw new Error("PromptOptimizer 未配置：缺少 Base URL 或 API Key");
      }
      info("PromptOptimizer", "PromptOptimizer service not configured (missing URL or Key). Skipping.");
      return user;
    }

    try {
      debug("PromptOptimizer", `Starting ${context}...`);

      const doRequest = async (targetUrl: string) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s 超时

        try {
          const response = await fetch(targetUrl, {
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
              model: config.model || "翻译",
              temperature: 0.7,
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM API Error (${response.status}): ${errorText}`);
          }

          const data = await response.json();
          const text = data.choices?.[0]?.message?.content;

          if (!text) {
            throw new Error("Empty response from LLM");
          }
          return text.trim();
        } finally {
          clearTimeout(timeoutId);
        }
      };

      const url = this.buildChatCompletionsUrl(config.baseUrl);
      try {
        const text = await doRequest(url);
        debug("PromptOptimizer", `${context} result: ${text.substring(0, 50)}...`);
        return text;
      } catch (e) {
        // 智能重试：如果是因为 localhost 连接拒绝，尝试 host.docker.internal
        const errStr = String(e);
        const isLocalhost = config.baseUrl.includes("localhost") ||
          config.baseUrl.includes("127.0.0.1");
        const isConnError = errStr.includes("Connection refused") ||
          errStr.includes("os error 111") || errStr.includes("client error");

        if (isLocalhost && isConnError) {
          const newBaseUrl = config.baseUrl
            .replace("localhost", "host.docker.internal")
            .replace("127.0.0.1", "host.docker.internal");

          info(
            "PromptOptimizer",
            `Connection to localhost failed. Retrying with host.docker.internal: ${newBaseUrl}`,
          );

          try {
            const retryUrl = this.buildChatCompletionsUrl(newBaseUrl);
            info("PromptOptimizer", `Retrying connection with: ${retryUrl}`);
            const text = await doRequest(retryUrl);
            debug("PromptOptimizer", `${context} retry success with host.docker.internal`);
            return text;
          } catch (retryError) {
            info("PromptOptimizer", `Retry with host.docker.internal also failed: ${retryError}`);
            // 明确抛出重试失败的错误，并提供诊断建议
            throw new Error(
              `连接 localhost 失败 (Connection Refused)。\n` +
                `已尝试自动重试 host.docker.internal 但仍失败。\n` +
                `这通常是因为：\n` +
                `1. AI 终端容器未在宿主机映射端口；\n` +
                `2. Windows 防火墙拦截了端口的入站连接；\n` +
                `3. AI 终端未监听 0.0.0.0。\n` +
                `建议：尝试使用 AI 终端的容器名称代替 localhost。`,
            );
          }
        }
        throw e;
      }
    } catch (e) {
      if (options?.strict) {
        throw e;
      }
      error(
        "PromptOptimizer",
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

export const promptOptimizerService = PromptOptimizerService.getInstance();
