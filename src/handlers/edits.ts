/**
 * Images Edit 端点处理器
 *
 * 处理 /v1/images/edits 端点（图生图/图片编辑）。
 *
 * 功能特性：
 * - 支持 **multipart/form-data**：标准 OpenAI 风格，适合上传文件。
 * - 支持 **JSON**：兼容部分客户端，通过 Base64 或 URL 传递图片。
 * - **自动路由**：根据 Authorization Header 中的 API Key 自动路由到对应的 Provider。
 * - **格式兼容**：返回 OpenAI Images API 兼容的响应格式。
 *
 * 注意事项：
 * - 所有的 Provider 实现都统一接收 `ImageGenerationRequest`，其中 `images` 数组包含所有输入图片。
 * - `mask` 参数虽然被解析，但目前的 Provider 实现大多不支持或通过其他方式（如 Alpha 通道）支持，因此暂未强依赖。
 */

import { encodeBase64 } from "@std/encoding/base64";
import { getProviderTaskDefaults } from "../config/manager.ts";
import type {
  ImageData,
  ImageGenerationRequest,
  ImagesEditRequest,
  ImagesResponse,
  Message,
} from "../types/index.ts";
import { providerRegistry } from "../providers/registry.ts";
import { buildDataUri, normalizeAndCompressInputImages, urlToBase64 } from "../utils/image.ts";
import { debug, error, generateRequestId, info, warn } from "../core/logger.ts";
import { extractPromptAndImages, normalizeMessageContent } from "./chat.ts";

/**
 * 将 File 对象转换为 Data URI
 *
 * 用于处理 multipart/form-data 上传的文件。
 *
 * @param file - 上传的文件对象
 * @returns Data URI 字符串 (data:image/png;base64,...)
 */
async function fileToDataUri(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  const base64 = encodeBase64(uint8Array);
  const mimeType = file.type || "image/png";
  return buildDataUri(base64, mimeType);
}

/**
 * 处理 /v1/images/edits 端点
 *
 * 核心流程：
 * 1. **鉴权与路由**：根据 API Key 检测 Provider。
 * 2. **请求解析**：
 *    - 如果是 `multipart/form-data`：解析 Form Data，提取文件并转换为 Data URI。
 *    - 如果是 `application/json`：解析 JSON Body，提取 Base64 或 URL 图片。
 * 3. **图片预处理**：统一压缩和格式化输入图片。
 * 4. **Provider 调用**：执行图片编辑生成。
 * 5. **响应构建**：根据 `response_format` 返回 URL 或 Base64 JSON。
 *
 * @param req - HTTP 请求对象
 * @returns HTTP 响应对象
 */
export async function handleImagesEdits(req: Request): Promise<Response> {
  const _url = new URL(req.url);
  const requestId = generateRequestId();

  // 1. 鉴权与路由
  const authHeader = req.headers.get("Authorization");
  const apiKey = authHeader?.replace("Bearer ", "").trim();
  if (!apiKey) {
    warn("HTTP", "Authorization header 缺失");

    return new Response(JSON.stringify({ error: "Authorization header missing" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const provider = providerRegistry.detectProvider(apiKey);
  if (!provider) {
    warn("HTTP", "API Key 格式无法识别");

    return new Response(
      JSON.stringify({ error: "Invalid API Key format. Could not detect provider." }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  info("HTTP", `路由到 ${provider.name} (Images Edit)`);

  const _startTime = Date.now();

  try {
    const contentType = req.headers.get("content-type") || "";

    let prompt = "";
    let model: string | undefined;
    let size: string | undefined;
    let steps: number | undefined;
    let responseFormat: "url" | "b64_json" = "url";
    const images: string[] = [];

    // 2. 请求解析
    if (contentType.includes("multipart/form-data")) {
      // 处理表单上传
      const formData = await req.formData();

      prompt = (formData.get("prompt") as string) || "";
      model = (formData.get("model") as string) || undefined;
      size = (formData.get("size") as string) || undefined;
      const stepsVal = formData.get("steps");
      if (stepsVal) steps = Number(stepsVal);

      const rf = formData.get("response_format");
      if (typeof rf === "string" && (rf === "url" || rf === "b64_json")) {
        responseFormat = rf;
      }

      const imageFiles = formData.getAll("image[]");
      const fallbackImage = formData.get("image");
      const allImages = imageFiles.length > 0 ? imageFiles : (fallbackImage ? [fallbackImage] : []);

      for (const item of allImages) {
        if (item instanceof File) {
          images.push(await fileToDataUri(item));
          info(
            "HTTP",
            `从 multipart/form-data 提取图片: ${item.name}, size=${Math.round(item.size / 1024)}KB`,
          );
        } else if (typeof item === "string" && item.trim()) {
          images.push(item.trim());
        }
      }

      const mask = formData.get("mask");
      if (mask) {
        warn("HTTP", "mask 参数已提供，但当前实现不保证所有 Provider 支持遮罩编辑");
      }
    } else {
      // 处理 JSON 请求
      const jsonBody = await req.json();

      // 兼容某些客户端发送 messages 数组的情况
      if (jsonBody?.messages && Array.isArray(jsonBody.messages)) {
        const normalizedMessages = (jsonBody.messages as Message[]).map((msg: Message) => ({
          ...msg,
          content: normalizeMessageContent(msg.content),
        }));

        const extracted = extractPromptAndImages(normalizedMessages);
        prompt = extracted.prompt;
        images.push(...extracted.images);

        model = typeof jsonBody.model === "string" ? jsonBody.model : undefined;
        size = typeof jsonBody.size === "string" ? jsonBody.size : undefined;

        const rf = jsonBody.response_format;
        if (typeof rf === "string" && (rf === "url" || rf === "b64_json")) {
          responseFormat = rf;
        }
      } else {
        // 标准 JSON 请求
        const body = jsonBody as ImagesEditRequest;

        prompt = body?.prompt || "";
        model = body?.model;
        size = body?.size;
        steps = body?.steps;

        if (body?.response_format) {
          responseFormat = body.response_format;
        }

        if (typeof body?.image === "string" && body.image.trim()) {
          images.push(body.image.trim());
        }

        if (body?.mask) {
          warn("HTTP", "mask 参数已提供，但当前实现不保证所有 Provider 支持遮罩编辑");
        }
      }
    }

    if (images.length === 0) {
      warn("HTTP", "Images Edit 请求缺少 image");

      return new Response(
        JSON.stringify({ error: "必须提供 image（multipart/form-data 或 JSON 字段）" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 3. 图片预处理
    const compressedImages = await normalizeAndCompressInputImages(images);
    const defaults = getProviderTaskDefaults(provider.name, "edit");

    debug(
      "Router",
      `Images Edit Prompt: ${prompt.substring(0, 80)}... (完整长度: ${prompt.length})`,
    );
    debug("Router", `Images Edit 图片数量: ${images.length}`);

    // 4. Provider 调用
    const generationRequest: ImageGenerationRequest = {
      prompt,
      images: compressedImages,
      model,
      size,
      steps: steps || defaults.steps || undefined,
      response_format: responseFormat,
    };

    const validationError = provider.validateRequest(generationRequest);
    if (validationError) {
      warn("HTTP", `请求参数无效: ${validationError}`);

      return new Response(JSON.stringify({ error: validationError }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const generationResult = await provider.generate(apiKey, generationRequest, {
      requestId,
      returnBase64: responseFormat === "b64_json",
    });

    if (!generationResult.success) {
      throw new Error(generationResult.error || "图片编辑失败");
    }

    // 5. 响应构建
    const output: ImageData[] = generationResult.images || [];
    const data: ImageData[] = [];

    for (const img of output) {
      if (responseFormat === "b64_json") {
        if (img.b64_json) {
          data.push({ b64_json: img.b64_json });
          continue;
        }
        if (img.url) {
          try {
            const { base64 } = await urlToBase64(img.url);
            data.push({ b64_json: base64 });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            warn("HTTP", `URL 转 Base64 失败，回退到 URL: ${msg}`);
            data.push({ url: img.url });
          }
        }
        continue;
      }

      // responseFormat === "url"
      if (img.url) {
        data.push({ url: img.url });
        continue;
      }
      if (img.b64_json) {
        data.push({ url: buildDataUri(img.b64_json, "image/png") });
      }
    }

    const responseBody: ImagesResponse = {
      created: Math.floor(Date.now() / 1000),
      data,
    };

    info("HTTP", "响应完成 (Images Edit API)");

    return new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Internal Server Error";
    const errorProvider = provider?.name || "Unknown";

    error("Proxy", `请求处理错误 (${errorProvider}): ${errorMessage}`);

    return new Response(
      JSON.stringify({
        error: { message: errorMessage, type: "server_error", provider: errorProvider },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
