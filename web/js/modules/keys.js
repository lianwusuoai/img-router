/**
 * Key 管理页面模块
 *
 * 负责渲染完整的 Key 管理界面，包括左侧 Provider 列表和右侧 Key 列表。
 * 支持 Key 的添加、删除、启用/禁用和状态统计。
 */

import { apiFetch, detectApiKey, escapeHtml, providerMeta } from "./utils.js";

let currentProvider = "Doubao"; // 默认选中第一个
let keyPool = [];

/**
 * 渲染 Key 管理页面
 *
 * @param {HTMLElement} container - 容器元素
 */
export async function renderKeys(container) {
  container.innerHTML = `
        <div class="card" style="height: calc(100vh - 140px); display: flex; flex-direction: column; padding: 0; overflow: hidden;">
            <div style="display: flex; flex: 1; overflow: hidden;">
                <!-- 左侧渠道列表 -->
                <div class="keys-sidebar" style="width: 240px; border-right: 1px solid var(--border-color); background: #fafafa; display: flex; flex-direction: column;">
                    <div style="padding: 20px 16px; font-weight: 600; color: var(--text-secondary); font-size: 12px; text-transform: uppercase;">选择渠道</div>
                    <div id="providerList" class="provider-list" style="flex: 1; overflow-y: auto; padding: 0 12px 12px;">
                        <!-- 动态生成 -->
                    </div>
                </div>

                <!-- 右侧 Key 列表 -->
                <div class="keys-content" style="flex: 1; display: flex; flex-direction: column; background: var(--surface);">
                    <div class="keys-header" style="padding: 20px 24px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <h3 id="currentProviderTitle" class="card-title" style="margin-bottom: 4px;">Doubao Keys</h3>
                            <div id="currentProviderDesc" style="font-size: 13px; color: var(--text-secondary);">管理 Doubao 模型的 API Key</div>
                        </div>
                        <button class="btn btn-primary" onclick="globalThis.showAddKeyModal()">
                            <i class="ri-add-line"></i> 添加 Key
                        </button>
                    </div>
                    
                    <div class="keys-table-container" style="flex: 1; overflow-y: auto; padding: 0;">
                        <table class="keys-table" style="width: 100%; border-collapse: collapse;">
                            <thead style="background: #f8f9fa; position: sticky; top: 0; z-index: 10;">
                                <tr>
                                    <th style="text-align: left; padding: 12px 24px; font-size: 12px; color: var(--text-secondary); font-weight: 600;">名称</th>
                                    <th style="text-align: left; padding: 12px 24px; font-size: 12px; color: var(--text-secondary); font-weight: 600;">Key (预览)</th>
                                    <th style="text-align: left; padding: 12px 24px; font-size: 12px; color: var(--text-secondary); font-weight: 600;">状态</th>
                                    <th style="text-align: left; padding: 12px 24px; font-size: 12px; color: var(--text-secondary); font-weight: 600;">统计</th>
                                    <th style="text-align: right; padding: 12px 24px; font-size: 12px; color: var(--text-secondary); font-weight: 600;">操作</th>
                                </tr>
                            </thead>
                            <tbody id="keysTableBody">
                                <!-- 动态生成 -->
                            </tbody>
                        </table>
                        <div id="emptyState" style="display: none; flex-direction: column; align-items: center; justify-content: center; padding: 60px; color: var(--text-secondary);">
                            <i class="ri-key-2-line" style="font-size: 48px; opacity: 0.2; margin-bottom: 16px;"></i>
                            <div>暂无 Key，请添加</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 添加 Key 弹窗 -->
        <div id="addKeyModal" class="modal">
            <div class="modal-content" style="width: 500px;">
                <div class="modal-header">
                    <h3 class="modal-title">添加 Key</h3>
                    <button class="modal-close" onclick="globalThis.closeAddKeyModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label class="form-label">Key 名称 (可选)</label>
                        <input type="text" id="newKeyName" class="form-control" placeholder="例如：我的测试 Key">
                    </div>
                    <div class="form-group">
                        <label class="form-label">API Key</label>
                        <textarea id="newKeyVal" class="form-control" rows="3" placeholder="sk-..." style="font-family: monospace;"></textarea>
                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">支持批量添加，每行一个 Key</div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn" style="background: var(--background); color: var(--text-primary);" onclick="globalThis.closeAddKeyModal()">取消</button>
                    <button class="btn btn-primary" onclick="globalThis.confirmAddKey()">确定添加</button>
                </div>
            </div>
        </div>
    `;

  // 暴露给全局以便 HTML onclick 调用
  globalThis.showAddKeyModal = showAddKeyModal;
  globalThis.closeAddKeyModal = closeAddKeyModal;
  globalThis.confirmAddKey = confirmAddKey;
  globalThis.deleteKey = deleteKey;
  globalThis.toggleKeyStatus = toggleKeyStatus;
  globalThis.switchProvider = switchProvider;

  await loadProviders();
  await loadKeys(currentProvider);
}

/**
 * 加载 Provider 列表 (左侧导航)
 */
async function loadProviders() {
  try {
    const res = await apiFetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();
    const providers = config.providers || [];

    const listEl = document.getElementById("providerList");
    if (!listEl) return;

    listEl.innerHTML = "";

    providers.forEach((p) => {
      const meta = providerMeta[p.name] || { icon: "ri-server-line", color: "#666" };
      const isActive = p.name === currentProvider;

      const div = document.createElement("div");
      div.className = `provider-item ${isActive ? "active" : ""}`;
      div.style.cssText = `
                display: flex; 
                align-items: center; 
                gap: 10px; 
                padding: 10px 12px; 
                cursor: pointer; 
                border-radius: 8px; 
                margin-bottom: 4px; 
                transition: all 0.2s;
                background: ${isActive ? "var(--primary-light)" : "transparent"};
                color: ${isActive ? "var(--primary)" : "var(--text-primary)"};
            `;
      div.onclick = () => switchProvider(p.name);

      div.innerHTML = `
                <i class="${meta.icon}" style="font-size: 18px; color: ${
        isActive ? "var(--primary)" : meta.color
      };"></i>
                <span style="font-weight: 500; font-size: 14px;">${p.name}</span>
            `;

      listEl.appendChild(div);
    });
  } catch (e) {
    console.error("加载提供商列表失败:", e);
  }
}

/**
 * 切换当前选中的 Provider
 *
 * @param {string} name - Provider 名称
 */
async function switchProvider(name) {
  currentProvider = name;

  // 更新左侧高亮
  document.querySelectorAll("#providerList > div").forEach((el) => {
    if (el.innerText.includes(name)) {
      el.style.background = "var(--primary-light)";
      el.style.color = "var(--primary)";
      const icon = el.querySelector("i");
      if (icon) icon.style.color = "var(--primary)";
    } else {
      el.style.background = "transparent";
      el.style.color = "var(--text-primary)";
      // 重绘列表以恢复原始 icon 颜色
      loadProviders();
    }
  });

  // 更新右侧标题
  const meta = providerMeta[name] || {};
  document.getElementById("currentProviderTitle").innerText = `${name} Keys`;
  document.getElementById("currentProviderDesc").innerText = meta.desc ||
    `管理 ${name} 模型的 API Key`;

  await loadKeys(name);
}

/**
 * 加载并渲染 Key 列表
 *
 * @param {string} provider - Provider 名称
 */
async function loadKeys(provider) {
  const tbody = document.getElementById("keysTableBody");
  const emptyState = document.getElementById("emptyState");
  if (!tbody) return;

  tbody.innerHTML =
    '<tr><td colspan="5" style="text-align:center; padding: 20px;">加载中...</td></tr>';
  emptyState.style.display = "none";

  try {
    const res = await apiFetch(`/api/key-pool?provider=${provider}`);
    if (!res.ok) throw new Error("加载失败");

    const data = await res.json();
    keyPool = data.pool || [];

    tbody.innerHTML = "";

    if (keyPool.length === 0) {
      emptyState.style.display = "flex";
      return;
    }

    keyPool.forEach((k) => {
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid var(--border-color)";
      tr.style.transition = "background 0.2s";
      tr.onmouseover = () => tr.style.background = "#f8f9fa";
      tr.onmouseout = () => tr.style.background = "transparent";

      const lastUsed = k.lastUsed ? new Date(k.lastUsed).toLocaleString() : "从未";
      const keyDisplay = k.key && typeof k.key === "string" && k.key.length > 8
        ? k.key.substring(0, 8) + "..." + k.key.slice(-4)
        : (k.key || "********");
      const successRate = k.totalCalls > 0
        ? Math.round((k.successCount / k.totalCalls) * 100) + "%"
        : "-";

      tr.innerHTML = `
                <td style="padding: 16px 24px;">
                    <div style="font-weight: 500; color: var(--text-primary);">${
        escapeHtml(k.name)
      }</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">ID: ${
        k.id && typeof k.id === "string" ? k.id.slice(0, 8) : "未知"
      }</div>
                </td>
                <td style="padding: 16px 24px;">
                    <code style="background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 4px; font-size: 12px;">${
        escapeHtml(keyDisplay)
      }</code>
                </td>
                <td style="padding: 16px 24px;">
                    <label class="switch" style="transform: scale(0.8); transform-origin: left center;">
                        <input type="checkbox" ${
        k.enabled ? "checked" : ""
      } onchange="globalThis.toggleKeyStatus('${escapeHtml(k.id)}', this.checked)">
                        <span class="slider"></span>
                    </label>
                    <span style="font-size: 12px; color: ${
        k.enabled ? "var(--success)" : "var(--text-secondary)"
      }; margin-left: 8px;">
                        ${k.enabled ? "已启用" : "已禁用"}
                    </span>
                </td>
                <td style="padding: 16px 24px;">
                    <div style="font-size: 12px;">调用: ${k.totalCalls || 0}</div>
                    <div style="font-size: 12px; color: var(--success);">成功率: ${successRate}</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">上次: ${lastUsed}</div>
                </td>
                <td style="padding: 16px 24px; text-align: right;">
                    <button class="btn icon-btn" onclick="globalThis.deleteKey('${escapeHtml(k.id)}')" title="删除" style="color: var(--error);">
                        <i class="ri-delete-bin-line"></i>
                    </button>
                </td>
            `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
    tbody.innerHTML =
      `<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--error);">加载失败: ${e.message}</td></tr>`;
  }
}

/**
 * 切换 Key 的启用状态
 *
 * @param {string} id - Key ID
 * @param {boolean} enabled - 启用状态
 */
async function toggleKeyStatus(id, enabled) {
  try {
    const res = await apiFetch("/api/key-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        provider: currentProvider,
        id: id,
        keyItem: { enabled: enabled },
      }),
    });

    if (!res.ok) throw new Error("更新状态失败");

    // 重新加载以确保数据一致性
    await loadKeys(currentProvider);
  } catch (e) {
    alert(e.message);
    // 如果失败，回滚开关状态
    await loadKeys(currentProvider);
  }
}

/**
 * 删除 Key
 *
 * @param {string} id - Key ID
 */
async function deleteKey(id) {
  console.log("[DEBUG deleteKey] Called with id:", id, "type:", typeof id);
  if (!confirm("确定要删除这个 Key 吗？")) return;
  console.log("[DEBUG deleteKey] User confirmed, sending request...");

  const requestBody = {
    action: "delete",
    provider: currentProvider,
    id,
  };
  console.log("[DEBUG deleteKey] Request body:", JSON.stringify(requestBody));

  try {
    const res = await apiFetch("/api/key-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) throw new Error("删除失败");
    await loadKeys(currentProvider);
  } catch (e) {
    alert(e.message);
  }
}

// ==========================================
// 弹窗相关函数
// ==========================================

function showAddKeyModal() {
  document.getElementById("addKeyModal").classList.add("active");
  document.getElementById("newKeyName").value = "";
  document.getElementById("newKeyVal").value = "";
}

function closeAddKeyModal() {
  document.getElementById("addKeyModal").classList.remove("active");
}

async function confirmAddKey() {
  const rawKeys = document.getElementById("newKeyVal").value.trim();
  const name = document.getElementById("newKeyName").value.trim();

  if (!rawKeys) {
    alert("请输入至少一个 Key");
    return;
  }

  const lines = rawKeys.split("\n").map((l) => l.trim()).filter(Boolean);

  // 验证 Key 格式
  const invalidKeys = [];
  for (const k of lines) {
    if (!detectApiKey(k, currentProvider)) {
      invalidKeys.push(k);
    }
  }

  if (invalidKeys.length > 0) {
    alert(
      `检测到 ${invalidKeys.length} 个 Key 不符合 ${currentProvider} 的格式要求：\n${
        invalidKeys.slice(0, 3).join("\n")
      }${invalidKeys.length > 3 ? "\n..." : ""}\n请检查是否选择了正确的渠道。`,
    );
    return;
  }

  try {
    // 如果只有一行且有名字，按单个添加
    if (lines.length === 1 && name) {
      const res = await apiFetch("/api/key-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          provider: currentProvider,
          keyItem: { key: lines[0], name: name },
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "添加失败");
    } else {
      // 批量添加
      const res = await apiFetch("/api/key-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batch_add",
          provider: currentProvider,
          keys: rawKeys,
          format: "auto",
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "添加失败");
    }

    closeAddKeyModal();
    await loadKeys(currentProvider);
  } catch (e) {
    alert(e.message);
  }
}
