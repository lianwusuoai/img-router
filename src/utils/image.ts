/**
 * @fileoverview 图片处理工具模块
 *
 * 提供一系列图片处理功能，包括：
 * 1. Base64 编解码与格式转换
 * 2. 图片格式自动检测 (基于文件头魔数)
 * 3. 图片压缩与尺寸调整 (使用 imagescript)
 * 4. 图床上传集成 (上传到配置的图床服务)
 */

import { ImageBedConfig } from "../config/manager.ts";
import { error } from "../core/logger.ts";
import { fetchWithTimeout } from "./http.ts";
import { Image } from "imagescript";

/** URL 转 Base64 的结果接口 */
export interface UrlToBase64Result {
  /** Base64 编码的图片数据（不含 data URI 前缀） */
  base64: string;
  /** 图片的 MIME 类型 (如 image/png) */
  mimeType: string;
}

/**
 * 将网络图片 URL 转换为 Base64 字符串
 * 会自动下载图片并提取其 MIME 类型
 *
 * @param {string} url - 图片的 URL 地址
 * @returns {Promise<UrlToBase64Result>} 包含 Base64 数据和 MIME 类型的对象
 * @throws {Error} 如果下载失败
 */
export async function urlToBase64(url: string): Promise<UrlToBase64Result> {
  const response = await fetchWithTimeout(url, {
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`获取图片失败: ${response.status} ${response.statusText}`);
  }

  // 从响应头获取 MIME 类型，默认为 png
  const contentType = response.headers.get("content-type") || "image/png";
  const mimeType = contentType.split(";")[0].trim();

  const arrayBuffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  // 将 Uint8Array 转换为 Base64 字符串
  let binary = "";
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }

  return {
    base64: btoa(binary),
    mimeType,
  };
}

/**
 * 将 Base64 图片上传到配置的图床服务并返回访问 URL
 *
 * @param {string} base64 - Base64 编码的图片数据（可以包含或不包含 Data URI 前缀）
 * @param {string} [mimeType="image/png"] - MIME 类型，用于确定文件扩展名
 * @returns {Promise<string>} 图片的公网访问 URL
 * @throws {Error} 如果图床鉴权未配置或上传失败
 */
export async function base64ToUrl(base64: string, mimeType: string = "image/png"): Promise<string> {
  let base64Content = base64;
  let resolvedMimeType = mimeType;

  // 处理 Data URI 前缀 (data:image/xyz;base64,...)
  if (base64.startsWith("data:image/")) {
    const parts = base64.split(",");
    if (parts.length < 2) throw new Error("Base64 Data URI 格式异常");
    base64Content = parts[1];
    // 从前缀中提取真实的 MIME 类型
    resolvedMimeType = parts[0].split(";")[0].split(":")[1] || mimeType;
  } else {
    // 移除可能存在的其他前缀
    base64Content = base64.replace(/^data:[^;]+;base64,/, "");
  }

  // 将 Base64 解码为二进制数据并封装为 Blob
  const binaryData = Uint8Array.from(atob(base64Content), (c) => c.charCodeAt(0));
  const blob = new Blob([binaryData], { type: resolvedMimeType });

  // MIME 类型到扩展名的映射
  const extMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  const ext = extMap[resolvedMimeType] || "png";
  const filename = `img_${Date.now()}.${ext}`;

  // 构建表单数据
  const formData = new FormData();
  formData.append("file", blob, filename);

  // 构建上传 URL
  const uploadUrl = new URL(ImageBedConfig.uploadEndpoint, ImageBedConfig.baseUrl);
  uploadUrl.searchParams.set("uploadChannel", ImageBedConfig.uploadChannel);

  // 检查是否配置了认证码
  if (!ImageBedConfig.authCode) {
    throw new Error("图床认证码未配置");
  }

  // 发起上传请求
  const response = await fetchWithTimeout(uploadUrl.toString(), {
    method: "POST",
    headers: {
      "Authorization": ImageBedConfig.authCode,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`图床上传失败: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (result.code !== 200 || !result.data?.url) {
    throw new Error(`图床响应异常: ${JSON.stringify(result)}`);
  }

  return result.data.url;
}

/**
 * 将 Base64 字符串转换为 Uint8Array
 * @param base64 Base64 字符串
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * 将 Uint8Array 转换为 Base64 字符串
 * @param bytes Uint8Array 数据
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 验证是否为有效的 Base64 字符串
 * @param str 待验证字符串
 */
export function isValidBase64(str: string): boolean {
  try {
    return btoa(atob(str)) === str;
  } catch (_err) {
    return false;
  }
}

/**
 * 从 Data URI 中提取 Base64 部分
 * @param dataUri Data URI 字符串
 */
export function extractBase64FromDataUri(dataUri: string): string {
  const parts = dataUri.split(",");
  return parts.length > 1 ? parts[1] : dataUri;
}

/**
 * 从 Data URI 中提取 MIME 类型
 * @param dataUri Data URI 字符串
 */
export function extractMimeTypeFromDataUri(dataUri: string): string {
  const matches = dataUri.match(/^data:([^;]+);base64,/);
  return matches ? matches[1] : "application/octet-stream";
}

/**
 * 将 Base64 字符串转换为 Blob 对象
 * 适用于通过 FormData 直接上传文件
 *
 * @param base64 Base64 字符串（支持 Data URI 格式）
 * @param defaultMime 默认 MIME 类型
 */
export function base64ToBlob(base64: string, defaultMime: string = "image/png"): Blob {
  let base64Content = base64;
  let mimeType = defaultMime;

  if (base64.startsWith("data:")) {
    mimeType = extractMimeTypeFromDataUri(base64);
    base64Content = extractBase64FromDataUri(base64);
  }

  const binaryString = atob(base64Content);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

/**
 * 构建 Data URI
 * @param base64 Base64 字符串
 * @param mimeType MIME 类型
 */
export function buildDataUri(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * 计算 Base64 字符串解码后的大小（字节）
 * @param base64 Base64 字符串
 */
export function calculateBase64Size(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return (base64.length * 3) / 4 - padding;
}

/**
 * 格式化文件大小
 * @param bytes 字节数
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * 将 WebP 转换为 PNG
 * 使用 imagescript 库进行解码和重编码
 *
 * @param blob WebP 图片 Blob
 * @returns PNG 图片 Blob
 */
export async function convertWebPToPNG(blob: Blob): Promise<Blob> {
  // 1. 读取原始二进制数据
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  // 2. 解码并重编码为 PNG (压缩等级 2，平衡速度与体积)
  const image = await Image.decode(uint8Array);
  const pngBuffer = await image.encode(2);
  const pngBytes = new Uint8Array(pngBuffer);

  // 3. 返回 PNG Blob
  return new Blob([pngBytes], { type: "image/png" });
}

/**
 * 检测图片格式
 * @param data 图片二进制数据
 */
export function detectImageFormat(data: Uint8Array): string {
  if (data.length < 4) return "unknown";

  // PNG: 89 50 4E 47
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    return "png";
  }

  // JPEG: FF D8 FF
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
    return "jpeg";
  }

  // GIF: 47 49 46 38
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return "gif";
  }

  // BMP: 42 4D
  if (data[0] === 0x42 && data[1] === 0x4D) {
    return "bmp";
  }

  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return "webp";
  }

  return "unknown";
}

/**
 * 获取 MIME 类型
 * @param format 格式名称或文件路径
 */
export function getMimeType(format: string): string {
  const ext = format.toLowerCase().split(".").pop();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/**
 * 规范化并压缩输入图片
 *
 * 1. 确保所有图片都是 Data URI 格式
 * 2. 如果是 URL，下载并转换为 Base64
 * 3. 验证图片格式和大小
 *
 * @param images 图片数组（URL 或 Base64）
 * @returns Promise<string[]> 规范化后的 Data URI 数组
 */
export async function normalizeAndCompressInputImages(images: string[]): Promise<string[]> {
  const result: string[] = [];

  for (const img of images) {
    try {
      if (img.startsWith("http://") || img.startsWith("https://")) {
        // 如果是 URL，下载并转换
        const { base64, mimeType } = await urlToBase64(img);
        result.push(buildDataUri(base64, mimeType));
      } else if (img.startsWith("data:")) {
        // 已经是 Data URI，直接透传（后续可以添加校验逻辑）
        result.push(img);
      } else {
        // 可能是纯 Base64，尝试探测或默认为 PNG
        // 简单假设是 png，实际应该尝试探测
        result.push(buildDataUri(img, "image/png"));
      }
    } catch (err) {
      error("Utils", `处理图片失败: ${img.substring(0, 50)}... ${err}`);
      // 忽略失败的图片，或者抛出错误？
      // 这里选择保留原始值，让后续 Provider 处理（可能会报错）
      result.push(img);
    }
  }

  return result;
}
