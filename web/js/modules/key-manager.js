/**
 * 简易 Key 管理器模块 (Modal 模式)
 *
 * 注意：此模块似乎与 keys.js 功能重叠，keys.js 提供了更完整的页面级管理。
 * 此模块可能用于快速弹窗管理，或者作为旧代码保留。
 * 建议优先使用 keys.js 的完整页面。
 */

import { apiFetch, escapeHtml } from "./utils.js";

let currentKeyProvider = "";

/**
 * 初始化 Key 管理器模态框
 *
 * 将模态框 HTML 注入到页面中。
 */
export function initKeyManager() {
  // 确保模态框 HTML 存在
  if (!document.getElementById("keyManagerModal")) {
    const modalHtml = `
            <div id="keyManagerModal" class="modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:1000; justify-content:center; align-items:center;">
                <div class="modal-content" style="background:var(--bg-card); padding:20px; border-radius:8px; width:700px; max-width:90%; box-shadow: 0 4px 20px rgba(0,0,0,0.3); border: 1px solid var(--border-color);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <h3 id="keyManagerTitle" style="margin:0;">管理 Keys</h3>
                        <button id="closeKeyManagerBtn" style="background:none; border:none; color:var(--text-primary); cursor:pointer; font-size:24px; padding:0; line-height:1;"><i class="ri-close-line"></i></button>
                    </div>
                    
                    <div style="background:var(--bg-main); padding:15px; border-radius:8px; margin-bottom:20px;">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:14px;">添加新 Key</h4>
                        <div id="newKeyForm" style="display:flex; flex-direction:column; gap:10px;">
                            <div style="display:flex; gap:10px;">
                                <input type="text" id="newKeyVal" placeholder="输入 API Key" class="form-control" style="flex:2;">
                                <input type="text" id="newKeyName" placeholder="备注 (可选)" class="form-control" style="flex:1;">
                            </div>
                            <div id="newApiFields" style="display:none; flex-direction:column; gap:10px;">
                                <input type="text" id="newKeyBaseUrl" placeholder="API Base URL (例如: https://api.example.com)" class="form-control">
                                <input type="text" id="newKeyModels" placeholder="模型列表 (逗号分隔，例如: gpt-4,gpt-3.5-turbo)" class="form-control">
                            </div>
                            <button class="btn btn-primary" id="addKeyBtn">添加</button>
                        </div>
                    </div>

                    <div style="max-height:400px; overflow-y:auto; border:1px solid var(--border-color); border-radius:8px;">
                        <table style="width:100%; text-align:left; border-collapse:collapse; font-size:14px;">
                            <thead style="background:var(--bg-main); position:sticky; top:0;">
                                <tr style="border-bottom:1px solid var(--border-color);">
                                    <th style="padding:12px;">备注</th>
                                    <th style="padding:12px;">Key (末4位)</th>
                                    <th style="padding:12px;">状态</th>
                                    <th style="padding:12px; width:80px;">操作</th>
                                </tr>
                            </thead>
                            <tbody id="keyTableBody"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
    document.getElementById("modal-container").innerHTML = modalHtml;

    // 绑定关闭按钮
    document.getElementById("closeKeyManagerBtn").onclick = closeKeyManager;
    document.getElementById("addKeyBtn").onclick = addKey;

    // 点击遮罩关闭
    document.getElementById("keyManagerModal").onclick = (e) => {
      if (e.target.id === "keyManagerModal") closeKeyManager();
    };
  }
}

/**
 * 打开 Key 管理器
 *
 * @param {string} provider - Provider 名称
 */
export async function openKeyManager(provider) {
  currentKeyProvider = provider;
  const modal = document.getElementById("keyManagerModal");
  const title = document.getElementById("keyManagerTitle");

  if (modal && title) {
    title.innerText = `管理 ${provider} Keys`;
    modal.style.display = "flex";
    document.getElementById("newKeyVal").value = "";
    document.getElementById("newKeyName").value = "";
    
    // 显示/隐藏 NewApi 特殊字段
    const newApiFields = document.getElementById("newApiFields");
    if (newApiFields) {
      newApiFields.style.display = provider === "NewApi" ? "flex" : "none";
      if (provider === "NewApi") {
        document.getElementById("newKeyBaseUrl").value = "";
        document.getElementById("newKeyModels").value = "";
      }
    }
    
    await loadKeys();
  }
}

function closeKeyManager() {
  const modal = document.getElementById("keyManagerModal");
  if (modal) modal.style.display = "none";
  currentKeyProvider = "";
}

/**
 * 加载 Key 列表
 */
async function loadKeys() {
  if (!currentKeyProvider) return;
  try {
    const res = await apiFetch(`/api/key-pool?provider=${currentKeyProvider}`);
    if (!res.ok) throw new Error("Failed to load keys");
    const data = await res.json();
    renderKeyTable(data.pool || []);
  } catch (e) {
    console.error(e);
    alert("加载 Key 列表失败");
  }
}

function renderKeyTable(pool) {
  const tbody = document.getElementById("keyTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (pool.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--text-secondary);">暂无 Key</td></tr>';
    return;
  }

  pool.forEach((k) => {
    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px solid var(--border-color)";

    const lastUsed = k.lastUsed ? new Date(k.lastUsed).toLocaleString() : "未使用";
    const keyDisplay = k.key && typeof k.key === "string" && k.key.length > 4
      ? "..." + k.key.slice(-4)
      : (k.key || "********");

    // NewApi 特殊信息显示
    let extraInfo = "";
    if (currentKeyProvider === "NewApi") {
      const url = k.baseUrl ? escapeHtml(k.baseUrl) : "未设置";
      const models = k.models && Array.isArray(k.models) && k.models.length > 0
        ? escapeHtml(k.models.join(", "))
        : "未设置";
      extraInfo = `
        <span style="font-size:12px; color:var(--text-secondary); display:block;">URL: ${url}</span>
        <span style="font-size:12px; color:var(--text-secondary); display:block;">模型: ${models}</span>
      `;
    }

    tr.innerHTML = `
            <td style="padding:12px;">${escapeHtml(k.name)}</td>
            <td style="padding:12px; font-family:monospace;">${keyDisplay}</td>
            <td style="padding:12px;">
                <span style="font-size:12px; color:var(--text-secondary); display:block;">最后使用: ${lastUsed}</span>
                ${extraInfo}
            </td>
            <td style="padding:12px;">
                <button class="btn delete-key-btn" style="padding:4px 8px; background:#dc3545; color:white;" data-id="${k.id}">删除</button>
            </td>
        `;
    tbody.appendChild(tr);
  });

  // 绑定删除按钮
  tbody.querySelectorAll(".delete-key-btn").forEach((btn) => {
    btn.onclick = () => deleteKey(btn.dataset.id);
  });
}

/**
 * 添加 Key
 */
async function addKey() {
  const keyInput = document.getElementById("newKeyVal");
  const nameInput = document.getElementById("newKeyName");

  const key = keyInput.value.trim();
  const name = nameInput.value.trim();

  if (!key) {
    alert("请输入 API Key");
    return;
  }

  const keyItem = { key, name: name || "Key" };

  // NewApi 特殊字段处理
  if (currentKeyProvider === "NewApi") {
    const baseUrlInput = document.getElementById("newKeyBaseUrl");
    const modelsInput = document.getElementById("newKeyModels");
    
    const baseUrl = baseUrlInput?.value.trim();
    const modelsStr = modelsInput?.value.trim();
    
    if (!baseUrl) {
      alert("请输入 API Base URL");
      return;
    }
    
    keyItem.baseUrl = baseUrl;
    keyItem.models = modelsStr ? modelsStr.split(",").map(m => m.trim()).filter(m => m) : [];
  }

  try {
    const res = await apiFetch("/api/key-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add",
        provider: currentKeyProvider,
        keyItem,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "添加失败");
    }

    keyInput.value = "";
    nameInput.value = "";
    if (currentKeyProvider === "NewApi") {
      document.getElementById("newKeyBaseUrl").value = "";
      document.getElementById("newKeyModels").value = "";
    }
    await loadKeys();
  } catch (e) {
    alert(e.message);
  }
}

/**
 * 删除 Key
 *
 * @param {string} id - Key ID
 */
async function deleteKey(id) {
  if (!confirm("确定要删除这个 Key 吗？")) return;

  try {
    const res = await apiFetch("/api/key-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "delete",
        provider: currentKeyProvider,
        id,
      }),
    });

    if (!res.ok) throw new Error("删除失败");
    await loadKeys();
  } catch (e) {
    alert(e.message);
  }
}

// 暴露给全局，以便 HTML 内联 onclick 调用
globalThis.openKeyManager = openKeyManager;
