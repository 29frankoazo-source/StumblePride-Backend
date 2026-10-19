require("dotenv").config();
const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");
const {
  MONGO_URI,
  DB_NAME,
  USERS_COLLECTION,
  BANS_COLLECTION,
  MONGO_CLIENT_OPTIONS,
  maskMongoUri
} = require("./mongoConfig");
const https = require("https");
const Console = require("./ConsoleUtils");
const CryptoUtils = require("./CryptoUtils");
const SharedUtils = require("./SharedUtils");
const ProxEncrypt = require("./AntiCheat/ProxEncrypt");
const { stripClientUsername } = require("./AntiCheat/Username");

let compression = null;
try {
  compression = require("compression");
} catch {
  console.warn("[BOOT] compression non installato — config più lenta senza gzip");
}

const {
  BackendUtils,
  UserModel,
  UserController,
  RoundController,
  BattlePassController,
  EconomyController,
  AnalyticsController,
  FriendsController,
  NewsController,
  MissionsController,
  TournamentXController,
  MatchmakingController,
  TournamentController,
  SocialController,
  EventsController,
  authenticate,
  errorControll,
  sendShared,
  OnlineCheck,
  VerifyPhoton,
  getPhotonAuthRecent
} = require("./BackendUtils");

const ANSI = {
  reset: "\x1b[0m",
  blue: "\x1b[38;2;18;127;212m",
  white: "\x1b[38;2;255;255;255m"
};

function timeStr() {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  })
    .format(new Date())
    .toUpperCase();
}

function logLine(level, msg) {
  process.stdout.write(
    `${ANSI.blue}${timeStr()}${ANSI.reset} | ${ANSI.white}${level}${ANSI.reset} | ${ANSI.blue}${String(
      msg || ""
    )}${ANSI.reset}\n`
  );
}

function logInfo(msg) {
  logLine("INFO", msg);
}

function logCheat(msg) {
  logLine("CHEAT", msg);
}

function logUser(msg) {
  logLine("USER", msg);
}

function showBanner() {
  const art = `
▄▄▄ .▄▄▌  ▄▄▌  ▄▄▄ .    .▄▄ · ▄▄▄ . ▌ ▐·▄▄▄ . ▐ ▄ 
▀▄.▀·██•  ██•  ▀▄.▀·    ▐█ ▀. ▀▄.▀·▪█·█▌▀▄.▀·•█▌▐█
▐▀▀▪▄██▪  ██▪  ▐▀▀▪▄    ▄▀▀▀█▄▐▀▀▪▄▐█▐█•▐▀▀▪▄▐█▐▐▌
▐█▄▄▌▐█▌▐▌▐█▌▐▌▐█▄▄▌    ▐█▄▪▐█▐█▄▄▌ ███ ▐█▄▄▌██▐█▌
 ▀▀▀ .▀▀▀ .▀▀▀  ▀▀▀      ▀▀▀▀  ▀▀▀ . ▀   ▀▀▀ ▀▀ █▪
`;
  console.log(`${ANSI.blue}${art}${ANSI.reset}`);
  console.log("");
}

const DISCORD_WEBHOOK_ANTICHEAT =
  process.env.DISCORD_WEBHOOK_ANTICHEAT ||
  process.env.WEBHOOK_ANTICHEAT ||
  process.env.DISCORD_WEBHOOK_CHEAT ||
  "";

const DISCORD_WEBHOOK_NAMES =
  process.env.DISCORD_WEBHOOK_NAMES ||
  process.env.WEBHOOK_NAMES ||
  process.env.DISCORD_WEBHOOK_USERNAME ||
  "";

const LOGO_URL =
  process.env.StumbleCore_LOGO_URL ||
  "https://media.discordapp.net/attachments/1389500406467526738/1448068002317598873/CoreLogo-NoBG.png?ex=6939e9eb&is=6938986b&hm=eb49c5a782995b7fc06b7cdf4e113420251e80d4bc1ab27811eddcd086038a8e&=&format=png&quality=lossless";

const E = {
  TournamentMedal: "<:TournamentMedal:1456294969454235688>",
  connectionIssueIcon: "<:connectionIssueIcon:1456295058935513242>",
  crownIcon: "<:crownIcon:1456294952203194524>",
  id: "<:id:1456295011023847431>",
  member: "<:member:1456294998239870996>",
  settingsIcon: "<:settingsIcon:1456295102753275965>",
  trophy_icon: "<:trophy_icon:1456295084285759640>"
};

let _discordChainAntiCheat = Promise.resolve();
let _discordChainNames = Promise.resolve();

function postWebhookPayload(url, chainRef, payload) {
  if (!url) return Promise.resolve(false);
  const next = chainRef
    .then(
      () =>
        new Promise(resolve => {
          try {
            const u = new URL(url);
            const data = JSON.stringify(payload || {});
            const req = https.request(
              {
                method: "POST",
                hostname: u.hostname,
                path: u.pathname + (u.search || ""),
                headers: {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(data)
                }
              },
              res => {
                res.on("data", () => {});
                res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
              }
            );
            req.on("error", () => resolve(false));
            req.write(data);
            req.end();
          } catch {
            resolve(false);
          }
        })
    )
    .catch(() => false);

  return next;
}

function sendAntiCheatEmbed(embed) {
  _discordChainAntiCheat = postWebhookPayload(DISCORD_WEBHOOK_ANTICHEAT, _discordChainAntiCheat, {
    embeds: [embed]
  });
  return _discordChainAntiCheat;
}

function sendNamesEmbed(embed) {
  _discordChainNames = postWebhookPayload(DISCORD_WEBHOOK_NAMES, _discordChainNames, {
    embeds: [embed]
  });
  return _discordChainNames;
}

function safeStr(v, fallback = "N/A") {
  const s = (v ?? "").toString().trim();
  return s ? s : fallback;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getPlayerId(u) {
  return safeStr(u?.id, "N/A");
}

function getTrophies(u) {
  const a = u?.trophys ?? u?.trophies;
  if (a !== undefined && a !== null) return safeNum(a);
  if (u?.userProfile?.trophies !== undefined && u?.userProfile?.trophies !== null)
    return safeNum(u.userProfile.trophies);
  return 0;
}

function getCrowns(u) {
  const a = u?.crowns;
  if (a !== undefined && a !== null) return safeNum(a);
  if (u?.userProfile?.crowns !== undefined && u?.userProfile?.crowns !== null)
    return safeNum(u.userProfile.crowns);
  return 0;
}

function buildAntiCheatBanEmbed(user, reason) {
  const username = safeStr(user?.username, "Unknown");
  const playerId = getPlayerId(user);
  const tourWins = safeNum(user?.age);
  const crowns = getCrowns(user);
  const trophies = getTrophies(user);
  const nowUnix = Math.floor(Date.now() / 1000);

  const description = [
    "**AntiCheat - Ban applicato**",
    `> ${E.member} **Username**: ${username}`,
    `> ${E.id} **User ID**: ${playerId}`,
    "",
    `> ${E.TournamentMedal} **Tour Wins**: ${tourWins}`,
    `> ${E.crownIcon} **Crown**: ${crowns}`,
    `> ${E.trophy_icon} **Trophies**: ${trophies}`,
    "",
    `> ${E.connectionIssueIcon} **Banned**: <t:${nowUnix}:F>`,
    `> ${E.settingsIcon} **Reason**: ${safeStr(reason, "cheat_detected")}`
  ].join("\n");

  return {
    color: 0xff0000,
    thumbnail: { url: LOGO_URL },
    footer: { text: "Stumble Anticheat", icon_url: LOGO_URL },
    description,
    timestamp: new Date().toISOString()
  };
}

function buildNameChangeEmbed(oldUser, newUser, newUsernameFallback) {
  const oldName = safeStr(oldUser?.username, "Unknown");
  const newName = safeStr(newUser?.username, safeStr(newUsernameFallback, "Unknown"));
  const base = newUser || oldUser || {};
  const playerId = getPlayerId(base);
  const tourWins = safeNum(base?.age);
  const crowns = getCrowns(base);
  const trophies = getTrophies(base);

  const description = [
    "**Name**",
    `> ${E.member}${oldName} âžœ ${newName}`,
    `> ${E.id} **User ID**: ${playerId}`,
    "",
    `> ${E.TournamentMedal} **Tour Wins**: ${tourWins}`,
    `> ${E.crownIcon} **Crown**: ${crowns}`,
    `> ${E.trophy_icon} **Trophies**: ${trophies}`
  ].join("\n");

  return {
    color: 0xf95d00,
    thumbnail: { url: LOGO_URL },
    footer: { text: "Stumblee Name's", icon_url: LOGO_URL },
    description,
    timestamp: new Date().toISOString()
  };
}

const app = express();
const Title = "elle seven backend " + process.env.version;
const PORT = process.env.PORT || 8080;

// Unity tratta 304 come errore HTTP — niente ETag / conditional GET
app.set("etag", false);
app.disable("etag");

const bannedPayload =
  (BackendUtils && BackendUtils.bannedPayload) ||
  function bannedPayload(reason) {
    return { error: "banned", banReason: reason || "banned" };
  };

if (compression) {
  app.use(
    compression({
      threshold: 1024,
      level: 6
    })
  );
}

app.use((req, res, next) => {
  // Evita 304 Not Modified su config/shared (client Unity non lo gestisce)
  if (req.path === "/user/config" || req.path.startsWith("/shared/")) {
    delete req.headers["if-none-match"];
    delete req.headers["if-modified-since"];
  }
  next();
});

app.use(express.json({ limit: "2mb" }));

// ClientLoader-only gate: rejects requests without valid x-prox-encrypt (see AntiCheat/ProxEncrypt.js)
app.use(
  ProxEncrypt.middleware({
    exclusions: ["/", "/health", "/photon/auth", "/api/v1/ping"]
  })
);

// Anti-spoof: drop client Username/Nickname body fields (Mongo is source of truth)
app.use(stripClientUsername);

// (Log richieste disattivato per evitare spam nei log)
// Se vuoi riattivarlo, decommenta il blocco seguente.
// app.use((req, res, next) => {
//   logInfo(`REQ ${req.method} ${req.path}`);
//   next();
// });

// Middleware globale per evitare il popup Rew001:
// intercetta tutte le risposte 500 o con messaggi di errore interni
// e le converte in una risposta di successo { ok: true }.
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const originalStatus = res.status.bind(res);

  res.status = function (code) {
    if (code === 500) {
      this._isError500 = true;
      return originalStatus(200);
    }
    return originalStatus(code);
  };

  res.json = function (data) {
    const msg = data && (data.mensagem || data.message || data.error);
    // NON mascherare errori su /user/login: il client deve vedere il fallimento reale
    // (prima diventava {ok:true} senza User → login page bloccata)
    const isLogin = req.path === "/user/login";
    const isTourX =
      req.path.includes("tournamentx") || req.path.includes("/round/tournament/finish");

    if (
      !isLogin &&
      !isTourX &&
      (this._isError500 ||
        this.statusCode === 500 ||
        msg === "erro interno do servidor" ||
        msg === "erro interno" ||
        msg === "Internal server error" ||
        msg === "Internal server error during login" ||
        msg === "Internal server error during JWT generation" ||
        data?.error === "internal_error")
    ) {
      this.statusCode = 200;
      return originalJson({ ok: true });
    }

    return originalJson(data);
  };

  res.send = function (data) {
    if (req.path === "/user/login") {
      return originalSend(data);
    }
    const isTourX =
      req.path.includes("tournamentx") || req.path.includes("/round/tournament/finish");
    if (isTourX) {
      return originalSend(data);
    }
    if (this._isError500 || this.statusCode === 500) {
      this.statusCode = 200;
      return originalSend(JSON.stringify({ ok: true }));
    }
    return originalSend(data);
  };

  next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "073sg",
    version: process.env.version || "V2",
    port: PORT
  });
});

app.get("/health", async (req, res) => {
  let mongo = false;
  try {
    mongo = await ensureMongo();
  } catch {}
  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    mongo,
    db: DB_NAME
  });
});

app.get("/bots", (req, res) => {
  res.status(200).json([]);
});

app.post("/bots", (req, res) => {
  res.status(200).json([]);
});

const authExclusions = [
  "/",
  "/health",
  "/bots",
  "/leaderboard/age",
  "/user/age",
  "/user/cheat",
  "/user/login",
  "/user/config",
  "/user/terms-of-service",
  "/api/v1/userLoginExternal",
  "/photon/auth",
  "/onlinecheck",
  "/api/v1/ping",
  "/pusher/authenticate",
  "/pusher/authorize"
];

function getDeviceIdFromReq(req) {
  return (
    req.body?.DeviceId ||
    req.body?.deviceid ||
    req.body?.deviceId ||
    req.headers?.deviceid ||
    req.headers?.["device-id"] ||
    req.headers?.["x-deviceid"] ||
    ""
  )
    .toString()
    .trim();
}

console.log("[BOOT] MONGO_URI usata da index.js:", maskMongoUri(MONGO_URI));
console.log("[BOOT] DB_NAME usata da index.js:", DB_NAME);

if (!MONGO_URI) {
  throw new Error("MONGODB_URI (o MONGO_URI/MONGO_URL) mancante nelle env");
}

let _mongoClient;
let _connectPromise;
let _usersCol;
let _bansCol;
let _mongoConnectedLogged = false;

async function ensureMongo() {
  if (_mongoClient) return true;
  if (!MONGO_URI) return false;
  if (!_connectPromise) {
    _mongoClient = new MongoClient(MONGO_URI, MONGO_CLIENT_OPTIONS);
    _connectPromise = _mongoClient
      .connect()
      .then(() => true)
      .catch((err) => {
        console.warn("[Database] Mongo non disponibile:", err && err.message ? err.message : err);
        _mongoClient = null;
        _connectPromise = null;
        return false;
      });
  }
  const ok = await _connectPromise;
  if (!ok || !_mongoClient) return false;
  if (!_mongoConnectedLogged) {
    _mongoConnectedLogged = true;
    logInfo("[Database] Connesso al database.");
  }
  return true;
}

async function usersCol() {
  if (_usersCol) return _usersCol;
  const ok = await ensureMongo();
  if (!ok || !_mongoClient) return null;
  _usersCol = _mongoClient.db(DB_NAME).collection(USERS_COLLECTION);
  return _usersCol;
}

async function bansCol() {
  if (_bansCol) return _bansCol;
  const ok = await ensureMongo();
  if (!ok || !_mongoClient) return null;
  _bansCol = _mongoClient.db(DB_NAME).collection(BANS_COLLECTION);
  try {
    await _bansCol.createIndex({ deviceid: 1 }, { unique: true });
  } catch {}
  return _bansCol;
}

async function getBanByDeviceId(deviceid) {
  if (!deviceid) return null;
  try {
    const col = await bansCol();
    if (!col) return null;
    return await col.findOne(
      { deviceid, isBanned: true },
      { projection: { _id: 0, deviceid: 1, banReason: 1, bannedAtUtc: 1 } }
    );
  } catch (err) {
    console.warn("[BAN] skip check (mongo offline):", err && err.message ? err.message : err);
    return null;
  }
}

async function banByDeviceId(deviceid, reason) {
  try {
    const col = await bansCol();
    if (!col) {
      console.warn("[BAN] skip write (mongo offline):", deviceid);
      return null;
    }
    return await col.updateOne(
      { deviceid },
      {
        $set: {
          deviceid,
          isBanned: true,
          banReason: reason || "cheat_detected",
          bannedAtUtc: new Date().toISOString()
        }
      },
      { upsert: true }
    );
  } catch (err) {
    console.warn("[BAN] write failed:", err && err.message ? err.message : err);
    return null;
  }
}

async function getUserForLogByDeviceId(deviceid) {
  if (!deviceid) return null;

  try {
    const u = await UserModel.findByDeviceId(deviceid);
    if (u) return u;
  } catch {}

  try {
    const col = await usersCol();
    if (!col) return null;
    return await col.findOne(
      { $or: [{ deviceId: deviceid }, { deviceid: deviceid }] },
      {
        projection: {
          _id: 0,
          id: 1,
          deviceId: 1,
          deviceid: 1,
          username: 1,
          crowns: 1,
          trophys: 1,
          trophies: 1,
          age: 1,
          userProfile: 1
        }
      }
    );
  } catch {
    return null;
  }
}

async function getUserForLogByIdentifier(identifier) {
  const idStr = safeStr(identifier, "");
  if (!idStr) return null;

  const maybeNum = Number.parseInt(idStr, 10);
  const hasNum = Number.isFinite(maybeNum);

  const ors = [{ id: idStr }];
  if (hasNum) ors.push({ id: maybeNum });

  try {
    const col = await usersCol();
    return await col.findOne(
      { $or: ors },
      {
        projection: {
          _id: 0,
          id: 1,
          deviceId: 1,
          deviceid: 1,
          username: 1,
          crowns: 1,
          trophys: 1,
          trophies: 1,
          age: 1,
          userProfile: 1
        }
      }
    );
  } catch {
    return null;
  }
}

async function getUserForNameChangeReq(req) {
  const ident =
    req.user?.id ||
    req.user?.userId ||
    req.user?.userid ||
    req.headers?.userid ||
    req.headers?.userId ||
    req.body?.userId ||
    req.body?.userid ||
    req.body?.id ||
    "";

  const deviceid = getDeviceIdFromReq(req);

  if (ident) {
    const u = await getUserForLogByIdentifier(ident);
    if (u) return u;
  }

  if (deviceid) {
    const u = await getUserForLogByDeviceId(deviceid);
    if (u) return u;
  }

  return null;
}

class CrownController {
  static async updateScore(req, res) {
    try {
      const { deviceid, username, country } = req.body;
      if (!deviceid || !username) {
        return res.status(400).json({ error: "Missing fields" });
      }

      let user = await UserModel.findByDeviceId(deviceid);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const newCrowns = (user.crowns || 0) + 1;
      await UserModel.update(user.stumbleId, { crowns: newCrowns });

      res.json({ success: true, crowns: newCrowns });
    } catch (err) {
      console.error("Error updating crowns:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  static async list(req, res) {
    try {
      const { country, start, count } = req.query;

      const data = await UserModel.GetHighscore(
        "crowns",
        country || "",
        start || 0,
        count || 50
      );

      res.json(data);
    } catch (err) {
      console.error("Error fetching crown highscores:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
}

class EventsWonController {
  static async list(req, res) {
    try {
      const { country, start, count } = req.query;
      const data = await UserModel.GetHighscore(
        "eventsWon",
        country || "",
        start || 0,
        count || 100
      );
      res.json(data);
    } catch (err) {
      console.error("Error fetching EventsWon highscores:", err);
      res.status(500).json({ error: "Internal server error", scores: [] });
    }
  }
}

app.use((req, res, next) => {
  if (authExclusions.includes(req.path)) return next();
  return authenticate(req, res, next);
});

app.use((req, res, next) => {
  if (authExclusions.includes(req.path)) return next();
  if (req.user && req.user.isBanned === true) {
    return res.status(403).json(bannedPayload(req.user.banReason));
  }
  next();
});

// Log strutturato per azioni lobby (username, cosmetics, bp, spin, ugc)
app.use((req, res, next) => {
  const p = req.path || "";
  const watch =
    p.includes("updateusername") ||
    p.includes("equipped-cosmetics") ||
    p.includes("inventory/selection") ||
    p.includes("battlepass") ||
    p.includes("luckyspin") ||
    p.includes("purchasedrop") ||
    p.includes("custom-maps") ||
    p.includes("tournamentx") ||
    p.includes("tournament") ||
    p.includes("xp-road");
  if (!watch) return next();
  const t0 = Date.now();
  const chunks = [];
  const originalJson = res.json.bind(res);
  res.json = function (data) {
    try {
      const preview =
        typeof data === "string"
          ? data.slice(0, 180)
          : JSON.stringify(data).slice(0, 180);
      console.log(
        `[LOBBY-HTTP] ${req.method} ${req.originalUrl || p} -> ${res.statusCode || 200} ${Date.now() - t0}ms body=${preview}`
      );
    } catch {}
    return originalJson(data);
  };
  console.log(
    `[LOBBY-HTTP] ${req.method} ${req.originalUrl || p} headers.auth=${req.headers.authorization ? "yes" : "no"} body=${JSON.stringify(req.body || {}).slice(0, 200)}`
  );
  next();
});

// Fix lobby: montati PRIMA delle route legacy (Express = first match wins)
try {
  const { mountLobbyRoutes } = require("./LobbyFixes");
  mountLobbyRoutes(app);
} catch (e) {
  console.error("[LOBBY] mount failed:", e && e.message ? e.message : e);
}

try {
  const { mountClassicTournamentRoutes } = require("./ClassicTournamentFixes");
  mountClassicTournamentRoutes(app);
} catch (e) {
  console.error("[TOUR] mount failed:", e && e.message ? e.message : e);
}

try {
  const { mountSafeStubs } = require("./SafeStubs");
  mountSafeStubs(app);
} catch (e) {
  console.error("[STUBS] mount failed:", e && e.message ? e.message : e);
}

// Photon Custom Auth webhook (dashboard Authentication URL → questo host)
app.post("/photon/auth", VerifyPhoton);
app.get("/photon/auth", VerifyPhoton);
app.all("/photon/auth/", VerifyPhoton);
app.get("/photon/auth/recent", getPhotonAuthRecent);
app.get("/onlinecheck", OnlineCheck);
app.get(["/matchmaking/filter", "/matchmaking/filter/"], MatchmakingController.getMatchmakingFilter);

app.post("/user/login", async (req, res, next) => {
  try {
    const deviceid = getDeviceIdFromReq(req);
    if (deviceid) {
      try {
        const ban = await getBanByDeviceId(deviceid);
        if (ban) return res.status(403).json(bannedPayload(ban.banReason));
      } catch (banErr) {
        console.warn("[LOGIN] ban check skipped:", banErr && banErr.message ? banErr.message : banErr);
      }

      try {
        const user = await UserModel.findByDeviceId(deviceid);
        if (user && user.isBanned === true) {
          return res.status(403).json(bannedPayload(user.banReason));
        }
      } catch (banUserErr) {
        console.warn("[LOGIN] ban user check skipped:", banUserErr && banUserErr.message ? banUserErr.message : banUserErr);
      }
    }
    return UserController.login(req, res, next);
  } catch (e) {
    console.error("[LOGIN] error", e && e.message ? e.message : e);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.get("/user/config", sendShared);
app.post("/user/config", sendShared);
app.get("/usersettings", UserController.getSettings);

// Stub sicuri: il catch-all {ok:true} rompeva la deserializzazione Unity
app.all(["/economy/offers/purchasedV2", "/economy/offers/purchasedV2/"], (req, res) => {
  res.status(200).json({});
});
app.all("/rewarded-videos", (req, res) =>
  res.status(200).json({ RewardedVideos: [] })
);
app.all(["/rewards/pending", "/rewards/pending/"], (req, res) =>
  res.status(200).json({ Rewards: [], PendingRewards: [] })
);
app.all(["/cosmetic-sources-config", "/cosmetic-sources-config/"], (req, res) =>
  res.status(200).json([])
);
// Game parses List<SteamPurchasePrice> — catch-all {} throws and shows a blank Error popup.
const emptySteamPrices = (req, res) => {
  console.log("[STEAM] prices stub", req.method, req.path);
  res.status(200).json([]);
};
app.all([
  "/steam/prices",
  "/steam/prices/",
  "/steam/purchaseprices",
  "/steam/purchaseprices/",
  "/purchasing/steam/prices",
  "/purchasing/steam/prices/",
  "/economy/steam/prices",
  "/economy/steam/prices/",
  "/user/steam/prices",
  "/user/steam/prices/"
], emptySteamPrices);
app.all(["/pusher/authenticate", "/pusher/authenticate/"], (req, res) => {
  console.log("[PUSHER] /authenticate hit, socket_id=" + req.body?.socket_id);
  const socketId = req.body?.socket_id || "0.0";
  return res.status(200).json({
    auth: socketId + ":placeholder",
    user_data: JSON.stringify({ id: String(req.body?.user_id || "anon") }),
  });
});
app.all(["/pusher/authorize", "/pusher/authorize/"], (req, res) => {
  console.log("[PUSHER] /authorize hit, socket_id=" + req.body?.socket_id + " channel=" + req.body?.channel_name);
  const socketId = req.body?.socket_id || "0.0";
  return res.status(200).json({
    auth: socketId + ":placeholder",
    channel_data: JSON.stringify({ user_id: String(req.body?.user_id || "anon") }),
  });
});
app.all("/user/creator-codes", (req, res) =>
  res.status(200).json({ Code: "", expiration_date: "2099-01-01T00:00:00+00:00" })
);
app.all(["/collection-events/me", "/collection-events/me/"], (req, res) => {
  res.status(200).json({ gameEvents: [] });
});
app.all("/user/terms-of-service", (req, res) => {
  res.status(200).json({
    accepted: true,
    TermsOfServiceAccepted: true,
    ok: true
  });
});
app.post("/user/age", (req, res) => {
  const age = Number(req.body?.age ?? req.body?.Age ?? 18) || 18;
  res.status(200).json({ age, Age: age, ok: true });
});
app.get("/user/age", async (req, res) => {
  try {
    const idRaw = typeof req.query.id === "string" ? req.query.id.trim() : "";
    if (!idRaw) {
      return res.status(200).json({ age: 18, Age: 18 });
    }
    const col = await usersCol();
    if (!col) return res.status(200).json({ age: 18, Age: 18 });
    const idNum = parseInt(idRaw, 10);
    const filter = Number.isFinite(idNum) ? { id: idNum } : { id: idRaw };
    const u = await col.findOne(filter, { projection: { age: 1 } });
    const age = typeof u?.age === "number" ? u.age : 18;
    res.json({ age, Age: age });
  } catch (err) {
    res.status(200).json({ age: 18, Age: 18 });
  }
});

app.post("/user/updateusername", async (req, res, next) => {
  const oldUser = await getUserForNameChangeReq(req);
  const newUsernameFromReq = safeStr(req.body?.username ?? req.body?.newUsername ?? req.body?.name, "");

  res.once("finish", async () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const newUser = await getUserForNameChangeReq(req);
      const embed = buildNameChangeEmbed(oldUser, newUser, newUsernameFromReq);
      logUser("Username cambiato.");
      await sendNamesEmbed(embed);
    }
  });

  return UserController.updateUsername(req, res, next);
});

app.get("/user/deleteaccount", UserController.deleteAccount);
app.post("/user/linkplatform", UserController.linkPlatform);
app.post("/user/unlinkplatform", UserController.unlinkPlatform);
app.get("/shared/:version/:type", sendShared);
app.post("/user/profile", UserController.getProfile);
// cosmetics / battlepass / luckyspin / purchasedrop → LobbyFixes (montato sopra)
app.post("/user/cosmetics/addskin", UserController.addSkin);

app.get("/round/finish/:round", RoundController.finishRound);
app.get("/round/finishv2/:round", RoundController.finishRound);
app.post("/round/finish/v3/:round", RoundController.finishRound);
app.post("/round/finish/v3/:round/", RoundController.finishRound);
app.all("/round/finish/v3/:round", RoundController.finishRound);
app.all("/round/finish/v3/:round/", RoundController.finishRound);
app.post("/round/finish/v4/:round", RoundController.finishRoundV4);
app.post("/round/eventfinish/v3/:round", RoundController.finishRound);
app.post("/round/eventfinish/v3/:round/", RoundController.finishRound);
app.all("/round/eventfinish/v3/:round", RoundController.finishRound);
app.all("/round/eventfinish/v3/:round/", RoundController.finishRound);
app.post("/round/eventfinish/v4/:round", RoundController.finishRoundV4);
app.post("/round/customroundfinish/:round", RoundController.finishCustomRound);
app.post("/round/customroundfinish/:round/", RoundController.finishCustomRound);
app.all("/round/customroundfinish/:round", RoundController.finishCustomRound);
app.all("/round/customroundfinish/:round/", RoundController.finishCustomRound);

app.get("/battlepass", BattlePassController.getBattlePass);
app.post("/battlepass/complete", BattlePassController.completeBattlePass);

app.get("/economy/purchase/:item", EconomyController.purchase);
app.get("/economy/purchasegasha/:itemId/:count", EconomyController.purchaseGasha);
// Safety net: se LobbyFixes non matcha, NON tornare SPIN_NOT_CONFIGURED
app.all("/economy/purchasedrop/:itemId/:count", async (req, res) => {
  try {
    const { LobbyController } = require("./LobbyFixes");
    return LobbyController.purchaseDrop(req, res);
  } catch (e) {
    console.error("[LOBBY] purchasedrop fallback EXC", e);
    return res.status(200).json({ Rewards: [{ Type: "CURRENCY", TypeInfo: "gems", Amount: 10 }] });
  }
});
app.all("/economy/purchaseluckyspin", async (req, res) => {
  try {
    const { LobbyController } = require("./LobbyFixes");
    return LobbyController.purchaseLuckySpin(req, res);
  } catch (e) {
    return res.status(200).json({ Rewards: [{ Type: "CURRENCY", TypeInfo: "gems", Amount: 5 }] });
  }
});
app.post("/economy/:currencyType/give/:amount", EconomyController.giveCurrency);

app.get("/missions", MissionsController.getMissions);
app.post("/missions/:missionId/rewards/claim/v2", MissionsController.claimMissionReward);
app.post(
  "/missions/objective/:objectiveId/:milestoneId/rewards/claim/v2",
  MissionsController.claimMilestoneReward
);

app.post("/friends/request/accept", FriendsController.add);
app.delete("/friends/:UserId", FriendsController.remove);
app.get("/friends", FriendsController.list);
app.post("/friends/search", FriendsController.search);
app.post("/friends/request", FriendsController.request);
app.post("/friends/accept", FriendsController.accept);
app.post("/friends/request/decline", FriendsController.reject);
app.post("/friends/cancel", FriendsController.cancel);
app.get("/friends/request", FriendsController.pending);

app.get(["/game-events/me", "/game-events/me/"], EventsController.getActive);
app.get("/news/getall", NewsController.GetNews);
app.post("/analytics", AnalyticsController.analytic);

app.get("/social/interactions", SocialController.getInteractions);

app.get("/tournamentx/active", TournamentXController.getActive);
app.get("/tournamentx/active/v2", TournamentXController.getActive);
app.get("/tournamentx/seasons", TournamentXController.getSeasons);
app.get("/tournamentx/season/:seasonId/progress", TournamentXController.getSeasonProgress);
app.post("/tournamentx/season/:seasonId/claim/:awardId", TournamentXController.claimSeasonReward);
app.post("/tournamentx/:tournamentId/join", TournamentXController.join);
app.post("/tournamentx/:tournamentId/join/v2", TournamentXController.join);
app.post("/tournamentx/:tournamentId/leave", TournamentXController.leave);
app.post("/tournamentx/:tournamentId/leave/v2", TournamentXController.leave);
app.post("/round/tournament/finish/v2", TournamentXController.finish);

// Classic tournament stubs montati da ClassicTournamentFixes (sopra)

app.get("/api/v1/ping", async (req, res) => {
  res.status(200).send("OK");
});

app.post("/user/setpremiumusername", async (req, res) => {
  try {
    const adminKey = process.env.AdminUsernameKey || "";
    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const username = req.headers.username;
    const userId = req.headers.userid;
    if (!username || !userId) {
      return res.status(400).json({ message: "Username and UserID required in headers" });
    }

    const oldUser = await getUserForLogByIdentifier(userId);

    await UserModel.update(userId, {
      premiumUsername: username.trim(),
      username: username.trim()
    });

    const newUser = await getUserForLogByIdentifier(userId);
    const embed = buildNameChangeEmbed(oldUser, newUser, username.trim());
    logUser("Username cambiato.");
    await sendNamesEmbed(embed);

    res.status(200).json({
      success: true,
      message: "Premium username set successfully",
      username: username.trim()
    });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/user/setadminusername", async (req, res) => {
  try {
    const adminKey = process.env.AdminUsernameKey || "";
    if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const username = req.headers.username;
    const userId = req.headers.userid;
    if (!username || !userId) {
      return res.status(400).json({ message: "Username and UserID required in headers" });
    }

    const oldUser = await getUserForLogByIdentifier(userId);

    await UserModel.update(userId, {
      adminUsername: username,
      username: username
    });

    const newUser = await getUserForLogByIdentifier(userId);
    const embed = buildNameChangeEmbed(oldUser, newUser, username);
    logUser("Username cambiato.");
    await sendNamesEmbed(embed);

    res.status(200).json({
      success: true,
      message: "Admin username set successfully",
      username
    });
  } catch (err) {
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/api/v1/userLoginExternal", async (req, res, next) => {
  try {
    const deviceid = getDeviceIdFromReq(req);
    if (deviceid) {
      const ban = await getBanByDeviceId(deviceid);
      if (ban) return res.status(403).json(bannedPayload(ban.banReason));

      try {
        const user = await UserModel.findByDeviceId(deviceid);
        if (user && user.isBanned === true) {
          return res.status(403).json(bannedPayload(user.banReason));
        }
      } catch (banUserErr) {
        console.warn("[LOGIN_EXTERNAL] ban user check skipped:", banUserErr && banUserErr.message ? banUserErr.message : banUserErr);
      }
    }
    return TournamentController.login(req, res, next);
  } catch (e) {
    console.error("[LOGIN_EXTERNAL] error", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.get("/api/v1/tournaments", TournamentController.getActive);

app.get("/leaderboard/age", async (req, res) => {
  try {
    const col = await usersCol();
    if (!col) return res.json([]);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "100", 10), 200));
    const country =
      typeof req.query.country === "string" && req.query.country.trim().toLowerCase() !== "global"
        ? req.query.country.trim()
        : "";
    const filter = { age: { $type: "number" } };
    if (country) filter.country = country;

    const docs = await col
      .find(filter)
      .project({ id: 1, deviceId: 1, deviceid: 1, username: 1, age: 1 })
      .sort({ age: -1 })
      .limit(limit)
      .toArray();

    res.json(
      docs.map(u => ({
        id: String(u.id ?? ""),
        deviceId: u.deviceId ?? u.deviceid ?? "",
        username: u.username ?? "",
        age: typeof u.age === "number" ? u.age : 0
      }))
    );
  } catch (err) {
    res.status(500).json({ error: "internal_error" });
  }
});

// /user/age handlers sono definiti sopra (GET+POST) — non duplicare

app.post("/user/cheat", async (req, res) => {
  try {
    const reason = (req.body?.reason || "").toString().trim() || "cheat_detected";
    const deviceid = (req.body?.deviceid || req.body?.deviceId || "").toString().trim();
    if (!deviceid) return res.status(400).json({ ok: false, error: "missing_deviceid" });

    const u0 = await getUserForLogByDeviceId(deviceid);

    await banByDeviceId(deviceid, reason);

    const col = await usersCol();
    if (col) {
      await col.updateMany(
        { $or: [{ deviceId: deviceid }, { deviceid: deviceid }] },
        {
          $set: {
            isBanned: true,
            banReason: reason,
            bannedAtUtc: new Date().toISOString()
          }
        }
      );
    }

    const u1 = (await getUserForLogByDeviceId(deviceid)) || u0 || {};
    const embed = buildAntiCheatBanEmbed(u1, reason);

    logCheat("Ban applicato.");
    await sendAntiCheatEmbed(embed);

    return res.json({ ok: true });
  } catch (err) {
    console.error("[CHEAT] error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// Route ranking (prima del catch-all per non essere intercettate)
app.post("/update-crown-score", CrownController.updateScore);
app.get("/highscore/crowns/list", CrownController.list);
app.get("/highscore/events/list", EventsWonController.list);

// Handler per richieste a endpoint inesistenti: oggetto vuoto (NON {ok:true} —
// Unity falliva con "Could not cast Boolean to OfferPurchasedInfo")
app.use((req, res) => {
  const p = (req.path || "").toLowerCase();
  console.log("[UNKNOWN]", req.method, req.path);
  if (p.includes("price") || p.includes("steam") || p.includes("/list")) {
    return res.status(200).set("Content-Type", "application/json").json([]);
  }
  res.status(200).set("Content-Type", "application/json").json({});
});

app.use(errorControll);

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err && err.stack ? err.stack : err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

// Railway richiede bind su 0.0.0.0 + process.env.PORT
app.listen(PORT, "0.0.0.0", () => {
  const currentDate = new Date().toLocaleString().replace(",", " |");
  showBanner();
  logInfo(`[${Title}] | ${currentDate}`);
  logInfo(`Listening on 0.0.0.0:${PORT}`);
  try {
    SharedUtils.generateAuthPayload();
  } catch (e) {
    console.error("[BOOT] shared cache:", e && e.message ? e.message : e);
  }
  ensureMongo().catch((err) => {
    console.error("[BOOT] ensureMongo:", err && err.message ? err.message : err);
  });
});

function mapLeaderboardRow(u) {
  const v = Number(u?.age ?? u?.crowns ?? u?.score ?? u?.value ?? 0) || 0;
  return { ...u, age: v, crowns: v, score: v, value: v };
}

function filterNonZero(list) {
  return list.filter(u => (Number(u?.age ?? u?.crowns ?? u?.score ?? u?.value ?? 0) || 0) > 0);
}
