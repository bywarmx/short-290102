# ShortLink - Acortador de URLs en Cloudflare Pages + D1

Acortador de enlaces moderno, ultrarrápido y serverless con almacenamiento en **Cloudflare D1 (SQLite)**, caché global en el **Edge (Cache API)** y fecha de expiración automática.

Desplegado en producción en: **[short.290102.xyz](https://short.290102.xyz)**  
Documentación de la API: **[short.290102.xyz/docs](https://short.290102.xyz/docs)**

---

## Características

- ⚡ **Redirecciones Instantáneas en el Edge:** Redirecciones HTTP 302 con almacenamiento en `caches.default` para no consumir lecturas de la base de datos en clics frecuentes.
- 🗄️ **Base de Datos Cloudflare D1 (SQLite):** Sin cuotas restrictivas como en KV (soporta 100k escrituras/día y 5M lecturas/día en plan gratuito).
- ⏳ **Expiración Automática:** Tiempo de vida por defecto de **15 días** (configurable desde 5 minutos hasta 1 año). Reutilización de alias expirados.
- 🔗 **Alias Personalizados:** Permite definir un slug propio o genera uno automático en Base62 (4-6 caracteres).
- 📊 **Contador de Clics Asíncrono:** Registra visitas en segundo plano con `ctx.waitUntil()` sin retrasar al usuario.
- 📱 **Generador de Código QR:** Genera y muestra códigos QR instantáneos en la interfaz web.
- 💻 **API REST Pública:** Endpoints para crear enlaces desde la terminal (`curl`), scripts de Bash, Python o aplicaciones externas.
- 🌓 **Modo Oscuro / Claro:** Interfaz responsiva diseñada con TailwindCSS.

---

## Estructura del Proyecto

```text
.
├── public/
│   ├── _worker.js       # Cloudflare Pages Worker (API REST, D1 y redirección)
│   ├── index.html       # Interfaz web principal del acortador
│   ├── app.js           # Lógica frontend (historial local, QR, temas)
│   ├── style.css        # Estilos visuales personalizados
│   ├── favicon.svg      # Icono del sitio
│   └── docs/
│       └── index.html   # Subpágina con la documentación completa de la API
├── wrangler.toml        # Configuración de Cloudflare Pages y binding D1
├── .gitignore
└── README.md
```

---

## Esquema SQL de la Base de Datos D1

```sql
CREATE TABLE IF NOT EXISTS links (
  slug TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  clicks INTEGER DEFAULT 0
);
```

---

## API REST

### 1. Acortar URL
- **Endpoint:** `POST https://short.290102.xyz/api/shorten`
- **Cabeceras:** `Content-Type: application/json`
- **Cuerpo:**
  ```json
  {
    "url": "https://mi-sitio.com/pagina-larga",
    "alias": "mi-alias",
    "ttl": 1296000
  }
  ```

### 2. Acortar desde la Terminal (Una sola línea en Texto Plano)
```bash
curl -s "https://short.290102.xyz/api/shorten?url=https://mi-sitio.com&format=text"
```

### 3. Consultar Estadísticas
```bash
curl -s "https://short.290102.xyz/api/stats/mi-alias"
```

---

## Despliegue con Wrangler

```bash
# 1. Crear la base de datos D1 (si no existe)
npx wrangler d1 create short-db

# 2. Ejecutar esquema inicial
npx wrangler d1 execute short-db --remote --command="CREATE TABLE IF NOT EXISTS links (slug TEXT PRIMARY KEY, target_url TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, clicks INTEGER DEFAULT 0);"

# 3. Desplegar en Cloudflare Pages
npx wrangler pages deploy public --project-name=short-290102
```
