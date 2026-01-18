/**
 * 画廊 (Gallery) 模块
 * 
 * 负责渲染图片列表
 */
import { apiFetch } from "./utils.js";

export async function renderGallery(container) {
    // 动态加载 CSS
    if (!document.getElementById('gallery-css')) {
        const link = document.createElement('link');
        link.id = 'gallery-css';
        link.rel = 'stylesheet';
        link.href = '/css/gallery.css';
        document.head.appendChild(link);
    }

    container.innerHTML = `
        <div class="card full-width" style="padding: 0; overflow: hidden;">
            <div class="card-header" style="padding: 20px; border-bottom: 1px solid var(--border-color);">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <h3 class="card-title">图片画廊</h3>
                        <p style="color: var(--text-secondary); font-size: 14px; margin-top: 4px;">本地存储生成的图片历史</p>
                    </div>
                    <button class="btn primary-btn" onclick="location.reload()">
                        <i class="ri-refresh-line"></i> 刷新
                    </button>
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
            if (payload && typeof payload === 'object') {
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

            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && el.classList.contains("open")) close();
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
                img.style.cursor = "grabbing";
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
                img.style.cursor = "grab";
            });

            el.openWith = (url, alt) => {
                img.src = url;
                img.alt = alt || "";
                img.style.cursor = "grab";
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
                console.error("Copy failed:", err);
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
                console.error("Copy text failed:", err);
                alert("复制提示词失败");
            }
        };

        galleryContainer.innerHTML = images
            .map((img) => {
                if (!img) return "";
                const prompt = (img && img.metadata && img.metadata.prompt) ? String(img.metadata.prompt) : "";
                const model = (img && img.metadata && img.metadata.model) ? String(img.metadata.model) : "unknown";
                const ts = (img && img.metadata && img.metadata.timestamp) ? img.metadata.timestamp : Date.now();
                const url = (img && img.url) ? String(img.url) : "";

                const promptEsc = escapeHtml(prompt);
                const modelEsc = escapeHtml(model);
                const urlEsc = escapeHtml(url);
                const promptEncoded = encodeURIComponent(prompt);

                return `
            <div class="gallery-item">
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
                            <span class="gallery-size">获取中</span>
                        </div>
                        <div class="gallery-meta-item" style="justify-content: flex-end;">
                            <span title="${new Date(ts).toLocaleString()}">${new Date(ts).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
            })
            .join("");

        galleryContainer.querySelectorAll(".gallery-img").forEach((img) => {
            const updateSize = () => {
                const item = img.closest(".gallery-item");
                const sizeEl = item ? item.querySelector(".gallery-size") : null;
                if (!sizeEl) return;

                const w = img.naturalWidth;
                const h = img.naturalHeight;
                if (w && h) {
                    sizeEl.textContent = `${w}×${h}`;
                } else {
                    sizeEl.textContent = "加载失败";
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
                        if (sizeEl) sizeEl.textContent = "加载失败";
                    },
                    { once: true },
                );
            }
        });

        if (!galleryContainer.dataset.bound) {
            galleryContainer.addEventListener("click", async (e) => {
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
                    const lb = ensureLightbox();
                    lb.openWith(url, alt);
                }
            });
            galleryContainer.dataset.bound = "1";
        }

    } catch (e) {
        console.error("Failed to load gallery:", e);
        document.getElementById("gallery-container").innerHTML = `
            <div class="gallery-empty" style="color: var(--error);">
                <i class="ri-error-warning-line" style="font-size: 32px; margin-bottom: 8px;"></i>
                <p>加载失败: ${e.message}</p>
            </div>
        `;
    }
}
