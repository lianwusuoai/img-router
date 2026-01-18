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

        <div class="card">
            <div class="card-header">
                <h3 class="card-title">智能增强 (AiChat)</h3>
            </div>
            <div class="form-section" style="padding: 16px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">API Base URL</label>
                        <input type="text" id="aiChatBaseUrl" class="form-control" placeholder="https://api.openai.com/v1">
                    </div>
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">Model</label>
                        <input type="text" id="aiChatModel" class="form-control" placeholder="gpt-3.5-turbo">
                    </div>
                </div>
                <div class="form-group" style="margin-bottom: 0;">
                    <label class="form-label">API Key</label>
                    <input type="password" id="aiChatApiKey" class="form-control" placeholder="sk-...">
                </div>
                <div class="help-text" style="font-size: 12px; color: var(--text-secondary); margin-top: 8px;">
                    配置兼容 OpenAI 格式的 LLM 服务，用于 Prompt 翻译、优化和扩充。
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

    // 加载 AiChat 配置
    try {
        const resChat = await apiFetch("/api/config/ai-chat");
        if (resChat.ok) {
            const chatConfig = await resChat.json();
            if (chatConfig) {
                document.getElementById("aiChatBaseUrl").value = chatConfig.baseUrl || "";
                document.getElementById("aiChatApiKey").value = chatConfig.apiKey || ""; // Will be ******
                document.getElementById("aiChatModel").value = chatConfig.model || "";
            }
        }
    } catch (e) {
        console.error("Failed to load AiChat settings:", e);
    }
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
    };

    // 发送运行时配置更新
    await apiFetch("/api/runtime-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: systemConfig }),
    });

    // 保存 AiChat 配置
    const aiChatBaseUrl = document.getElementById("aiChatBaseUrl").value;
    if (aiChatBaseUrl) {
        await apiFetch("/api/config/ai-chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                baseUrl: aiChatBaseUrl,
                apiKey: document.getElementById("aiChatApiKey").value,
                model: document.getElementById("aiChatModel").value
            }),
        });
    }

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
