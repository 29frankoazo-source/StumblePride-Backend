const crypto = require("crypto");

const HEADER = "x-prox-encrypt";
const MAX_SKEW_SEC = 120;

function getSalt() {
  const raw = process.env.ProxEncryptSalt;
  if (!raw || typeof raw !== "string") return "";
  // Strip optional surrounding quotes from .env
  return raw.trim().replace(/^"(.*)"$/, "$1");
}

function normalizePath(path) {
  if (!path || typeof path !== "string") return "/";
  let p = path.split("?")[0].trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function normalizeMethod(method) {
  return String(method || "GET").toUpperCase();
}

function sign(timestamp, nonce, method, path) {
  const salt = getSalt();
  const payload = `${timestamp}.${nonce}.${normalizeMethod(method)}.${normalizePath(path)}`;
  return crypto.createHmac("sha256", salt).update(payload, "utf8").digest("hex");
}

function createToken(method, path) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const signature = sign(timestamp, nonce, method, path);
  return `${timestamp}.${nonce}.${signature}`;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyToken(token, method, path) {
  if (!token || typeof token !== "string") {
    return { ok: false, reason: "missing" };
  }

  const salt = getSalt();
  if (!salt || salt.length < 16) {
    return { ok: false, reason: "server_misconfigured" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed" };
  }

  const [timestamp, nonce, signature] = parts;
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{16,64}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return { ok: false, reason: "malformed" };
  }

  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SEC) {
    return { ok: false, reason: "expired" };
  }

  const expected = sign(timestamp, nonce, method, path);
  const provided = signature.toLowerCase();
  if (!timingSafeEqualHex(expected, provided)) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true };
}

/**
 * Paths that are not game-client routes (health, Photon cloud webhooks, etc.).
 * Everything else requires a valid x-prox-encrypt header from ClientLoader.
 */
const DEFAULT_EXCLUSIONS = [
  "/",
  "/health",
  "/photon/auth",
  "/api/v1/ping"
];

function middleware(options = {}) {
  const exclusions = new Set(
    (options.exclusions || DEFAULT_EXCLUSIONS).map((p) => normalizePath(p))
  );

  return function proxEncryptMiddleware(req, res, next) {
    const path = normalizePath(req.path || "/");

    if (exclusions.has(path)) {
      return next();
    }

    // Photon / probes sometimes hit with trailing differences
    if (path.startsWith("/photon/")) {
      return next();
    }

    const token =
      req.headers[HEADER] ||
      req.headers["X-Prox-Encrypt"] ||
      req.headers["x-prox-encrypt"];

    const result = verifyToken(token, req.method, path);
    if (!result.ok) {
      if (result.reason === "server_misconfigured") {
        console.error("[ProxEncrypt] ProxEncryptSalt missing or too short in env");
        return res.status(503).json({ error: "prox_encrypt_unavailable" });
      }
      return res.status(403).json({
        error: "prox_encrypt_required",
        reason: result.reason
      });
    }

    return next();
  };
}

module.exports = {
  HEADER,
  createToken,
  verifyToken,
  sign,
  normalizePath,
  normalizeMethod,
  middleware,
  DEFAULT_EXCLUSIONS
};
