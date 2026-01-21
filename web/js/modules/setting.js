/**
 * 系统设置模块
 *
 * 负责管理系统基础配置，包括端口、超时、CORS、日志、健康检查、运行模式和图片压缩设置。
 * 支持自动保存功能。
 */

import { apiFetch } from "./utils.js";

let saveTimer = null;
let saveInFlight = false;
let pendingSave = false;

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
                <div style="display: flex; gap: 8px; align-items: center;">
                    <div id="settingSaveStatus" style="font-size: 12px; color: var(--text-secondary); opacity: 0; transition: opacity 0.3s;">
                        <i class="ri-check-line"></i> 已保存
                    </div>
                    <div class="status-pill">
                        <span class="status-dot"></span>
                        <span>运行中</span>
                    </div>
                </div>
            </div>
            
            <div class="form-section" style="padding: 16px;">
                <!-- 第一行：端口、超时、请求体 -->
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px;">
                    <div class="form-group" style="margin-bottom: 0;">
                        <label class="form-label">服务端口 <span class="badge" style="font-size:10px; margin-left:4px;">重启生效</span></label>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <input type="number" id="port" class="form-control" placeholder="10001" style="flex: 1;">
                            <button class="btn btn-primary" id="restartDockerBtn" type="button" style="padding: 10px 14px; white-space: nowrap;">重启Docker</button>
                        </div>
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
                <h3 class="card-title">图片压缩（支持常见图片格式：JPG, PNG, GIF, WEBP）</h3>
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
    if (input.type === "checkbox") {
      // 开关类控件：立即保存
      input.addEventListener("change", () => triggerSave(true));
    } else {
      // 输入框：输入时防抖保存，失去焦点或回车立即保存
      input.addEventListener("input", () => triggerSave(false));
      input.addEventListener("change", () => triggerSave(true));
      input.addEventListener("blur", () => triggerSave(true));
    }
  });

  // 加载当前设置
  await loadSystemSettings();

  const restartBtn = document.getElementById("restartDockerBtn");
  if (restartBtn) {
    restartBtn.addEventListener("click", restartDocker);
  }
}

async function restartDocker() {
  const confirmed = globalThis.confirm(
    "将执行 docker compose up -d 以应用端口配置，可能短暂中断服务。是否继续？",
  );
  if (!confirmed) return;

  const btn = document.getElementById("restartDockerBtn");
  const originalText = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "重启中...";
  }

  const portEl = document.getElementById("port");
  const nextPort = portEl && "value" in portEl ? Number.parseInt(String(portEl.value), 10) : NaN;
  const targetUrl = Number.isFinite(nextPort) && nextPort > 0
    ? (() => {
      const url = new URL(globalThis.location.href);
      url.port = String(nextPort);
      url.pathname = "/setting";
      url.search = "";
      url.hash = "";
      return url.toString();
    })()
    : "";

  const targetPingUrl = targetUrl
    ? (() => {
      const url = new URL(targetUrl);
      url.pathname = "/api/info";
      url.search = `t=${Date.now()}`;
      return url.toString();
    })()
    : "";

  const controller = new AbortController();
  const timeoutMs = 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await apiFetch("/api/restart-docker", {
      method: "POST",
      signal: controller.signal,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const msg = data && data.error ? data.error : (text || "重启失败");
      throw new Error(msg);
    }
    if (targetUrl) {
      const waitMs = 60_000;
      const start = Date.now();
      while (Date.now() - start < waitMs) {
        try {
          const pingUrl = (() => {
            const u = new URL(targetPingUrl);
            u.searchParams.set("t", String(Date.now()));
            return u.toString();
          })();
          await fetch(pingUrl, { cache: "no-store", mode: "no-cors" });
          break;
        } catch (e) {
          void e;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      globalThis.location.href = targetUrl;
      return;
    }
    globalThis.alert(
      "已触发重启。端口映射将在容器重建后生效。\n\n如果页面短暂无法访问，请稍等几秒刷新。",
    );
  } catch (e) {
    const isAbort = typeof e === "object" && e !== null && "name" in e && e.name === "AbortError";
    const msg = e instanceof Error ? e.message : String(e);
    globalThis.alert(
      isAbort ? "重启请求超时：后端未及时响应。请稍等片刻刷新页面确认状态。" : `重启失败：${msg}`,
    );
  } finally {
    clearTimeout(timer);
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || "重启Docker";
    }
  }
}

/**
 * 从后端加载系统配置
 */
async function loadSystemSettings() {
  try {
    const res = await apiFetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val !== undefined ? val : "";
    };
    const setCheck = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.checked = !!val;
    };

    // 基础设置
    setVal("port", config.port);
    setVal("timeout", config.timeout / 1000);
    setVal("maxBody", config.maxBody / 1024 / 1024);

    setCheck("cors", config.cors);
    setCheck("logging", config.logging);
    setCheck("health", config.healthCheck);

    // 运行模式
    const runtimeSystem = (config.runtimeConfig && config.runtimeConfig.system)
      ? config.runtimeConfig.system
      : {};
    const modes = runtimeSystem.modes || { relay: true, backend: false };

    setCheck("modeRelay", modes.relay);
    setCheck("modeBackend", modes.backend);
    setVal("globalAccessKey", runtimeSystem.globalAccessKey);

    const token = typeof runtimeSystem.globalAccessKey === "string"
      ? runtimeSystem.globalAccessKey
      : "";
    if (token) {
      localStorage.setItem("authToken", token);
    } else {
      localStorage.removeItem("authToken");
    }

    // 图片压缩设置 (从 runtimeConfig 读取)
    setVal("compressThreshold", runtimeSystem.compressThreshold || 5);
    setVal("compressTarget", runtimeSystem.compressTarget || 2);
  } catch (e) {
    console.error("加载设置失败:", e);
  }
}

function updateSaveStatus(status) {
  const el = document.getElementById("settingSaveStatus");
  const dot = document.querySelector(".status-dot");
  const text = document.querySelector(".status-pill span");

  if (!el) return;

  if (status === "saving") {
    el.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> 保存中...';
    el.style.opacity = "1";
    el.style.color = "var(--text-secondary)";
    if (dot) dot.style.background = "#ffd700";
    if (text) text.innerText = "保存中...";
  } else if (status === "saved") {
    el.innerHTML = '<i class="ri-check-line"></i> 已保存';
    el.style.opacity = "1";
    el.style.color = "var(--success-color, #10b981)";
    if (dot) dot.style.background = "var(--success)";
    if (text) text.innerText = "运行中";

    // 2秒后淡出
    setTimeout(() => {
      if (el.innerHTML.includes("已保存")) {
        el.style.opacity = "0";
      }
    }, 2000);
  } else if (status === "error") {
    el.innerHTML = '<i class="ri-error-warning-line"></i> 保存失败';
    el.style.opacity = "1";
    el.style.color = "var(--error-color, #ef4444)";
    if (dot) dot.style.background = "var(--error)";
    if (text) text.innerText = "保存失败";
  } else if (status === "unsaved") {
    el.innerHTML = '<i class="ri-edit-circle-line"></i> 未保存';
    el.style.opacity = "1";
    el.style.color = "var(--warning-color, #f59e0b)";
  }
}

/**
 * 触发保存
 * @param {boolean} immediate - 是否立即保存
 */
function triggerSave(immediate = false) {
  // 如果正在保存中，跳过本次触发
  if (saveInFlight) {
    pendingSave = true;
    return;
  }

  updateSaveStatus("unsaved");

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  if (immediate) {
    saveSystemSettings();
  } else {
    saveTimer = setTimeout(() => {
      saveSystemSettings();
      saveTimer = null;
    }, 500); // 500ms 防抖
  }
}

/**
 * 保存系统配置到后端
 */
async function saveSystemSettings() {
  if (saveInFlight) {
    pendingSave = true;
    return;
  }

  saveInFlight = true;
  updateSaveStatus("saving");

  try {
    const getVal = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : "";
    };
    const getNum = (id) => {
      const el = document.getElementById(id);
      return el ? Number(el.value) : 0;
    };
    const getCheck = (id) => {
      const el = document.getElementById(id);
      return el ? el.checked : false;
    };

    const systemConfig = {
      // 基础设置
      port: getNum("port"),
      apiTimeout: getNum("timeout") * 1000, // 转换为毫秒
      maxBodySize: getNum("maxBody") * 1024 * 1024, // 转换为字节

      // 功能开关
      cors: getCheck("cors"),
      requestLogging: getCheck("logging"),
      healthCheck: getCheck("health"),

      modes: {
        relay: getCheck("modeRelay"),
        backend: getCheck("modeBackend"),
      },
      globalAccessKey: getVal("globalAccessKey"),
      // 图片压缩配置
      compressThreshold: getNum("compressThreshold"),
      compressTarget: getNum("compressTarget"),

      // 功能特性
      features: {
        autoConvertWebP: getCheck("autoConvertWebP"),
      },
    };

    // 构建 S3 配置 (仅当存在对应 DOM 时获取)
    let s3Config = undefined;
    const s3Endpoint = document.getElementById("s3Endpoint");
    if (s3Endpoint) {
      s3Config = {
        endpoint: getVal("s3Endpoint"),
        region: getVal("s3Region"),
        bucket: getVal("s3Bucket"),
        accessKey: getVal("s3AccessKey"),
        secretKey: getVal("s3SecretKey"),
        publicUrl: getVal("s3PublicUrl"),
      };
    }

    const payload = {
      system: systemConfig,
      storage: s3Config ? { s3: s3Config } : undefined,
    };

    // 发送运行时配置更新
    const res = await apiFetch("/api/runtime-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const token = typeof systemConfig.globalAccessKey === "string"
        ? systemConfig.globalAccessKey
        : "";
      if (token) {
        localStorage.setItem("authToken", token);
      } else {
        localStorage.removeItem("authToken");
      }
      updateSaveStatus("saved");
    } else {
      throw new Error("Save failed");
    }
  } catch (e) {
    console.error(e);
    updateSaveStatus("error");
  } finally {
    saveInFlight = false;
    if (pendingSave) {
      pendingSave = false;
      triggerSave(true);
    }
  }
}
