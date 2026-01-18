/**
 * AI 助手 (AiChat) 设置模块
 *
 * 负责渲染和管理 AI 聊天的配置。
 * 包括 BaseURL, API Key, Model, 以及翻译和扩充的提示词模板。
 */

import { apiFetch } from "./utils.js";

/**
 * 渲染 AI 助手设置页面
 *
 * @param {HTMLElement} container - 容器元素
 */
export async function renderAiChat(container) {
  container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3 class="card-title">AI 助手 (AiChat) 配置</h3>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <div id="aiChatSaveStatus" style="font-size: 12px; color: var(--text-secondary); opacity: 0; transition: opacity 0.3s;">
                        <i class="ri-check-line"></i> 已保存
                    </div>
                    <div class="status-pill">
                        <span class="status-dot"></span>
                        <span>运行中</span>
                    </div>
                </div>
            </div>
            <div id="aiChatContainer">
                <div class="loading">加载中...</div>
            </div>
        </div>
    `;

  if (!container.dataset.aiChatBound) {
    container.dataset.aiChatBound = "1";

    container.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (!target.matches("[data-field]")) return;
      
      debouncedSave(container);
    });

    container.addEventListener("change", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches("[data-field]")) return;
      
      // 立即保存
      saveAiChatConfig();
    });

    container.addEventListener("focusin", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('[data-field="model"]')) {
        showModelDropdown(container);
      }
    });

    container.addEventListener("click", async (e) => {
      const target = e.target;
      
      const btn = target.closest("#btnTestConnection");
      if (btn) {
        await testConnection(btn);
        return;
      }

      const dropdownItem = e.target.closest(".model-option");
      if (dropdownItem) {
        const modelInput = container.querySelector('[data-field="model"]');
        if (!modelInput) return;
        const value = dropdownItem.dataset.value;

        if (value === "custom") {
          modelInput.value = "";
          modelInput.focus();
        } else {
          modelInput.value = value;
          await saveAiChatConfig();
        }

        const dropdown = container.querySelector("#modelDropdown");
        if (dropdown) dropdown.style.display = "none";
        return;
      }

      if (!e.target.closest('[data-field="model"]') && !e.target.closest("#modelDropdown")) {
        const dropdown = container.querySelector("#modelDropdown");
        if (dropdown) dropdown.style.display = "none";
      }
    });
  }

  await loadAiChatConfig();
}

/**
 * 显示模型下拉菜单
 */
async function showModelDropdown(container) {
    const dropdown = container.querySelector("#modelDropdown");
    const baseUrlInput = container.querySelector('[data-field="baseUrl"]');
    const apiKeyInput = container.querySelector('[data-field="apiKey"]');

    if (!dropdown || !baseUrlInput || !apiKeyInput) return;

    const baseUrl = baseUrlInput.value;
    const apiKey = apiKeyInput.value;

    if (!baseUrl || !apiKey) {
        renderDropdownContent(dropdown, []);
        dropdown.innerHTML = '<div style="padding: 8px; color: var(--warning-color, #f59e0b);">请先填写 Base URL 和 API Key</div>';
        dropdown.style.display = "block";
        return;
    }

    dropdown.innerHTML = '<div style="padding: 8px; color: var(--text-secondary);"><i class="ri-loader-4-line ri-spin"></i> 加载模型列表...</div>';
    dropdown.style.display = "block";

    try {
        const res = await apiFetch("/api/tools/fetch-models", {
            method: "POST",
            body: JSON.stringify({ baseUrl, apiKey }),
        });
        
        if (res.ok) {
          const data = await res.json();
          renderDropdownContent(dropdown, data.models || []);
        } else {
          const data = await res.json().catch(() => ({}));
          const errorMsg = data.error || "获取失败";
          dropdown.innerHTML = `
            <div style="padding: 8px; color: var(--error-color, #ef4444);">
                <i class="ri-error-warning-line"></i> ${errorMsg}
            </div>
            <div class="model-option" data-value="custom" style="padding: 8px 12px; cursor: pointer; border-top: 1px solid var(--border-color); color: var(--text-primary);">
                <i class="ri-edit-line"></i> 自定义模型 ID (手动输入)
            </div>
          `;
        }
    } catch (e) {
        console.error("Fetch models failed", e);
        dropdown.innerHTML = `
            <div style="padding: 8px; color: var(--error-color, #ef4444);">
                <i class="ri-error-warning-line"></i> 网络错误
            </div>
            <div class="model-option" data-value="custom" style="padding: 8px 12px; cursor: pointer; border-top: 1px solid var(--border-color); color: var(--text-primary);">
                <i class="ri-edit-line"></i> 自定义模型 ID (手动输入)
            </div>
        `;
    }
}

function renderDropdownContent(dropdown, models) {
    let html = `
        <div class="model-option" data-value="custom" style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--border-color); color: var(--text-primary);">
            <i class="ri-edit-line"></i> 自定义模型 ID (手动输入)
        </div>
    `;

    if (models && models.length > 0) {
        html += models.map(m => `
            <div class="model-option" data-value="${m}" style="padding: 8px 12px; cursor: pointer; color: var(--text-secondary);">
                ${m}
            </div>
        `).join("");
    }

    dropdown.innerHTML = html;

    const options = dropdown.querySelectorAll('.model-option');
    options.forEach(opt => {
        opt.addEventListener('mouseenter', () => opt.style.backgroundColor = 'var(--bg-tertiary)');
        opt.addEventListener('mouseleave', () => opt.style.backgroundColor = 'transparent');
    });
}

/**
 * 测试 AI Chat 连接
 * @param {HTMLButtonElement} btn - 按钮元素
 */
async function testConnection(btn) {
  const container = document.getElementById("aiChatContainer");
  const baseUrl = container.querySelector('[data-field="baseUrl"]').value;
  const apiKey = container.querySelector('[data-field="apiKey"]').value;
  const model = container.querySelector('[data-field="model"]').value;

  if (!baseUrl || !apiKey) {
    alert("请先填写 Base URL 和 API Key");
    return;
  }

  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> 测试中...';
  btn.disabled = true;

  try {
    const res = await apiFetch("/api/tools/test-ai-chat", {
      method: "POST",
      body: JSON.stringify({ baseUrl, apiKey, model }),
    });
    
    const data = await res.json();
    if (res.ok && data.ok) {
      alert(`连接成功！\nLLM 回复: ${data.message}`);
    } else {
      alert(`连接失败: ${data.error || "未知错误"}`);
    }
  } catch (e) {
    alert(`请求出错: ${e.message}`);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

/**
 * 加载 AI 助手配置
 */
async function loadAiChatConfig() {
  const container = document.getElementById("aiChatContainer");
  if (!container) return;

  try {
    const res = await apiFetch("/api/config/ai-chat");
    let config = {};
    if (res.ok) {
      config = await res.json();
    }

    container.innerHTML = `
            <div class="form-section" style="padding: 16px;">
                <div class="form-header">
                    <h4 style="margin: 0; font-size: 1rem; color: var(--text-primary);">基础配置</h4>
                    <p style="margin: 4px 0 0; font-size: 0.8rem; color: var(--text-secondary);">配置兼容 OpenAI 格式的 LLM 服务</p>
                </div>
                <div class="form-grid" style="grid-template-columns: 1fr 1fr;">
                    <div class="form-group">
                        <label class="form-label">API Base URL</label>
                        <input type="text" class="form-control" data-field="baseUrl" value="${
      config.baseUrl || ""
    }" placeholder="例如: https://api.openai.com/v1 或 http://localhost:10000/v1 或 http://new-api:3000/v1">
                    </div>
                    <div class="form-group" style="position: relative;">
                        <label class="form-label">Model</label>
                        <input type="text" class="form-control" data-field="model" value="${
      config.model || ""
    }" placeholder="gpt-3.5-turbo" autocomplete="off">
                        <div id="modelDropdown" class="model-dropdown" style="display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 4px; max-height: 200px; overflow-y: auto; z-index: 1000; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);"></div>
                    </div>
                </div>
                <div class="form-group" style="display: flex; gap: 8px; align-items: flex-end;">
                    <div style="flex: 1;">
                        <label class="form-label">API Key</label>
                        <input type="text" class="form-control" data-field="apiKey" value="${
      config.apiKey || ""
    }" placeholder="sk-...">
                    </div>
                    <button class="btn btn-secondary" id="btnTestConnection" style="height: 36px; white-space: nowrap;">
                        <i class="ri-plug-line"></i> 测试连接
                    </button>
                </div>
            </div>

            <div class="form-section" style="padding: 16px;">
                <div class="form-header">
                    <h4 style="margin: 0; font-size: 1rem; color: var(--text-primary);">Prompt 优化配置</h4>
                    <p style="margin: 4px 0 0; font-size: 0.8rem; color: var(--text-secondary);">自定义提示词翻译和扩充的 System Prompt</p>
                </div>
                
                <div class="form-group" style="display: flex; flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <label class="form-label" style="margin-bottom: 0;">启用翻译功能 (Global Translate)</label>
                    <label class="switch">
                        <input type="checkbox" data-field="enableTranslate" ${config.enableTranslate ? "checked" : ""}>
                        <span class="slider"></span>
                    </label>
                </div>

                <div class="form-group">
                    <label class="form-label">翻译提示词模板 (Translation System Prompt)</label>
                    <textarea class="form-control" data-field="translatePrompt" rows="3" placeholder="默认: You are a professional prompt engineer and translator...">${
      config.translatePrompt || ""
    }</textarea>
                    <div class="help-text" style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                        用于将用户的非英文 Prompt 翻译为英文。请确保指令要求 LLM 仅输出翻译结果，不包含解释。
                    </div>
                </div>

                <div class="form-group" style="display: flex; flex-direction: row; align-items: center; justify-content: space-between; margin-bottom: 8px; margin-top: 20px;">
                    <label class="form-label" style="margin-bottom: 0;">启用扩充功能 (Global Expand)</label>
                    <label class="switch">
                        <input type="checkbox" data-field="enableExpand" ${config.enableExpand ? "checked" : ""}>
                        <span class="slider"></span>
                    </label>
                </div>

                <div class="form-group">
                    <label class="form-label">扩充提示词模板 (Expansion System Prompt)</label>
                    <textarea class="form-control" data-field="expandPrompt" rows="3" placeholder="默认: You are a professional prompt engineer. Expand the user's short prompt...">${
      config.expandPrompt || ""
    }</textarea>
                    <div class="help-text" style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">
                        用于将简短的 Prompt 扩充为详细的描述性 Prompt。
                    </div>
                </div>
            </div>
        `;
  } catch (e) {
    console.error("Failed to load AiChat settings:", e);
    container.innerHTML =
      '<div style="padding:20px; text-align:center; color:red;">加载失败</div>';
  }
}

let saveTimer = null;

function updateSaveStatus(status) {
    const el = document.getElementById("aiChatSaveStatus");
    if (!el) return;

    if (status === "saving") {
        el.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> 保存中...';
        el.style.opacity = "1";
        el.style.color = "var(--text-secondary)";
    } else if (status === "saved") {
        el.innerHTML = '<i class="ri-check-line"></i> 已保存';
        el.style.opacity = "1";
        el.style.color = "var(--success-color, #10b981)";
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
    } else if (status === "unsaved") {
        el.innerHTML = '<i class="ri-edit-circle-line"></i> 未保存';
        el.style.opacity = "1";
        el.style.color = "var(--warning-color, #f59e0b)";
    }
}

function debouncedSave(container) {
  updateSaveStatus("unsaved");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveAiChatConfig();
    saveTimer = null;
  }, 100); // 缩短到 100ms
}

let saveInFlight = false;
let pendingPayload = null;

async function saveAiChatConfig(overridePayload) {
  const container = document.getElementById("aiChatContainer");
  if (!container) return;
  
  updateSaveStatus("saving");

  const payload = overridePayload || (() => {
    const p = {};
    container.querySelectorAll("[data-field]").forEach((el) => {
      const field = el.dataset.field;
      if (!field) return;
      if (el.type === "checkbox") {
        p[field] = el.checked;
      } else {
        p[field] = el.value;
      }
    });
    return p;
  })();

  if (saveInFlight) {
    pendingPayload = payload;
    return;
  }

  saveInFlight = true;
  try {
    const res = await apiFetch("/api/config/ai-chat", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error("保存失败", data);
      updateSaveStatus("error");
    } else {
      updateSaveStatus("saved");
    }
  } catch (e) {
    console.error("保存出错", e);
    updateSaveStatus("error");
  } finally {
    saveInFlight = false;
    if (pendingPayload) {
      const next = pendingPayload;
      pendingPayload = null;
      await saveAiChatConfig(next);
    }
  }
}
