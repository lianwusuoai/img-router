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
   * 检测文本是否为英文
   * 简单规则：如果 ASCII 字符占比超过 70%，认为是英文
   */
  private isEnglish(text: string): boolean {
    if (!text) return true;
    const asciiCount = text.split("").filter((c) => c.charCodeAt(0) < 128).length;
    const ratio = asciiCount / text.length;
    return ratio > 0.7;
  }

  /**
   * 处理 Prompt (翻译/扩充)
   * 保持向后兼容：返回字符串
   *
   * 规则：
   * - 翻译和扩充是独立的功能
   * - 翻译：仅当不是英文时才翻译为英文
   * - 扩充：按照源语言进行扩充（中文扩充为中文，英文扩充为英文）
   */
  public async processPrompt(
    prompt: string,
    options: { translate?: boolean; expand?: boolean; imageIndex?: number },
  ): Promise<string> {
    if (!prompt) return "";

    // 只有明确设置为 true 时才执行翻译/扩充
    const shouldTranslate = options.translate === true;
    const shouldExpand = options.expand === true;
    const imageIndex = options.imageIndex;

    let result = prompt;
    let translatedText = "";
    let translated = false;
    let expanded = false;

    // 1. 翻译（仅当需要翻译且不是英文时）
    if (shouldTranslate) {
      const isEng = this.isEnglish(prompt);
      if (!isEng) {
        const beforeTranslate = result;
        result = await this.translatePrompt(result);
        translated = result !== beforeTranslate;
        if (translated) {
          translatedText = result;
        }
      } else {
        if (!shouldExpand) {
          info("PromptOptimizer", "⏭️ 检测到英文提示词，跳过翻译");
        }
      }
    }

    // 2. 扩充（按照当前语言扩充，不管是中文还是英文）
    if (shouldExpand) {
      const beforeExpand = result;
      result = await this.expandPrompt(result);
      expanded = result !== beforeExpand;
    }

    // 3. 输出日志 - 合并翻译和扩充的结果
    // 将提示词中的换行符替换为空格，使其显示为一行
    const formatPrompt = (text: string) => text.replace(/\s+/g, ' ').trim();
    
    if (translated && expanded) {
      // 同时开启翻译+扩充
      const prefix = imageIndex !== undefined ? `图${imageIndex} ` : "";
      info("PromptOptimizer",
        `✅ ${prefix}翻译+扩充提示词\n` +
        `原始: "${formatPrompt(prompt)}"\n` +
        `翻译后: "${formatPrompt(translatedText)}"\n` +
        `扩充后: "${formatPrompt(result)}"`
      );
    } else if (translated) {
      // 仅翻译
      info("PromptOptimizer", `✅ 翻译:\n原始: "${formatPrompt(prompt)}"\n翻译后: "${formatPrompt(result)}"`);
    } else if (expanded) {
      // 仅扩充
      info("PromptOptimizer", `✅ 扩充:\n原始: "${formatPrompt(prompt)}"\n扩充后: "${formatPrompt(result)}"`);
    } else if (shouldTranslate || shouldExpand) {
      info("PromptOptimizer", "⏭️ 提示词未发生变化");
    }

    return result;
  }

  private translatePrompt(prompt: string): Promise<string> {
    const config = getPromptOptimizerConfig();
    
    // 检查字数限制
    const maxLength = config?.translateMaxLength || 5000;
    if (prompt.length > maxLength) {
      info("PromptOptimizer", `⚠️ 翻译提示词超过长度限制 (${prompt.length}/${maxLength})，将截断`);
      prompt = prompt.substring(0, maxLength);
    }
    
    const system = config?.translatePrompt ||
      "You are a professional prompt engineer and translator. Translate the user's image generation prompt into English. Only output the translated text, no explanation.";
    return this.callLLM(system, prompt, "Prompt Translation");
  }

  private async expandPrompt(prompt: string): Promise<string> {
    const config = getPromptOptimizerConfig();
    
    // 检查字数限制
    const maxLength = config?.expandMaxLength || 5000;
    if (prompt.length > maxLength) {
      info("PromptOptimizer", `⚠️ 扩充提示词超过长度限制 (${prompt.length}/${maxLength})，将截断`);
      prompt = prompt.substring(0, maxLength);
    }
    
    const system = config?.expandPrompt ||
      "You are a professional prompt engineer. Expand the user's short prompt into a detailed, high-quality image generation prompt. Keep it descriptive and aesthetic. Output ONLY the expanded prompt in plain text format. DO NOT use any Markdown formatting (no **, __, ##, etc.). Just output pure text without any special formatting.";
    
    const rawResult = await this.callLLM(system, prompt, "Prompt Expansion");
    
    // 清理可能的 Markdown 格式
    return this.cleanMarkdown(rawResult);
  }

  /**
   * 清理 Markdown 格式
   * 移除 **bold**, __italic__, ##headers 等格式标记
   */
  private cleanMarkdown(text: string): string {
    return text
      // 移除加粗: **text** 或 __text__
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      // 移除斜体: *text* 或 _text_
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      // 移除标题: ## text
      .replace(/^#{1,6}\s+/gm, '')
      // 移除行内代码: `code`
      .replace(/`(.+?)`/g, '$1')
      // 移除列表符号: - item 或 * item
      .replace(/^[\*\-]\s+/gm, '')
      // 移除多余空格
      .replace(/\s+/g, ' ')
      .trim();
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
      info(
        "PromptOptimizer",
        "PromptOptimizer service not configured (missing URL or Key). Skipping.",
      );
      return user;
    }

    try {
      debug("PromptOptimizer", `Starting ${context}...`);

      const doRequest = async (targetUrl: string) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s 超时

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
