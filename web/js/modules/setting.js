/**
 * 系统设置模块
 *
 * 负责管理系统基础配置，包括端口、超时、CORS、日志、健康检查、运行模式和图片压缩设置。
 * 支持自动保存功能。
 */

import { apiFetch, debounce } from "./utils.js";

/**
 * 渲染设置页面
 *
 * @param {HTMLElement} container - 容器元素
 */
export async function renderSetting(container) {
  container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">基础设置</h3>
            </div>
            
            <div class="form-section" style="padding: 16px;">
                <!-- 第一行：端口、超时、请求体 -->
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">服务端口 <span class="badge" style="font-size:10px; margin-left:4px;">重启生效</span></label>
                        <input type="number" id="port" class="form-control" placeholder="10001">
                    </div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">API 超时 (秒)</label>
                        <input type="number" id="timeout" class="form-control" placeholder="120">
                    </div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">最大请求体 (MB)</label>
                        <input type="number" id="maxBody" class="form-control" placeholder="10">
                        <div class="help-text" style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">限制单次请求上传文件的大小，建议设置为 10-50MB</div>
                    </div>
                </div>

                <!-- 第二行：CORS、日志、健康检查 -->
                <div style="display: flex; gap: 32px; border-top: 1px solid var(--border-color); padding-top: 16px;">
                    <div class="switch-group-inline">
                        <label class="switch" style="transform: scale(0.8);">
                            <input type="checkbox" id="cors">
                            <span class="slider"></span>
                        </label>
                        <div class="switch-label">
                            <div style="font-weight: 500;">CORS 跨域</div>
                            <div style="font-size: 12px; color: var(--text-secondary);">允许跨域请求</div>
                        </div>
                    </div>

                    <div class="switch-group-inline">
                        <label class="switch" style="transform: scale(0.8);">
                            <input type="checkbox" id="logging">
                            <span class="slider"></span>
                        </label>
                        <div class="switch-label">
                            <div style="font-weight: 500;">请求日志</div>
                            <div style="font-size: 12px; color: var(--text-secondary);">记录请求详情</div>
                        </div>
                    </div>

                    <div class="switch-group-inline">
                        <label class="switch" style="transform: scale(0.8);">
                            <input type="checkbox" id="health">
                            <span class="slider"></span>
                        </label>
                        <div class="switch-label">
                            <div style="font-weight: 500;">健康检查</div>
                            <div style="font-size: 12px; color: var(--text-secondary);">启用 /health</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-header">
                <h3 class="card-title">图片压缩</h3>
            </div>
            <div class="form-section" style="padding: 20px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px;">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">压缩阈值 (MB)</label>
                        <input type="number" id="compressThreshold" class="form-control" placeholder="5">
                        <div class="help-text" style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">当图片超过此大小时自动压缩</div>
                    </div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">目标大小 (MB)</label>
                        <input type="number" id="compressTarget" class="form-control" placeholder="2">
                        <div class="help-text" style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">压缩后的目标大小</div>
                    </div>
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label class="form-label">支持格式</label>
                    <div style="font-size: 13px; color: var(--text-secondary); padding: 10px 0;">
                        支持所有常见图片格式：<span style="font-weight: 500; color: var(--text-primary);">JPG, PNG, GIF, WEBP</span>
                    </div>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-header">
                <h3 class="card-title">运行模式</h3>
            </div>
            <div class="form-section" style="padding: 16px;">
                <!-- 模式选择 -->
                <div style="display: flex; gap: 16px; margin-bottom: 16px;">
                    <label class="mode-card">
                        <input type="checkbox" id="modeRelay" class="mode-checkbox">
                        <div class="mode-content">
                            <i class="ri-route-line mode-icon"></i>
                            <div>
                                <div class="mode-title">中转模式</div>
                                <div class="mode-desc">作为网关转发，无Key</div>
                            </div>
                        </div>
                    </label>

                    <label class="mode-card">
                        <input type="checkbox" id="modeBackend" class="mode-checkbox">
                        <div class="mode-content">
                            <i class="ri-server-line mode-icon"></i>
                            <div>
                                <div class="mode-title">后端模式</div>
                                <div class="mode-desc">使用后端 Key 池</div>
                            </div>
                        </div>
                    </label>
                </div>

                <!-- 访问密钥 -->
                <div class="form-group" style="display: flex; align-items: center; gap: 16px; margin-bottom: 0; background: #fafafa; padding: 12px; border-radius: 8px;">
                    <label class="form-label" style="margin: 0; white-space: nowrap; width: 120px;">全局访问密钥</label>
                    <input type="text" id="globalAccessKey" class="form-control" placeholder="用于后端模式的鉴权凭证（留空则不校验）" style="flex: 1;">
                </div>
            </div>
        </div>


        <style>
            .switch-group-inline {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .mode-card {
                flex: 1;
                cursor: pointer;
                position: relative;
            }
            .mode-checkbox {
                position: absolute;
                opacity: 0;
            }
            .mode-content {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 16px;
                border: 2px solid var(--border-color);
                border-radius: 8px;
                transition: all 0.2s;
            }
            .mode-checkbox:checked + .mode-content {
                border-color: var(--primary);
                background: var(--primary-light);
            }
            .mode-icon {
                font-size: 24px;
                color: var(--text-secondary);
            }
            .mode-checkbox:checked + .mode-content .mode-icon {
                color: var(--primary);
            }
            .mode-title {
                font-weight: 600;
                font-size: 14px;
            }
            .mode-desc {
                font-size: 12px;
                color: var(--text-secondary);
            }
        </style>
    `;

  // 事件监听：自动保存
  const inputs = container.querySelectorAll("input");
  inputs.forEach((input) => {
    input.addEventListener("change", debounceSave);
    input.addEventListener("input", debounceSave);
  });

  // 加载当前设置
  await loadSystemSettings();
}

/**
 * 从后端加载系统配置
 */
async function loadSystemSettings() {
  try {
    const res = await apiFetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();

    // 基础设置
    document.getElementById("port").value = config.port;
    document.getElementById("timeout").value = config.timeout / 1000;
    document.getElementById("maxBody").value = config.maxBody / 1024 / 1024;

    document.getElementById("cors").checked = config.cors;
    document.getElementById("logging").checked = config.logging;
    document.getElementById("health").checked = config.healthCheck;

    // 运行模式
    const runtimeSystem = (config.runtimeConfig && config.runtimeConfig.system)
      ? config.runtimeConfig.system
      : {};
    const modes = runtimeSystem.modes || { relay: true, backend: false };

    document.getElementById("modeRelay").checked = modes.relay;
    document.getElementById("modeBackend").checked = modes.backend;
    document.getElementById("globalAccessKey").value = runtimeSystem.globalAccessKey || "";

    // 图片压缩设置 (从 runtimeConfig 读取)
    document.getElementById("compressThreshold").value = runtimeSystem.compressThreshold || 5;
    document.getElementById("compressTarget").value = runtimeSystem.compressTarget || 2;
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
}

/**
 * 防抖保存函数
 */
const debounceSave = debounce(async () => {
  await saveSystemSettings();
}, 1000);

/**
 * 保存系统配置到后端
 */
async function saveSystemSettings() {
  const statusDot = document.querySelector(".status-dot");
  const statusText = document.querySelector(".status-pill span");
  if (statusDot) {
    statusDot.style.background = "#ffd700";
    if (statusText) statusText.innerText = "保存中...";
  }

  try {
    const systemConfig = {
      // 基础设置
      port: Number(document.getElementById("port").value),
      apiTimeout: Number(document.getElementById("timeout").value) * 1000, // 转换为毫秒
      maxBodySize: Number(document.getElementById("maxBody").value) * 1024 * 1024, // 转换为字节

      // 功能开关
      cors: document.getElementById("cors").checked,
      requestLogging: document.getElementById("logging").checked,
      healthCheck: document.getElementById("health").checked,

      modes: {
        relay: document.getElementById("modeRelay").checked,
        backend: document.getElementById("modeBackend").checked,
      },
      globalAccessKey: document.getElementById("globalAccessKey").value,
      // 图片压缩配置 (扁平化存储以匹配后端 SystemConfig)
      compressThreshold: Number(document.getElementById("compressThreshold").value),
      compressTarget: Number(document.getElementById("compressTarget").value),

      // 功能特性
      features: {
        autoConvertWebP: document.getElementById("autoConvertWebP").checked,
      },
    };

    // 构建 S3 配置
    const s3Config = {
      endpoint: document.getElementById("s3Endpoint").value,
      region: document.getElementById("s3Region").value,
      bucket: document.getElementById("s3Bucket").value,
      accessKey: document.getElementById("s3AccessKey").value,
      secretKey: document.getElementById("s3SecretKey").value,
      publicUrl: document.getElementById("s3PublicUrl").value,
    };

    // 如果 S3 关键字段不为空，则更新 storage 配置
    // 注意：这里需要确保后端支持接收 storage 字段的更新，目前 /api/runtime-config 接收 { system: ... }
    // 我们需要调整后端 app.ts 或者在此处构造正确的 payload
    // 查看 app.ts，/api/runtime-config 接收 { system, providers }
    // 我们需要把 storage 放入 payload 的顶层（如果后端支持）或者 system 中？
    // 检查 app.ts，runtimeConfig 结构是 { system, providers, keyPools, storage }
    // app.ts 的 POST 处理逻辑:
    // const nextConfig = { ...current.providers, ...current.system, ... }
    // 它只处理了 system 和 providers 的 patch
    // 我们需要修改 app.ts 来支持 storage 的更新

    // 这里先构造 payload，稍后（或同时）去修改 app.ts
    const payload = {
      system: systemConfig,
      storage: {
        s3: s3Config.endpoint ? s3Config : undefined,
      },
    };

    // 发送运行时配置更新
    await apiFetch("/api/runtime-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (statusDot) {
      statusDot.style.background = "var(--success)";
      if (statusText) statusText.innerText = "已保存";
      setTimeout(() => {
        if (statusText) statusText.innerText = "运行中";
      }, 2000);
    }
  } catch (e) {
    console.error(e);
    if (statusDot) statusDot.style.background = "var(--error)";
    if (statusText) statusText.innerText = "保存失败";
  }
}
