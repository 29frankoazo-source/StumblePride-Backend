const shared = require("./shared.json");
const dotenv = require("dotenv");
dotenv.config();

let _cachedPayload = null;
let _cachedJson = null;
let _cachedBuffer = null;

const RARITY_FROM_AMOUNT = {
  1: "COMMON",
  2: "UNCOMMON",
  3: "RARE",
  4: "EPIC",
  5: "LEGENDARY"
};

const RARITY_SET = new Set([
  "COMMON",
  "UNCOMMON",
  "RARE",
  "EPIC",
  "LEGENDARY",
  "SPECIAL",
  "MYTHIC",
  "MYTHICAL",
  "RANDOM"
]);

function hashStr(s) {
  let h = 2166136261;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildSkinPools(payload) {
  const skins = payload.Skins_v4 || payload.Skins || [];
  const byRarity = {};
  for (const s of skins) {
    if (!s || s.Hidden || s.IsFallback) continue;
    const id = s.SkinID || s.Id || s.id || s.ID;
    if (!id || !/^SKIN\d+/i.test(String(id))) continue;
    const r = String(s.Rarity || s.rarity || "COMMON").toUpperCase();
    if (!byRarity[r]) byRarity[r] = [];
    byRarity[r].push(String(id));
  }
  return byRarity;
}

function pickSkinForReward(byRarity, rarity, salt) {
  const want = String(rarity || "RARE").toUpperCase();
  const pool =
    byRarity[want] ||
    byRarity.RARE ||
    byRarity.EPIC ||
    byRarity.COMMON ||
    [];
  if (!pool.length) return "SKIN2";
  return pool[hashStr(salt + "|" + want) % pool.length];
}

/** Converte TypeInfo random/rarità → SkinID fisso (sprite reale, niente default). */
function normalizeBattlePassReward(reward, byRarity, salt) {
  if (!reward || typeof reward !== "object") return reward;
  const type = String(reward.Type || reward.type || "").toUpperCase();
  if (type !== "SKIN") return reward;

  let typeInfo = String(reward.TypeInfo || reward.typeInfo || "");
  const amount = Number(reward.Amount ?? reward.amount ?? 1) || 1;

  if (/^random$/i.test(typeInfo) || typeInfo === "") {
    typeInfo = RARITY_FROM_AMOUNT[amount] || "RARE";
  }

  const upper = typeInfo.toUpperCase();
  if (RARITY_SET.has(upper) || !/^SKIN\d+/i.test(typeInfo)) {
    const rarity = RARITY_SET.has(upper) ? upper : "RARE";
    const skinId = pickSkinForReward(byRarity, rarity === "RANDOM" ? "RARE" : rarity, salt);
    reward.Type = "SKIN";
    reward.TypeInfo = skinId;
    reward.Amount = 1;
    if (reward.typeInfo != null) reward.typeInfo = skinId;
    if (reward.amount != null) reward.amount = 1;
  }
  return reward;
}

function normalizeBattlePassTree(node, byRarity, path) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => normalizeBattlePassTree(item, byRarity, path + "[" + i + "]"));
    return;
  }

  for (const key of ["FreeReward", "PremiumReward", "Rewards", "rewards", "freeReward", "premiumReward"]) {
    if (Array.isArray(node[key])) {
      node[key] = node[key].map((r, i) =>
        normalizeBattlePassReward(r, byRarity, path + "." + key + "[" + i + "]")
      );
    }
  }

  for (const k of Object.keys(node)) {
    if (k === "Skins_v4" || k === "Skins") continue;
    const v = node[k];
    if (v && typeof v === "object") normalizeBattlePassTree(v, byRarity, path + "." + k);
  }
}

function normalizePhotonSettings(payload) {
  const appId =
    process.env.PHOTON_APP_ID ||
    process.env.PHOTON_REALTIME_APP_ID ||
    "cf22f86c-6c8a-4288-8865-ed4bee32b42c";
  try {
    if (!payload.PhotonSettings) payload.PhotonSettings = {};
    const ps = payload.PhotonSettings;
    const mappers = ps.PhotonAppIdMappers;
    if (Array.isArray(mappers) && mappers.length) {
      for (const m of mappers) {
        if (m && typeof m === "object") m.AppId = appId;
      }
    } else {
      ps.PhotonAppIdMappers = [{ AppId: appId, MinVersion: "0.45" }];
    }
    // Quantum AppId: keep plugin regions so the client uses QuantumPlugin / room management.
    // Do NOT clear these unless the AppId has no server plugins (old Realtime-only AppId).
    if (!Array.isArray(ps.RegionsWithPluginFactory) || ps.RegionsWithPluginFactory.length === 0) {
      ps.RegionsWithPluginFactory = ["ASIA", "EU", "IN", "INW", "TR", "USSC", "USW", "SA", "US"];
    }
    if (!Array.isArray(ps.RegionsWithRoomManagement) || ps.RegionsWithRoomManagement.length === 0) {
      ps.RegionsWithRoomManagement = ["ASIA", "EU", "IN", "INW", "TR", "USSC", "USW", "SA", "US"];
    }
    console.log(
      "[BOOT] Photon AppId=" + appId +
      " plugin-regions=" + JSON.stringify(ps.RegionsWithPluginFactory)
    );
  } catch (e) {
    console.warn("[BOOT] normalizePhoton:", e && e.message);
  }
}

function normalizeBattlePassRotation(payload) {
  try {
    const v3 = payload.BattlePassesV3 || [];
    const latest = v3.length ? v3[v3.length - 1] : null;
    const passId = latest ? Number(latest.PassID || 33) : 33;
    if (!Array.isArray(payload.BattlePassRotation)) payload.BattlePassRotation = [];
    const now = new Date();
    let active = payload.BattlePassRotation.find((r) => r && Number(r.PassID) === passId);
    if (!active) {
      active = {
        DateID: 99,
        PassID: passId,
        StartDate: "2024-01-01T00:00:00Z",
        EndDate: "2099-01-01T00:00:00Z",
        Platforms: ["xbox", "playstation", "web", "steam", "ios", "android"]
      };
      payload.BattlePassRotation.push(active);
    } else {
      const end = active.EndDate ? new Date(active.EndDate) : null;
      if (!end || isNaN(end.getTime()) || end < now) {
        active.EndDate = "2099-01-01T00:00:00Z";
      }
    }
  } catch (e) {
    console.warn("[BOOT] normalizeBPRotation:", e && e.message);
  }
}

function buildPayload() {
  const salt = process.env.LeagueSalt;
  if (!salt) {
    throw new Error("LeagueSalt não definida no .env");
  }

  // Clona una sola volta — shared.json è ~7MB
  const payload = JSON.parse(JSON.stringify(shared));

  try {
    const seasons = payload?.RankedPlaySettings?.Seasons;
    if (Array.isArray(seasons)) {
      const now = new Date();
      for (const season of seasons) {
        if (!season || typeof season !== "object") continue;
        const rawEnd = season.EndDateTime;
        const endDate = rawEnd ? new Date(rawEnd) : null;
        if (!endDate || isNaN(endDate.getTime()) || endDate < now) {
          season.EndDateTime = "2050-01-01T00:00:00Z";
        }
      }
    }
  } catch {
    // ignore
  }

  if (process.env.PUBLIC_BACKEND_URL) {
    payload.BackendUrl = process.env.PUBLIC_BACKEND_URL;
  } else if (!payload.BackendUrl || /stumbleguys\.com|scopely/i.test(String(payload.BackendUrl))) {
    payload.BackendUrl = "https://073sg.up.railway.app";
  }

  normalizePhotonSettings(payload);

  try {
    const pools = buildSkinPools(payload);
    normalizeBattlePassTree(payload.BattlePass, pools, "BattlePass");
    normalizeBattlePassTree(payload.BattlePasses, pools, "BattlePasses");
    normalizeBattlePassTree(payload.BattlePassesV3, pools, "BattlePassesV3");
    normalizeBattlePassRotation(payload);
    console.log("[BOOT] BattlePass skin rewards normalizzati (random/rarity → SkinID)");
  } catch (e) {
    console.warn("[BOOT] normalizeBattlePass:", e && e.message ? e.message : e);
  }

  try {
    normalizeXpRoad(payload.XpRoad);
  } catch (e) {
    console.warn("[BOOT] normalizeXpRoad:", e && e.message ? e.message : e);
  }

  // Dump SharedData.TournamentXConfig — senza questo il client nasconde il bottone TourX
  if (!payload.TournamentXConfig || typeof payload.TournamentXConfig !== "object") {
    payload.TournamentXConfig = {
      RequestActiveTournamentsRateLimitSeconds: 60,
      OverrideMatchmakingPoolsForRegions: [],
      TargetOverrideMatchmakingPool: 0
    };
    console.log("[BOOT] TournamentXConfig iniettato nello shared");
  } else {
    if (payload.TournamentXConfig.RequestActiveTournamentsRateLimitSeconds == null) {
      payload.TournamentXConfig.RequestActiveTournamentsRateLimitSeconds = 60;
    }
    if (!Array.isArray(payload.TournamentXConfig.OverrideMatchmakingPoolsForRegions)) {
      payload.TournamentXConfig.OverrideMatchmakingPoolsForRegions = [];
    }
    if (payload.TournamentXConfig.TargetOverrideMatchmakingPool == null) {
      payload.TournamentXConfig.TargetOverrideMatchmakingPool = 0;
    }
  }

  return payload;
}

function normalizeGameReward(g) {
  if (!g || typeof g !== "object") return g;
  if (g.Type == null && g.type != null) g.Type = g.type;
  if (g.TypeInfo == null && g.typeInfo != null) g.TypeInfo = g.typeInfo;
  if (g.Source == null && g.source != null) g.Source = g.source || "";
  if (g.Chance == null && g.chance != null) g.Chance = Number(g.chance) || 0;
  if (g.Min == null && g.min != null) g.Min = Number(g.min) || 0;
  if (g.Max == null && g.max != null) g.Max = Number(g.max) || 0;
  return g;
}

function normalizeXpRoadLevel(level) {
  if (!level || typeof level !== "object") return;
  if (level.RequiredXP == null && level.RequiredXp != null) {
    level.RequiredXP = Number(level.RequiredXp) || 0;
  }
  if (!Array.isArray(level.Rewards)) level.Rewards = [];
  for (const reward of level.Rewards) {
    if (!reward || typeof reward !== "object") continue;
    if (reward.ID == null && reward.Id != null) reward.ID = Number(reward.Id) || 0;
    if (typeof reward.Segmented !== "boolean") reward.Segmented = !!reward.Segmented;
    if (!Array.isArray(reward.Rewards)) reward.Rewards = [];
    reward.Rewards = reward.Rewards.map(normalizeGameReward);
  }
}

function normalizeXpRoad(xpRoad) {
  if (!xpRoad || typeof xpRoad !== "object") return;
  if (!xpRoad.SegmentedLevelRewards || typeof xpRoad.SegmentedLevelRewards !== "object") {
    xpRoad.SegmentedLevelRewards = {};
  }
  if (xpRoad.SegmentedEndlessLevelRewards == null) {
    xpRoad.SegmentedEndlessLevelRewards = "";
  }
  if (!Array.isArray(xpRoad.Levels)) xpRoad.Levels = [];
  for (const level of xpRoad.Levels) normalizeXpRoadLevel(level);
  if (xpRoad.EndlessLevel) normalizeXpRoadLevel(xpRoad.EndlessLevel);
}

function generateAuthPayload() {
  if (!_cachedPayload) {
    _cachedPayload = buildPayload();
    _cachedJson = JSON.stringify(_cachedPayload);
    _cachedBuffer = Buffer.from(_cachedJson, "utf8");
    console.log(
      `[BOOT] shared config cached: ${(_cachedBuffer.length / 1024 / 1024).toFixed(2)} MB raw`
    );
  }
  return _cachedPayload;
}

function getSharedJsonBuffer() {
  generateAuthPayload();
  return _cachedBuffer;
}

function getSharedJsonString() {
  generateAuthPayload();
  return _cachedJson;
}

module.exports = {
  generateAuthPayload,
  getSharedJsonBuffer,
  getSharedJsonString
};
