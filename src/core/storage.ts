import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { error, info } from "./logger.ts";
import { S3Client } from "s3-lite-client";
import { convertWebPToPNG } from "../utils/image.ts";
import { configManager } from "../config/manager.ts";

const STORAGE_DIR = "data/storage";

export interface ImageMetadata {
  prompt: string;
  model: string;
  seed?: number;
  params?: Record<string, unknown>;
  timestamp: number;
}

export interface StoredImage {
  filename: string;
  url: string;
  metadata: ImageMetadata;
}

export class StorageService {
  private static instance: StorageService;
  private initialized = false;
  private s3Client: S3Client | null = null;

  private constructor() {}

  static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  async init() {
    if (this.initialized) return;
    try {
      await ensureDir(STORAGE_DIR);
      info("Storage", `存储目录已就绪: ${STORAGE_DIR}`);

      // 初始化 S3 客户端
      this.initS3();

      this.initialized = true;
    } catch (e) {
      error("Storage", `初始化存储目录失败: ${e}`);
    }
  }

  private initS3() {
    const s3Config = configManager.getRuntimeConfig().storage?.s3;
    if (s3Config) {
      try {
        const url = new URL(s3Config.endpoint);
        this.s3Client = new S3Client({
          endPoint: url.hostname,
          port: url.port ? parseInt(url.port) : (url.protocol === "https:" ? 443 : 80),
          useSSL: url.protocol === "https:",
          region: s3Config.region || "auto",
          bucket: s3Config.bucket,
          accessKey: s3Config.accessKey,
          secretKey: s3Config.secretKey,
          pathStyle: false,
        });
        info("Storage", "S3 客户端已初始化");
      } catch (e) {
        error("Storage", `S3 客户端初始化失败: ${e}`);
      }
    }
  }

  private formatDate(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${
      pad(date.getHours())
    }-${pad(date.getMinutes())}`;
  }

  /**
   * 保存图片和元数据
   */
  async saveImage(
    base64Data: string,
    metadata: Omit<ImageMetadata, "timestamp">,
    extension = "png",
  ): Promise<string | null> {
    await this.init();

    try {
      // 1. 准备数据
      let base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "");
      let binaryData = Uint8Array.from(atob(base64Clean), (c) => c.charCodeAt(0));
      let finalExtension = extension;

      // WebP 转 PNG (如果开启且是 WebP)
      // TODO: 添加系统设置开关，目前默认开启
      if (extension.toLowerCase() === "webp") {
        try {
          const blob = new Blob([binaryData], { type: "image/webp" });
          const pngBlob = await convertWebPToPNG(blob);
          const buffer = await pngBlob.arrayBuffer();
          binaryData = new Uint8Array(buffer);
          finalExtension = "png";
          base64Clean = btoa(String.fromCharCode(...binaryData)); // 更新 base64 用于返回或其他用途
          info("Storage", "已自动将 WebP 转换为 PNG");
        } catch (e) {
          info("Storage", `WebP 转 PNG 失败，保留原格式: ${e}`);
        }
      }

      const timestamp = Date.now();

      // 生成新版文件名: YYYY-MM-DD HH-mm model-prompt-seed.png
      const dateStr = this.formatDate(new Date(timestamp));
      // 清理 model name
      const modelShort = metadata.model.split("/").pop()?.replace(/[^a-zA-Z0-9]/g, "-") ||
        "unknown";
      // 清理 prompt (取前 20 字符)
      const promptSlug = metadata.prompt.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "-") || "image";
      const seed = metadata.seed || 0;

      const filename = `${dateStr} ${modelShort}-${promptSlug}-${seed}.${finalExtension}`;
      const metaFilename = `${filename}.json`; // 使用 .png.json 或直接 .json，这里为了唯一性关联，使用完整文件名+json

      const filePath = join(STORAGE_DIR, filename);
      const metaPath = join(STORAGE_DIR, metaFilename);

      // 2. 保存本地
      await Deno.writeFile(filePath, binaryData);

      const fullMetadata: ImageMetadata = {
        ...metadata,
        timestamp,
      };
      await Deno.writeTextFile(metaPath, JSON.stringify(fullMetadata, null, 2));

      // 3. 上传 S3 (如果已配置)
      if (this.s3Client) {
        try {
          await this.s3Client.putObject(filename, binaryData, {
            metadata: {
              "Content-Type": `image/${finalExtension}`,
            },
          });
          // 可选：上传元数据文件到 S3
          const metaJson = JSON.stringify(fullMetadata);
          await this.s3Client.putObject(metaFilename, new TextEncoder().encode(metaJson), {
            metadata: { "Content-Type": "application/json" },
          });
          info("Storage", `已同步上传至 S3: ${filename}`);
        } catch (e) {
          error("Storage", `S3 上传失败: ${e}`);
        }
      }

      info("Storage", `图片已保存: ${filename}`);
      return filename;
    } catch (e) {
      error("Storage", `保存图片失败: ${e}`);
      return null;
    }
  }

  /**
   * 批量删除图片
   */
  async deleteImages(filenames: string[]): Promise<string[]> {
    await this.init();
    const deleted: string[] = [];

    for (const filename of filenames) {
      try {
        // 删除本地图片
        const filePath = join(STORAGE_DIR, filename);
        await Deno.remove(filePath).catch(() => {});

        // 删除本地元数据
        const metaPath = join(STORAGE_DIR, `${filename}.json`);
        await Deno.remove(metaPath).catch(() => {}); // 尝试删除新版命名

        // 尝试删除旧版命名 (timestamp_id.json)
        // 这里的逻辑有点复杂，因为旧版 json 不包含 .png 后缀
        // 暂时只支持删除新版命名的配套 json

        // 删除 S3
        if (this.s3Client) {
          await this.s3Client.deleteObject(filename).catch((e) =>
            error("Storage", `S3 删除失败: ${e}`)
          );
          await this.s3Client.deleteObject(`${filename}.json`).catch(() => {});
        }

        deleted.push(filename);
      } catch (e) {
        error("Storage", `删除文件失败 ${filename}: ${e}`);
      }
    }
    return deleted;
  }

  /**
   * 获取所有图片列表（带元数据）
   */
  async listImages(): Promise<StoredImage[]> {
    await this.init();
    const images: StoredImage[] = [];
    const s3Config = configManager.getRuntimeConfig().storage?.s3;

    try {
      for await (const entry of Deno.readDir(STORAGE_DIR)) {
        // 查找 .json 元数据文件
        if (entry.isFile && entry.name.endsWith(".json")) {
          try {
            const metaPath = join(STORAGE_DIR, entry.name);
            const metaContent = await Deno.readTextFile(metaPath);
            const metadata = JSON.parse(metaContent) as ImageMetadata;

            // 确定对应的图片文件名
            // 新版命名: image.png.json -> image.png
            // 旧版命名: timestamp_id.json -> timestamp_id.png (需要探测)

            let imageFilename = "";
            const baseName = entry.name.substring(0, entry.name.length - 5); // remove .json

            // 情况 1: filename.png.json -> filename.png
            // 实际上我们保存的是 filename.png.json 吗？
            // 代码里是: metaFilename = `${filename}.json`; -> "xxx.png.json"
            // 所以 baseName 就是 "xxx.png"，直接就是图片文件名

            if (await this.exists(join(STORAGE_DIR, baseName))) {
              imageFilename = baseName;
            } else {
              // 情况 2: 旧版命名 timestamp_id.json -> timestamp_id.png
              // 此时 baseName 是 timestamp_id
              const supportedExts = ["png", "jpg", "jpeg", "webp"];
              for (const ext of supportedExts) {
                if (await this.exists(join(STORAGE_DIR, `${baseName}.${ext}`))) {
                  imageFilename = `${baseName}.${ext}`;
                  break;
                }
              }
            }

            if (imageFilename) {
              let url = `/storage/${imageFilename}`;
              // 如果配置了 S3 公共域名，使用 S3 链接
              if (s3Config?.publicUrl) {
                // 简单的拼接，可能需要处理路径分隔符
                url = `${s3Config.publicUrl.replace(/\/$/, "")}/${imageFilename}`;
              }

              images.push({
                filename: imageFilename,
                url,
                metadata,
              });
            }
          } catch (_e) {
            continue;
          }
        }
      }

      // 按时间倒序排列
      return images.sort((a, b) => b.metadata.timestamp - a.metadata.timestamp);
    } catch (e) {
      error("Storage", `读取列表失败: ${e}`);
      return [];
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

export const storageService = StorageService.getInstance();
