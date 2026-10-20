/**
 * Server-side username anti-spoof.
 * Mongo `user.username` is the only identity for display / Photon Nickname.
 * Client-supplied Username/Nickname fields are stripped except real rename routes.
 */

const USERNAME_BODY_KEYS = [
  "username",
  "Username",
  "userName",
  "UserName",
  "newUsername",
  "Nickname",
  "nickname",
  "nickName",
  "NickName"
];

/** Routes that may legitimately send a new name in the body (paid / lobby rename). */
const RENAME_PATH_PREFIXES = [
  "/user/update",
  "/user/updateusername"
];

function normalizePath(path) {
  if (!path || typeof path !== "string") return "/";
  let p = path.split("?")[0].trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p.toLowerCase();
}

function isRenameRoute(path) {
  const p = normalizePath(path);
  return RENAME_PATH_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/")
  );
}

function canonicalUsername(user) {
  if (!user) return "";
  return String(user.username || user.Username || "").trim();
}

/**
 * Strip spoofable username fields from body on all routes except rename.
 * Does not touch search needles that use other keys after we delete Username —
 * friends search uses UserName — KEEP search: allow /friends/search to keep UserName as query.
 */
function stripClientUsername(req, res, next) {
  try {
    const path = normalizePath(req.path || req.url || "/");
    if (isRenameRoute(path)) return next();

    // Friends search needs the needle — keep UserName / username as search only
    if (path === "/friends/search" || path.startsWith("/friends/search")) {
      return next();
    }

    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      for (const k of USERNAME_BODY_KEYS) {
        if (Object.prototype.hasOwnProperty.call(req.body, k)) {
          delete req.body[k];
        }
      }
    }
  } catch {
    // never block the request on strip errors
  }
  return next();
}

/**
 * Build Photon Custom Auth success payload from a live Mongo user.
 */
function photonAuthFromUser(user) {
  if (!user || !user.stumbleId) return null;
  const nick = canonicalUsername(user) || String(user.stumbleId);
  return {
    ResultCode: 1,
    UserId: String(user.stumbleId),
    Nickname: nick
  };
}

/**
 * Overlay live Mongo username onto nested profile objects.
 */
function attachLiveUsername(profile, user) {
  const p = profile && typeof profile === "object" ? { ...profile } : {};
  const live = canonicalUsername(user);
  if (live) {
    p.userName = live;
    p.Username = live;
    p.username = live;
  }
  return p;
}

module.exports = {
  USERNAME_BODY_KEYS,
  RENAME_PATH_PREFIXES,
  canonicalUsername,
  stripClientUsername,
  isRenameRoute,
  photonAuthFromUser,
  attachLiveUsername
};
