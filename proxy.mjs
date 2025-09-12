// proxy.mjs
import express from "express";
import cors from "cors";
import http from "http";

const app = express();

// ==== CONFIG ====
const FRONT_ORIGIN = "https://alex-mentor.netlify.app/";         // tu front
const N8N_BASE = "https://n8n.icc-e.org";             // tu n8n
const PORT = 8787;                                    // puerto local proxy
const UPSTREAM_TIMEOUT_MS = 300_000;                  // 5 min
// ================

// CORS para TODO el proxy
app.use(cors({
  origin: FRONT_ORIGIN,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// Body parsers (acepta JSON y texto plano)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "*/*", limit: "2mb" }));

// Mantener sockets abiertos lo suficiente
app.use((req, res, next) => {
  req.setTimeout(UPSTREAM_TIMEOUT_MS + 10_000);
  res.setTimeout(UPSTREAM_TIMEOUT_MS + 10_000);
  next();
});

// Utilidad para reenviar la petición a n8n con fetch y abort a los 5 min
async function forward({ path, method, headers, body }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  // Limpia cabeceras que no deben reenviarse
  const { host, origin, referer, ...safeHeaders } = headers || {};

  const url = `${N8N_BASE}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      ...safeHeaders,
      // si el front envía text/plain, aquí lo normalizamos a JSON si procede
    },
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
    signal: controller.signal
  }).finally(() => clearTimeout(t));

  const text = await resp.text();
  return { status: resp.status, body: text, headers: resp.headers };
}

// Rutas genéricas para tus webhooks n8n
// Llama desde el front a: http://localhost:8787/webhook/mentor-chat  (POST)
//                         http://localhost:8787/webhook/mentor-task/ID (GET/POST)
//                         http://localhost:8787/webhook/task-status   (GET)
app.all("/webhook/*", async (req, res) => {
  try {
    const upstream = await forward({
      path: req.originalUrl,  // conserva /webhook/...
      method: req.method,
      headers: req.headers,
      body: typeof req.body === "string" ? req.body : JSON.stringify(req.body)
    });

    // Respuesta al navegador + CORS
    res.status(upstream.status);
    res.set("Access-Control-Allow-Origin", FRONT_ORIGIN);
    res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.set("Cache-Control", "no-store");
    res.send(upstream.body);
  } catch (err) {
    const msg = err?.name === "AbortError"
      ? "Proxy timeout (5 min) alcanzado"
      : `Proxy error: ${err?.message || err}`;
    res.set("Access-Control-Allow-Origin", FRONT_ORIGIN);
    res.status(504).send(JSON.stringify({ success: false, error: msg }));
  }
});

// Responder explícitamente a OPTIONS (preflight)
app.options("/webhook/*", (req, res) => {
  res.set("Access-Control-Allow-Origin", FRONT_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.set("Access-Control-Max-Age", "86400");
  res.status(204).end();
});

// Arranque
http.createServer(app).listen(PORT, () => {
  console.log(`Proxy CORS listo en http://localhost:${PORT}`);
  console.log(`Reenviando hacia ${N8N_BASE}`);
});
