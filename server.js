const express = require("express");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const multer = require("multer");
const mammoth = require("mammoth");
const cors = require("cors");
const crypto = require("crypto");
const os = require("os");
const { spawnSync, spawn } = require("child_process");
const PptxGenJS = require("pptxgenjs");
const AdmZip = require("adm-zip");
const iconv = require("iconv-lite");
const { Readable } = require("stream");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROBOT_LANDING = String(process.env.ROBOT_LANDING || "0") === "1";
const ROBOT_AP_ONLY = String(process.env.ROBOT_AP_ONLY || "0") === "1";
const ROBOT_AP_ROUTE =
  String(process.env.ROBOT_AP_ROUTE || "/robot-entry").trim() || "/robot-entry";
const ROBOT_AP_SUBNET_PREFIX =
  String(process.env.ROBOT_AP_SUBNET_PREFIX || "192.168.8.").trim() ||
  "192.168.8.";
const ROBOT_AP_WIFI_SSID = String(
  process.env.ROBOT_AP_WIFI_SSID || "chenlong-robot-725047",
).trim();
const ROBOT_AP_STRICT_WIFI =
  String(process.env.ROBOT_AP_STRICT_WIFI || "0") === "1";
const AUDIT_LOG_ENABLED =
  String(process.env.AUDIT_LOG_ENABLED || "true").toLowerCase() !== "false";
const AUDIT_LOG_DIR = process.env.AUDIT_LOG_DIR || path.join(__dirname, "logs");
const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, "audit.log");
const AUDIT_SALT = process.env.AUDIT_SALT || "daymori-audit-salt";
const LLM_FETCH_TIMEOUT_MS = Number(process.env.LLM_FETCH_TIMEOUT_MS || 20000);
const LLM_FETCH_RETRY = Number(process.env.LLM_FETCH_RETRY || 1);
const visionSummaryCache = new Map();
const TRAINING_DIR = path.join(__dirname, "docs", "benchmarks", "training");
const PROMPTS_DIR = path.join(__dirname, "docs", "benchmarks", "prompts");
const BAD_SAMPLES_PATH = path.join(TRAINING_DIR, "bad_samples.jsonl");
const GOLDEN_SAMPLES_PATH = path.join(TRAINING_DIR, "golden_samples.json");
const DEFAULT_TEMPLATE_PATH = path.join(
  __dirname,
  "docs",
  "benchmarks",
  "templates",
  "inbox",
  "模板.pptx",
);

async function fetchWithRetry(url, options, retries = 0) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (i === retries) throw error;
    }
  }
  throw lastError;
}

function parseAllowedOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

function corsOriginHandler(origin, callback) {
  if (!origin) return callback(null, true);
  if (ALLOWED_ORIGINS.length === 0) return callback(null, true);
  if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
  return callback(new Error("CORS blocked: origin not allowed"));
}

function hashValue(value) {
  return crypto
    .createHash("sha256")
    .update(`${AUDIT_SALT}:${String(value || "")}`)
    .digest("hex")
    .slice(0, 16);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function normalizeIpv4(ip) {
  const raw = String(ip || "").trim();
  if (!raw) return "";
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  if (raw === "::1") return "127.0.0.1";
  return raw;
}

function isHotspotClient(req) {
  const ip = normalizeIpv4(getClientIp(req));
  return ip.startsWith(ROBOT_AP_SUBNET_PREFIX);
}

function isLoopbackClient(req) {
  const ip = normalizeIpv4(getClientIp(req));
  return ip === "127.0.0.1";
}

function getLocalWlanIpv4() {
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!/WLAN|Wi-Fi|无线/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a && a.family === "IPv4" && !a.internal && a.address) {
        return a.address;
      }
    }
  }
  return "";
}

function isLocalWlanInHotspotSubnet() {
  const ip = getLocalWlanIpv4();
  return Boolean(ip && ip.startsWith(ROBOT_AP_SUBNET_PREFIX));
}

function buildLikelyRobotTargetsFromWlan() {
  const local = getLocalWlanIpv4();
  if (!local) return [];
  const parts = local.split(".");
  if (parts.length !== 4) return [];
  parts[3] = "1";
  const gateway = parts.join(".");
  return [`http://${gateway}`, `http://${gateway}:8080`];
}

function robotApOnlyGuard(req, res, next) {
  if (!ROBOT_AP_ONLY) return next();

  if (ROBOT_AP_STRICT_WIFI && ROBOT_AP_WIFI_SSID) {
    const wifi = getCurrentWifiSsid();
    if (wifi && wifi !== ROBOT_AP_WIFI_SSID) {
      return res.status(403).json({
        ok: false,
        error: "hotspot-only access denied",
        detail: `Current Wi-Fi SSID ${wifi} does not match required ${ROBOT_AP_WIFI_SSID}`,
      });
    }
    if (!wifi) {
      return res.status(403).json({
        ok: false,
        error: "hotspot-only access denied",
        detail: "Cannot detect current Wi-Fi SSID",
      });
    }

    // When current Wi-Fi is the required robot hotspot, allow fixed localhost URL.
    if (isLoopbackClient(req)) return next();
  }

  if (isLoopbackClient(req)) {
    if (isLocalWlanInHotspotSubnet()) return next();
    return res.status(403).json({
      ok: false,
      error: "hotspot-only access denied",
      detail: `Local WLAN is not in hotspot subnet ${ROBOT_AP_SUBNET_PREFIX}*`,
    });
  }

  if (isHotspotClient(req)) return next();

  const ip = normalizeIpv4(getClientIp(req));
  return res.status(403).json({
    ok: false,
    error: "hotspot-only access denied",
    detail: `Current client ip ${ip || "unknown"} is not in hotspot subnet ${ROBOT_AP_SUBNET_PREFIX}*`,
  });
}

function getCurrentWifiSsid() {
  try {
    const out = spawnSync("netsh", ["wlan", "show", "interfaces"], {
      encoding: "utf8",
      timeout: 1500,
    });

    const text = String(out.stdout || "");
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const clean = line.trim();
      if (!clean) continue;
      if (/^BSSID\s*:/i.test(clean)) continue;
      const m = clean.match(/^SSID(?:\s+\d+)?\s*:\s*(.+)$/i);
      if (m && m[1]) {
        const ssid = m[1].trim();
        if (!ssid || /^not\s+connected$/i.test(ssid)) continue;
        return ssid;
      }
    }
    const ps = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-Fi|无线' } | Select-Object -First 1 -ExpandProperty Name)",
      ],
      { encoding: "utf8", timeout: 2000 },
    );
    const ssid = String(ps.stdout || "").trim();
    return ssid;
  } catch {
    return "";
  }
}

function sanitizeAuditDetail(detail) {
  if (!detail) return "";
  const text = String(detail);
  if (text.length <= 220) return text;
  return `${text.slice(0, 220)}...[truncated]`;
}

function writeAuditLog(event) {
  if (!AUDIT_LOG_ENABLED) return;
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
  try {
    fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_LOG_FILE, line, "utf8");
  } catch (error) {
    console.error("audit_log_write_failed", error.message);
  }
}

function baseAuditEvent(req) {
  return {
    requestId: req.requestId,
    route: req.path,
    method: req.method,
    ipHash: hashValue(getClientIp(req)),
    uaHash: hashValue(req.headers["user-agent"] || ""),
    originHash: hashValue(req.headers.origin || ""),
    provider: (process.env.LLM_PROVIDER || "deepseek").toLowerCase().trim(),
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 2 },
});

const uploadAsr = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 26 * 1024 * 1024, files: 1 },
});

app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: corsOriginHandler }));
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader("x-request-id", req.requestId);
  next();
});
app.use("/games", express.static(path.join(__dirname, "games")));
app.use("/docs", express.static(path.join(__dirname, "docs")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  if (ROBOT_LANDING) {
    return res.sendFile(path.join(__dirname, "public", "robot-drive.html"));
  }
  res.sendFile(path.join(__dirname, "docs", "index.html"));
});

app.get("/fighter", (req, res) => {
  res.sendFile(path.join(__dirname, "games", "fighter", "index.html"));
});

app.get("/robot-drive", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "robot-drive.html"));
});

app.get("/robot-drive-latest", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "robot-drive.html"));
});

app.get("/car-control.html", (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "car-control.html"));
});

app.get(ROBOT_AP_ROUTE, robotApOnlyGuard, (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "robot-drive.html"));
});

app.get("/robot-entry", robotApOnlyGuard, (req, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "robot-drive.html"));
});

app.get("/api/robot/ap-status", (req, res) => {
  const ip = normalizeIpv4(getClientIp(req));
  const hotspotAllowed = isHotspotClient(req);
  const currentWifiSsid = getCurrentWifiSsid();
  const localWlanIp = getLocalWlanIpv4();
  const suggestedTarget =
    buildLikelyRobotTargetsFromWlan()[0] || "http://192.168.4.1";
  return res.json({
    ok: true,
    apOnlyMode: ROBOT_AP_ONLY,
    route: ROBOT_AP_ROUTE,
    subnetPrefix: ROBOT_AP_SUBNET_PREFIX,
    strictWifi: ROBOT_AP_STRICT_WIFI,
    requiredWifiSsid: ROBOT_AP_WIFI_SSID,
    currentWifiSsid,
    localWlanIp,
    suggestedTarget,
    localWlanInSubnet: Boolean(
      localWlanIp && localWlanIp.startsWith(ROBOT_AP_SUBNET_PREFIX),
    ),
    clientIp: ip,
    hotspotAllowed,
  });
});

function buildRobotTargetCandidates(inputTarget) {
  const raw = String(inputTarget || "http://192.168.4.1").trim();
  const hasScheme = /^https?:\/\//i.test(raw);
  const normalized = hasScheme ? raw : `http://${raw}`;

  const dynamic = buildLikelyRobotTargetsFromWlan();
  const candidates = [
    normalized,
    ...dynamic,
    "http://192.168.4.1",
    "http://192.168.4.1:8080",
  ];
  try {
    const u = new URL(normalized);
    if (u.port === "8080") {
      candidates.unshift(`${u.protocol}//${u.hostname}`);
    } else if (!u.port) {
      candidates.unshift(`${u.protocol}//${u.hostname}:8080`);
    }
  } catch {
    // Ignore malformed URL here; spawn result will surface the error.
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function normalizeRobotBaseTarget(inputTarget) {
  const raw = String(inputTarget || "192.168.4.1").trim();
  if (!raw) return "http://192.168.4.1";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
}

function tryRobotWebControlFallback(action, target, seconds) {
  const actionMap = {
    up: "forward-hold",
    down: "backward-hold",
    left: "left-hold",
    right: "right-hold",
    stop: "stop",
    grab: "grab",
    release: "release",
  };
  const mappedAction = actionMap[action];
  if (!mappedAction) {
    return { ok: false, error: `unsupported fallback action: ${action}` };
  }

  const holdMs = Math.max(
    120,
    Math.min(3000, Math.round((Number(seconds) || 0.45) * 1000)),
  );
  const scriptPath = path.join(__dirname, "tools", "robot-web-control.mjs");
  const targets = buildRobotTargetCandidates(target);
  let lastError = "fallback failed";

  for (const candidate of targets) {
    const result = spawnSync(
      process.execPath,
      [scriptPath, mappedAction, candidate, String(holdMs), "true"],
      {
        cwd: __dirname,
        encoding: "utf8",
        timeout: 9000,
      },
    );

    if (result.error) {
      lastError = result.error.message;
      continue;
    }

    if (result.status === 0) {
      return {
        ok: true,
        target: candidate,
        output: String(result.stdout || "").trim(),
      };
    }

    lastError = String(
      result.stderr || result.stdout || "fallback failed",
    ).trim();
  }

  return { ok: false, error: lastError };
}

app.get("/api/robot/control", async (req, res) => {
  const action = String(req.query.action || "stop")
    .trim()
    .toLowerCase();
  const target = normalizeRobotBaseTarget(
    req.query.target || req.query.ip || "192.168.4.1",
  );
  const speedRaw = Number(req.query.speed);
  const timeRaw = Number(req.query.time);
  const speed = Number.isFinite(speedRaw)
    ? Math.max(0, Math.min(100, Math.round(speedRaw)))
    : 0;
  const seconds = Number.isFinite(timeRaw)
    ? Math.max(0, Math.min(8, timeRaw))
    : 0;

  const allowed = new Set([
    "up",
    "down",
    "left",
    "right",
    "stop",
    "grab",
    "release",
  ]);
  if (!allowed.has(action)) {
    return res
      .status(400)
      .json({ ok: false, error: `invalid action: ${action}` });
  }

  const isMovementAction =
    action === "up" ||
    action === "down" ||
    action === "left" ||
    action === "right";
  const isRealtimeAction = isMovementAction || action === "stop";

  const primaryProfile = {
    up: {
      path: "/control",
      robotAction: "forward",
      robotSpeed: Math.max(speed, 180),
    },
    down: {
      path: "/control",
      robotAction: "backward",
      robotSpeed: Math.max(speed, 180),
    },
    left: {
      path: "/control",
      robotAction: "left",
      robotSpeed: Math.max(speed, 170),
    },
    right: {
      path: "/control",
      robotAction: "right",
      robotSpeed: Math.max(speed, 170),
    },
    stop: { path: "/api/control", robotAction: "stop", robotSpeed: 0 },
    grab: {
      path: "/api/control",
      robotAction: "grab",
      robotSpeed: Math.max(speed, 70),
    },
    release: {
      path: "/api/control",
      robotAction: "release",
      robotSpeed: Math.max(speed, 70),
    },
  }[action];

  const backupProfile = {
    up: {
      path: "/api/control",
      robotAction: "up",
      robotSpeed: Math.max(speed, 92),
    },
    down: {
      path: "/api/control",
      robotAction: "down",
      robotSpeed: Math.max(speed, 92),
    },
    left: {
      path: "/api/control",
      robotAction: "left",
      robotSpeed: Math.max(speed, 88),
    },
    right: {
      path: "/api/control",
      robotAction: "right",
      robotSpeed: Math.max(speed, 88),
    },
    stop: { path: "/control", robotAction: "stop", robotSpeed: 0 },
    grab: {
      path: "/control",
      robotAction: "grab",
      robotSpeed: Math.max(speed, 70),
    },
    release: {
      path: "/control",
      robotAction: "release",
      robotSpeed: Math.max(speed, 70),
    },
  }[action];

  const triedHttp = [];
  const quickRequest = async (profile, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const endpoint = new URL(profile.path, target);
      endpoint.searchParams.set("action", profile.robotAction);
      endpoint.searchParams.set("speed", String(profile.robotSpeed));
      if (seconds > 0) {
        endpoint.searchParams.set("time", String(seconds));
      }

      const response = await fetch(endpoint.toString(), {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      triedHttp.push(
        `${profile.path}?action=${profile.robotAction}&speed=${profile.robotSpeed}:status=${response.status}`,
      );
      return response.ok;
    } catch (error) {
      clearTimeout(timer);
      triedHttp.push(
        `${profile.path}?action=${profile.robotAction}&speed=${profile.robotSpeed}:error=${error && error.message ? error.message : "unknown"}`,
      );
      return false;
    }
  };

  const dispatchAsync = (profile) => {
    const endpoint = new URL(profile.path, target);
    endpoint.searchParams.set("action", profile.robotAction);
    endpoint.searchParams.set("speed", String(profile.robotSpeed));
    if (seconds > 0) {
      endpoint.searchParams.set("time", String(seconds));
    }

    fetch(endpoint.toString(), {
      method: "GET",
      cache: "no-store",
    }).catch(() => {});
    return endpoint.toString();
  };

  if (isRealtimeAction) {
    const dispatched = [
      dispatchAsync(primaryProfile),
      dispatchAsync(backupProfile),
    ];
    return res.json({
      ok: true,
      target,
      action,
      proxied: true,
      controlMode: isMovementAction
        ? "movement-async-dispatch"
        : "stop-async-dispatch",
      dispatched,
    });
  }

  const primaryOk = await quickRequest(primaryProfile, 1800);
  if (primaryOk) {
    return res.json({
      ok: true,
      target,
      action,
      proxied: true,
      controlMode: "http-fast-primary",
      httpPath: primaryProfile.path,
      httpAction: primaryProfile.robotAction,
      httpSpeed: primaryProfile.robotSpeed,
    });
  }

  const backupOk = await quickRequest(backupProfile, 1800);
  if (backupOk) {
    return res.json({
      ok: true,
      target,
      action,
      proxied: true,
      controlMode: "http-fast-backup",
      httpPath: backupProfile.path,
      httpAction: backupProfile.robotAction,
      httpSpeed: backupProfile.robotSpeed,
      triedHttp,
    });
  }

  if (isMovementAction || action === "stop") {
    return res.status(502).json({
      ok: false,
      error: "http fast control failed",
      target,
      action,
      proxied: true,
      controlMode: "http-fast-failed",
      triedHttp,
    });
  }

  const fallback = tryRobotWebControlFallback(action, target, seconds || 0.45);
  if (fallback.ok) {
    return res.json({
      ok: true,
      target: fallback.target,
      action,
      proxied: true,
      controlMode: "web-fallback-only",
      fallback: "robot-web-control",
      triedHttp,
    });
  }

  return res.status(502).json({
    ok: false,
    error: "robot control failed",
    target,
    action,
    proxied: true,
    triedHttp,
    fallbackError: fallback.error,
  });
});

app.post("/api/robot/camera/open", async (req, res) => {
  const target = normalizeRobotBaseTarget(
    (req.body && req.body.target) ||
      req.query.target ||
      req.query.ip ||
      "192.168.4.1",
  );

  const openUrl = new URL("/api/camera/open", target).toString();
  const statusUrl = new URL("/api/camera/status", target).toString();

  let openOk = false;
  let statusPayload = null;

  try {
    const openResp = await fetch(openUrl, { method: "POST" });
    openOk = openResp.ok;
  } catch {
    openOk = false;
  }

  try {
    const statusResp = await fetch(statusUrl, { method: "GET" });
    const data = await statusResp.json().catch(() => ({}));
    statusPayload = data;
  } catch {
    statusPayload = null;
  }

  return res.json({
    ok: true,
    target,
    openTried: true,
    openOk,
    cameraOn: !!(statusPayload && statusPayload.camera_on),
    status: statusPayload || {},
  });
});

app.get("/api/robot/vision-proxy", async (req, res) => {
  const target = normalizeRobotBaseTarget(
    req.query.target || req.query.ip || "192.168.4.1",
  );
  const preferredPathRaw = String(req.query.path || "").trim();
  const preferredPath = preferredPathRaw.startsWith("/")
    ? preferredPathRaw
    : "";

  const baseTargets = buildRobotTargetCandidates(target);
  const defaultPaths = [
    "/api/camera/stream?fps=30",
    "/stream",
    "/video",
    "/?action=stream",
    "/?action=video",
    "/",
  ];
  const scanPaths = preferredPath
    ? [preferredPath, ...defaultPaths]
    : defaultPaths;
  const tried = [];

  for (const base of baseTargets) {
    for (const p of scanPaths) {
      let endpoint;
      try {
        endpoint = new URL(p, base).toString();
      } catch {
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const upstream = await fetch(endpoint, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!upstream.ok || !upstream.body) {
          tried.push(`${endpoint}:status=${upstream.status}`);
          continue;
        }

        const contentType =
          upstream.headers.get("content-type") || "application/octet-stream";
        tried.push(`${endpoint}:status=${upstream.status}:ok`);

        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("x-robot-vision-upstream", endpoint);
        res.setHeader("Content-Type", contentType);

        const bodyStream = Readable.fromWeb(upstream.body);
        bodyStream.on("error", () => {
          if (!res.headersSent) {
            res.status(502).end("vision stream proxy error");
          } else {
            res.end();
          }
        });
        bodyStream.pipe(res);
        return;
      } catch (error) {
        clearTimeout(timer);
        tried.push(
          `${endpoint}:error=${error && error.message ? error.message : "unknown"}`,
        );
      }
    }
  }

  return res.status(502).json({
    ok: false,
    error: "robot vision unavailable",
    target,
    tried,
  });
});

async function readFirstJpegFrameFromResponse(
  upstream,
  maxBytes = 3 * 1024 * 1024,
) {
  const contentType = String(
    upstream.headers.get("content-type") || "",
  ).toLowerCase();

  if (
    contentType.includes("image/jpeg") ||
    contentType.includes("image/jpg") ||
    contentType.includes("image/png")
  ) {
    const ab = await upstream.arrayBuffer();
    const bin = Buffer.from(ab);
    if (!bin.length) return null;
    return bin.slice(0, Math.min(bin.length, maxBytes));
  }

  if (!upstream.body || typeof upstream.body.getReader !== "function") {
    return null;
  }

  const startMark = Buffer.from([0xff, 0xd8]);
  const endMark = Buffer.from([0xff, 0xd9]);
  const reader = upstream.body.getReader();
  let merged = Buffer.alloc(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;

      merged = Buffer.concat([merged, Buffer.from(value)]);
      if (merged.length > maxBytes) {
        merged = merged.slice(merged.length - maxBytes);
      }

      const start = merged.indexOf(startMark);
      if (start < 0) continue;
      const end = merged.indexOf(endMark, start + 2);
      if (end < 0) continue;
      return merged.slice(start, end + 2);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  return null;
}

async function fetchRobotCameraFrameBuffer(target, preferredPath) {
  const baseTargets = buildRobotTargetCandidates(target);
  const pathCandidates = [];
  const p = String(preferredPath || "").trim();
  if (p && p.startsWith("/")) pathCandidates.push(p);
  pathCandidates.push(
    "/api/camera/stream",
    "/api/camera/stream?fps=30",
    "/api/camera/stream?fps=24",
  );

  const uniquePaths = Array.from(new Set(pathCandidates));
  const tried = [];

  for (const base of baseTargets) {
    for (const pathItem of uniquePaths) {
      let endpoint;
      try {
        endpoint = new URL(pathItem, base).toString();
      } catch {
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5500);
      try {
        const upstream = await fetch(endpoint, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!upstream.ok) {
          tried.push(`${endpoint}:status=${upstream.status}`);
          continue;
        }

        const frame = await readFirstJpegFrameFromResponse(upstream);
        if (frame && frame.length > 0) {
          return {
            ok: true,
            frame,
            endpoint,
            contentType: String(upstream.headers.get("content-type") || ""),
          };
        }
        tried.push(`${endpoint}:no_frame`);
      } catch (error) {
        clearTimeout(timer);
        tried.push(
          `${endpoint}:error=${error && error.message ? error.message : "unknown"}`,
        );
      }
    }
  }

  return { ok: false, tried };
}

function normalizeVisionSummary(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const structuredStart = text.search(/(?:场景|物体|方位|距离|风险)\s*[:：]/);
  const candidate = structuredStart >= 0 ? text.slice(structuredStart) : text;

  let out = candidate
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/<answer>/gi, "")
    .replace(/<\/answer>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^[\s\r\n]*(分析|思考|推理)[:：][\s\S]*$/gim, "")
    .trim();

  const answerMatch = text.match(/<answer>([\s\S]*?)<\/answer>/i);
  if (answerMatch && answerMatch[1]) {
    out = String(answerMatch[1]).trim();
  }

  const getLine = (label) => {
    const m = out.match(new RegExp(`${label}\\s*[:：]\\s*([^\\n]+)`, "i"));
    return m && m[1] ? String(m[1]).trim() : "";
  };

  const scene = getLine("场景");
  const object = getLine("物体");
  const risk = getLine("风险");
  const position = getLine("方位");
  const distance = getLine("距离");

  if (!(scene || object || risk || position || distance)) {
    const firstBrace = out.indexOf("{");
    const lastBrace = out.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(out.slice(firstBrace, lastBrace + 1));
        const scene2 = String(parsed.scene || parsed.场景 || "").trim();
        const object2 = String(
          parsed.object || parsed.objects || parsed.物体 || "",
        ).trim();
        const position2 = String(
          parsed.position || parsed.location || parsed.方位 || "",
        ).trim();
        const distance2 = String(
          parsed.distance || parsed.range || parsed.距离 || "",
        ).trim();
        const risk2 = String(
          parsed.risk || parsed.hazard || parsed.风险 || "",
        ).trim();
        if (scene2 || object2 || position2 || distance2 || risk2) {
          out = [
            `场景: ${scene2 || "未识别"}`,
            `物体: ${object2 || "未识别"}`,
            `方位: ${position2 || "未识别"}`,
            `距离: ${distance2 || "未识别"}`,
            `风险: ${risk2 || "未识别"}`,
          ].join("\n");
          return out.slice(0, 900);
        }
      } catch {
        // ignore and continue fallback
      }
    }
  }

  if (scene || object || risk || position || distance) {
    out = [
      `场景: ${scene || "未识别"}`,
      `物体: ${object || "未识别"}`,
      `方位: ${position || "未识别"}`,
      `距离: ${distance || "未识别"}`,
      `风险: ${risk || "未识别"}`,
    ].join("\n");
  }

  if (!out.trim()) {
    const cleaned = text
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .filter((line) => !/^<think>/i.test(line))
      .slice(0, 5);
    if (cleaned.length) out = cleaned.join("\n");
  }

  return out.slice(0, 900);
}

app.post("/api/vision/analyze", async (req, res) => {
  const startedAt = Date.now();
  const target = normalizeRobotBaseTarget(
    req.body && req.body.target
      ? req.body.target
      : req.query.target || "192.168.4.1",
  );
  const streamPathRaw = String(
    req.body && req.body.streamPath
      ? req.body.streamPath
      : req.query.streamPath || "/api/camera/stream",
  ).trim();
  const streamPath = streamPathRaw.startsWith("/")
    ? streamPathRaw
    : "/api/camera/stream";
  const cacheKey = `${target}|${streamPath}`;
  const cached = visionSummaryCache.get(cacheKey);
  const visionModel =
    sanitizeContractText(
      String(
        (req.body && req.body.model) ||
          process.env.ZHIPU_VISION_MODEL ||
          "glm-4.1v-thinking-flash",
      ),
      64,
    ) || "glm-4.1v-thinking-flash";

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "missing_ZHIPU_API_KEY",
      detail: "服务端未配置 ZHIPU_API_KEY，无法进行视觉识别",
    });
  }

  const frameResult = await fetchRobotCameraFrameBuffer(target, streamPath);
  if (!frameResult.ok) {
    if (cached && cached.summary) {
      return res.json({
        ok: true,
        provider: "zhipu",
        model: visionModel,
        target,
        streamPath,
        upstream: cached.upstream || "cache",
        frameBytes: 0,
        latencyMs: Date.now() - startedAt,
        summary: cached.summary,
        fallback: true,
        fallbackReason: "camera_frame_unavailable",
        cachedAt: cached.ts,
      });
    }
    return res.status(502).json({
      ok: false,
      error: "camera_frame_unavailable",
      detail: "未能从前置摄像头获取有效帧",
      target,
      streamPath,
      tried: frameResult.tried || [],
    });
  }

  const imageB64 = frameResult.frame.toString("base64");
  const dataUrl = `data:image/jpeg;base64,${imageB64}`;

  const buildVisionRequestBody = () => ({
    model: visionModel,
    messages: [
      {
        role: "system",
        content:
          "你是机器人视觉识别助手。请只基于图像回答，用中文简洁输出。输出格式固定为五行：场景:...\\n物体:...（列出最多3个核心物体，逗号分隔，每个物体尽量附带置信度如苹果(置信78%)）\\n方位:...（左/中/右，可写偏左/偏右）\\n距离:...（近/中/远）\\n风险:...",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "仔细识别这张机器人前置摄像头画面中的主要物体和潜在风险。请保证通用识别，不只针对球类，并在物体行输出可用于匹配的标准物体名称与置信度。",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 420,
  });

  let upstream;
  try {
    upstream = await fetchWithRetry(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildVisionRequestBody()),
      },
      LLM_FETCH_RETRY,
    );
  } catch (error) {
    if (cached && cached.summary) {
      return res.json({
        ok: true,
        provider: "zhipu",
        model: visionModel,
        target,
        streamPath,
        upstream: cached.upstream || "cache",
        frameBytes: Number(frameResult.frame.length || 0),
        latencyMs: Date.now() - startedAt,
        summary: cached.summary,
        fallback: true,
        fallbackReason: "vision_upstream_connect_error",
        cachedAt: cached.ts,
      });
    }
    return res.status(502).json({
      ok: false,
      error: "vision_upstream_connect_error",
      detail: describeUpstreamError(error),
    });
  }

  if (!upstream.ok && (upstream.status === 429 || upstream.status >= 500)) {
    // Retry once for transient upstream throttling/instability.
    await new Promise((r) => setTimeout(r, 320));
    try {
      const retryResp = await fetchWithRetry(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(buildVisionRequestBody()),
        },
        0,
      );
      upstream = retryResp;
    } catch {
      // Keep original upstream response for error detail below.
    }
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    if (cached && cached.summary) {
      return res.json({
        ok: true,
        provider: "zhipu",
        model: visionModel,
        target,
        streamPath,
        upstream: cached.upstream || "cache",
        frameBytes: Number(frameResult.frame.length || 0),
        latencyMs: Date.now() - startedAt,
        summary: cached.summary,
        fallback: true,
        fallbackReason: "vision_upstream_http_error",
        cachedAt: cached.ts,
      });
    }
    return res.status(upstream.status).json({
      ok: false,
      error: "vision_upstream_http_error",
      detail: rawText.slice(0, 1000),
    });
  }

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    if (cached && cached.summary) {
      return res.json({
        ok: true,
        provider: "zhipu",
        model: visionModel,
        target,
        streamPath,
        upstream: cached.upstream || "cache",
        frameBytes: Number(frameResult.frame.length || 0),
        latencyMs: Date.now() - startedAt,
        summary: cached.summary,
        fallback: true,
        fallbackReason: "vision_upstream_non_json",
        cachedAt: cached.ts,
      });
    }
    return res.status(502).json({
      ok: false,
      error: "vision_upstream_non_json",
      detail: rawText.slice(0, 400),
    });
  }

  const summary = normalizeVisionSummary(extractChatText(data));
  if (summary) {
    visionSummaryCache.set(cacheKey, {
      summary,
      upstream: frameResult.endpoint,
      ts: new Date().toISOString(),
    });
  }
  return res.json({
    ok: true,
    provider: "zhipu",
    model: visionModel,
    target,
    streamPath,
    upstream: frameResult.endpoint,
    frameBytes: Number(frameResult.frame.length || 0),
    latencyMs: Date.now() - startedAt,
    summary,
  });
});

app.post("/api/robot/drive", (req, res) => {
  const actionRaw = String(req.body && req.body.action ? req.body.action : "")
    .toLowerCase()
    .trim();
  const target = String(
    req.body && req.body.target ? req.body.target : "http://192.168.4.1",
  ).trim();
  const durationRaw = Number(
    req.body && req.body.durationMs ? req.body.durationMs : 450,
  );
  const durationMs = Math.max(
    120,
    Math.min(
      3000,
      Number.isFinite(durationRaw) ? Math.round(durationRaw) : 450,
    ),
  );

  const actionMap = {
    forward: "forward-hold",
    backward: "backward-hold",
    left: "left-hold",
    right: "right-hold",
  };

  const action = actionMap[actionRaw];
  if (!action) {
    return res.status(400).json({
      ok: false,
      error: "Invalid action. Use forward/backward/left/right.",
    });
  }

  const scriptPath = path.join(__dirname, "tools", "robot-web-control.mjs");
  const targetCandidates = buildRobotTargetCandidates(target);

  let lastFailure = "robot control failed";
  for (const targetCandidate of targetCandidates) {
    const result = spawnSync(
      process.execPath,
      [scriptPath, action, targetCandidate, String(durationMs), "true"],
      {
        cwd: __dirname,
        encoding: "utf8",
        timeout: 9000,
      },
    );

    if (result.error) {
      lastFailure = result.error.message;
      continue;
    }

    if (result.status === 0) {
      return res.json({
        ok: true,
        action: actionRaw,
        durationMs,
        target: targetCandidate,
        output: (result.stdout || "").trim(),
      });
    }

    lastFailure = (
      result.stderr ||
      result.stdout ||
      "robot control failed"
    ).trim();
  }

  return res.status(500).json({ ok: false, error: lastFailure });
});

app.post("/api/robot/ping", (req, res) => {
  const target = String(
    req.body && req.body.target ? req.body.target : "http://192.168.4.1",
  ).trim();
  const scriptPath = path.join(__dirname, "tools", "robot-web-control.mjs");
  const targets = buildRobotTargetCandidates(target);

  let lastFailure = "ping failed";
  for (const t of targets) {
    const result = spawnSync(
      process.execPath,
      [scriptPath, "stop", t, "120", "true"],
      {
        cwd: __dirname,
        encoding: "utf8",
        timeout: 8000,
      },
    );

    if (result.error) {
      lastFailure = result.error.message;
      continue;
    }
    if (result.status === 0) {
      return res.json({
        ok: true,
        target: t,
        output: (result.stdout || "").trim(),
      });
    }
    lastFailure = (result.stderr || result.stdout || "ping failed").trim();
  }

  return res.status(500).json({ ok: false, error: lastFailure });
});

async function parseUploadedFile(file) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ext === ".docx") {
    try {
      const doc = await mammoth.extractRawText({ buffer: file.buffer });
      return doc.value || "";
    } catch (error) {
      return `[文件 ${file.originalname}] docx 解析失败（${error.message}），请尝试另存为新的 docx 后重传。`;
    }
  }

  const textExts = new Set([
    ".txt",
    ".md",
    ".json",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".html",
    ".css",
    ".csv",
    ".yml",
    ".yaml",
    ".xml",
  ]);
  if (
    textExts.has(ext) ||
    (file.mimetype && file.mimetype.startsWith("text/"))
  ) {
    return file.buffer.toString("utf8");
  }

  return `[文件 ${file.originalname}] 该格式暂不支持自动解析文本，请在输入框补充关键内容。`;
}

function getProviderConfig() {
  const provider = (process.env.LLM_PROVIDER || "deepseek")
    .toLowerCase()
    .trim();
  const modelOverride = (process.env.LLM_MODEL || "").trim();
  const zhipuModel = (process.env.ZHIPU_MODEL || "").trim();

  if (provider === "deepseek") {
    return {
      provider,
      type: "chat-completions",
      keyEnv: "DEEPSEEK_API_KEY",
      apiKey: process.env.DEEPSEEK_API_KEY,
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      model: modelOverride || "deepseek-chat",
    };
  }

  if (provider === "qwen") {
    return {
      provider,
      type: "chat-completions",
      keyEnv: "QWEN_API_KEY",
      apiKey: process.env.QWEN_API_KEY,
      endpoint:
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      model: modelOverride || "qwen-plus",
    };
  }

  if (provider === "zhipu") {
    return {
      provider,
      type: "chat-completions",
      keyEnv: "ZHIPU_API_KEY",
      apiKey: process.env.ZHIPU_API_KEY,
      endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      model: zhipuModel || "glm-5.2",
    };
  }

  if (provider === "openai") {
    return {
      provider,
      type: "responses",
      keyEnv: "OPENAI_API_KEY",
      apiKey: process.env.OPENAI_API_KEY,
      endpoint: "https://api.openai.com/v1/responses",
      model: modelOverride || "gpt-5.3-codex",
    };
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

// GLM-4.5/4.6/Z 系列是思考型模型：默认会把 token 预算烧在 reasoning_content 上，
// 导致正式 content 返回空/半截，应用只能退回本地骨架内容。关闭 thinking 后可直接
// 拿到高质量正文。对不支持该参数的模型返回空对象，避免 400。
function buildThinkingExtras(model) {
  if (/^glm-(4\.5|4\.6|z)/i.test(String(model || ""))) {
    return { thinking: { type: "disabled" } };
  }
  return {};
}

function extractChatText(data) {
  const choice =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message
      : null;
  const message = choice ? choice.content : "";
  if (typeof message === "string") {
    const t = message.trim();
    // 思考模型即便关闭 thinking 仍可能偶发把正文放进 reasoning_content，做一次兜底回退。
    if (t) return message;
    if (choice && typeof choice.reasoning_content === "string")
      return choice.reasoning_content;
    return message;
  }
  if (Array.isArray(message)) {
    const joined = message
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (
          part &&
          part.type === "output_text" &&
          typeof part.content === "string"
        )
          return part.content;
        return "";
      })
      .join("")
      .trim();
    if (joined) return joined;
    if (choice && typeof choice.reasoning_content === "string") {
      return String(choice.reasoning_content || "").trim();
    }
    return "";
  }
  if (choice && typeof choice.reasoning_content === "string") {
    return String(choice.reasoning_content || "").trim();
  }
  return "";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u0000/g, "")
    .trim();
}

const MOJIBAKE_PATTERN = /(?:锛|鏄|瀵|琛|缁|鍔|鎴|璇|鎬|琚|闂|銆|鈥|锝|锟�|�)/g;

function countMojibakeTokens(text) {
  const m = String(text || "").match(MOJIBAKE_PATTERN);
  return m ? m.length : 0;
}

function countZhChars(text) {
  const m = String(text || "").match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

function scoreReadableText(text) {
  const value = String(text || "");
  const zh = countZhChars(value);
  const bad = countMojibakeTokens(value);
  const replacement = (value.match(/�/g) || []).length;
  return zh - bad * 2 - replacement * 3;
}

function tryRepairMojibakeText(input) {
  const original = String(input || "");
  if (!original) return "";
  if (countMojibakeTokens(original) < 2) return original;
  try {
    const repaired = iconv.decode(iconv.encode(original, "gbk"), "utf8");
    if (!repaired || repaired === original) return original;
    return scoreReadableText(repaired) > scoreReadableText(original) + 1
      ? repaired
      : original;
  } catch {
    return original;
  }
}

function sanitizeContractText(value, maxLen = 0) {
  let text = normalizeText(value);
  if (!text) return "";
  text = text
    .replace(/<\/?[a-z]+:[^>]*>/gi, " ")
    .replace(/\/[a-z]+:[a-z]+>/gi, " ")
    .replace(/<[^>]{1,220}>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  text = tryRepairMojibakeText(text);
  if (maxLen > 0 && text.length > maxLen) {
    return `${text.slice(0, maxLen)}…`;
  }
  return text;
}

const SLIDE_TYPE_ENUM = [
  "cover",
  "agenda",
  "section",
  "content",
  "comparison",
  "process",
  "example",
  "exercise",
  "summary",
  "qa",
];
const SLIDE_TYPES = [
  "cover",
  "agenda",
  "section",
  "content_text",
  "content_bullets",
  "compare",
  "process",
  "timeline",
  "data_insight",
  "case_study",
  "quote",
  "example",
  "exercise",
  "summary",
  "next_steps",
  "thanks",
];
const SCENARIO_PRESETS = {
  teaching: [
    "cover",
    "section",
    "content_text",
    "content_text",
    "section",
    "content_text",
    "content_bullets",
    "content_text",
    "content_bullets",
    "thanks",
  ],
  business_report: [
    "cover",
    "section",
    "content_text",
    "content_text",
    "section",
    "content_text",
    "content_bullets",
    "content_text",
    "content_bullets",
    "thanks",
  ],
  proposal: [
    "cover",
    "section",
    "content_text",
    "content_text",
    "section",
    "content_text",
    "content_bullets",
    "content_text",
    "content_bullets",
    "thanks",
  ],
  training: [
    "cover",
    "section",
    "content_text",
    "content_bullets",
    "section",
    "content_text",
    "content_bullets",
    "content_text",
    "content_bullets",
    "thanks",
  ],
  research: [
    "cover",
    "agenda",
    "section",
    "content_text",
    "data_insight",
    "compare",
    "case_study",
    "summary",
    "next_steps",
    "thanks",
  ],
  product_intro: [
    "cover",
    "agenda",
    "section",
    "content_text",
    "compare",
    "content_text",
    "case_study",
    "data_insight",
    "summary",
    "thanks",
  ],
  summary: [
    "cover",
    "agenda",
    "content_text",
    "summary",
    "next_steps",
    "thanks",
  ],
};
const SCENARIO_EXPANDABLE_TYPES = {
  teaching: ["content_text", "content_bullets"],
  business_report: ["content_text", "content_bullets"],
  proposal: ["content_text", "content_bullets"],
  training: ["content_text", "content_bullets"],
  research: ["content_text", "data_insight", "case_study"],
  product_intro: ["content_text", "compare", "data_insight"],
  summary: ["content_text", "summary"],
};
const FORBIDDEN_TEMPLATE_TEXT = [
  "OfficePLUS",
  "20XX",
  "202X",
  "时间：",
  "/05/01",
  "时间：202X/05/01",
  "本章目标",
  "输入标题",
  "请在此输入",
  "请您单击此处",
  "或者到此处",
  "您的文字内容或者到此处",
  "您的文字内容",
  "粘贴复制的文本",
  "添加合适文字",
  "文本内容加以解释说明",
  "Your text here",
  "Click to add",
  "Lorem ipsum",
  "placeholder",
  "template",
  "PART 01",
  "PART 02",
];
const STALE_MOCK_PATTERNS = [/要点\d+/i, /动作\d+/i, /聚焦一个中心观点/i];
const CROSS_TOPIC_LEAK_TERMS = [
  /牛顿第二定律/i,
  /牛顿第一定律/i,
  /F\s*=\s*ma/i,
  /实验探究/i,
  /课堂讲解/i,
  /公式详解/i,
  /复习[:：]/i,
  /本章目标/i,
];
const SCENARIO_LEAK_PATTERNS = {
  proposal: [/实验探究/i, /牛顿/i, /课堂/i, /PART\s*0?\d+/i],
  business_report: [/实验探究/i, /牛顿/i, /课堂/i],
  teaching: [/市场分析报告/i, /降本增效方案/i, /ROI/i],
  training: [/牛顿/i, /实验探究/i],
};
const PLACEHOLDER_PATTERNS = [
  ...FORBIDDEN_TEMPLATE_TEXT.map(
    (x) => new RegExp(String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
  ),
  /单击添加标题/i,
  /单击添加副标题/i,
  /CONTENT/i,
  /LOGO/i,
];
const SLIDE_TYPE_FIELDS = {
  cover: ["title", "subtitle", "speaker", "date", "footer"],
  agenda: ["title", "bullets", "footer"],
  section: ["sectionNo", "title", "subtitle", "footer"],
  content_text: ["title", "label", "body", "visualHint", "footer"],
  content_bullets: ["title", "label", "bullets", "visualHint", "footer"],
  compare: [
    "title",
    "leftTitle",
    "leftPoints",
    "rightTitle",
    "rightPoints",
    "conclusion",
    "footer",
  ],
  process: ["title", "steps", "conclusion", "footer"],
  timeline: ["title", "milestones", "footer"],
  data_insight: ["title", "metric", "insight", "chartHint", "footer"],
  case_study: ["title", "background", "action", "result", "footer"],
  quote: ["title", "body", "footer"],
  example: ["title", "problem", "solution", "keyTakeaway", "footer"],
  exercise: ["title", "question", "options", "answer", "footer"],
  summary: ["title", "keyPoints", "conclusion", "footer"],
  next_steps: ["title", "actions", "ownerHint", "footer"],
  thanks: ["title", "subtitle", "footer"],
};
const FORBIDDEN_IN_TITLE_PATTERNS = [
  /\d+\s*\/\s*\d+/,
  /\bV\s*\d+(?:\.\d+)?\b/i,
  /内容由\s*AI\s*生成/i,
  /Q\s*&?\s*A\s*Q\s*&?\s*A/i,
  /图示[:：]|示意[:：]/,
];
const METADATA_POLLUTION_PATTERNS = [
  /\d+\s*\/\s*\d+/,
  /内容由\s*AI\s*生成/i,
  /\bV\s*\d+(?:\.\d+)?\b/i,
  /版本\s*\d+(?:\.\d+)?/i,
];

function extractSlideNamespaces(slideInput, index = 1) {
  const raw = slideInput && typeof slideInput === "object" ? slideInput : {};
  const contentRaw =
    raw.content && typeof raw.content === "object" ? raw.content : {};
  const metadataRaw =
    raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};

  const title = stripVersionSuffix(
    cleanDeckText(contentRaw.title || raw.title || "", 96),
  );
  const subtitle = cleanDeckText(contentRaw.subtitle || raw.subtitle || "", 80);
  const bodyRaw =
    contentRaw.body !== undefined
      ? contentRaw.body
      : raw.body !== undefined
        ? raw.body
        : raw.goal !== undefined
          ? raw.goal
          : raw.summary !== undefined
            ? raw.summary
            : "";
  const body = Array.isArray(bodyRaw)
    ? bodyRaw.map((x) => cleanDeckText(x, 80)).filter(Boolean)
    : cleanDeckText(bodyRaw, 220);

  const version = cleanDeckText(metadataRaw.version || raw.version || "", 32);
  const source = cleanDeckText(metadataRaw.source || raw.footer || "", 32);
  const pageNumber = cleanDeckText(
    metadataRaw.pageNumber || raw.pageNo || "",
    16,
  );

  return {
    content: {
      title,
      subtitle,
      body,
    },
    metadata: {
      version,
      source,
      pageNumber,
    },
    hasExplicitNamespaces: !!(raw.content || raw.metadata),
  };
}

function titleHasForbiddenPattern(title) {
  const t = cleanDeckText(title || "", 0);
  if (!t) return false;
  return FORBIDDEN_IN_TITLE_PATTERNS.some((re) => re.test(t));
}

function hasMetadataPollution(value) {
  const t = cleanDeckText(value || "", 0);
  if (!t) return false;
  return METADATA_POLLUTION_PATTERNS.some((re) => re.test(t));
}

function validateContentMetadataBoundary(slide, index) {
  const errors = [];
  const ns = extractSlideNamespaces(slide, index);
  const title = cleanDeckText(ns.content.title, 0);
  const subtitle = cleanDeckText(ns.content.subtitle, 0);

  if (!title) {
    errors.push({
      slideIndex: index,
      type: "schemaBoundary",
      text: "missing_content_title",
    });
    return errors;
  }

  if (titleHasForbiddenPattern(title)) {
    errors.push({
      slideIndex: index,
      type: "schemaBoundary",
      text: "forbidden_pattern_in_title",
    });
  }

  if (subtitle && hasMetadataPollution(subtitle)) {
    errors.push({
      slideIndex: index,
      type: "schemaBoundary",
      text: "metadata_pollution_in_subtitle",
    });
  }

  const body = ns.content.body;
  if (typeof body === "string") {
    if (/\d+\s*\/\s*\d+/.test(body) || /内容由\s*AI\s*生成/i.test(body)) {
      errors.push({
        slideIndex: index,
        type: "schemaBoundary",
        text: "metadata_pollution_in_body",
      });
    }
  } else if (Array.isArray(body)) {
    const polluted = body.some(
      (x) =>
        /\d+\s*\/\s*\d+/.test(String(x || "")) ||
        /内容由\s*AI\s*生成/i.test(String(x || "")),
    );
    if (polluted)
      errors.push({
        slideIndex: index,
        type: "schemaBoundary",
        text: "metadata_pollution_in_body",
      });
  }

  return errors;
}

function asGlobalRegex(pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function isTemplatePlaceholderText(value) {
  const text = sanitizeContractText(value || "", 0);
  const normalized = String(text || "").replace(/\s+/g, "");
  if (!normalized) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(text));
}

function cleanDeckText(value, maxLen = 0) {
  let text = sanitizeContractText(value || "", 0);
  for (const pattern of PLACEHOLDER_PATTERNS) {
    text = text.replace(asGlobalRegex(pattern), "");
  }
  text = text.replace(/\s{2,}/g, " ").trim();
  if (isTemplatePlaceholderText(text)) text = "";
  if (maxLen > 0 && text.length > maxLen) text = `${text.slice(0, maxLen)}…`;
  return text;
}

function stripVersionSuffix(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .replace(/\s*[\(（]?v\s*\d+(?:\.\d+)?[\)）]?\s*$/i, "")
    .replace(/\s*[\(（]?版本\s*\d+(?:\.\d+)?[\)）]?\s*$/i, "")
    .replace(/\s*[\(（]?(?:新版|执行版|修订版)[\)）]?\s*$/i, "")
    .trim();
}

function isDecisionLikeText(value) {
  const text = String(value || "");
  return /(决策|下一步|行动项|管理)/.test(text);
}

function cleanDecisionDesc(text, maxLen = 22) {
  const cleaned = cleanDeckText(text || "", 0)
    .replace(/^第\s*\d+\s*阶段[:：]?\s*/i, "")
    .replace(/^(阶段|流程)[:：]?\s*/i, "")
    .replace(/(阶段|流程|里程碑)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length > maxLen) return cleaned.slice(0, maxLen);
  return cleaned;
}

function getDecisionFourPointPrompt() {
  return "请从范围、预算、系统接入、责任人这4个不同维度，各生成一条决策事项。每条由4-6字短标题+12-20字说明组成，互不重复，不要合并。";
}

function buildDecisionFourPointDefaults() {
  return [
    { title: "试点范围", desc: "明确首批渠道与服务场景边界" },
    { title: "预算边界", desc: "锁定试点投入上限与审批口径" },
    { title: "系统接入", desc: "确认客服系统接口与联调计划" },
    { title: "责任人", desc: "指定业务与技术双负责人机制" },
  ];
}

function normalizeFourPointItems(rawItems, rawBullets, labelText = "") {
  const defaults = buildDecisionFourPointDefaults();
  const out = [];
  const seenTitle = new Set();
  const seenDesc = new Set();

  const pushItem = (title, desc) => {
    const t = cleanDeckText(title || "", 10)
      .replace(/^输入标题$/i, "")
      .trim();
    const d = cleanDecisionDesc(desc || "", 22);
    if (!t || !d) return;
    const tk = t.toLowerCase();
    const dk = d.toLowerCase();
    if (seenTitle.has(tk) || seenDesc.has(dk)) return;
    seenTitle.add(tk);
    seenDesc.add(dk);
    out.push({ title: t.slice(0, 6), desc: d });
  };

  const items = Array.isArray(rawItems) ? rawItems : [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    pushItem(
      it.title || it.name || it.label,
      it.desc || it.point || it.text || it.body,
    );
    if (out.length >= 4) break;
  }

  if (out.length < 4) {
    const bullets = Array.isArray(rawBullets) ? rawBullets : [];
    for (let i = 0; i < bullets.length && out.length < 4; i += 1) {
      const b = cleanDecisionDesc(bullets[i] || "", 22);
      const fallbackTitle = defaults[out.length]
        ? defaults[out.length].title
        : `事项${out.length + 1}`;
      pushItem(fallbackTitle, b);
    }
  }

  for (let i = out.length; i < 4; i += 1) {
    const d = defaults[i];
    pushItem(d.title, d.desc);
  }

  const normalized = out.slice(0, 4);
  const label = cleanDeckText(labelText || "", 20);
  return {
    label: label || "管理决策",
    items: normalized,
    bullets: normalized.map((x) => x.desc),
  };
}

function validateFourPointGeneration(slide, index) {
  const s = slide && typeof slide === "object" ? slide : {};
  const layoutId = String(s.layoutId || "").toLowerCase();
  if (layoutId !== "four_points") return [];

  const errors = [];
  const items = Array.isArray(s.items) ? s.items : [];
  if (items.length !== 4) {
    errors.push({
      slideIndex: index,
      type: "fourPointsGeneration",
      text: `items_count_${items.length}`,
    });
    return errors;
  }

  const seen = new Set();
  const lengths = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const title = cleanDeckText(it.title || "", 0);
    const desc = cleanDecisionDesc(it.desc || it.text || "", 40);
    if (!title || /^输入标题$/i.test(title)) {
      errors.push({
        slideIndex: index,
        type: "fourPointsGeneration",
        text: `item_${i + 1}_title_invalid`,
      });
    }
    if (!desc) {
      errors.push({
        slideIndex: index,
        type: "fourPointsGeneration",
        text: `item_${i + 1}_desc_empty`,
      });
    }
    if (desc.length < 10 || desc.length > 24) {
      errors.push({
        slideIndex: index,
        type: "fourPointsGeneration",
        text: `item_${i + 1}_desc_chars_${desc.length}`,
      });
    }
    const key = `${title}::${desc}`.toLowerCase();
    if (seen.has(key)) {
      errors.push({
        slideIndex: index,
        type: "fourPointsGeneration",
        text: `item_${i + 1}_duplicate`,
      });
    }
    seen.add(key);
    if (desc) lengths.push(desc.length);
  }

  if (lengths.length === 4) {
    const minLen = Math.min(...lengths);
    const maxLen = Math.max(...lengths);
    if (maxLen - minLen > 10) {
      errors.push({
        slideIndex: index,
        type: "fourPointsGeneration",
        text: `length_spread_${maxLen - minLen}`,
      });
    }
  }

  return errors;
}

function validateSlideScriptsAtSource(slideScripts) {
  const scripts = Array.isArray(slideScripts) ? slideScripts : [];
  const errors = [];
  for (let i = 0; i < scripts.length; i += 1) {
    const idx = i + 1;
    errors.push(...validateContentMetadataBoundary(scripts[i], idx));
    errors.push(...validateFourPointGeneration(scripts[i], idx));
  }
  return {
    ok: errors.length === 0,
    pass: errors.length === 0,
    errors,
    issues: errors.map((e) => `${e.type}_slide_${e.slideIndex}_${e.text}`),
  };
}

function isLikelyTitleGarble(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  const qCount = (text.match(/[?？]/g) || []).length;
  const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (qCount >= 4 && zhCount === 0) return true;
  return /\?{4,}|？{4,}/.test(text);
}

function normalizeSlideType(rawType, index = 1) {
  const t = String(rawType || "")
    .trim()
    .toLowerCase();
  if (SLIDE_TYPE_ENUM.includes(t)) return t;
  if (SLIDE_TYPES.includes(t)) {
    if (
      t === "content_text" ||
      t === "content_bullets" ||
      t === "data_insight" ||
      t === "case_study" ||
      t === "quote"
    )
      return "content";
    if (t === "compare") return "comparison";
    if (t === "timeline") return "process";
    if (t === "next_steps" || t === "thanks") return "qa";
    return t;
  }
  if (index === 1) return "cover";
  if (index === 2) return "agenda";
  return "content";
}

function normalizeScriptType(rawType, index = 1) {
  const t = String(rawType || "")
    .trim()
    .toLowerCase();
  if (SLIDE_TYPES.includes(t)) return t;
  if (t === "content") return "content_text";
  if (t === "comparison") return "compare";
  if (t === "qa") return "thanks";
  if (t === "process") return "process";
  if (index === 1) return "cover";
  return "content_text";
}

function mapLayoutTypeToSlideType(layoutType, index = 1) {
  const t = String(layoutType || "")
    .trim()
    .toLowerCase();
  if (!t) return normalizeSlideType("", index);
  if (t === "summary-hero") return index === 1 ? "cover" : "summary";
  if (t === "roadmap-timeline") return "process";
  if (t === "strategy-compare") return "comparison";
  if (t === "decision-board") return "qa";
  if (t === "risk-heatmap") return "exercise";
  if (t === "evidence-chart") return "example";
  if (t === "diagnosis-matrix") return "content";
  return normalizeSlideType("", index);
}

function mapSlideTypeToLayoutType(slideType, index = 1) {
  const t = normalizeSlideType(slideType, index);
  if (t === "cover") return "summary-hero";
  if (t === "agenda") return "roadmap-timeline";
  if (t === "section") return "diagnosis-matrix";
  if (t === "comparison") return "strategy-compare";
  if (t === "process") return "roadmap-timeline";
  if (t === "example") return "evidence-chart";
  if (t === "exercise") return "risk-heatmap";
  if (t === "summary") return "summary-hero";
  if (t === "qa") return "decision-board";
  return "diagnosis-matrix";
}

function chooseLayoutByContentIntent(slideScript, index = 1) {
  const s = slideScript && typeof slideScript === "object" ? slideScript : {};
  const type = normalizeScriptType(s.type || s.slideType, index);
  const sectionNo = cleanDeckText(s.sectionNo || "", 8);
  const body = cleanDeckText(
    s.body || s.goal || s.summary || s.insight || "",
    260,
  );
  const bullets = sanitizeBullets(s.bullets || s.keyPoints || [], 6);
  const actions = Array.isArray(s.actions) ? s.actions.filter(Boolean) : [];

  if (type === "cover" || type === "thanks") return type;
  if (String(s.layoutId || "").toLowerCase() === "four_points")
    return "four_points";
  if (type === "next_steps") return "content_bullets";
  if (sectionNo && !body && bullets.length === 0) return "section";
  if (type === "section") return "section";

  // Hard-disable four-points promotion path to prevent recurring mislayout regressions.
  if (actions.length === 3) return "content_bullets";
  if (bullets.length === 3) return "content_bullets";
  if (body.length >= 60) return "content_text";

  return "content_text";
}

function sanitizeBullets(input, maxItems = 5) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    let cleaned = cleanDeckText(row, 0)
      .replace(/^(结论：|证据：|行动：)/, "")
      .trim();
    if (cleaned.length > 24) cleaned = cleaned.slice(0, 24);
    if (!cleaned) continue;
    if (isTemplatePlaceholderText(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanForbiddenPrefixes(text) {
  return String(text || "")
    .replace(/^(结论：|证据：|行动：)/g, "")
    .replace(/^(结论:|证据:|行动:)/g, "")
    .replace(/OfficePLUS/gi, "")
    .replace(/20XX|202X/g, "")
    .replace(/LOGO|CONTENT/gi, "")
    .trim();
}

function inferScenarioFromText(text) {
  const value = String(text || "");
  if (/(培训|入职|上岗|演练|课堂训练)/.test(value)) return "training";
  if (/(方案|建议书|提案|招标|落地路径)/.test(value)) return "proposal";
  if (/(研究|调研|白皮书|论文|实验报告)/.test(value)) return "research";
  if (/(产品|发布|功能介绍|路演|发布会|品牌故事)/.test(value))
    return "product_intro";
  if (/(复盘|总结|回顾)/.test(value)) return "summary";
  if (/(课堂|教学|学生|教案|讲解|课件)/.test(value)) return "teaching";
  return "business_report";
}

function inferToneByScenario(scenario) {
  if (scenario === "teaching" || scenario === "training") return "educational";
  if (scenario === "proposal") return "persuasive";
  if (scenario === "summary") return "concise";
  return "professional";
}

function analyzeUserIntent(input) {
  const source = input && typeof input === "object" ? input : {};
  const rawScenario = String(source.scenario || source.sceneType || "")
    .trim()
    .toLowerCase();
  const topic =
    stripVersionSuffix(
      cleanDeckText(
        source.topic || source.userTopic || source.userInput || "当前主题",
        120,
      ),
    ) || "当前主题";
  const scenario = SCENARIO_PRESETS[rawScenario]
    ? rawScenario
    : inferScenarioFromText(`${source.sceneType || ""} ${topic}`);
  const audience =
    cleanDeckText(source.audience || source.targetAudience || "通用受众", 60) ||
    "通用受众";
  const tone =
    cleanDeckText(source.tone || inferToneByScenario(scenario), 32) ||
    inferToneByScenario(scenario);
  const explicitCount = Number(source.pageCount || 0);
  const pageCount =
    Number.isFinite(explicitCount) && explicitCount > 0
      ? Math.max(8, Math.min(12, Math.round(explicitCount)))
      : 10;
  return { topic, scenario, audience, tone, pageCount };
}

function buildDeckPlan(intent, input = {}) {
  const base = intent || analyzeUserIntent(input);
  const structure =
    Array.isArray(input && input.structure) && input.structure.length
      ? input.structure.map((x, i) => ({
          sectionTitle:
            cleanDeckText(x && x.sectionTitle, 24) || `第${i + 1}部分`,
          pages: Math.max(1, Number(x && x.pages) || 1),
        }))
      : [
          {
            sectionTitle: "问题背景",
            pages: Math.max(1, Math.round(base.pageCount * 0.2)),
          },
          {
            sectionTitle: "核心分析",
            pages: Math.max(2, Math.round(base.pageCount * 0.4)),
          },
          {
            sectionTitle: "方案与行动",
            pages: Math.max(1, Math.round(base.pageCount * 0.3)),
          },
        ];
  return {
    topic: base.topic,
    scenario: base.scenario,
    audience: base.audience,
    tone: base.tone,
    pageCount: base.pageCount,
    narrative:
      cleanDeckText(input && input.narrative, 120) ||
      `${base.topic}从背景到行动的单线叙事`,
    structure,
  };
}

function stretchPresetTypes(scenario, pageCount) {
  const base = Array.isArray(SCENARIO_PRESETS[scenario])
    ? [...SCENARIO_PRESETS[scenario]]
    : [...SCENARIO_PRESETS.business_report];
  const target = Math.max(6, Math.min(20, Number(pageCount) || 10));
  if (base.length === target) return base;
  if (base.length > target) {
    const keepTail = base.slice(-1);
    const head = base.slice(0, Math.max(1, target - keepTail.length));
    return [...head, ...keepTail].slice(0, target);
  }
  const expandable = SCENARIO_EXPANDABLE_TYPES[scenario] || [
    "content_text",
    "data_insight",
    "case_study",
  ];
  const out = [...base];
  let i = 0;
  while (out.length < target) {
    out.splice(
      Math.max(1, out.length - 2),
      0,
      expandable[i % expandable.length],
    );
    i += 1;
  }
  return out;
}

function createDefaultSlideScript(type, idx, deckPlan, input = {}) {
  const sectionNo = String(idx).padStart(2, "0");
  const topic =
    stripVersionSuffix(cleanDeckText(deckPlan && deckPlan.topic, 40)) ||
    "当前主题";
  const scenario = String(
    (deckPlan && deckPlan.scenario) || "business_report",
  ).toLowerCase();
  const styleHint = cleanDeckText(
    (input && (input.styleGuide || input.variant || input.promptVersion)) || "",
    80,
  ).toLowerCase();
  const seedHint = Number(input && input.seed);
  const diversityKey = `${topic}|${styleHint}|${Number.isFinite(seedHint) ? seedHint : "na"}|${idx}`;
  const footer = "";
  const title = idx === 1 ? topic : `${topic}第${idx}页`;
  const oneBody = `${topic}围绕业务目标给出可执行方案，结合场景对象、关键动作与衡量指标，确保本页信息可直接用于汇报与决策。`;

  const pickByKey = (arr, fallback = "") => {
    const list = Array.isArray(arr)
      ? arr.filter((x) => typeof x === "string" && x.trim())
      : [];
    if (!list.length) return fallback;
    let h = 0;
    for (let i = 0; i < diversityKey.length; i += 1)
      h = (h * 31 + diversityKey.charCodeAt(i)) >>> 0;
    return list[h % list.length] || fallback;
  };

  if (scenario === "proposal") {
    const t = topic;
    const angle = String((input && input.diversityAngle) || "balanced");
    const angleProfiles = {
      roi: {
        subtitle: `${t}提案汇报：聚焦ROI验证路径`,
        s3: `${t}目前在高频场景中存在明显资源浪费，标准问题处理成本偏高。若按试点方式先覆盖TOP场景，可在3个月内验证单位成本下降与响应效率提升。`,
        s4: `围绕${t}应优先拆解“流量入口、问题分类、转接策略、复盘机制”四段链路，先做高影响节点优化，再扩展到中低频场景，确保收益可量化。`,
        s6: `${t}建议采用“价值目标-能力模块-收益看板”架构，用同一指标口径追踪效率、成本与满意度，形成可持续优化闭环。`,
        s7: [
          `第1阶段：锁定${t}的ROI口径与基线`,
          `第2阶段：在高频场景上线${t}并对比前后数据`,
          `第3阶段：按收益优先级扩展至更多场景`,
        ],
        s8: `建议围绕${t}建立收益看板，至少覆盖单次服务成本、一次解决率、平均响应时长与满意度，按周复盘并动态调整资源投入。`,
      },
      risk: {
        subtitle: `${t}提案汇报：强调风险可控`,
        s3: `${t}当前问题并非单点故障，而是流程协同与质量兜底不足。若直接大规模上线，可能引发体验波动，应先通过小范围试点验证风险边界。`,
        s4: `围绕${t}需重点拆解“误判风险、转人工滞后、知识库缺口、监控盲区”四类问题，先补齐兜底机制，再逐步扩大自动化覆盖范围。`,
        s6: `${t}建议采用“分级策略+人工兜底+实时告警”架构，在每个关键节点设置回退机制，确保效率提升不以服务质量为代价。`,
        s7: [
          `第1阶段：定义${t}的风险分级与兜底规则`,
          `第2阶段：灰度试点${t}并监控异常告警`,
          `第3阶段：在风险可控前提下扩大覆盖`,
        ],
        s8: `建议围绕${t}建立风险指标集，包括误判率、转人工时延、投诉率与SLA达成率，确保每次扩容都在阈值内推进。`,
      },
      tech: {
        subtitle: `${t}提案汇报：技术能力演进`,
        s3: `${t}当前瓶颈集中在知识检索精度与多系统联动效率，导致自动化能力难以稳定释放。需要先完成数据治理和接口标准化。`,
        s4: `围绕${t}应拆解“数据层、模型层、编排层、运营层”能力缺口，先打通知识与工单系统，再优化策略引擎与反馈学习流程。`,
        s6: `${t}建议采用“知识中台+策略编排+质量评估”技术架构，以模块化方式迭代能力，降低后续扩展与维护成本。`,
        s7: [
          `第1阶段：完成${t}核心系统接口与数据对齐`,
          `第2阶段：上线${t}策略编排并接入质量评估`,
          `第3阶段：持续迭代模型与知识更新机制`,
        ],
        s8: `建议围绕${t}跟踪技术指标，如召回准确率、接口稳定性、自动处理成功率与回归缺陷率，确保技术迭代可观测。`,
      },
      process: {
        subtitle: `${t}提案汇报：流程重构优先`,
        s3: `${t}当前流程存在重复确认与跨团队交接低效，导致处理链路拉长。需要通过标准化流程与职责边界重构提升整体吞吐。`,
        s4: `围绕${t}应拆解“入口分流、任务路由、协同审批、复盘改进”四段流程，先治理长链路节点，再提升跨部门协同效率。`,
        s6: `${t}建议采用“流程模板化+策略自动化+复盘常态化”架构，确保每次流程调整都能快速验证并沉淀可复制经验。`,
        s7: [
          `第1阶段：梳理${t}关键流程并设定标准模板`,
          `第2阶段：上线${t}自动路由与协同规则`,
          `第3阶段：按复盘结果持续优化流程`,
        ],
        s8: `建议围绕${t}跟踪流程指标，包括流转时长、中断率、协同完成率与复盘闭环率，持续压缩无效环节。`,
      },
      experience: {
        subtitle: `${t}提案汇报：体验与增长并重`,
        s3: `${t}当前用户体验受响应一致性与问题解决率影响明显，导致留存和满意度承压。应优先在关键触点提升体验稳定性。`,
        s4: `围绕${t}应拆解“首次触达体验、问题解决效率、升级处理体验、复访反馈体验”四个触点，逐步提升端到端感知质量。`,
        s6: `${t}建议采用“体验指标驱动+策略精细化+反馈闭环”架构，让体验优化和效率提升同步推进，避免单边优化。`,
        s7: [
          `第1阶段：定义${t}关键体验指标与目标值`,
          `第2阶段：在核心触点试点${t}体验优化策略`,
          `第3阶段：根据用户反馈迭代并扩展`,
        ],
        s8: `建议围绕${t}监测NPS、一次解决率、重复咨询率与关键触点满意度，建立体验与效率联动看板。`,
      },
      cost: {
        subtitle: `${t}提案汇报：成本结构优化`,
        s3: `${t}当前成本压力来自高频重复处理与人力峰值冗余，边际成本随业务增长快速上升。需要通过自动化与分级处理优化成本结构。`,
        s4: `围绕${t}应拆解“人力结构、自动化覆盖、峰值调度、质量返工”四项成本因子，优先治理可规模化降本的关键环节。`,
        s6: `${t}建议采用“成本分层核算+自动化优先+质量防返工”架构，以周为单位评估投入产出并滚动优化预算分配。`,
        s7: [
          `第1阶段：建立${t}成本基线与分层口径`,
          `第2阶段：提升${t}自动化覆盖并压降人工峰值`,
          `第3阶段：按成本收益曲线持续优化投放`,
        ],
        s8: `建议围绕${t}持续跟踪人均产出、单次处理成本、返工率与峰值人力利用率，形成可执行的降本节奏。`,
      },
    };
    const profile = angleProfiles[angle] || angleProfiles.roi;
    const profileCopy = profile;

    const proposalByIndex = {
      1: {
        type: "cover",
        title: t,
        subtitle: profileCopy.subtitle,
        speaker: "项目负责人",
        date: new Date().toISOString().slice(0, 10),
        footer,
      },
      2: {
        type: "section",
        sectionNo: "01",
        title: "现状与问题",
        subtitle: `${t}的核心约束与机会`,
        footer,
      },
      3: {
        type: "content_text",
        title: "现状评估",
        label: "现状背景",
        body: profileCopy.s3,
        visualHint: `${t}现状结构图`,
        footer,
      },
      4: {
        type: "content_text",
        title: "关键问题拆解",
        label: "问题拆解",
        body: profileCopy.s4,
        visualHint: `${t}问题分层卡片`,
        footer,
      },
      5: {
        type: "section",
        sectionNo: "02",
        title: "方案设计",
        subtitle: `${t}的分阶段落地方案`,
        footer,
      },
      6: {
        type: "content_text",
        title: "方案架构",
        label: "方案设计",
        body: profileCopy.s6,
        visualHint: `${t}方案架构图`,
        footer,
      },
      7: {
        type: "content_bullets",
        title: "三阶段推进试点落地",
        label: "实施路径",
        bullets: Array.isArray(profileCopy.s7)
          ? profileCopy.s7
          : [
              `第1阶段：明确${t}目标与边界`,
              `第2阶段：完成${t}试点并跟踪关键指标`,
              `第3阶段：复盘优化后推进规模化`,
            ],
        visualHint: "阶段里程碑流程图",
        footer,
      },
      8: {
        type: "content_text",
        title: "用关键指标验证收益",
        label: "价值评估",
        body: profileCopy.s8,
        visualHint: "试点指标仪表盘",
        footer,
      },
      9: {
        type: "content_bullets",
        layoutId: "four_points",
        generationPrompt: getDecisionFourPointPrompt(),
        title: "下一步决策事项",
        label: "管理决策",
        items: buildDecisionFourPointDefaults(),
        bullets: buildDecisionFourPointDefaults().map((x) => x.desc),
        visualHint: "决策事项清单",
        footer,
      },
      10: { type: "thanks", title: "谢谢观看", subtitle: "Q&A", footer },
    };
    const picked = proposalByIndex[idx];
    if (picked) return { id: `s${idx}`, ...picked };
  }

  if (type === "cover")
    return {
      id: `s${idx}`,
      type,
      title: topic,
      subtitle: `${scenario} 场景汇报`,
      speaker: "汇报人",
      date: new Date().toISOString().slice(0, 10),
      footer,
    };
  if (type === "agenda")
    return {
      id: `s${idx}`,
      type,
      title: "目录",
      bullets: ["背景", "分析", "行动"],
      visualHint: "目录结构图",
      footer,
    };
  if (type === "section")
    return {
      id: `s${idx}`,
      type,
      sectionNo,
      title: `章节${sectionNo}`,
      subtitle: "章节说明",
      footer,
    };
  if (type === "content_bullets")
    return {
      id: `s${idx}`,
      type,
      title,
      label: "核心要点",
      bullets: [
        "先定义问题边界与目标",
        "再明确关键动作与责任",
        "最后确认指标与复盘机制",
      ],
      visualHint: "执行要点图",
      footer,
    };
  if (type === "compare")
    return {
      id: `s${idx}`,
      type,
      title,
      leftTitle: "方案A",
      leftPoints: [
        "投入更低，适合快速试点",
        "上线周期短，风险可控",
        "适合先验证关键指标",
      ],
      rightTitle: "方案B",
      rightPoints: [
        "能力更完整，覆盖面更广",
        "实施复杂度更高",
        "适合中长期规模化",
      ],
      conclusion: "按目标阶段选择最优解",
      visualHint: "对比图",
      footer,
    };
  if (type === "process")
    return {
      id: `s${idx}`,
      type,
      title,
      steps: [
        "完成现状诊断并锁定优先场景",
        "按里程碑推进实施并跟踪数据",
        "复盘问题后持续优化与扩展",
      ],
      conclusion: "形成可复制的执行闭环",
      visualHint: "流程图",
      footer,
    };
  if (type === "timeline")
    return {
      id: `s${idx}`,
      type,
      title,
      milestones: [
        "第1阶段：准备与基线建立",
        "第2阶段：试点上线与验证",
        "第3阶段：优化与全面推广",
      ],
      visualHint: "时间轴",
      footer,
    };
  if (type === "data_insight")
    return {
      id: `s${idx}`,
      type,
      title,
      metric: "关键指标",
      insight:
        "通过对成本、效率和满意度数据的联合分析，可以识别最具价值的优化环节并优先投入资源。",
      chartHint: "柱状图",
      visualHint: "数据图",
      footer,
    };
  if (type === "case_study")
    return {
      id: `s${idx}`,
      type,
      title,
      background: "某团队在高峰期出现响应延迟和人力压力。",
      action:
        "先聚焦高频问题场景上线自动化能力，再逐步接入复杂问题转人工链路。",
      result: "响应时效与处理效率显著提升，人工压力下降。",
      visualHint: "案例卡片",
      footer,
    };
  if (type === "quote")
    return {
      id: `s${idx}`,
      type,
      title,
      body: "引用观点用于强调核心判断。",
      visualHint: "引言页",
      footer,
    };
  if (type === "example")
    return {
      id: `s${idx}`,
      type,
      title,
      problem: "当前流程存在重复沟通和响应延迟。",
      solution: "通过标准化流程与自动化分流降低无效操作。",
      keyTakeaway: "先抓高频场景再扩展复杂场景。",
      visualHint: "示例图",
      footer,
    };
  if (type === "exercise")
    return {
      id: `s${idx}`,
      type,
      title,
      question: "如果目标是先降本，应该优先推进哪一类场景？",
      options: ["高频标准化问题", "低频复杂问题", "所有场景同时推进"],
      answer: "优先高频标准化问题",
      visualHint: "练习卡",
      footer,
    };
  if (type === "summary")
    return {
      id: `s${idx}`,
      type,
      title: "总结",
      keyPoints: [
        "核心问题已被结构化识别",
        "方案具备分阶段落地路径",
        "收益指标可持续跟踪验证",
      ],
      conclusion: "形成统一结论",
      visualHint: "总结图",
      footer,
    };
  if (type === "next_steps")
    return {
      id: `s${idx}`,
      type,
      title: "下一步行动",
      actions: [
        "明确里程碑与负责人",
        "完成试点并跟踪指标",
        "复盘优化后规模化推广",
      ],
      ownerHint: "责任人",
      visualHint: "行动清单",
      footer,
    };
  if (type === "thanks")
    return { id: `s${idx}`, type, title: "感谢", subtitle: "Q&A", footer };
  return {
    id: `s${idx}`,
    type: "content_text",
    title,
    label: "核心观点",
    body: oneBody,
    visualHint: "结构示意图",
    footer,
  };
}

function generateSlideScripts(deckPlan, input = {}) {
  const sourceSlides = Array.isArray(input && input.slides) ? input.slides : [];
  if (sourceSlides.length > 0) {
    return sourceSlides.map((s, i) => {
      const type = normalizeScriptType(
        (s && (s.type || s.slideType)) || "",
        i + 1,
      );
      const fallback = createDefaultSlideScript(type, i + 1, deckPlan, input);
      const merged = { ...fallback, ...(s && typeof s === "object" ? s : {}) };
      merged.id = cleanDeckText(merged.id || `s${i + 1}`, 12) || `s${i + 1}`;
      merged.type = type;
      if (
        String(merged.layoutId || "").toLowerCase() === "four_points" ||
        isDecisionLikeText(`${merged.title || ""} ${merged.label || ""}`)
      ) {
        const four = normalizeFourPointItems(
          merged.items,
          merged.bullets || merged.actions || [],
          merged.label || "管理决策",
        );
        merged.layoutId = "four_points";
        merged.label = four.label;
        merged.items = four.items;
        merged.bullets = four.bullets;
        if (!merged.generationPrompt)
          merged.generationPrompt = getDecisionFourPointPrompt();
      }
      return merged;
    });
  }
  const sequence = stretchPresetTypes(deckPlan.scenario, deckPlan.pageCount);
  return sequence.map((type, i) =>
    createDefaultSlideScript(type, i + 1, deckPlan, input),
  );
}

function normalizeSlideScripts(slides, deckPlan = null) {
  const input = Array.isArray(slides) ? slides : [];
  const out = [];
  const seenTitle = new Set();
  const seenBody = new Set();

  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i] && typeof input[i] === "object" ? { ...input[i] } : {};
    const idx = i + 1;
    const ns = extractSlideNamespaces(raw, idx);
    const type = normalizeScriptType(raw.type || raw.slideType, idx);
    const footer = cleanDeckText(raw.footer || "", 24);
    let title = stripVersionSuffix(
      cleanDeckText(ns.content.title || raw.title || `第${idx}页`, 22),
    );
    if (!title || /^封面[:：]|^章节[:：]/.test(title))
      title =
        cleanDeckText((deckPlan && deckPlan.topic) || `第${idx}页`, 22) ||
        `第${idx}页`;
    if (seenTitle.has(title.toLowerCase()))
      title = cleanDeckText(`${title}-${idx}`, 22) || `第${idx}页`;
    seenTitle.add(title.toLowerCase());

    const normalized = {
      id: cleanDeckText(raw.id || `s${idx}`, 12) || `s${idx}`,
      type,
      title,
      footer,
    };
    if (type === "section") {
      normalized.sectionNo =
        cleanDeckText(raw.sectionNo || String(idx).padStart(2, "0"), 4) ||
        String(idx).padStart(2, "0");
      normalized.subtitle = cleanDeckText(
        ns.content.subtitle || raw.subtitle || "章节说明",
        32,
      );
    } else if (type === "cover" || type === "thanks") {
      normalized.subtitle = cleanDeckText(
        ns.content.subtitle || raw.subtitle || "",
        32,
      );
      if (type === "cover") {
        normalized.speaker = cleanDeckText(raw.speaker || "汇报人", 18);
        normalized.date = cleanDeckText(
          raw.date || new Date().toISOString().slice(0, 10),
          24,
        );
      }
    } else if (type === "content_bullets") {
      const wantFourPoints =
        String(raw.layoutId || "").toLowerCase() === "four_points" ||
        isDecisionLikeText(`${title} ${raw.label || ""}`);
      if (wantFourPoints) {
        const four = normalizeFourPointItems(
          raw.items,
          raw.bullets || raw.keyPoints || raw.actions || [],
          raw.label || "管理决策",
        );
        normalized.layoutId = "four_points";
        normalized.generationPrompt = cleanDeckText(
          raw.generationPrompt || getDecisionFourPointPrompt(),
          220,
        );
        normalized.label = four.label;
        normalized.items = four.items;
        normalized.bullets = four.bullets;
      } else {
        normalized.label = cleanDeckText(raw.label || "核心要点", 20);
        normalized.bullets = sanitizeBullets(
          raw.bullets || raw.keyPoints || [],
          5,
        )
          .map((b) => cleanForbiddenPrefixes(b))
          .filter(Boolean)
          .slice(0, 5);
        if (normalized.bullets.length < 3) {
          const fallbackBullets = [
            "明确目标与适用范围",
            "拆解执行动作与负责人",
            "定义验收指标与节奏",
          ];
          for (const line of fallbackBullets) {
            if (normalized.bullets.length >= 3) break;
            if (!normalized.bullets.includes(line))
              normalized.bullets.push(line);
          }
        }
        const hasQuantBullet = normalized.bullets.some((b) =>
          /\d+(\.\d+)?\s*(%|万元|元|天|周|月|季度|年|人|个|倍)/i.test(
            String(b || ""),
          ),
        );
        if (!hasQuantBullet) {
          normalized.bullets[0] = "试点目标：3周内把一次解决率提升到85%";
        }
      }
      normalized.visualHint =
        cleanDeckText(raw.visualHint || "图示建议", 32) || "图示建议";
    } else if (type === "content_text") {
      normalized.label = cleanDeckText(raw.label || "核心观点", 20);
      let body = cleanDeckText(
        (typeof ns.content.body === "string" ? ns.content.body : "") ||
          raw.body ||
          raw.summary ||
          raw.goal ||
          "",
        160,
      );
      if (body.length < 60) {
        body = cleanDeckText(
          "本页提供可直接用于汇报的业务说明，系统覆盖场景现状、关键判断、执行动作与里程碑安排，帮助读者快速理解问题背景、方案价值与下一步推进优先级。",
          160,
        );
      }
      if (!/\d+(\.\d+)?\s*(%|万元|元|天|周|月|季度|年|人|个|倍)/i.test(body)) {
        body = cleanDeckText(
          `${body} 量化目标：4周内将响应时长降低30%，季度节省成本50万元。`,
          160,
        );
      }
      normalized.body = body;
      normalized.visualHint =
        cleanDeckText(raw.visualHint || "图示建议", 32) || "图示建议";
      const bodyKey = body.toLowerCase();
      if (seenBody.has(bodyKey)) {
        const alternatives = [
          body
            .replace(/目标达成/g, "价值验证")
            .replace(/资源配置/g, "投入分配"),
          body.replace(/执行路径/g, "落地节奏").replace(/关键/g, "核心"),
          body
            .replace(/明显瓶颈/g, "结构性约束")
            .replace(/同步承压/g, "面临挑战"),
        ];
        normalized.body = cleanDeckText(
          alternatives[i % alternatives.length] || body,
          160,
        );
      }
      seenBody.add((normalized.body || "").toLowerCase());
    } else {
      Object.assign(normalized, {
        ...createDefaultSlideScript(
          type,
          idx,
          deckPlan || { topic: title, scenario: "business_report" },
        ),
        ...normalized,
      });
      normalized.title = title;
      normalized.footer = footer;
      if (!normalized.visualHint && !normalized.chartHint)
        normalized.visualHint = "图示建议";
    }

    const contentBody =
      String(normalized.layoutId || "").toLowerCase() === "four_points"
        ? (Array.isArray(normalized.items) ? normalized.items : [])
            .map((it) =>
              `${cleanDeckText(it && it.title, 10)}：${cleanDecisionDesc(it && (it.desc || it.text || it.body), 22)}`.replace(
                /^：/,
                "",
              ),
            )
            .filter(Boolean)
        : type === "content_bullets"
          ? Array.isArray(normalized.bullets)
            ? normalized.bullets.slice(0, 6)
            : []
          : type === "content_text"
            ? cleanDeckText(normalized.body || "", 180)
            : "";
    normalized.content = {
      title: cleanDeckText(normalized.title || "", 96),
      subtitle: cleanDeckText(
        normalized.subtitle || normalized.label || "",
        80,
      ),
      body: contentBody,
    };
    normalized.metadata = {
      version: cleanDeckText(ns.metadata.version || raw.version || "", 32),
      source: cleanDeckText(ns.metadata.source || normalized.footer || "", 32),
      pageNumber: cleanDeckText(ns.metadata.pageNumber || raw.pageNo || "", 16),
    };
    out.push(normalized);
  }

  return out.filter((s) => !!cleanDeckText(s && s.title, 22));
}

function buildLayoutManifest(templateId = "default-clean") {
  return {
    templateId: String(templateId || "default-business-template"),
    layouts: {
      cover: {
        templateIndex: 0,
        slots: {
          title: { shapeName: "TITLE", required: true, maxLength: 28 },
          subtitle: { shapeName: "SUBTITLE", maxLength: 42 },
          footer: { shapeName: "FOOTER", maxLength: 24 },
          pageNo: { shapeName: "PAGE_NO", maxLength: 10 },
        },
      },
      section: {
        templateIndex: 1,
        slots: {
          sectionNo: { shapeName: "SECTION_NO", required: true, maxLength: 6 },
          title: { shapeName: "TITLE", required: true, maxLength: 24 },
          subtitle: { shapeName: "SUBTITLE", maxLength: 20 },
          footer: { shapeName: "FOOTER", maxLength: 24 },
          pageNo: { shapeName: "PAGE_NO", maxLength: 10 },
        },
      },
      content_text: {
        templateIndex: 2,
        slots: {
          title: { shapeName: "TITLE", required: true, maxLength: 24 },
          label: { shapeName: "LABEL", maxLength: 10 },
          body: { shapeName: "BODY", required: true, maxLength: 150 },
          visualHint: { shapeName: "VISUAL_HINT", maxLength: 24 },
          footer: { shapeName: "FOOTER", maxLength: 24 },
          pageNo: { shapeName: "PAGE_NO", maxLength: 10 },
        },
      },
      content_bullets: {
        templateIndex: 3,
        slots: {
          title: { shapeName: "TITLE", required: true, maxLength: 24 },
          label: { shapeName: "LABEL", maxLength: 10 },
          bullets: {
            shapeName: "BODY",
            required: true,
            maxItems: 3,
            maxItemLength: 30,
          },
          visualHint: { shapeName: "VISUAL_HINT", maxLength: 24 },
          footer: { shapeName: "FOOTER", maxLength: 24 },
          pageNo: { shapeName: "PAGE_NO", maxLength: 10 },
        },
      },
      thanks: {
        templateIndex: 4,
        slots: {
          title: { shapeName: "TITLE", required: true, maxLength: 24 },
          subtitle: { shapeName: "SUBTITLE", maxLength: 24 },
          footer: { shapeName: "FOOTER", maxLength: 24 },
          pageNo: { shapeName: "PAGE_NO", maxLength: 10 },
        },
      },
    },
  };
}

function selectTemplateLayouts(slideScripts, templateId = "default-clean") {
  const manifest = buildLayoutManifest(templateId);
  const warnings = [];
  const selected = (Array.isArray(slideScripts) ? slideScripts : []).map(
    (slide, i) => {
      const type = normalizeScriptType(slide && slide.type, i + 1);
      const intentType = chooseLayoutByContentIntent(slide, i + 1);
      const mappedType =
        intentType === "four_points"
          ? "content_bullets"
          : [
                "cover",
                "section",
                "content_text",
                "content_bullets",
                "thanks",
              ].includes(intentType)
            ? intentType
            : "content_text";
      const layout =
        manifest.layouts[mappedType] || manifest.layouts.content_text;
      if (!manifest.layouts[type])
        warnings.push(`missing_layout_${type}_fallback_${mappedType}`);
      const requiredKeys = Object.keys(layout.slots || {}).filter(
        (key) => !!(layout.slots[key] && layout.slots[key].required),
      );
      const missingRequiredSlots = requiredKeys.filter((key) => {
        const v = slide && slide[key];
        if (Array.isArray(v)) return v.length === 0;
        return !cleanDeckText(v, 0);
      });
      return {
        ...slide,
        type,
        intentType,
        mappedType,
        templateIndex: layout.templateIndex,
        slots: layout.slots,
        missingRequiredSlots,
      };
    },
  );
  return { manifest, warnings, slides: selected };
}

function toBulletListFromScript(script) {
  const s = script || {};
  const out = [];
  if (Array.isArray(s.items)) {
    for (const it of s.items) {
      if (!it || typeof it !== "object") continue;
      const t = cleanDeckText(it.title || "", 10);
      const d = cleanDecisionDesc(it.desc || it.text || it.body || "", 22);
      if (t && d) out.push(`${t}：${d}`);
      else if (d) out.push(d);
    }
  }
  if (Array.isArray(s.bullets)) out.push(...sanitizeBullets(s.bullets, 5));
  if (Array.isArray(s.keyPoints)) out.push(...sanitizeBullets(s.keyPoints, 5));
  if (Array.isArray(s.leftPoints))
    out.push(...sanitizeBullets(s.leftPoints, 3));
  if (Array.isArray(s.rightPoints))
    out.push(...sanitizeBullets(s.rightPoints, 3));
  if (Array.isArray(s.steps)) out.push(...sanitizeBullets(s.steps, 5));
  if (Array.isArray(s.milestones))
    out.push(...sanitizeBullets(s.milestones, 5));
  if (Array.isArray(s.options)) out.push(...sanitizeBullets(s.options, 5));
  if (Array.isArray(s.actions)) out.push(...sanitizeBullets(s.actions, 5));
  if (Array.isArray(s.keyPoints)) out.push(...sanitizeBullets(s.keyPoints, 5));
  return sanitizeBullets(out, 5);
}

function formatStageBullets(bullets) {
  return sanitizeBullets(bullets || [], 3).map((line, idx) => {
    const cleaned = cleanDeckText(line || "", 0)
      .replace(/^第\s*\d+\s*阶段[:：]?\s*/i, "")
      .trim();
    return `第${idx + 1}阶段：${cleaned || "补充该阶段动作"}`;
  });
}

function renderSlidesFromTemplate(layoutSelection, deckPlan) {
  const selected =
    layoutSelection && Array.isArray(layoutSelection.slides)
      ? layoutSelection.slides
      : [];
  const slides = selected.map((script, i) => {
    const idx = i + 1;
    const scriptType = normalizeScriptType(script && script.type, idx);
    const slideType = normalizeSlideType(scriptType, idx);
    const title =
      cleanDeckText(script && script.title, 42) ||
      cleanDeckText(deckPlan && deckPlan.topic, 42) ||
      `第${idx}页`;
    const subtitle = cleanDeckText(
      script && (script.subtitle || script.label || script.metric),
      56,
    );
    const body = cleanDeckText(
      script &&
        (script.body ||
          script.insight ||
          script.background ||
          script.problem ||
          script.question ||
          script.conclusion ||
          script.result),
      220,
    );
    const bullets = toBulletListFromScript(script);
    const notes = cleanDeckText(
      script &&
        (script.visualHint ||
          script.chartHint ||
          script.ownerHint ||
          script.solution ||
          script.answer ||
          ""),
      280,
    );
    const slotPayload = {};
    const slots = script && script.slots ? script.slots : {};
    Object.keys(slots).forEach((slotKey) => {
      const value = script[slotKey];
      if (Array.isArray(value)) slotPayload[slotKey] = value.join("；");
      else slotPayload[slotKey] = cleanDeckText(value, 240);
    });

    return {
      index: idx,
      scriptId: script && script.id ? script.id : `s${idx}`,
      scriptType,
      layoutId: String((script && script.layoutId) || "").toLowerCase(),
      slideType,
      title,
      subtitle,
      bullets,
      items: Array.isArray(script && script.items)
        ? script.items.slice(0, 4).map((it) => ({
            title: cleanDeckText(it && it.title, 10),
            desc: cleanDecisionDesc(it && (it.desc || it.text || it.body), 22),
          }))
        : [],
      notes,
      footer: cleanDeckText(script && script.footer, 48),
      date: cleanDeckText(script && script.date, 24),
      goal: scriptType === "section" ? "" : body || subtitle,
      layoutType: mapSlideTypeToLayoutType(slideType, idx),
      keyPoints: bullets,
      speakerNotes: notes,
      templateIndex: Number(script && script.templateIndex) || 0,
      slotPayload,
      missingRequiredSlots: Array.isArray(script && script.missingRequiredSlots)
        ? script.missingRequiredSlots.slice(0, 8)
        : [],
    };
  });

  return { slides };
}

function runDeckPipeline(input) {
  const intent = analyzeUserIntent(input);
  const deckPlan = buildDeckPlan(intent, input);
  const rawScripts = generateSlideScripts(deckPlan, input);
  const normalizedScripts = normalizeSlideScripts(rawScripts, deckPlan);
  const generationValidation = validateSlideScriptsAtSource(normalizedScripts);
  if (!generationValidation.pass) {
    return {
      intent,
      deckPlan,
      slideScripts: normalizedScripts,
      templateManifest: null,
      templateWarnings: [],
      slides: [],
      generationValidation,
    };
  }
  const layoutSelection = selectTemplateLayouts(
    normalizedScripts,
    String((input && input.templateId) || "default-clean"),
  );
  const rendered = renderSlidesFromTemplate(layoutSelection, deckPlan);
  return {
    intent,
    deckPlan,
    slideScripts: normalizedScripts,
    templateManifest: layoutSelection.manifest,
    templateWarnings: layoutSelection.warnings,
    slides: rendered.slides,
    generationValidation,
  };
}

function sanitizeSlideContent(slideInput, index = 1, topic = "") {
  const raw = slideInput && typeof slideInput === "object" ? slideInput : {};
  const slideType = normalizeSlideType(
    raw.slideType ||
      raw.type ||
      mapLayoutTypeToSlideType(raw.layoutType, index),
    index,
  );
  const rawBullets = Array.isArray(raw.bullets)
    ? raw.bullets
    : Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(raw.keyPoints)
        ? raw.keyPoints
        : [];
  let bullets = sanitizeBullets(rawBullets, 5);

  const fallbackTitle =
    slideType === "cover"
      ? cleanDeckText(topic || `第${index}页`, 42)
      : slideType === "section"
        ? `第${index}部分`
        : `第${index}页`;

  let title = stripVersionSuffix(cleanDeckText(raw.title, 42));
  if (/^\d{1,2}$/.test(title)) title = "";
  if (!title) title = fallbackTitle;

  const subtitle = cleanDeckText(raw.subtitle || raw.goal, 56);
  const summary = cleanDeckText(raw.summary || raw.subtitle || raw.goal, 72);
  const notes = cleanDeckText(raw.notes || raw.speakerNotes, 300);
  const footer = cleanDeckText(raw.footer, 48);
  const date = cleanDeckText(raw.date, 24);

  if (
    bullets.length === 0 &&
    slideType !== "cover" &&
    slideType !== "section"
  ) {
    if (slideType === "agenda") {
      bullets = ["现状背景", "关键问题", "方案思路", "执行路径", "结果目标"];
    } else {
      const fallbackPoint = cleanDeckText(
        raw.goal || raw.subtitle || raw.notes || "核心信息说明",
        28,
      );
      bullets = [fallbackPoint || "核心信息说明"];
    }
  }

  return {
    index,
    slideType,
    title,
    subtitle,
    summary,
    bullets,
    notes,
    footer,
    date,
    layoutType: mapSlideTypeToLayoutType(slideType, index),
    assetPlaceholders: Array.isArray(raw.assetPlaceholders)
      ? raw.assetPlaceholders
          .map((x) => cleanDeckText(x, 24))
          .filter(Boolean)
          .slice(0, 4)
      : [],
  };
}

function normalizeTitle(title) {
  return cleanDeckText(title || "", 0)
    .replace(/^封面[:：]/, "")
    .replace(/^第[一二三四五六七八九十]+[章节、.：:]\s*/, "")
    .replace(/^PART\s*\d+/i, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function isDuplicateTitle(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  return !!(x && y && x === y);
}

function hasForbiddenTemplateText(value) {
  const text = sanitizeContractText(value || "", 0);
  if (!text) return false;
  return FORBIDDEN_TEMPLATE_TEXT.some((x) =>
    new RegExp(String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(
      text,
    ),
  );
}

function validateMinimumEffectiveSlide(scriptType, slide, idx) {
  const s = slide && typeof slide === "object" ? slide : {};
  const title = cleanDeckText(s.title || "", 0);
  const subtitle = cleanDeckText(s.subtitle || "", 0);
  const label = cleanDeckText(s.label || "", 0);
  const bullets = sanitizeBullets(s.bullets || s.keyPoints || [], 6);
  const body =
    cleanDeckText(s.goal || s.body || s.insight || "", 0) ||
    cleanDeckText(Array.isArray(bullets) ? bullets.join("；") : "", 0);
  const sectionNo = cleanDeckText(s.sectionNo || "", 0);
  const visualHint = cleanDeckText(s.visualHint || "", 0);
  const errors = [];

  if (!title)
    errors.push({
      slideIndex: idx,
      type: "minimumEffectiveSlide",
      text: "missing_title",
    });

  if (scriptType === "cover") {
    if (!title)
      errors.push({
        slideIndex: idx,
        type: "minimumEffectiveSlide",
        text: "cover_missing_title",
      });
  }

  if (scriptType === "section") {
    const bodyChars = body.replace(/\s+/g, "").length;
    if (bodyChars > 120)
      errors.push({
        slideIndex: idx,
        type: "minimumEffectiveSlide",
        text: "section_body_too_long",
      });
  }

  if (scriptType === "content_text") {
    const bodyChars = body.replace(/\s+/g, "").length;
    if (!body)
      errors.push({
        slideIndex: idx,
        type: "minimumEffectiveSlide",
        text: "content_text_missing_body",
      });
    if (bodyChars < 60 || bodyChars > 180)
      errors.push({
        slideIndex: idx,
        type: "minimumEffectiveSlide",
        text: `content_text_body_chars_${bodyChars}`,
      });
    if (title && (body.includes(title) || label === title))
      errors.push({
        slideIndex: idx,
        type: "minimumEffectiveSlide",
        text: "content_text_repeats_title",
      });
  }

  if (
    scriptType === "content_bullets" &&
    String(s.layoutId || "").toLowerCase() !== "four_points"
  ) {
    if (bullets.length !== 3)
      errors.push({
        slideIndex: idx,
        type: "minimumEffectiveSlide",
        text: `content_bullets_count_${bullets.length}`,
      });
    bullets.forEach((b, bi) => {
      const chars = String(b || "").replace(/\s+/g, "").length;
      if (chars < 10 || chars > 40)
        errors.push({
          slideIndex: idx,
          type: "minimumEffectiveSlide",
          text: `bullet_${bi + 1}_chars_${chars}`,
        });
    });
  }

  if (String(s.layoutId || "").toLowerCase() === "four_points") {
    const items = Array.isArray(s.items) ? s.items : [];
    if (items.length !== 4)
      errors.push({
        slideIndex: idx,
        type: "minimumEffectiveSlide",
        text: `four_points_items_count_${items.length}`,
      });
    const seen = new Set();
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i] || {};
      const t = cleanDeckText(it.title || "", 0);
      const d = cleanDecisionDesc(it.desc || "", 40);
      if (!t || /^输入标题$/i.test(t))
        errors.push({
          slideIndex: idx,
          type: "minimumEffectiveSlide",
          text: `four_points_item_${i + 1}_title_invalid`,
        });
      if (!d || d.length < 10 || d.length > 24)
        errors.push({
          slideIndex: idx,
          type: "minimumEffectiveSlide",
          text: `four_points_item_${i + 1}_desc_invalid`,
        });
      const key = `${t}::${d}`.toLowerCase();
      if (seen.has(key))
        errors.push({
          slideIndex: idx,
          type: "minimumEffectiveSlide",
          text: `four_points_item_${i + 1}_duplicate`,
        });
      seen.add(key);
    }
  }

  if (scriptType === "thanks") {
    if (!title)
      errors.push({
        slideIndex: idx,
        type: "minimumEffectiveSlide",
        text: "thanks_missing_title",
      });
  }

  return errors;
}

function validateDecisionToolCompleteness(contract) {
  const errors = [];
  const scenario = String(
    (contract && (contract.scenario || contract.sceneType)) || "",
  ).toLowerCase();
  if (scenario === "teaching" || scenario === "training") return errors;

  const slides = Array.isArray(contract && contract.slides)
    ? contract.slides
    : [];
  if (slides.length === 0) return errors;

  const textParts = [];
  for (const s of slides) {
    if (!s || typeof s !== "object") continue;
    textParts.push(
      cleanDeckText(s.title || "", 0),
      cleanDeckText(s.subtitle || "", 0),
      cleanDeckText(s.label || "", 0),
      cleanDeckText(s.goal || s.body || s.insight || "", 0),
      cleanDeckText(s.ownerHint || "", 0),
    );
    const bullets = Array.isArray(s.bullets) ? s.bullets : [];
    for (const b of bullets) textParts.push(cleanDeckText(b, 0));
    const actions = Array.isArray(s.actions) ? s.actions : [];
    for (const a of actions) textParts.push(cleanDeckText(a, 0));
    const items = Array.isArray(s.items) ? s.items : [];
    for (const it of items) {
      textParts.push(
        cleanDeckText(it && it.title, 0),
        cleanDeckText(it && (it.desc || it.text || it.body), 0),
      );
    }
  }
  const joined = textParts.filter(Boolean).join(" ");

  const hasDecisionBoard = slides.some((s) => {
    const layoutId = String((s && s.layoutId) || "").toLowerCase();
    const title = String((s && s.title) || "");
    const label = String((s && s.label) || "");
    return (
      layoutId === "four_points" ||
      /决策事项|行动项|下一步决策|管理决策/.test(`${title} ${label}`)
    );
  });
  const hasObjective = /目标|指标|收益|成本|roi|转化|达成/i.test(joined);
  const hasQuant =
    /\d+(\.\d+)?\s*(%|万元|元|天|周|月|季度|年|人|个|倍)/i.test(joined) ||
    /\broi\b/i.test(joined);
  const hasPlan = /方案|路径|策略|试点|推进|落地|执行/i.test(joined);
  const hasRisk = /风险|问题反思|兜底|边界|不确定|假设/i.test(joined);
  const hasOwner = /责任人|负责人|owner/i.test(joined);
  const hasTimeline =
    /第\s*\d+\s*阶段|里程碑|本周|下周|本月|季度|时间|截止|deadline|\bm\d\b/i.test(
      joined,
    );

  if (!hasDecisionBoard)
    errors.push({
      slideIndex: 0,
      type: "decisionCompleteness",
      text: "missing_decision_board",
    });
  if (!hasObjective)
    errors.push({
      slideIndex: 0,
      type: "decisionCompleteness",
      text: "missing_objective_or_metric",
    });
  if (!hasQuant)
    errors.push({
      slideIndex: 0,
      type: "decisionCompleteness",
      text: "missing_quant_target",
    });
  if (!hasPlan)
    errors.push({
      slideIndex: 0,
      type: "decisionCompleteness",
      text: "missing_plan_or_execution_path",
    });
  if (!hasRisk)
    errors.push({
      slideIndex: 0,
      type: "decisionCompleteness",
      text: "missing_risk_boundary",
    });
  if (!hasOwner)
    errors.push({
      slideIndex: 0,
      type: "decisionCompleteness",
      text: "missing_owner",
    });
  if (!hasTimeline)
    errors.push({
      slideIndex: 0,
      type: "decisionCompleteness",
      text: "missing_timeline",
    });

  return errors;
}

function validateDeck(contract, exportedTextDump = null) {
  const errors = [];
  const warnings = [];
  const seenTitle = [];
  const seenBody = new Set();
  const slides = Array.isArray(contract && contract.slides)
    ? contract.slides
    : [];
  const slideScripts = Array.isArray(contract && contract.slideScripts)
    ? contract.slideScripts
    : [];
  const topic = cleanDeckText(contract && contract.topic, 120).toLowerCase();
  const scenario = String(
    (contract && (contract.scenario || contract.sceneType)) || "",
  ).toLowerCase();
  const textBudget = {
    cover: { maxBlocks: 4, maxChars: 80 },
    section: { maxBlocks: 4, maxChars: 70 },
    content_text: { maxBlocks: 5, maxChars: 210 },
    content_bullets: { maxBlocks: 6, maxChars: 180 },
    thanks: { maxBlocks: 4, maxChars: 60 },
  };
  const scenarioForbidden = {
    proposal: [
      /课堂抓手/i,
      /学生/i,
      /例题/i,
      /本课/i,
      /教学目标/i,
      /复习/i,
      /练习题/i,
    ],
    business_report: [
      /课堂抓手/i,
      /学生/i,
      /例题/i,
      /本课/i,
      /教学目标/i,
      /复习/i,
      /练习题/i,
    ],
    teaching: [/降本增效方案/i, /试点预算/i, /客户满意度/i],
    training: [],
  };

  slides.forEach((s, i) => {
    const idx = i + 1;
    const title = String((s && s.title) || "").trim();
    const layoutId = String((s && s.layoutId) || "").toLowerCase();
    const scriptType = normalizeScriptType(
      (s && s.scriptType) ||
        (s && s.slideType) ||
        (slideScripts[i] && slideScripts[i].type) ||
        "",
      idx,
    );
    const legacyType = normalizeSlideType((s && s.slideType) || "", idx);
    if (!title)
      errors.push({ slideIndex: idx, type: "missingTitle", text: "" });
    if (/[\(（]?v\s*\d+(?:\.\d+)?[\)）]?$/i.test(title)) {
      errors.push({
        slideIndex: idx,
        type: "titlePollution",
        text: "version_suffix_detected",
      });
    }
    if (!SLIDE_TYPES.includes(scriptType))
      errors.push({
        slideIndex: idx,
        type: "unknownSlideType",
        text: String(scriptType || ""),
      });
    if (!SLIDE_TYPE_ENUM.includes(legacyType))
      errors.push({
        slideIndex: idx,
        type: "unknownLegacySlideType",
        text: String(legacyType || ""),
      });

    if (title) {
      if (seenTitle.some((x) => isDuplicateTitle(x, title))) {
        errors.push({
          slideIndex: idx,
          type: "duplicateSlideTitles",
          text: title,
        });
      }
      seenTitle.push(title);
    }

    const bullets = Array.isArray(s && s.bullets) ? s.bullets : [];
    const bodyText = cleanDeckText((s && s.goal) || "", 0);
    const fields = [
      s && s.title,
      s && s.subtitle,
      bodyText,
      ...(bullets || []),
      s && s.notes,
      s && s.footer,
      s && s.date,
    ]
      .map((x) => sanitizeContractText(x || "", 0))
      .filter(Boolean);
    const fieldBlob = fields.join(" ");

    const normalizedTitle = normalizeTitle(title);
    const duplicateTitleMatches = fields.filter(
      (x) => normalizeTitle(x) === normalizedTitle,
    );
    const duplicateTitleInSlideCount = duplicateTitleMatches.length;
    const subtitleNormalized = normalizeTitle(String((s && s.subtitle) || ""));
    const isCoverSubtitleEcho =
      scriptType === "cover" &&
      duplicateTitleInSlideCount === 2 &&
      subtitleNormalized &&
      subtitleNormalized === normalizedTitle;
    if (title && duplicateTitleInSlideCount > 1 && !isCoverSubtitleEcho) {
      errors.push({
        slideIndex: idx,
        type: "duplicateTitleInSlide",
        text: title,
      });
    }

    const missingRequiredSlots = Array.isArray(s && s.missingRequiredSlots)
      ? s.missingRequiredSlots
      : [];
    if (missingRequiredSlots.length > 0) {
      errors.push({
        slideIndex: idx,
        type: "missingRequiredSlots",
        text: missingRequiredSlots.join(","),
      });
    }

    if (
      fields.some(
        (x) => isTemplatePlaceholderText(x) || hasForbiddenTemplateText(x),
      )
    ) {
      errors.push({
        slideIndex: idx,
        type: "forbiddenText",
        text: String(
          fields.find(
            (x) => isTemplatePlaceholderText(x) || hasForbiddenTemplateText(x),
          ) || "",
        ),
      });
    }
    if (fields.some((x) => STALE_MOCK_PATTERNS.some((p) => p.test(x)))) {
      errors.push({
        slideIndex: idx,
        type: "staleMockData",
        text: String(
          fields.find((x) => STALE_MOCK_PATTERNS.some((p) => p.test(x))) || "",
        ),
      });
    }
    if (
      topic &&
      !/牛顿第二定律|牛顿第一定律|f\s*=\s*ma/.test(topic) &&
      fields.some((x) => CROSS_TOPIC_LEAK_TERMS.some((p) => p.test(x)))
    ) {
      errors.push({
        slideIndex: idx,
        type: "crossTopicLeak",
        text: String(
          fields.find((x) => CROSS_TOPIC_LEAK_TERMS.some((p) => p.test(x))) ||
            "",
        ),
      });
    }
    if (
      SCENARIO_LEAK_PATTERNS[scenario] &&
      fields.some((x) =>
        SCENARIO_LEAK_PATTERNS[scenario].some((p) => p.test(x)),
      )
    ) {
      errors.push({
        slideIndex: idx,
        type: "mixedScenario",
        text: String(
          fields.find((x) =>
            SCENARIO_LEAK_PATTERNS[scenario].some((p) => p.test(x)),
          ) || "",
        ),
      });
    }
    if (fields.some((x) => /(结论：|证据：|行动：)/.test(x))) {
      errors.push({
        slideIndex: idx,
        type: "mechanicalLanguage",
        text: String(
          fields.find((x) => /(结论：|证据：|行动：)/.test(x)) || "",
        ),
      });
    }

    if (layoutId === "four_points") {
      const items = Array.isArray(s && s.items) ? s.items : [];
      if (items.length !== 4) {
        errors.push({
          slideIndex: idx,
          type: "fourPointsInvalid",
          text: `items_count_${items.length}`,
        });
      }
      const seenItems = new Set();
      const itemLens = [];
      for (let k = 0; k < items.length; k += 1) {
        const it = items[k] || {};
        const itTitle = cleanDeckText(it.title || "", 0);
        const itDesc = cleanDecisionDesc(it.desc || "", 40);
        if (!itTitle || /^输入标题$/i.test(itTitle))
          errors.push({
            slideIndex: idx,
            type: "fourPointsInvalid",
            text: `item_${k + 1}_title`,
          });
        if (!itDesc || itDesc.length < 10 || itDesc.length > 24)
          errors.push({
            slideIndex: idx,
            type: "fourPointsInvalid",
            text: `item_${k + 1}_desc`,
          });
        if (/(阶段|流程|里程碑)/.test(itDesc))
          errors.push({
            slideIndex: idx,
            type: "crossSlideLanguageLeak",
            text: `item_${k + 1}_stage_word`,
          });
        const key2 = `${itTitle}::${itDesc}`.toLowerCase();
        if (seenItems.has(key2))
          errors.push({
            slideIndex: idx,
            type: "fourPointsInvalid",
            text: `item_${k + 1}_duplicate`,
          });
        seenItems.add(key2);
        if (itDesc) itemLens.push(itDesc.length);
      }
      if (itemLens.length === 4) {
        const spread = Math.max(...itemLens) - Math.min(...itemLens);
        if (spread > 10)
          errors.push({
            slideIndex: idx,
            type: "fourPointsInvalid",
            text: `length_spread_${spread}`,
          });
      }
      const labelText = cleanDeckText(
        (s && s.slotPayload && s.slotPayload.label) || (s && s.subtitle) || "",
        0,
      );
      if (
        labelText &&
        bullets.some((b) => cleanDeckText(b, 0).startsWith(labelText))
      ) {
        errors.push({
          slideIndex: idx,
          type: "duplicateLabel",
          text: "label_repeated_in_items",
        });
      }
    }

    if (title.length > 22)
      errors.push({
        slideIndex: idx,
        type: "overlongText",
        text: `title:${title}`,
      });
    if (
      ["cover", "agenda", "section", "thanks"].includes(scriptType) &&
      String((s && s.subtitle) || "").length > 32
    ) {
      errors.push({
        slideIndex: idx,
        type: "overlongText",
        text: `subtitle:${String((s && s.subtitle) || "")}`,
      });
    }
    if (bullets.some((b) => String(b || "").length > 24))
      errors.push({
        slideIndex: idx,
        type: "overlongText",
        text: `bullet:${String(bullets.find((b) => String(b || "").length > 24) || "")}`,
      });
    if (bullets.length > 5)
      errors.push({
        slideIndex: idx,
        type: "overlongText",
        text: `bullets=${bullets.length}`,
      });

    if (scriptType === "section" && (bullets.length > 0 || bodyText)) {
      errors.push({
        slideIndex: idx,
        type: "mixedSlideTypes",
        text: "section_has_content",
      });
    }
    if (
      [
        "content_text",
        "content_bullets",
        "data_insight",
        "case_study",
        "compare",
        "process",
        "timeline",
        "example",
        "exercise",
      ].includes(scriptType)
    ) {
      if (bullets.length === 0 && !bodyText) {
        errors.push({
          slideIndex: idx,
          type: "blankSlide",
          text: "content_empty",
        });
      }
      if (/^\d{1,2}$/.test(title)) {
        errors.push({
          slideIndex: idx,
          type: "mixedSlideTypes",
          text: "content_title_is_section_no",
        });
      }
    }

    const bodyKey = `${title}::${bodyText}::${bullets.join("|")}`.toLowerCase();
    if (bodyText && seenBody.has(bodyKey)) {
      errors.push({ slideIndex: idx, type: "duplicateRender", text: title });
    }
    if (bodyText) seenBody.add(bodyKey);

    if (
      idx > 1 &&
      (scriptType === "content_text" ||
        scriptType === "content_bullets" ||
        scriptType === "data_insight" ||
        scriptType === "process" ||
        scriptType === "compare") &&
      (!fieldBlob || (bullets.length === 0 && bodyText.length < 20))
    ) {
      errors.push({
        slideIndex: idx,
        type: "blankOrHalfFilled",
        text: title || "",
      });
    }

    const visibleBlocks = [
      title,
      s && s.subtitle,
      bodyText,
      ...bullets,
      s && s.footer,
    ]
      .map((x) => sanitizeContractText(x || "", 0))
      .filter(Boolean);
    const visibleChars = visibleBlocks.join("").length;
    const budget =
      layoutId === "four_points"
        ? { maxBlocks: 9, maxChars: 260 }
        : textBudget[scriptType] || textBudget.content_text;
    if (
      visibleBlocks.length > Number(budget.maxBlocks || 5) ||
      visibleChars > Number(budget.maxChars || 220)
    ) {
      errors.push({
        slideIndex: idx,
        type: "textBudgetExceeded",
        text: `${visibleBlocks.length}/${visibleChars}`,
      });
    }

    const forbiddenPatterns = scenarioForbidden[scenario] || [];
    if (
      forbiddenPatterns.some((re) =>
        visibleBlocks.some((line) => re.test(line)),
      )
    ) {
      errors.push({
        slideIndex: idx,
        type: "scenarioVocabularyLeak",
        text: title || "",
      });
    }

    if (!cleanDeckText(s && s.footer, 0))
      warnings.push(`missing_footer_slide_${idx}`);
  });

  const decisionCompletenessErrors = validateDecisionToolCompleteness(contract);
  for (const err of decisionCompletenessErrors) errors.push(err);

  if (exportedTextDump && Array.isArray(exportedTextDump.slides)) {
    const inputCount = Number(
      exportedTextDump.inputSlideCount || slides.length || 0,
    );
    const outputCount = Number(exportedTextDump.outputSlideCount || 0);
    const physicalCount = Number(
      exportedTextDump.physicalSlideCount || outputCount || 0,
    );
    const visibleCount = Number(
      exportedTextDump.visibleSlideCount || outputCount || 0,
    );
    const hiddenCount = Number(exportedTextDump.hiddenSlideCount || 0);
    if (outputCount !== inputCount) {
      errors.push({
        slideIndex: 0,
        type: "slideCountMismatch",
        text: `input=${inputCount},output=${outputCount}`,
      });
    }
    if (physicalCount !== inputCount) {
      errors.push({
        slideIndex: 0,
        type: "slideCountMismatch",
        text: `input=${inputCount},physical=${physicalCount}`,
      });
    }
    if (visibleCount !== inputCount) {
      errors.push({
        slideIndex: 0,
        type: "slideCountMismatch",
        text: `input=${inputCount},visible=${visibleCount}`,
      });
    }
    if (hiddenCount !== 0) {
      errors.push({
        slideIndex: 0,
        type: "hiddenSlideDetected",
        text: `hidden=${hiddenCount}`,
      });
    }
    if (outputCount < 8 || outputCount > 12) {
      errors.push({
        slideIndex: 0,
        type: "pageCountMismatch",
        text: `output=${outputCount}`,
      });
    }
    if (outputCount > inputCount) {
      errors.push({
        slideIndex: 0,
        type: "orphanTemplatePages",
        text: `input=${inputCount},output=${outputCount}`,
      });
    }

    const indexes = exportedTextDump.slides
      .map((row) => Number(row && row.index) || 0)
      .filter((n) => n > 0);
    for (let i = 0; i < indexes.length; i += 1) {
      if (indexes[i] !== i + 1) {
        errors.push({
          slideIndex: 0,
          type: "nonContinuousSlideIndex",
          text: `at=${i + 1},got=${indexes[i]}`,
        });
        break;
      }
    }

    for (const row of exportedTextDump.slides) {
      const idx = Number(row && row.index) || 0;
      const texts = Array.isArray(row && row.texts)
        ? row.texts.map((x) => cleanDeckText(x, 0)).filter(Boolean)
        : [];
      const nonPlaceholder = texts.filter((t) => !isTemplatePlaceholderText(t));
      const semanticTexts = nonPlaceholder.filter((t) => !isMetaText(t));
      const title = String((row && row.title) || "").trim();
      const plan = slides[idx - 1] || {};
      const planType = normalizeScriptType(
        (plan && plan.scriptType) || (plan && plan.slideType) || "",
        idx,
      );
      const planLayoutId = String((plan && plan.layoutId) || "").toLowerCase();
      const titleIndex = title
        ? semanticTexts.findIndex(
            (t) =>
              isDuplicateTitle(t, title) ||
              t.includes(title) ||
              title.includes(t),
          )
        : -1;

      if (
        title &&
        [
          "content_text",
          "content_bullets",
          "data_insight",
          "process",
          "compare",
          "case_study",
        ].includes(planType) &&
        titleIndex > 2
      ) {
        errors.push({
          slideIndex: idx,
          type: "slotOrder",
          text: "title_after_body",
        });
      }

      if (
        title &&
        [
          "content_text",
          "content_bullets",
          "data_insight",
          "process",
          "compare",
          "case_study",
        ].includes(planType) &&
        semanticTexts.some(
          (t) => t.length > 12 && t !== title && isDuplicateTitle(t, title),
        )
      ) {
        errors.push({
          slideIndex: idx,
          type: "slotOrder",
          text: "title_written_to_body",
        });
      }

      if (planLayoutId === "four_points") {
        const candidateItems = nonPlaceholder
          .map((t) => cleanDeckText(t, 0))
          .filter(
            (t) =>
              t && t !== title && !/^\d+$/.test(t) && !/^管理决策$/i.test(t),
          );
        const normalizedItems = Array.from(new Set(candidateItems));
        if (normalizedItems.length < 4) {
          errors.push({
            slideIndex: idx,
            type: "fourPointsRenderIncomplete",
            text: `items_rendered_${normalizedItems.length}`,
          });
        }
      }

      if (
        texts.some(
          (t) => isTemplatePlaceholderText(t) || hasForbiddenTemplateText(t),
        )
      ) {
        errors.push({
          slideIndex: idx,
          type: "templateLeakage",
          text:
            texts.find(
              (t) =>
                isTemplatePlaceholderText(t) || hasForbiddenTemplateText(t),
            ) || "",
        });
      }
      if (texts.some((t) => STALE_MOCK_PATTERNS.some((p) => p.test(t)))) {
        errors.push({
          slideIndex: idx,
          type: "staleMockData",
          text:
            texts.find((t) => STALE_MOCK_PATTERNS.some((p) => p.test(t))) || "",
        });
      }
      if (
        topic &&
        !/牛顿第二定律|牛顿第一定律|f\s*=\s*ma/.test(topic) &&
        texts.some((t) => CROSS_TOPIC_LEAK_TERMS.some((p) => p.test(t)))
      ) {
        errors.push({
          slideIndex: idx,
          type: "crossTopicLeak",
          text:
            texts.find((t) => CROSS_TOPIC_LEAK_TERMS.some((p) => p.test(t))) ||
            "",
        });
      }
      if (
        SCENARIO_LEAK_PATTERNS[scenario] &&
        texts.some((t) =>
          SCENARIO_LEAK_PATTERNS[scenario].some((p) => p.test(t)),
        )
      ) {
        errors.push({
          slideIndex: idx,
          type: "mixedScenario",
          text:
            texts.find((t) =>
              SCENARIO_LEAK_PATTERNS[scenario].some((p) => p.test(t)),
            ) || "",
        });
      }
      if (texts.some((t) => /(结论：|证据：|行动：)/.test(t))) {
        errors.push({
          slideIndex: idx,
          type: "mechanicalLanguage",
          text: texts.find((t) => /(结论：|证据：|行动：)/.test(t)) || "",
        });
      }

      if (texts.some((t) => (t.match(/•/g) || []).length >= 2)) {
        errors.push({
          slideIndex: idx,
          type: "bulletFormat",
          text: texts.find((t) => (t.match(/•/g) || []).length >= 2) || "",
        });
      }

      const phraseCount = new Map();
      for (const t of nonPlaceholder) {
        const key = String(t || "")
          .replace(/\s+/g, "")
          .slice(0, 28)
          .toLowerCase();
        if (!key) continue;
        phraseCount.set(key, (phraseCount.get(key) || 0) + 1);
      }
      const repeated = Array.from(phraseCount.entries()).find(([, n]) => n > 2);
      if (repeated) {
        errors.push({
          slideIndex: idx,
          type: "repeatedTextInSlide",
          text: repeated[0],
        });
      }

      const joined = semanticTexts.join(" ");
      const hasPartToken = /\bPART\s*0?\d+\b/i.test(joined);
      if (planType !== "section" && hasPartToken) {
        errors.push({
          slideIndex: idx,
          type: "mixedLayout",
          text: "part_token_in_non_section",
        });
      }
      if (planType === "section") {
        const sectionPayload = semanticTexts
          .filter((t) => !isDuplicateTitle(t, title))
          .filter((t) => !/^part\s*\d+$/i.test(t))
          .filter((t) => !isSectionScaffoldText(t));
        const bodyChars = sectionPayload.join("").replace(/\s+/g, "").length;
        if (bodyChars > 140) {
          errors.push({
            slideIndex: idx,
            type: "mixedLayout",
            text: "section_body_too_long",
          });
        }
      }
      if (nonPlaceholder.length === 0) {
        errors.push({ slideIndex: idx, type: "blankSlide", text: "" });
      }

      const dupeInSlide = nonPlaceholder.filter((t) =>
        isDuplicateTitle(t, title),
      ).length;
      const inSlideType = normalizeScriptType(
        (slides[idx - 1] && slides[idx - 1].scriptType) || "",
        idx,
      );
      if (
        title &&
        dupeInSlide > 3 &&
        inSlideType !== "section" &&
        inSlideType !== "cover"
      ) {
        errors.push({
          slideIndex: idx,
          type: "duplicateTitleInSlide",
          text: title,
        });
      }

      if (nonPlaceholder.some((t) => t.length > 150)) {
        errors.push({
          slideIndex: idx,
          type: "overlongText",
          text: nonPlaceholder.find((t) => t.length > 150) || "",
        });
      }
      if (nonPlaceholder.length <= 1) {
        const planned = slides[idx - 1] || {};
        const plannedType = normalizeScriptType(
          (planned && planned.scriptType) ||
            (planned && planned.slideType) ||
            "",
          idx,
        );
        const plannedBody = cleanDeckText((planned && planned.goal) || "", 0);
        const plannedBullets = Array.isArray(planned && planned.bullets)
          ? planned.bullets.filter(Boolean)
          : [];
        const needsDenseContent =
          idx > 1 &&
          [
            "content_text",
            "content_bullets",
            "data_insight",
            "process",
            "compare",
            "case_study",
          ].includes(plannedType);
        const canTrustSource =
          ["content_text", "content_bullets"].includes(plannedType) &&
          (plannedBody.length >= 60 || plannedBullets.length >= 3);
        if (
          needsDenseContent &&
          !canTrustSource &&
          nonPlaceholder.length <= 1
        ) {
          errors.push({
            slideIndex: idx,
            type: "blankOrHalfFilled",
            text: String((row && row.title) || ""),
          });
        }
      }
    }

    slides.forEach((s, i) => {
      const idx = i + 1;
      const sourceSlide =
        slideScripts[i] && typeof slideScripts[i] === "object"
          ? slideScripts[i]
          : s && typeof s === "object"
            ? s
            : {};
      const t = normalizeScriptType(
        (sourceSlide && sourceSlide.scriptType) ||
          (sourceSlide && sourceSlide.slideType) ||
          (sourceSlide && sourceSlide.type) ||
          "",
        idx,
      );
      const mins = validateMinimumEffectiveSlide(t, sourceSlide, idx);
      mins.forEach((e) => errors.push(e));
    });

    for (let i = 1; i < exportedTextDump.slides.length; i += 1) {
      const prev = exportedTextDump.slides[i - 1];
      const curr = exportedTextDump.slides[i];
      if (isDuplicateTitle(prev && prev.title, curr && curr.title)) {
        errors.push({
          slideIndex: Number(curr && curr.index) || i + 1,
          type: "duplicateSlideTitles",
          text: String((curr && curr.title) || ""),
        });
      }
    }
  }

  const issueSet = new Set(
    errors.map((e) => `${e.type}_slide_${e.slideIndex}`),
  );
  return {
    ok: errors.length === 0,
    pass: errors.length === 0,
    errors,
    issues: Array.from(issueSet),
    warnings,
  };
}

function extractHeadings(text) {
  const lines = normalizeText(text).split("\n");
  const headingCandidates = lines.filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^#{1,6}\s+/.test(t)) return true;
    if (/^[一二三四五六七八九十0-9]+[、.)）]\s*/.test(t)) return true;
    if (/^chapter\s+\d+/i.test(t)) return true;
    return false;
  });
  return headingCandidates.slice(0, 18);
}

function topKeywords(text, limit = 16) {
  const tokens = normalizeText(text)
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w.length >= 2);

  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "have",
    "will",
    "into",
    "you",
    "your",
    "http",
    "https",
    "www",
    "com",
    "的",
    "了",
    "和",
    "是",
    "在",
    "与",
    "以及",
    "一个",
    "进行",
    "可以",
  ]);
  const counts = new Map();
  for (const token of tokens) {
    if (stop.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function buildIngestorPack({ userInput, fileContexts }) {
  const merged = normalizeText(fileContexts.join("\n\n"));
  const clipped =
    merged.length > 18000
      ? `${merged.slice(0, 18000)}\n...[context truncated]`
      : merged;
  const headings = extractHeadings(clipped);
  const keywords = topKeywords(clipped, 16);
  const lines = clipped.split("\n").filter((line) => line.trim());
  const keySnippets = lines.filter((line) => line.length >= 20).slice(0, 12);

  return {
    intentRaw: normalizeText(userInput),
    contextStats: {
      fileCount: fileContexts.length,
      contextChars: clipped.length,
      headingCount: headings.length,
    },
    headings,
    keywords,
    keySnippets,
    contextBody: clipped,
  };
}

function extractFirstJsonObject(text) {
  const raw = normalizeText(text);
  if (!raw) return null;

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw;

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace)
    return null;

  return candidate.slice(firstBrace, lastBrace + 1);
}

function validateCompiledJson(parsed) {
  const requiredString = [
    "goal",
    "audience",
    "style",
    "contextSummary",
    "finalPrompt",
  ];
  const requiredArray = ["constraints", "successCriteria", "checklist"];

  for (const key of requiredString) {
    if (!parsed || typeof parsed[key] !== "string" || !parsed[key].trim()) {
      return { ok: false, reason: `missing_or_invalid_${key}` };
    }
  }

  for (const key of requiredArray) {
    if (!parsed || !Array.isArray(parsed[key]) || parsed[key].length === 0) {
      return { ok: false, reason: `missing_or_invalid_${key}` };
    }
  }

  return { ok: true };
}

function describeUpstreamError(error) {
  const cause = error && error.cause ? error.cause : {};
  const code = cause.code || error.code || "UNKNOWN";
  const message =
    cause.message || (error && error.message ? error.message : String(error));
  return `upstream_connect_error(${code}): ${message}`;
}

function sanitizeFileName(name) {
  const base = String(name || "daymori-ppt").trim();
  const safe = base
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return safe || "daymori-ppt";
}

function createRequestContext(req, contractInput = null) {
  const requestId = String((req && req.requestId) || crypto.randomUUID());
  const exportDir = path.join(
    __dirname,
    "docs",
    "benchmarks",
    "results",
    "exports",
    requestId,
  );
  const debugDir = path.join(
    __dirname,
    "docs",
    "benchmarks",
    "results",
    "debug",
    requestId,
  );
  fs.mkdirSync(exportDir, { recursive: true });
  fs.mkdirSync(debugDir, { recursive: true });
  if (contractInput) {
    try {
      fs.writeFileSync(
        path.join(debugDir, "input.json"),
        JSON.stringify(contractInput, null, 2),
        "utf8",
      );
    } catch {}
  }
  return { requestId, exportDir, debugDir };
}

function writeDebugJson(requestContext, name, payload) {
  if (!requestContext || !requestContext.debugDir) return "";
  try {
    const filePath = path.join(requestContext.debugDir, name);
    fs.writeFileSync(filePath, JSON.stringify(payload || {}, null, 2), "utf8");
    return path.relative(__dirname, filePath).replace(/\\/g, "/");
  } catch {
    return "";
  }
}

function ensureDirSafe(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {}
}

function readJsonFileSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function ensureGoldenSamplesFile() {
  ensureDirSafe(TRAINING_DIR);
  if (fs.existsSync(GOLDEN_SAMPLES_PATH)) return;
  const seed = [
    {
      slideType: "cover",
      example: {
        title: "AI客服降本增效方案",
        subtitle: "从高频服务场景切入，验证自动化降本路径",
        metadata: { source: "", pageNumber: "" },
      },
      rules: [
        "标题5-20字，不含版本号",
        "副标题15-40字，说明业务定位",
        "元数据仅出现在页脚，不混入标题",
      ],
    },
    {
      slideType: "four_points",
      example: {
        title: "下一步决策事项",
        items: [
          { label: "试点范围", desc: "明确首批渠道与服务场景" },
          { label: "预算边界", desc: "确认工具、人力和集成成本" },
          { label: "系统接入", desc: "打通客服、工单和知识库系统" },
          { label: "责任机制", desc: "指定业务、技术和运营负责人" },
        ],
      },
      rules: [
        "必须恰好4条，每条含label和desc",
        "label 4-6字，desc 12-20字",
        "4条内容不重复、不交叉",
      ],
    },
  ];
  try {
    fs.writeFileSync(
      GOLDEN_SAMPLES_PATH,
      JSON.stringify(seed, null, 2),
      "utf8",
    );
  } catch {}
}

function readBadSamples(limit = 40) {
  ensureDirSafe(TRAINING_DIR);
  if (!fs.existsSync(BAD_SAMPLES_PATH)) return [];
  try {
    const lines = fs
      .readFileSync(BAD_SAMPLES_PATH, "utf8")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") rows.push(parsed);
      } catch {}
    }
    return rows.slice(
      Math.max(0, rows.length - Math.max(1, Number(limit) || 40)),
    );
  } catch {
    return [];
  }
}

function buildNegativeExamplesBlock(badSamples) {
  const rows = Array.isArray(badSamples) ? badSamples.slice(-24) : [];
  if (!rows.length) return "";

  const seen = new Set();
  const compact = [];
  for (const row of rows) {
    const err = cleanDeckText(row && row.error, 64) || "unknown_error";
    const bad = cleanDeckText(row && row.bad, 64) || "(空)";
    const good = cleanDeckText(row && row.good, 64) || "(请按语义纠正)";
    const key = `${err}|${bad}|${good}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compact.push({ err, bad, good });
    if (compact.length >= 6) break;
  }

  if (!compact.length) return "";
  const lines = ["以下是必须避免的错误示例："];
  for (const row of compact) {
    lines.push(`❌ ${row.err}: ${row.bad}`);
    lines.push(`✅ ${row.good}`);
  }
  lines.push("请避免以上错误模式，仅输出合同要求内容。\n");
  return lines.join("\n");
}

function buildPositiveExamplesBlock(goldenSamples) {
  const samples = Array.isArray(goldenSamples) ? goldenSamples : [];
  if (!samples.length) return "";

  const lines = [
    "以下是优秀差异化示例（请参考角度，生成独特内容，禁止照抄）：\n",
  ];

  for (const sample of samples) {
    const variants = Array.isArray(sample && sample.variants)
      ? sample.variants
      : [];
    if (!variants.length) continue;

    const slideType =
      cleanDeckText(sample && sample.slideType, 40) || "content";
    lines.push(`\n【${slideType} 的 ${variants.length} 种业务视角】`);

    variants.forEach((v, idx) => {
      const context =
        cleanDeckText((v && (v.context || v.angle || v.focus)) || "", 20) ||
        `视角${idx + 1}`;
      const bodyPreview = cleanDeckText((v && v.body) || "", 80);
      const bulletsPreview = Array.isArray(v && v.bullets)
        ? v.bullets
            .slice(0, 2)
            .map((b) => cleanDeckText(b, 40))
            .join("；")
        : "";
      const itemPreview = cleanDeckText(
        (v && Array.isArray(v.items) && v.items[0] && v.items[0].desc) || "",
        80,
      );
      const preview =
        bodyPreview ||
        bulletsPreview ||
        itemPreview ||
        cleanDeckText((v && v.subtitle) || "", 80);
      if (preview) lines.push(`  ${idx + 1}. 【${context}】${preview}...`);
    });
  }

  lines.push(
    "\n✅ 请从不同业务视角生成内容，确保每个变体有独特价值。不要复用同一句式。",
  );
  lines.push('❌ 禁止重复使用"目标达成、资源配置、执行路径"等通用套话。\n');
  return lines.join("\n");
}

function buildDiversityHint(contract) {
  const angles = [
    "roi",
    "risk",
    "tech",
    "process",
    "experience",
    "cost",
    "compliance",
    "scalability",
    "timeline",
    "stakeholder",
  ];
  const hints = {
    roi: "强调投入产出比、成本下降、收益验证",
    risk: "强调风险边界、兜底机制、灰度试点",
    tech: "强调技术选型、接口对接、模型迭代",
    process: "强调流程标准化、协同效率、复盘改进",
    experience: "强调用户体验、触点优化、满意度提升",
    cost: "强调成本结构、人力优化、峰值调度",
    compliance: "强调合规要求、审计追溯、风控流程",
    scalability: "强调扩展性、模块化、长期演进",
    timeline: "强调里程碑、交付节奏、资源协调",
    stakeholder: "强调干系人对齐、决策机制、责任划分",
  };
  const rawIndex = Number(
    contract && (contract.runIndex ?? contract.seed ?? 0),
  );
  const runIndex = Number.isFinite(rawIndex) ? rawIndex : 0;
  const angle = angles[Math.abs(runIndex) % angles.length] || "roi";
  return {
    angle,
    runIndex,
    instruction: `本次生成聚焦【${angle}】视角：${hints[angle]}。避免通用套话，给出该视角下的具体判断和行动。`,
  };
}

function applyFeedbackConstraintsToContract(contract) {
  if (!contract || typeof contract !== "object") return;
  ensureDirSafe(PROMPTS_DIR);
  ensureGoldenSamplesFile();
  ensureDirSafe(TRAINING_DIR);
  if (!fs.existsSync(BAD_SAMPLES_PATH)) {
    try {
      fs.writeFileSync(BAD_SAMPLES_PATH, "", "utf8");
    } catch {}
  }

  const badSamples = readBadSamples(40);
  const negativeBlock = buildNegativeExamplesBlock(badSamples);
  const goldenSamples = readJsonFileSafe(GOLDEN_SAMPLES_PATH, []);
  const positiveBlock = buildPositiveExamplesBlock(goldenSamples);
  const diversityHint = buildDiversityHint(contract);
  const diversityBlock =
    diversityHint && diversityHint.instruction
      ? `【差异化视角约束】\n${diversityHint.instruction}`
      : "";
  const quantKpiBlock =
    "【量化指标硬约束】\n每页必须至少包含1个可验证的量化指标，并带单位（例如：12%、50万元、3周、Q3、120人、2倍）。禁止只写抽象目标，不给数字。";
  const promptVersion =
    cleanDeckText(contract.promptVersion || "v1_observable_baseline", 64) ||
    "v1_observable_baseline";

  const promptSource = [
    `promptVersion=${promptVersion}`,
    JSON.stringify(goldenSamples || []),
    diversityBlock,
    quantKpiBlock,
    negativeBlock,
    positiveBlock,
    JSON.stringify({
      topic: contract.topic || "",
      pageCount: contract.pageCount || 0,
    }),
  ].join("\n");
  const promptHash = crypto
    .createHash("sha256")
    .update(promptSource)
    .digest("hex");

  contract.promptVersion = promptVersion;
  contract.promptHash = promptHash;
  contract.promptHints = {
    negativeExamples: negativeBlock,
    positiveExamples: positiveBlock,
    diversity: diversityHint,
    goldenSamples,
    loadedBadSamples: Array.isArray(badSamples) ? badSamples.length : 0,
  };

  if (Array.isArray(contract.slideScripts)) {
    contract.slideScripts = contract.slideScripts.map((s, i) => {
      const copy = s && typeof s === "object" ? { ...s } : { id: `s${i + 1}` };
      const basePrompt = cleanDeckText(
        copy.generationPrompt || `生成第${i + 1}页内容：${copy.title || ""}`,
        800,
      );
      const injectedBlocks = [
        diversityBlock,
        quantKpiBlock,
        positiveBlock,
        negativeBlock,
      ]
        .filter(Boolean)
        .join("\n\n");
      copy.generationPrompt = injectedBlocks
        ? `${basePrompt}\n\n${injectedBlocks}`
        : basePrompt;
      return copy;
    });
  }
}

function mapErrorToBadSample(contract, errorItem) {
  const slideIndex = Number(errorItem && errorItem.slideIndex) || 0;
  const slide =
    Array.isArray(contract && contract.slides) && slideIndex > 0
      ? contract.slides[slideIndex - 1]
      : null;
  const errorType = cleanDeckText(errorItem && errorItem.type, 64) || "unknown";
  const slideBullets = Array.isArray(slide && slide.bullets)
    ? slide.bullets.join("；")
    : "";
  const badText =
    cleanDeckText(
      (slide &&
        (slide.goal ||
          slide.body ||
          slide.summary ||
          slideBullets ||
          slide.title)) ||
        (errorItem && errorItem.text) ||
        "",
      180,
    ) || "(empty)";
  let goodText = "按模板槽位重写，确保信息密度和可读性";
  if (/repetition|duplicate/i.test(errorType))
    goodText = "从不同业务视角改写，避免复用相同句式和关键词";
  else if (/blank|empty/i.test(errorType))
    goodText = "补齐至少60字业务说明，包含场景、动作、指标";
  else if (/mechanical/i.test(errorType))
    goodText = "去除机械前缀，保持自然业务表达";
  else if (/title|metadata|version/i.test(errorType))
    goodText = "标题仅保留主题，不含版本号、页码、来源信息";
  else if (/qualityscore/i.test(errorType))
    goodText = "优先清零 BLOCKER，再提升模板匹配与可读性";
  return {
    slide: slideIndex,
    error: errorType,
    bad: badText,
    good: goodText,
    timestamp: new Date().toISOString(),
    topic: cleanDeckText(contract && contract.topic, 120),
    requestId: cleanDeckText(contract && contract.requestId, 80),
  };
}

function appendBadSamples(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  if (!rows.length) return 0;
  ensureDirSafe(TRAINING_DIR);
  const lines = rows
    .map((x) => {
      try {
        return JSON.stringify(x);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  if (!lines.length) return 0;
  try {
    fs.appendFileSync(BAD_SAMPLES_PATH, `${lines.join("\n")}\n`, "utf8");
    return lines.length;
  } catch {
    return 0;
  }
}

function buildGenerationTracePayload(params) {
  const {
    contract,
    requestContext,
    saved,
    result,
    postCheck,
    elapsedMs,
    exportConfig,
  } = params || {};
  const deckValidation =
    postCheck && postCheck.deckValidation
      ? postCheck.deckValidation
      : { errors: [] };
  const errors = Array.isArray(deckValidation.errors)
    ? deckValidation.errors
    : [];
  const scripts = Array.isArray(contract && contract.slideScripts)
    ? contract.slideScripts
    : [];
  const slides = Array.isArray(contract && contract.slides)
    ? contract.slides
    : [];
  const llmCalls = scripts.map((s, i) => {
    const idx = i + 1;
    const itemErrors = errors.filter((e) => Number(e && e.slideIndex) === idx);
    const responseSlide = slides[i] || {};
    return {
      slideIndex: idx,
      prompt:
        cleanDeckText(s && s.generationPrompt, 2400) || `生成第${idx}页内容`,
      response: {
        title: cleanDeckText(responseSlide.title, 120),
        subtitle: cleanDeckText(responseSlide.subtitle, 200),
        bullets: Array.isArray(responseSlide.bullets)
          ? responseSlide.bullets
          : [],
        items: Array.isArray(responseSlide.items) ? responseSlide.items : [],
      },
      validationResult: {
        passed: itemErrors.length === 0,
        errors: itemErrors.map((e) =>
          cleanDeckText(`${e.type}:${e.text || ""}`, 180),
        ),
      },
    };
  });

  if (result && result.llmTrace) {
    llmCalls.unshift({
      slideIndex: 0,
      prompt: result.llmTrace.prompt || "",
      response: result.llmTrace.response || {},
      validationResult: { passed: true, errors: [] },
    });
  }

  return {
    timestamp: new Date().toISOString(),
    requestId:
      requestContext && requestContext.requestId
        ? requestContext.requestId
        : "",
    version: cleanDeckText(
      (contract && contract.version) || (contract && contract.requestId) || "",
      64,
    ),
    promptVersion: cleanDeckText(contract && contract.promptVersion, 64),
    promptHash: cleanDeckText(contract && contract.promptHash, 80),
    input: {
      theme: cleanDeckText(contract && contract.topic, 160),
      targetSlides: Number(contract && contract.pageCount) || 0,
      styleGuide: cleanDeckText(contract && contract.visualStyle, 80),
      scenario: cleanDeckText(contract && contract.sceneType, 40),
      templateFileName: cleanDeckText(
        contract && contract.templateFileName,
        120,
      ),
    },
    llmProvider: {
      aipptProvider: cleanDeckText(exportConfig && exportConfig.provider, 40),
      endpoint: cleanDeckText(exportConfig && exportConfig.endpoint, 180),
      model: cleanDeckText(exportConfig && exportConfig.model, 80),
    },
    llmCalls,
    output: {
      filePath: saved && saved.relPath ? saved.relPath : "",
      qualityScore:
        postCheck && postCheck.qualityScore ? postCheck.qualityScore : null,
      failedChecks: errors
        .map((e) => cleanDeckText(e && e.type, 64))
        .filter(Boolean),
      elapsedMs: Number(elapsedMs) || 0,
    },
  };
}

function writeGenerationTraceFile(requestContext, tracePayload) {
  if (!requestContext || !requestContext.debugDir) return "";
  try {
    const absPath = path.join(requestContext.debugDir, "generation_trace.json");
    fs.writeFileSync(
      absPath,
      JSON.stringify(tracePayload || {}, null, 2),
      "utf8",
    );
    return path.relative(__dirname, absPath).replace(/\\/g, "/");
  } catch {
    return "";
  }
}

function computeQualityScore(contract, textDump, deckValidation) {
  const errors = Array.isArray(deckValidation && deckValidation.errors)
    ? deckValidation.errors
    : [];
  const hasType = (type) =>
    errors.some((e) => String((e && e.type) || "") === type);
  const hasAny = (types) => types.some((t) => hasType(t));
  const slides = Array.isArray(textDump && textDump.slides)
    ? textDump.slides
    : [];
  const scripts = Array.isArray(contract && contract.slideScripts)
    ? contract.slideScripts
    : [];
  const scriptTypes = new Set(
    scripts.map((s) => normalizeScriptType(s && s.type, 1)),
  );

  const templateUsage = hasAny(["missingRequiredSlots", "unknownSlideType"])
    ? 70
    : 92;
  let visualCleanliness = hasAny([
    "textBudgetExceeded",
    "blankOrHalfFilled",
    "mechanicalLanguage",
  ])
    ? 72
    : 92;
  if (hasAny(["forbiddenText", "templateLeakage", "staleMockData"]))
    visualCleanliness = Math.min(visualCleanliness, 55);

  const specificityPenalty = hasAny([
    "staleMockData",
    "mechanicalLanguage",
    "duplicateTitleInSlide",
  ])
    ? 18
    : 0;
  const contentSpecificity = Math.max(50, 95 - specificityPenalty);

  const hasFlow =
    scriptTypes.has("cover") &&
    scriptTypes.has("section") &&
    (scriptTypes.has("content_text") || scriptTypes.has("content_bullets")) &&
    scriptTypes.has("thanks");
  const narrativeFlow = hasFlow ? 92 : 68;

  const scenarioFit = hasAny([
    "mixedScenario",
    "crossTopicLeak",
    "scenarioVocabularyLeak",
  ])
    ? 55
    : 96;
  const exportIntegrity = hasAny([
    "slideCountMismatch",
    "pageCountMismatch",
    "orphanTemplatePages",
    "nonContinuousSlideIndex",
  ])
    ? 0
    : 100;

  const overall = Math.round(
    templateUsage * 0.2 +
      visualCleanliness * 0.18 +
      contentSpecificity * 0.2 +
      narrativeFlow * 0.14 +
      scenarioFit * 0.14 +
      exportIntegrity * 0.14,
  );

  return {
    templateUsage,
    visualCleanliness,
    contentSpecificity,
    narrativeFlow,
    scenarioFit,
    exportIntegrity,
    overall,
    // backward-compatible fields
    cleanliness: visualCleanliness,
    structure: narrativeFlow,
    contentDepth: contentSpecificity,
    layoutConsistency: templateUsage,
    topicRelevance: scenarioFit,
  };
}

function getOfficeplusTemplateInboxDir() {
  return path.join(__dirname, "docs", "benchmarks", "templates", "inbox");
}

function getOfficeplusPickUrl() {
  const raw = String(process.env.OFFICEPLUS_PICK_URL || "").trim();
  return raw || "https://www.officeplus.cn/Template/Home.shtml";
}

function ensureOfficeplusTemplateInboxDir() {
  const dir = getOfficeplusTemplateInboxDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listInboxPptxFiles() {
  const dir = ensureOfficeplusTemplateInboxDir();
  const files = fs
    .readdirSync(dir)
    .map((name) => {
      const absPath = path.join(dir, name);
      const stat = fs.statSync(absPath);
      return { name, absPath, stat };
    })
    .filter((x) => x.stat && x.stat.isFile() && /\.pptx$/i.test(x.name));
  return files.sort(
    (a, b) => Number(b.stat.mtimeMs || 0) - Number(a.stat.mtimeMs || 0),
  );
}

function getLatestInboxPptxFile() {
  const files = listInboxPptxFiles();
  return files.length ? files[0] : null;
}

function escapePowerShellSingleQuoted(value) {
  return String(value || "").replace(/'/g, "''");
}

function buildPowerPointLaunchScript(officeplusUrl, inboxDir, options = {}) {
  const shouldOpenOfficeplus = options.openOfficeplus !== false;
  const shouldOpenInbox = options.openInbox !== false;
  const ppCandidates = [
    "powerpnt.exe",
    path.join(
      process.env.ProgramFiles || "",
      "Microsoft Office",
      "root",
      "Office16",
      "POWERPNT.EXE",
    ),
    path.join(
      process.env.ProgramFiles || "",
      "Microsoft Office",
      "Office16",
      "POWERPNT.EXE",
    ),
    path.join(
      process.env["ProgramFiles(x86)"] || "",
      "Microsoft Office",
      "root",
      "Office16",
      "POWERPNT.EXE",
    ),
    path.join(
      process.env["ProgramFiles(x86)"] || "",
      "Microsoft Office",
      "Office16",
      "POWERPNT.EXE",
    ),
  ].filter(Boolean);

  const candidateExpr = ppCandidates
    .map((x) => `'${escapePowerShellSingleQuoted(x)}'`)
    .join(", ");
  const safeUrl = escapePowerShellSingleQuoted(officeplusUrl);
  const safeInbox = escapePowerShellSingleQuoted(inboxDir);
  const openOfficeplusExpr = shouldOpenOfficeplus ? "$true" : "$false";
  const openInboxExpr = shouldOpenInbox ? "$true" : "$false";

  return [
    "$ErrorActionPreference = 'Stop'",
    "$result = [ordered]@{",
    "  powerPoint = [ordered]@{ ok = $false; mode = ''; detail = '' }",
    "  officeplus = [ordered]@{ ok = $false; detail = '' }",
    "  inbox = [ordered]@{ ok = $false; detail = '' }",
    "}",
    `$ppCandidates = @(${candidateExpr})`,
    "try {",
    "  $pp = New-Object -ComObject PowerPoint.Application",
    "  $pp.Visible = $true",
    "  if ($pp.Presentations.Count -eq 0) { $null = $pp.Presentations.Add($true) }",
    "  $result.powerPoint.ok = $true",
    "  $result.powerPoint.mode = 'com'",
    "  $result.powerPoint.detail = 'com-visible-presentation'",
    "} catch {",
    "  $result.powerPoint.detail = $_.Exception.Message",
    "}",
    "if (-not $result.powerPoint.ok) {",
    "  foreach ($candidate in $ppCandidates) {",
    "    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }",
    "    try {",
    "      $p = Start-Process -FilePath $candidate -PassThru",
    "      $result.powerPoint.ok = $true",
    "      $result.powerPoint.mode = 'process'",
    "      $result.powerPoint.detail = ('started:' + $p.Id + ':' + $candidate)",
    "      break",
    "    } catch {",
    "      continue",
    "    }",
    "  }",
    "}",
    "if (-not $result.powerPoint.ok) {",
    "  try {",
    "    $p2 = Start-Process -FilePath 'powerpnt.exe' -PassThru",
    "    $result.powerPoint.ok = $true",
    "    $result.powerPoint.mode = 'process-fallback'",
    "    $result.powerPoint.detail = ('started:' + $p2.Id + ':powerpnt.exe')",
    "  } catch {",
    "    if (-not $result.powerPoint.detail) { $result.powerPoint.detail = $_.Exception.Message }",
    "  }",
    "}",
    `if (${openOfficeplusExpr}) {`,
    "  try {",
    `    Start-Process -FilePath '${safeUrl}' | Out-Null`,
    "    $result.officeplus.ok = $true",
    "    $result.officeplus.detail = 'opened'",
    "  } catch {",
    "    $result.officeplus.detail = $_.Exception.Message",
    "  }",
    "} else {",
    "  $result.officeplus.ok = $true",
    "  $result.officeplus.detail = 'skipped'",
    "}",
    `if (${openInboxExpr}) {`,
    "  try {",
    `    Start-Process -FilePath explorer.exe -ArgumentList '${safeInbox}' | Out-Null`,
    "    $result.inbox.ok = $true",
    "    $result.inbox.detail = 'opened'",
    "  } catch {",
    "    $result.inbox.detail = $_.Exception.Message",
    "  }",
    "} else {",
    "  $result.inbox.ok = $true",
    "  $result.inbox.detail = 'skipped'",
    "}",
    "$result | ConvertTo-Json -Compress",
  ].join("\n");
}

function launchPowerPointAndOpenInbox(options = {}) {
  if (process.platform !== "win32") {
    return { ok: false, reason: "windows_only" };
  }
  const inboxDir = ensureOfficeplusTemplateInboxDir();
  const officeplusUrl = getOfficeplusPickUrl();
  try {
    const script = buildPowerPointLaunchScript(
      officeplusUrl,
      inboxDir,
      options,
    );
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    const stdout = String(result && result.stdout ? result.stdout : "").trim();
    const stderr = String(result && result.stderr ? result.stderr : "").trim();

    if (result.status !== 0 || !stdout) {
      const detail = stderr || stdout || "no_output";
      return {
        ok: false,
        reason: `open_powerpoint_failed:${sanitizeAuditDetail(detail)}`,
        officeplusUrl,
        inboxDir,
        inboxRelativePath: path
          .relative(__dirname, inboxDir)
          .replace(/\\/g, "/"),
      };
    }

    let launchStatus = null;
    try {
      launchStatus = JSON.parse(stdout);
    } catch (error) {
      return {
        ok: false,
        reason: `open_powerpoint_failed:invalid_script_output:${sanitizeAuditDetail(stdout)}`,
        officeplusUrl,
        inboxDir,
        inboxRelativePath: path
          .relative(__dirname, inboxDir)
          .replace(/\\/g, "/"),
      };
    }

    const powerPointOk = !!(
      launchStatus &&
      launchStatus.powerPoint &&
      launchStatus.powerPoint.ok
    );
    const officeplusOk = !!(
      launchStatus &&
      launchStatus.officeplus &&
      launchStatus.officeplus.ok
    );
    const inboxOk = !!(
      launchStatus &&
      launchStatus.inbox &&
      launchStatus.inbox.ok
    );
    if (!powerPointOk || !officeplusOk || !inboxOk) {
      return {
        ok: false,
        reason: `open_powerpoint_failed:${sanitizeAuditDetail(JSON.stringify(launchStatus))}`,
        launchStatus,
        officeplusUrl,
        inboxDir,
        inboxRelativePath: path
          .relative(__dirname, inboxDir)
          .replace(/\\/g, "/"),
      };
    }

    return {
      ok: true,
      inboxDir,
      officeplusUrl,
      inboxRelativePath: path.relative(__dirname, inboxDir).replace(/\\/g, "/"),
      launchStatus,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `open_powerpoint_failed:${sanitizeAuditDetail(error && error.message ? error.message : String(error))}`,
    };
  }
}

function normalizeContract(input, requestContext = null) {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "contract_required" };
  }
  if (String(input.contractVersion || "") !== "aippt.v1") {
    return { ok: false, reason: "unsupported_contract_version" };
  }
  if (!Array.isArray(input.slides)) {
    input.slides = [];
  }

  const rawPageCount = Number(input.pageCount || input.slides.length || 10);
  const pageCount = Number.isFinite(rawPageCount)
    ? Math.max(8, Math.min(12, Math.round(rawPageCount)))
    : NaN;
  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    return { ok: false, reason: "invalid_page_count" };
  }

  const pipeline = runDeckPipeline({
    scenario: input.scenario || input.sceneType,
    sceneType: input.sceneType,
    topic: input.topic,
    audience: input.audience,
    tone: input.tone,
    pageCount,
    slides: input.slides,
    templateId: input.templateId,
    diversityAngle: String(
      input.diversityAngle ||
        (input.diversityHint && input.diversityHint.angle) ||
        "balanced",
    ),
    seed: Number.isFinite(Number(input.seed)) ? Number(input.seed) : undefined,
    runIndex: Number.isFinite(Number(input.runIndex))
      ? Number(input.runIndex)
      : undefined,
    promptVersion: String(input.promptVersion || ""),
    variant: String(input.promptVariant || input.promptVersion || ""),
    styleGuide: String(
      (input.diversityHint &&
        (input.diversityHint.angle || input.diversityHint.instruction)) ||
        input.promptVariant ||
        input.promptVersion ||
        input.visualStyle ||
        "",
    ),
  });
  writeDebugJson(requestContext, "deckPlan.json", pipeline.deckPlan || {});
  writeDebugJson(
    requestContext,
    "slideScripts.raw.json",
    Array.isArray(pipeline.slideScripts) ? pipeline.slideScripts : [],
  );

  if (pipeline.generationValidation && !pipeline.generationValidation.pass) {
    writeDebugJson(
      requestContext,
      "generation.validation.json",
      pipeline.generationValidation,
    );
    return {
      ok: false,
      reason: `generation_validation_failed:${(pipeline.generationValidation.issues || []).join(",")}`,
      validation: pipeline.generationValidation,
    };
  }

  const slides = (pipeline.slides || []).map((s, i) => {
    const index = Number(s && s.index) || i + 1;
    const sanitized = sanitizeSlideContent(s, index, input.topic || "");
    const subtitle = sanitizeContractText(sanitized.subtitle || "", 260);
    const bullets = sanitizeBullets(sanitized.bullets, 5);
    const notes = sanitizeContractText(sanitized.notes || "", 520);
    const footer = sanitizeContractText(sanitized.footer || "", 80);
    const date = sanitizeContractText(sanitized.date || "", 32);
    const richGoal = sanitizeContractText(
      (s &&
        (s.goal ||
          s.body ||
          s.insight ||
          s.background ||
          s.problem ||
          s.question ||
          s.conclusion ||
          s.result)) ||
        subtitle ||
        "",
      260,
    );
    return {
      index,
      slideType: sanitized.slideType,
      title: sanitizeContractText(
        stripVersionSuffix(sanitized.title || `第${i + 1}页`),
        96,
      ),
      subtitle,
      bullets,
      notes,
      footer,
      date,
      goal: sanitized.slideType === "section" ? "" : richGoal,
      layoutType: String(
        (s && s.layoutType) || sanitized.layoutType || "",
      ).trim(),
      layoutId: String((s && s.layoutId) || "")
        .trim()
        .toLowerCase(),
      scriptType: String((s && s.scriptType) || "")
        .trim()
        .toLowerCase(),
      scriptId: String((s && s.scriptId) || `s${index}`),
      templateIndex: Number(s && s.templateIndex) || 0,
      slotPayload:
        s && s.slotPayload && typeof s.slotPayload === "object"
          ? s.slotPayload
          : {},
      missingRequiredSlots: Array.isArray(s && s.missingRequiredSlots)
        ? s.missingRequiredSlots.slice(0, 8)
        : [],
      keyPoints: bullets,
      items: Array.isArray(s && s.items)
        ? s.items.slice(0, 4).map((it) => ({
            title: cleanDeckText(it && it.title, 10),
            desc: cleanDecisionDesc(it && (it.desc || it.text || it.body), 22),
          }))
        : [],
      assetPlaceholders: sanitized.assetPlaceholders,
      speakerNotes: notes,
    };
  });

  const rawMode = String(
    (input.layoutPolicy && input.layoutPolicy.mode) ||
      input.failureStrategy ||
      "balanced",
  )
    .trim()
    .toLowerCase();
  const mode = ["strict-layout", "balanced", "strict-content"].includes(rawMode)
    ? rawMode
    : "balanced";
  const minScoreRaw = Number(input.layoutPolicy && input.layoutPolicy.minScore);
  const defaultMinScore =
    mode === "strict-layout" ? 84 : mode === "strict-content" ? 55 : 68;
  const minScore = Number.isFinite(minScoreRaw)
    ? Math.max(0, Math.min(100, minScoreRaw))
    : defaultMinScore;
  const mappingVersion =
    String(
      (input.layoutPolicy && input.layoutPolicy.mappingVersion) ||
        "semantic-slot-v1",
    ).trim() || "semantic-slot-v1";

  const layoutPolicy = {
    mode,
    minScore,
    mappingVersion,
    overflowPolicy: mode === "strict-content" ? "notes-first" : "layout-first",
  };

  const normalizedContract = {
    contractVersion: "aippt.v1",
    engineType: String(input.engineType || "generic-aippt"),
    sceneType: String(input.sceneType || "通用"),
    templateId: String(input.templateId || "default-business-template"),
    diversityAngle: String(input.diversityAngle || "balanced"),
    templateSource: String(input.templateSource || "internal"),
    externalTemplateId: String(input.externalTemplateId || ""),
    externalTemplateName: String(input.externalTemplateName || ""),
    templateFileName: String(input.templateFileName || ""),
    templateFileBase64: String(input.templateFileBase64 || ""),
    pageCount,
    visualStyle: String(input.visualStyle || "简洁商务风"),
    tone: String(input.tone || "清晰、可执行"),
    fontTheme: String(input.fontTheme || "business-cn"),
    chartStyle: String(input.chartStyle || "calm"),
    narrativeMode: String(input.narrativeMode || "standard"),
    lockToTemplate: true,
    codegenOnly: false,
    requestId:
      requestContext && requestContext.requestId
        ? requestContext.requestId
        : "",
    topic: sanitizeContractText(
      stripVersionSuffix(input.topic || "当前需求"),
      140,
    ),
    seed: Number.isFinite(Number(input.seed)) ? Number(input.seed) : undefined,
    runIndex: Number.isFinite(Number(input.runIndex))
      ? Number(input.runIndex)
      : undefined,
    diversityHint:
      input && input.diversityHint && typeof input.diversityHint === "object"
        ? {
            angle: sanitizeContractText(input.diversityHint.angle || "", 32),
            instruction: sanitizeContractText(
              input.diversityHint.instruction || "",
              220,
            ),
          }
        : null,
    deckPlan: pipeline.deckPlan,
    slideScripts: pipeline.slideScripts,
    templateManifest: pipeline.templateManifest,
    templateWarnings: pipeline.templateWarnings,
    layoutPolicy,
    slides,
  };

  applyFeedbackConstraintsToContract(normalizedContract);

  // Auto bind a real local template when caller does not provide one.
  if (!normalizedContract.templateFileBase64) {
    const preferredTemplate = fs.existsSync(DEFAULT_TEMPLATE_PATH)
      ? {
          name: path.basename(DEFAULT_TEMPLATE_PATH),
          absPath: DEFAULT_TEMPLATE_PATH,
        }
      : getLatestInboxPptxFile();
    if (preferredTemplate) {
      try {
        normalizedContract.templateSource = "officeplus";
        normalizedContract.templateFileName = preferredTemplate.name;
        normalizedContract.templateFileBase64 = fs
          .readFileSync(preferredTemplate.absPath)
          .toString("base64");
      } catch {}
    }
  }

  // Hard policy: all exports must be based on a real template file.
  if (normalizedContract.templateFileBase64) {
    normalizedContract.templateSource = "officeplus";
    normalizedContract.lockToTemplate = true;
    normalizedContract.codegenOnly = false;
  }

  // Second pass sanitization for title dedup and placeholder hard cleanup.
  const seenTitle = new Map();
  normalizedContract.slides = normalizedContract.slides.map((s, i) => {
    const cur = sanitizeSlideContent(s, i + 1, normalizedContract.topic);
    const effectiveScriptType = normalizeScriptType(
      (s && s.scriptType) || cur.slideType || "",
      i + 1,
    );
    let title = cleanForbiddenPrefixes(
      sanitizeContractText(stripVersionSuffix(cur.title || `第${i + 1}页`), 96),
    );
    const key = title.toLowerCase();
    const count = seenTitle.get(key) || 0;
    if (count > 0) {
      title = `${title}（${i + 1}）`;
    }
    seenTitle.set(key, count + 1);
    const bullets = sanitizeBullets(cur.bullets, 5)
      .map((b) => cleanForbiddenPrefixes(b))
      .filter(Boolean);
    const slotPayload =
      s && s.slotPayload && typeof s.slotPayload === "object"
        ? s.slotPayload
        : {};
    const isFourPoints =
      String((s && s.layoutId) || "").toLowerCase() === "four_points";
    const visibleLabel = sanitizeContractText(
      slotPayload.label || cur.subtitle || "",
      24,
    );
    let visibleBody = sanitizeContractText(
      slotPayload.body || s.goal || cur.subtitle || "",
      180,
    );
    if (visibleLabel && visibleBody) {
      const labelNorm = visibleLabel.replace(/\s+/g, "").toLowerCase();
      const bodyNorm = visibleBody.replace(/\s+/g, "").toLowerCase();
      if (bodyNorm === labelNorm) {
        visibleBody = "";
      } else if (bodyNorm.startsWith(labelNorm)) {
        const sliced = visibleBody
          .slice(visibleLabel.length)
          .replace(/^[：:，,\-\s]+/, "")
          .trim();
        visibleBody = sliced || visibleBody;
      }
    }
    const visibleHint = sanitizeContractText(
      slotPayload.visualHint || slotPayload.chartHint || "",
      24,
    );
    let normalizedItems = Array.isArray(s && s.items)
      ? s.items.slice(0, 4)
      : [];
    if (isFourPoints) {
      const four = normalizeFourPointItems(
        normalizedItems,
        s && s.bullets,
        visibleLabel || "管理决策",
      );
      normalizedItems = four.items;
    }
    return {
      ...s,
      index: i + 1,
      slideType: cur.slideType,
      title,
      subtitle: sanitizeContractText(cur.subtitle || "", 260),
      bullets,
      notes: sanitizeContractText(cur.notes || "", 520),
      footer: sanitizeContractText(cur.footer || "", 80),
      date: sanitizeContractText(cur.date || "", 32),
      keyPoints: bullets,
      goal: effectiveScriptType === "content_text" ? visibleBody : "",
      speakerNotes: sanitizeContractText(cur.notes || "", 520),
      layoutType: cur.layoutType,
      layoutId: isFourPoints
        ? "four_points"
        : String((s && s.layoutId) || "").toLowerCase(),
      items: normalizedItems,
      slotPayload: {
        ...slotPayload,
        label: isFourPoints
          ? sanitizeContractText(visibleLabel || "管理决策", 24)
          : visibleLabel,
        body: visibleBody,
        visualHint: visibleHint,
        footer: sanitizeContractText(cur.footer || "", 24),
        pageNo: "",
      },
    };
  });
  writeDebugJson(
    requestContext,
    "slideScripts.normalized.json",
    normalizedContract.slideScripts || [],
  );

  const deckValidation = validateDeck(normalizedContract);
  writeDebugJson(
    requestContext,
    "validation.precheck.json",
    deckValidation || {},
  );
  if (!deckValidation.pass) {
    return {
      ok: false,
      reason: `deck_validation_failed:${deckValidation.issues.join(",")}`,
      validation: deckValidation,
    };
  }

  return {
    ok: true,
    contract: normalizedContract,
    validation: deckValidation,
  };
}

function isTeachingScene(contract) {
  const scene = String((contract && contract.sceneType) || "");
  const topic = String((contract && contract.topic) || "");
  return (
    /(教务|教学|课堂|学生|初中|物理|理科)/.test(scene) ||
    /(牛顿|合力|加速度|受力|实验|例题|练习|作业|定律|公式)/.test(topic)
  );
}

function enforceFirstPrinciplesTeachingContract(contract) {
  // Stop-bleed mode: disable legacy teaching hardcoding to avoid cross-topic pollution.
  return contract;
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseSlideSizeFromPresentationXml(xml) {
  const m = String(xml || "").match(
    /<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i,
  );
  return {
    cx: m && m[1] ? Number(m[1]) : 12192000,
    cy: m && m[2] ? Number(m[2]) : 6858000,
  };
}

function extractSlideTextBoxesFromXml(xml) {
  const boxes = [];
  const src = String(xml || "");
  const shapeRegex = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  let sm;
  while ((sm = shapeRegex.exec(src)) !== null) {
    const part = sm[0];
    const textMatches = [...part.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)];
    if (!textMatches.length) continue;
    const text = textMatches
      .map((t) => decodeXmlText(t[1] || ""))
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!text) continue;

    const off = part.match(/<a:off[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i);
    const ext = part.match(/<a:ext[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i);
    const x = off && off[1] ? Number(off[1]) : 0;
    const y = off && off[2] ? Number(off[2]) : 0;
    const w = ext && ext[1] ? Number(ext[1]) : 0;
    const h = ext && ext[2] ? Number(ext[2]) : 0;

    boxes.push({ text, x, y, w, h });
  }
  return boxes;
}

function isMetaText(text) {
  return (
    /^(logo|content)$/i.test(text) ||
    /officeplus|^时间[:：]|^part\s*\d+|^\d+([\/\-]\d+)?$/i.test(text)
  );
}

function isSectionScaffoldText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/^[a-z]$/i.test(t)) return true;
  return (
    /^(work\s*overview|core\s*results|problem\s*reflection|future\s*plan)\b/i.test(
      t,
    ) ||
    /review\s+of\s+goals\s+and\s+responsibilities/i.test(t) ||
    /key\s+work\s+is\s+displayed/i.test(t) ||
    /analysis\s+of\s+existing\s+deficiencies\s+and\s+causes/i.test(t) ||
    /optimization\s+direction\s+and\s+implementation\s+plan/i.test(t) ||
    /核心成果[:：]|问题反思[:：]|未来计划[:：]/.test(t)
  );
}

function isTitleHintText(text) {
  return /输入.*标题|标题文字添加|enter\s*your\s*title|work\s*report|this is your title|^title$|汇报|总结|大标题/i.test(
    text,
  );
}

function isBodyHintText(text) {
  return /您的内容打在这里|点击此处|输入副标题|lorem|添加文本|输入标题|标题信息|副标题内容/i.test(
    text,
  );
}

function buildSemanticModelFromPptxBuffer(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const presentationEntry = zip.getEntry("ppt/presentation.xml");
    const presentationXml = presentationEntry
      ? presentationEntry.getData().toString("utf8")
      : "";
    const slideSize = parseSlideSizeFromPresentationXml(presentationXml);

    const slideEntries = zip
      .getEntries()
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => {
        const ai = Number(
          (a.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0,
        );
        const bi = Number(
          (b.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0,
        );
        return ai - bi;
      });

    const slides = slideEntries.map((entry, idx) => {
      const xml = entry.getData().toString("utf8");
      const boxes = extractSlideTextBoxesFromXml(xml);
      const validH = Math.max(1, Number(slideSize.cy) || 1);

      const normalized = boxes.map((b) => {
        const topRatio = b.y / validH;
        const bottomRatio = (b.y + b.h) / validH;
        let role = "body-candidate";
        if (isMetaText(b.text)) role = "meta";
        else if (isTitleHintText(b.text)) role = "title-hint";
        else if (isBodyHintText(b.text)) role = "body-hint";
        return {
          text: b.text,
          role,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
          topRatio,
          bottomRatio,
          centerXRatio:
            (b.x + b.w / 2) / Math.max(1, Number(slideSize.cx) || 1),
          centerYRatio: (b.y + b.h / 2) / validH,
        };
      });

      const bodyHints = normalized.filter((b) => b.role === "body-hint");
      const titleHints = normalized.filter((b) => b.role === "title-hint");
      const bodyBandCandidates = normalized.filter(
        (b) => b.role === "body-candidate",
      );
      const bodyTop = bodyHints.length
        ? Math.max(0.16, Math.min(...bodyHints.map((b) => b.topRatio)) - 0.03)
        : 0.28;
      const bodyBottom = bodyHints.length
        ? Math.min(
            0.96,
            Math.max(...bodyHints.map((b) => b.bottomRatio)) + 0.03,
          )
        : 0.9;
      const titleMaxTop = titleHints.length
        ? Math.min(
            0.62,
            Math.max(...titleHints.map((b) => b.bottomRatio)) + 0.04,
          )
        : 0.36;
      const expectedTitleMin = titleHints.length > 0 ? 1 : 0;
      const inferredBodyCandidates = bodyBandCandidates.filter(
        (b) => b.topRatio >= bodyTop && b.bottomRatio <= bodyBottom,
      );
      const expectedBodyMin =
        bodyHints.length > 0
          ? Math.max(1, Math.min(2, bodyHints.length))
          : inferredBodyCandidates.length > 0
            ? 1
            : 0;

      return {
        index: idx + 1,
        bodyBand: {
          minTopRatio: Number(bodyTop.toFixed(4)),
          maxTopRatio: Number(bodyBottom.toFixed(4)),
        },
        titleBand: {
          maxTopRatio: Number(titleMaxTop.toFixed(4)),
        },
        expectedSlots: {
          titleMin: expectedTitleMin,
          bodyMin: expectedBodyMin,
        },
        anchors: bodyHints
          .sort(
            (a, b) =>
              a.topRatio - b.topRatio || a.centerXRatio - b.centerXRatio,
          )
          .slice(0, 4)
          .map((b) => ({
            xRatio: Number(b.centerXRatio.toFixed(4)),
            yRatio: Number(b.centerYRatio.toFixed(4)),
          })),
        slotCount: normalized.length,
        slots: normalized,
      };
    });

    return {
      version: "semantic-slot-v1",
      slideSize,
      slides,
    };
  } catch {
    return null;
  }
}

function resolveTemplateSemanticModel(contract) {
  const b64 = String((contract && contract.templateFileBase64) || "").trim();
  if (!b64) return null;
  const buffer = parseBase64Payload(b64);
  if (!buffer.length) return null;
  return buildSemanticModelFromPptxBuffer(buffer);
}

function evaluateLayoutQualityAgainstModel(model, outputBuffer, contract) {
  const outputModel = buildSemanticModelFromPptxBuffer(outputBuffer);
  const policy = (contract && contract.layoutPolicy) || {
    mode: "balanced",
    minScore: 68,
  };
  if (!outputModel || !outputModel.slides.length) {
    return {
      pass: false,
      score: 0,
      minScore: Number(policy.minScore) || 68,
      mode: String(policy.mode || "balanced"),
      issues: ["output_semantic_parse_failed"],
      slideStats: [],
    };
  }

  const slideStats = [];
  let totalPenalty = 0;
  const count = Math.min(
    outputModel.slides.length,
    Array.isArray(contract && contract.slides)
      ? contract.slides.length
      : outputModel.slides.length,
  );

  for (let i = 0; i < count; i += 1) {
    const outSlide = outputModel.slides[i];
    const refSlide =
      model && model.slides && model.slides[i] ? model.slides[i] : null;
    const titleMax = refSlide
      ? Number(refSlide.titleBand.maxTopRatio || 0.36)
      : 0.36;
    const bodyMin = refSlide
      ? Number(refSlide.bodyBand.minTopRatio || 0.28)
      : 0.28;
    const bodyMax = refSlide
      ? Number(refSlide.bodyBand.maxTopRatio || 0.9)
      : 0.9;
    const expectedTitleMin =
      refSlide && refSlide.expectedSlots
        ? Number(refSlide.expectedSlots.titleMin || 0)
        : 1;
    const expectedBodyMin =
      refSlide && refSlide.expectedSlots
        ? Number(refSlide.expectedSlots.bodyMin || 0)
        : 1;

    const contentSlots = outSlide.slots.filter((s) => !isMetaText(s.text));
    const titleSlots = contentSlots.filter(
      (s) => s.topRatio <= titleMax && s.text.length >= 2,
    );
    const bodySlots = contentSlots.filter(
      (s) =>
        s.topRatio >= bodyMin && s.bottomRatio <= bodyMax && s.text.length >= 2,
    );
    const outOfBand = contentSlots.filter(
      (s) =>
        s.topRatio < bodyMin && s.bottomRatio > titleMax && s.text.length >= 10,
    );

    let overlapRisk = 0;
    for (let a = 0; a < bodySlots.length; a += 1) {
      for (let b = a + 1; b < bodySlots.length; b += 1) {
        const sa = bodySlots[a];
        const sb = bodySlots[b];
        const dx = Math.abs(sa.centerXRatio - sb.centerXRatio);
        const dy = Math.abs(sa.centerYRatio - sb.centerYRatio);
        if (dx < 0.05 && dy < 0.03) overlapRisk += 1;
      }
    }

    const penalties = {
      missingTitle:
        titleSlots.length >= expectedTitleMin
          ? 0
          : expectedTitleMin > 0
            ? 14
            : 0,
      missingBody:
        bodySlots.length >= expectedBodyMin ? 0 : expectedBodyMin > 0 ? 14 : 0,
      outOfBand: Math.min(22, outOfBand.length * 8),
      overlap: Math.min(18, overlapRisk * 6),
    };
    const slidePenalty =
      penalties.missingTitle +
      penalties.missingBody +
      penalties.outOfBand +
      penalties.overlap;
    totalPenalty += slidePenalty;
    const expectedMiss =
      (titleSlots.length >= expectedTitleMin
        ? 0
        : expectedTitleMin > 0
          ? 1
          : 0) +
      (bodySlots.length >= expectedBodyMin ? 0 : expectedBodyMin > 0 ? 1 : 0);

    slideStats.push({
      index: i + 1,
      expectedTitleMin,
      expectedBodyMin,
      titleSlots: titleSlots.length,
      bodySlots: bodySlots.length,
      outOfBand: outOfBand.length,
      overlapRisk,
      expectedMiss,
      penalty: slidePenalty,
    });
  }

  const avgPenalty = count > 0 ? totalPenalty / count : 100;
  const score = Math.max(0, Math.min(100, Math.round(100 - avgPenalty)));
  const minScore = Number(policy.minScore) || 68;
  const visibleIssueSlides = slideStats.filter(
    (s) => s.outOfBand > 0 || s.overlapRisk > 0,
  ).length;
  const structuralMissSlides = slideStats.filter(
    (s) => Number(s.titleSlots || 0) === 0 && Number(s.bodySlots || 0) === 0,
  ).length;
  const expectedMissCount = slideStats.reduce(
    (acc, s) => acc + Number(s.expectedMiss || 0),
    0,
  );
  const estimatedManualFixes = Math.max(
    0,
    Math.ceil((visibleIssueSlides * 2 + structuralMissSlides) / 3),
  );
  const issues = [];
  if (score < minScore) issues.push("layout_quality_below_threshold");
  if (slideStats.some((s) => s.outOfBand > 0))
    issues.push("content_out_of_body_band");
  if (slideStats.some((s) => s.overlapRisk > 0))
    issues.push("potential_overlap_detected");
  if (slideStats.some((s) => s.expectedMiss > 0))
    issues.push("slot_missing_expected_content");

  return {
    pass: score >= minScore,
    strictLeakSafe: visibleIssueSlides === 0,
    score,
    minScore,
    mode: String(policy.mode || "balanced"),
    mappingVersion: String(policy.mappingVersion || "semantic-slot-v1"),
    visibleIssueSlides,
    structuralMissSlides,
    expectedMissCount,
    estimatedManualFixes,
    issues,
    slideStats,
  };
}

function evaluateContentQualityFromOutputBuffer(outputBuffer, contract) {
  const outputModel = buildSemanticModelFromPptxBuffer(outputBuffer);
  const expectedSlides = Math.max(
    1,
    Number(contract && contract.pageCount) ||
      (Array.isArray(contract && contract.slides)
        ? contract.slides.length
        : 0) ||
      (outputModel && Array.isArray(outputModel.slides)
        ? outputModel.slides.length
        : 0),
  );

  if (
    !outputModel ||
    !Array.isArray(outputModel.slides) ||
    outputModel.slides.length === 0
  ) {
    return {
      pass: false,
      contentCoverage: 0,
      emptySlides: Array.from({ length: expectedSlides }, (_, i) => i + 1),
      placeholderOnlySlides: [],
      reasons: ["output_semantic_parse_failed"],
      slideStats: [],
    };
  }

  const slideStats = [];
  const emptySlides = [];
  const placeholderOnlySlides = [];
  let contentSlides = 0;

  for (let i = 0; i < expectedSlides; i += 1) {
    const s = outputModel.slides[i] || null;
    const slots = s && Array.isArray(s.slots) ? s.slots : [];
    const nonMeta = slots.filter((x) => String((x && x.role) || "") !== "meta");
    const placeholderLike = nonMeta.filter((x) => {
      const role = String((x && x.role) || "");
      return role === "title-hint" || role === "body-hint";
    });
    const contentLike = nonMeta.filter((x) => {
      const role = String((x && x.role) || "");
      return role === "body-candidate";
    });

    const empty = nonMeta.length === 0;
    const placeholderOnly =
      !empty && contentLike.length === 0 && placeholderLike.length > 0;
    const hasContent = contentLike.length > 0;
    if (empty) emptySlides.push(i + 1);
    if (placeholderOnly) placeholderOnlySlides.push(i + 1);
    if (hasContent) contentSlides += 1;

    slideStats.push({
      index: i + 1,
      slotCount: slots.length,
      nonMetaCount: nonMeta.length,
      placeholderCount: placeholderLike.length,
      contentCount: contentLike.length,
      empty,
      placeholderOnly,
      hasContent,
    });
  }

  const contentCoverage = contentSlides / expectedSlides;
  const reasons = [];
  if (emptySlides.length > 0)
    reasons.push(`blank_slides:${emptySlides.join(",")}`);
  if (placeholderOnlySlides.length > 0)
    reasons.push(`placeholder_only_slides:${placeholderOnlySlides.join(",")}`);
  if (contentCoverage < 0.98)
    reasons.push(`content_coverage_low:${contentCoverage.toFixed(3)}`);

  return {
    pass:
      emptySlides.length === 0 &&
      placeholderOnlySlides.length === 0 &&
      contentCoverage >= 0.98,
    contentCoverage,
    emptySlides,
    placeholderOnlySlides,
    reasons,
    slideStats,
  };
}

function extractPptTextDumpFromBuffer(outputBuffer, contract) {
  const slidesIn = Array.isArray(contract && contract.slides)
    ? contract.slides
    : [];
  const dump = {
    inputSlideCount: slidesIn.length,
    physicalSlideCount: 0,
    visibleSlideCount: 0,
    hiddenSlideCount: 0,
    outputSlideCount: 0,
    slides: [],
  };

  try {
    const zip = new AdmZip(outputBuffer);
    const slideEntries = zip
      .getEntries()
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.entryName))
      .sort((a, b) => {
        const ai = Number(
          (a.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0,
        );
        const bi = Number(
          (b.entryName.match(/slide(\d+)\.xml/i) || [])[1] || 0,
        );
        return ai - bi;
      });

    dump.physicalSlideCount = slideEntries.length;
    dump.hiddenSlideCount = slideEntries.reduce((acc, entry) => {
      const xml = entry.getData().toString("utf8");
      return acc + (/<p:sld\b[^>]*\bshow="0"/i.test(xml) ? 1 : 0);
    }, 0);
    dump.visibleSlideCount = Math.max(
      0,
      dump.physicalSlideCount - dump.hiddenSlideCount,
    );
    dump.outputSlideCount = slideEntries.length;
    dump.slides = slideEntries.map((entry, i) => {
      const xml = entry.getData().toString("utf8");
      const isHidden = /<p:sld\b[^>]*\bshow="0"/i.test(xml);
      const boxes = extractSlideTextBoxesFromXml(xml)
        .map((b) => ({
          text: cleanDeckText(b && b.text, 0),
          x: Number(b && b.x) || 0,
          y: Number(b && b.y) || 0,
          w: Number(b && b.w) || 0,
          h: Number(b && b.h) || 0,
        }))
        .filter((b) => !!b.text)
        .sort((a, b) => a.y - b.y || a.x - b.x);
      const texts = boxes
        .map((x) => cleanDeckText(x && x.text, 0))
        .filter(Boolean);
      const title = cleanDeckText(
        (slidesIn[i] && slidesIn[i].title) || texts[0] || "",
        64,
      );
      return {
        index: i + 1,
        type:
          String((slidesIn[i] && slidesIn[i].slideType) || "")
            .trim()
            .toLowerCase() || "content",
        title,
        isHidden,
        texts,
        boxes,
      };
    });
  } catch {}

  return dump;
}

function logExportSlideSummary(textDump) {
  const inputCount = Number((textDump && textDump.inputSlideCount) || 0);
  const outputCount = Number((textDump && textDump.outputSlideCount) || 0);
  console.log(`[ppt-export] inputSlideCount=${inputCount}`);
  console.log(`[ppt-export] outputSlideCount=${outputCount}`);
  const rows = Array.isArray(textDump && textDump.slides)
    ? textDump.slides
    : [];
  for (const row of rows) {
    console.log(
      `[ppt-export] slide#${row.index} type=${row.type || "content"} title=${String(row.title || "").slice(0, 60)}`,
    );
  }
}

function runPostExportDeckValidation(contract, result, requestContext = null) {
  if (!result || !result.buffer) {
    return {
      textDump: { inputSlideCount: 0, outputSlideCount: 0, slides: [] },
      deckValidation: {
        pass: false,
        errors: [{ slideIndex: 0, type: "missingBuffer", text: "" }],
        issues: ["missingBuffer"],
        warnings: [],
      },
    };
  }
  const textDump = extractPptTextDumpFromBuffer(result.buffer, contract);
  logExportSlideSummary(textDump);
  const deckValidation = validateDeck(contract, textDump);
  const qualityScore = computeQualityScore(contract, textDump, deckValidation);
  result.textDump = textDump;
  result.deckValidation = deckValidation;
  result.qualityScore = qualityScore;
  writeDebugJson(requestContext, "dump.json", {
    requestId: String((contract && contract.requestId) || ""),
    topic: String((contract && contract.topic) || ""),
    deckPlan: contract && contract.deckPlan ? contract.deckPlan : null,
    inputSlideCount: Number((textDump && textDump.inputSlideCount) || 0),
    outputSlideCount: Number((textDump && textDump.outputSlideCount) || 0),
    slides: Array.isArray(textDump && textDump.slides) ? textDump.slides : [],
    validation: {
      ok: !!(deckValidation && deckValidation.ok),
      errors: Array.isArray(deckValidation && deckValidation.errors)
        ? deckValidation.errors
        : [],
    },
    qualityScore,
  });
  writeDebugJson(requestContext, "validation.json", {
    requestId: String((contract && contract.requestId) || ""),
    ok: !!(deckValidation && deckValidation.ok),
    errors: Array.isArray(deckValidation && deckValidation.errors)
      ? deckValidation.errors
      : [],
    qualityScore,
  });
  writeDebugJson(requestContext, "renderLog.json", {
    requestId: String((contract && contract.requestId) || ""),
    inputSlideCount: Array.isArray(contract && contract.slides)
      ? contract.slides.length
      : 0,
    outputSlideCount: Number((textDump && textDump.outputSlideCount) || 0),
    physicalSlideCount: Number((textDump && textDump.physicalSlideCount) || 0),
    visibleSlideCount: Number((textDump && textDump.visibleSlideCount) || 0),
    hiddenSlideCount: Number((textDump && textDump.hiddenSlideCount) || 0),
    records: Array.isArray(contract && contract.slides)
      ? contract.slides.map((s, i) => ({
          sourceTemplateIndex: Number(s && s.templateIndex) || 0,
          outputSlideIndex: i + 1,
          slideType: String((s && (s.scriptType || s.slideType)) || ""),
          slideTitle: String((s && s.title) || ""),
          slotWrites: (() => {
            const row = Array.isArray(textDump && textDump.slides)
              ? textDump.slides[i]
              : null;
            const boxes = Array.isArray(row && row.boxes)
              ? row.boxes.slice(0, 8)
              : [];
            const slotSpec =
              s && s.slots && typeof s.slots === "object" ? s.slots : {};
            const expected = Object.keys(slotSpec).map((key) => ({
              slot: key,
              shapeName: String(
                (slotSpec[key] && slotSpec[key].shapeName) || "",
              ),
              required: !!(slotSpec[key] && slotSpec[key].required),
              text:
                key === "title"
                  ? String((s && s.title) || "")
                  : key === "label"
                    ? String(
                        (s && s.slotPayload && s.slotPayload.label) ||
                          s.goal ||
                          "",
                      )
                    : key === "body"
                      ? String((s && s.slotPayload && s.slotPayload.body) || "")
                      : key === "bullets"
                        ? String((s && s.pointText) || "")
                        : key === "footer"
                          ? String(
                              (s && s.slotPayload && s.slotPayload.footer) ||
                                "",
                            )
                          : "",
            }));
            return expected.map((e, bi) => {
              const b = boxes[bi] || null;
              return {
                slot: e.slot,
                shapeName: e.shapeName,
                required: e.required,
                text: e.text,
                fallback: !b,
                x: b ? Number(b.x || 0) : null,
                y: b ? Number(b.y || 0) : null,
                w: b ? Number(b.w || 0) : null,
                h: b ? Number(b.h || 0) : null,
              };
            });
          })(),
        }))
      : [],
  });
  return { textDump, deckValidation, qualityScore };
}

function evaluateTeachingQualityFromOutputBuffer(outputBuffer, contract) {
  if (contract && contract.codegenOnly === true) {
    return {
      pass: true,
      enabled: false,
      avgCharsPerSlide: 0,
      formulaSlideRatio: 0,
      genericSlideRatio: 0,
      actionTimeCoverage: 0,
      titleViolationSlides: [],
      reasons: [],
    };
  }

  if (!isTeachingScene(contract)) {
    return {
      pass: true,
      enabled: false,
      avgCharsPerSlide: 0,
      formulaSlideRatio: 0,
      genericSlideRatio: 0,
      actionTimeCoverage: 0,
      titleViolationSlides: [],
      reasons: [],
    };
  }

  const outputModel = buildSemanticModelFromPptxBuffer(outputBuffer);
  if (
    !outputModel ||
    !Array.isArray(outputModel.slides) ||
    outputModel.slides.length === 0
  ) {
    return {
      pass: false,
      enabled: true,
      avgCharsPerSlide: 0,
      formulaSlideRatio: 0,
      genericSlideRatio: 1,
      actionTimeCoverage: 0,
      titleViolationSlides: [],
      reasons: ["teaching_parse_failed"],
      slideStats: [],
    };
  }

  const lockMode = !!(contract && contract.lockToTemplate === true);
  const genericRe =
    /(当前需求|占位|模板|待完善|输入标题|添加标题|标题文字添加|点击此处|请在此输入)/;
  const formulaRe =
    /(F\s*=\s*ma|牛顿第二定律|合力|加速度|\d+\s*(N|kg|m\/s2|m\/s²|%))/i;
  const actionTimeRe =
    /(提问|板演|练习|实验|讨论|互评|复述|订正|分钟|课后|下节|本节)/;
  const countChars = (text) => String(text || "").replace(/\s+/g, "").length;
  const slides = outputModel.slides;

  let totalChars = 0;
  let formulaSlides = 0;
  let genericSlides = 0;
  let actionSlides = 0;
  const titleViolationSlides = [];
  const slideStats = [];

  for (let i = 0; i < slides.length; i += 1) {
    const slots = Array.isArray(slides[i].slots) ? slides[i].slots : [];
    const nonMeta = slots.filter((x) => String((x && x.role) || "") !== "meta");
    const ordered = nonMeta
      .slice()
      .sort((a, b) => Number(a.topRatio || 0) - Number(b.topRatio || 0));
    const topCandidates = ordered.filter(
      (s) => Number(s.topRatio || 0) <= 0.32,
    );
    const title = String(
      (topCandidates[0] && topCandidates[0].text) ||
        (ordered[0] && ordered[0].text) ||
        "",
    ).trim();
    const body = ordered.map((x) => String(x.text || "")).join(" ");
    const chars = countChars(body);
    const hasFormula = formulaRe.test(body);
    const hasGeneric = genericRe.test(body);
    const hasAction = actionTimeRe.test(body) && /行动[:：]/.test(body);
    const titleBad = title.length > 18 || /[•|｜]/.test(title);

    totalChars += chars;
    if (hasFormula) formulaSlides += 1;
    if (hasGeneric) genericSlides += 1;
    if (hasAction) actionSlides += 1;
    if (titleBad) titleViolationSlides.push(i + 1);

    slideStats.push({
      index: i + 1,
      title: title.slice(0, 36),
      chars,
      hasFormula,
      hasGeneric,
      hasAction,
      titleBad,
    });
  }

  const total = Math.max(1, slides.length);
  const avgCharsPerSlide = Number((totalChars / total).toFixed(1));
  const formulaSlideRatio = Number((formulaSlides / total).toFixed(3));
  const genericSlideRatio = Number((genericSlides / total).toFixed(3));
  const actionTimeCoverage = Number((actionSlides / total).toFixed(3));

  const maxGeneric = lockMode ? 0.1 : 0;
  const minFormula = lockMode ? 0.45 : 0.6;
  const minAvgChars = lockMode ? 45 : 70;
  const maxAvgChars = lockMode ? 180 : 130;
  const maxTitleViolations = lockMode ? 2 : 0;
  const minActionCoverage = lockMode ? 0 : 0.95;

  const reasons = [];
  if (genericSlideRatio > maxGeneric)
    reasons.push(
      `generic_gt_${maxGeneric.toFixed(3)}:${genericSlideRatio.toFixed(3)}`,
    );
  if (formulaSlideRatio < minFormula)
    reasons.push(
      `formula_lt_${minFormula.toFixed(1)}:${formulaSlideRatio.toFixed(3)}`,
    );
  if (avgCharsPerSlide < minAvgChars || avgCharsPerSlide > maxAvgChars)
    reasons.push(
      `avg_chars_out_of_${minAvgChars}_${maxAvgChars}:${avgCharsPerSlide}`,
    );
  if (titleViolationSlides.length > maxTitleViolations)
    reasons.push(
      `title_violations_gt_${maxTitleViolations}:${titleViolationSlides.join(",")}`,
    );
  if (actionTimeCoverage < minActionCoverage)
    reasons.push(
      `action_time_coverage_lt_${minActionCoverage.toFixed(2)}:${actionTimeCoverage.toFixed(3)}`,
    );

  return {
    pass: reasons.length === 0,
    enabled: true,
    avgCharsPerSlide,
    formulaSlideRatio,
    genericSlideRatio,
    actionTimeCoverage,
    titleViolationSlides,
    reasons,
    slideStats,
  };
}

function buildPageDiagnostics(layoutQuality, contentQuality, contract) {
  const expectedSlides = Math.max(
    1,
    Number(contract && contract.pageCount) ||
      (Array.isArray(contract && contract.slides) ? contract.slides.length : 0),
  );
  const lStats =
    layoutQuality && Array.isArray(layoutQuality.slideStats)
      ? layoutQuality.slideStats
      : [];
  const cStats =
    contentQuality && Array.isArray(contentQuality.slideStats)
      ? contentQuality.slideStats
      : [];
  const byIndex = new Map();

  for (let i = 1; i <= expectedSlides; i += 1) {
    byIndex.set(i, { index: i, reasons: [] });
  }

  for (const s of lStats) {
    const row = byIndex.get(Number(s.index));
    if (!row) continue;
    if (Number(s.expectedMiss || 0) > 0)
      row.reasons.push("missing_expected_slots");
    if (Number(s.outOfBand || 0) > 0) row.reasons.push("content_out_of_band");
    if (Number(s.overlapRisk || 0) > 0) row.reasons.push("potential_overlap");
  }

  for (const s of cStats) {
    const row = byIndex.get(Number(s.index));
    if (!row) continue;
    if (s.empty) row.reasons.push("blank_slide");
    if (s.placeholderOnly) row.reasons.push("placeholder_only");
    if (!s.hasContent) row.reasons.push("missing_content");
  }

  const failedSlides = Array.from(byIndex.values())
    .map((x) => ({
      index: x.index,
      reasons: Array.from(new Set(x.reasons)),
    }))
    .filter((x) => x.reasons.length > 0);

  return {
    failedSlideCount: failedSlides.length,
    failedSlides,
    summary: {
      layoutPass: !!(layoutQuality && layoutQuality.pass),
      strictLeakSafe: !!(layoutQuality && layoutQuality.strictLeakSafe),
      contentPass: !!(contentQuality && contentQuality.pass),
      contentCoverage: Number(
        (contentQuality && contentQuality.contentCoverage) || 0,
      ),
      emptySlides:
        contentQuality && Array.isArray(contentQuality.emptySlides)
          ? contentQuality.emptySlides
          : [],
      placeholderOnlySlides:
        contentQuality && Array.isArray(contentQuality.placeholderOnlySlides)
          ? contentQuality.placeholderOnlySlides
          : [],
    },
  };
}

function isDualGatePass(result) {
  if (!result || !result.ok) return false;
  const lq = result.layoutQuality || null;
  const cq = result.contentQuality || null;
  const tq = result.teachingQuality || null;
  const layoutPass = !!(lq && lq.pass);
  const contentPass = !!(
    cq &&
    cq.pass &&
    Number(cq.contentCoverage || 0) >= 0.98 &&
    Array.isArray(cq.emptySlides) &&
    cq.emptySlides.length === 0 &&
    Array.isArray(cq.placeholderOnlySlides) &&
    cq.placeholderOnlySlides.length === 0
  );
  const teachingPass = !!(!tq || tq.pass);
  return layoutPass && contentPass && teachingPass;
}

function dualGateFailReason(result) {
  if (!result) return "dual_gate_failed:empty_result";
  const reasons = [];
  const lq = result.layoutQuality || null;
  const cq = result.contentQuality || null;
  const tq = result.teachingQuality || null;
  if (!lq || !lq.pass) reasons.push("layout_gate_failed");
  if (!cq || !cq.pass) reasons.push("content_gate_failed");
  if (tq && !tq.pass)
    reasons.push(
      `teaching_gate_failed:${Array.isArray(tq.reasons) ? tq.reasons.join(",") : "unknown"}`,
    );
  if (cq && Number(cq.contentCoverage || 0) < 0.98)
    reasons.push(
      `coverage_lt_0.98:${Number(cq.contentCoverage || 0).toFixed(3)}`,
    );
  if (cq && Array.isArray(cq.emptySlides) && cq.emptySlides.length > 0)
    reasons.push(`blank_slides:${cq.emptySlides.join(",")}`);
  if (
    cq &&
    Array.isArray(cq.placeholderOnlySlides) &&
    cq.placeholderOnlySlides.length > 0
  )
    reasons.push(
      `placeholder_only_slides:${cq.placeholderOnlySlides.join(",")}`,
    );
  return `dual_gate_failed:${reasons.join("|") || "unknown"}`;
}

function candidateGatePenalty(result) {
  if (!result || !result.ok) return 999999;
  const diag = result.diagnostics || {};
  const lq = result.layoutQuality || {};
  const cq = result.contentQuality || {};
  const tq = result.teachingQuality || {};
  const failedSlides = Number(diag.failedSlideCount || 0);
  const layoutPenalty = Math.max(0, 100 - Number(lq.score || 0));
  const expectedMiss = Number(lq.expectedMissCount || 0);
  const coveragePenalty = Math.max(
    0,
    Math.round((1 - Number(cq.contentCoverage || 0)) * 100),
  );
  const formulaPenalty = Math.max(
    0,
    Math.round((0.6 - Number(tq.formulaSlideRatio || 0)) * 100),
  );
  const genericPenalty = Math.max(
    0,
    Math.round(Number(tq.genericSlideRatio || 0) * 100),
  );
  const avgChars = Number(tq.avgCharsPerSlide || 90);
  const densityPenalty =
    avgChars < 85 ? 85 - avgChars : avgChars > 95 ? avgChars - 95 : 0;
  const actionPenalty = Math.max(
    0,
    Math.round((0.95 - Number(tq.actionTimeCoverage || 0)) * 100),
  );
  const titlePenalty = Array.isArray(tq.titleViolationSlides)
    ? tq.titleViolationSlides.length * 12
    : 0;
  return (
    failedSlides * 1000 +
    expectedMiss * 50 +
    coveragePenalty * 8 +
    layoutPenalty +
    formulaPenalty * 6 +
    genericPenalty * 8 +
    densityPenalty * 4 +
    actionPenalty * 5 +
    titlePenalty
  );
}

function parseFailedSlideIndexesFromDiagnosticsFile(diagFile) {
  try {
    if (!diagFile || !fs.existsSync(diagFile)) return [];
    const parsed = parseJsonSafe(fs.readFileSync(diagFile, "utf8"));
    const list =
      parsed &&
      parsed.diagnostics &&
      Array.isArray(parsed.diagnostics.failedSlides)
        ? parsed.diagnostics.failedSlides
        : [];
    const out = list
      .map((x) => Number(x && x.index))
      .filter((n) => Number.isInteger(n) && n > 0);
    return Array.from(new Set(out)).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function persistRepairTrainingPair({
  contract,
  beforeResult,
  afterResult,
  beforeSaved,
  afterSaved,
  repairedSlides,
}) {
  try {
    const dir = path.join(
      __dirname,
      "docs",
      "benchmarks",
      "results",
      "training-pairs",
    );
    fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `${date}.jsonl`);
    const row = {
      timestamp: new Date().toISOString(),
      topic: String((contract && contract.topic) || ""),
      sceneType: String((contract && contract.sceneType) || ""),
      templateSource: String(
        (contract && contract.templateSource) || "internal",
      ),
      repairedSlides: Array.isArray(repairedSlides) ? repairedSlides : [],
      before: {
        file: beforeSaved && beforeSaved.relPath ? beforeSaved.relPath : "",
        diagnosticsFile:
          beforeSaved && beforeSaved.diagnosticsRelPath
            ? beforeSaved.diagnosticsRelPath
            : "",
        layoutQuality:
          beforeResult && beforeResult.layoutQuality
            ? beforeResult.layoutQuality
            : null,
        contentQuality:
          beforeResult && beforeResult.contentQuality
            ? beforeResult.contentQuality
            : null,
        teachingQuality:
          beforeResult && beforeResult.teachingQuality
            ? beforeResult.teachingQuality
            : null,
        diagnostics:
          beforeResult && beforeResult.diagnostics
            ? beforeResult.diagnostics
            : null,
      },
      after: {
        file: afterSaved && afterSaved.relPath ? afterSaved.relPath : "",
        diagnosticsFile:
          afterSaved && afterSaved.diagnosticsRelPath
            ? afterSaved.diagnosticsRelPath
            : "",
        layoutQuality:
          afterResult && afterResult.layoutQuality
            ? afterResult.layoutQuality
            : null,
        contentQuality:
          afterResult && afterResult.contentQuality
            ? afterResult.contentQuality
            : null,
        teachingQuality:
          afterResult && afterResult.teachingQuality
            ? afterResult.teachingQuality
            : null,
        diagnostics:
          afterResult && afterResult.diagnostics
            ? afterResult.diagnostics
            : null,
      },
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    return path.relative(__dirname, file).replace(/\\/g, "/");
  } catch {
    return "";
  }
}

function parseBase64Payload(value) {
  if (!value || typeof value !== "string") return Buffer.alloc(0);
  const raw = value.includes(",") ? value.split(",").pop() : value;
  return Buffer.from(raw, "base64");
}

function parseJsonSafe(text) {
  if (!text || typeof text !== "string") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isPowerPointComEnabled() {
  // Explicit opt-in required: legacy env values cannot accidentally enable COM.
  // Must set POWERPOINT_COM_EXPLICIT_ALLOW=true to allow COM path.
  const explicitAllow = String(process.env.POWERPOINT_COM_EXPLICIT_ALLOW || "")
    .trim()
    .toLowerCase();
  if (!["1", "true", "on", "yes"].includes(explicitAllow)) {
    return false;
  }

  // Hard no-popup guard: default ON, disables COM regardless legacy envs.
  // Set POWERPOINT_STRICT_NO_POPUP=false to allow COM checks below.
  const strictNoPopup = String(process.env.POWERPOINT_STRICT_NO_POPUP || "true")
    .trim()
    .toLowerCase();
  if (!["0", "false", "off", "no"].includes(strictNoPopup)) {
    return false;
  }

  const raw = String(process.env.POWERPOINT_COM_ENABLED || "")
    .trim()
    .toLowerCase();
  // Default OFF to avoid intrusive PowerPoint UI popups on desktop.
  if (!raw) return false;
  return ["1", "true", "on", "yes"].includes(raw);
}

let powerPointComCircuitReason = "";

function shouldShortCircuitPowerPointCom() {
  return !!powerPointComCircuitReason;
}

function markPowerPointComCircuit(reason) {
  powerPointComCircuitReason = String(reason || "powerpoint_com_circuit_open");
}

function getPowerPointComTimeoutMs() {
  const n = Number(process.env.POWERPOINT_COM_TIMEOUT_MS || 120000);
  if (!Number.isFinite(n) || n < 10000) return 120000;
  return Math.min(n, 600000);
}

function isPowerPointComProbeEnabled() {
  const raw = String(process.env.POWERPOINT_COM_PROBE_ENABLED || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "on", "yes"].includes(raw);
}

function probePowerPointComRuntime() {
  // Probe is disabled by default because creating COM application objects can surface UI.
  if (!isPowerPointComProbeEnabled()) {
    return { ok: false, reason: "powerpoint_com_probe_disabled" };
  }
  if (!isPowerPointComEnabled()) {
    return { ok: false, reason: "powerpoint_com_disabled" };
  }
  if (process.platform !== "win32") {
    return { ok: false, reason: "powerpoint_com_windows_only" };
  }

  const ps = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$ErrorActionPreference='Stop'; $pp=New-Object -ComObject PowerPoint.Application; $pp.Quit(); 'ok'",
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    },
  );

  if (ps.error) {
    return {
      ok: false,
      reason: `powerpoint_com_probe_error:${sanitizeAuditDetail(ps.error.message || String(ps.error))}`,
    };
  }
  if (ps.status !== 0) {
    const detail = sanitizeAuditDetail(
      String(ps.stderr || ps.stdout || `exit_${ps.status}`),
    );
    return { ok: false, reason: `powerpoint_com_probe_failed:${detail}` };
  }
  return { ok: true, reason: "ok" };
}

// 纯 ASCII JSON：把所有非 ASCII 字符转成 \uXXXX，彻底规避 PowerShell 读取 payload
// 时的中文乱码问题（PS 会用 ConvertFrom-Json 解回真实 Unicode，再交给 COM 写入）。
function toAsciiJson(obj) {
  return JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function clampText(value, max) {
  const text = String(value || "").trim();
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// 关键：所有中文/项目符号的正文组装都在 Node 侧完成，PowerShell 脚本保持纯 ASCII，
// 避免 .ps1 non-ASCII 解析失败导致回退低保真引擎。
function buildPowerPointComContractPayload(contract) {
  const semanticModel = resolveTemplateSemanticModel(contract);
  const semanticSlides =
    semanticModel && Array.isArray(semanticModel.slides)
      ? semanticModel.slides
      : [];
  const slidesIn = Array.isArray(contract && contract.slides)
    ? contract.slides
    : [];
  const lockMode = !!(contract && contract.lockToTemplate === true);
  const sceneText = sanitizeContractText(
    (contract && contract.sceneType) || "",
    80,
  );
  const topicText = sanitizeContractText(
    (contract && contract.topic) || "",
    160,
  );
  const isEduDeck =
    /(教务|教学|课堂|学生|初中|物理)/i.test(sceneText) ||
    /(牛顿|合力|加速度|受力|实验|例题|练习|作业|定律|公式)/i.test(topicText);
  const splitTitlePieces = (text) =>
    String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s*[•|｜]+\s*/)
      .map((x) => x.trim())
      .filter(Boolean);
  const stripTriadPrefix = (text) =>
    String(text || "")
      .replace(/^(结论：|证据：|行动：)/, "")
      .trim();
  const chapterTitleRe =
    /^(一、|二、|三、|四、|五、|目录|封面|课堂小结|课堂总结|课堂收束|分层作业)/;
  const repairSlideIndexes = Array.isArray(
    contract && contract.repairSlideIndexes,
  )
    ? Array.from(
        new Set(
          contract.repairSlideIndexes
            .map((x) => Number(x))
            .filter((n) => Number.isInteger(n) && n > 0),
        ),
      ).sort((a, b) => a - b)
    : [];
  const sceneLower = String(
    (contract && (contract.scenario || contract.sceneType)) || "",
  ).toLowerCase();
  const forbiddenByScene = {
    proposal: [/课堂抓手/i, /本课/i, /复习/i, /教学目标/i, /学生/i],
    business_report: [/课堂抓手/i, /本课/i, /复习/i, /教学目标/i, /学生/i],
    teaching: [/ROI\b/i, /降本增效方案/i],
    training: [],
  };

  const slides = slidesIn.map((s, i) => {
    const semanticHint = semanticSlides[i] || null;
    const slotPayload =
      s && s.slotPayload && typeof s.slotPayload === "object"
        ? s.slotPayload
        : {};
    const slideType = normalizeScriptType(
      (s && (s.scriptType || s.slideType)) || "",
      i + 1,
    );
    let title = sanitizeContractText(
      stripVersionSuffix((s && s.title) || `第${i + 1}页`),
      30,
    );
    let subtitle = sanitizeContractText(
      slotPayload.label || (s && s.subtitle) || "",
      24,
    );
    if (slideType === "cover" && isLikelyTitleGarble(title)) {
      const coverFallback = sanitizeContractText(
        (s && s.subtitle) || subtitle || topicText || "",
        30,
      );
      if (coverFallback) {
        console.warn(
          "cover_title_garble_fallback",
          JSON.stringify({ index: i + 1, before: title, after: coverFallback }),
        );
        title = coverFallback;
      }
    }
    const body = sanitizeContractText(
      slotPayload.body || (s && s.goal) || "",
      180,
    );
    const layoutId = String((s && s.layoutId) || "").toLowerCase();
    const isFourPoints = layoutId === "four_points";
    const fourPointItems = isFourPoints
      ? normalizeFourPointItems(
          (s && s.items) || [],
          (s && (s.bullets || s.keyPoints)) || [],
          subtitle || "管理决策",
        ).items
      : [];
    const bullets = isFourPoints
      ? fourPointItems.map((it) =>
          sanitizeContractText(`${it.title}：${it.desc}`, 36),
        )
      : formatStageBullets((s && (s.bullets || s.keyPoints)) || []).map((x) =>
          sanitizeContractText(x, 34),
        );
    const visualHint = sanitizeContractText(slotPayload.visualHint || "", 24);
    const footer = sanitizeContractText(
      slotPayload.footer || (s && s.footer) || "",
      24,
    );
    const pageNo = sanitizeContractText(slotPayload.pageNo || "", 10);
    const notes = sanitizeContractText((s && s.speakerNotes) || "", 420);

    // renderState: deduplicate same field/text writes and avoid repeated phrase spam.
    const renderState = {
      renderedFields: new Set(),
      renderedTexts: new Set(),
    };
    const pushLine = (field, text, out) => {
      const line = sanitizeContractText(text || "", 220);
      if (!line) return;
      const key = line.toLowerCase();
      if (renderState.renderedFields.has(field)) return;
      if (renderState.renderedTexts.has(key)) return;
      renderState.renderedFields.add(field);
      renderState.renderedTexts.add(key);
      out.push(line);
    };

    if (subtitle && subtitle === title) subtitle = "";

    const visibleLines = [];
    if (isFourPoints) {
      // four_points must always provide 4 independent lines for 2x2 rendering.
      const bodyLines = bullets.slice(0, 4);
      bodyLines.forEach((b, idx) => pushLine(`bullet_${idx}`, b, visibleLines));
    } else if (slideType === "section") {
      pushLine("subtitle", subtitle, visibleLines);
      pushLine("footer", footer, visibleLines);
      pushLine("pageNo", pageNo, visibleLines);
    } else if (slideType === "content_bullets") {
      // Keep label as an independent block; bullets are always one item per line.
      if (!isFourPoints) pushLine("label", subtitle, visibleLines);
      const bodyLines = isFourPoints
        ? bullets.slice(0, 4)
        : bullets.slice(0, 3);
      bodyLines.forEach((b, idx) => pushLine(`bullet_${idx}`, b, visibleLines));
      if (!isFourPoints) {
        pushLine(
          "visualHint",
          visualHint ? `图示：${visualHint}` : "",
          visibleLines,
        );
        pushLine("footer", footer, visibleLines);
        pushLine("pageNo", pageNo, visibleLines);
      }
    } else if (slideType === "cover" || slideType === "thanks") {
      pushLine(
        "subtitle",
        sanitizeContractText((s && s.subtitle) || subtitle || "", 32),
        visibleLines,
      );
      pushLine("footer", footer, visibleLines);
      pushLine("pageNo", pageNo, visibleLines);
    } else {
      pushLine("label", subtitle, visibleLines);
      pushLine("body", body, visibleLines);
      pushLine(
        "visualHint",
        visualHint ? `图示：${visualHint}` : "",
        visibleLines,
      );
      pushLine("footer", footer, visibleLines);
      pushLine("pageNo", pageNo, visibleLines);
    }

    let blocks = visibleLines.slice(0, 4);
    if (!blocks.length) {
      const fallback =
        slideType === "content_bullets"
          ? isFourPoints
            ? "试点范围：明确首批渠道与服务场景"
            : "第1阶段：明确执行动作与衡量口径"
          : "补充该页业务说明，确保信息可直接用于汇报。";
      blocks = [fallback, footer, pageNo].filter(Boolean);
    }

    const sceneRules = forbiddenByScene[sceneLower] || [];
    const blocked = sceneRules.some((re) =>
      re.test([title, ...blocks].join(" ")),
    );
    if (blocked) {
      blocks = blocks.map((line) =>
        line
          .replace(/课堂抓手/g, "关键抓手")
          .replace(/本课/g, "本页")
          .replace(/复习/g, "回顾")
          .replace(/教学目标/g, "目标")
          .replace(/学生/g, "用户"),
      );
    }

    return {
      index: i + 1,
      title,
      goal: slideType === "section" || isFourPoints ? "" : subtitle,
      pointText: isFourPoints
        ? bullets.join("\r\n")
        : bullets.map((x, idx) => `第${idx + 1}阶段：${x}`).join("\r\n"),
      notes,
      blocks,
      bodyText: blocks.join("\r\n\r\n"),
      slideType,
      layoutId,
      pageNo,
      semanticHint: semanticHint
        ? {
            bodyBand: semanticHint.bodyBand || {
              minTopRatio: 0.28,
              maxTopRatio: 0.9,
            },
            titleBand: semanticHint.titleBand || { maxTopRatio: 0.36 },
            anchors: Array.isArray(semanticHint.anchors)
              ? semanticHint.anchors.slice(0, 4)
              : [],
            expectedSlots: semanticHint.expectedSlots || {
              titleMin: 1,
              bodyMin: 1,
            },
          }
        : null,
    };
  });

  return {
    topic: sanitizeContractText(
      stripVersionSuffix((contract && contract.topic) || "Daymori"),
      120,
    ),
    sceneType: sanitizeContractText(
      (contract && contract.sceneType) || "通用",
      40,
    ),
    layoutPolicy: (contract && contract.layoutPolicy) || {
      mode: "balanced",
      minScore: 68,
      mappingVersion: "semantic-slot-v1",
    },
    semanticModelVersion:
      semanticModel && semanticModel.version
        ? semanticModel.version
        : "semantic-slot-v1",
    slideCount: slides.length,
    repairSlideIndexes,
    slides,
  };
}

function buildPowerPointComScript() {
  return [
    "param([string]$TemplatePath,[string]$PayloadPath,[string]$OutputPath)",
    "$ErrorActionPreference = 'Stop'",
    "$ppt = $null",
    "$pres = $null",
    "try {",
    "  $payloadRaw = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8",
    "  $payload = $payloadRaw | ConvertFrom-Json",
    "  $ppt = New-Object -ComObject PowerPoint.Application",
    "  # Some Office installations reject hidden automation windows. Keep COM visible for stability.",
    "  $ppt.Visible = -1",
    "  try { $ppt.DisplayAlerts = 0 } catch {}",
    "  $pres = $ppt.Presentations.Open($TemplatePath, $false, $false, $false)",
    "",
    "  $normalizeForBody = {",
    "    param([string]$text)",
    "    $x = [string]$text",
    "    $x = $x -replace '\\r\\n?', \"`n\"",
    '    if ($x -notmatch "`n") {',
    "      $x = $x -replace '[;；]\\s*', \"`n\"",
    "      $x = $x -replace '\\s+\\|\\s+', \"`n\"",
    "    }",
    "    $x = $x -replace '\\s{2,}', ' '",
    "    return $x.Trim()",
    "  }",
    "",
    "  $wrapLine = {",
    "    param([string]$line, [int]$maxChars)",
    "    $out = New-Object System.Collections.ArrayList",
    "    $src = [string]$line",
    "    if ([string]::IsNullOrWhiteSpace($src)) { return ,$out }",
    "    if ($maxChars -lt 10) { $maxChars = 10 }",
    "    $src = $src.Trim()",
    "    while ($src.Length -gt $maxChars) {",
    "      $cut = $maxChars",
    "      $scanStart = [Math]::Max(0, $cut - 10)",
    "      for ($i = $cut; $i -ge $scanStart; $i--) {",
    "        if ($i -ge $src.Length) { continue }",
    "        $ch = $src[$i]",
    "        if (',，。；;:：、 '.IndexOf($ch) -ge 0) {",
    "          $cut = $i + 1",
    "          break",
    "        }",
    "      }",
    "      $part = $src.Substring(0, $cut).Trim()",
    "      if ([string]::IsNullOrWhiteSpace($part) -eq $false) { [void]$out.Add($part) }",
    "      $src = $src.Substring($cut).TrimStart()",
    "    }",
    "    if ([string]::IsNullOrWhiteSpace($src) -eq $false) { [void]$out.Add($src) }",
    "    return ,$out",
    "  }",
    "",
    "  $fitBodyText = {",
    "    param([string]$text, $shape, [double]$fontSize)",
    "    $norm = &$normalizeForBody $text",
    "    if ([string]::IsNullOrWhiteSpace($norm)) { return @{ text = ''; overflow = '' } }",
    "",
    "    $w = 300.0",
    "    $h = 120.0",
    "    try { $w = [double]$shape.Width } catch {}",
    "    try { $h = [double]$shape.Height } catch {}",
    "",
    "    $charsPerLine = [int][Math]::Floor(($w - 12) / ([Math]::Max(6.0, $fontSize * 0.95)))",
    "    if ($charsPerLine -lt 10) { $charsPerLine = 10 }",
    "",
    "    $lineCap = [int][Math]::Floor(($h - 8) / ([Math]::Max(10.0, $fontSize * 1.55)))",
    "    if ($lineCap -lt 2) { $lineCap = 2 }",
    "",
    "    $lines = New-Object System.Collections.ArrayList",
    '    foreach ($ln in ($norm -split "`n")) {',
    "      $chunks = &$wrapLine ([string]$ln) $charsPerLine",
    "      foreach ($chunk in $chunks) {",
    "        if ([string]::IsNullOrWhiteSpace([string]$chunk)) { continue }",
    "        [void]$lines.Add([string]$chunk)",
    "      }",
    "    }",
    "",
    "    if ($lines.Count -eq 0) { return @{ text = ''; overflow = '' } }",
    "",
    "    $take = [Math]::Min($lineCap, $lines.Count)",
    "    $kept = New-Object System.Collections.ArrayList",
    "    for ($i = 0; $i -lt $take; $i++) { [void]$kept.Add([string]$lines[$i]) }",
    "",
    "    $overflow = ''",
    "    if ($lines.Count -gt $lineCap) {",
    "      $rest = New-Object System.Collections.ArrayList",
    "      for ($i = $lineCap; $i -lt $lines.Count; $i++) { [void]$rest.Add([string]$lines[$i]) }",
    "      $overflow = ($rest -join ' ')",
    "      if ($kept.Count -gt 0) {",
    "        $last = [string]$kept[$kept.Count - 1]",
    "        $kept[$kept.Count - 1] = ($last.TrimEnd('.', '。', ';', '；', ',', '，') + '...')",
    "      }",
    "    }",
    "",
    '    return @{ text = ($kept -join "`r`n"); overflow = $overflow }',
    "  }",
    "",
    "  $applyText = {",
    "    param($shape, [string]$text, [string]$kind)",
    "    try {",
    "      if ($shape -eq $null) { return '' }",
    "      $final = [string]$text",
    "      if ([string]::IsNullOrWhiteSpace($final)) { return '' }",
    "",
    "      $shape.TextFrame.WordWrap = -1",
    "      $shape.TextFrame.AutoSize = 0",
    "      try {",
    "        $shape.TextFrame2.WordWrap = -1",
    "        $shape.TextFrame2.AutoSize = 2",
    "      } catch {}",
    "",
    "      if ($kind -eq 'title') {",
    "        $shape.TextFrame.TextRange.Text = $final",
    "        if ($shape.TextFrame.TextRange.Font.Size -le 0) { $shape.TextFrame.TextRange.Font.Size = 30 }",
    "        for ($k = 0; $k -lt 8; $k++) {",
    "          try {",
    "            $bh = [double]$shape.TextFrame2.TextRange.BoundHeight",
    "            if ($bh -le ($shape.Height - 4)) { break }",
    "            $cur = [double]$shape.TextFrame.TextRange.Font.Size",
    "            if ($cur -le 18) { break }",
    "            $shape.TextFrame.TextRange.Font.Size = $cur - 1",
    "          } catch { break }",
    "        }",
    "        return ''",
    "      }",
    "",
    "      $base = 14.0",
    "      $len = $final.Length",
    "      if ($len -gt 600) { $base = 11.0 }",
    "      elseif ($len -gt 420) { $base = 12.0 }",
    "      elseif ($len -gt 280) { $base = 13.0 }",
    "",
    "      $fit = &$fitBodyText $final $shape $base",
    "      $finalBody = [string]$fit.text",
    "      if ([string]::IsNullOrWhiteSpace($finalBody)) { return [string]$fit.overflow }",
    "",
    "      $shape.TextFrame.TextRange.Text = $finalBody",
    "      try { $shape.TextFrame.TextRange.Font.Size = $base } catch {}",
    "",
    "      for ($k = 0; $k -lt 8; $k++) {",
    "        try {",
    "          $bh = [double]$shape.TextFrame2.TextRange.BoundHeight",
    "          if ($bh -le ($shape.Height - 4)) { break }",
    "          $cur = [double]$shape.TextFrame.TextRange.Font.Size",
    "          if ($cur -le 10) { break }",
    "          $shape.TextFrame.TextRange.Font.Size = $cur - 1",
    "        } catch { break }",
    "      }",
    "      return [string]$fit.overflow",
    "    } catch {",
    "      return ''",
    "    }",
    "  }",
    "",
    "  $selectBodyTargets = {",
    "    param($candidates, [int]$limit)",
    "    $picked = New-Object System.Collections.ArrayList",
    "    foreach ($cand in $candidates) {",
    "      $ok = $true",
    "      foreach ($keep in $picked) {",
    "        try {",
    "          $dx = [Math]::Abs(([double]$cand.Left + ([double]$cand.Width / 2.0)) - ([double]$keep.Left + ([double]$keep.Width / 2.0)))",
    "          $dy = [Math]::Abs(([double]$cand.Top + ([double]$cand.Height / 2.0)) - ([double]$keep.Top + ([double]$keep.Height / 2.0)))",
    "          $xCap = [Math]::Min([double]$cand.Width, [double]$keep.Width) * 0.34",
    "          $yCap = [Math]::Min([double]$cand.Height, [double]$keep.Height) * 0.34",
    "          if ($dx -lt $xCap -and $dy -lt $yCap) { $ok = $false; break }",
    "        } catch {}",
    "      }",
    "      if ($ok) { [void]$picked.Add($cand) }",
    "      if ($limit -gt 0 -and $picked.Count -ge $limit) { break }",
    "    }",
    "    return $picked",
    "  }",
    "",
    "  $sortByAnchors = {",
    "    param($candidates, $anchors)",
    "    if ($candidates -eq $null) { return @() }",
    "    if ($anchors -eq $null -or $anchors.Count -eq 0) { return @($candidates) }",
    "    return @($candidates | Sort-Object @{ Expression = {",
    "      $cx = 0.0; $cy = 0.0",
    "      try { $cx = ([double]$_.Left + ([double]$_.Width / 2.0)) } catch {}",
    "      try { $cy = ([double]$_.Top + ([double]$_.Height / 2.0)) } catch {}",
    "      $best = 1e12",
    "      foreach ($a in $anchors) {",
    "        try {",
    "          $dx = $cx - [double]$a.x",
    "          $dy = $cy - [double]$a.y",
    "          $d = ($dx * $dx) + ($dy * $dy)",
    "          if ($d -lt $best) { $best = $d }",
    "        } catch {}",
    "      }",
    "      $best",
    "    } }, @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } })",
    "  }",
    "",
    "  $createTitleFallbackBox = {",
    "    param($slide, [double]$slideW, [double]$slideH, [double]$titleMaxTopRatio)",
    "    $left = $slideW * 0.10",
    "    $top = $slideH * 0.08",
    "    $width = $slideW * 0.80",
    "    $height = $slideH * ([Math]::Min(0.18, [Math]::Max(0.10, $titleMaxTopRatio - 0.02)))",
    "    if ($height -lt 52) { $height = 52 }",
    "    try {",
    "      $shape = $slide.Shapes.AddTextbox(1, $left, $top, $width, $height)",
    "      $shape.TextFrame.WordWrap = -1",
    "      $shape.TextFrame.AutoSize = 0",
    "      return $shape",
    "    } catch {",
    "      return $null",
    "    }",
    "  }",
    "",
    "  $createBodyFallbackBox = {",
    "    param($slide, [double]$slideW, [double]$slideH, [double]$bodyMinTopRatio, [double]$bodyMaxTopRatio)",
    "    $left = $slideW * 0.10",
    "    $top = $slideH * ([Math]::Max(0.24, $bodyMinTopRatio))",
    "    if ($top -gt ($slideH * 0.72)) { $top = $slideH * 0.58 }",
    "    $band = [Math]::Max(0.14, [Math]::Min(0.30, $bodyMaxTopRatio - $bodyMinTopRatio - 0.02))",
    "    $width = $slideW * 0.80",
    "    $height = $slideH * $band",
    "    if ($height -lt 80) { $height = 80 }",
    "    if (($top + $height) -gt ($slideH * 0.94)) { $height = [Math]::Max(64, ($slideH * 0.94) - $top) }",
    "    try {",
    "      $shape = $slide.Shapes.AddTextbox(1, $left, $top, $width, $height)",
    "      $shape.TextFrame.WordWrap = -1",
    "      $shape.TextFrame.AutoSize = 0",
    "      return $shape",
    "    } catch {",
    "      return $null",
    "    }",
    "  }",
    "",
    "  $createFourPointBoxes = {",
    "    param($slide, [double]$slideW, [double]$slideH, [double]$bodyMinTopRatio, [double]$bodyMaxTopRatio)",
    "    $boxes = New-Object System.Collections.ArrayList",
    "    $leftMargin = $slideW * 0.12",
    "    $rightMargin = $slideW * 0.12",
    "    $top = $slideH * ([Math]::Max(0.32, $bodyMinTopRatio))",
    "    $bottom = $slideH * ([Math]::Min(0.88, $bodyMaxTopRatio))",
    "    if ($bottom -le ($top + 80)) { $bottom = $top + 220 }",
    "    $gapX = $slideW * 0.05",
    "    $gapY = $slideH * 0.04",
    "    $colW = ($slideW - $leftMargin - $rightMargin - $gapX) / 2.0",
    "    if ($colW -lt 120) { $colW = 120 }",
    "    $rowH = (($bottom - $top) - $gapY) / 2.0",
    "    if ($rowH -lt 72) { $rowH = 72 }",
    "    $positions = @(",
    "      @{ l = $leftMargin; t = $top },",
    "      @{ l = $leftMargin + $colW + $gapX; t = $top },",
    "      @{ l = $leftMargin; t = $top + $rowH + $gapY },",
    "      @{ l = $leftMargin + $colW + $gapX; t = $top + $rowH + $gapY }",
    "    )",
    "    foreach ($p in $positions) {",
    "      try {",
    "        $shape = $slide.Shapes.AddTextbox(1, [double]$p.l, [double]$p.t, [double]$colW, [double]$rowH)",
    "        $shape.TextFrame.WordWrap = -1",
    "        $shape.TextFrame.AutoSize = 0",
    "        [void]$boxes.Add($shape)",
    "      } catch {}",
    "    }",
    "    return $boxes",
    "  }",
    "",
    "  $keepCount = 0",
    "  try { $keepCount = [int]$payload.slideCount } catch { $keepCount = 0 }",
    "  $repairSet = New-Object 'System.Collections.Generic.HashSet[int]'",
    "  $repairMode = $false",
    "  try {",
    "    if ($payload.repairSlideIndexes) {",
    "      foreach ($ri in $payload.repairSlideIndexes) {",
    "        try { [void]$repairSet.Add([int]$ri) } catch {}",
    "      }",
    "      if ($repairSet.Count -gt 0) { $repairMode = $true }",
    "    }",
    "  } catch {}",
    "",
    "  foreach ($s in $payload.slides) {",
    "    $idx = [int]$s.index",
    "    if ($idx -lt 1 -or $idx -gt $pres.Slides.Count) { continue }",
    "    if ($repairMode -and -not $repairSet.Contains($idx)) { continue }",
    "",
    "    $slide = $pres.Slides.Item($idx)",
    "    $slideH = 0",
    "    $slideW = 0",
    "    try { $slideH = [double]$pres.PageSetup.SlideHeight } catch { $slideH = 540 }",
    "    try { $slideW = [double]$pres.PageSetup.SlideWidth } catch { $slideW = 960 }",
    "    $titleText = [string]$s.title",
    "    $goalText = [string]$s.goal",
    "    $pointText = [string]$s.pointText",
    "    $layoutId = [string]$s.layoutId",
    "    $isFourPoints = ($layoutId -eq 'four_points')",
    "    $notes = [string]$s.notes",
    "    $layoutMode = 'balanced'",
    "    try { if ($payload.layoutPolicy -and $payload.layoutPolicy.mode) { $layoutMode = [string]$payload.layoutPolicy.mode } } catch {}",
    "    $isEduDeck = $false",
    "    try {",
    "      $sceneTxt = ''",
    "      $topicTxt = ''",
    "      try { $sceneTxt = [string]$payload.sceneType } catch { $sceneTxt = '' }",
    "      try { $topicTxt = [string]$payload.topic } catch { $topicTxt = '' }",
    "      if ($sceneTxt -match '(?i)教务|教学|课堂|学生|初中|物理' -or $topicTxt -match '(?i)牛顿|合力|加速度|受力|实验|例题|练习|作业|定律|公式') { $isEduDeck = $true }",
    "    } catch {}",
    "    $titleMaxTopRatio = 0.36",
    "    $bodyMinTopRatio = 0.30",
    "    $bodyMaxTopRatio = 0.88",
    "    if ($layoutMode -eq 'strict-layout') { $titleMaxTopRatio = 0.34; $bodyMinTopRatio = 0.34; $bodyMaxTopRatio = 0.86 }",
    "    elseif ($layoutMode -eq 'strict-content') { $titleMaxTopRatio = 0.40; $bodyMinTopRatio = 0.24; $bodyMaxTopRatio = 0.92 }",
    "    if ($isEduDeck) {",
    "      if ($titleMaxTopRatio -gt 0.30) { $titleMaxTopRatio = 0.30 }",
    "      if ($bodyMinTopRatio -lt 0.38) { $bodyMinTopRatio = 0.38 }",
    "      if ($bodyMaxTopRatio -gt 0.90) { $bodyMaxTopRatio = 0.90 }",
    "    }",
    "    try {",
    "      if ($s.semanticHint) {",
    "        if ($s.semanticHint.titleBand -and $s.semanticHint.titleBand.maxTopRatio) { $titleMaxTopRatio = [double]$s.semanticHint.titleBand.maxTopRatio }",
    "        if ($s.semanticHint.bodyBand -and $s.semanticHint.bodyBand.minTopRatio) { $bodyMinTopRatio = [double]$s.semanticHint.bodyBand.minTopRatio }",
    "        if ($s.semanticHint.bodyBand -and $s.semanticHint.bodyBand.maxTopRatio) { $bodyMaxTopRatio = [double]$s.semanticHint.bodyBand.maxTopRatio }",
    "      }",
    "    } catch {}",
    "    if ($titleMaxTopRatio -lt 0.18) { $titleMaxTopRatio = 0.18 }",
    "    if ($titleMaxTopRatio -gt 0.72) { $titleMaxTopRatio = 0.72 }",
    "    if ($bodyMinTopRatio -lt 0.16) { $bodyMinTopRatio = 0.16 }",
    "    if ($bodyMinTopRatio -gt 0.82) { $bodyMinTopRatio = 0.82 }",
    "    if ($bodyMaxTopRatio -lt ($bodyMinTopRatio + 0.06)) { $bodyMaxTopRatio = $bodyMinTopRatio + 0.06 }",
    "    if ($bodyMaxTopRatio -gt 0.96) { $bodyMaxTopRatio = 0.96 }",
    "",
    "    $blocks = @()",
    "    if ($s.blocks) { foreach ($b in $s.blocks) { $blocks += [string]$b } }",
    "    if ($blocks.Count -eq 0 -and [string]::IsNullOrWhiteSpace($pointText) -eq $false) { $blocks += $pointText }",
    "    if ($blocks.Count -eq 0 -and [string]::IsNullOrWhiteSpace($goalText) -eq $false) { $blocks += $goalText }",
    "    if ($blocks.Count -eq 0 -and [string]::IsNullOrWhiteSpace($titleText) -eq $false) { $blocks += $titleText }",
    "    $bodyAppliedCount = 0",
    "",
    "    $titleTargets = New-Object System.Collections.ArrayList",
    "    $bodyTargets = New-Object System.Collections.ArrayList",
    "    $titleHintTargets = New-Object System.Collections.ArrayList",
    "    $bodyHintTargets = New-Object System.Collections.ArrayList",
    "    $bodyTextTargets = New-Object System.Collections.ArrayList",
    "    $tokenTargets = New-Object System.Collections.ArrayList",
    "    $textShapes = New-Object System.Collections.ArrayList",
    "    $usedShapeIds = New-Object 'System.Collections.Generic.HashSet[int]'",
    "",
    "    foreach ($shape in $slide.Shapes) {",
    "      try {",
    "        if ($shape.HasTextFrame -ne -1 -or $shape.TextFrame -eq $null) { continue }",
    "        [void]$textShapes.Add($shape)",
    "",
    "        $orig = ''",
    "        try { $orig = [string]$shape.TextFrame.TextRange.Text } catch { $orig = '' }",
    "        $origTrim = $orig.Trim()",
    "        $isBrandOrMeta = $false",
    "        if ($origTrim -match '(?i)^logo$|officeplus|^时间[:：]|^part\\s*\\d+|^content$') { $isBrandOrMeta = $true }",

    "        if (-not $isBrandOrMeta) {",
    "          $isTitleHint = $false",
    "          if ($origTrim -match '(?i)输入.*标题|标题文字添加|enter\\s*your\\s*title|work\\s*report|this is your title|^title$|汇报|总结|大标题') { $isTitleHint = $true }",
    "          if ($isTitleHint -and $shape.Top -lt ($slideH * 0.5) -and $shape.Height -ge 16) {",
    "            [void]$titleHintTargets.Add($shape)",
    "          }",

    "          $isBodyHint = $false",
    "          if ($origTrim -match '(?i)您的内容打在这里|点击此处|输入副标题|lorem|添加文本|输入标题|标题信息|副标题内容') { $isBodyHint = $true }",
    "          if ($isBodyHint -and $shape.Top -lt ($slideH * 0.88)) {",
    "            [void]$bodyHintTargets.Add($shape)",
    "          }",

    "          if ([string]::IsNullOrWhiteSpace($origTrim) -eq $false -and -not $isTitleHint -and $shape.Top -ge ($slideH * $bodyMinTopRatio) -and $shape.Top -lt ($slideH * $bodyMaxTopRatio)) {",
    "            [void]$bodyTextTargets.Add($shape)",
    "          }",
    "        }",

    "        if ($orig -match '\\{\\{title\\}\\}' -or $orig -match '\\{\\{goal\\}\\}' -or $orig -match '\\{\\{points\\}\\}' -or $orig -match '\\{\\{notes\\}\\}') {",
    "          [void]$tokenTargets.Add(@{ shape = $shape; text = $orig })",
    "        }",
    "",
    "        if ($shape.Type -eq 14) {",
    "          $ptype = 0",
    "          try { $ptype = [int]$shape.PlaceholderFormat.Type } catch { $ptype = 0 }",
    "          if ($ptype -eq 1 -or $ptype -eq 3) { [void]$titleTargets.Add($shape); continue }",
    "          if ($ptype -eq 2 -or $ptype -eq 4 -or $ptype -eq 7) { [void]$bodyTargets.Add($shape); continue }",
    "        }",
    "      } catch {",
    "      }",
    "    }",
    "",
    "    if ($titleHintTargets.Count -gt 0) {",
    "      $titleTargets.Clear()",
    "      $orderedTitleHints = @($titleHintTargets | Where-Object {",
    "        try { $_.Width -ge ($slideW * 0.25) -and $_.Top -le ($slideH * 0.55) } catch { $false }",
    "      } | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { -($_.Width * $_.Height) } }, @{ Expression = { $_.Left } })",
    "      if ($orderedTitleHints.Count -gt 0) { [void]$titleTargets.Add($orderedTitleHints[0]) }",
    "    }",

    "    if ($titleTargets.Count -eq 0 -and $titleHintTargets.Count -gt 0) {",
    "      $orderedTitleHints = @($titleHintTargets | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { -($_.Width * $_.Height) } }, @{ Expression = { $_.Left } })",
    "      if ($orderedTitleHints.Count -gt 0) { [void]$titleTargets.Add($orderedTitleHints[0]) }",
    "    }",

    "    if ($titleTargets.Count -eq 0 -and $textShapes.Count -gt 0) {",
    "      $bestTitle = $null",
    "      $bestScore = [double]::NegativeInfinity",
    "      foreach ($shape in $textShapes) {",
    "        try {",
    "          if ($shape.Width -lt ($slideW * 0.35)) { continue }",
    "          if ($shape.Top -gt ($slideH * $titleMaxTopRatio)) { continue }",
    "          if ($shape.Height -lt 16) { continue }",
    "          $score = (($slideH - $shape.Top) * 2.0) + ($shape.Width * 0.4) + ($shape.Height * 0.2)",
    "          if ($score -gt $bestScore) { $bestScore = $score; $bestTitle = $shape }",
    "        } catch {}",
    "      }",
    "      if ($bestTitle -ne $null) { [void]$titleTargets.Add($bestTitle) }",
    "    }",
    "",
    "    if ($titleTargets.Count -gt 0) {",
    "      [void](&$applyText $titleTargets[0] $titleText 'title')",
    "      try { [void]$usedShapeIds.Add([int]$titleTargets[0].Id) } catch {}",
    "    }",
    "    elseif ([string]::IsNullOrWhiteSpace($titleText) -eq $false) {",
    "      $titleFallback = &$createTitleFallbackBox $slide $slideW $slideH $titleMaxTopRatio",
    "      if ($titleFallback -ne $null) {",
    "        [void](&$applyText $titleFallback $titleText 'title')",
    "        try { [void]$usedShapeIds.Add([int]$titleFallback.Id) } catch {}",
    "      }",
    "    }",
    "",
    "    foreach ($token in $tokenTargets) {",
    "      try {",
    "        $shape = $token.shape",
    "        $orig = [string]$token.text",
    "        $replaced = $orig.Replace('{{title}}', $titleText)",
    "        $replaced = $replaced.Replace('{{goal}}', $goalText)",
    "        $replaced = $replaced.Replace('{{points}}', $pointText)",
    "        $replaced = $replaced.Replace('{{notes}}', $notes)",
    "        $ov = [string](&$applyText $shape $replaced 'body')",
    "        if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "          if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "        }",
    "        try { [void]$usedShapeIds.Add([int]$shape.Id) } catch {}",
    "      } catch {",
    "      }",
    "    }",
    "",
    "    $orderedBodies = @($bodyHintTargets | Where-Object {",
    "      try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "    } | Where-Object {",
    "      try {",
    "        if ($_.Width -lt 140 -or $_.Height -lt 56) { return $false }",
    "        if ($slideH -gt 0 -and $_.Top -lt ($slideH * $bodyMinTopRatio)) { return $false }",
    "        if ($slideH -gt 0 -and $_.Top -gt ($slideH * $bodyMaxTopRatio)) { return $false }",
    "        return $true",
    "      } catch { return $false }",
    "    } | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } }, @{ Expression = { -($_.Width * $_.Height) } })",
    "",
    "    if ($orderedBodies.Count -eq 0) {",
    "      $orderedBodies = @($bodyTextTargets | Where-Object {",
    "        try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "      } | Where-Object {",
    "        try {",
    "          if ($_.Width -lt 120 -or $_.Height -lt 40) { return $false }",
    "          return $true",
    "        } catch { return $false }",
    "      } | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } }, @{ Expression = { -($_.Width * $_.Height) } })",
    "    }",

    "    if ($orderedBodies.Count -eq 0) {",
    "      $orderedBodies = @($bodyTargets | Where-Object {",
    "      try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "    } | Where-Object {",
    "      try {",
    "        if ($_.Width -lt 140 -or $_.Height -lt 56) { return $false }",
    "        if ($slideH -gt 0 -and $_.Top -lt ($slideH * $bodyMinTopRatio)) { return $false }",
    "        if ($slideH -gt 0 -and $_.Top -gt ($slideH * $bodyMaxTopRatio)) { return $false }",
    "        return $true",
    "      } catch { return $false }",
    "    } | Sort-Object @{ Expression = { -($_.Width * $_.Height) } }, @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } })",
    "    }",

    "    if ($orderedBodies.Count -eq 0) {",
    "      $orderedBodies = @($textShapes | Where-Object {",
    "        try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "      } | Where-Object {",
    "        try {",
    "          if ($_.Width -lt 140 -or $_.Height -lt 56) { return $false }",
    "          if ($slideH -gt 0 -and $_.Top -lt ($slideH * $bodyMinTopRatio)) { return $false }",
    "          if ($slideH -gt 0 -and $_.Top -gt ($slideH * $bodyMaxTopRatio)) { return $false }",
    "          return $true",
    "        } catch { return $false }",
    "      } | Sort-Object @{ Expression = { -($_.Width * $_.Height) } }, @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } })",
    "    }",
    "",
    "    if ($orderedBodies.Count -eq 0) {",
    "      $fallbackBodies = @($textShapes | Where-Object {",
    "        try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "      } | Where-Object {",
    "        try {",
    "          $ft = ''",
    "          try { $ft = [string]$_.TextFrame.TextRange.Text } catch { $ft = '' }",
    "          $ftrim = $ft.Trim()",
    "          if ([string]::IsNullOrWhiteSpace($ftrim)) { return $false }",
    "          if ($ftrim -match '(?i)^logo$|officeplus|^时间[:：]|^part\\s*\\d+|^content$|^\\d+([\\/\\-]\\d+)?$') { return $false }",
    "          if ($ftrim -match '(?i)请在此输入|输入标题|添加标题|添加文本|this is your title|enter your title|click to add') { return $true }",
    "          return $false",
    "        } catch { return $false }",
    "      } | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } }, @{ Expression = { -($_.Width * $_.Height) } })",
    "      if ($fallbackBodies.Count -gt 0) { $orderedBodies = $fallbackBodies }",
    "    }",
    "",
    "    if ($orderedBodies.Count -eq 0) {",
    "      $orderedBodies = @($textShapes | Where-Object {",
    "        try { -not $usedShapeIds.Contains([int]$_.Id) } catch { $true }",
    "      } | Where-Object {",
    "        try {",
    "          if ($_.Width -lt 80 -or $_.Height -lt 24) { return $false }",
    "          if ($slideH -gt 0 -and $_.Top -lt ($slideH * $bodyMinTopRatio)) { return $false }",
    "          if ($slideH -gt 0 -and $_.Top -gt ($slideH * $bodyMaxTopRatio)) { return $false }",
    "          return $true",
    "        } catch { return $false }",
    "      } | Sort-Object @{ Expression = { $_.Top } }, @{ Expression = { $_.Left } }, @{ Expression = { -($_.Width * $_.Height) } })",
    "    }",
    "",
    "    if ($isFourPoints) {",
    "      $orderedBodies = @(&$createFourPointBoxes $slide $slideW $slideH $bodyMinTopRatio $bodyMaxTopRatio)",
    "    }",
    "",
    "    if ($orderedBodies.Count -gt 0) {",
    "      $anchors = @()",
    "      try {",
    "        if ($s.semanticHint -and $s.semanticHint.anchors) {",
    "          foreach ($a in $s.semanticHint.anchors) {",
    "            try {",
    "              $ax = [double]$a.xRatio * $slideW",
    "              $ay = [double]$a.yRatio * $slideH",
    "              if ($ax -gt 0 -and $ay -gt 0) { $anchors += @{ x = $ax; y = $ay } }",
    "            } catch {}",
    "          }",
    "        }",
    "      } catch {}",
    "      if ($anchors.Count -gt 0) { $orderedBodies = @(&$sortByAnchors $orderedBodies $anchors) }",
    "    }",
    "",
    "    if ($orderedBodies.Count -gt 0) {",
    "      $expectedBodyMin = 1",
    "      try {",
    "        if ($s.semanticHint -and $s.semanticHint.expectedSlots -and $s.semanticHint.expectedSlots.bodyMin) {",
    "          $expectedBodyMin = [int]$s.semanticHint.expectedSlots.bodyMin",
    "        }",
    "      } catch {}",
    "      if ($expectedBodyMin -lt 1) { $expectedBodyMin = 1 }",
    "      $needCount = [Math]::Max(1, $blocks.Count)",
    "      if ($isFourPoints -and $needCount -lt 4) { $needCount = 4 }",
    "      if (-not $isFourPoints) {",
    "        $capByHint = [Math]::Max(1, $expectedBodyMin + 1)",
    "        if ($needCount -gt $capByHint) { $needCount = $capByHint }",
    "      }",
    "      $orderedBodies = @(&$selectBodyTargets $orderedBodies $needCount)",
    "    }",
    "",
    "    if ($orderedBodies.Count -gt 0 -and $blocks.Count -gt 0) {",
    "      if ($blocks.Count -eq 1) {",
    "        $b0 = [string]$blocks[0]",
    "        $ov = [string](&$applyText $orderedBodies[0] $b0 'body')",
    "        $bodyAppliedCount = $bodyAppliedCount + 1",
    "        if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "          if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "        }",
    "        try { [void]$usedShapeIds.Add([int]$orderedBodies[0].Id) } catch {}",
    "      }",
    "      elseif ($orderedBodies.Count -ge $blocks.Count) {",
    "        for ($i = 0; $i -lt $blocks.Count; $i++) {",
    "          $bi = [string]$blocks[$i]",
    "          $ov = [string](&$applyText $orderedBodies[$i] $bi 'body')",
    "          $bodyAppliedCount = $bodyAppliedCount + 1",
    "          if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "            if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "          }",
    "          try { [void]$usedShapeIds.Add([int]$orderedBodies[$i].Id) } catch {}",
    "        }",
    "      }",
    "      else {",
    "        for ($i = 0; $i -lt $orderedBodies.Count; $i++) {",
    "          if ($i -lt ($orderedBodies.Count - 1)) {",
    "            $txt = ''",
    "            if ($i -lt $blocks.Count) { $txt = [string]$blocks[$i] }",
    "            if ([string]::IsNullOrWhiteSpace($txt) -eq $false) {",
    "              $ov = [string](&$applyText $orderedBodies[$i] $txt 'body')",
    "              $bodyAppliedCount = $bodyAppliedCount + 1",
    "              if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "                if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "              }",
    "              try { [void]$usedShapeIds.Add([int]$orderedBodies[$i].Id) } catch {}",
    "            }",
    "          } else {",
    "            $rest = @()",
    "            for ($j = $i; $j -lt $blocks.Count; $j++) { $rest += [string]$blocks[$j] }",
    '            $restText = ($rest -join "`r`n`r`n")',
    "            $ov = [string](&$applyText $orderedBodies[$i] $restText 'body')",
    "            $bodyAppliedCount = $bodyAppliedCount + 1",
    "            if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "              if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "            }",
    "            try { [void]$usedShapeIds.Add([int]$orderedBodies[$i].Id) } catch {}",
    "          }",
    "        }",
    "      }",
    "    }",
    "",
    "    if ($bodyAppliedCount -le 0 -and $blocks.Count -gt 0) {",
    "      $bodyFallback = &$createBodyFallbackBox $slide $slideW $slideH $bodyMinTopRatio $bodyMaxTopRatio",
    "      if ($bodyFallback -ne $null) {",
    "        $fallbackText = [string]$blocks[0]",
    "        if ($blocks.Count -gt 1) {",
    "          $tmp = New-Object System.Collections.ArrayList",
    "          for ($bi = 0; $bi -lt [Math]::Min(3, $blocks.Count); $bi++) { [void]$tmp.Add([string]$blocks[$bi]) }",
    '          $fallbackText = ($tmp -join "`r`n`r`n")',
    "        }",
    "        $ov = [string](&$applyText $bodyFallback $fallbackText 'body')",
    "        $bodyAppliedCount = $bodyAppliedCount + 1",
    "        if ([string]::IsNullOrWhiteSpace($ov) -eq $false) {",
    "          if ([string]::IsNullOrWhiteSpace($notes)) { $notes = $ov } else { $notes = ($notes + ' ' + $ov).Trim() }",
    "        }",
    "        try { [void]$usedShapeIds.Add([int]$bodyFallback.Id) } catch {}",
    "      }",
    "    }",
    "",
    "    # write speaker notes into the notes page, not the body",
    "    if ([string]::IsNullOrWhiteSpace($notes) -eq $false) {",
    "      try {",
    "        $np = $slide.NotesPage",
    "        foreach ($ns in $np.Shapes) {",
    "          try {",
    "            if ($ns.HasTextFrame -ne -1) { continue }",
    "            $npt = 0",
    "            try { $npt = [int]$ns.PlaceholderFormat.Type } catch { $npt = 0 }",
    "            if ($npt -eq 2) { $ns.TextFrame.TextRange.Text = $notes; break }",
    "          } catch {}",
    "        }",
    "      } catch {}",
    "    }",
    "",
    "    # clear unmapped placeholder copy and generic template headings that are not used",
    "    foreach ($shape in $textShapes) {",
    "      try {",
    "        if ($bodyAppliedCount -le 0) { continue }",
    "        $sid = [int]$shape.Id",
    "        if ($usedShapeIds.Contains($sid)) { continue }",
    "        $cur = [string]$shape.TextFrame.TextRange.Text",
    "        $curTrim = $cur.Trim()",
    "        if ([string]::IsNullOrWhiteSpace($curTrim)) { continue }",
    "        if ($curTrim -match '(?i)^logo$|officeplus|^时间[:：]|^part\\s*\\d+|^content$|^\\d+([\\/\\-]\\d+)?$') { continue }",
    "        $isPlaceholderText = $curTrim -match '(?i)您的内容打在这里|点击此处|输入.*标题|标题文字添加|lorem ipsum|添加文本|副标题内容|enter\\s*your\\s*title|this is your title|click to add'",
    "        $isGenericTemplateHeading = $curTrim -match '(?i)^目录$|^目标与范围$|^关键数据趋势$|^问题与对策$|^行动计划$|^阶段工作概述$|^工作完成进度$|^企业$|^汇报$|^report$'",
    "        $isDupTitle = $false",
    "        if ([string]::IsNullOrWhiteSpace($titleText) -eq $false) {",
    "          $safeTitle = [Regex]::Escape($titleText)",
    "          $safeTrim = [Regex]::Escape($curTrim)",
    "          if ($curTrim -eq $titleText -or $curTrim -match $safeTitle -or $titleText -match $safeTrim) { $isDupTitle = $true }",
    "        }",
    "        if (-not $isPlaceholderText -and -not $isGenericTemplateHeading -and -not $isDupTitle) { continue }",
    "        $shape.TextFrame.TextRange.Text = ''",
    "      } catch {}",
    "    }",
    "",
    "    # hard guard: if a slide ends up with no real content (or only placeholders),",
    "    # create fallback title/body boxes to avoid blank pages.",
    "    $nonMetaCount = 0",
    "    $placeholderOnlyCount = 0",
    "    foreach ($shape in $slide.Shapes) {",
    "      try {",
    "        if ($shape.HasTextFrame -ne -1 -or $shape.TextFrame -eq $null) { continue }",
    "        $txt = ''",
    "        try { $txt = [string]$shape.TextFrame.TextRange.Text } catch { $txt = '' }",
    "        $trim = $txt.Trim()",
    "        if ([string]::IsNullOrWhiteSpace($trim)) { continue }",
    "        if ($trim -match '(?i)^logo$|officeplus|^时间[:：]|^part\\s*\\d+|^content$|^\\d+([\\/\\-]\\d+)?$') { continue }",
    "        if ($trim -match '(?i)您的内容打在这里|点击此处|输入.*标题|标题文字添加|lorem ipsum|添加文本|副标题内容|enter\\s*your\\s*title|this is your title|click to add') {",
    "          $placeholderOnlyCount = $placeholderOnlyCount + 1",
    "        } else {",
    "          $nonMetaCount = $nonMetaCount + 1",
    "        }",
    "      } catch {}",
    "    }",
    "",
    "    if ($nonMetaCount -le 0) {",
    "      if ([string]::IsNullOrWhiteSpace($titleText) -eq $false) {",
    "        $titleFallback2 = &$createTitleFallbackBox $slide $slideW $slideH $titleMaxTopRatio",
    "        if ($titleFallback2 -ne $null) {",
    "          [void](&$applyText $titleFallback2 $titleText 'title')",
    "        }",
    "      }",
    "      $fallbackBlocks = @()",
    "      if ($blocks -and $blocks.Count -gt 0) {",
    "        for ($bi = 0; $bi -lt [Math]::Min(3, $blocks.Count); $bi++) { $fallbackBlocks += [string]$blocks[$bi] }",
    "      }",
    "      if ($fallbackBlocks.Count -eq 0 -and [string]::IsNullOrWhiteSpace($goalText) -eq $false) { $fallbackBlocks += [string]$goalText }",
    "      if ($fallbackBlocks.Count -eq 0 -and [string]::IsNullOrWhiteSpace($titleText) -eq $false) { $fallbackBlocks += [string]$titleText }",
    "      if ($fallbackBlocks.Count -gt 0) {",
    "        $bodyFallback2 = &$createBodyFallbackBox $slide $slideW $slideH $bodyMinTopRatio $bodyMaxTopRatio",
    "        if ($bodyFallback2 -ne $null) {",
    '          $fbText = ($fallbackBlocks -join "`r`n`r`n")',
    "          [void](&$applyText $bodyFallback2 $fbText 'body')",
    "        }",
    "      }",
    "    }",

    "    # if visible text is still too thin, add one explicit fallback body box",
    "    $visibleChars = 0",
    "    foreach ($shape in $slide.Shapes) {",
    "      try {",
    "        if ($shape.HasTextFrame -ne -1 -or $shape.TextFrame -eq $null) { continue }",
    "        $txt2 = ''",
    "        try { $txt2 = [string]$shape.TextFrame.TextRange.Text } catch { $txt2 = '' }",
    "        $trim2 = $txt2.Trim()",
    "        if ([string]::IsNullOrWhiteSpace($trim2)) { continue }",
    "        if ($trim2 -match '(?i)^logo$|officeplus|^时间[:：]|^part\\s*\\d+|^content$|^\\d+([\\/\\-]\\d+)?$') { continue }",
    "        $visibleChars = $visibleChars + $trim2.Length",
    "      } catch {}",
    "    }",
    "    if ($visibleChars -lt 48) {",
    "      $fbParts = @()",
    "      if ([string]::IsNullOrWhiteSpace($goalText) -eq $false) { $fbParts += [string]$goalText }",
    "      if ($blocks -and $blocks.Count -gt 0) {",
    "        for ($k = 0; $k -lt [Math]::Min(2, $blocks.Count); $k++) {",
    "          $btxt = [string]$blocks[$k]",
    "          if ([string]::IsNullOrWhiteSpace($btxt) -eq $false) { $fbParts += $btxt }",
    "        }",
    "      }",
    "      if ($fbParts.Count -gt 0) {",
    "        $bodyFallback3 = &$createBodyFallbackBox $slide $slideW $slideH $bodyMinTopRatio $bodyMaxTopRatio",
    "        if ($bodyFallback3 -ne $null) {",
    "          $fb3 = ($fbParts -join " + '"`r`n`r`n"' + ")",
    "          [void](&$applyText $bodyFallback3 $fb3 'body')",
    "        }",
    "      }",
    "    }",

    "    # final cleanup: forbidden-term post clean with whitelist",
    "    $topicText = ''",
    "    $sceneText = ''",
    "    try { $topicText = [string]$payload.topic } catch { $topicText = '' }",
    "    try { $sceneText = [string]$payload.sceneType } catch { $sceneText = '' }",
    "    $isEduTopic = ($sceneText -match '(?i)教务|教学|课堂|学生|初中|物理') -or ($topicText -match '(?i)牛顿|合力|加速度|受力|实验|例题|练习|作业|定律|公式')",
    "    $forbiddenHeadingPattern = '(?i)目录|阶段工作概述|工作完成进度|目标与范围|关键数据趋势|问题与对策|行动计划|企业|汇报|report|项目成果展示|未来工作规划|添加标题|content|logo|感谢聆听|后续|待完善|示例|占位|当前需求'",
    "    $placeholderPattern = '(?i)您的内容打在这里|点击此处|输入.*标题|标题文字添加|lorem ipsum|添加文本|副标题内容|enter\\s*your\\s*title|this is your title|click to add'",
    "    $eduWhitelistPattern = '(?i)牛顿|合力|加速度|受力|实验|变量|例题|练习|作业|课堂|定律|公式|单位|图像|摩擦|质量|力|误区|提问|板演|讨论|订正'",
    "    foreach ($shape in $slide.Shapes) {",
    "      try {",
    "        if ($shape.HasTextFrame -ne -1 -or $shape.TextFrame -eq $null) { continue }",
    "        $txt = ''",
    "        try { $txt = [string]$shape.TextFrame.TextRange.Text } catch { $txt = '' }",
    "        $trim = $txt.Trim()",
    "        if ([string]::IsNullOrWhiteSpace($trim)) { continue }",
    "        $triadClean = ($trim -replace '结论[:：]', '' -replace '证据[:：]', '' -replace '行动[:：]', '').Trim()",
    "        if ($triadClean -ne $trim) {",
    "          try { $shape.TextFrame.TextRange.Text = $triadClean } catch {}",
    "          $trim = $triadClean",
    "        }",
    "        if ($trim -match '(?i)officeplus|^时间[:：]|^part\\s*\\d+|^\\d+([\\/\\-]\\d+)?$') { continue }",
    "        $isPlaceholder = $trim -match $placeholderPattern",
    "        $isForbidden = $trim -match $forbiddenHeadingPattern",
    "        if (-not $isPlaceholder -and -not $isForbidden) { continue }",
    "        if ($isEduTopic) {",
    "          if ($trim -match $eduWhitelistPattern) { continue }",
    "          if ($trim -match '(?i)添加标题|项目成果展示|未来工作规划|阶段工作概述|工作完成进度|目录|感谢聆听|content|logo|后续|待完善|示例|占位|当前需求') {",
    "            $shape.TextFrame.TextRange.Text = ''",
    "            continue",
    "          }",
    "          if ($shape.Top -le ($slideH * 0.42) -and [string]::IsNullOrWhiteSpace($titleText) -eq $false) {",
    "            $shape.TextFrame.TextRange.Text = $titleText",
    "          } else {",
    "            $shape.TextFrame.TextRange.Text = ''",
    "          }",
    "          continue",
    "        }",
    "        $hasTopicToken = $false",
    "        foreach ($tk in @('牛顿','合力','加速度','F=ma','受力','实验','例题','练习','作业')) {",
    "          if ($trim -like ('*' + $tk + '*') -or $topicText -like ('*' + $tk + '*')) { $hasTopicToken = $true; break }",
    "        }",
    "        # never clear the active slide title text, even if it matches generic forbidden terms",
    "        if ([string]::IsNullOrWhiteSpace($titleText) -eq $false -and ($trim -eq $titleText -or $trim -like ('*' + $titleText + '*') -or $titleText -like ('*' + $trim + '*'))) { continue }",
    "        if (-not $hasTopicToken) { $shape.TextFrame.TextRange.Text = '' }",
    "      } catch {}",
    "    }",

    "    # ensure top teaching title survives after cleanup",
    "    if ($isEduTopic -and [string]::IsNullOrWhiteSpace($titleText) -eq $false) {",
    "      $hasTopTitle = $false",
    "      foreach ($shape in $slide.Shapes) {",
    "        try {",
    "          if ($shape.HasTextFrame -ne -1 -or $shape.TextFrame -eq $null) { continue }",
    "          if ($shape.Top -gt ($slideH * 0.45)) { continue }",
    "          $tt = ''",
    "          try { $tt = [string]$shape.TextFrame.TextRange.Text } catch { $tt = '' }",
    "          $ttTrim = $tt.Trim()",
    "          if ([string]::IsNullOrWhiteSpace($ttTrim)) { continue }",
    "          if ($ttTrim -eq $titleText -or $ttTrim -like ('*' + $titleText.Substring(0, [Math]::Min(6, $titleText.Length)) + '*')) {",
    "            $hasTopTitle = $true",
    "            break",
    "          }",
    "        } catch {}",
    "      }",
    "      if (-not $hasTopTitle) {",
    "        $titleFallback3 = &$createTitleFallbackBox $slide $slideW $slideH $titleMaxTopRatio",
    "        if ($titleFallback3 -ne $null) {",
    "          [void](&$applyText $titleFallback3 $titleText 'title')",
    "        }",
    "      }",
    "    }",
    "  }",
    "",
    "  # delete extra template slides so final count matches requested pages",
    "  if ($keepCount -ge 1 -and $pres.Slides.Count -gt $keepCount) {",
    "    for ($i = $pres.Slides.Count; $i -gt $keepCount; $i--) {",
    "      try { $pres.Slides.Item($i).Delete() } catch {}",
    "    }",
    "  }",
    "",
    "  $pres.SaveAs($OutputPath, 24)",
    "  $pres.Close()",
    "  $ppt.Quit()",
    "  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null",
    "  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null",
    "  [GC]::Collect()",
    "  [GC]::WaitForPendingFinalizers()",
    "",
    "  $info = @{ ok = $true; outputPath = $OutputPath; engine = 'local-powerpoint-com' }",
    "  $info | ConvertTo-Json -Depth 5 -Compress",
    "} catch {",
    "  if ($pres -ne $null) { try { $pres.Close() } catch {} }",
    "  if ($ppt -ne $null) { try { $ppt.Quit() } catch {} }",
    "  $err = @{ ok = $false; reason = [string]$_.Exception.Message }",
    "  $err | ConvertTo-Json -Depth 5 -Compress",
    "  exit 1",
    "}",
  ].join("\r\n");
}

async function buildPowerPointComPptx(contract) {
  if (!isPowerPointComEnabled()) {
    return { ok: false, reason: "powerpoint_com_disabled" };
  }
  if (shouldShortCircuitPowerPointCom()) {
    return {
      ok: false,
      reason: `powerpoint_com_circuit_open:${powerPointComCircuitReason}`,
    };
  }
  if (process.platform !== "win32") {
    return { ok: false, reason: "powerpoint_com_windows_only" };
  }

  const b64 = String((contract && contract.templateFileBase64) || "").trim();
  const templateBuffer = parseBase64Payload(b64);
  if (!templateBuffer.length) {
    return { ok: false, reason: "powerpoint_com_template_required" };
  }

  const workDir = path.join(
    os.tmpdir(),
    `daymori-com-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
  );
  const templatePath = path.join(workDir, "template.pptx");
  const payloadPath = path.join(workDir, "payload.json");
  const scriptPath = path.join(workDir, "run-com-export.ps1");
  const outputPath = path.join(workDir, "output.pptx");

  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(templatePath, templateBuffer);
    fs.writeFileSync(
      payloadPath,
      toAsciiJson(buildPowerPointComContractPayload(contract)),
      "utf8",
    );
    // 关键：.ps1 必须带 UTF-8 BOM，否则 PowerShell 5.1 会按 ANSI 解析脚本，
    // 导致 COM 写入的中文被降级成 "?"（脚本本身保持纯 ASCII，双保险）。
    fs.writeFileSync(scriptPath, "\ufeff" + buildPowerPointComScript(), "utf8");

    const timeoutMs = getPowerPointComTimeoutMs();
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-TemplatePath",
        templatePath,
        "-PayloadPath",
        payloadPath,
        "-OutputPath",
        outputPath,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    if (ps.error) {
      return {
        ok: false,
        reason: `powerpoint_com_exec_error:${sanitizeAuditDetail(ps.error.message || String(ps.error))}`,
      };
    }

    const stdout = String(ps.stdout || "").trim();
    const stderr = String(ps.stderr || "").trim();
    if (ps.status !== 0) {
      const detail = sanitizeAuditDetail(
        stderr || stdout || `exit_${ps.status}`,
      );
      // If Office disallows hidden window mode, avoid repeated COM retries in this process.
      if (/hiding the application window is not allowed/i.test(detail)) {
        markPowerPointComCircuit("hidden_not_allowed");
      }
      return { ok: false, reason: `powerpoint_com_failed:${detail}` };
    }

    if (!fs.existsSync(outputPath)) {
      return { ok: false, reason: "powerpoint_com_no_output" };
    }

    try {
      sanitizeTeachingForbiddenTermsInPptx(outputPath, contract);
    } catch {}
    try {
      sanitizeTemplatePlaceholderTermsInPptx(outputPath, contract);
    } catch {}

    const outBuffer = fs.readFileSync(outputPath);
    if (!outBuffer.length) {
      return { ok: false, reason: "powerpoint_com_empty_output" };
    }

    return {
      ok: true,
      engine: "local-powerpoint-com",
      fileName: `${sanitizeFileName(contract.topic)}.pptx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: outBuffer,
    };
  } catch (error) {
    const detail = sanitizeAuditDetail(
      error && error.message ? error.message : String(error),
    );
    if (/hiding the application window is not allowed/i.test(detail)) {
      markPowerPointComCircuit("hidden_not_allowed");
    }
    return { ok: false, reason: `powerpoint_com_exception:${detail}` };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

function normalizeHexColor(value) {
  const raw = String(value || "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
  if (raw.length >= 6) return raw.slice(0, 6);
  return "";
}

function resolveSysColorHex(val) {
  const key = String(val || "").toLowerCase();
  if (key === "windowtext") return "000000";
  if (key === "window") return "FFFFFF";
  return "";
}

function findSchemeColor(xml, tag) {
  const regex = new RegExp(
    `<a:${tag}>[\\s\\S]*?<a:(?:srgbClr|sysClr)\\s+([^>]+?)\\/?>(?:[\\s\\S]*?)<\\/a:${tag}>|<a:${tag}>[\\s\\S]*?<a:(?:srgbClr|sysClr)\\s+([^>]+?)\\/>(?:[\\s\\S]*?)<\\/a:${tag}>`,
    "i",
  );
  const m = xml.match(regex);
  const attrs = (m && (m[1] || m[2])) || "";
  const srgb = attrs.match(/val=\"([0-9a-fA-F]{6})\"/i);
  if (srgb && srgb[1]) return normalizeHexColor(srgb[1]);
  const sys = attrs.match(/lastClr=\"([0-9a-fA-F]{6})\"/i);
  if (sys && sys[1]) return normalizeHexColor(sys[1]);
  const sysVal = attrs.match(/val=\"([a-zA-Z]+)\"/);
  if (sysVal && sysVal[1]) return resolveSysColorHex(sysVal[1]);
  return "";
}

function parseThemeFonts(xml) {
  const major = xml.match(
    /<a:majorFont>[\s\S]*?<a:latin[^>]*typeface=\"([^\"]+)\"/i,
  );
  const minor = xml.match(
    /<a:minorFont>[\s\S]*?<a:latin[^>]*typeface=\"([^\"]+)\"/i,
  );
  return {
    titleFont: major && major[1] ? String(major[1]).trim() : "",
    bodyFont: minor && minor[1] ? String(minor[1]).trim() : "",
  };
}

function parseTemplateThemeFromPptxBuffer(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry("ppt/theme/theme1.xml");
    if (!entry) return null;
    const xml = entry.getData().toString("utf8");
    const dk1 = findSchemeColor(xml, "dk1") || "12100F";
    const lt1 = findSchemeColor(xml, "lt1") || "FFFFFF";
    const accent1 = findSchemeColor(xml, "accent1") || "2D6CDF";
    const accent2 = findSchemeColor(xml, "accent2") || accent1;
    const accent3 = findSchemeColor(xml, "accent3") || "A5A5A5";
    const fonts = parseThemeFonts(xml);

    return {
      palette: {
        bg: lt1,
        panel: lt1,
        panelSoft: normalizeHexColor(accent3) || "F2F4F8",
        line: normalizeHexColor(accent2) || "9BB8E6",
        title: dk1,
        text: dk1,
        muted: normalizeHexColor(accent3) || "667A99",
        accent: accent1,
        accentSoft: normalizeHexColor(accent2) || "DCE8FF",
      },
      fontPack: {
        title: fonts.titleFont || "Microsoft YaHei",
        body: fonts.bodyFont || "Microsoft YaHei",
      },
    };
  } catch {
    return null;
  }
}

function escapeRegexLiteral(input) {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXmlText(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeTeachingForbiddenTermsInPptx(filePath, contract) {
  try {
    const scene = String((contract && contract.sceneType) || "");
    const topic = String((contract && contract.topic) || "");
    const isEdu =
      /教务|教学|课堂|学生|初中|物理/i.test(scene) ||
      /牛顿|合力|加速度|受力|实验|例题|练习|作业|定律|公式/i.test(topic);
    if (!isEdu) return false;

    const forbiddenTerms = [
      "添加标题",
      "项目成果展示",
      "未来工作规划",
      "阶段工作概述",
      "工作完成进度",
      "目录",
      "CONTENT",
      "LOGO",
      "感谢聆听",
      "后续",
      "待完善",
      "示例",
      "占位",
      "当前需求",
    ];
    const slidePlans = Array.isArray(contract && contract.slides)
      ? contract.slides
      : [];
    const zip = new AdmZip(filePath);
    let touched = false;

    for (const entry of zip.getEntries()) {
      const name = String(entry.entryName || "");
      const m = name.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
      if (!m) continue;
      const slideIndex = Number(m[1] || 0);
      const plan = slidePlans[slideIndex - 1] || {};
      const title = String(plan.title || "").trim();
      let xml = entry.getData().toString("utf8");
      const before = xml;

      for (const term of forbiddenTerms) {
        const escaped = escapeRegexLiteral(term);
        const wholeTag = new RegExp(`<a:t>\\s*${escaped}\\s*<\\/a:t>`, "gi");
        if (term === "添加标题" && title) {
          xml = xml.replace(wholeTag, `<a:t>${escapeXmlText(title)}</a:t>`);
        } else {
          xml = xml.replace(wholeTag, "<a:t></a:t>");
        }
      }

      if (xml !== before) {
        touched = true;
        zip.updateFile(name, Buffer.from(xml, "utf8"));
      }
    }

    if (touched) zip.writeZip(filePath);
    return touched;
  } catch {
    return false;
  }
}

function sanitizeTemplatePlaceholderTermsInPptx(filePath, contract = null) {
  try {
    const zip = new AdmZip(filePath);
    const plans = Array.isArray(contract && contract.slides)
      ? contract.slides
      : [];
    const patterns = [
      /OfficePLUS/gi,
      /20XX/gi,
      /202X/gi,
      /时间[:：]/gi,
      /\/05\/01/gi,
      /时间[:：]\s*202X\/?\d*\/?\d*/gi,
      /输入标题/gi,
      /请在此输入[^<]{0,120}/gi,
      /您的文字内容或者到此处[^<]{0,120}/gi,
      /click\s*to\s*add[^<]{0,80}/gi,
      /placeholder/gi,
      /template/gi,
    ];

    let touched = false;
    for (const entry of zip.getEntries()) {
      const name = String(entry.entryName || "");
      const m = name.match(/^ppt\/slides\/slide(\d+)\.xml$/i);
      if (!m) continue;
      const slideIndex = Number(m[1] || 0);
      const plan = plans[slideIndex - 1] || {};
      const planType = normalizeScriptType(
        (plan && plan.scriptType) || (plan && plan.slideType) || "",
        slideIndex,
      );
      const before = entry.getData().toString("utf8");
      const after = before.replace(/<a:t>([\s\S]*?)<\/a:t>/g, (full, inner) => {
        let text = String(inner || "");
        for (const re of patterns) text = text.replace(re, "");
        if (planType !== "section")
          text = text.replace(/\bPART\s*0?\d+\b/gi, "");
        if (planType !== "content_bullets")
          text = text.replace(/^\s*[1234]\s*$/g, "");
        text = text.replace(/\s{2,}/g, " ").trim();
        return `<a:t>${escapeXmlText(text)}</a:t>`;
      });
      if (after !== before) {
        touched = true;
        zip.updateFile(name, Buffer.from(after, "utf8"));
      }
    }
    if (touched) zip.writeZip(filePath);
    return touched;
  } catch {
    return false;
  }
}

function resolveTemplateThemeOverride(contract) {
  const b64 = String((contract && contract.templateFileBase64) || "").trim();
  if (!b64) return null;
  const buffer = parseBase64Payload(b64);
  if (!buffer.length) return null;
  return parseTemplateThemeFromPptxBuffer(buffer);
}

function getAipptExportConfig() {
  const provider = String(process.env.AIPPT_PROVIDER || "generic")
    .toLowerCase()
    .trim();
  const endpointRaw = String(process.env.AIPPT_API_ENDPOINT || "").trim();
  const apiKey = String(process.env.AIPPT_API_KEY || "").trim();
  const model = String(process.env.AIPPT_API_MODEL || "").trim();
  const authMode = String(process.env.AIPPT_API_AUTH_MODE || "bearer")
    .toLowerCase()
    .trim();
  const keyHeader = String(
    process.env.AIPPT_API_KEY_HEADER || "x-api-key",
  ).trim();
  const lazymanEndpoint = String(process.env.LAZYMAN_API_ENDPOINT || "").trim();
  const extraHeaders = parseJsonSafe(process.env.AIPPT_API_EXTRA_HEADERS || "");
  const supportedProviders = new Set([
    "generic",
    "openai-compatible",
    "openai",
    "lazyman",
  ]);

  if (!supportedProviders.has(provider)) {
    throw new Error(`Unsupported AIPPT_PROVIDER: ${provider}`);
  }

  if (!["bearer", "header", "none"].includes(authMode)) {
    throw new Error(`Unsupported AIPPT_API_AUTH_MODE: ${authMode}`);
  }

  const endpoint =
    endpointRaw ||
    (provider === "openai"
      ? "https://api.openai.com/v1/chat/completions"
      : "") ||
    (provider === "lazyman" ? lazymanEndpoint : "");

  return {
    provider,
    endpoint,
    apiKey,
    model,
    authMode,
    keyHeader: keyHeader || "x-api-key",
    extraHeaders:
      extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {},
  };
}

function inspectOfficeplusExportConfig() {
  const comEnabled = isPowerPointComEnabled();
  const comProbe = comEnabled
    ? probePowerPointComRuntime()
    : { ok: false, reason: "powerpoint_com_disabled" };
  const comAvailable = comEnabled && !!comProbe.ok;
  let config = null;
  let configError = "";
  try {
    config = getAipptExportConfig();
  } catch (error) {
    configError = error && error.message ? error.message : String(error);
  }

  if (!config) {
    return {
      ready: false,
      officeplusLocalFallbackReady: true,
      officeplusComEnabled: comEnabled,
      officeplusComAvailable: comAvailable,
      officeplusComReason: comProbe.reason,
      issues: [sanitizeAuditDetail(configError || "aippt_config_invalid")],
      warnings: [],
      config: {
        provider:
          String(process.env.AIPPT_PROVIDER || "generic")
            .toLowerCase()
            .trim() || "generic",
        endpointConfigured: false,
        apiKeyConfigured: false,
        modelConfigured: false,
        authMode:
          String(process.env.AIPPT_API_AUTH_MODE || "bearer")
            .toLowerCase()
            .trim() || "bearer",
      },
    };
  }

  const issues = [];
  const warnings = [];
  const endpointConfigured = !!String(config.endpoint || "").trim();
  const apiKeyConfigured =
    config.authMode === "none" ? true : !!String(config.apiKey || "").trim();
  const modelConfigured = !!String(config.model || "").trim();

  if (!endpointConfigured) {
    issues.push("AIPPT_API_ENDPOINT/LAZYMAN_API_ENDPOINT 未配置");
  }
  if (!apiKeyConfigured) {
    issues.push("AIPPT_API_KEY 未配置（当前鉴权模式需要密钥）");
  }
  if (!modelConfigured) {
    warnings.push("AIPPT_API_MODEL 未配置，将使用默认模型，可能与上游不兼容");
  }
  if (config.provider === "generic") {
    warnings.push(
      "AIPPT_PROVIDER=generic 需要你的上游直接接受 contract 并返回 fileBase64/downloadUrl",
    );
  }
  if (
    config.provider === "lazyman" &&
    !String(process.env.LAZYMAN_API_ENDPOINT || "").trim() &&
    !String(process.env.AIPPT_API_ENDPOINT || "").trim()
  ) {
    issues.push("AIPPT_PROVIDER=lazyman 但未设置 LAZYMAN_API_ENDPOINT");
  }

  return {
    ready: issues.length === 0,
    officeplusLocalFallbackReady: true,
    officeplusComEnabled: comEnabled,
    officeplusComAvailable: comAvailable,
    officeplusComReason: comProbe.reason,
    issues,
    warnings,
    config: {
      provider: config.provider,
      endpointConfigured,
      endpointPreview: endpointConfigured
        ? String(config.endpoint).slice(0, 120)
        : "",
      apiKeyConfigured,
      modelConfigured,
      authMode: config.authMode,
      keyHeader: config.authMode === "header" ? config.keyHeader : "",
    },
  };
}

function buildAipptHeaders(config) {
  const headers = {
    "Content-Type": "application/json",
  };

  if (config.authMode === "bearer" && config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  if (config.authMode === "header" && config.apiKey) {
    headers[config.keyHeader] = config.apiKey;
  }

  for (const [key, value] of Object.entries(config.extraHeaders || {})) {
    if (typeof value === "string" && key) {
      headers[key] = value;
    }
  }

  return headers;
}

function buildAipptRequestPayload(config, contract) {
  if (
    config.provider === "openai-compatible" ||
    config.provider === "openai" ||
    config.provider === "lazyman"
  ) {
    return {
      model: config.model || "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: [
            "You are an AIPPT export adapter.",
            "Generate a PPTX file from the provided contract.",
            "Return JSON only, without markdown fences.",
            "JSON schema:",
            '{"fileBase64":"...","fileName":"...pptx","mimeType":"application/vnd.openxmlformats-officedocument.presentationml.presentation"}',
            "You may return downloadUrl instead of fileBase64 if supported.",
          ].join("\\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            task: "export_contract_to_pptx",
            contractVersion: contract.contractVersion,
            contract,
          }),
        },
      ],
      temperature: 0.1,
    };
  }

  return {
    model: config.model || undefined,
    contractVersion: contract.contractVersion,
    contract,
  };
}

function parseAipptResponsePayload(config, data) {
  if (
    config.provider === "openai-compatible" ||
    config.provider === "openai" ||
    config.provider === "lazyman"
  ) {
    const content = extractChatText(data);
    const jsonText = extractFirstJsonObject(content || "");
    if (!jsonText) return { ok: false, reason: "aippt_openai_no_json_payload" };
    try {
      return { ok: true, payload: JSON.parse(jsonText) };
    } catch {
      return { ok: false, reason: "aippt_openai_json_parse_error" };
    }
  }

  return { ok: true, payload: data || {} };
}

async function callAipptEngine(contract, config) {
  const endpoint = config.endpoint;
  const apiKey = config.apiKey;
  const requestPayload = buildAipptRequestPayload(config, contract);

  const requiresApiKey = config.authMode !== "none";
  if (!endpoint || (requiresApiKey && !apiKey)) {
    return { ok: false, reason: "aippt_not_configured" };
  }

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: buildAipptHeaders(config),
      body: JSON.stringify(requestPayload),
    });
  } catch (error) {
    return {
      ok: false,
      reason: sanitizeAuditDetail(describeUpstreamError(error)),
    };
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    return {
      ok: false,
      reason: `aippt_http_${upstream.status}:${sanitizeAuditDetail(rawText)}`,
    };
  }

  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    return { ok: false, reason: "aippt_non_json_response" };
  }

  const parsedPayload = parseAipptResponsePayload(config, data);
  if (!parsedPayload.ok) {
    return { ok: false, reason: parsedPayload.reason };
  }

  const payload = parsedPayload.payload;

  if (payload.downloadUrl) {
    try {
      const fileResp = await fetch(String(payload.downloadUrl));
      if (!fileResp.ok)
        return { ok: false, reason: `aippt_download_${fileResp.status}` };
      const arr = await fileResp.arrayBuffer();
      return {
        ok: true,
        engine: `upstream-aippt-${config.provider}`,
        fileName: String(
          payload.fileName || `${sanitizeFileName(contract.topic)}.pptx`,
        ),
        mimeType: String(
          payload.mimeType ||
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        buffer: Buffer.from(arr),
        llmTrace: {
          prompt: JSON.stringify(requestPayload),
          response: data,
        },
      };
    } catch (error) {
      return {
        ok: false,
        reason: sanitizeAuditDetail(describeUpstreamError(error)),
      };
    }
  }

  const b64 = payload.fileBase64 || payload.pptxBase64 || "";
  const bin = parseBase64Payload(b64);
  if (!bin.length) {
    return { ok: false, reason: "aippt_no_file_payload" };
  }

  return {
    ok: true,
    engine: `upstream-aippt-${config.provider}`,
    fileName: String(
      payload.fileName || `${sanitizeFileName(contract.topic)}.pptx`,
    ),
    mimeType: String(
      payload.mimeType ||
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    buffer: bin,
    llmTrace: {
      prompt: JSON.stringify(requestPayload),
      response: data,
    },
  };
}

async function buildLocalPptx(contract) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Daymori";
  pptx.company = "Daymori";
  pptx.subject = contract.sceneType;
  pptx.title = `${contract.topic} - ${contract.sceneType}`;

  const narrativeMode = String(contract.narrativeMode || "standard");
  const sceneTopicText =
    `${String(contract.sceneType || "")} ${String(contract.topic || "")} ${String(contract.visualStyle || "")}`.toLowerCase();

  const standardPalette = {
    bg: "12100F",
    panel: "1A1715",
    panelSoft: "26211D",
    line: "4A3A2D",
    title: "F4E5D4",
    text: "EAD8C4",
    muted: "B89E83",
    accent: "8A5B38",
    accentSoft: "2F241D",
  };

  const lazymanPalette = {
    bg: "111111",
    panel: "181614",
    panelSoft: "25211D",
    line: "4A3A2D",
    title: "F5E7D8",
    text: "E9D7C3",
    muted: "B79E83",
    accent: "7A5130",
    accentSoft: "2E241D",
  };

  const eduSciencePalette = {
    bg: "F3F8FF",
    panel: "FFFFFF",
    panelSoft: "E7F0FF",
    line: "9BB8E6",
    title: "0E2A56",
    text: "173965",
    muted: "456A96",
    accent: "2D6CDF",
    accentSoft: "DCE8FF",
  };

  const warmTeachingPalette = {
    bg: "FFF8F0",
    panel: "FFFFFF",
    panelSoft: "FFEED9",
    line: "E6C59A",
    title: "5A2E12",
    text: "6B3B1D",
    muted: "8A5B3B",
    accent: "D17A2A",
    accentSoft: "FFE5CC",
  };
  const isEduScene = /教务|教学|课堂|学生|初中|物理|牛顿|力学|实验/.test(
    sceneTopicText,
  );
  const isWarmTheme = /语文|历史|地理|文科|暖色|橙/.test(sceneTopicText);
  const templateThemeOverride = resolveTemplateThemeOverride(contract);
  let palette = isEduScene
    ? isWarmTheme
      ? warmTeachingPalette
      : eduSciencePalette
    : narrativeMode === "lazyman"
      ? lazymanPalette
      : standardPalette;

  if (templateThemeOverride && templateThemeOverride.palette) {
    palette = {
      ...palette,
      ...templateThemeOverride.palette,
    };
  }

  function srgbToLinear(v) {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(hex) {
    const t = String(hex || "000000")
      .replace(/[^0-9a-fA-F]/g, "")
      .slice(0, 6)
      .padEnd(6, "0");
    const r = parseInt(t.slice(0, 2), 16);
    const g = parseInt(t.slice(2, 4), 16);
    const b = parseInt(t.slice(4, 6), 16);
    return (
      0.2126 * srgbToLinear(r) +
      0.7152 * srgbToLinear(g) +
      0.0722 * srgbToLinear(b)
    );
  }

  function contrastRatio(hexA, hexB) {
    const l1 = luminance(hexA);
    const l2 = luminance(hexB);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Enforce readability floor: body >= 4.5:1, title >= 3:1.
  if (
    contrastRatio(palette.text, palette.panel) < 4.5 ||
    contrastRatio(palette.title, palette.panel) < 3
  ) {
    palette = isEduScene ? eduSciencePalette : standardPalette;
  }

  const fontTheme = String(contract.fontTheme || "business-cn");
  const chartStyle = String(contract.chartStyle || "calm");
  const fontMap = {
    "business-cn": { title: "Microsoft YaHei", body: "Microsoft YaHei" },
    "serif-cn": { title: "SimSun", body: "SimSun" },
    "modern-cn": { title: "Microsoft JhengHei", body: "Microsoft YaHei" },
  };
  let fontPack = fontMap[fontTheme] || fontMap["business-cn"];
  if (templateThemeOverride && templateThemeOverride.fontPack) {
    fontPack = {
      title: String(templateThemeOverride.fontPack.title || fontPack.title),
      body: String(templateThemeOverride.fontPack.body || fontPack.body),
    };
  }

  const chartStyleMap = {
    calm: { color: palette.accent, symbol: "circle" },
    contrast: { color: isEduScene ? "2D6CDF" : "A97A52", symbol: "diamond" },
    growth: { color: isEduScene ? "1B8AA6" : "6E4A2F", symbol: "triangle" },
  };
  const chartPack = chartStyleMap[chartStyle] || chartStyleMap.calm;

  const storyLabels =
    narrativeMode === "lazyman"
      ? [
          "董事会摘要",
          "关键目标",
          "数据证据",
          "问题归因",
          "执行动作",
          "战略补充",
        ]
      : [
          "封面总览",
          "目标对齐",
          "数据洞察",
          "问题归因",
          "行动落地",
          "补充说明",
        ];

  function cleanText(value, fallback = "") {
    const raw = String(value || fallback)
      .replace(/\s+/g, " ")
      .trim();
    return raw || fallback;
  }

  function safeList(items, fallback) {
    const out = Array.isArray(items)
      ? items.map((x) => cleanText(x)).filter(Boolean)
      : [];
    return out.length ? out : [fallback];
  }

  function shortText(text, max = 26) {
    const t = cleanText(text, "-");
    return t.length > max ? `${t.slice(0, max)}...` : t;
  }

  function toPptColor(hex, fallback) {
    const source = String(hex || "")
      .replace(/[^0-9a-fA-F]/g, "")
      .toUpperCase();
    if (source.length === 6) return source;
    if (source.length === 3)
      return source
        .split("")
        .map((c) => c + c)
        .join("");
    return String(fallback || "000000")
      .replace(/[^0-9a-fA-F]/g, "")
      .toUpperCase()
      .slice(0, 6)
      .padEnd(6, "0");
  }

  function mixColor(hexA, hexB, ratio = 0.5) {
    const a = toPptColor(hexA, "000000");
    const b = toPptColor(hexB, "FFFFFF");
    const t = Math.max(0, Math.min(1, Number(ratio) || 0));
    const ch = (i) => {
      const av = parseInt(a.slice(i, i + 2), 16);
      const bv = parseInt(b.slice(i, i + 2), 16);
      const v = Math.round(av * (1 - t) + bv * t);
      return v.toString(16).padStart(2, "0");
    };
    return `${ch(0)}${ch(2)}${ch(4)}`.toUpperCase();
  }

  function resolveSlideVisual(slideSpec, basePalette) {
    const vt = (slideSpec && slideSpec.visualTokens) || {};
    const vtPalette =
      vt && vt.palette && typeof vt.palette === "object" ? vt.palette : {};
    const slidePalette = {
      bg: toPptColor(vtPalette.bg, basePalette.bg),
      panel: toPptColor(vtPalette.surface, basePalette.panel),
      panelSoft: toPptColor(vtPalette.surface, basePalette.panelSoft),
      line: toPptColor(vtPalette.accent, basePalette.line),
      title: toPptColor(vtPalette.title, basePalette.title),
      text: toPptColor(vtPalette.body, basePalette.text),
      muted: toPptColor(vtPalette.body, basePalette.muted),
      accent: toPptColor(vtPalette.accent, basePalette.accent),
      accentSoft: mixColor(
        toPptColor(vtPalette.accent, basePalette.accent),
        toPptColor(vtPalette.surface, basePalette.panelSoft),
        0.7,
      ),
    };

    const typeScale =
      vt && vt.typeScale && typeof vt.typeScale === "object"
        ? vt.typeScale
        : {};
    const layout =
      vt && vt.layout && typeof vt.layout === "object" ? vt.layout : {};
    const shapeStyle =
      vt && vt.shapeStyle && typeof vt.shapeStyle === "object"
        ? vt.shapeStyle
        : {};

    const titleSize = Math.max(20, Math.min(44, Number(typeScale.title) || 25));
    const bodySize = Math.max(9, Math.min(16, Number(typeScale.body) || 11.5));
    const noteSize = Math.max(8, Math.min(14, Number(typeScale.note) || 10.5));
    const columns = Math.max(1, Math.min(2, Number(layout.columns) || 1));
    const gap = Math.max(0.12, Math.min(0.52, (Number(layout.gap) || 8) / 28));
    const padding = Math.max(
      0.7,
      Math.min(1.35, (Number(layout.padding) || 11) / 10),
    );
    const accentShape = String(shapeStyle.accent || "bar").toLowerCase();

    return {
      palette: slidePalette,
      titleSize,
      bodySize,
      noteSize,
      columns,
      gap,
      padding,
      accentShape,
    };
  }

  function extractNumericHints(slideSpec) {
    const source = [
      slideSpec.title,
      slideSpec.goal,
      ...(slideSpec.keyPoints || []),
    ].join(" ");
    const percentMatches = [...source.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)].map(
      (m) => Number(m[1]),
    );
    const numberMatches = [...source.matchAll(/(-?\d+(?:\.\d+)?)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n));
    const values = [...percentMatches, ...numberMatches]
      .filter((n) => n >= 0)
      .slice(0, 6);
    return values;
  }

  function buildTakeaway(slideSpec) {
    const lead = cleanText(slideSpec.goal, "本页聚焦关键结论与行动");
    const first = safeList(slideSpec.keyPoints, "形成统一执行口径")[0];
    return `本页重点：${lead}；课堂抓手：${first}`;
  }

  function isDataLikeSlide(slideSpec, pageIndex) {
    const lt = String(slideSpec.layoutType || "");
    if (lt === "evidence-chart" || lt === "risk-heatmap") return true;
    if (pageIndex === 3 || pageIndex === 4) return true;
    const text = [
      slideSpec.title,
      slideSpec.goal,
      ...(slideSpec.keyPoints || []),
    ].join(" ");
    return /(数据|趋势|同比|环比|增长|收入|成本|转化|问题|风险|指标)/.test(
      text,
    );
  }

  function isStrategyLikeSlide(slideSpec) {
    const lt = String(slideSpec.layoutType || "");
    if (lt === "strategy-compare" || lt === "roadmap-timeline") return true;
    const text = [
      slideSpec.title,
      slideSpec.goal,
      ...(slideSpec.keyPoints || []),
    ].join(" ");
    return /(策略|路径|实施|里程碑|试点|验收|预算|资源)/.test(text);
  }

  function isDecisionLikeSlide(slideSpec, pageIndex, totalSlides) {
    const lt = String(slideSpec.layoutType || "");
    if (lt === "decision-board") return true;
    if (pageIndex === totalSlides) return true;
    const text = [
      slideSpec.title,
      slideSpec.goal,
      ...(slideSpec.keyPoints || []),
    ].join(" ");
    return /(决策|下一步|拍板|行动建议|请求)/.test(text);
  }

  function addTeachingDiagram(slide, slideSpec, pageIndex) {
    const keyPoints = safeList(slideSpec.keyPoints, "补充关键教学要点")
      .slice(0, 3)
      .map((x) => shortText(x, 22));
    const left = 8.95;
    const top = 3.0;
    const boxW = 2.8;
    const boxH = 0.48;
    const gap = 0.2;
    const title = /实验/.test(`${slideSpec.title} ${slideSpec.goal}`)
      ? "实验流程图"
      : "受力示意流程";

    slide.addText(title, {
      x: left,
      y: 2.6,
      w: boxW,
      h: 0.28,
      fontSize: 10,
      bold: true,
      color: palette.accent,
      fontFace: fontPack.body,
    });

    for (let i = 0; i < keyPoints.length; i++) {
      const y = top + i * (boxH + gap);
      slide.addShape(pptx.ShapeType.roundRect, {
        x: left,
        y,
        w: boxW,
        h: boxH,
        radius: 0.05,
        fill: { color: i % 2 === 0 ? "EAF1FF" : "DDEBFF" },
        line: { color: "9BB8E6", pt: 1 },
      });
      slide.addText(`${i + 1}. ${keyPoints[i]}`, {
        x: left + 0.12,
        y: y + 0.12,
        w: boxW - 0.2,
        h: 0.25,
        fontSize: 9.5,
        color: "173965",
        fontFace: fontPack.body,
      });

      if (i < keyPoints.length - 1) {
        slide.addShape(pptx.ShapeType.chevron, {
          x: left + boxW / 2 - 0.09,
          y: y + boxH + 0.03,
          w: 0.18,
          h: 0.12,
          fill: { color: "2D6CDF" },
          line: { color: "2D6CDF", pt: 0.5 },
        });
      }
    }

    slide.addText(`课堂动作：第${pageIndex}页可安排30秒提问+60秒板演`, {
      x: left,
      y: 5.08,
      w: boxW,
      h: 0.34,
      fontSize: 9,
      color: "456A96",
      fontFace: fontPack.body,
    });
  }

  function chartSpecForSlide(slideSpec, pageIndex) {
    const labels = safeList(slideSpec.keyPoints, "关键指标")
      .slice(0, 3)
      .map((x) => shortText(x, 12));
    const hinted = extractNumericHints(slideSpec).slice(0, 3);
    let values = hinted;
    if (values.length < labels.length) {
      const base = pageIndex === 4 ? [42, 31, 21] : [58, 66, 74];
      values = [...values, ...base].slice(0, labels.length);
    }
    values = values.map((n, i) => {
      const v = Number(n);
      if (!Number.isFinite(v)) return 40 + i * 12;
      if (v > 1000) return Math.round(v / 1000);
      return Math.max(5, Math.round(v));
    });

    const type = pageIndex === 4 ? pptx.ChartType.bar : pptx.ChartType.line;
    return {
      type,
      labels,
      values,
      seriesName: pageIndex === 4 ? "问题影响度" : "核心指标趋势",
    };
  }

  function addFooter(slide, index, total) {
    slide.addShape(pptx.ShapeType.line, {
      x: 0.6,
      y: 6.92,
      w: 12.1,
      h: 0,
      line: { color: palette.line, pt: 1 },
    });

    slide.addText(cleanText(contract.topic, "Daymori 演示文稿"), {
      x: 0.62,
      y: 6.95,
      w: 8.6,
      h: 0.28,
      fontSize: 9,
      color: palette.muted,
      fontFace: fontPack.body,
    });

    slide.addText(`${index}/${total}`, {
      x: 11.95,
      y: 6.95,
      w: 0.8,
      h: 0.28,
      align: "right",
      fontSize: 9,
      color: palette.muted,
      fontFace: fontPack.body,
    });
  }

  function renderCoverSlide(slide, ctx) {
    const {
      contentLeft,
      contentTop,
      contentW,
      slidePalette,
      visual,
      title,
      subtitle,
      footer,
      pageDate,
    } = ctx;
    slide.addShape(pptx.ShapeType.roundRect, {
      x: contentLeft,
      y: contentTop,
      w: contentW,
      h: 5.9,
      radius: 0.09,
      fill: { color: slidePalette.panel },
      line: { color: slidePalette.line, pt: 1.2 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: contentLeft,
      y: contentTop,
      w: contentW,
      h: 0.2,
      fill: { color: slidePalette.accent },
    });
    slide.addText(title, {
      x: contentLeft + 0.5,
      y: 1.8,
      w: contentW - 1,
      h: 1.2,
      fontSize: Math.max(30, visual.titleSize + 10),
      bold: true,
      color: slidePalette.title,
      fontFace: fontPack.title,
      align: "center",
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: contentLeft + 0.8,
        y: 3.2,
        w: contentW - 1.6,
        h: 0.6,
        fontSize: Math.max(14, visual.bodySize + 2),
        color: slidePalette.text,
        fontFace: fontPack.body,
        align: "center",
      });
    }
    const dateText = pageDate || new Date().toISOString().slice(0, 10);
    slide.addText(dateText, {
      x: contentLeft + 0.8,
      y: 4.9,
      w: contentW - 1.6,
      h: 0.35,
      fontSize: 11,
      color: slidePalette.muted,
      fontFace: fontPack.body,
      align: "center",
    });
    if (footer) {
      slide.addText(footer, {
        x: contentLeft + 0.8,
        y: 5.35,
        w: contentW - 1.6,
        h: 0.35,
        fontSize: 10,
        color: slidePalette.muted,
        fontFace: fontPack.body,
        align: "center",
      });
    }
  }

  function renderAgendaSlide(slide, ctx) {
    const {
      contentLeft,
      contentTop,
      contentW,
      contentH,
      slidePalette,
      title,
      keyPoints,
    } = ctx;
    slide.addShape(pptx.ShapeType.roundRect, {
      x: contentLeft,
      y: contentTop,
      w: contentW,
      h: contentH,
      radius: 0.09,
      fill: { color: slidePalette.panel },
      line: { color: slidePalette.line, pt: 1.2 },
    });
    slide.addText(title, {
      x: contentLeft + 0.45,
      y: 0.95,
      w: contentW - 0.9,
      h: 0.5,
      fontSize: 28,
      bold: true,
      color: slidePalette.title,
      fontFace: fontPack.title,
    });
    keyPoints.slice(0, 6).forEach((item, i) => {
      slide.addText(`${i + 1}. ${item}`, {
        x: contentLeft + 0.7,
        y: 1.9 + i * 0.66,
        w: contentW - 1.4,
        h: 0.45,
        fontSize: 16,
        color: slidePalette.text,
        fontFace: fontPack.body,
      });
    });
  }

  function renderSectionSlide(slide, ctx) {
    const {
      contentLeft,
      contentTop,
      contentW,
      contentH,
      slidePalette,
      title,
      subtitle,
      pageIndex,
    } = ctx;
    slide.addShape(pptx.ShapeType.roundRect, {
      x: contentLeft,
      y: contentTop,
      w: contentW,
      h: contentH,
      radius: 0.09,
      fill: { color: slidePalette.panel },
      line: { color: slidePalette.line, pt: 1.2 },
    });
    slide.addText(String(pageIndex).padStart(2, "0"), {
      x: contentLeft + 0.5,
      y: 1.5,
      w: 1.2,
      h: 0.8,
      fontSize: 34,
      bold: true,
      color: slidePalette.accent,
      fontFace: fontPack.title,
    });
    slide.addText(title, {
      x: contentLeft + 1.9,
      y: 1.7,
      w: contentW - 2.3,
      h: 0.9,
      fontSize: 30,
      bold: true,
      color: slidePalette.title,
      fontFace: fontPack.title,
    });
    if (subtitle) {
      slide.addText(subtitle, {
        x: contentLeft + 1.9,
        y: 2.85,
        w: contentW - 2.3,
        h: 0.6,
        fontSize: 15,
        color: slidePalette.text,
        fontFace: fontPack.body,
      });
    }
  }

  function renderContentSlide() {
    return false;
  }
  function renderComparisonSlide() {
    return false;
  }
  function renderProcessSlide() {
    return false;
  }
  function renderExampleSlide() {
    return false;
  }
  function renderExerciseSlide() {
    return false;
  }
  function renderSummarySlide() {
    return false;
  }
  function renderQaSlide() {
    return false;
  }

  const totalSlides = contract.slides.length;
  for (const slideSpec of contract.slides) {
    const slide = pptx.addSlide();
    const pageIndex = Number(slideSpec.index) || 1;
    const slideType = normalizeSlideType(
      slideSpec.slideType ||
        mapLayoutTypeToSlideType(slideSpec.layoutType, pageIndex),
      pageIndex,
    );
    const title = cleanText(slideSpec.title, `第${pageIndex}页`);
    const subtitle = cleanText(slideSpec.subtitle || slideSpec.goal, "");
    const goal = cleanText(
      slideSpec.goal || slideSpec.subtitle,
      "明确本页目标并输出可执行内容",
    );
    const keyPoints = safeList(
      slideSpec.bullets || slideSpec.keyPoints,
      "补充关键业务要点",
    )
      .map((x) =>
        String(x || "")
          .replace(/^(结论：|证据：|行动：)/, "")
          .trim(),
      )
      .filter(Boolean)
      .slice(0, 5);
    const assets = safeList(
      slideSpec.assetPlaceholders,
      "补充图表或配图",
    ).slice(0, 4);
    const notes =
      cleanText(
        slideSpec.notes || slideSpec.speakerNotes,
        "先讲核心观点，再给例题和练习。",
      ) || "-";
    const footer = cleanText(slideSpec.footer, "");
    const pageDate = cleanText(slideSpec.date, "");
    const takeaway = buildTakeaway(slideSpec);
    const dataLike = isDataLikeSlide(slideSpec, pageIndex);
    const visual = resolveSlideVisual(slideSpec, palette);
    const slidePalette = visual.palette;
    const contentLeft = visual.padding;
    const contentTop = 0.52;
    const contentW = 13.33 - visual.padding * 2;
    const contentH = 6.15;

    slide.background = { color: slidePalette.bg };

    const renderCtx = {
      contentLeft,
      contentTop,
      contentW,
      contentH,
      slidePalette,
      visual,
      title,
      subtitle,
      goal,
      keyPoints,
      footer,
      pageDate,
      pageIndex,
    };
    if (slideType === "cover") {
      renderCoverSlide(slide, renderCtx);
      addFooter(slide, pageIndex, totalSlides);
      continue;
    }
    if (slideType === "agenda") {
      renderAgendaSlide(slide, renderCtx);
      addFooter(slide, pageIndex, totalSlides);
      continue;
    }
    if (slideType === "section") {
      renderSectionSlide(slide, renderCtx);
      addFooter(slide, pageIndex, totalSlides);
      continue;
    }

    const isCover = false;
    if (isCover) {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft,
        y: contentTop,
        w: contentW,
        h: 5.9,
        radius: 0.09,
        fill: { color: slidePalette.panel },
        line: { color: slidePalette.line, pt: 1.2 },
      });

      slide.addShape(pptx.ShapeType.rect, {
        x: contentLeft,
        y: contentTop,
        w: contentW,
        h: 0.2,
        fill: { color: slidePalette.accent },
      });

      slide.addText(cleanText(contract.sceneType, "企业汇报"), {
        x: contentLeft + 0.38,
        y: 1.15,
        w: 4.8,
        h: 0.36,
        fontSize: 13,
        bold: true,
        color: slidePalette.accent,
        fontFace: fontPack.body,
      });

      slide.addText(
        storyLabels[Math.min(pageIndex - 1, storyLabels.length - 1)] ||
          "封面总览",
        {
          x: contentLeft + contentW - 6.15,
          y: 1.2,
          w: 5.95,
          h: 0.34,
          align: "right",
          fontSize: 11,
          color: slidePalette.muted,
          fontFace: fontPack.body,
        },
      );

      slide.addText(title, {
        x: contentLeft + 0.38,
        y: 1.62,
        w: contentW - 1.2,
        h: 1.35,
        fontSize: Math.max(30, visual.titleSize + 12),
        bold: true,
        color: slidePalette.title,
        fontFace: fontPack.title,
        valign: "top",
      });

      slide.addText(goal, {
        x: contentLeft + 0.38,
        y: 3.2,
        w: contentW - 1.2,
        h: 0.9,
        fontSize: Math.max(14, visual.bodySize + 3),
        color: slidePalette.text,
        fontFace: fontPack.body,
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft + 0.38,
        y: 4.35,
        w: contentW - 1.2,
        h: 1.25,
        radius: 0.06,
        fill: { color: slidePalette.accentSoft },
        line: { color: slidePalette.line, pt: 1 },
      });

      slide.addText(`关键要点：${keyPoints.join(" ｜ ")}`, {
        x: contentLeft + 0.63,
        y: 4.72,
        w: contentW - 1.7,
        h: 0.5,
        fontSize: Math.max(11, visual.bodySize + 1),
        color: slidePalette.text,
        fontFace: fontPack.body,
      });

      slide.addText(takeaway, {
        x: contentLeft + 0.38,
        y: 5.76,
        w: contentW - 1.2,
        h: 0.38,
        fontSize: Math.max(10, visual.noteSize),
        color: slidePalette.muted,
        fontFace: fontPack.body,
      });
    } else {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft,
        y: contentTop,
        w: contentW,
        h: contentH,
        radius: 0.09,
        fill: { color: slidePalette.panel },
        line: { color: slidePalette.line, pt: 1.2 },
      });

      slide.addText(title, {
        x: contentLeft + 0.33,
        y: 0.82,
        w: Math.max(6.8, contentW - 4.8),
        h: 0.5,
        fontSize: Math.max(20, visual.titleSize + 7),
        bold: true,
        color: slidePalette.title,
        fontFace: fontPack.title,
      });

      slide.addText(
        storyLabels[Math.min(pageIndex - 1, storyLabels.length - 1)] ||
          "补充说明",
        {
          x: contentLeft + contentW - 3.55,
          y: 1.29,
          w: 2.9,
          h: 0.22,
          align: "right",
          fontSize: 9,
          color: slidePalette.muted,
          fontFace: fontPack.body,
        },
      );

      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft + contentW - 3.05,
        y: 0.78,
        w: 2.6,
        h: 0.48,
        radius: 0.08,
        fill: { color: slidePalette.panelSoft },
        line: { color: slidePalette.line, pt: 1 },
      });

      slide.addText(`目标：${goal.slice(0, 36)}`, {
        x: contentLeft + contentW - 2.89,
        y: 0.9,
        w: 2.26,
        h: 0.26,
        align: "center",
        fontSize: Math.max(9, visual.noteSize),
        color: slidePalette.accent,
        fontFace: fontPack.body,
      });

      if (visual.accentShape === "orb") {
        slide.addShape(pptx.ShapeType.ellipse, {
          x: contentLeft + contentW - 1.2,
          y: 0.5,
          w: 0.62,
          h: 0.62,
          fill: { color: slidePalette.accentSoft, transparency: 5 },
          line: { color: slidePalette.accent, pt: 0.6 },
        });
      } else if (visual.accentShape === "ribbon") {
        slide.addShape(pptx.ShapeType.chevron, {
          x: contentLeft + contentW - 1.95,
          y: 0.7,
          w: 1.35,
          h: 0.46,
          fill: { color: slidePalette.accent },
          line: { color: slidePalette.accent, pt: 0.5 },
        });
      } else if (visual.accentShape === "grid") {
        for (let i = 0; i < 3; i++) {
          slide.addShape(pptx.ShapeType.roundRect, {
            x: contentLeft + contentW - 2.05 + i * 0.42,
            y: 0.72,
            w: 0.3,
            h: 0.3,
            radius: 0.03,
            fill: { color: slidePalette.accentSoft },
            line: { color: slidePalette.accent, pt: 0.4 },
          });
        }
      } else {
        slide.addShape(pptx.ShapeType.rect, {
          x: contentLeft + contentW - 1.25,
          y: 0.74,
          w: 0.62,
          h: 0.12,
          fill: { color: slidePalette.accent },
        });
      }

      const mainX = contentLeft + 0.33;
      const mainY = 1.52;
      const mainW =
        visual.columns === 2
          ? Math.max(4.8, contentW - 4.4)
          : Math.max(6.4, contentW - 4.2);
      const assetX = mainX + mainW + visual.gap;
      const assetW = Math.max(2.55, contentLeft + contentW - assetX - 0.35);

      slide.addShape(pptx.ShapeType.roundRect, {
        x: mainX,
        y: mainY,
        w: mainW,
        h: 3.9,
        radius: 0.06,
        fill: {
          color: isEduScene
            ? "FFFFFF"
            : mixColor(slidePalette.panel, "000000", 0.18),
        },
        line: { color: slidePalette.line, pt: 1 },
      });

      slide.addText(takeaway, {
        x: mainX + 0.25,
        y: 1.62,
        w: mainW - 0.45,
        h: 0.38,
        fontSize: Math.max(9.5, visual.noteSize),
        bold: true,
        color: slidePalette.accent,
        fontFace: fontPack.body,
      });

      const strategyLike = isStrategyLikeSlide(slideSpec);
      const decisionLike = isDecisionLikeSlide(
        slideSpec,
        pageIndex,
        totalSlides,
      );
      const layoutType = String(slideSpec.layoutType || "");

      keyPoints.forEach((point, i) => {
        const row = visual.columns === 2 ? Math.floor(i / 2) : i;
        const col = visual.columns === 2 ? i % 2 : 0;
        const colGap = visual.columns === 2 ? 0.24 : 0;
        const blockW =
          visual.columns === 2 ? (mainW - 0.7 - colGap) / 2 : mainW - 0.57;
        const blockX = mainX + 0.25 + col * (blockW + colGap);
        const y = 2.06 + row * 0.8;
        const blockColor = isEduScene
          ? i % 2 === 0
            ? mixColor(slidePalette.accentSoft, "FFFFFF", 0.52)
            : mixColor(slidePalette.accentSoft, "FFFFFF", 0.35)
          : decisionLike
            ? i % 2 === 0
              ? mixColor(slidePalette.accentSoft, "FFFFFF", 0.52)
              : mixColor(slidePalette.accentSoft, "FFFFFF", 0.4)
            : i % 2 === 0
              ? mixColor(slidePalette.panel, "000000", 0.12)
              : mixColor(slidePalette.panel, "000000", 0.03);
        slide.addShape(pptx.ShapeType.roundRect, {
          x: blockX,
          y,
          w: blockW,
          h: 0.66,
          radius: 0.05,
          fill: { color: blockColor },
          line: {
            color: isEduScene
              ? mixColor(slidePalette.accent, "FFFFFF", 0.62)
              : mixColor(slidePalette.line, "FFFFFF", 0.18),
            pt: 0.8,
          },
        });

        slide.addText(`0${i + 1}`, {
          x: blockX + 0.14,
          y: y + 0.18,
          w: 0.35,
          h: 0.2,
          fontSize: Math.max(8.5, visual.noteSize - 1),
          bold: true,
          color: slidePalette.accent,
          fontFace: fontPack.body,
        });

        slide.addText(point.slice(0, 60), {
          x: blockX + 0.58,
          y: y + 0.12,
          w: blockW - 0.65,
          h: 0.4,
          fontSize: Math.max(11, visual.bodySize + 1.5),
          color: isEduScene
            ? toPptColor(slidePalette.text, "173965")
            : toPptColor(slidePalette.title, "F3E7D9"),
          fontFace: fontPack.body,
        });
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: assetX,
        y: 1.52,
        w: assetW,
        h: 3.9,
        radius: 0.06,
        fill: { color: slidePalette.panelSoft },
        line: { color: slidePalette.line, pt: 1 },
      });

      slide.addText("建议素材", {
        x: assetX + 0.25,
        y: 1.76,
        w: Math.max(2.0, assetW - 0.45),
        h: 0.3,
        fontSize: Math.max(11, visual.bodySize + 1),
        bold: true,
        color: slidePalette.accent,
        fontFace: fontPack.body,
      });

      if (isEduScene) {
        addTeachingDiagram(slide, slideSpec, pageIndex);
      } else if (dataLike) {
        const c = chartSpecForSlide(slideSpec, pageIndex);
        slide.addChart(
          c.type,
          [
            {
              name: c.seriesName,
              labels: c.labels,
              values: c.values,
            },
          ],
          {
            x: 8.95,
            y: 3.1,
            w: 2.95,
            h: 1.95,
            showLegend: false,
            valAxisTitle: "指数",
            catAxisLabelRotate: -25,
            valAxisMinVal: 0,
            valAxisMaxVal: Math.max(100, ...c.values) + 10,
            chartColors: [chartPack.color],
            lineSize: 2,
            lineDataSymbol: chartPack.symbol,
          },
        );
      }

      if (strategyLike) {
        slide.addShape(pptx.ShapeType.line, {
          x: mainX + 0.25,
          y: 4.72,
          w: mainW - 0.5,
          h: 0,
          line: { color: slidePalette.accent, pt: 1.4 },
        });
        slide.addText("执行里程碑：M1 方案确认 -> M2 试点落地 -> M3 规模推广", {
          x: mainX + 0.25,
          y: 4.8,
          w: mainW - 0.55,
          h: 0.32,
          fontSize: Math.max(9.5, visual.noteSize),
          bold: true,
          color: slidePalette.accent,
          fontFace: fontPack.body,
        });
      }

      if (decisionLike) {
        slide.addShape(pptx.ShapeType.roundRect, {
          x: assetX + 0.1,
          y: 5.52,
          w: Math.max(2.0, assetW - 0.2),
          h: 0.96,
          radius: 0.08,
          fill: { color: slidePalette.accentSoft },
          line: { color: slidePalette.accent, pt: 1 },
        });
        slide.addText("管理层决策请求\n批准试点预算与跨部门协同机制", {
          x: assetX + 0.26,
          y: 5.72,
          w: Math.max(1.7, assetW - 0.5),
          h: 0.56,
          fontSize: Math.max(9, visual.noteSize),
          bold: true,
          color: slidePalette.accent,
          fontFace: fontPack.body,
        });
      }

      assets.forEach((asset, i) => {
        slide.addText(`• ${asset.slice(0, 20)}`, {
          x: assetX + 0.25,
          y: 2.1 + i * 0.34,
          w: Math.max(1.8, assetW - 0.45),
          h: 0.25,
          fontSize: Math.max(9.5, visual.bodySize),
          color: slidePalette.text,
          fontFace: fontPack.body,
        });
      });

      const noteFill =
        layoutType === "decision-board"
          ? slidePalette.accentSoft
          : isEduScene
            ? mixColor(slidePalette.accentSoft, "FFFFFF", 0.45)
            : mixColor(slidePalette.panel, "000000", 0.2);
      slide.addShape(pptx.ShapeType.roundRect, {
        x: contentLeft + 0.33,
        y: 5.52,
        w: contentW - 0.65,
        h: 0.96,
        radius: 0.05,
        fill: { color: noteFill },
        line: { color: slidePalette.line, pt: 1 },
      });

      slide.addText(`演讲备注：${notes.slice(0, 120)}`, {
        x: contentLeft + 0.53,
        y: 5.84,
        w: contentW - 1.05,
        h: 0.44,
        fontSize: Math.max(9.5, visual.noteSize),
        color: isEduScene
          ? toPptColor(slidePalette.muted, "365B88")
          : toPptColor(slidePalette.text, "E2CFB9"),
        fontFace: fontPack.body,
      });
    }

    addFooter(slide, pageIndex, totalSlides);
  }

  const stream = await pptx.write({ outputType: "nodebuffer" });
  return {
    ok: true,
    engine: "local-pptxgenjs",
    fileName: `${sanitizeFileName(contract.topic)}.pptx`,
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(stream),
  };
}

async function buildPptExportResult(contract) {
  const exportConfig = getAipptExportConfig();
  const templateModel = resolveTemplateSemanticModel(contract);
  const officeplusMode =
    String((contract && contract.templateSource) || "").toLowerCase() ===
    "officeplus";
  const forceCodegenOnly =
    String(process.env.PPT_FORCE_CODEGEN_ONLY || "false").toLowerCase() !==
    "false";
  const templateRequired = true;
  const hasTemplateFile = !!String(
    (contract && contract.templateFileBase64) || "",
  ).trim();
  let result = null;

  const annotateQuality = (candidate, usedContract) => {
    if (!candidate || !candidate.ok || !candidate.buffer) return candidate;
    candidate.layoutQuality = evaluateLayoutQualityAgainstModel(
      templateModel,
      candidate.buffer,
      usedContract,
    );
    candidate.contentQuality = evaluateContentQualityFromOutputBuffer(
      candidate.buffer,
      usedContract,
    );
    candidate.teachingQuality = evaluateTeachingQualityFromOutputBuffer(
      candidate.buffer,
      usedContract,
    );
    candidate.diagnostics = buildPageDiagnostics(
      candidate.layoutQuality,
      candidate.contentQuality,
      usedContract,
    );
    return candidate;
  };

  const candidatePenalty = (candidate) => {
    if (!candidate || !candidate.ok) return 999999;
    const diag = candidate.diagnostics || {};
    const lq = candidate.layoutQuality || {};
    const cq = candidate.contentQuality || {};
    const failedSlides = Number(diag.failedSlideCount || 0);
    const layoutPenalty = Math.max(0, 100 - Number(lq.score || 0));
    const expectedMiss = Number(lq.expectedMissCount || 0);
    const coveragePenalty = Math.max(
      0,
      Math.round((1 - Number(cq.contentCoverage || 0)) * 100),
    );
    return (
      failedSlides * 1000 +
      expectedMiss * 50 +
      coveragePenalty * 8 +
      layoutPenalty
    );
  };

  const pickBetterCandidate = (current, challenger) => {
    if (!current || !current.ok) return challenger;
    if (!challenger || !challenger.ok) return current;
    const a = candidatePenalty(current);
    const b = candidatePenalty(challenger);
    return b < a ? challenger : current;
  };

  if (
    !templateRequired &&
    (forceCodegenOnly || contract.codegenOnly === true)
  ) {
    result = await buildLocalPptx(contract);
    if (result && result.ok && result.buffer) {
      annotateQuality(result, contract);
      result.fallbackReason = "codegen_only_clean_layout";
    }
    return {
      result,
      exportConfig,
    };
  }

  if (templateRequired && !hasTemplateFile) {
    return {
      result: { ok: false, reason: "template_required_real_pptx" },
      exportConfig,
    };
  }

  if (officeplusMode || hasTemplateFile) {
    if (!String((contract && contract.templateFileBase64) || "").trim()) {
      return {
        result: { ok: false, reason: "officeplus_template_file_required" },
        exportConfig,
      };
    }
    const comResult = await buildPowerPointComPptx(contract);
    if (comResult && comResult.ok) {
      result = comResult;
      result.fallbackReason = "officeplus_template_first:local_powerpoint_com";
    } else {
      if (templateRequired) {
        return {
          result: {
            ok: false,
            reason: `template_render_failed:${(comResult && comResult.reason) || "unknown"}`,
          },
          exportConfig,
        };
      }
      const upstreamResult = await callAipptEngine(contract, exportConfig);
      if (upstreamResult && upstreamResult.ok) {
        result = upstreamResult;
        result.fallbackReason = `officeplus_com_failed_use_upstream:${(comResult && comResult.reason) || "unknown"}`;
      } else {
        result = await buildLocalPptx(contract);
        result.fallbackReason = `officeplus_local_fallback:${(comResult && comResult.reason) || (upstreamResult && upstreamResult.reason) || (result && result.reason) || "upstream_unavailable"}`;
      }
    }
    if (result && result.ok && result.buffer) {
      annotateQuality(result, contract);
      const mode = String(
        (contract && contract.layoutPolicy && contract.layoutPolicy.mode) ||
          "balanced",
      );
      const needsRemediation =
        mode === "balanced" &&
        result.diagnostics &&
        Number(result.diagnostics.failedSlideCount || 0) > 0;

      if (needsRemediation) {
        const retryContracts = [
          {
            ...contract,
            layoutPolicy: {
              ...(contract.layoutPolicy || {}),
              mode: "strict-layout",
              minScore: Math.max(
                84,
                Number(
                  contract &&
                    contract.layoutPolicy &&
                    contract.layoutPolicy.minScore,
                ) || 84,
              ),
            },
          },
          {
            ...contract,
            layoutPolicy: {
              ...(contract.layoutPolicy || {}),
              mode: "strict-content",
              minScore: Math.max(
                72,
                Number(
                  contract &&
                    contract.layoutPolicy &&
                    contract.layoutPolicy.minScore,
                ) || 72,
              ),
            },
          },
        ];

        for (const rc of retryContracts) {
          const retry = await buildPowerPointComPptx(rc);
          if (!retry || !retry.ok || !retry.buffer) continue;
          annotateQuality(retry, rc);
          retry.fallbackReason = `${result.fallbackReason || "officeplus_retry"}:retry_${String((rc.layoutPolicy && rc.layoutPolicy.mode) || "balanced")}`;
          result = pickBetterCandidate(result, retry);
        }
      }
    }
    return {
      result,
      exportConfig,
    };
  }

  if (String((contract && contract.templateFileBase64) || "").trim()) {
    const comResult = await buildPowerPointComPptx(contract);
    if (comResult && comResult.ok) {
      result = comResult;
      result.fallbackReason = "template_first_local_powerpoint_com";
    }
  }

  if (!result || !result.ok) {
    result = await callAipptEngine(contract, exportConfig);
  }

  if (!result.ok) {
    result = await buildLocalPptx(contract);
    result.fallbackReason = result.fallbackReason || "upstream_unavailable";
  }
  if (result && result.ok && result.buffer) annotateQuality(result, contract);
  return {
    result,
    exportConfig,
  };
}

function saveExportedPptToWorkspace(contract, result, options = {}) {
  const reqId = sanitizeFileName(
    (contract && contract.requestId) || crypto.randomUUID(),
  );
  const dir = path.join(
    __dirname,
    "docs",
    "benchmarks",
    "results",
    "exports",
    reqId,
  );
  fs.mkdirSync(dir, { recursive: true });
  const invalidTag = options && options.invalid ? "-invalid" : "";
  const fileName = `deck${invalidTag}.pptx`;
  const absPath = path.join(dir, fileName);
  fs.writeFileSync(absPath, result.buffer);
  const relPath = path.relative(__dirname, absPath).replace(/\\/g, "/");

  let diagnosticsRelPath = "";
  let diagnosticsAbsPath = "";
  if (
    result &&
    (result.layoutQuality ||
      result.contentQuality ||
      result.teachingQuality ||
      result.diagnostics)
  ) {
    const diagName = "quality.json";
    diagnosticsAbsPath = path.join(dir, diagName);
    const diagnosticsPayload = {
      generatedAt: new Date().toISOString(),
      topic: String((contract && contract.topic) || ""),
      templateSource: String(
        (contract && contract.templateSource) || "internal",
      ),
      templateFileName: String((contract && contract.templateFileName) || ""),
      engine: String((result && result.engine) || ""),
      fallbackReason: String((result && result.fallbackReason) || ""),
      layoutPolicy: (contract && contract.layoutPolicy) || null,
      layoutQuality: result.layoutQuality || null,
      contentQuality: result.contentQuality || null,
      teachingQuality: result.teachingQuality || null,
      diagnostics: result.diagnostics || null,
    };
    fs.writeFileSync(
      diagnosticsAbsPath,
      JSON.stringify(diagnosticsPayload, null, 2),
      "utf8",
    );
    diagnosticsRelPath = path
      .relative(__dirname, diagnosticsAbsPath)
      .replace(/\\/g, "/");
  }

  let dumpRelPath = "";
  let dumpAbsPath = "";
  if (result && result.textDump) {
    const dumpName = "dump.json";
    dumpAbsPath = path.join(dir, dumpName);
    const dumpPayload = {
      requestId: reqId,
      generatedAt: new Date().toISOString(),
      topic: String((contract && contract.topic) || ""),
      deckPlan: contract && contract.deckPlan ? contract.deckPlan : null,
      inputSlideCount: Number(result.textDump.inputSlideCount || 0),
      outputSlideCount: Number(result.textDump.outputSlideCount || 0),
      slideCount: Number(result.textDump.outputSlideCount || 0),
      slides: Array.isArray(result.textDump.slides)
        ? result.textDump.slides
        : [],
      validation: {
        ok: !!(result.deckValidation && result.deckValidation.ok),
        errors: Array.isArray(
          result.deckValidation && result.deckValidation.errors,
        )
          ? result.deckValidation.errors
          : [],
      },
      qualityScore: result.qualityScore || null,
    };
    fs.writeFileSync(dumpAbsPath, JSON.stringify(dumpPayload, null, 2), "utf8");
    dumpRelPath = path.relative(__dirname, dumpAbsPath).replace(/\\/g, "/");
  }

  const validationAbsPath = path.join(dir, "validation.json");
  const validationRelPath = path
    .relative(__dirname, validationAbsPath)
    .replace(/\\/g, "/");
  fs.writeFileSync(
    validationAbsPath,
    JSON.stringify(
      {
        requestId: reqId,
        ok: !!(result && result.deckValidation && result.deckValidation.ok),
        errors: Array.isArray(
          result && result.deckValidation && result.deckValidation.errors,
        )
          ? result.deckValidation.errors
          : [],
        qualityScore:
          result && result.qualityScore ? result.qualityScore : null,
      },
      null,
      2,
    ),
    "utf8",
  );

  const renderLogAbsPath = path.join(dir, "renderLog.json");
  const renderLogRelPath = path
    .relative(__dirname, renderLogAbsPath)
    .replace(/\\/g, "/");
  fs.writeFileSync(
    renderLogAbsPath,
    JSON.stringify(
      {
        requestId: reqId,
        inputSlideCount: Array.isArray(contract && contract.slides)
          ? contract.slides.length
          : 0,
        outputSlideCount: Number(
          (result && result.textDump && result.textDump.outputSlideCount) || 0,
        ),
        records: Array.isArray(contract && contract.slides)
          ? contract.slides.map((s, i) => ({
              sourceTemplateIndex: Number(s && s.templateIndex) || 0,
              outputSlideIndex: i + 1,
              slideType: String((s && (s.scriptType || s.slideType)) || ""),
              slideTitle: String((s && s.title) || ""),
            }))
          : [],
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    fileName,
    absPath,
    relPath,
    diagnosticsRelPath,
    diagnosticsAbsPath,
    dumpRelPath,
    dumpAbsPath,
    validationRelPath,
    validationAbsPath,
    renderLogRelPath,
    renderLogAbsPath,
  };
}

async function repairFailedSlidesFromQualitySidecar(
  contract,
  saved,
  currentResult,
) {
  if (!saved || !saved.absPath || !saved.diagnosticsAbsPath) {
    return { ok: false, reason: "repair_missing_saved_files" };
  }
  if (!isPowerPointComEnabled() || process.platform !== "win32") {
    return { ok: false, reason: "repair_requires_powerpoint_com" };
  }

  const failedIndexes = parseFailedSlideIndexesFromDiagnosticsFile(
    saved.diagnosticsAbsPath,
  );
  if (!failedIndexes.length) {
    return { ok: false, reason: "repair_no_failed_slides" };
  }

  const baseBuffer = fs.readFileSync(saved.absPath);
  if (!baseBuffer.length) {
    return { ok: false, reason: "repair_base_export_empty" };
  }

  const strictMin = Math.max(
    88,
    Number(
      contract && contract.layoutPolicy && contract.layoutPolicy.minScore,
    ) || 88,
  );
  const repairContract = {
    ...contract,
    templateSource: "officeplus",
    templateId: String((contract && contract.templateId) || "template-default"),
    templateFileName: path.basename(saved.absPath),
    templateFileBase64: baseBuffer.toString("base64"),
    repairSlideIndexes: failedIndexes,
    layoutPolicy: {
      ...(contract && contract.layoutPolicy ? contract.layoutPolicy : {}),
      mode: "strict-layout",
      minScore: strictMin,
    },
  };

  const repaired = await buildPowerPointComPptx(repairContract);
  if (!repaired || !repaired.ok || !repaired.buffer) {
    return {
      ok: false,
      reason: `repair_export_failed:${(repaired && repaired.reason) || "unknown"}`,
    };
  }

  const templateModel = resolveTemplateSemanticModel(contract);
  repaired.layoutQuality = evaluateLayoutQualityAgainstModel(
    templateModel,
    repaired.buffer,
    repairContract,
  );
  repaired.contentQuality = evaluateContentQualityFromOutputBuffer(
    repaired.buffer,
    repairContract,
  );
  repaired.teachingQuality = evaluateTeachingQualityFromOutputBuffer(
    repaired.buffer,
    repairContract,
  );
  repaired.diagnostics = buildPageDiagnostics(
    repaired.layoutQuality,
    repaired.contentQuality,
    repairContract,
  );
  repaired.fallbackReason = `${String((currentResult && currentResult.fallbackReason) || "")}::targeted_repair`;
  repaired.repairSlideIndexes = failedIndexes;

  return {
    ok: true,
    repairedResult: repaired,
    repairSlideIndexes: failedIndexes,
  };
}

async function callProviderText({
  providerConfig,
  systemPrompt,
  userPrompt,
  maxTokens = 520,
}) {
  if (providerConfig.type === "responses") {
    let upstream;
    try {
      upstream = await fetch(providerConfig.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${providerConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: providerConfig.model,
          input: `${systemPrompt}\n\n${userPrompt}`,
          max_output_tokens: maxTokens,
        }),
      });
    } catch (error) {
      return { ok: false, status: 502, detail: describeUpstreamError(error) };
    }

    const rawText = await upstream.text();
    if (!upstream.ok)
      return {
        ok: false,
        status: upstream.status,
        detail: rawText.slice(0, 1200),
      };

    let data = {};
    try {
      data = JSON.parse(rawText);
    } catch (error) {
      return {
        ok: false,
        status: 502,
        detail: `上游返回非JSON: ${rawText.slice(0, 300)}`,
      };
    }

    return { ok: true, text: data.output_text || "", raw: data };
  }

  let upstream;
  try {
    upstream = await fetch(providerConfig.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${providerConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: providerConfig.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        ...buildThinkingExtras(providerConfig.model),
      }),
    });
  } catch (error) {
    return { ok: false, status: 502, detail: describeUpstreamError(error) };
  }

  const rawText = await upstream.text();
  if (!upstream.ok)
    return {
      ok: false,
      status: upstream.status,
      detail: rawText.slice(0, 1200),
    };

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      detail: `上游返回非JSON: ${rawText.slice(0, 300)}`,
    };
  }

  return { ok: true, text: extractChatText(data), raw: data };
}

async function compilePromptWithRetry({ providerConfig, ingestorPack }) {
  const systemPrompt = [
    "你是语义编译器（Semantic Compiler），不是聊天助手。",
    "任务：将用户意图+文件骨架编译为高质量可直接执行的提示词。",
    "只允许输出严格 JSON，不要输出解释、markdown、代码块、前后缀。",
    "禁止输出推理过程。",
  ].join("\n");

  // Last-resort fallback: keep first meaningful lines instead of returning empty.
  if (!out.trim()) {
    const cleaned = text
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .slice(0, 5);
    if (cleaned.length) {
      out = cleaned.join("\n");
    }
  }
  const schemaSpec = [
    "JSON字段必须完整：",
    "goal: string",
    "audience: string",
    "style: string",
    "constraints: string[] (4-8条)",
    "successCriteria: string[] (3-6条)",
    "contextSummary: string (120-240字)",
    "finalPrompt: string (可直接复制使用)",
    "checklist: string[] (4-8条)",
  ].join("\n");

  const baseUserPrompt = [
    "[INTENT]",
    ingestorPack.intentRaw || "用户仅上传文件，未写额外意图",
    "",
    "[CONTEXT_STATS]",
    JSON.stringify(ingestorPack.contextStats, null, 2),
    "",
    "[HEADINGS]",
    ingestorPack.headings.join("\n") || "(none)",
    "",
    "[KEYWORDS]",
    ingestorPack.keywords.join(", ") || "(none)",
    "",
    "[KEY_SNIPPETS]",
    ingestorPack.keySnippets.join("\n") || "(none)",
    "",
    "[CONTEXT_BODY]",
    ingestorPack.contextBody,
    "",
    schemaSpec,
  ].join("\n");

  let lastReason = "unknown";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryHint =
      attempt === 0
        ? ""
        : `\n\n上一次输出不合规，原因: ${lastReason}。请只输出合规 JSON。`;
    const result = await callProviderText({
      providerConfig,
      systemPrompt,
      userPrompt: `${baseUserPrompt}${retryHint}`,
      maxTokens: 800,
    });

    if (!result.ok) {
      return result;
    }

    const jsonText = extractFirstJsonObject(result.text);
    if (!jsonText) {
      lastReason = "no_json_object";
      continue;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      lastReason = "json_parse_error";
      continue;
    }

    const valid = validateCompiledJson(parsed);
    if (!valid.ok) {
      lastReason = valid.reason;
      continue;
    }

    return {
      ok: true,
      compiled: parsed,
      raw: result.raw,
      compileRetries: attempt,
    };
  }

  return { ok: false, status: 422, detail: `结构化编译失败: ${lastReason}` };
}

async function callChatCompletions({
  endpoint,
  apiKey,
  model,
  system,
  input,
  maxTokens,
}) {
  let upstream;
  try {
    upstream = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: String(
                system || "你是高信息密度助手，回答要清晰、可执行、低废话。",
              ),
            },
            { role: "user", content: input },
          ],
          temperature: 0.2,
          max_tokens: Number.isFinite(maxTokens) ? maxTokens : 850,
          ...buildThinkingExtras(model),
        }),
      },
      LLM_FETCH_RETRY,
    );
  } catch (error) {
    return { ok: false, status: 502, detail: describeUpstreamError(error) };
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      detail: rawText.slice(0, 1200),
    };
  }

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      detail: `上游返回非JSON: ${rawText.slice(0, 300)}`,
    };
  }

  return { ok: true, data, text: extractChatText(data) };
}

async function callResponses({ endpoint, apiKey, model, input, maxTokens }) {
  let upstream;
  try {
    upstream = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input,
          max_output_tokens: Number.isFinite(maxTokens) ? maxTokens : 850,
        }),
      },
      LLM_FETCH_RETRY,
    );
  } catch (error) {
    return { ok: false, status: 502, detail: describeUpstreamError(error) };
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      detail: rawText.slice(0, 1200),
    };
  }

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      detail: `上游返回非JSON: ${rawText.slice(0, 300)}`,
    };
  }

  return { ok: true, data, text: data.output_text || "" };
}

function parseHotwordsInput(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .slice(0, 100);
  }
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr
          .map((x) => String(x || "").trim())
          .filter(Boolean)
          .slice(0, 100);
      }
    } catch {
      const split = raw
        .split(/[,，\n]/)
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .slice(0, 100);
      return split;
    }
  }
  return [];
}

async function callZhipuAsr({ apiKey, file, model, prompt, hotwords }) {
  const endpoint = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype || "audio/webm" });
  form.append("file", blob, file.originalname || "audio.webm");
  form.append("model", model || "glm-asr-2512");
  form.append("stream", "false");

  const cleanPrompt = sanitizeContractText(prompt || "", 2000);
  if (cleanPrompt) {
    form.append("prompt", cleanPrompt);
  }

  const hw = parseHotwordsInput(hotwords);
  if (hw.length > 0) {
    form.append("hotwords", JSON.stringify(hw));
  }

  let upstream;
  try {
    upstream = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: form,
      },
      LLM_FETCH_RETRY,
    );
  } catch (error) {
    return { ok: false, status: 502, detail: describeUpstreamError(error) };
  }

  const rawText = await upstream.text();
  if (!upstream.ok) {
    return {
      ok: false,
      status: upstream.status,
      detail: rawText.slice(0, 1200),
    };
  }

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return {
      ok: false,
      status: 502,
      detail: `上游返回非JSON: ${rawText.slice(0, 300)}`,
    };
  }

  return {
    ok: true,
    data,
    text: normalizeText(data && data.text ? data.text : ""),
  };
}

app.get("/api/audit/status", (req, res) => {
  return res.json({
    ok: true,
    auditEnabled: AUDIT_LOG_ENABLED,
    auditLogFile: AUDIT_LOG_FILE,
    allowedOriginsCount: ALLOWED_ORIGINS.length,
  });
});

app.get("/api/llm/runtime", (req, res) => {
  try {
    const cfg = getProviderConfig();
    return res.json({
      ok: true,
      provider: cfg.provider,
      model: cfg.model,
      endpoint: cfg.endpoint,
      apiKeyConfigured: !!cfg.apiKey,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "llm_runtime_read_failed",
      detail: error && error.message ? error.message : String(error),
    });
  }
});

app.post("/api/asr-zhipu", uploadAsr.single("file"), async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);

  try {
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 500,
        latencyMs: Date.now() - startedAt,
        reason: "missing_ZHIPU_API_KEY",
      });
      return res.status(500).json({
        ok: false,
        error: "missing_api_key",
        detail: "服务端未配置 ZHIPU_API_KEY",
      });
    }

    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 400,
        latencyMs: Date.now() - startedAt,
        reason: "asr_file_missing",
      });
      return res.status(400).json({ ok: false, error: "file is required" });
    }

    const asrModelRaw =
      req.body && typeof req.body.model === "string" ? req.body.model : "";
    const asrModel =
      sanitizeContractText(
        asrModelRaw || process.env.ZHIPU_ASR_MODEL || "glm-asr-2512",
        64,
      ) || "glm-asr-2512";
    const prompt =
      req.body && typeof req.body.prompt === "string" ? req.body.prompt : "";
    const hotwords = req.body ? req.body.hotwords : [];

    const result = await callZhipuAsr({
      apiKey,
      file,
      model: asrModel,
      prompt,
      hotwords,
    });

    if (!result.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: result.status,
        model: asrModel,
        latencyMs: Date.now() - startedAt,
        promptChars: String(prompt || "").length,
        reason: sanitizeAuditDetail(result.detail),
      });
      return res.status(result.status).json({
        ok: false,
        error: "zhipu_asr_error",
        detail: result.detail,
      });
    }

    const text = String(result.text || "").trim();
    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      model: asrModel,
      latencyMs: Date.now() - startedAt,
      inputBytes: Number(file.size || file.buffer.length || 0),
      outputChars: text.length,
    });

    return res.json({
      ok: true,
      provider: "zhipu",
      model: asrModel,
      text,
      requestId:
        result.data && result.data.request_id ? result.data.request_id : "",
    });
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(
        error && error.message ? error.message : String(error),
      ),
    });
    return res.status(500).json({
      ok: false,
      error: "asr_server_error",
      detail: error && error.message ? error.message : String(error),
    });
  }
});

app.get("/api/ppt/officeplus-status", (req, res) => {
  const inspection = inspectOfficeplusExportConfig();
  return res.json({
    ok: true,
    officeplusReady: inspection.ready,
    officeplusLocalFallbackReady: !!inspection.officeplusLocalFallbackReady,
    requiresTemplateFile: true,
    ...inspection,
  });
});

app.post("/api/ppt/open-local-template-workflow", (req, res) => {
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  const openOfficeplus = body.openOfficeplus === true;
  const openInbox = body.openInbox === true;
  const launched = launchPowerPointAndOpenInbox({ openOfficeplus, openInbox });
  if (!launched.ok) {
    return res.status(500).json({
      ok: false,
      error: "open_local_template_workflow_failed",
      detail: launched.reason || "unknown",
    });
  }
  return res.json({
    ok: true,
    inboxDir: launched.inboxDir,
    officeplusUrl: launched.officeplusUrl,
    inboxRelativePath: launched.inboxRelativePath,
    launchStatus: launched.launchStatus || null,
    steps: [
      "PowerPoint 已打开。",
      openOfficeplus
        ? "OfficePLUS 页面已打开；请你手动挑选模板。"
        : "如需挑选模板，请手动打开 OfficePLUS 页面。",
      openInbox
        ? "模板收件箱已打开。"
        : "如需查看模板收件箱，请手动打开该目录。",
      `模板收件箱路径: ${launched.inboxDir}`,
      "返回 Daymori 后执行 /ppt pp-sync 同步最新模板。",
    ],
  });
});

app.get("/api/ppt/template-inbox/latest", (req, res) => {
  try {
    const latest = getLatestInboxPptxFile();
    if (!latest) {
      return res.status(404).json({
        ok: false,
        error: "template_inbox_empty",
        detail: "模板收件箱为空，请先在 PowerPoint 中另存为一个 .pptx 模板。",
        inboxRelativePath: path
          .relative(__dirname, ensureOfficeplusTemplateInboxDir())
          .replace(/\\/g, "/"),
      });
    }

    const bin = fs.readFileSync(latest.absPath);
    return res.json({
      ok: true,
      fileName: latest.name,
      fileBase64: bin.toString("base64"),
      mtimeMs: Number(latest.stat.mtimeMs || 0),
      relativePath: path
        .relative(__dirname, latest.absPath)
        .replace(/\\/g, "/"),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "template_inbox_read_failed",
      detail: error && error.message ? error.message : String(error),
    });
  }
});

app.post("/api/llm-proxy", async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const providerConfig = getProviderConfig();
    const requestedModel =
      req.body && typeof req.body.model === "string"
        ? req.body.model.trim()
        : "";
    if (requestedModel) {
      if (providerConfig.provider === "deepseek") {
        providerConfig.model = requestedModel;
      } else if (
        providerConfig.provider === "qwen" &&
        /^qwen/i.test(requestedModel)
      ) {
        providerConfig.model = requestedModel;
      }
    }
    if (!providerConfig.apiKey) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 500,
        latencyMs: Date.now() - startedAt,
        reason: `missing_${providerConfig.keyEnv}`,
      });
      return res.status(500).json({
        error: "Missing API key",
        detail: `服务端未配置 ${providerConfig.keyEnv}，请在 .env 中设置后重启服务`,
      });
    }

    const system =
      req.body && typeof req.body.system === "string"
        ? req.body.system
        : "你是高信息密度助手，回答要清晰、可执行、低废话。";
    const userText =
      req.body && typeof req.body.userText === "string"
        ? req.body.userText
        : "";
    const maxTokensRaw =
      req.body && req.body.maxTokens ? Number(req.body.maxTokens) : 850;
    const maxTokens = Number.isFinite(maxTokensRaw)
      ? Math.min(Math.max(maxTokensRaw, 120), 8000)
      : 850;

    if (!userText.trim()) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 400,
        latencyMs: Date.now() - startedAt,
        reason: "empty_user_text",
      });
      return res.status(400).json({ error: "userText is required" });
    }

    let result;
    if (providerConfig.type === "responses") {
      result = await callResponses({
        endpoint: providerConfig.endpoint,
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        input: `${system}\n\n${userText}`,
        maxTokens,
      });
    } else {
      result = await callChatCompletions({
        endpoint: providerConfig.endpoint,
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        system,
        input: userText,
        maxTokens,
      });
    }

    if (!result.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: result.status,
        model: providerConfig.model,
        latencyMs: Date.now() - startedAt,
        promptChars: userText.length,
        reason: sanitizeAuditDetail(result.detail),
      });
      return res.status(result.status).json({
        error: `${providerConfig.provider} API error`,
        detail: result.detail,
      });
    }

    const text = typeof result.text === "string" ? result.text : "";
    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      model: providerConfig.model,
      latencyMs: Date.now() - startedAt,
      promptChars: userText.length,
      outputChars: text.length,
    });

    const usage = (result && result.data && result.data.usage) || null;
    return res.json({
      text,
      provider: providerConfig.provider,
      model: providerConfig.model,
      usage,
    });
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(
        error && error.message ? error.message : String(error),
      ),
    });
    return res.status(500).json({
      error: "Server error",
      detail: error && error.message ? error.message : String(error),
    });
  }
});

app.post("/api/chat", upload.array("files", 2), async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const providerConfig = getProviderConfig();
    if (!providerConfig.apiKey) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 500,
        latencyMs: Date.now() - startedAt,
        reason: `missing_${providerConfig.keyEnv}`,
      });
      return res.status(500).json({
        error: "Missing API key",
        detail: `服务端未配置 ${providerConfig.keyEnv}，请在 .env 中设置后重启服务`,
      });
    }

    const userInput = (
      req.body && req.body.message ? String(req.body.message) : ""
    ).trim();
    const files = Array.isArray(req.files) ? req.files : [];

    if (!userInput && files.length === 0) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 400,
        latencyMs: Date.now() - startedAt,
        reason: "empty_input_and_files",
      });
      return res.status(400).json({ error: "message or files is required" });
    }

    const fileContexts = await Promise.all(
      files.map(async (file, i) => {
        const content = await parseUploadedFile(file);
        const clipped =
          content.length > 12000
            ? `${content.slice(0, 12000)}\n...[已截断]`
            : content;
        const name =
          file && file.originalname
            ? String(file.originalname)
            : `file-${i + 1}`;
        return `文件${i + 1}: ${name}\n${clipped}`;
      }),
    );

    const ingestorPack = buildIngestorPack({ userInput, fileContexts });
    const result = await compilePromptWithRetry({
      providerConfig,
      ingestorPack,
    });

    if (!result.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: result.status,
        model: providerConfig.model,
        latencyMs: Date.now() - startedAt,
        promptChars: userInput.length,
        fileCount: files.length,
        reason: sanitizeAuditDetail(result.detail),
      });
      return res.status(result.status).json({
        error: `${providerConfig.provider} API error`,
        detail: result.detail,
      });
    }

    const compiled = result.compiled;
    const displayText = [
      `目标: ${compiled.goal}`,
      `受众: ${compiled.audience}`,
      `风格: ${compiled.style}`,
      "",
      "最终提示词:",
      compiled.finalPrompt,
    ].join("\n");

    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      model: providerConfig.model,
      latencyMs: Date.now() - startedAt,
      promptChars: userInput.length,
      fileCount: files.length,
      outputChars: compiled.finalPrompt.length,
      compileRetries: result.compileRetries,
    });

    return res.json({
      text: displayText,
      compiled,
      compileRetries: result.compileRetries,
      provider: providerConfig.provider,
      model: providerConfig.model,
      raw: result.raw,
    });
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(
        error && error.message ? error.message : String(error),
      ),
    });
    return res.status(500).json({
      error: "Server error",
      detail: error && error.message ? error.message : String(error),
    });
  }
});

app.post("/api/ppt/export", async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const requestContext = createRequestContext(
      req,
      req.body && req.body.contract ? req.body.contract : {},
    );
    const normalized = normalizeContract(
      req.body && req.body.contract,
      requestContext,
    );
    if (!normalized.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 422,
        latencyMs: Date.now() - startedAt,
        reason: normalized.reason,
      });
      writeDebugJson(
        requestContext,
        "validation.json",
        normalized.validation || {
          ok: false,
          errors: [
            {
              slideIndex: 0,
              type: "invalid_contract",
              text: normalized.reason,
              message: "请求合同不合法",
            },
          ],
        },
      );
      return res.status(422).json({
        error: "ppt_export_validation_failed",
        detail: normalized.reason,
        requestId: requestContext.requestId,
        validation: normalized.validation || null,
      });
    }

    const contract = normalized.contract;
    const { result, exportConfig } = await buildPptExportResult(contract);

    if (!result || !result.ok) {
      const detail = sanitizeAuditDetail(
        result && result.reason ? result.reason : "ppt_export_unavailable",
      );
      const layoutQuality =
        result && result.layoutQuality ? result.layoutQuality : null;
      const contentQuality =
        result && result.contentQuality ? result.contentQuality : null;
      const teachingQuality =
        result && result.teachingQuality ? result.teachingQuality : null;
      const diagnostics =
        result && result.diagnostics ? result.diagnostics : null;
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 409,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider,
      });
      return res.status(409).json({
        error: "ppt_export_unavailable",
        detail,
        layoutQuality,
        contentQuality,
        teachingQuality,
        diagnostics,
      });
    }

    let postCheck = runPostExportDeckValidation(
      contract,
      result,
      requestContext,
    );
    let qualityScore = postCheck.qualityScore || result.qualityScore || null;
    const badSampleEntries = (
      Array.isArray(
        postCheck &&
          postCheck.deckValidation &&
          postCheck.deckValidation.errors,
      )
        ? postCheck.deckValidation.errors
        : []
    ).map((e) => mapErrorToBadSample(contract, e));
    const appendedBadSamples = appendBadSamples(badSampleEntries);
    const tracePayload = buildGenerationTracePayload({
      contract,
      requestContext,
      result,
      postCheck,
      elapsedMs: Date.now() - startedAt,
      exportConfig,
    });
    const traceRelativePath = writeGenerationTraceFile(
      requestContext,
      tracePayload,
    );
    const qualityHardFail =
      qualityScore &&
      (Number(qualityScore.templateUsage || 0) < 80 ||
        Number(qualityScore.visualCleanliness || 0) < 85 ||
        Number(qualityScore.contentSpecificity || 0) < 85 ||
        Number(qualityScore.exportIntegrity || 0) < 100 ||
        Number(qualityScore.overall || 0) < 85);
    if (!postCheck.deckValidation.pass) {
      const detail = sanitizeAuditDetail(
        `deck_validation_failed:${postCheck.deckValidation.issues.join(",")}`,
      );
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 422,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider,
      });
      return res.status(422).json({
        error: "ppt_export_validation_failed",
        detail,
        requestId: requestContext.requestId,
        validation: postCheck.deckValidation,
        dump: postCheck.textDump,
        qualityScore,
        generationTracePath: traceRelativePath,
        badSamplesAppended: appendedBadSamples,
        layoutQuality: result.layoutQuality || null,
        contentQuality: result.contentQuality || null,
        diagnostics: result.diagnostics || null,
      });
    }

    if (qualityHardFail) {
      const detail = sanitizeAuditDetail(
        `quality_score_failed:overall=${qualityScore.overall},templateUsage=${qualityScore.templateUsage},visualCleanliness=${qualityScore.visualCleanliness},contentSpecificity=${qualityScore.contentSpecificity},exportIntegrity=${qualityScore.exportIntegrity}`,
      );
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 422,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider,
      });
      return res.status(422).json({
        error: "ppt_export_validation_failed",
        detail,
        requestId: requestContext.requestId,
        validation: {
          ok: false,
          errors: [
            {
              slideIndex: 0,
              type: "qualityScore",
              text: JSON.stringify(qualityScore),
              message: "质量分未达标",
            },
          ],
        },
        qualityScore,
        generationTracePath: traceRelativePath,
        badSamplesAppended: appendedBadSamples,
      });
    }

    if (!isDualGatePass(result)) {
      const detail = sanitizeAuditDetail(dualGateFailReason(result));
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 409,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider,
      });
      return res.status(409).json({
        error: "ppt_export_quality_gate_failed",
        detail,
        layoutQuality: result.layoutQuality || null,
        contentQuality: result.contentQuality || null,
        teachingQuality: result.teachingQuality || null,
        diagnostics: result.diagnostics || null,
        generationTracePath: traceRelativePath,
        badSamplesAppended: appendedBadSamples,
      });
    }

    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      latencyMs: Date.now() - startedAt,
      model: exportConfig.model || "local-pptxgenjs",
      promptChars: JSON.stringify(contract).length,
      outputChars: result.buffer.length,
      pptEngine: result.engine,
      aipptProvider: exportConfig.provider,
      templateId: contract.templateId,
    });

    res.setHeader("Content-Type", result.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizeFileName(result.fileName)}"`,
    );
    res.setHeader("x-ppt-engine", result.engine);
    res.setHeader(
      "x-template-source",
      String(contract.templateSource || "internal"),
    );
    res.setHeader("x-export-ms", String(Date.now() - startedAt));
    res.setHeader("x-generation-trace", traceRelativePath || "");
    res.setHeader("x-bad-samples-appended", String(appendedBadSamples));
    if (result.layoutQuality) {
      res.setHeader("x-layout-score", String(result.layoutQuality.score));
      res.setHeader("x-layout-min", String(result.layoutQuality.minScore));
      res.setHeader("x-layout-pass", result.layoutQuality.pass ? "1" : "0");
      res.setHeader(
        "x-layout-leak-safe",
        result.layoutQuality.strictLeakSafe ? "1" : "0",
      );
    }
    if (result.contentQuality) {
      res.setHeader("x-content-gate", result.contentQuality.pass ? "1" : "0");
      res.setHeader(
        "x-content-coverage",
        String(Number(result.contentQuality.contentCoverage || 0).toFixed(3)),
      );
      res.setHeader(
        "x-content-blank",
        String(
          Array.isArray(result.contentQuality.emptySlides)
            ? result.contentQuality.emptySlides.length
            : 0,
        ),
      );
      res.setHeader(
        "x-content-placeholder-only",
        String(
          Array.isArray(result.contentQuality.placeholderOnlySlides)
            ? result.contentQuality.placeholderOnlySlides.length
            : 0,
        ),
      );
    }
    if (result.teachingQuality && result.teachingQuality.enabled) {
      res.setHeader("x-teaching-gate", result.teachingQuality.pass ? "1" : "0");
      res.setHeader(
        "x-teaching-generic",
        String(
          Number(result.teachingQuality.genericSlideRatio || 0).toFixed(3),
        ),
      );
      res.setHeader(
        "x-teaching-formula",
        String(
          Number(result.teachingQuality.formulaSlideRatio || 0).toFixed(3),
        ),
      );
      res.setHeader(
        "x-teaching-avg-chars",
        String(Number(result.teachingQuality.avgCharsPerSlide || 0).toFixed(1)),
      );
      res.setHeader(
        "x-teaching-action",
        String(
          Number(result.teachingQuality.actionTimeCoverage || 0).toFixed(3),
        ),
      );
    }
    if (String(contract.templateFileName || "").trim()) {
      res.setHeader(
        "x-template-file",
        encodeURIComponent(String(contract.templateFileName || "")).slice(
          0,
          240,
        ),
      );
    }
    if (result.fallbackReason) {
      const safeFallback = encodeURIComponent(
        String(result.fallbackReason || ""),
      ).slice(0, 400);
      res.setHeader("x-ppt-fallback", safeFallback);
    }
    return res.status(200).send(result.buffer);
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(
        error && error.message ? error.message : String(error),
      ),
    });
    return res.status(500).json({
      error: "ppt_export_error",
      detail: error && error.message ? error.message : String(error),
    });
  }
});

app.post("/api/ppt/export-save", async (req, res) => {
  const startedAt = Date.now();
  const audit = baseAuditEvent(req);
  try {
    const requestContext = createRequestContext(
      req,
      req.body && req.body.contract ? req.body.contract : {},
    );
    const retryTrace = [];
    let normalized = normalizeContract(
      req.body && req.body.contract,
      requestContext,
    );

    if (!normalized.ok) {
      const requestedMode = String(
        (req.body &&
          req.body.contract &&
          req.body.contract.layoutPolicy &&
          req.body.contract.layoutPolicy.mode) ||
          "",
      ).toLowerCase();
      const canFallbackToBalanced =
        requestedMode === "strict-layout" || requestedMode === "strict-content";
      const isDeckValidationFail = /deck_validation_failed/i.test(
        String(normalized.reason || ""),
      );

      if (canFallbackToBalanced && isDeckValidationFail) {
        const balancedRawContract = {
          ...(req.body && req.body.contract ? req.body.contract : {}),
          layoutPolicy: {
            ...((req.body &&
              req.body.contract &&
              req.body.contract.layoutPolicy) ||
              {}),
            mode: "balanced",
            minScore: 68,
          },
        };
        const fallbackNormalized = normalizeContract(
          balancedRawContract,
          requestContext,
        );
        retryTrace.push({
          stage: "precheck",
          from: requestedMode || "unknown",
          to: "balanced",
          success: !!fallbackNormalized.ok,
          reason: String(normalized.reason || ""),
        });
        if (fallbackNormalized.ok) {
          normalized = fallbackNormalized;
        }
      }
    }

    if (!normalized.ok) {
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 422,
        latencyMs: Date.now() - startedAt,
        reason: normalized.reason,
      });
      writeDebugJson(
        requestContext,
        "validation.json",
        normalized.validation || {
          ok: false,
          errors: [
            {
              slideIndex: 0,
              type: "invalid_contract",
              text: normalized.reason,
              message: "请求合同不合法",
            },
          ],
        },
      );
      return res.status(422).json({
        error: "ppt_export_validation_failed",
        detail: normalized.reason,
        requestId: requestContext.requestId,
        validation: normalized.validation || null,
        retryTrace,
      });
    }

    const contract = normalized.contract;
    let { result, exportConfig } = await buildPptExportResult(contract);

    if (!result || !result.ok) {
      const detail = sanitizeAuditDetail(
        result && result.reason ? result.reason : "ppt_export_unavailable",
      );
      const layoutQuality =
        result && result.layoutQuality ? result.layoutQuality : null;
      const contentQuality =
        result && result.contentQuality ? result.contentQuality : null;
      const teachingQuality =
        result && result.teachingQuality ? result.teachingQuality : null;
      const diagnostics =
        result && result.diagnostics ? result.diagnostics : null;
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 409,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider,
      });
      return res.status(409).json({
        error: "ppt_export_unavailable",
        detail,
        layoutQuality,
        contentQuality,
        teachingQuality,
        diagnostics,
      });
    }

    let postCheck = runPostExportDeckValidation(
      contract,
      result,
      requestContext,
    );
    let qualityScore = postCheck.qualityScore || result.qualityScore || null;
    const badSampleEntries = (
      Array.isArray(
        postCheck &&
          postCheck.deckValidation &&
          postCheck.deckValidation.errors,
      )
        ? postCheck.deckValidation.errors
        : []
    ).map((e) => mapErrorToBadSample(contract, e));
    const appendedBadSamples = appendBadSamples(badSampleEntries);
    const tracePayload = buildGenerationTracePayload({
      contract,
      requestContext,
      result,
      postCheck,
      elapsedMs: Date.now() - startedAt,
      exportConfig,
    });
    const traceRelativePath = writeGenerationTraceFile(
      requestContext,
      tracePayload,
    );
    const debugInvalid =
      String((req.query && req.query.debug) || "").toLowerCase() === "1";
    if (!postCheck.deckValidation.pass) {
      const repairSeedSaved = saveExportedPptToWorkspace(contract, result, {
        invalid: true,
      });
      const repairAttempt = await repairFailedSlidesFromQualitySidecar(
        contract,
        repairSeedSaved,
        result,
      );
      if (
        repairAttempt &&
        repairAttempt.ok &&
        repairAttempt.repairedResult &&
        repairAttempt.repairedResult.ok
      ) {
        const repairedResult = repairAttempt.repairedResult;
        const repairedPostCheck = runPostExportDeckValidation(
          contract,
          repairedResult,
          requestContext,
        );
        if (repairedPostCheck && repairedPostCheck.deckValidation.pass) {
          result = repairedResult;
          postCheck = repairedPostCheck;
          qualityScore =
            repairedPostCheck.qualityScore ||
            repairedResult.qualityScore ||
            null;
          retryTrace.push({
            stage: "post_export_repair",
            mode: "targeted_failed_slides",
            repairedSlides: Array.isArray(repairAttempt.repairSlideIndexes)
              ? repairAttempt.repairSlideIndexes
              : [],
            success: true,
          });
        } else {
          retryTrace.push({
            stage: "post_export_repair",
            mode: "targeted_failed_slides",
            repairedSlides: Array.isArray(repairAttempt.repairSlideIndexes)
              ? repairAttempt.repairSlideIndexes
              : [],
            success: false,
            reason: "repair_postcheck_failed",
          });
        }
      } else {
        retryTrace.push({
          stage: "post_export_repair",
          mode: "targeted_failed_slides",
          success: false,
          reason: String(
            (repairAttempt && repairAttempt.reason) || "repair_unavailable",
          ),
        });
      }
    }

    if (!postCheck.deckValidation.pass) {
      let invalidSaved = null;
      if (debugInvalid) {
        invalidSaved = saveExportedPptToWorkspace(contract, result, {
          invalid: true,
        });
      }
      const detail = sanitizeAuditDetail(
        `deck_validation_failed:${postCheck.deckValidation.issues.join(",")}`,
      );
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 422,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider,
        detail: invalidSaved ? `saved:${invalidSaved.relPath}` : "",
      });
      return res.status(422).json({
        error: "ppt_export_validation_failed",
        detail,
        requestId: requestContext.requestId,
        message: "PPT质量检查失败",
        validation: postCheck.deckValidation,
        dump: postCheck.textDump,
        qualityScore,
        retryTrace,
        generationTracePath: traceRelativePath,
        badSamplesAppended: appendedBadSamples,
        relativePath: invalidSaved ? invalidSaved.relPath : "",
        diagnosticsRelativePath: invalidSaved
          ? invalidSaved.diagnosticsRelPath || ""
          : "",
        dumpRelativePath: invalidSaved ? invalidSaved.dumpRelPath || "" : "",
      });
    }

    const qualityHardFail =
      qualityScore &&
      (Number(qualityScore.templateUsage || 0) < 80 ||
        Number(qualityScore.visualCleanliness || 0) < 85 ||
        Number(qualityScore.contentSpecificity || 0) < 85 ||
        Number(qualityScore.exportIntegrity || 0) < 100 ||
        Number(qualityScore.overall || 0) < 85);

    if (qualityHardFail) {
      const detail = sanitizeAuditDetail(
        `quality_score_failed:overall=${qualityScore.overall},templateUsage=${qualityScore.templateUsage},visualCleanliness=${qualityScore.visualCleanliness},contentSpecificity=${qualityScore.contentSpecificity},exportIntegrity=${qualityScore.exportIntegrity}`,
      );
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 422,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider,
        detail: "",
      });
      return res.status(422).json({
        error: "ppt_export_validation_failed",
        detail,
        requestId: requestContext.requestId,
        message: "PPT质量检查失败",
        validation: {
          ok: false,
          errors: [
            {
              slideIndex: 0,
              type: "qualityScore",
              text: JSON.stringify(qualityScore),
              message: "质量分未达标",
            },
          ],
        },
        qualityScore,
        retryTrace,
        generationTracePath: traceRelativePath,
        badSamplesAppended: appendedBadSamples,
      });
    }

    if (!isDualGatePass(result)) {
      const detail = sanitizeAuditDetail(dualGateFailReason(result));
      writeAuditLog({
        ...audit,
        outcome: "error",
        status: 409,
        latencyMs: Date.now() - startedAt,
        model: exportConfig.model || "local-pptxgenjs",
        reason: detail,
        templateId: contract.templateId,
        aipptProvider: exportConfig.provider,
        detail: "",
      });
      return res.status(409).json({
        error: "ppt_export_quality_gate_failed",
        detail,
        layoutQuality: result.layoutQuality || null,
        contentQuality: result.contentQuality || null,
        teachingQuality: result.teachingQuality || null,
        diagnostics: result.diagnostics || null,
        requestId: requestContext.requestId,
        retryTrace,
        generationTracePath: traceRelativePath,
        badSamplesAppended: appendedBadSamples,
      });
    }

    const saved = saveExportedPptToWorkspace(contract, result);
    const tracePayloadFinal = buildGenerationTracePayload({
      contract,
      requestContext,
      saved,
      result,
      postCheck,
      elapsedMs: Date.now() - startedAt,
      exportConfig,
    });
    const traceFileName = "generation_trace.json";
    const exportTraceAbsPath = path.join(
      path.dirname(saved.absPath),
      traceFileName,
    );
    let exportTraceRelPath = "";
    try {
      fs.writeFileSync(
        exportTraceAbsPath,
        JSON.stringify(tracePayloadFinal, null, 2),
        "utf8",
      );
      exportTraceRelPath = path
        .relative(__dirname, exportTraceAbsPath)
        .replace(/\\/g, "/");
    } catch {}

    const elapsedMs = Date.now() - startedAt;

    writeAuditLog({
      ...audit,
      outcome: "ok",
      status: 200,
      latencyMs: Date.now() - startedAt,
      model: exportConfig.model || "local-pptxgenjs",
      promptChars: JSON.stringify(contract).length,
      outputChars: result.buffer.length,
      pptEngine: result.engine,
      aipptProvider: exportConfig.provider,
      templateId: contract.templateId,
      detail: `saved:${saved.relPath}`,
    });

    return res.json({
      ok: true,
      requestId: requestContext.requestId,
      engine: result.engine,
      fallbackReason: result.fallbackReason || "",
      retryTrace,
      layoutQuality: result.layoutQuality || null,
      contentQuality: result.contentQuality || null,
      diagnostics: result.diagnostics || null,
      qualityScore,
      elapsedMs,
      sla: {
        under60s: elapsedMs <= 60000,
        strictLeakSafe: !!(
          result.layoutQuality && result.layoutQuality.strictLeakSafe
        ),
        manualAdjustmentsLe1: !!(
          result.layoutQuality &&
          Number(result.layoutQuality.estimatedManualFixes || 0) <= 1
        ),
        contentGatePass: !!(
          result.contentQuality && result.contentQuality.pass
        ),
        blankSlidesZero: !!(
          result.contentQuality &&
          Array.isArray(result.contentQuality.emptySlides) &&
          result.contentQuality.emptySlides.length === 0
        ),
        placeholderOnlyZero: !!(
          result.contentQuality &&
          Array.isArray(result.contentQuality.placeholderOnlySlides) &&
          result.contentQuality.placeholderOnlySlides.length === 0
        ),
      },
      fileName: saved.fileName,
      relativePath: saved.relPath,
      absolutePath: saved.absPath,
      diagnosticsRelativePath: saved.diagnosticsRelPath || "",
      diagnosticsAbsolutePath: saved.diagnosticsAbsPath || "",
      dumpRelativePath: saved.dumpRelPath || "",
      dumpAbsolutePath: saved.dumpAbsPath || "",
      validationRelativePath: saved.validationRelPath || "",
      renderLogRelativePath: saved.renderLogRelPath || "",
      generationTracePath: exportTraceRelPath || traceRelativePath,
      badSamplesAppended: appendedBadSamples,
      bytes: result.buffer.length,
    });
  } catch (error) {
    writeAuditLog({
      ...audit,
      outcome: "error",
      status: 500,
      latencyMs: Date.now() - startedAt,
      reason: sanitizeAuditDetail(
        error && error.message ? error.message : String(error),
      ),
    });
    return res.status(500).json({
      error: "ppt_export_save_error",
      detail: error && error.message ? error.message : String(error),
    });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "upload too large",
        detail: "单个文件超过 15MB，请压缩后重试",
      });
    }
    return res.status(400).json({
      error: "upload failed",
      detail: err.message,
    });
  }

  if (err) {
    return res.status(500).json({
      error: "upload server error",
      detail: err.message || String(err),
    });
  }

  return next();
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`Server running on http://${displayHost}:${PORT}`);
    if (ROBOT_LANDING) {
      console.log("Robot landing mode enabled.");
    }
  });
}

module.exports = app;
