// URL Shortener Frontend Script - short.290102.xyz

(() => {
  const storage = {
    get(key, fallback = null) {
      try {
        const val = localStorage.getItem(key);
        return val !== null ? val : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem(key, typeof val === "string" ? val : JSON.stringify(val));
      } catch (e) {}
    }
  };

  const STATE = {
    theme: storage.get("short_theme", "dark"),
    links: []
  };

  function init() {
    applyTheme(STATE.theme);
    loadSavedLinks();
    initEventListeners();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function loadSavedLinks() {
    try {
      const raw = storage.get("short_links", "[]");
      STATE.links = JSON.parse(raw) || [];
      renderLinksList();
      // Silently refresh stats of recent links
      refreshAllStats();
    } catch {
      STATE.links = [];
    }
  }

  function saveLinks() {
    storage.set("short_links", JSON.stringify(STATE.links));
    renderLinksList();
  }

  async function refreshAllStats() {
    if (!STATE.links.length) return;
    for (const link of STATE.links.slice(0, 10)) {
      try {
        const res = await fetch(`/api/stats/${link.slug}`);
        const data = await res.json();
        if (data.ok) {
          link.clicks = data.link.clicks;
          link.isExpired = data.isExpired;
        }
      } catch {}
    }
    saveLinks();
  }

  function initEventListeners() {
    // Form submit
    document.getElementById("form-shorten")?.addEventListener("submit", handleShorten);

    // Toggle options
    document.getElementById("btn-toggle-options")?.addEventListener("click", () => {
      const panel = document.getElementById("options-panel");
      const icon = document.getElementById("options-chevron");
      panel.classList.toggle("hidden");
      icon.classList.toggle("rotate-180");
    });

    // Copy result
    document.getElementById("btn-copy-result")?.addEventListener("click", () => {
      const shortUrl = document.getElementById("result-short-url")?.textContent;
      if (shortUrl) copyText(shortUrl);
    });

    // QR modal
    document.getElementById("btn-view-qr")?.addEventListener("click", () => {
      const shortUrl = document.getElementById("result-short-url")?.textContent;
      if (!shortUrl) return;
      renderQr(shortUrl);
      document.getElementById("modal-qr").classList.remove("hidden");
    });
    document.getElementById("btn-close-qr")?.addEventListener("click", () => {
      document.getElementById("modal-qr").classList.add("hidden");
    });

    // Theme toggle
    document.getElementById("btn-theme-toggle")?.addEventListener("click", () => {
      const next = STATE.theme === "dark" ? "light" : "dark";
      applyTheme(next);
    });

    // API Tabs
    document.querySelectorAll(".api-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const targetTab = btn.dataset.tab;
        document.querySelectorAll(".api-tab-btn").forEach(b => {
          b.classList.remove("active", "bg-blue-600", "text-white");
          b.classList.add("bg-gray-800/80", "text-gray-400");
        });
        btn.classList.add("active", "bg-blue-600", "text-white");
        btn.classList.remove("bg-gray-800/80", "text-gray-400");

        document.querySelectorAll(".api-tab-pane").forEach(pane => {
          pane.classList.add("hidden");
        });
        document.getElementById(targetTab)?.classList.remove("hidden");
      });
    });

    // Copy Code Buttons in API Docs
    document.querySelectorAll(".btn-copy-code").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.dataset.code;
        if (code) {
          copyText(code);
          showToast("Código copiado al portapapeles", "success");
        }
      });
    });
  }

  async function handleShorten(e) {
    e.preventDefault();
    const urlInput = document.getElementById("input-url");
    const aliasInput = document.getElementById("input-alias");
    const ttlSelect = document.getElementById("select-ttl");
    const submitBtn = document.getElementById("btn-submit");

    const targetUrl = urlInput.value.trim();
    const customSlug = aliasInput.value.trim();
    const ttlSeconds = Number(ttlSelect.value);

    if (!targetUrl) return;

    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <svg class="w-4 h-4 animate-spin inline mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>
      Acortando...
    `;

    try {
      const res = await fetch("/api/shorten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl, customSlug, ttlSeconds })
      });
      const data = await res.json();

      if (!data.ok) {
        showToast(data.message || data.error, "error");
        return;
      }

      // Display result card
      showResultCard(data);

      // Add to saved history
      STATE.links = [
        {
          slug: data.slug,
          shortUrl: data.shortUrl,
          targetUrl: data.targetUrl,
          expiresAt: data.expiresAt,
          clicks: 0
        },
        ...STATE.links.filter(l => l.slug !== data.slug)
      ].slice(0, 20);

      saveLinks();
      showToast("¡Enlace acortado con éxito!", "success");
      urlInput.value = "";
      aliasInput.value = "";
    } catch (err) {
      showToast("Error de conexión al acortar el enlace", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = "Acortar URL";
    }
  }

  function showResultCard(data) {
    const card = document.getElementById("result-card");
    const shortUrlElem = document.getElementById("result-short-url");
    const targetUrlElem = document.getElementById("result-target-url");
    const expiryElem = document.getElementById("result-expiry");
    const visitBtn = document.getElementById("btn-visit-result");

    shortUrlElem.textContent = data.shortUrl;
    targetUrlElem.textContent = data.targetUrl;
    visitBtn.href = data.shortUrl;

    const expiryDate = new Date(data.expiresAt * 1000);
    expiryElem.textContent = `Expira: ${expiryDate.toLocaleDateString([], { month: "short", day: "numeric" })} ${expiryDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    card.classList.remove("hidden");
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderLinksList() {
    const container = document.getElementById("recent-links-list");
    const emptyNotice = document.getElementById("empty-links-notice");
    if (!container) return;

    if (!STATE.links.length) {
      container.innerHTML = "";
      if (emptyNotice) emptyNotice.classList.remove("hidden");
      return;
    }

    if (emptyNotice) emptyNotice.classList.add("hidden");

    container.innerHTML = STATE.links.map(l => {
      const now = Math.floor(Date.now() / 1000);
      const isExpired = l.expiresAt <= now;
      const expiryDate = new Date(l.expiresAt * 1000);

      return `
        <div class="p-4 rounded-xl bg-[#080c14] border border-[#1e293b] flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-[#334155] transition-all">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 mb-1">
              <a href="${l.shortUrl}" target="_blank" rel="noopener" class="font-mono text-sm font-bold text-blue-400 hover:underline truncate">
                ${l.shortUrl}
              </a>
              ${isExpired ? '<span class="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">Expirado</span>' : '<span class="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Activo</span>'}
            </div>
            <div class="text-xs text-gray-500 truncate max-w-md">
              ${escapeHtml(l.targetUrl)}
            </div>
          </div>

          <div class="flex items-center gap-4 flex-shrink-0">
            <div class="text-right">
              <div class="text-xs font-bold text-gray-200">${l.clicks || 0} clics</div>
              <div class="text-[11px] text-gray-500">${expiryDate.toLocaleDateString([], { month: "short", day: "numeric" })}</div>
            </div>
            <button data-url="${l.shortUrl}" class="btn-copy-history p-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-all" title="Copiar enlace">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join("");

    container.querySelectorAll(".btn-copy-history").forEach(btn => {
      btn.onclick = () => copyText(btn.dataset.url);
    });
  }

  function renderQr(text) {
    const container = document.getElementById("qr-container");
    if (!container) return;
    document.getElementById("qr-url-text").textContent = text;
    const encoded = encodeURIComponent(text);
    container.innerHTML = `
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}&bgcolor=ffffff&color=0b0f19&margin=8" 
           alt="Código QR" 
           class="w-48 h-48 rounded-xl shadow-lg border border-gray-700 bg-white p-2">
    `;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Enlace copiado al portapapeles", "success");
    } catch {
      showToast("Copia manual: " + text, "info");
    }
  }

  function applyTheme(theme) {
    STATE.theme = theme;
    storage.set("short_theme", theme);
    const body = document.body;
    const icon = document.getElementById("theme-icon");

    if (theme === "light") {
      body.classList.add("light");
      body.classList.remove("dark");
      if (icon) icon.innerHTML = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
    } else {
      body.classList.remove("light");
      body.classList.add("dark");
      if (icon) {
        icon.innerHTML = `
          <circle cx="12" cy="12" r="4"/>
          <path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>
          <path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>
        `;
      }
    }
  }

  function showToast(msg, type = "info") {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    const bg = {
      success: "bg-emerald-600 text-white border-emerald-500",
      error: "bg-rose-600 text-white border-rose-500",
      info: "bg-gray-800 text-white border-gray-700"
    }[type] || "bg-gray-800 text-white border-gray-700";

    toast.className = `toast px-4 py-2.5 rounded-xl text-sm font-medium border shadow-2xl ${bg}`;
    toast.textContent = msg;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c]);
  }
})();
