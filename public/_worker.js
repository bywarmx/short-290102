// Cloudflare Pages Advanced Worker for short.290102.xyz
// Features: D1 Database + Cloudflare Edge Cache API (Zero quota waste on repeated visits)

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const RESERVED = new Set(["api", "assets", "docs", "favicon.ico", "favicon.svg", "style.css", "app.js", "robots.txt", "sitemap.xml"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return handleCors();
    }

    // API Routes
    if (pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx, url);
    }

    // Static root, docs page, or static files
    if (pathname === "/" || pathname === "/docs" || pathname.startsWith("/docs/") || pathname.includes(".")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }

    // Redirection route: /:slug
    const slug = pathname.replace(/^\/+|\/+$/g, "");
    if (!slug || RESERVED.has(slug.toLowerCase())) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
    }

    return handleRedirect(request, env, ctx, slug, url);
  }
};

// --- REDIRECTION WITH EDGE CACHE ---
async function handleRedirect(request, env, ctx, slug, currentUrl) {
  const cache = caches.default;
  const now = Math.floor(Date.now() / 1000);

  // 1. Check Cloudflare Edge Cache
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  // 2. Query D1 database
  try {
    const row = await env.DB.prepare(
      "SELECT target_url, expires_at, clicks FROM links WHERE slug = ?"
    ).bind(slug).first();

    // Not found
    if (!row) {
      return notFoundHtml(slug, "Enlace no encontrado", "El enlace corto que intentas visitar no existe o fue eliminado.");
    }

    // Expired
    if (row.expires_at <= now) {
      // Async clean up
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(env.DB.prepare("DELETE FROM links WHERE slug = ?").bind(slug).run().catch(() => {}));
      }
      return notFoundHtml(slug, "Enlace expirado", "Este enlace temporal ha alcanzado su tiempo límite de expiración.");
    }

    // 3. Increment clicks counter asynchronously in background
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(
        env.DB.prepare("UPDATE links SET clicks = clicks + 1 WHERE slug = ?").bind(slug).run().catch(() => {})
      );
    }

    // 4. Calculate Cache TTL (up to 24h, never exceeding the expiration time)
    const maxAge = Math.max(60, Math.min(86400, row.expires_at - now));

    // 5. Construct Instant Redirect Response (HTTP 302)
    const redirectResponse = new Response(null, {
      status: 302,
      headers: {
        "Location": row.target_url,
        "Cache-Control": `public, max-age=${maxAge}`,
        "X-Robots-Tag": "noindex, nofollow"
      }
    });

    // 6. Store in Cloudflare Edge Cache so repeated visits do NOT touch D1
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(request, redirectResponse.clone()));
    }

    return redirectResponse;
  } catch (err) {
    console.error("Redirect query error:", err);
    return notFoundHtml(slug, "Error en el servidor", "Ocurrió un problema temporal al procesar la redirección.");
  }
}

// --- API HANDLERS ---
async function handleApi(request, env, ctx, url) {
  try {
    // 1. POST or GET /api/shorten
    if (url.pathname === "/api/shorten") {
      let targetUrl = "";
      let customSlug = "";
      let ttl = 1296000; // default: 15 días (15 * 86400)
      let format = url.searchParams.get("format") || "";

      if (request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const body = await request.json().catch(() => ({}));
          targetUrl = String(body.url || "").trim();
          customSlug = String(body.alias || body.customSlug || body.slug || "").trim();
          if (body.ttlSeconds || body.ttl) ttl = Number(body.ttlSeconds || body.ttl);
          if (body.format) format = body.format;
        } else if (contentType.includes("application/x-www-form-urlencoded")) {
          const form = await request.formData().catch(() => new FormData());
          targetUrl = String(form.get("url") || "").trim();
          customSlug = String(form.get("alias") || form.get("customSlug") || form.get("slug") || "").trim();
          if (form.get("ttlSeconds") || form.get("ttl")) ttl = Number(form.get("ttlSeconds") || form.get("ttl"));
          if (form.get("format")) format = form.get("format");
        }
      } else if (request.method === "GET") {
        targetUrl = String(url.searchParams.get("url") || "").trim();
        customSlug = String(url.searchParams.get("alias") || url.searchParams.get("customSlug") || url.searchParams.get("slug") || "").trim();
        if (url.searchParams.get("ttlSeconds") || url.searchParams.get("ttl")) {
          ttl = Number(url.searchParams.get("ttlSeconds") || url.searchParams.get("ttl"));
        }
      } else {
        return withCors(json({ ok: false, error: "method_not_allowed" }, 405));
      }

      // Check if format plain text requested via header
      const acceptHeader = request.headers.get("accept") || "";
      const wantPlainText = format === "text" || acceptHeader.includes("text/plain");

      // Validate URL
      if (!isValidHttpUrl(targetUrl)) {
        if (wantPlainText) {
          return withCors(new Response("Error: URL invalida. Debe iniciar con http:// o https://\n", { status: 400 }));
        }
        return withCors(json({ ok: false, error: "invalid_url", message: "La URL ingresada no es válida. Debe iniciar con http:// o https://" }, 400));
      }

      // Prevent loop (cannot shorten a link to the shortener itself)
      const parsedTarget = new URL(targetUrl);
      if (parsedTarget.hostname === url.hostname || parsedTarget.hostname === "short.290102.xyz") {
        return withCors(json({ ok: false, error: "loop_forbidden", message: "No puedes acortar un enlace que apunta a este mismo dominio." }, 400));
      }

      // Determine slug
      let slug = "";
      if (customSlug) {
        slug = sanitizeSlug(customSlug);
        if (!slug || slug.length < 2 || slug.length > 32) {
          return withCors(json({ ok: false, error: "invalid_slug", message: "El alias debe tener entre 2 y 32 caracteres alfanuméricos." }, 400));
        }
        if (RESERVED.has(slug.toLowerCase())) {
          return withCors(json({ ok: false, error: "slug_reserved", message: "Ese alias está reservado para el sistema." }, 400));
        }
      } else {
        slug = await generateUniqueSlug(env);
      }

      const now = Math.floor(Date.now() / 1000);
      const clampedTtl = Math.max(300, Math.min(31536000, ttl)); // between 5m and 1 year
      const expiresAt = now + clampedTtl;

      // Check if slug exists in D1
      const existing = await env.DB.prepare(
        "SELECT slug, expires_at FROM links WHERE slug = ?"
      ).bind(slug).first();

      if (existing) {
        if (existing.expires_at > now) {
          if (wantPlainText) {
            return withCors(new Response("Error: El alias personalizado ya está en uso.\n", { status: 409 }));
          }
          return withCors(json({ ok: false, error: "slug_taken", message: "El alias personalizado ya está en uso. Elige otro." }, 409));
        } else {
          // Overwrite expired
          await env.DB.prepare(
            "UPDATE links SET target_url = ?, created_at = ?, expires_at = ?, clicks = 0 WHERE slug = ?"
          ).bind(targetUrl, now, expiresAt, slug).run();
        }
      } else {
        await env.DB.prepare(
          "INSERT INTO links (slug, target_url, created_at, expires_at, clicks) VALUES (?, ?, ?, ?, 0)"
        ).bind(slug, targetUrl, now, expiresAt).run();
      }

      const shortUrl = `${url.origin}/${slug}`;
      if (wantPlainText) {
        return withCors(new Response(`${shortUrl}\n`, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        }));
      }

      return withCors(json({
        ok: true,
        shortUrl,
        slug,
        targetUrl,
        expiresAt,
        createdAt: now
      }));
    }

    // 2. GET /api/stats/:slug
    const statsMatch = url.pathname.match(/^\/api\/stats\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && statsMatch) {
      const slug = statsMatch[1];
      const row = await env.DB.prepare(
        "SELECT slug, target_url, created_at, expires_at, clicks FROM links WHERE slug = ?"
      ).bind(slug).first();

      if (!row) {
        return withCors(json({ ok: false, error: "not_found" }, 404));
      }

      return withCors(json({
        ok: true,
        link: row,
        isExpired: row.expires_at <= Math.floor(Date.now() / 1000)
      }));
    }

    return withCors(json({ ok: false, error: "not_found" }, 404));
  } catch (err) {
    console.error("API error:", err);
    return withCors(json({ ok: false, error: "internal_error", message: err.message }, 500));
  }
}

// --- UTILS ---
function isValidHttpUrl(string) {
  try {
    const u = new URL(string);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function sanitizeSlug(str) {
  return String(str || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

async function generateUniqueSlug(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let slug = "";
    const len = attempt < 3 ? 4 : 5;
    const randomBytes = crypto.getRandomValues(new Uint8Array(len));
    for (let i = 0; i < len; i++) {
      slug += BASE62[randomBytes[i] % BASE62.length];
    }

    const exists = await env.DB.prepare("SELECT slug, expires_at FROM links WHERE slug = ?").bind(slug).first();
    const now = Math.floor(Date.now() / 1000);
    if (!exists || exists.expires_at <= now) {
      return slug;
    }
  }
  // Fallback random timestamp-derived slug
  return Math.random().toString(36).substring(2, 7);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function notFoundHtml(slug, title, message) {
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - short.290102.xyz</title>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0b0f19; color: #f8fafc; min-height: 100vh; display: grid; place-items: center; margin: 0; padding: 20px; text-align: center; }
    .card { background: #161c2d; border: 1px solid #222b3e; padding: 40px 32px; border-radius: 20px; max-width: 440px; width: 100%; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .icon { width: 56px; height: 56px; border-radius: 16px; background: rgba(239,68,68,0.12); color: #f87171; display: grid; place-items: center; margin: 0 auto 20px; font-size: 24px; }
    h1 { font-size: 20px; margin: 0 0 10px; font-weight: 700; color: #fff; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.6; margin: 0 0 24px; }
    .code { font-family: monospace; background: #0b0f19; padding: 4px 8px; border-radius: 6px; color: #60a5fa; border: 1px solid #222b3e; }
    a { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 12px; font-weight: 600; font-size: 14px; transition: background 0.2s; }
    a:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${title}</h1>
    <p>${message} Identificador: <span class="code">${slug}</span></p>
    <a href="/">Crear un nuevo enlace corto</a>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
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
