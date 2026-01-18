import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { info, error } from "./logger.ts";

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
      this.initialized = true;
    } catch (e) {
      error("Storage", `初始化存储目录失败: ${e}`);
    }
  }

  /**
   * 保存图片和元数据
   */
  async saveImage(
    base64Data: string,
    metadata: Omit<ImageMetadata, "timestamp">,
    extension = "png"
  ): Promise<string | null> {
    await this.init();

    const timestamp = Date.now();
    const id = crypto.randomUUID().split("-")[0];
    const filename = `${timestamp}_${id}.${extension}`;
    const metaFilename = `${timestamp}_${id}.json`;

    const filePath = join(STORAGE_DIR, filename);
    const metaPath = join(STORAGE_DIR, metaFilename);

    try {
      // 1. 保存图片
      // 去掉可能存在的 data URI 前缀
      const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, "");
      const binaryData = Uint8Array.from(atob(base64Clean), (c) => c.charCodeAt(0));
      await Deno.writeFile(filePath, binaryData);

      // 2. 保存元数据
      const fullMetadata: ImageMetadata = {
        ...metadata,
        timestamp,
      };
      await Deno.writeTextFile(metaPath, JSON.stringify(fullMetadata, null, 2));

      info("Storage", `图片已保存: ${filename}`);
      return filename;
    } catch (e) {
      error("Storage", `保存图片失败: ${e}`);
      return null;
    }
  }

  /**
   * 获取所有图片列表（带元数据）
   */
  async listImages(): Promise<StoredImage[]> {
    await this.init();
    const images: StoredImage[] = [];

    try {
      for await (const entry of Deno.readDir(STORAGE_DIR)) {
        if (entry.isFile && entry.name.endsWith(".json")) {
          try {
            const metaPath = join(STORAGE_DIR, entry.name);
            const metaContent = await Deno.readTextFile(metaPath);
            const metadata = JSON.parse(metaContent) as ImageMetadata;
            
            // 对应的图片文件名 (假设是 png，实际应该从 metadata 或查找对应文件优化)
            // 这里简化逻辑，查找同名但后缀不同的文件
            const baseName = entry.name.replace(".json", "");
            // 尝试查找对应的图片文件 (支持 png, jpg, webp)
            const supportedExts = ["png", "jpg", "jpeg", "webp"];
            let imageFilename = "";
            
            for (const ext of supportedExts) {
                try {
                    await Deno.stat(join(STORAGE_DIR, `${baseName}.${ext}`));
                    imageFilename = `${baseName}.${ext}`;
                    break;
                } catch {
                    continue;
                }
            }

            if (imageFilename) {
              images.push({
                filename: imageFilename,
                url: `/storage/${imageFilename}`,
                metadata,
              });
            }
          } catch (_e) {
            // 忽略损坏的元数据文件
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
}

export const storageService = StorageService.getInstance();
