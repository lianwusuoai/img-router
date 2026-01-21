/**
 * 画廊 (Gallery) 模块
 *
 * 负责渲染图片列表
 */
import { apiFetch } from "./utils.js";

export async function renderGallery(container) {
  // 动态加载 CSS
  if (!document.getElementById("gallery-css")) {
    const link = document.createElement("link");
    link.id = "gallery-css";
    link.rel = "stylesheet";
    link.href = "/css/gallery.css";
    document.head.appendChild(link);
  }

  // 辅助函数：时间格式化
  const formatDate = (ts) => {
    const d = new Date(ts);
    const pad = (n) => n.toString().padStart(2, "0");
    const padMs = (n) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${
      pad(d.getMinutes())
    }:${pad(d.getSeconds())}.${padMs(Math.floor(d.getMilliseconds() / 10))}`;
  };

  // 辅助函数：计算比例
  const formatSize = (w, h) => {
    if (!w || !h) return "Unknown";
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const d = gcd(w, h);
    const ratio = `${w / d}:${h / d}`;
    // 特殊比例修正
    if (ratio === "64:27") return "21:9";
    if (ratio === "27:64") return "9:21";
    return `${ratio} ${w}x${h}`;
  };

  container.innerHTML = `
        <div class="card full-width" style="padding: 0; overflow: hidden;">
            <div class="card-header" style="padding: 20px; border-bottom: 1px solid var(--border-color);">
                <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <div>
                        <h3 class="card-title">图片画廊</h3>
                        <p style="color: var(--text-secondary); font-size: 14px; margin-top: 4px;">本地存储生成的图片历史</p>
                    </div>
                    <div class="gallery-actions">
                        <button class="btn secondary-btn" id="btn-select-mode">
                            <i class="ri-checkbox-multiple-line"></i> 选择
                        </button>
                        <div id="selection-actions" style="display: none; gap: 12px; align-items: center;">
                            <span id="selection-count" style="font-size: 14px; color: var(--text-secondary); font-weight: 500;">已选 0</span>
                            <div style="display: flex; gap: 8px;">
                                <button class="btn danger-btn" id="btn-delete-selected">
                                    <i class="ri-delete-bin-line"></i> 删除
                                </button>
                                <button class="btn secondary-btn" id="btn-cancel-select">取消</button>
                            </div>
                        </div>
                        <button class="btn primary-btn" onclick="location.reload()" style="margin-left: 8px;">
                            <i class="ri-refresh-line"></i> 刷新
                        </button>
                    </div>
                </div>
            </div>
            <div id="gallery-container" class="gallery-grid">
                <div class="gallery-empty">
                    <i class="ri-loader-4-line ri-spin" style="font-size: 24px;"></i>
                    <p style="margin-top: 10px;">加载中...</p>
                </div>
            </div>
        </div>
    `;

  // 状态管理
  let isSelectionMode = false;
  const selectedFiles = new Set();

  const toggleSelectionMode = (active) => {
    isSelectionMode = active;
    const container = document.getElementById("gallery-container");
    const selectBtn = document.getElementById("btn-select-mode");
    const actions = document.getElementById("selection-actions");
    const refreshBtn = container.closest(".card").querySelector(".primary-btn"); // 刷新按钮

    if (active) {
      container.classList.add("selection-mode");
      selectBtn.style.display = "none";
      refreshBtn.style.display = "none";
      actions.style.display = "flex";
    } else {
      container.classList.remove("selection-mode");
      container.querySelectorAll(".gallery-checkbox").forEach((cb) => cb.checked = false);
      selectedFiles.clear();
      selectBtn.style.display = "inline-flex";
      refreshBtn.style.display = "inline-flex";
      actions.style.display = "none";
      updateSelectionCount();
    }
  };

  const updateSelectionCount = () => {
    document.getElementById("selection-count").textContent = `已选 ${selectedFiles.size}`;
  };

  // 绑定事件
  document.getElementById("btn-select-mode").onclick = () => toggleSelectionMode(true);
  document.getElementById("btn-cancel-select").onclick = () => toggleSelectionMode(false);

  document.getElementById("btn-delete-selected").onclick = async () => {
    if (selectedFiles.size === 0) return;
    if (!confirm(`确定要删除选中的 ${selectedFiles.size} 张图片吗？此操作不可恢复。`)) return;

    const btn = document.getElementById("btn-delete-selected");
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i> 删除中...';
    btn.disabled = true;

    try {
      const res = await apiFetch("/api/gallery", {
        method: "DELETE",
        body: JSON.stringify({ filenames: Array.from(selectedFiles) }),
      });

      if (!res.ok) throw new Error("删除失败");

      // 刷新页面或移除元素
      // 简单起见，重新渲染
      await renderGallery(container);
    } catch (e) {
      alert(`删除失败: ${e.message}`);
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  };

  try {
    const res = await apiFetch("/api/gallery");
    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = (payload && (payload.error || payload.message))
        ? (payload.error || payload.message)
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const images = (() => {
      if (Array.isArray(payload)) return payload;
      if (payload && typeof payload === "object") {
        if (Array.isArray(payload.images)) return payload.images;
        if (Array.isArray(payload.data)) return payload.data;
      }
      return [];
    })();

    const galleryContainer = document.getElementById("gallery-container");
    if (!Array.isArray(images) || images.length === 0) {
      galleryContainer.innerHTML = `
                <div class="gallery-empty">
                    <i class="ri-image-line" style="font-size: 48px; opacity: 0.5; margin-bottom: 16px;"></i>
                    <p>暂无生成的图片</p>
                </div>
            `;
      return;
    }

    const escapeHtml = (value) => {
      const s = (value === undefined || value === null) ? "" : String(value);
      return s.replace(/[&<>"']/g, (ch) => {
        switch (ch) {
          case "&":
            return "&amp;";
          case "<":
            return "&lt;";
          case ">":
            return "&gt;";
          case '"':
            return "&quot;";
          case "'":
            return "&#39;";
          default:
            return ch;
        }
      });
    };

    const ensureLightbox = () => {
      let el = document.getElementById("gallery-lightbox");
      if (el) return el;

      el = document.createElement("div");
      el.id = "gallery-lightbox";
      el.className = "gallery-lightbox";
      el.innerHTML = `
                <div class="gallery-lightbox-backdrop" data-action="close"></div>
                <div class="gallery-lightbox-content">
                    <button class="gallery-lightbox-close" type="button" data-action="close" title="关闭">
                        <i class="ri-close-line"></i>
                    </button>
                    <button class="gallery-lightbox-prev" type="button" title="上一张 (←)">
                        <i class="ri-arrow-left-s-line"></i>
                    </button>
                    <button class="gallery-lightbox-next" type="button" title="下一张 (→)">
                        <i class="ri-arrow-right-s-line"></i>
                    </button>
                    <img class="gallery-lightbox-img" alt="">
                </div>
            `;
      document.body.appendChild(el);

      const state = {
        scale: 1,
        tx: 0,
        ty: 0,
        dragging: false,
        lastX: 0,
        lastY: 0,
        currentIndex: 0,
        allImages: [],
      };

      const img = el.querySelector(".gallery-lightbox-img");
      const apply = () => {
        img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
      };

      const close = () => {
        el.classList.remove("open");
        document.body.style.overflow = "";
        state.scale = 1;
        state.tx = 0;
        state.ty = 0;
        apply();
        img.removeAttribute("src");
      };

      el.addEventListener("click", (e) => {
        const t = e.target;
        if (!(t instanceof Element)) return;
        if (t.closest('[data-action="close"]')) close();
      });


      el.addEventListener(
        "wheel",
        (e) => {
          if (!el.classList.contains("open")) return;
          e.preventDefault();

          const rect = img.getBoundingClientRect();
          const cx = e.clientX - rect.left;
          const cy = e.clientY - rect.top;

          const prev = state.scale;
          const factor = e.deltaY < 0 ? 1.12 : 0.89;
          const next = Math.max(0.2, Math.min(8, prev * factor));
          if (next === prev) return;

          const dx = cx - rect.width / 2;
          const dy = cy - rect.height / 2;

          state.tx -= dx * (next / prev - 1);
          state.ty -= dy * (next / prev - 1);
          state.scale = next;
          apply();
        },
        { passive: false },
      );

      img.addEventListener("mousedown", (e) => {
        if (!el.classList.contains("open")) return;
        e.preventDefault();
        state.dragging = true;
        state.lastX = e.clientX;
        state.lastY = e.clientY;
        img.classList.add("dragging");
      });

      globalThis.addEventListener("mousemove", (e) => {
        if (!state.dragging) return;
        const dx = e.clientX - state.lastX;
        const dy = e.clientY - state.lastY;
        state.lastX = e.clientX;
        state.lastY = e.clientY;
        state.tx += dx;
        state.ty += dy;
        apply();
      });

      globalThis.addEventListener("mouseup", () => {
        if (!state.dragging) return;
        state.dragging = false;
        img.classList.remove("dragging");
      });

      // 导航函数
      const navigate = (direction) => {
        if (state.allImages.length === 0) return;
        
        state.currentIndex += direction;
        if (state.currentIndex < 0) state.currentIndex = state.allImages.length - 1;
        if (state.currentIndex >= state.allImages.length) state.currentIndex = 0;
        
        const imgData = state.allImages[state.currentIndex];
        img.src = imgData.url;
        img.alt = imgData.alt;
        
        // 重置缩放和位置
        state.scale = 1;
        state.tx = 0;
        state.ty = 0;
        apply();
      };

      // 左右箭头点击事件
      el.querySelector('.gallery-lightbox-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        navigate(-1);
      });

      el.querySelector('.gallery-lightbox-next').addEventListener('click', (e) => {
        e.stopPropagation();
        navigate(1);
      });

      // 键盘事件监听
      const keydownHandler = (e) => {
        if (!el.classList.contains('open')) return;
        
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          navigate(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          navigate(1);
        } else if (e.key === 'Escape') {
          close();
        }
      };

      // 移除旧的 Escape 键监听，使用新的统一键盘处理
      document.addEventListener('keydown', keydownHandler);

      el.openWith = (url, alt, images, index) => {
        state.allImages = images || [];
        state.currentIndex = index || 0;
        
        img.src = url;
        img.alt = alt || "";
        state.scale = 1;
        state.tx = 0;
        state.ty = 0;
        apply();
        el.classList.add("open");
        document.body.style.overflow = "hidden";
      };

      return el;
    };

    const copyImageToClipboard = async (url, btn) => {
      const originalIcon = btn.innerHTML;
      try {
        btn.innerHTML = '<i class="ri-loader-4-line ri-spin"></i>';

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const blob = await response.blob();

        await navigator.clipboard.write([
          new ClipboardItem({
            [blob.type]: blob,
          }),
        ]);

        btn.innerHTML = '<i class="ri-check-line"></i>';
        setTimeout(() => {
          btn.innerHTML = originalIcon;
        }, 2000);
      } catch (err) {
        console.error("复制失败:", err);
        alert("复制图片失败: " + (err && err.message ? err.message : String(err)));
        btn.innerHTML = '<i class="ri-error-warning-line"></i>';
        setTimeout(() => {
          btn.innerHTML = originalIcon;
        }, 2000);
      }
    };

    const copyTextToClipboard = async (text, btn) => {
      const originalIcon = btn.innerHTML;
      try {
        await navigator.clipboard.writeText(text);

        btn.innerHTML = '<i class="ri-check-line"></i>';
        btn.style.color = "var(--success)";
        btn.style.borderColor = "var(--success)";

        setTimeout(() => {
          btn.innerHTML = originalIcon;
          btn.style.color = "";
          btn.style.borderColor = "";
        }, 2000);
      } catch (err) {
        console.error("复制文本失败:", err);
        alert("复制提示词失败");
      }
    };

    galleryContainer.innerHTML = images
      .map((img) => {
        if (!img) return "";
        const prompt = (img && img.metadata && img.metadata.prompt)
          ? String(img.metadata.prompt)
          : "";
        const model = (img && img.metadata && img.metadata.model)
          ? String(img.metadata.model)
          : "unknown";
        const ts = (img && img.metadata && img.metadata.timestamp)
          ? img.metadata.timestamp
          : Date.now();
        const url = (img && img.url) ? String(img.url) : "";
        const filename = (img && img.filename) ? String(img.filename) : ""; // 用于删除

        const promptEsc = escapeHtml(prompt);
        const modelEsc = escapeHtml(model);
        const urlEsc = escapeHtml(url);
        const promptEncoded = encodeURIComponent(prompt);
        const dateStr = formatDate(ts);

        return `
            <div class="gallery-item" data-filename="${filename}">
                <div class="gallery-checkbox-wrapper">
                    <input type="checkbox" class="gallery-checkbox" data-filename="${filename}">
                </div>
                <div class="gallery-img-container">
                    <img src="${urlEsc}" class="gallery-img" loading="lazy" alt="${promptEsc}" data-full-url="${urlEsc}" data-full-alt="${promptEsc}">
                    <button class="gallery-copy-btn" type="button" data-copy-image-url="${urlEsc}" title="复制图片">
                        <i class="ri-file-copy-line"></i>
                    </button>
                </div>
                <div class="gallery-info">
                    <div class="gallery-prompt-container">
                        <div class="gallery-prompt" title="${promptEsc}">${promptEsc}</div>
                        <button class="gallery-copy-prompt-btn" type="button" data-copy-text="${promptEncoded}" title="复制提示词">
                            <i class="ri-file-copy-2-line"></i>
                        </button>
                    </div>
                    <div class="gallery-meta-grid">
                        <div style="grid-column: 1 / -1; margin-bottom: 4px;">
                            <span class="gallery-tag" title="${modelEsc}">${modelEsc}</span>
                        </div>
                        <div class="gallery-meta-item">
                            <i class="ri-aspect-ratio-line"></i>
                            <span class="gallery-size">Calculating...</span>
                        </div>
                        <div class="gallery-meta-item" style="justify-content: flex-end;">
                            <span title="${dateStr}" style="font-family: monospace;">${dateStr}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
      })
      .join("");

    // Lazy Load Observer
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const img = entry.target;
          // Preload Logic
          const link = document.createElement("link");
          link.rel = "preload";
          link.as = "image";
          link.href = img.src;
          document.head.appendChild(link);
          observer.unobserve(img);
        }
      });
    }, { rootMargin: "200px" });

    galleryContainer.querySelectorAll(".gallery-img").forEach((img) => {
      observer.observe(img); // Start observing

      const updateSize = () => {
        const item = img.closest(".gallery-item");
        const sizeEl = item ? item.querySelector(".gallery-size") : null;
        if (!sizeEl) return;

        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w && h) {
          sizeEl.textContent = formatSize(w, h);
        } else {
          sizeEl.textContent = "Error";
        }
      };

      if (img.complete) {
        updateSize();
      } else {
        img.addEventListener("load", updateSize, { once: true });
        img.addEventListener(
          "error",
          () => {
            const item = img.closest(".gallery-item");
            const sizeEl = item ? item.querySelector(".gallery-size") : null;
            if (sizeEl) sizeEl.textContent = "Error";
          },
          { once: true },
        );
      }
    });

    // Checkbox Event Listeners
    galleryContainer.addEventListener("change", (e) => {
      if (e.target.classList.contains("gallery-checkbox")) {
        const filename = e.target.dataset.filename;
        if (e.target.checked) {
          selectedFiles.add(filename);
          e.target.closest(".gallery-item").classList.add("selected");
        } else {
          selectedFiles.delete(filename);
          e.target.closest(".gallery-item").classList.remove("selected");
        }
        updateSelectionCount();
      }
    });

    // Click item to select in selection mode
    galleryContainer.addEventListener("click", (e) => {
      // 如果不在选择模式，且点击的是图片本身（非按钮），则什么都不做（因为 data-bound 会处理 Lightbox）
      // 但我们需要确保 Lightbox 只在非选择模式下触发

      if (isSelectionMode) {
        // Ignore if clicking checkbox directly or buttons (buttons handle their own events)
        // 但实际上 checkbox 点击会冒泡，我们只需要捕获 item 点击

        const item = e.target.closest(".gallery-item");
        if (item && !e.target.closest("button") && !e.target.closest("input")) {
          e.preventDefault();
          e.stopPropagation(); // 防止触发其他点击事件
          const cb = item.querySelector(".gallery-checkbox");
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else {
        // 非选择模式：点击空白处退出预览逻辑在 Lightbox 内部实现
        // 这里不需要额外处理，Lightbox 的 backdrop 点击已绑定 close
      }
    });

    if (!galleryContainer.dataset.bound) {
      galleryContainer.addEventListener("click", async (e) => {
        // 如果是选择模式，且点击的是图片区域，阻止 Lightbox
        if (isSelectionMode) {
          // 如果点击的是图片，且上面已经处理了选择逻辑，这里需要阻止默认行为
          // 由于上面的 listener 是后绑定的（或者顺序问题），我们需要确保 Lightbox 逻辑里检查 isSelectionMode
          // 最简单的方法是在这里检查
          if (e.target.closest(".gallery-img") || e.target.closest(".gallery-item")) {
            // e.preventDefault(); // 已经在上面处理了
            return;
          }
        }

        const t = e.target;
        if (!(t instanceof Element)) return;

        const copyImgBtn = t.closest(".gallery-copy-btn");
        if (copyImgBtn) {
          e.preventDefault();
          e.stopPropagation();
          const url = copyImgBtn.getAttribute("data-copy-image-url") || "";
          await copyImageToClipboard(url, copyImgBtn);
          return;
        }

        const copyTextBtn = t.closest(".gallery-copy-prompt-btn");
        if (copyTextBtn) {
          e.preventDefault();
          e.stopPropagation();
          const encoded = copyTextBtn.getAttribute("data-copy-text") || "";
          const text = decodeURIComponent(encoded);
          await copyTextToClipboard(text, copyTextBtn);
          return;
        }

        const img = t.closest(".gallery-img");
        if (img) {
          e.preventDefault();
          const url = img.getAttribute("data-full-url") || img.getAttribute("src") || "";
          const alt = img.getAttribute("data-full-alt") || img.getAttribute("alt") || "";
          
          // 获取所有图片数据
          const allImgs = Array.from(galleryContainer.querySelectorAll('.gallery-img')).map(imgEl => ({
            url: imgEl.getAttribute("data-full-url") || imgEl.getAttribute("src") || "",
            alt: imgEl.getAttribute("data-full-alt") || imgEl.getAttribute("alt") || ""
          }));
          
          // 找到当前图片的索引
          const currentIndex = Array.from(galleryContainer.querySelectorAll('.gallery-img')).indexOf(img);
          
          const lb = ensureLightbox();
          lb.openWith(url, alt, allImgs, currentIndex);
        }
      });
      galleryContainer.dataset.bound = "1";
    }
  } catch (e) {
    console.error("加载画廊失败:", e);
    document.getElementById("gallery-container").innerHTML = `
            <div class="gallery-empty" style="color: var(--error);">
                <i class="ri-error-warning-line" style="font-size: 32px; margin-bottom: 8px;"></i>
                <p>加载失败: ${e.message}</p>
            </div>
        `;
  }
}
