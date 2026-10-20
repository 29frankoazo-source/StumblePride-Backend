const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Console = require("./ConsoleUtils");
const dotenv = require('dotenv');
dotenv.config();
const { MONGO_URI, DB_NAME, MONGO_CLIENT_OPTIONS, maskMongoUri } = require("./mongoConfig");
const CryptoUtils = require("./CryptoUtils");
const CountryFinder = require("./CountryFinder");

const { generateAuthPayload } = require("./SharedUtils");
const SharedData = require("./shared.json");


const isAllSkinsUnlocked = false;
const isAllEmotesUnlocked = false;
const isAllAnimationsUnlocked = true;
const isAllFootstepsUnlocked = true;
const isAllActionEmotesUnlocked = true;


function collectCosmeticIds(list, idKeys) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    let id = null;
    for (const k of idKeys) {
      if (item[k] != null && item[k] !== "") {
        id = String(item[k]);
        break;
      }
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

let _cachedAllCosmetics = null;
function getAllCosmeticsCatalog() {
  if (_cachedAllCosmetics) return _cachedAllCosmetics;
  const actionList = Array.isArray(SharedData?.ActionEmotes?.ActionEmotes)
    ? SharedData.ActionEmotes.ActionEmotes
    : Array.isArray(SharedData?.ActionEmotes)
      ? SharedData.ActionEmotes
      : [];
  _cachedAllCosmetics = {
    skins: collectCosmeticIds(SharedData.Skins_v4 || SharedData.Skins || [], ["SkinID", "Id", "ID", "id"]),
    emotes: collectCosmeticIds(SharedData.Emotes_v2 || SharedData.Emotes || [], ["ID", "Id", "id"]),
    animations: collectCosmeticIds(SharedData.Animations_v2 || SharedData.Animations || [], ["ID", "Id", "id"]),
    footsteps: collectCosmeticIds(SharedData.Footsteps_v2 || SharedData.Footsteps || [], ["ID", "Id", "id"]),
    actionEmotes: collectCosmeticIds(actionList, ["Id", "ID", "id"])
  };
  return _cachedAllCosmetics;
}

const DEFAULT_SKINS = ["SKIN1", "SKIN2"];
const DEFAULT_EMOTES = ["emote_cry", "emote_hi", "emote_gg", "emote_haha", "emote_happy"];
const DEFAULT_ANIMATIONS = ["animation1"];
const DEFAULT_FOOTSTEPS = ["footsteps_smoke"];

/** Build starter or full unlock lists for a new/updated user. */
function resolveCosmeticInventories(existing = {}) {
  const all = getAllCosmeticsCatalog();
  return {
    skins: isAllSkinsUnlocked
      ? all.skins
      : Array.isArray(existing.skins) && existing.skins.length
        ? existing.skins
        : DEFAULT_SKINS,
    emotes: isAllEmotesUnlocked
      ? all.emotes
      : Array.isArray(existing.emotes) && existing.emotes.length
        ? existing.emotes
        : DEFAULT_EMOTES,
    animations: isAllAnimationsUnlocked
      ? all.animations
      : Array.isArray(existing.animations) && existing.animations.length
        ? existing.animations
        : DEFAULT_ANIMATIONS,
    footsteps: isAllFootstepsUnlocked
      ? all.footsteps
      : Array.isArray(existing.footsteps) && existing.footsteps.length
        ? existing.footsteps
        : DEFAULT_FOOTSTEPS,
    actionEmotes: isAllActionEmotesUnlocked
      ? all.actionEmotes
      : Array.isArray(existing.actionEmotes) && existing.actionEmotes.length
        ? existing.actionEmotes
        : []
  };
}

function arraysEqualUnordered(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const x of a) if (!setB.has(x)) return false;
  return true;
}

/**
 * Apply unlock toggles onto a user object and persist to Mongo when needed.
 * Returns the (possibly updated) user.
 */
async function applyCosmeticUnlocks(user) {
  if (!user || !user.stumbleId) return user;
  const next = resolveCosmeticInventories(user);
  const patch = {};
  if (isAllSkinsUnlocked && !arraysEqualUnordered(user.skins, next.skins)) patch.skins = next.skins;
  if (isAllEmotesUnlocked && !arraysEqualUnordered(user.emotes, next.emotes)) patch.emotes = next.emotes;
  if (isAllAnimationsUnlocked && !arraysEqualUnordered(user.animations, next.animations)) {
    patch.animations = next.animations;
  }
  if (isAllFootstepsUnlocked && !arraysEqualUnordered(user.footsteps, next.footsteps)) {
    patch.footsteps = next.footsteps;
  }
  if (isAllActionEmotesUnlocked && !arraysEqualUnordered(user.actionEmotes, next.actionEmotes)) {
    patch.actionEmotes = next.actionEmotes;
  }

  Object.assign(user, next);

  if (Object.keys(patch).length === 0) return user;
  try {
    const updated = await UserModel.update(user.stumbleId, patch);
    return updated || user;
  } catch (err) {
    console.warn(
      "[UNLOCK] persist cosmetics failed:",
      err && err.message ? err.message : err
    );
    return user;
  }
}

const BackendUtils = {
  generateId: () => crypto.randomBytes(16).toString('hex'),
  createHash: (...args) => crypto.createHash('sha256').update(args.join('')).digest('hex'),
  getTimestamp: () => Math.floor(Date.now() / 1000),
  validateAuthHeader: (authHeader) => {
    if (!authHeader || typeof authHeader !== 'string') return null;
    try {
      const parsed = JSON.parse(authHeader);
      if (!parsed.DeviceId) return null;
      return { DeviceId: parsed.DeviceId, StumbleId: parsed.StumbleId };
    } catch {
      return null;
    }
  },
  createLoginHash: (deviceId, version, timestamp, stumbleId, steamTicket, scopelyId) => {
    const hashInput = `${deviceId}${version}${timestamp}${stumbleId || ''}${steamTicket || ''}${scopelyId || ''}${process.env.LeagueSalt}`;
    return crypto.createHash('md5').update(hashInput).digest('hex');
  },
  createRegularHash: (deviceId, googleId, token, timestamp, stumbleId, url, body) => {
    const hashInput = `${deviceId}${googleId}${token}${timestamp}${stumbleId}${url}${body || ''}${process.env.LeagueSalt}`;
    return crypto.createHash('md5').update(hashInput).digest('hex');
  },
  createGameId: (type = 'regular') => {
    const prefix = type === 'event' ? 'EV' : 'RG';
    return `${prefix}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  },
  formatNumber: (num) => {
    return new Intl.NumberFormat('en-US').format(num);
  },
  GenAndroidId: () => {
    return `android-${crypto.randomBytes(8).toString('hex')}`;
  },
  GenCaracters: (length) => {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  },
  LeagueEncrypt: (text) => {
    const cipher = crypto.createCipheriv('aes-256-cbc', process.env.LeagueSalt, crypto.randomBytes(16));
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  },
  Hash: (algorithm, data) => {
    return crypto.createHash(algorithm).update(data).digest('hex');
  }
};

class Database {
  constructor() {
    this.mongoUri = MONGO_URI;
    this.dbName = DB_NAME;
    this.client = null;
    this.db = null;
    this.ready = false;
    this._memoryUsers = new Map(); // deviceId/stumbleId -> user (fallback se Mongo down)
    this.collections = {
  Users: null,
  Analytics: null,
  News: null,
  Events: null,
  BattlePasses: null,
  Skins: null,
  Missions: null,
  PurchasableItems: null,
  Animations: null,
  Emotes: null,
  Footsteps: null,
  Parties: null
};
  }

  _memKeyDevice(deviceId) {
    return `dev:${deviceId}`;
  }

  _memKeyStumble(stumbleId) {
    return `sid:${stumbleId}`;
  }

  _memSave(user) {
    if (!user) return user;
    if (user.deviceId) this._memoryUsers.set(this._memKeyDevice(user.deviceId), user);
    if (user.stumbleId) this._memoryUsers.set(this._memKeyStumble(user.stumbleId), user);
    if (Array.isArray(user.alternateDeviceIds)) {
      for (const d of user.alternateDeviceIds) {
        if (d) this._memoryUsers.set(this._memKeyDevice(d), user);
      }
    }
    return user;
  }

  _memFind(query) {
    if (!query || typeof query !== "object") return null;
    if (query.deviceId) {
      return this._memoryUsers.get(this._memKeyDevice(query.deviceId)) || null;
    }
    if (query.stumbleId) {
      return this._memoryUsers.get(this._memKeyStumble(query.stumbleId)) || null;
    }
    if (query.$or && Array.isArray(query.$or)) {
      for (const part of query.$or) {
        const hit = this._memFind(part);
        if (hit) return hit;
        if (part.alternateDeviceIds) {
          const d = part.alternateDeviceIds;
          const byAlt = this._memoryUsers.get(this._memKeyDevice(d));
          if (byAlt) return byAlt;
        }
      }
    }
    if (query.scopelyId || query.token || query.usernameLower || query.id !== undefined) {
      for (const u of this._memoryUsers.values()) {
        if (!u) continue;
        if (query.scopelyId && u.scopelyId === query.scopelyId) return u;
        if (query.token && u.token === query.token) return u;
        if (query.usernameLower && (u.usernameLower === query.usernameLower)) {
          if (query.id && query.id.$ne !== undefined && u.id === query.id.$ne) continue;
          return u;
        }
        if (query.id !== undefined && typeof query.id === "number" && u.id === query.id) return u;
      }
    }
    return null;
  }

  async connect() {
    if (!this.mongoUri) {
      throw new Error("mongoUri mancante nelle env");
    }
    if (!this._uriLogged) {
      this._uriLogged = true;
      console.log("[BOOT] mongoUri usata da BackendUtils.Database:", maskMongoUri(this.mongoUri));
      console.log("[BOOT] DB_NAME usata da BackendUtils.Database:", this.dbName);
    }
    this.client = new MongoClient(this.mongoUri, MONGO_CLIENT_OPTIONS);
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collections.Users = this.db.collection("Users");
    this.collections.Analytics = this.db.collection("Analytics");
    this.collections.News = this.db.collection("News");
    this.collections.Events = this.db.collection("Events");
    this.collections.BattlePasses = this.db.collection("BattlePasses");
    this.collections.Skins = this.db.collection("Skins");
    this.collections.Missions = this.db.collection("Missions");
    this.collections.PurchasableItems = this.db.collection("PurchasableItems");
    this.collections.Animations = this.db.collection("Animations");
    this.collections.Emotes = this.db.collection("Emotes");
    this.collections.Footsteps = this.db.collection("Footsteps");
    this.collections.Parties = this.db.collection("Parties");
    this.ready = true;

    try {
      await this.createIndexes();
    } catch (err) {
      console.error("[BOOT] createIndexes non fatale:", err && err.message ? err.message : err);
    }
    try {
      await this.collections.Users.updateMany(
        { $or: [{ friends: { $exists: false } }, { friends: null }] },
        { $set: { friends: [] } }
      );
      await this.collections.Users.updateMany(
        { $or: [{ sentFriendRequests: { $exists: false } }, { sentFriendRequests: null }] },
        { $set: { sentFriendRequests: [] } }
      );
      await this.collections.Users.updateMany(
        { $or: [{ receivedFriendRequests: { $exists: false } }, { receivedFriendRequests: null }] },
        { $set: { receivedFriendRequests: [] } }
      );
      await this.collections.Users.updateMany(
        { $or: [{ receivedPartyInvites: { $exists: false } }, { receivedPartyInvites: null }] },
        { $set: { receivedPartyInvites: [] } }
      );
    } catch (err) {
      console.error("[BOOT] friends backfill non fatale:", err && err.message ? err.message : err);
    }
    try {
      const missingLower = await this.collections.Users
        .find({
          $or: [{ usernameLower: { $exists: false } }, { usernameLower: null }, { usernameLower: "" }]
        })
        .project({ username: 1 })
        .limit(5000)
        .toArray();
      for (const doc of missingLower) {
        const lower = getBaseUsername(doc.username || "").toLowerCase();
        if (!lower) continue;
        await this.collections.Users.updateOne(
          { _id: doc._id },
          { $set: { usernameLower: lower } }
        );
      }
    } catch (err) {
      console.error("[BOOT] usernameLower backfill non fatale:", err && err.message ? err.message : err);
    }
    // Populate solo se vuoto — NON a ogni restart (causava timeout/OOM/crash loop)
    try {
      await this.autoPopulateSharedData();
    } catch (err) {
      console.error("[BOOT] autoPopulate non fatale:", err && err.message ? err.message : err);
    }
    Console.log("Database", 'Connesso al database');
  }

  async autoPopulateSharedData() {
    try {
      const skinCount = await this.collections.Skins.estimatedDocumentCount();
      if (skinCount === 0 && SharedData.Skins_v4?.length > 0) {
        await this.collections.Skins.insertMany(
          SharedData.Skins_v4.map((skin) => ({ ...skin })),
          { ordered: false }
        );
      }

      const animCount = await this.collections.Animations.estimatedDocumentCount();
      if (animCount === 0 && SharedData.Animations_v2?.length > 0) {
        await this.collections.Animations.insertMany(
          SharedData.Animations_v2.map((anim) => ({ ...anim })),
          { ordered: false }
        );
      }

      const emoteCount = await this.collections.Emotes.estimatedDocumentCount();
      if (emoteCount === 0 && SharedData.Emotes_v2?.length > 0) {
        await this.collections.Emotes.insertMany(
          SharedData.Emotes_v2.map((emote) => ({ ...emote })),
          { ordered: false }
        );
      }

      const footCount = await this.collections.Footsteps.estimatedDocumentCount();
      if (footCount === 0 && SharedData.Footsteps_v2?.length > 0) {
        await this.collections.Footsteps.insertMany(
          SharedData.Footsteps_v2.map((footstep) => ({ ...footstep })),
          { ordered: false }
        );
      }
    } catch (error) {
      Console.error('Populate', 'Errore durante il popolamento delle collezioni:', error);
    }
  }
  async createIndexes() {
    await this.collections.Users.createIndexes([
      { key: { deviceId: 1 }, unique: true, sparse: true },
      { key: { stumbleId: 1 }, unique: true, sparse: true },
      { key: { username: 1 }, unique: true, sparse: true },
      { key: { friends: 1 } },
      { key: { sentFriendRequests: 1 } },
      { key: { receivedFriendRequests: 1 } },
      { key: { 'balances.name': 1 } }
    ]);
    
    await this.collections.Events.createIndex({ StartDateTime: 1, EndDateTime: 1 });
    await this.collections.BattlePasses.createIndex({ PassID: 1 });
    await this.collections.Skins.createIndex({ SkinID: 1 });
  }

  async getUserByQuery(query) {
    if (!this.ready || !this.collections.Users) {
      return this._memFind(query);
    }
    try {
      return await this.collections.Users.findOne(query);
    } catch (err) {
      console.error("[DB] getUserByQuery fallback memory:", err && err.message ? err.message : err);
      return this._memFind(query);
    }
  }

  async updateUser(query, updates) {
    if (!this.ready || !this.collections.Users) {
      const existing = this._memFind(query) || {};
      const merged = { ...existing };
      for (const [key, value] of Object.entries(updates || {})) {
        if (key.includes(".")) {
          const parts = key.split(".");
          let cur = merged;
          for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
            cur = cur[p];
          }
          cur[parts[parts.length - 1]] = value;
        } else {
          merged[key] = value;
        }
      }
      return this._memSave(merged);
    }
    await this.collections.Users.updateOne(query, { $set: updates });
    return await this.getUserByQuery(query);
  }

  async addToUserArray(query, arrayField, value) {
    if (!this.ready || !this.collections.Users) {
      const u = this._memFind(query);
      if (!u) return null;
      const arr = Array.isArray(u[arrayField]) ? u[arrayField] : [];
      if (!arr.includes(value)) arr.push(value);
      u[arrayField] = arr;
      return this._memSave(u);
    }
    return await this.collections.Users.updateOne(query, { $addToSet: { [arrayField]: value } });
  }

  async incrementUserBalance(query, currency, amount) {
    if (!this.ready || !this.collections.Users) {
      const u = this._memFind(query);
      if (!u) return null;
      u.balances = Array.isArray(u.balances) ? u.balances : [];
      const bal = u.balances.find((b) => b.name === currency);
      if (bal) bal.amount = (bal.amount || 0) + amount;
      else if (amount > 0) u.balances.push({ name: currency, amount });
      return this._memSave(u);
    }
    const result = await this.collections.Users.updateOne(
      { ...query, 'balances.name': currency },
      { $inc: { 'balances.$.amount': amount } }
    );

    if (result.matchedCount === 0 && amount > 0) {
      await this.collections.Users.updateOne(
        query,
        { $push: { balances: { name: currency, amount } } }
      );
    }
    return result;
  }

  async createUser(userData) {
    if (!this.ready || !this.collections.Users) {
      console.warn("[DB] Mongo offline — user creato in memoria");
      return this._memSave({ ...userData });
    }
    try {
      const result = await this.collections.Users.insertOne(userData);
      return { ...userData, _id: result.insertedId };
    } catch (err) {
      console.error("[DB] createUser fallback memory:", err && err.message ? err.message : err);
      return this._memSave({ ...userData });
    }
  }

  async getActiveEvents() {
    const now = new Date();
    return await this.collections.Events.find({
      StartDateTime: { $lte: now },
      EndDateTime: { $gte: now }
    }).toArray();
  }

  async getBattlePass(passId) {
    return await this.collections.BattlePasses.findOne({ PassID: passId });
  }

  async getSkinInfo(skinId) {
    return await this.collections.Skins.findOne({ SkinID: skinId });
  }

  async getMissionInfo(missionId) {
    return await this.collections.Missions.findOne({ Id: missionId });
  }

  async getPurchasableItem(itemId) {
    return await this.collections.PurchasableItems.findOne({ Name: itemId });
  }
}

const database = new Database();

async function connectDatabaseWithRetry(maxAttempts = 0) {
  let attempt = 0;
  while (maxAttempts === 0 || attempt < maxAttempts) {
    attempt += 1;
    try {
      await database.connect();
      console.log(`[BOOT] Mongo connesso (attempt ${attempt})`);
      return true;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      // ENOTFOUND / cluster morto: stop retry infinito (evita Unhandled + spam log)
      const permanent =
        /ENOTFOUND|querySrv|getaddrinfo|ServerSelectionError|MongoServerSelectionError/i.test(msg) ||
        /novabone2z\.l7x7akq\.mongodb\.net/i.test(msg);
      if (attempt <= 3 || attempt % 10 === 0 || permanent) {
        console.error(`[BOOT] Mongo connect fallita (attempt ${attempt}):`, msg);
      }
      if (permanent) {
        console.warn("[BOOT] Mongo DNS/cluster non raggiungibile — uso solo memory store (niente retry)");
        database.ready = false;
        return false;
      }
      // NON process.exit — tiene vivo HTTP per healthcheck Railway
      const delay = Math.min(60000, 3000 * Math.min(attempt, 10));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return false;
}

/** Feature flag obbligatori per mostrare TourX in lobby (dump string literals). */
const TOURX_FEATURE_FLAGS = [
  "TournamentsX",
  "TournamentsXMeta",
  "TournamentsXConsoles"
];

/**
 * Photon's ParameterCode.Ticket (190) is NOT supported on private AppIds without
 * official matchmaking-ticket infra — any Ticket string disconnects with code -13.
 */
const PHOTON_TICKET_FEATURE_FLAGS = [
  "UsePhotonTicketsTournamentsX",
  "UsePhotonTicketsEvents"
];

/**
 * Flag che richiedono Photon Server Plugins (Quantum/RoomManagement) sull'AppId.
 * Su AppId privati senza plugin → CreateRoom/Join falliscono e non si gioca.
 */
const PHOTON_PLUGIN_FEATURE_FLAGS = [
  "PluginFactory",
  "RoomManagement",
  "RoomManagementConsole",
  "MergeParties",
  "Consensus",
  "QuantumSystemManagement",
  "LateJoinResyncSystem"
];

function ensureFeatureFlags(flags) {
  const list = Array.isArray(flags) ? flags.map(String) : [];
  const set = new Set(list);
  for (const f of TOURX_FEATURE_FLAGS) set.add(f);
  // Quantum AppId: enable Photon plugin-related flags (needed for normal match start).
  for (const f of PHOTON_PLUGIN_FEATURE_FLAGS) set.add(f);
  for (const f of PHOTON_TICKET_FEATURE_FLAGS) set.delete(f);
  return Array.from(set);
}

/** XPRoadUserData (dump): XpRoadId, ClaimedRewardsIds, IsVeteran, LastClaimedLevel, HasBeenEnabled */
function formatXpRoadUserData(raw, userId) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    XpRoadId: Number(src.xpRoadId ?? src.XpRoadId ?? 0) || 0,
    ClaimedRewardsIds: Array.isArray(src.claimedRewardsIds || src.ClaimedRewardsIds)
      ? (src.claimedRewardsIds || src.ClaimedRewardsIds).map((n) => Number(n) || 0)
      : [],
    IsVeteran: !!(src.isVeteran ?? src.IsVeteran ?? true),
    LastClaimedLevel: Number(src.lastClaimedLevel ?? src.LastClaimedLevel ?? 1) || 1,
    HasBeenEnabled: !!(src.hasBeenEnabled ?? src.HasBeenEnabled ?? true),
    // campi extra tollerati dal client (non nel typedef minimo)
    UserId: Number(src.userId ?? src.UserId ?? userId ?? 0) || 0,
    CurrentLevelCap: Number(src.currentLevelCap ?? src.CurrentLevelCap ?? 70) || 70,
    IsOnboarding: !!(src.isOnboarding ?? src.IsOnboarding ?? false),
    OnboardingFeaturesUnlocked: Array.isArray(
      src.onboardingFeaturesUnlocked || src.OnboardingFeaturesUnlocked
    )
      ? src.onboardingFeaturesUnlocked || src.OnboardingFeaturesUnlocked
      : []
  };
}

/** Drop forced trailing reset tags from older name-change logic. */
function stripTrailingColorWhite(name) {
  return String(name || "").replace(/(?:\s*<color=white>\s*)+$/gi, "");
}

/** Strip TMP / rich-text tags like <wave:…>, <color=…>, <#RRGGBB>, <sup>. */
function stripRichTags(text) {
  return String(text || "").replace(/<[^>]*>/g, "");
}

/**
 * Visible "base" username used for uniqueness.
 * <wave:…>prox</wave> → prox
 * prox <wave:…>[W]</wave> → prox
 * kike<color=blue>[W]<#000><sup>Dev → kike
 * kikeXX → kikeXX
 */
function getBaseUsername(username) {
  const raw = stripTrailingColorWhite(username);
  if (!raw) return "";

  // Name + styled suffix/badge: "prox <wave:…>[W]</wave>" or "kike<color=…>"
  const lt = raw.indexOf("<");
  if (lt > 0) {
    return raw.slice(0, lt).replace(/\[[^\]]*\]/g, "").trim();
  }

  // Whole name styled inside wave tags
  const wave = raw.match(/<wave:[^>]*>([\s\S]*?)<\/wave>/i);
  if (wave) {
    return stripRichTags(wave[1]).replace(/\[[^\]]*\]/g, "").trim();
  }

  return stripRichTags(raw).replace(/\[[^\]]*\]/g, "").trim();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when wave inner is a badge/prefix (e.g. [W]), not the display name itself. */
function isWaveBadgeInner(inner) {
  const visible = stripRichTags(inner).trim();
  if (!visible) return true;
  if (/^\[[^\]]+\]$/.test(visible)) return true;
  if (visible.length <= 2) return true;
  if (!/^[A-Za-z0-9 _\-#.]+$/.test(visible)) return true;
  return false;
}

/**
 * Keep rich-text style (wave / rainbow / color) and only swap the visible name.
 *
 * Full styled name:
 *   <wave:#FFAA00,#FFFFFF>prox</wave> + "elle7"
 *     -> <wave:#FFAA00,#FFFFFF>elle7</wave>
 *
 * Base name + wave badge/prefix (keep badge):
 *   prox <wave:#00ffff,#000000>[W]</wave> + "elle7"
 *     -> elle7 <wave:#00ffff,#000000>[W]</wave>
 */
function rebuildStyledUsername(oldUsername, newPlainName) {
  const plain = String(newPlainName || "").trim();
  if (!plain) return stripTrailingColorWhite(oldUsername);

  let old = stripTrailingColorWhite(oldUsername);

  const waveMatch = old.match(/^(.*?)(<wave:[^>]+>)([\s\S]*?)(<\/wave>)(.*)$/i);
  if (waveMatch) {
    const leading = waveMatch[1] || "";
    const open = waveMatch[2];
    const inner = waveMatch[3];
    const close = waveMatch[4];
    const trailing = stripTrailingColorWhite(waveMatch[5] || "");
    const leadingBase = leading.replace(/\[[^\]]*\]/g, "").trim();

    // Prefix style: plain base name before a wave badge → keep badge, rename base.
    if (leadingBase && isWaveBadgeInner(inner)) {
      const spacer = /\s+$/.test(leading) ? " " : " ";
      return `${plain}${spacer}${open}${inner}${close}${trailing}`;
    }

    // Full name inside wave (also drops stray plain prefixes from older buggy renames).
    return `${open}${plain}${close}${trailing}`;
  }

  // Trailing badge / clan tags like [VIP] — keep them, but never treat </wave> as one
  const suffixMatch = old.match(/((?:\[[^\]]+\])+)$/);
  const suffix = suffixMatch ? suffixMatch[1] : "";
  let head = suffix ? old.slice(0, old.length - suffix.length) : old;

  let spaceBeforeSuffix = false;
  if (suffix && head.endsWith(" ")) {
    spaceBeforeSuffix = true;
    head = head.slice(0, -1);
  }

  function extractBaseName(restWithoutW) {
    let base = "";
    for (let i = 0; i < restWithoutW.length; i++) {
      const ch = restWithoutW[i];
      if (ch === "<") break;
      base += ch;
    }
    return base.trim();
  }

  function getAfterNamePart(restWithoutW, baseName) {
    if (!baseName) return restWithoutW;

    let i = 0;
    let j = 0;

    while (i < restWithoutW.length && j < baseName.length) {
      const ch = restWithoutW[i];

      if (ch === "<") {
        const close = restWithoutW.indexOf(">", i);
        if (close === -1) return restWithoutW;
        i = close + 1;
        continue;
      }

      if (ch === baseName[j]) {
        i++;
        j++;
      } else {
        return restWithoutW;
      }
    }

    if (j === baseName.length) return restWithoutW.slice(i);
    return restWithoutW;
  }

  const rainbowSegMatch = head.match(/^((?:<#[0-9a-fA-F]{3,8}>[^<])+)/);
  let finalUsername = "";

  if (rainbowSegMatch) {
    const seg = rainbowSegMatch[1];
    const colors = [];
    const pairRe = /(<#[0-9a-fA-F]{3,8}>)([^<])/g;
    let m;
    while ((m = pairRe.exec(seg)) !== null) colors.push(m[1]);

    if (colors.length >= 2) {
      const chars = Array.from(plain);
      let styled = "";
      for (let i = 0; i < chars.length; i++) {
        styled += colors[i % colors.length] + chars[i];
      }
      finalUsername = styled;
    }
  }

  if (!finalUsername) {
    const firstColorMatch = head.match(/^(<color=[^>]+>|<#[0-9a-fA-F]{3,8}>)/);
    const nameColor = firstColorMatch ? firstColorMatch[1] : "";
    let rest = nameColor ? head.slice(nameColor.length) : head;

    const wPrefixMatch = rest.match(/^([^A-Za-z0-9]*W\s+)/);
    const wPrefix = wPrefixMatch ? wPrefixMatch[1] : "";
    const restWithoutW = rest.slice(wPrefix.length);
    const baseName = extractBaseName(restWithoutW);
    const afterName = baseName ? getAfterNamePart(restWithoutW, baseName) : "";

    // No styling / couldn't find a base name → plain rename
    if (!nameColor && !wPrefix && !baseName && !afterName) {
      finalUsername = plain;
    } else {
      finalUsername = `${nameColor}${wPrefix}${plain}${afterName}`;
    }
  }

  if (suffix) {
    finalUsername += (spaceBeforeSuffix ? " " : "") + suffix;
  }

  const hasSupOpen = finalUsername.includes("<sup>");
  const hasSupClose = finalUsername.includes("</sup>");
  if (hasSupOpen && !hasSupClose) finalUsername += "</sup>";

  return finalUsername;
}

/** Risposta login allineata a Backend.BackendUserResponse + User (dump 0.73, PascalCase). */
function formatLoginResponse(user, photonJwt) {
  const balances = Array.isArray(user.balances)
    ? user.balances.map((b) => ({
        Name: b.name ?? b.Name ?? "",
        Amount: Number(b.amount ?? b.Amount ?? 0),
        SecondsPerUnit: Number(b.secondsPerUnit ?? b.SecondsPerUnit ?? 0),
        MaxAmount: Number(b.maxAmount ?? b.MaxAmount ?? 0),
        SecondsSince: Number(b.secondsSince ?? b.SecondsSince ?? 0),
        LastGiven: b.lastGiven ?? b.LastGiven ?? new Date().toISOString()
      }))
    : [];

  const inventory = Array.isArray(user.inventory)
    ? user.inventory.map((i) => ({
        ItemType: i.itemType ?? i.ItemType ?? "",
        Item: i.item ?? i.Item ?? "",
        Amount: Number(i.amount ?? i.Amount ?? 0)
      }))
    : [];

  // Sempre merge TourX flags (utenti già in Mongo non li hanno salvati)
  const featureFlags = ensureFeatureFlags(user.featureFlags || user.FeaturesEnabled || []);
  const equipped = formatEquippedCosmetics(user.equippedCosmetics || user.EquippedCosmetics || {});
  const battlePass = formatBattlePass(user.battlePass || user.BattlePass);
  const cosmetics = resolveCosmeticInventories(user);

  const clientUser = {
    Id: Number(user.id ?? user.Id ?? 0),
    StumbleId: user.stumbleId || user.StumbleId || "",
    DeviceId: user.deviceId || user.DeviceId || "",
    Username: stripTrailingColorWhite(user.username || user.Username || "Player"),
    Country: user.country || user.Country || "UN",
    Region: user.region || user.Region || "un",
    Token: user.token || user.Token || "",
    Version: user.version || user.Version || "0.73",
    Friends: user.friends || user.Friends || [],
    Skins: cosmetics.skins,
    SkinVariants: user.skinVariants || user.SkinVariants || [],
    Rewards: user.Rewards || user.rewards || [],
    Balances: balances,
    Created: user.createdAt || user.Created || new Date().toISOString(),
    LastLogin: user.lastLogin || user.LastLogin || new Date().toISOString(),
    SkillRating: Number(user.skillRating ?? user.SkillRating ?? 0),
    Crowns: Number(user.crowns ?? user.Crowns ?? 0),
    HiddenRating: Number(user.hiddenRating ?? user.HiddenRating ?? 0),
    Experience: Number(user.experience ?? user.Experience ?? 0),
    XpRoad: formatXpRoadUserData(user.xpRoad || user.XpRoad, user.id ?? user.Id),
    NewsVersion: Number(user.newsVersion ?? user.NewsVersion ?? 0),
    AvailableNewsVersion: Number(user.availableNewsVersion ?? user.AvailableNewsVersion ?? 0),
    LatestNewsIdBackend: Number(user.latestNewsIdBackend ?? user.LatestNewsIdBackend ?? 0),
    Emotes: cosmetics.emotes,
    Animations: cosmetics.animations,
    Footsteps: cosmetics.footsteps,
    ActionEmotes: cosmetics.actionEmotes,
    HasBattlePass: !!(user.hasBattlePass ?? user.HasBattlePass),
    PassTokens: Number(user.passTokens ?? user.PassTokens ?? battlePass?.PassTokens ?? 0),
    FreePassRewards: user.freePassRewards || user.FreePassRewards || battlePass?.FreePassRewards || [],
    PremiumPassRewards: user.premiumPassRewards || user.PremiumPassRewards || battlePass?.PremiumPassRewards || [],
    KidFriendlyMode: Number(user.kidFriendlyMode ?? user.KidFriendlyMode ?? 0),
    Age: Math.max(18, Number(user.age ?? user.Age ?? 18) || 18),
    TermsOfServiceAccepted: true,
    FeaturesEnabled: featureFlags,
    BattlePass: battlePass,
    SecondsSinceCreated: Number(user.secondsSinceCreated ?? user.SecondsSinceCreated ?? 0),
    PhotonJwt: photonJwt || "",
    NativePlatformName: user.userProfile?.nativePlatformName || "android",
    Inventory: inventory,
    UserFlags: user.userFlags || user.UserFlags || {},
    EquippedCosmetics: equipped
  };

  return {
    User: clientUser,
    TermsOfServiceAccepted: true,
    PhotonJwt: photonJwt || "",
    ScopelyId: user.scopelyId || user.ScopelyId || "",
    FeatureFlags: featureFlags,
    EquippedCosmetics: equipped
  };
}

/** Cosmetics in PascalCase come UserEquippedCosmeticsDto (dump 0.73). */
function normalizeActionEmote(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return null;
  const s = String(v).trim();
  if (!s || /^\d+$/.test(s)) return null;
  return s;
}

function formatEquippedCosmetics(eq = {}) {
  return {
    Skin: eq.skin || eq.Skin || "SKIN1",
    Color: eq.color || eq.Color || "COLOR1",
    Animation: eq.animation || eq.Animation || "animation1",
    Footsteps: eq.footsteps || eq.Footsteps || "footsteps_smoke",
    Emote1: eq.emote1 || eq.Emote1 || "emote_cry",
    Emote2: eq.emote2 || eq.Emote2 || "emote_hi",
    Emote3: eq.emote3 || eq.Emote3 || "emote_gg",
    Emote4: eq.emote4 || eq.Emote4 || "emote_haha",
    ActionEmote1: normalizeActionEmote(eq.actionEmote1 ?? eq.ActionEmote1),
    ActionEmote2: normalizeActionEmote(eq.actionEmote2 ?? eq.ActionEmote2),
    ActionEmote3: normalizeActionEmote(eq.actionEmote3 ?? eq.ActionEmote3),
    ActionEmote4: normalizeActionEmote(eq.actionEmote4 ?? eq.ActionEmote4)
  };
}

function formatBattlePass(bp) {
  // PassID allineato a BattlePassesV3 più recente (33) — 72 non esiste nello shared
  const DEFAULT_PASS_ID = 33;
  if (!bp || typeof bp !== "object") {
    return {
      PassID: DEFAULT_PASS_ID,
      PassTokens: 0,
      HasPurchased: false,
      FreePassRewards: [],
      PremiumPassRewards: [],
      SlotsClaimed: [],
      Experience: 0,
      Coins: 0,
      SecondsToEnd: 904064,
      HasUsedDiscount: false,
      OldExperience: 0,
      XpBooster: 0
    };
  }
  const rawPassId = Number(bp.passID ?? bp.PassID ?? DEFAULT_PASS_ID);
  // Evita PassID fantasma (es. 72) non presenti nello shared
  const passId = rawPassId > 0 && rawPassId < 200 ? rawPassId : DEFAULT_PASS_ID;
  return {
    PassID: passId === 72 ? DEFAULT_PASS_ID : passId,
    PassTokens: Number(bp.passTokens ?? bp.PassTokens ?? 0),
    HasPurchased: !!(bp.hasPurchased ?? bp.HasPurchased),
    FreePassRewards: bp.freePassRewards || bp.FreePassRewards || [],
    PremiumPassRewards: bp.premiumPassRewards || bp.PremiumPassRewards || [],
    SlotsClaimed: bp.slotsClaimed || bp.SlotsClaimed || [],
    Experience: Number(bp.experience ?? bp.Experience ?? 0),
    Coins: Number(bp.coins ?? bp.Coins ?? 0),
    SecondsToEnd: Number(bp.secondsToEnd ?? bp.SecondsToEnd ?? 904064),
    HasUsedDiscount: !!(bp.hasUsedDiscount ?? bp.HasUsedDiscount),
    OldExperience: Number(bp.oldExperience ?? bp.OldExperience ?? 0),
    XpBooster: Number(bp.xpBooster ?? bp.XpBooster ?? 0)
  };
}

/** Alias balance client ↔ DB (login crea default_free_spins / gems lowercase). */
function resolveBalanceName(currency) {
  if (!currency) return currency;
  const key = String(currency);
  const map = {
    FreeSpins: "default_free_spins",
    free_spins: "default_free_spins",
    default_free_spins: "default_free_spins",
    AdSpins: "default_free_ad_spins",
    free_ad_spins: "default_free_ad_spins",
    default_free_ad_spins: "default_free_ad_spins",
    Gems: "gems",
    gems: "gems",
    Coins: "coins",
    coins: "coins",
    Gold: "coins",
    Dust: "dust",
    dust: "dust",
    aec: "aec",
    AEC: "aec"
  };
  return map[key] || key.toLowerCase();
}

function pickBody(body, ...keys) {
  if (!body || typeof body !== "object") return undefined;
  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null) return body[k];
  }
  return undefined;
}

async function requireUser(req, res) {
  let user = req.user;
  if (!user) {
    const authHeader = req.headers.authorization;
    if (authHeader && typeof authHeader === "string" && !authHeader.startsWith("Bearer ")) {
      try {
        const authData = JSON.parse(authHeader);
        if (authData.StumbleId) user = await UserModel.findByStumbleId(authData.StumbleId);
        if (!user && authData.DeviceId) user = await UserModel.findByDeviceId(authData.DeviceId);
        if (!user && authData.Token) user = await UserModel.findByToken(authData.Token);
      } catch {}
    }
  }
  if (!user) {
    res.status(401).json({ message: "unauthorized", error: "UNAUTHORIZED" });
    return null;
  }
  return user;
}

// Avvio non bloccante: se Mongo è down il processo resta up (niente crash loop)
connectDatabaseWithRetry().catch((err) => {
  console.error("[BOOT] connectDatabaseWithRetry fatal:", err && err.message ? err.message : err);
});

class UserModel {
  
  static async create(deviceId, platformData = {}) {
    // Ottieni il country code ISO a 2 lettere (supporta tutti i paesi: IT, US, FR, DE, GB, ES, BR, JP, CN, AU, etc.)
    let countryCode = null;
    
    // 1) Prova da platformData.country (già formattato da CountryFinder - supporta tutti i codici ISO)
    if (platformData.country) {
      const rawCountry = String(platformData.country).trim().toUpperCase();
      // Accetta qualsiasi codice ISO a 2 lettere (AD, AE, AF, AG, AI, AL, AM, AO, AQ, AR, AS, AT, AU, AW, AX, AZ, BA, BB, BD, BE, BF, BG, BH, BI, BJ, BL, BM, BN, BO, BQ, BR, BS, BT, BV, BW, BY, BZ, CA, CC, CD, CF, CG, CH, CI, CK, CL, CM, CN, CO, CR, CU, CV, CW, CX, CY, CZ, DE, DJ, DK, DM, DO, DZ, EC, EE, EG, EH, ER, ES, ET, FI, FJ, FK, FM, FO, FR, GA, GB, GD, GE, GF, GG, GH, GI, GL, GM, GN, GP, GQ, GR, GS, GT, GU, GW, GY, HK, HM, HN, HR, HT, HU, ID, IE, IL, IM, IN, IO, IQ, IR, IS, IT, JE, JM, JO, JP, KE, KG, KH, KI, KM, KN, KP, KR, KW, KY, KZ, LA, LB, LC, LI, LK, LR, LS, LT, LU, LV, LY, MA, MC, MD, ME, MF, MG, MH, MK, ML, MM, MN, MO, MP, MQ, MR, MS, MT, MU, MV, MW, MX, MY, MZ, NA, NC, NE, NF, NG, NI, NL, NO, NP, NR, NU, NZ, OM, PA, PE, PF, PG, PH, PK, PL, PM, PN, PR, PS, PT, PW, PY, QA, RE, RO, RS, RU, RW, SA, SB, SC, SD, SE, SG, SH, SI, SJ, SK, SL, SM, SN, SO, SR, SS, ST, SV, SX, SY, SZ, TC, TD, TF, TG, TH, TJ, TK, TL, TM, TN, TO, TR, TT, TV, TW, TZ, UA, UG, UM, US, UY, UZ, VA, VC, VE, VG, VI, VN, VU, WF, WS, YE, YT, ZA, ZM, ZW, etc.)
      if (/^[A-Z]{2}$/.test(rawCountry)) {
        countryCode = rawCountry;
      }
    }
    
    // 2) Se non disponibile, prova da locale (supporta tutti i codici paese)
    if (!countryCode && platformData.locale) {
      const localeStr = String(platformData.locale);
      // Supporta formati: "it-IT", "en-US", "fr-FR", "de-DE", "es-ES", "pt-BR", "ja-JP", "zh-CN", etc.
      const localeParts = localeStr.split(/[-_]/);
      for (let i = 0; i < localeParts.length; i++) {
        const part = localeParts[i].trim();
        if (/^[A-Za-z]{2}$/.test(part)) {
          const upperPart = part.toUpperCase();
          // Valida che sia un codice paese valido (2 lettere alfabetiche)
          if (/^[A-Z]{2}$/.test(upperPart)) {
            countryCode = upperPart;
            break;
          }
        }
      }
    }
    
    // 3) Fallback: usa "UN" solo se non trovato un codice valido
    if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
      countryCode = 'UN';
    }
    
    // Country: uppercase (2 lettere) - supporta tutti i codici ISO paese
    const country = countryCode.toUpperCase();
    // Region: lowercase delle stesse 2 lettere del country - supporta tutti i paesi
    const region = country.toLowerCase();
    const now = new Date();
    const userId = Math.floor(Math.random() * 99999);
    const username = 'StumblePride' + BackendUtils.GenCaracters(5).toUpperCase();
    
    const user = {
      id: userId,
      deviceId,
      alternateDeviceIds: [],
      stumbleId: BackendUtils.generateId().toUpperCase(),
      username,
      usernameLower: getBaseUsername(username).toLowerCase(),
      country: country,
      region: region,
      token: CryptoUtils.SessionToken(),
      version: platformData.Version || '0.99',
      createdAt: now,
      lastLogin: now,
      newsVersion: 0,
      skillRating: 0,
      experience: 0,
      crowns: 0,
      EventsWon: 0,
      hiddenRating: 0,
      isBanned: false,
      inventory: [{
        userId,
        itemId: 803,
        itemType: "DUPLICATE_BANK",
        item: "CONFIG_VERSION",
        amount: 3
      }],
      ...resolveCosmeticInventories(),
      friends: [],
      sentFriendRequests: [],
      receivedFriendRequests: [],
      receivedPartyInvites: [],
      hasBattlePass: false,
      passTokens: 0,
      freePassRewards: [],
      premiumPassRewards: [],
      balances: [
        { name: "coins", amount: 101, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "remove_ads", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 2, lastGiven: now },
        { name: "video", amount: 50, secondsSince: 0, secondsPerUnit: 0, maxAmount: 5000, lastGiven: now },
        { name: "gems", amount: 5000, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "video_gems", amount: 10, secondsSince: 0, secondsPerUnit: 5400, maxAmount: 10, lastGiven: now },
        { name: "video_coins", amount: 8, secondsSince: 0, secondsPerUnit: 10800, maxAmount: 8, lastGiven: now },
        { name: "special_video", amount: 3, secondsSince: 0, secondsPerUnit: 28800, maxAmount: 3, lastGiven: now },
        { name: "skin_charge", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 5, lastGiven: now },
        { name: "skin_purchase", amount: 7, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 7, lastGiven: now },
        { name: "gem_charge", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 3, lastGiven: now },
        { name: "gem_purchase", amount: 1, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 1, lastGiven: now },
        { name: "dust", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "default_free_spins", amount: 1, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: new Date(Date.now() - 86400000) },
        { name: "default_free_ad_spins", amount: 16, secondsSince: 0, secondsPerUnit: 0, maxAmount: 16, lastGiven: new Date(Date.now() - 86400000) },
        { name: "remove_interstitial_ads", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 2, lastGiven: now },
        { name: "end_of_match", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: now },
        { name: "end_of_match_event", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: now },
        { name: "video_coins_02", amount: 5, secondsSince: 0, secondsPerUnit: 28800, maxAmount: 5, lastGiven: now },
        { name: "aes", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "aec", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "ranked_friend_boost", amount: 3, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 3, lastGiven: now },
        { name: "stumble_coins", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "dust_backup", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now }
      ],
      Rewards: [],
      availableNewsVersion: 0,
      latestNewsIdBackend: 11698,
      battlePass: {
        freePassRewards: [],
        premiumPassRewards: [],
        passTokens: 0,
        hasPurchased: false,
        passID: 72,
        secondsToEnd: 904064,
        experience: 0,
        slotsClaimed: [],
        hasUsedDiscount: false,
        xpBooster: 0,
        coins: 0,
        hasUsedBonusDiscount: false,
        passDateId: 0
      },
      secondsSinceCreated: 0,
      age: 18,
      kidFriendlyMode: 0,
      termsOfServiceVersion: 99,
      termsOfServiceAccepted: true,
      xpRoad: {
        userId,
        xpRoadId: 0,
        lastClaimedLevel: 1,
        isVeteran: true,
        claimedRewardsIds: [],
        hasBeenEnabled: true,
        currentLevelCap: 70,
        isOnboarding: false,
        onboardingFeaturesUnlocked: []
      },
      userFlags: {
        hasUsedFreeNameChange: false,
        hasCoinConversionPopupShown: false,
        hasCoinConversionCompleted: false
      },
      offerSequenceState: [],
      userProfile: {
        userId,
        userName: username,
        country: country,
        trophies: 0,
        crowns: 0,
        experience: 0,
        hiddenRating: 0,
        isOnline: true,
        lastSeenDate: now.toISOString(),
        skin: "SKIN1",
        nativePlatformName: "android",
        ranked: {
          // Agganciato a una season realmente esistente nel shared.json
          // per evitare errori client tipo "The active season is null"
          currentSeasonId:
            (SharedData?.RankedPlaySettings?.Seasons &&
              SharedData.RankedPlaySettings.Seasons[0] &&
              SharedData.RankedPlaySettings.Seasons[0].Id) ||
            "LIVE_RANKED_SEASON_0",
          currentRankId: 0,
          currentTierIndex: 0
        },
        flags: 0
      },
      featureFlags: [
        "ActionEmotes",
        "ActionEmotesCustomPartyVisibility",
        // "XpRoad" disabilitato: CacheData NRE con shared attuale blocca la lobby
        // "age-request" disabilitato: popup età/ToS in loop impedisce di entrare in lobby
        "AssignInitialPhotonRegionBasedOnPing",
        "AutomatedShardSources",
        "AvailableCosmetics",
        "BattlePassActivationButton",
        "BattlePassOffer",
        "BattlePassPremiumPopupImprovement",
        "BattlePassSkipButtonOnSections",
        "BattlePassTheme",
        "BattlePassV2",
        "ConsoleFreeSpin",
        "CreatorCodes",
        "CreatorsQR",
        "CustomizeEmotesOnCustomPartyLobby",
        "CustomParty",
        "DeltaSharedConfig",
        "DiscoverabilityEvents",
        "DynamicContainer",
        "EndOfMatchRewardedVideo",
        "Events",
        "FriendsList",
        "GameplayAds",
        "GamePlayInGameNotifications",
        "GlobalLTCMetaEvent",
        "GraphicsQualitySettings",
        "HelpshiftConversation",
        "InAppMessageGifting",
        "Leaderboards",
        "LocalNotifications",
        "LootBoxes",
        "MainMenuRevamp",
        "MatchmakingFilter",
        "MemoryFixesSections",
        "Missions",
        "NewMatchmaking",
        "Offerwall",
        "OldPurchaserImplementation",
        "OneStopShop",
        "OneStopShop3dAnimations",
        "OneStopShop3dSkins",
        "OneStopShop3dTaunts",
        // No PluginFactory/RoomManagement/MergeParties/Consensus/QuantumSystemManagement:
        // richiedono Photon plugins server-side assenti sull'AppId privato → no play
        "ProjectVerano",
        // Pusher auth is a stub — enabling it shows a blank "Error!" popup on lobby.
        // "Pusher",
        "Ranked",
        "RankedPlayWithFriends",
        "RemoteLocalizations",
        "SavePhotonRegionOnBackend",
        "ScopelyAccount",
        "ScopelyAccountApple",
        "SequentialOffers",
        "Shards",
        "ShardsDuplicateBank",
        "ShopOfferCentering",
        "ShopOfferPurchaseLimitIndicator",
        "SimulationGamePayload",
        "SpecialEmoteFilter",
        "StartupNewFlow",
        "StaticBundles",
        "SteamInventory",
        "TransferAppleIdAuthorization",
        "TournamentsX",
        "TournamentsXMeta",
        "TournamentsXConsoles",
        "UserConfiguration",
        "UserGeneratedContent",
        "UserTimeRecords",
        "WebGLRealMoneyOffers",
        "WorkshopCustomThumbnails"
        // "XpRoad" — CacheData NRE blocca lobby finché shared non è allineato
      ],
      googleId: platformData.googleId || '',
      facebookId: platformData.facebookId || '',
      appleId: platformData.appleId || '',
      scopelyId: platformData.scopelyId || '',
      steamTicket: platformData.steamTicket || '',
      equippedCosmetics: {
        skin: 'SKIN1',
        color: 'COLOR1',
        animation: 'animation1',
        footsteps: 'footsteps_smoke',
        emote1: 'emote_cry',
        emote2: 'emote_hi',
        emote3: 'emote_gg',
        emote4: 'emote_haha',
        // dump: ActionEmote* sono string? — mai InternalId numerici
        actionEmote1: null,
        actionEmote2: null,
        actionEmote3: null,
        actionEmote4: null
      },
      tournamentSeasons: [
        {
          seasonId: 1,
          xp: 0,
          claimedAwards: []
        }
      ]
    };

    return await database.createUser(user);
  }
 

  static async findByDeviceId(deviceId) {
    if (!deviceId) return null;
    return await database.getUserByQuery({
      $or: [
        { deviceId },
        { alternateDeviceIds: deviceId }
      ]
    });
  }

  static async findByStumbleId(stumbleId) {
    return await database.getUserByQuery({ stumbleId });
  }

  static async findByToken(token) {
    if (!token) return null;
    return await database.getUserByQuery({ token });
  }

  static async findBySteamTicket(steamTicket) {
    if (!steamTicket) return null;
    return await database.getUserByQuery({ steamTicket });
  }

  static async findByScopelyId(rawScopelyId) {
    if (!rawScopelyId || typeof rawScopelyId !== 'string') return null;
    const trimmed = rawScopelyId.trim();
    if (!trimmed) return null;
    const hashed = BackendUtils.Hash('md5', trimmed);
    return await database.getUserByQuery({
      $or: [{ scopelyId: trimmed }, { scopelyId: hashed }]
    });
  }

  /** True if another account already owns this base name (tags ignored). */
  static async isBaseUsernameTaken(baseName, excludeUserId) {
    const needle = (
      getBaseUsername(baseName) || String(baseName || "").trim()
    ).toLowerCase();
    if (!needle) return false;

    const ownedByOther = (u) => {
      if (!u) return false;
      if (excludeUserId != null && u.id === excludeUserId) return false;
      const fromName = getBaseUsername(u.username || u.Username || "").toLowerCase();
      const fromField = String(u.usernameLower || "").toLowerCase();
      return fromName === needle || fromField === needle;
    };

    const byLower = await database.getUserByQuery({ usernameLower: needle });
    if (ownedByOther(byLower)) return true;

    if (database.ready && database.collections.Users) {
      try {
        const filter = {
          username: { $regex: escapeRegex(needle), $options: "i" }
        };
        if (excludeUserId != null) filter.id = { $ne: excludeUserId };
        const candidates = await database.collections.Users
          .find(filter, { projection: { username: 1, usernameLower: 1, id: 1 } })
          .limit(100)
          .toArray();
        for (const u of candidates) {
          if (ownedByOther(u)) return true;
        }
      } catch (err) {
        console.warn(
          "[USERNAME] base uniqueness scan:",
          err && err.message ? err.message : err
        );
      }
    } else if (database._memoryUsers) {
      for (const u of database._memoryUsers.values()) {
        if (ownedByOther(u)) return true;
      }
    }

    return false;
  }

  static async addAlternateDeviceId(stumbleId, deviceId) {
    if (!stumbleId || !deviceId) return;
    if (!database.ready || !database.collections.Users) {
      const u = database._memFind({ stumbleId });
      if (!u) return;
      u.alternateDeviceIds = Array.isArray(u.alternateDeviceIds) ? u.alternateDeviceIds : [];
      if (!u.alternateDeviceIds.includes(deviceId)) u.alternateDeviceIds.push(deviceId);
      database._memSave(u);
      return;
    }
    try {
      await database.collections.Users.updateOne(
        { stumbleId },
        { $addToSet: { alternateDeviceIds: deviceId } }
      );
    } catch (err) {
      console.warn("[DB] addAlternateDeviceId fallback memory:", err && err.message ? err.message : err);
      const u = database._memFind({ stumbleId });
      if (!u) return;
      u.alternateDeviceIds = Array.isArray(u.alternateDeviceIds) ? u.alternateDeviceIds : [];
      if (!u.alternateDeviceIds.includes(deviceId)) u.alternateDeviceIds.push(deviceId);
      database._memSave(u);
    }
  }

  static async findById(id) {
    return await database.getUserByQuery({ id: parseInt(id) });
  }

  static async update(stumbleId, updates) {
    return await database.updateUser({ stumbleId }, updates);
  }

  static async _resolveBalanceQuery(idOrUser) {
    if (!idOrUser) return null;
    if (typeof idOrUser === "object") {
      if (idOrUser.deviceId) return { deviceId: idOrUser.deviceId };
      if (idOrUser.stumbleId) return { stumbleId: idOrUser.stumbleId };
    }
    const asStr = String(idOrUser);
    const byStumble = await this.findByStumbleId(asStr);
    if (byStumble) return { deviceId: byStumble.deviceId };
    const byDevice = await this.findByDeviceId(asStr);
    if (byDevice) return { deviceId: byDevice.deviceId };
    return { deviceId: asStr };
  }

  static async addBalance(idOrUser, currency, amount) {
    const query = await this._resolveBalanceQuery(idOrUser);
    if (!query) return null;
    return await database.incrementUserBalance(query, resolveBalanceName(currency), amount);
  }

  static async removeBalance(idOrUser, currency, amount) {
    const query = await this._resolveBalanceQuery(idOrUser);
    if (!query) return null;
    return await database.incrementUserBalance(query, resolveBalanceName(currency), -amount);
  }

  static async addSkin(stumbleId, skinId) {
    return await database.addToUserArray({ stumbleId }, 'skins', skinId);
  }

  static async addEmote(stumbleId, emoteId) {
    return await database.addToUserArray({ stumbleId }, 'emotes', emoteId);
  }

  static async addActionEmote(stumbleId, emoteId) {
    return await database.addToUserArray({ stumbleId }, 'actionEmotes', emoteId);
  }

  static async setEquippedCosmetic(stumbleId, cosmeticType, cosmeticId) {
    const user = await this.findByStumbleId(stumbleId);
    if (!user) throw new Error("User not found");

    const updatedCosmetics = { ...user.equippedCosmetics, [cosmeticType]: cosmeticId };
    return await this.update(stumbleId, { equippedCosmetics: updatedCosmetics });
  }

  static async claimBattlePassSlot(deviceId, slotKey) {
    const user = await this.findByDeviceId(deviceId);
    if (user.battlePass.slotsClaimed.includes(slotKey)) {
      throw new Error("Slot already claimed");
    }

    await database.collections.Users.updateOne(
      { deviceId },
      { $push: { 'battlePass.slotsClaimed': slotKey } }
    );
    return await this.findByDeviceId(deviceId);
  }

  static async addBattlePassExperience(deviceId, xpToAdd) {
    // Battle Pass disabilitato: non modificare più l'esperienza
    // Ritorna semplicemente l'utente corrente senza toccare i punti BP
    return await this.findByDeviceId(deviceId);
  }

  static async GetHighscore(type, country, start = 0, count = 50) {
    const filter = {};
    const projection = { username: 1, country: 1, _id: 0 };
    let sortField;
    let valueField;

    if (type === "crowns") {
      filter.crowns = { $exists: true, $gt: 0 };
      projection.crowns = 1;
      sortField = "crowns";
      valueField = "Crowns";
    } else if (type === "rank") {
      filter.skillRating = { $gt: 0 };
      projection.skillRating = 1;
      sortField = "skillRating";
      valueField = "SkillRating";
    } else if (type === "eventsWon" || type === "events") {
      // Ranking Events tab — sort by Users.EventsWon
      filter.EventsWon = { $exists: true, $gt: 0 };
      projection.EventsWon = 1;
      sortField = "EventsWon";
      valueField = "SkillRating";
    } else {
      return { Error: "Unknown highscore type", scores: [] };
    }

    if (country && country.toLowerCase() !== "") {
      filter.country = country;
    }

    const users = await database.collections.Users
      .find(filter)
      .sort({ [sortField]: -1 })
      .project(projection)
      .skip(parseInt(start))
      .limit(parseInt(count))
      .toArray();

    if (users.length === 0) {
      return { scores: [] };
    }

    const scores = users.map(user => {
      let value = 0;
      if (type === "crowns") value = user.crowns || 0;
      else if (type === "rank") value = user.skillRating || 0;
      else value = user.EventsWon || 0;
      return {
        User: {
          Username: user.username,
          Country: user.country || "Unknown",
          [valueField]: value
        }
      };
    });

    return { scores };
  }

  static getBalanceAmount(user, currency) {
    if (!user || !Array.isArray(user.balances)) return 0;
    const want = resolveBalanceName(currency);
    const balance = user.balances.find(
      (b) => resolveBalanceName(b.name || b.Name) === want
    );
    return balance ? Number(balance.amount ?? balance.Amount ?? 0) : 0;
  }

  static getRankData(skillRating) {
    const ranks = [
      { id: 1, thresholds: [0, 250, 500], next: 750 },
      { id: 2, thresholds: [750, 1100, 1450], next: 1800 },
      { id: 3, thresholds: [1800, 2250, 2700], next: 3150 },
      { id: 4, thresholds: [3150, 3650, 4150], next: 4650 },
      { id: 5, thresholds: [4650, 5250, 5850], next: 6450 },
      { id: 6, thresholds: [6450, 7100, 7750], next: 8400 },
      { id: 7, thresholds: [8400, 9200, 10000], next: Infinity }
    ];

    for (let i = 0; i < ranks.length; i++) {
      const rank = ranks[i];
      if (skillRating < rank.next) {
        let tierIndex = 0;
        for (let j = rank.thresholds.length - 1; j >= 0; j--) {
          if (skillRating >= rank.thresholds[j]) {
            tierIndex = j;
            break;
          }
        }
        return { rankId: rank.id, tierIndex };
      }
    }
    return { rankId: 7, tierIndex: 2 };
  }

  static getRankedObject(skillRating) {
    const { rankId, tierIndex } = this.getRankData(skillRating || 0);
    const defaultSeasonId =
      (SharedData?.RankedPlaySettings?.Seasons &&
        SharedData.RankedPlaySettings.Seasons[0] &&
        SharedData.RankedPlaySettings.Seasons[0].Id) ||
      "LIVE_RANKED_SEASON_0";
    return {
      currentSeasonId: defaultSeasonId,
      currentRankId: rankId,
      currentTierIndex: tierIndex
    };
  }

  static getRankAssets(rankId) {
    const rankAssets = {
      1: { name: "1v1 Super Slide", cardImage: "Ranked_Background_Image_Tournaments_Card", hubImage: "Ranked_Background_Image_Tournaments" },
      2: { name: "Ranked Bronze", cardImage: "Ranked_Background_Image_Tournaments_Card_Bronze", hubImage: "Ranked_Background_Image_Tournaments_Bronze" },
      3: { name: "Ranked Silver", cardImage: "Ranked_Background_Image_Tournaments_Card_Silver", hubImage: "Ranked_Background_Image_Tournaments_Silver" },
      4: { name: "Ranked Gold", cardImage: "Ranked_Background_Image_Tournaments_Card_Gold", hubImage: "Ranked_Background_Image_Tournaments_Gold" },
      5: { name: "Ranked Platinum", cardImage: "Ranked_Background_Image_Tournaments_Card_Platinum", hubImage: "Ranked_Background_Image_Tournaments_Platinum" },
      6: { name: "Ranked Master", cardImage: "Ranked_Background_Image_Tournaments_Card_Master", hubImage: "Ranked_Background_Image_Tournaments_Master" },
      7: { name: "Ranked Champion", cardImage: "Ranked_Background_Image_Tournaments_Card_Champion", hubImage: "Ranked_Background_Image_Tournaments_Champion" }
    };
    return rankAssets[rankId] || rankAssets[1];
  }

  static async getLevel(xp) {
    return Math.floor((xp + 1032700) / 30000) - 9;
  }
}

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    req.user = null;

    if (!authHeader || typeof authHeader !== "string") return next();

    // 1) Bearer JWT
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    const token = bearer || null;

    const looksLikeJwt = (str) => typeof str === "string" && str.split(".").length === 3;

    if (token && looksLikeJwt(token)) {
      try {
        const decoded = jwt.verify(token, process.env.LeagueSalt);
        const user = decoded?.stumbleId
          ? await UserModel.findByStumbleId(decoded.stumbleId)
          : (decoded?.deviceId ? await UserModel.findByDeviceId(decoded.deviceId) : null);

        req.user = user || null;
        return next();
      } catch {
        // token non valido → continua con tentativo JSON
      }
    }

    // 2) JSON auth header (vecchio formato)
    let authData;
    try {
      authData = JSON.parse(authHeader);
    } catch {
      return next();
    }

    const { DeviceId, StumbleId, Token } = authData || {};
    if (!DeviceId && !StumbleId && !Token) return next();

    let user = null;
    if (StumbleId) user = await UserModel.findByStumbleId(StumbleId);
    if (!user && DeviceId) user = await UserModel.findByDeviceId(DeviceId);
    if (!user && Token && UserModel.findByToken) user = await UserModel.findByToken(Token);

    req.user = user || null;
    return next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}


async function generatePhotonJwt(user) {
  const payload = {
    stumbleId: user.stumbleId,
    deviceId: user.deviceId,
    username: user.username
  };

  const secret = process.env.LeagueSalt;
  const options = { expiresIn: '30d', issuer: 'StumbleLeaguePhoton' };

  return new Promise((resolve, reject) => {
    jwt.sign(payload, secret, options, (err, token) => {
      if (err) reject(err);
      else resolve(token);
    });
  });
}

/** Ring buffer ultimi webhook Photon (autodebug: verifica se Photon Cloud chiama davvero). */
const photonAuthRecent = [];
const PHOTON_AUTH_RECENT_MAX = 40;

function pushPhotonAuthLog(entry) {
  photonAuthRecent.push(entry);
  if (photonAuthRecent.length > PHOTON_AUTH_RECENT_MAX) photonAuthRecent.shift();
}

function getPhotonAuthRecent(req, res) {
  return res.status(200).json({
    count: photonAuthRecent.length,
    recent: photonAuthRecent.slice().reverse()
  });
}

function pickPhotonParam(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * Photon Custom Authentication webhook.
 * Photon Cloud chiama questo endpoint (GET/POST) con token/userId in query/body/header.
 * Express passa (req,res,next) — NON c'è `user` middleware.
 * Docs: ResultCode 1 = ok, 2 = credenziali, 3 = parametri mancanti.
 */
async function VerifyPhoton(req, res) {
  const started = Date.now();
  const q = req.query || {};
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const authHeader = String(req.headers.authorization || "").trim();
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : authHeader;

  const token = [
    q.token, q.Token, q.jwt, q.Jwt, q.ticket, q.Ticket,
    b.token, b.Token, b.jwt, b.Jwt, b.ticket, b.Ticket,
    bearer
  ].find((t) => typeof t === "string" && t.length > 8);

  const userIdHint = [
    q.userid, q.userId, q.UserId, q.username, q.Username,
    b.userid, b.userId, b.UserId, b.username, b.Username
  ].find((t) => typeof t === "string" && t.length > 0);

  const sessionHint = pickPhotonParam(q, ["sessionId", "sessionid", "SessionId"]) ||
    pickPhotonParam(b, ["sessionId", "sessionid", "SessionId"]);

  const logBase = {
    at: new Date().toISOString(),
    method: req.method,
    ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "",
    ua: String(req.headers["user-agent"] || "").slice(0, 120),
    hasToken: !!token,
    tokenLen: token ? token.length : 0,
    tokenPrefix: token ? token.slice(0, 24) : null,
    userIdHint: userIdHint || null,
    sessionHint: sessionHint || null,
    queryKeys: Object.keys(q),
  };

  try {
    // Anti-spoof: never accept a bare client userId/username as Photon identity.
    if (!token) {
      pushPhotonAuthLog(Object.assign({}, logBase, { resultCode: 3, note: "missing-token", ms: Date.now() - started }));
      console.warn("[PHOTON-AUTH] missing token/params keys=" + logBase.queryKeys.join(","));
      return res.status(200).json({ ResultCode: 3, Message: "Missing token" });
    }

    const secret = process.env.LeagueSalt;
    if (!secret) {
      pushPhotonAuthLog(Object.assign({}, logBase, { resultCode: 2, note: "no-salt", ms: Date.now() - started }));
      console.error("[PHOTON-AUTH] LeagueSalt missing");
      return res.status(200).json({ ResultCode: 2, Message: "Server misconfigured" });
    }

    const { photonAuthFromUser } = require("./AntiCheat/Username");

    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch (err) {
      // Fallback: session token (TourX PhotonTicket uses user.token, not full JWT)
      try {
        const userByToken = await UserModel.findByToken(token);
        const out = photonAuthFromUser(userByToken);
        if (out) {
          pushPhotonAuthLog(Object.assign({}, logBase, {
            resultCode: 1,
            userId: out.UserId,
            note: "session-token-mongo-nick",
            ms: Date.now() - started
          }));
          console.log("[PHOTON-AUTH] ok (session token) userId=" + out.UserId + " nick=" + out.Nickname);
          return res.status(200).json(out);
        }
      } catch {}

      pushPhotonAuthLog(Object.assign({}, logBase, {
        resultCode: 2,
        note: "invalid-jwt",
        err: err && err.message ? err.message : String(err),
        ms: Date.now() - started
      }));
      console.warn("[PHOTON-AUTH] invalid jwt:", err && err.message);
      return res.status(200).json({ ResultCode: 2, Message: "Invalid token" });
    }

    // Always reload live Mongo username — never trust JWT username (stale / spoofable snapshot)
    let user = null;
    const stumbleId = decoded.stumbleId || decoded.StumbleId || decoded.s || null;
    const deviceId = decoded.deviceId || decoded.DeviceId || null;
    if (stumbleId) user = await UserModel.findByStumbleId(stumbleId);
    if (!user && deviceId) user = await UserModel.findByDeviceId(deviceId);

    const out = photonAuthFromUser(user);
    if (!out) {
      pushPhotonAuthLog(Object.assign({}, logBase, {
        resultCode: 2,
        note: "jwt-user-not-found",
        ms: Date.now() - started
      }));
      console.warn("[PHOTON-AUTH] jwt ok but user missing stumbleId=" + stumbleId);
      return res.status(200).json({ ResultCode: 2, Message: "User not found" });
    }

    pushPhotonAuthLog(Object.assign({}, logBase, {
      resultCode: 1,
      userId: out.UserId,
      sessionHint: sessionHint || deviceId || null,
      note: "jwt-mongo-nick",
      ms: Date.now() - started
    }));
    console.log("[PHOTON-AUTH] ok userId=" + out.UserId + " nick=" + out.Nickname);
    return res.status(200).json(out);
  } catch (err) {
    pushPhotonAuthLog(Object.assign({}, logBase, {
      resultCode: 2,
      note: "exception",
      err: err && err.message ? err.message : String(err),
      ms: Date.now() - started
    }));
    console.error("[PHOTON-AUTH] error:", err && err.message ? err.message : err);
    return res.status(200).json({ ResultCode: 2, Message: "Internal server error" });
  }
}

class UserController {
  static async login(req, res) {
    try {
      const DeviceId =
        req.body?.DeviceId ||
        req.body?.deviceId ||
        req.body?.deviceid ||
        req.headers?.deviceid ||
        req.headers?.["device-id"] ||
        "";
      const { StumbleId, SteamTicket, ScopelyId, Version, LinkStumbleId, PreviousStumbleId } = req.body || {};

      if (!DeviceId) {
        return res.status(400).json({ message: 'DeviceId is required' });
      }

      // Logica anti-duplicati: nuovo utente SOLO se nessun account esistente è collegabile.
      // Ordine: StumbleId → DeviceId/alternateDeviceIds → LinkStumbleId → ScopelyId → solo allora create.
      let user = null;
      if (StumbleId) {
        user = await UserModel.findByStumbleId(StumbleId);
        if (user && DeviceId && user.deviceId !== DeviceId) {
          const altIds = user.alternateDeviceIds || [];
          if (!altIds.includes(DeviceId)) {
            await UserModel.addAlternateDeviceId(user.stumbleId, DeviceId);
          }
        }
      }

      if (!user) {
        user = await UserModel.findByDeviceId(DeviceId);
      }

      if (!user && (LinkStumbleId || PreviousStumbleId)) {
        const linkId = (LinkStumbleId || PreviousStumbleId).toString().trim();
        if (linkId) {
          user = await UserModel.findByStumbleId(linkId);
          if (user) {
            await UserModel.addAlternateDeviceId(user.stumbleId, DeviceId);
            Console.log("Login", "Account esistente collegato al nuovo deviceId (StumbleId link). " + DeviceId);
          }
        }
      }

      if (!user && ScopelyId) {
        user = await UserModel.findByScopelyId(ScopelyId);
        if (user) {
          await UserModel.addAlternateDeviceId(user.stumbleId, DeviceId);
          Console.log("Login", "Account esistente collegato al nuovo deviceId (ScopelyId). " + DeviceId);
        }
      }

      if (!user) {
        Console.log("Login", "Primo accesso: creazione nuovo utente (nessun account esistente trovato). " + DeviceId);
        let geoInfo = null;
        try {
          geoInfo = CountryFinder.lookup(req);
        } catch (e) {
          Console.error("GeoIP", "Errore durante il lookup della regione:", e);
        }

        const platformInfo = {
          steamTicket: SteamTicket,
          scopelyId: ScopelyId,
          Version
        };

        // Usa i dati reali da CountryFinder per il country
        // Region verrà calcolato automaticamente come lowercase del country in UserModel.create
        if (geoInfo && typeof geoInfo === "object" && geoInfo.country) {
          platformInfo.country = geoInfo.country;
        }

        user = await UserModel.create(DeviceId, platformInfo);
      }

      user = await applyCosmeticUnlocks(user);

      const photonJwt = await generatePhotonJwt(user);

      if (user.isBanned) {
        Console.warn("Login", "Rejected because the resolved or newly created user has isBanned=true");
        return res.status(403).send("BANNED");
      }

      return res.status(200).json(formatLoginResponse(user, photonJwt));
    } catch (err) {
      Console.error('Login', 'Error:', err && err.stack ? err.stack : err);
      return res.status(500).json({ message: 'Internal server error during login' });
    }
  }

  static async getConfig(req, res) {
    try {
      const config = {
        _SharedVersion: 2,
        Versions: {
          AndroidLastVersionAvailable: 0.59
        },
        BattlePassRotation: SharedData.BattlePassRotation || [],
        BattlePassesV3: SharedData.BattlePasses || [],
        RoundLevels_v2: SharedData.RoundLevels_v2 || [],
        Skins_v4: SharedData.Skins_v4 || [],
        MissionObjectives: SharedData.MissionObjectives || [],
        PurchasableItems: SharedData.PurchasableItems || [],
        GameEvents: SharedData.GameEvents || [],
        Animations: SharedData.Animations || [],
        Animations_v2: SharedData.Animations_v2 || [],
        AdSettings: SharedData.AdSettings || {},
        AnalyticsSettings: SharedData.AnalyticsSettings || {},
        BackendUrl: SharedData.BackendUrl || "",
        BattlePass: SharedData.BattlePass || {},
        ActionEmotes: SharedData.ActionEmotes || {},
        RankedPlaySettings: SharedData.RankedPlaySettings || {}
      };

      res.json(config);
    } catch (err) {
      Console.error('Config', 'Error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

static async updateUsername(req, res) {
  try {
    const { Username } = req.body;
    const { user } = req;

    if (!user) return res.status(401).json({ message: "unauthorized" });

    const rawInput = (Username || "").toString();
    if (!rawInput || rawInput.trim().length === 0) {
      return res.status(409).json({ message: "nome non disponibile" });
    }

    let newNameRaw = rawInput.trim().replace(/\s{2,}/g, " ");

    if (newNameRaw.length < 3 || newNameRaw.length > 12) {
      return res.status(401).json({ message: "so pode ter de 3 a 12 carater" });
    }

    if (/[<>{}\[\]()"'\`~#$%^&*=+\\\/|:;,?!]/.test(newNameRaw)) {
      return res.status(403).json({ message: "caracteres invalidos" });
    }

    if (/\p{Extended_Pictographic}/u.test(newNameRaw)) {
      return res.status(403).json({ message: "emojis non consentiti nel nome" });
    }

    const usernameLower = getBaseUsername(newNameRaw).toLowerCase() || newNameRaw.toLowerCase();

    if (await UserModel.isBaseUsernameTaken(usernameLower, user.id)) {
      return res.status(409).json({ message: "ja existe um usuario com este nome ai pae" });
    }

    const oldName = (user.username || "").toString();
    const finalUsername = rebuildStyledUsername(oldName, newNameRaw);

    const updates = {
      username: finalUsername,
      "userProfile.userName": finalUsername,
      usernameLower
    };

    const updatedUser = await UserModel.update(user.stumbleId, updates);

    await UserModel.removeBalance(user.deviceId, "gems", 100);

    console.log(`${oldName} ha cambiato nome in ${finalUsername}`);
    return res.status(200).json({ User: updatedUser });
  } catch (err) {
    console.error("Username Update error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

  static async getSettings(req, res) {
    try {
        const settings = {
            friendIsOnlinePush: true,
            invitedToPartyPush: true,
            partyInviteToastNotification: true,
            partyInviteInGameToastNotification: true
        };
        
        res.json(settings);
    } catch (err) {
        Console.error('Settings', 'Error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
}

  static async getProfile(req, res) {
    try {
      const { userID } = req.body;
      let user = null;

      if (userID) {
        user = await UserModel.findById(userID);
      }

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      res.json({ 
        User: user.userProfile
      });
    } catch (err) {
      Console.error('Profile', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async addSkin(req, res) {
    try {
      const { user } = req;
      const { skinId } = req.body;

      if (!skinId) {
        return res.status(400).json({ message: 'skinId is required' });
      }

      await UserModel.addSkin(user.stumbleId, skinId);
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Add skin error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async setEquippedCosmetic(req, res) {
    try {
      const { user } = req;
      const { cosmeticType, cosmeticId } = req.body;

      if (!cosmeticType || !cosmeticId) {
        return res.status(400).json({ message: 'Both cosmeticType and cosmeticId are required' });
      }

      const updatedUser = await UserModel.setEquippedCosmetic(user.stumbleId, cosmeticType, cosmeticId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Set equipped error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async updateCosmetics(req, res) {
    try {
      const { user } = req;
      const { 
        skin, color, animation, footsteps, 
        emote1, emote2, emote3, emote4,
        actionEmote1, actionEmote2, actionEmote3, actionEmote4 
      } = req.body;

      const updates = {
        equippedCosmetics: {
          skin: skin || user.equippedCosmetics.skin,
          color: color || user.equippedCosmetics.color,
          animation: animation || user.equippedCosmetics.animation,
          footsteps: footsteps || user.equippedCosmetics.footsteps,
          emote1: emote1 || user.equippedCosmetics.emote1,
          emote2: emote2 || user.equippedCosmetics.emote2,
          emote3: emote3 || user.equippedCosmetics.emote3,
          emote4: emote4 || user.equippedCosmetics.emote4,
          actionEmote1: actionEmote1 || user.equippedCosmetics.actionEmote1,
          actionEmote2: actionEmote2 || user.equippedCosmetics.actionEmote2,
          actionEmote3: actionEmote3 || user.equippedCosmetics.actionEmote3,
          actionEmote4: actionEmote4 || user.equippedCosmetics.actionEmote4
        }
      };

      const updatedUser = await UserModel.update(user.stumbleId, updates);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Update error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async deleteAccount(req, res) {
    try {
      const { user } = req;
      const newUsername = `#${BackendUtils.GenCaracters(11)}`;
      
      await UserModel.update(user.deviceId, { username: newUsername });
      await database.collections.Users.deleteOne({ deviceId: user.deviceId });
      
      res.json({ message: 'Account deleted successfully' });
    } catch (err) {
      Console.error('Account', 'Delete error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async linkPlatform(req, res) {
    try {
      const { platform, platformId } = req.body;
      const { user } = req;
      
      const validPlatforms = ['google', 'apple', 'facebook', 'scopely'];
      if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ message: 'Invalid platform' });
      }

      const platformIdMD5 = BackendUtils.Hash('md5', platformId || `${platform}-${user.username}-${process.env.LeagueSalt}`);
      const updateField = `${platform}Id`;

      const updatedUser = await UserModel.update(user.deviceId, { [updateField]: platformIdMD5 });
      res.json({ User: updatedUser, message: `Successfully linked ${platform} account` });
    } catch (err) {
      Console.error('Platform', 'Link error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async unlinkPlatform(req, res) {
    try {
      const { platform } = req.body;
      const { user } = req;
      
      const validPlatforms = ['google', 'apple', 'facebook', 'scopely'];
      if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ message: 'Invalid platform' });
      }

      const updateField = `${platform}Id`;
      const updatedUser = await UserModel.update(user.deviceId, { [updateField]: '' });
      
      res.json({ User: updatedUser, message: `Successfully unlinked ${platform} account` });
    } catch (err) {
      Console.error('Platform', 'Unlink error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class RoundController {
  static async finishRound(req, res) {
    try {
      const { user } = req;
      const { round } = req.params;
      const { StartingUsers, maxPlayers } = req.body;

      if (!round) {
        return res.status(400).json({ message: 'Round is required' });
      }

      // Non dare corone quando si vince (round 3) nelle partite normali
      // Non dare corone quando si perde (round 1 o 2)
      const crownsReward = 0;

      const rewards = {
        crowns: crownsReward,
        skillRating: round === '3' ? 20 : round === '2' ? 10 : 0,
        experience: 100
      };

      const updatedUser = await UserModel.update(user.deviceId, {
        crowns: user.crowns + rewards.crowns,
        skillRating: user.skillRating + rewards.skillRating,
        experience: user.experience + rewards.experience
      });

      res.status(200).json({
        User: updatedUser,
        Rewards: rewards
      });
    } catch (err) {
      Console.error('Round', 'Finish error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async finishCustomRound(req, res) {
    try {
      const { user } = req;
      const { round } = req.params;
      const roundNum = Number(round) || 1;

      const rewards = {
        crowns: 0,
        skillRating: 0,
        experience: roundNum >= 3 ? 100 : roundNum === 2 ? 50 : 25
      };

      let updatedUser = user;
      try {
        if (user && user.deviceId) {
          updatedUser = await UserModel.update(user.deviceId, {
            crowns: (user.crowns || 0) + rewards.crowns,
            skillRating: (user.skillRating || 0) + rewards.skillRating,
            experience: (user.experience || 0) + rewards.experience
          });
        }
      } catch (_) {}

      res.status(200).json({
        User: updatedUser || user || {},
        Rewards: rewards,
        Round: roundNum,
        ok: true,
        message: 'Custom round finished successfully'
      });
    } catch (err) {
      Console.error('Round', 'Custom finish error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async finishRoundV4(req, res) {
    try {
      const { user } = req;
      const { round } = req.params;
      const { gameType, variantId, StartingUsers, maxPlayers } = req.body;

      const gameId = BackendUtils.createGameId(gameType === 'event' ? 'event' : 'regular');
      const levelIds = SharedData.RoundLevels_v2.map(level => level.LevelID).slice(0, 3);

      const roundPayloads = {};
      const placements = {};
      const eliminatedPlayers = [];
      const usersLastRound = {};

      // Determina il numero di giocatori dalla richiesta o usa default
      const numPlayers = StartingUsers || maxPlayers || 32;

      if (round === '1') {
        placements[user.id] = 16;
        usersLastRound[user.id] = 1;
        roundPayloads[1] = {
          EliminatedPlayers: [user.id, ...Array(15).fill(0).map((_, i) => 1000 + i)],
          LevelId: levelIds[0],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
      } else if (round === '2') {
        placements[user.id] = 8;
        usersLastRound[user.id] = 2;
        roundPayloads[1] = {
          EliminatedPlayers: [],
          LevelId: levelIds[0],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
        roundPayloads[2] = {
          EliminatedPlayers: [user.id, ...Array(7).fill(0).map((_, i) => 1000 + i)],
          LevelId: levelIds[1],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
      } else if (round === '3') {
        placements[user.id] = 1;
        usersLastRound[user.id] = 3;
        roundPayloads[1] = {
          EliminatedPlayers: [],
          LevelId: levelIds[0],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
        roundPayloads[2] = {
          EliminatedPlayers: [],
          LevelId: levelIds[1],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
        roundPayloads[3] = {
          EliminatedPlayers: [],
          LevelId: levelIds[2],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
      }

      const clientViewPayload = {
        AverageMmr: null,
        CurrentRound: parseInt(round),
        ExpectedRounds: 3,
        FrameNumber: 7814,
        GameId: gameId,
        GameType: gameType === 'event' ? "Event" : "Regular",
        Placements: null,
        RoundPayloads: roundPayloads,
        StartingUsers: numPlayers,
        UsersLastRound: usersLastRound,
        VariantId: variantId || null
      };

      // Non dare corone quando si vince (round 3) nelle partite normali
      // Non dare corone quando si perde (round 1 o 2)
      const crownsReward = 0;

      const rewards = {
        crowns: crownsReward,
        skillRating: round === '3' ? 20 : round === '2' ? 10 : 0,
        experience: 100
      };

      const updatedUser = await UserModel.update(user.deviceId, {
        crowns: user.crowns + rewards.crowns,
        skillRating: user.skillRating + rewards.skillRating,
        experience: user.experience + rewards.experience
      });

      res.status(200).json({
        ClientViewPayload: clientViewPayload,
        ClientViewPlacements: null,
        FriendsCount: 0,
        LevelIds: levelIds,
        MissionsProgression: {},
        SignedPayload: "",
        User: updatedUser,
        Rewards: rewards
      });
    } catch (err) {
      Console.error('Round', 'FinishV4 error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class BattlePassController {
  static async getBattlePass(req, res) {
    try {
      // Battle Pass disabilitato: non mandiamo più dati di pass/stagione
      // Restituiamo sempre un array vuoto con 200 OK
      return res.status(200).json([]);
    } catch (err) {
      Console.error('BattlePass', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimReward(req, res) {
    try {
      const { user } = req;
      // Battle Pass disabilitato: non modificare nulla, ritorna solo lo user
      return res.status(200).json({ User: user });
    } catch (err) {
      Console.error('BattlePass', 'Claim error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async purchaseBattlePass(req, res) {
    try {
      const { user } = req;
      // Battle Pass disabilitato: nessun acquisto, nessun movimento gemme
      return res.status(200).json({ User: user });
    } catch (err) {
      Console.error('BattlePass', 'Purchase error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async completeBattlePass(req, res) {
    try {
      const { user } = req;
      // Battle Pass disabilitato: non completare nulla, ritorna lo user com'è
      return res.status(200).json({ User: user });
    } catch (err) {
      Console.error('BattlePass', 'Complete error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class EconomyController {
  static async purchase(req, res) {
    try {
      const { user } = req;
      const itemId = req.params.item;

      const item = SharedData.PurchasableItems.find(i => i.Name === itemId);
      if (!item) return res.status(404).json({ error: 'ITEM_NOT_FOUND' });

      const price = item.Prices[0];
      if (!price) return res.status(400).json({ error: 'INVALID_PRICE' });

      const balance = UserModel.getBalanceAmount(user, price.Currency);
      if (balance < price.Amount) return res.status(402).json({ error: 'INSUFFICIENT_FUNDS' });

      await UserModel.removeBalance(user.stumbleId, price.Currency, price.Amount);

      const rewards = [];
      if (item.Rewards) {
        for (const reward of item.Rewards) {
          if (reward.Type === 'Currency') {
            await UserModel.addBalance(user.stumbleId, reward.CurrencyType, reward.Amount);
            rewards.push({
              type: 'CURRENCY',
              currencyType: reward.CurrencyType,
              amount: reward.Amount
            });
          } else if (reward.Type === 'Cosmetic') {
            await UserModel.addSkin(user.stumbleId, reward.CosmeticId);
            rewards.push({
              type: 'COSMETIC',
              cosmeticType: reward.CosmeticType,
              cosmeticId: reward.CosmeticId
            });
          }
        }
      }

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({ 
        success: true,
        user: updatedUser,
        rewards: rewards
      });
    } catch (err) {
      Console.error('Economy', 'Purchase error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async purchaseGasha(req, res) {
    try {
      const { user } = req;
      const { itemId } = req.params;

      const gashaItem = SharedData.PurchasableItems.find(i => i.Name === itemId && i.Type === 'Gasha');
      if (!gashaItem) return res.status(404).json({ error: 'GASHA_NOT_FOUND' });

      const price = gashaItem.Prices[0];
      if (!price || price.Currency !== 'Gems') return res.status(400).json({ error: 'INVALID_PRICE' });

      const userGems = UserModel.getBalanceAmount(user, 'Gems');
      if (userGems < price.Amount) return res.status(402).json({ error: 'INSUFFICIENT_GEMS' });

      await UserModel.removeBalance(user.stumbleId, 'Gems', price.Amount);

      const rewards = [];
      const possibleDrops = gashaItem.GashaDrops || [];
      const totalWeight = possibleDrops.reduce((sum, drop) => sum + drop.Weight, 0);

      for (let i = 0; i < (gashaItem.RollCount || 1); i++) {
        const roll = Math.random() * totalWeight;
        let weightSum = 0;
        
        for (const drop of possibleDrops) {
          weightSum += drop.Weight;
          if (roll <= weightSum) {
            if (drop.Type === 'Currency') {
              await UserModel.addBalance(user.stumbleId, drop.CurrencyType, drop.Amount);
              rewards.push({
                type: 'CURRENCY',
                currencyType: drop.CurrencyType,
                amount: drop.Amount,
                rarity: drop.Rarity
              });
            } else if (drop.Type === 'Cosmetic') {
              await UserModel.addSkin(user.stumbleId, drop.CosmeticId);
              rewards.push({
                type: 'COSMETIC',
                cosmeticType: drop.CosmeticType,
                cosmeticId: drop.CosmeticId,
                rarity: drop.Rarity
              });
            }
            break;
          }
        }
      }

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({
        success: true,
        user: updatedUser,
        rewards: rewards,
        gashaId: gashaItem.Name
      });
    } catch (err) {
      Console.error('Economy', 'Gasha error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async purchaseLuckySpin(req, res) {
    // Delega a LobbyFixes — MAI SPIN_NOT_CONFIGURED (PUR004)
    try {
      const { LobbyController } = require("./LobbyFixes");
      return LobbyController.purchaseLuckySpin(req, res);
    } catch (err) {
      Console.error('Economy', 'Spin error:', err);
      try {
        const { LobbyController } = require("./LobbyFixes");
        return LobbyController.purchaseDrop(req, res);
      } catch (e2) {
        res.status(200).json({
          Rewards: [{ Type: "CURRENCY", TypeInfo: "gems", Amount: 5 }]
        });
      }
    }
  }

  static async giveCurrency(req, res) {
    try {
      const { currencyType, amount } = req.params;
      const { user } = req;

      const validCurrencies = ['Gems', 'Gold', 'Dust', 'FreeSpins', 'AdSpins'];
      if (!validCurrencies.includes(currencyType)) {
        return res.status(400).json({ error: 'INVALID_CURRENCY' });
      }

      const parsedAmount = parseInt(amount);
      if (isNaN(parsedAmount)) {
        return res.status(400).json({ error: 'INVALID_AMOUNT' });
      }

      await UserModel.addBalance(user.stumbleId, currencyType, parsedAmount);
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      res.json({
        success: true,
        user: updatedUser,
        currencyAdded: {
          type: currencyType,
          amount: parsedAmount
        }
      });
    } catch (err) {
      Console.error('Economy', 'GiveCurrency error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }
}
class AnalyticsController {
  static async analytic(req, res) {
    try {
      const { user } = req;
      const { type, message } = req.body;

      if (!type || !message) {
        return res.status(400).json({ message: 'Type and message are required' });
      }

      await database.collections.Analytics.insertOne({
        DeviceId: user.deviceId,
        type,
        message,
        timestamp: new Date()
      });

      res.status(200).json("OK");
    } catch (err) {
      Console.error("Analytics", "Error:", err);
      res.status(500).json("Error");
    }
  }
}

class FriendsController {
  static ensureFriendArrays(user) {
    if (!user) return false;
    if (!Array.isArray(user.friends)) user.friends = [];
    if (!Array.isArray(user.sentFriendRequests)) user.sentFriendRequests = [];
    if (!Array.isArray(user.receivedFriendRequests)) user.receivedFriendRequests = [];
    return true;
  }

  static isSameUser(a, b) {
    if (!a || !b) return false;
    if (a.stumbleId && b.stumbleId && String(a.stumbleId) === String(b.stumbleId)) return true;
    if (a.id != null && b.id != null && Number(a.id) === Number(b.id)) return true;
    return false;
  }

  static isSelfUserId(user, userId) {
    if (!user || userId == null || userId === "") return false;
    if (user.id != null && Number(user.id) === Number(userId)) return true;
    if (user.stumbleId && String(user.stumbleId) === String(userId)) return true;
    return false;
  }

  static async add(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!FriendsController.ensureFriendArrays(user)) {
        return res.status(401).json({ message: 'unauthorized' });
      }
      if (!UserId) return res.status(400).json({ message: 'UserId is required' });
      if (FriendsController.isSelfUserId(user, UserId)) {
        return res.status(400).json({ message: 'Cannot friend yourself' });
      }

      const friend = await UserModel.findById(UserId);
      if (!friend) return res.status(404).json({ message: 'User not found' });
      if (FriendsController.isSameUser(user, friend)) {
        return res.status(400).json({ message: 'Cannot friend yourself' });
      }

      if (user.friends.includes(friend.stumbleId)) {
        return res.status(409).json({ message: 'Already friends' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $addToSet: { friends: friend.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: friend.stumbleId },
        { $addToSet: { friends: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json(updatedUser.userProfile);
    } catch (err) {
      Console.error('Friends', 'Add error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async request(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!FriendsController.ensureFriendArrays(user)) {
        return res.status(401).json({ message: 'unauthorized' });
      }
      if (!UserId) return res.status(400).json({ message: 'UserId is required' });
      if (FriendsController.isSelfUserId(user, UserId)) {
        return res.status(400).json({ message: 'Cannot friend yourself' });
      }

      const toUser = await UserModel.findById(UserId);
      if (!toUser) return res.status(404).json({ message: 'User not found' });
      if (FriendsController.isSameUser(user, toUser)) {
        return res.status(400).json({ message: 'Cannot friend yourself' });
      }

      if (user.sentFriendRequests.includes(toUser.stumbleId)) {
        return res.status(409).json({ message: 'Request already sent' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $addToSet: { sentFriendRequests: toUser.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: toUser.stumbleId },
        { $addToSet: { receivedFriendRequests: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json(updatedUser.userProfile);
    } catch (err) {
      Console.error('Friends', 'Request error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async accept(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!FriendsController.ensureFriendArrays(user)) {
        return res.status(401).json({ message: 'unauthorized' });
      }
      if (!UserId) return res.status(400).json({ message: 'UserId is required' });

      const fromUser = await UserModel.findById(UserId);
      if (!fromUser) return res.status(404).json({ message: 'User not found' });

      if (!user.receivedFriendRequests.includes(fromUser.stumbleId)) {
        return res.status(404).json({ message: 'No friend request found' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        {
          $pull: { receivedFriendRequests: fromUser.stumbleId },
          $addToSet: { friends: fromUser.stumbleId }
        }
      );

      await database.collections.Users.updateOne(
        { stumbleId: fromUser.stumbleId },
        {
          $pull: { sentFriendRequests: user.stumbleId },
          $addToSet: { friends: user.stumbleId }
        }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json(updatedUser.userProfile);
    } catch (err) {
      Console.error('Friends', 'Accept error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async reject(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!FriendsController.ensureFriendArrays(user)) {
        return res.status(401).json({ message: 'unauthorized' });
      }
      if (!UserId) return res.status(400).json({ message: 'UserId is required' });

      const fromUser = await UserModel.findById(UserId);
      if (!fromUser) return res.status(404).json({ message: 'User not found' });

      if (!user.receivedFriendRequests.includes(fromUser.stumbleId)) {
        return res.status(404).json({ message: 'No friend request found' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $pull: { receivedFriendRequests: fromUser.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: fromUser.stumbleId },
        { $pull: { sentFriendRequests: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json(updatedUser.userProfile);
    } catch (err) {
      Console.error('Friends', 'Reject error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async cancel(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!FriendsController.ensureFriendArrays(user)) {
        return res.status(401).json({ message: 'unauthorized' });
      }
      if (!UserId) return res.status(400).json({ message: 'UserId is required' });

      const toUser = await UserModel.findById(UserId);
      if (!toUser) return res.status(404).json({ message: 'User not found' });

      if (!user.sentFriendRequests.includes(toUser.stumbleId)) {
        return res.status(404).json({ message: 'No friend request found' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $pull: { sentFriendRequests: toUser.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: toUser.stumbleId },
        { $pull: { receivedFriendRequests: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json(updatedUser.userProfile);
    } catch (err) {
      Console.error('Friends', 'Cancel error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async list(req, res) {
    try {
      const { user } = req;
      if (!FriendsController.ensureFriendArrays(user)) {
        return res.status(401).json({ message: 'unauthorized' });
      }

      const friends = await database.collections.Users.find({
        stumbleId: { $in: user.friends }
      }).project({
        userProfile: 1
      }).toArray();

      return res.status(200).json({ friends: friends.map(f => f.userProfile) });
    } catch (err) {
      Console.error('Friends', 'List error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async pending(req, res) {
    try {
      const { user } = req;
      if (!FriendsController.ensureFriendArrays(user)) {
        return res.status(401).json({ message: 'unauthorized' });
      }

      const pendingUsers = await database.collections.Users.find({
        stumbleId: { $in: user.receivedFriendRequests }
      }).project({
        userProfile: 1
      }).toArray();

      return res.status(200).json(pendingUsers.map(u => u.userProfile));
    } catch (err) {
      Console.error('Friends', 'Pending error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async remove(req, res) {
    try {
      const { UserId } = req.params;
      const { user } = req;

      if (!FriendsController.ensureFriendArrays(user)) {
        return res.status(401).json({ message: 'unauthorized' });
      }
      if (!UserId) return res.status(400).json({ message: 'UserId is required' });

      const friend = await UserModel.findById(UserId);
      if (!friend) return res.status(404).json({ message: 'User not found' });

      if (!user.friends.includes(friend.stumbleId)) {
        return res.status(404).json({ message: 'Not friends' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $pull: { friends: friend.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: friend.stumbleId },
        { $pull: { friends: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json(updatedUser.userProfile);
    } catch (err) {
      Console.error('Friends', 'Remove error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static normalizeSearchName(input) {
    const raw = String(input || "").trim().replace(/\s{2,}/g, " ");
    const noSpaceAroundHash = raw.replace(/\s*#\s*/g, "#");
    const base = (getBaseUsername(raw) || raw).toLowerCase();
    return {
      raw,
      noSpaceAroundHash,
      base,
      baseCompact: base.replace(/\s+/g, "")
    };
  }

  static nameMatchesSearch(user, needle) {
    if (!user || !needle) return false;
    const username = String(user.username || "");
    const visible = stripRichTags(username).trim();
    const visibleNoSpaceHash = visible.replace(/\s*#\s*/g, "#").trim();
    const base = getBaseUsername(username).toLowerCase();
    const lower = String(user.usernameLower || "").toLowerCase();

    const targets = new Set(
      [
        lower,
        base,
        base.replace(/\s+/g, ""),
        visible.toLowerCase(),
        visible.replace(/\s+/g, "").toLowerCase(),
        visibleNoSpaceHash.toLowerCase(),
        visibleNoSpaceHash.replace(/\s+/g, "").toLowerCase()
      ].filter(Boolean)
    );

    const needles = [
      needle.base,
      needle.baseCompact,
      needle.raw.toLowerCase(),
      needle.raw.replace(/\s+/g, "").toLowerCase(),
      needle.noSpaceAroundHash.toLowerCase(),
      needle.noSpaceAroundHash.replace(/\s+/g, "").toLowerCase()
    ];

    return needles.some((n) => n && targets.has(n));
  }

  static buildSearchProfile(user) {
    const profile = { ...(user.userProfile || {}) };
    // Prefer live username so a renamed player is not shown as old Priz#XXXX
    profile.userName = user.username || profile.userName || "";
    if (user.id != null) profile.userId = user.id;
    if (user.country) profile.country = user.country;
    return profile;
  }

  static async search(req, res) {
    try {
      const rawInput =
        req.body?.UserName ?? req.body?.userName ?? req.body?.Username ?? "";
      const trimmed = String(rawInput).trim();

      if (!trimmed || trimmed.length < 3) {
        return res.status(400).json({ message: 'UserName must be at least 3 characters' });
      }

      const needle = FriendsController.normalizeSearchName(trimmed);
      let user = null;

      // Exact base name (set on rename / create)
      const byLower = await database.getUserByQuery({ usernameLower: needle.base });
      if (byLower && FriendsController.nameMatchesSearch(byLower, needle)) {
        user = byLower;
      }

      if (!user && database.ready && database.collections.Users) {
        const exactVariants = [...new Set([
          needle.raw,
          needle.noSpaceAroundHash,
          needle.base
        ].filter(Boolean))];

        for (const variant of exactVariants) {
          const hit = await database.collections.Users.findOne({
            username: { $regex: `^${escapeRegex(variant)}$`, $options: "i" }
          });
          if (hit && FriendsController.nameMatchesSearch(hit, needle)) {
            user = hit;
            break;
          }
        }
      }

      // Styled/rich usernames: gather contains-candidates, keep only exact base matches
      if (!user && database.ready && database.collections.Users) {
        const candidates = await database.collections.Users.find({
          $or: [
            { usernameLower: needle.base },
            { username: { $regex: escapeRegex(needle.base), $options: "i" } },
            { username: { $regex: escapeRegex(needle.noSpaceAroundHash), $options: "i" } }
          ]
        })
          .project({
            userProfile: 1,
            username: 1,
            usernameLower: 1,
            id: 1,
            country: 1
          })
          .limit(50)
          .toArray();

        user = candidates.find((u) => FriendsController.nameMatchesSearch(u, needle)) || null;
      } else if (!user && database._memoryUsers) {
        for (const u of database._memoryUsers.values()) {
          if (FriendsController.nameMatchesSearch(u, needle)) {
            user = u;
            break;
          }
        }
      }

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      if (FriendsController.isSameUser(req.user, user)) {
        return res.status(400).json({ message: 'Cannot search yourself' });
      }

      return res.status(200).json(FriendsController.buildSearchProfile(user));
    } catch (err) {
      Console.error('Friends', 'Search error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class NewsController {
  static async GetNews(req, res) {
    try {
      const newsList = await database.collections.News
        .find()
        .sort({ timestamp: -1 })
        .toArray();

      const news = newsList.map((item, index) => {
        const timestamp = item.timestamp ?? item.Timestamp ?? item.timeStamp ?? item.TimeStamp ?? null;
        const targetUrl = item.targetUrl ?? item.TargetUrl ?? item.link ?? item.Link ?? "";
        const imagePath = item.imagePath ?? item.ImagePath ?? item.imageUrl ?? item.ImageUrl ?? "";
        const header = item.headerText ?? item.HeaderText ?? item.header ?? item.Header ?? "";
        const message = item.contentText ?? item.ContentText ?? item.message ?? item.Message ?? "";

        return {
          // The game uses NewsType to separate regular news from videos.
          Id: Number.isFinite(Number(item.id ?? item.Id))
            ? Number(item.id ?? item.Id)
            : (timestamp && Number.isFinite(new Date(timestamp).getTime()) ? new Date(timestamp).getTime() : index + 1),
          TargetUrl: targetUrl,
          Language: item.language ?? item.Language ?? "en",
          ImagePath: imagePath,
          HeaderText: header,
          ContentText: message,
          NewsType: String(item.newsType ?? item.NewsType ?? item.type ?? "news").toLowerCase(),
          Timestamp: timestamp,
          // Keep aliases for older NewsData clients.
          Header: header,
          Message: message,
          TimeStamp: timestamp,
          imagePath,
          link: targetUrl
        };
      });

      res.json(news);
    } catch (err) {
      Console.error('News', 'Get error:', err);
      res.status(500).json({ message: 'Error fetching news' });
    }
  }
}

class MissionsController {
  static async getMissions(req, res) {
    try {
      const { user } = req;

      const missions = SharedData.MissionObjectives.map(mission => ({
        missionId: mission.Id,
        missionActive: true,
        rewardsClaimed: false,
        requirementProgressions: mission.Requirements.map(req => ({
          requirementId: req.Id,
          completed: Math.random() > 0.5,
          current: Math.floor(Math.random() * req.Target),
          target: req.Target
        }))
      }));

      res.json({
        missionObjectiveProgressionUpdated: {
          missionObjectiveId: "daily",
          currentPoints: Math.floor(Math.random() * 100),
          milestoneProgressions: SharedData.MissionObjectives
            .find(m => m.Id === "daily")?.Milestones.map(milestone => ({
              milestoneId: milestone.MilestoneId,
              claimed: false
            })) || []
        },
        missionsProgressionsUpdated: missions
      });
    } catch (err) {
      Console.error('Missions', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimMissionReward(req, res) {
    try {
      const { user } = req;
      const { missionId } = req.params;

      const mission = SharedData.MissionObjectives
        .flatMap(m => m.Requirements.map(r => ({ ...r, missionId: m.Id })))
        .find(m => m.missionId === missionId);

      if (!mission) {
        return res.status(404).json({ message: 'Mission not found' });
      }

      const rewards = mission.Rewards || [];
      for (const reward of rewards) {
        if (reward.type === 'CURRENCY') {
          await UserModel.addBalance(user.deviceId, reward.typeInfo, reward.amount);
        }
      }

      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({
        User: updatedUser,
        Rewards: rewards,
        message: 'Rewards claimed successfully'
      });
    } catch (err) {
      Console.error('Missions', 'Claim error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimMilestoneReward(req, res) {
    try {
      const { user } = req;
      const { objectiveId, milestoneId } = req.params;

      const objective = SharedData.MissionObjectives.find(m => m.Id === objectiveId);
      if (!objective) {
        return res.status(404).json({ message: 'Objective not found' });
      }

      const milestone = objective.Milestones.find(m => m.MilestoneId === milestoneId);
      if (!milestone) {
        return res.status(404).json({ message: 'Milestone not found' });
      }

      const rewards = milestone.Rewards || [];
      for (const reward of rewards) {
        if (reward.type === 'CURRENCY') {
          await UserModel.addBalance(user.deviceId, reward.typeInfo, reward.amount);
        }
      }

      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({
        User: updatedUser,
        Rewards: rewards,
        message: 'Milestone rewards claimed successfully'
      });
    } catch (err) {
      Console.error('Missions', 'Claim milestone error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}
class TournamentController {
    static async login(req, res) {
        try {
            const user = await UserModel.findByDeviceId(req.user.deviceId);
            const photonJwt = await generatePhotonJwt(user);
            
            return res.json({
                User: user,
                PhotonJwt: photonJwt,
                equippedCosmetics: user.equippedCosmetics
            });

        } catch (error) {
            Console.error('TournamentLogin', error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async createTournament(req, res) {
        try {
            const { name, description, startTime, endTime, entryFee, maxPlayers, rewards } = req.body;
            
            if (!name || !startTime || !endTime) {
                return res.status(400).json({ message: 'Name, startTime and endTime are required' });
            }

            const tournament = {
                id: uuidv4(),
                name,
                description: description || "",
                startTime: new Date(startTime),
                endTime: new Date(endTime),
                entryFee: entryFee || 0,
                maxPlayers: maxPlayers || 1000,
                currentPlayers: 0,
                rewards: rewards || [],
                createdAt: new Date(),
                updatedAt: new Date(),
                isActive: true
            };

            const result = await database.collections.Tournaments.insertOne(tournament);
            
            if (result.acknowledged) {
                res.status(201).json({
                    message: 'Tournament created successfully',
                    tournament
                });
            } else {
                throw new Error('Failed to create tournament');
            }
        } catch (err) {
            Console.error('Tournament', 'Create error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async getActive(req, res) {
        try {
            const now = new Date();
            const activeTournaments = await database.collections.Tournaments.find({
                startTime: { $lte: now },
                endTime: { $gte: now },
                isActive: true
            }).sort({ startTime: 1 }).toArray();

            res.json(activeTournaments);
        } catch (err) {
            Console.error('Tournament', 'Get active error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async getTournamentById(req, res) {
        try {
            const { id } = req.params;
            
            if (!id) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const tournament = await database.collections.Tournaments.findOne({ id });
            
            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            res.json(tournament);
        } catch (err) {
            Console.error('Tournament', 'Get by ID error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async joinTournament(req, res) {
        try {
            const { user } = req;
            const { tournamentId } = req.params;

            if (!tournamentId) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const tournament = await database.collections.Tournaments.findOne({ 
                id: tournamentId,
                isActive: true
            });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found or inactive' });
            }

            const now = new Date();
            if (now < tournament.startTime) {
                return res.status(400).json({ message: 'Tournament has not started yet' });
            }

            if (tournament.currentPlayers >= tournament.maxPlayers) {
                return res.status(400).json({ message: 'Tournament is full' });
            }

            const existingParticipation = await database.collections.TournamentParticipants.findOne({
                tournamentId,
                userId: user.id
            });

            if (existingParticipation) {
                return res.status(400).json({ message: 'You have already joined this tournament' });
            }

            if (tournament.entryFee > 0) {
                const userBalance = UserModel.getBalanceAmount(user, 'gems');
                if (userBalance < tournament.entryFee) {
                    return res.status(400).json({ message: 'Not enough gems to join tournament' });
                }
                
                await UserModel.removeBalance(user.stumbleId, 'gems', tournament.entryFee);
            }

            await database.collections.TournamentParticipants.insertOne({
                id: uuidv4(),
                tournamentId,
                userId: user.id,
                username: user.username,
                joinTime: new Date(),
                score: 0,
                position: 0,
                rewardsClaimed: false
            });

            await database.collections.Tournaments.updateOne(
                { id: tournamentId },
                { $inc: { currentPlayers: 1 } }
            );

            res.json({
                message: 'Successfully joined tournament',
                tournamentId,
                entryFeePaid: tournament.entryFee
            });

        } catch (err) {
            Console.error('Tournament', 'Join error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async submitTournamentScore(req, res) {
        try {
            const { user } = req;
            const { tournamentId } = req.params;
            const { score } = req.body;

            if (!tournamentId) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            if (typeof score !== 'number' || score < 0) {
                return res.status(400).json({ message: 'Invalid score' });
            }

            const tournament = await database.collections.Tournaments.findOne({ 
                id: tournamentId,
                isActive: true
            });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found or inactive' });
            }

            const participation = await database.collections.TournamentParticipants.findOne({
                tournamentId,
                userId: user.id
            });

            if (!participation) {
                return res.status(400).json({ message: 'You have not joined this tournament' });
            }

            await database.collections.TournamentParticipants.updateOne(
                { id: participation.id },
                { $set: { score: Math.max(participation.score, score) } }
            );

            res.json({
                message: 'Score submitted successfully',
                tournamentId,
                newScore: score,
                previousScore: participation.score
            });

        } catch (err) {
            Console.error('Tournament', 'Submit score error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async getTournamentLeaderboard(req, res) {
        try {
            const { tournamentId } = req.params;
            const { limit = 50 } = req.query;

            if (!tournamentId) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const tournament = await database.collections.Tournaments.findOne({ 
                id: tournamentId
            });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            const leaderboard = await database.collections.TournamentParticipants
                .find({ tournamentId })
                .sort({ score: -1 })
                .limit(parseInt(limit))
                .project({
                    id: 1,
                    userId: 1,
                    username: 1,
                    score: 1,
                    position: 1
                })
                .toArray();

            if (leaderboard.length > 0) {
                let currentPosition = 1;
                let previousScore = leaderboard[0].score;

                for (let i = 0; i < leaderboard.length; i++) {
                    if (leaderboard[i].score < previousScore) {
                        currentPosition = i + 1;
                        previousScore = leaderboard[i].score;
                    }
                    leaderboard[i].position = currentPosition;
                }

                await Promise.all(leaderboard.map(async (entry, index) => {
                    await database.collections.TournamentParticipants.updateOne(
                        { 
                            tournamentId,
                            userId: entry.userId
                        },
                        { $set: { position: entry.position } }
                    );
                }));
            }

            res.json({
                tournamentId,
                tournamentName: tournament.name,
                leaderboard
            });

        } catch (err) {
            Console.error('Tournament', 'Leaderboard error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async claimTournamentRewards(req, res) {
        try {
            const { user } = req;
            const { tournamentId } = req.params;

            if (!tournamentId) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const tournament = await database.collections.Tournaments.findOne({ 
                id: tournamentId
            });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            const now = new Date();
            if (now < tournament.endTime) {
                return res.status(400).json({ message: 'Tournament has not ended yet' });
            }

            const participation = await database.collections.TournamentParticipants.findOne({
                tournamentId,
                userId: user.id
            });

            if (!participation) {
                return res.status(400).json({ message: 'You did not participate in this tournament' });
            }

            if (participation.rewardsClaimed) {
                return res.status(400).json({ message: 'You have already claimed your rewards' });
            }

            const reward = tournament.rewards.find(r => 
                participation.position >= r.positionRangeLowest && 
                participation.position <= r.positionRangeHighest
            );

            if (!reward) {
                return res.status(400).json({ message: 'No rewards available for your position' });
            }

            switch (reward.type) {
                case 'crowns':
                    await UserModel.addBalance(user.stumbleId, 'crowns', reward.amount);
                    break;
                case 'gems':
                    await UserModel.addBalance(user.stumbleId, 'gems', reward.amount);
                    break;
                case 'skins':
                    await UserModel.addSkin(user.stumbleId, reward.skinId);
                    break;
            }

            await database.collections.TournamentParticipants.updateOne(
                { id: participation.id },
                { $set: { rewardsClaimed: true } }
            );

            res.json({
                message: 'Rewards claimed successfully',
                rewards: reward
            });

        } catch (err) {
            Console.error('Tournament', 'Claim rewards error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async updateTournament(req, res) {
        try {
            const { id } = req.params;
            const updates = req.body;

            if (!id) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ message: 'No updates provided' });
            }

            updates.updatedAt = new Date();

            const result = await database.collections.Tournaments.updateOne(
                { id },
                { $set: updates }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            const updatedTournament = await database.collections.Tournaments.findOne({ id });

            res.json({
                message: 'Tournament updated successfully',
                tournament: updatedTournament
            });

        } catch (err) {
            Console.error('Tournament', 'Update error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async endTournament(req, res) {
        try {
            const { id } = req.params;

            if (!id) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const result = await database.collections.Tournaments.updateOne(
                { id },
                { 
                    $set: { 
                        isActive: false,
                        endTime: new Date(),
                        updatedAt: new Date()
                    } 
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            res.json({ message: 'Tournament ended successfully' });

        } catch (err) {
            Console.error('Tournament', 'End error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
}
class TournamentXController {
  static tournaments = [
    {
      id: 1,
      type: 1,
      isEnabled: true,
      minVersion: "0.56",
      startTime: new Date(),
      endTime: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
      nameKey: "Block Dash Legendary 1x1",
      descriptionKey: "Compete in free-for-all matches, be the last one standing to win!",
      listItemBackgroundImage: "STPBlockDash_Background_Image_Tournaments_Card",
      detailsPanelBackgroundImage: "STPBlockDash_Background_Image_Tournaments",
prizeBannerColour: "#4FC3FF",
headerColour: "#6FD0FF",
mapListGradientColourTop: "#8BDFFF",
mapListGradientColourBottom: "#3BA8FF",
      listPriority: 1,
      minPlayers: 2,
      maxPlayers: 2,
      maxRounds: 1,
      minMatchmakingSeconds: 5,
      entryCurrencyType: "gems",
      entryCurrencyCost: 50,
      entryCurrencyType2: "dust",
      entryCurrencyCost2: 1,
      areEmotesRestricted: true,
      prohibitedEmotes: [2, 4, 5, 6],
detailsPanelBorderColourTop: "#6FD0FF",
detailsPanelBorderColourBottom: "#3BA8FF",
colourData: {
  detailsPanelMainColour: "#4FC3FF",
  detailsPanelBorderColour: "#6FD0FF",
  headerGradientRight: "#4FC3FF",
  headerGradientLeft: "#6FD0FF",
  infoWidgetsGradientRight: "#4FC3FF",
  infoWidgetsGradientLeft: "#3BA8FF",
  infoWidgetsBorderColour: "#6FD0FF"
},

      rounds: [
        {
          roundOrder: 1,
          maxPlayersToProgress: 1,
          minPlayersPerMatch: 2,
          maxPlayersPerMatch: 5,
          areLevelsRestricted: true,
          permittedLevels: ["eventlevel13_block_legendary"]
        }
      ],
      awards: [
        {
          placementRangeLowest: 1,
          placementRangeHighest: 1,
          awardId: 4,
          type: "CURRENCY",
          amount: 500,
          awardJson: { name: "gems" }
        },
        {
          placementRangeLowest: 1,
          placementRangeHighest: 1,
          awardId: 2,
          type: "CURRENCY", 
          amount: 15,
          awardJson: { name: "trophies" }
        }
      ]
    },
    {
      id: 2,
      type: 1,
      isEnabled: true,
      minVersion: "0.56",
      startTime: new Date(),
      endTime: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
      nameKey: "Block Dash 1x1",
      descriptionKey: "Fast 1v1 duels. Pure skill. Only victory.",
      listItemBackgroundImage: "Punchapalooza_Background_Image_Tournaments_Card",
      detailsPanelBackgroundImage: "Punchapalooza_Background_Image_Tournaments",
prizeBannerColour: "#328bffff",
headerColour: "#328bffff",
mapListGradientColourTop: "#328bffff",
mapListGradientColourBottom: "#328bffff",
      listPriority: 2,
      minPlayers: 2,
      maxPlayers: 2,
      maxRounds: 1,
      minMatchmakingSeconds: 10,
      entryCurrencyType: "gems",
      entryCurrencyCost: 50,
      entryCurrencyType2: "tournament_ticket_legendary",
      entryCurrencyCost2: 1,
      areEmotesRestricted: true,
      prohibitedEmotes: [2, 4, 5, 6],
detailsPanelBorderColourTop: "#328bffff",
detailsPanelBorderColourBottom: "#328bffff",
colourData: {
  detailsPanelMainColour: "#328bffff",
  detailsPanelBorderColour: "#328bffff",
  headerGradientRight: "#328bffff",
  headerGradientLeft: "#328bffff",
  infoWidgetsGradientRight: "#328bfffff",
  infoWidgetsGradientLeft: "#328bffff",
  infoWidgetsBorderColour: "#328bffff"
},

      rounds: [
        {
          roundOrder: 1,
          maxPlayersToProgress: 1,
          minPlayersPerMatch: 2,
          maxPlayersPerMatch: 5,
          areLevelsRestricted: true,
          permittedLevels: ["level19_block"]
        }
      ],
      awards: [
        {
          placementRangeLowest: 1,
          placementRangeHighest: 1,
          awardId: 4,
          type: "CURRENCY",
          amount: 450,
          awardJson: { name: "gems" }
        },
        {
          placementRangeLowest: 1,
          placementRangeHighest: 1,
          awardId: 2,
          type: "CURRENCY",
          amount: 50,
          awardJson: { name: "trophies" }
        },
        {
          placementRangeLowest: 1,
          placementRangeHighest: 1,
          awardId: 3,
          type: "CURRENCY",
          amount: 5,
          awardJson: { name: "crowns" }
        }
      ]
    },
    {
      id: 54,
      type: 1,
      isEnabled: true,
      minVersion: "0.56",
      startTime: new Date(),
      endTime: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
      nameKey: "Rush Hour 1x1",
      descriptionKey: "Win, Farps and be the best",
      listItemBackgroundImage: "IceSki_Background_Image_Tournaments_Card",
      detailsPanelBackgroundImage: "IceSki_Background_Image_Tournaments",
prizeBannerColour: "#29ffdb3b",
headerColour: "#32ffd3ff",
mapListGradientColourTop: "#5bffb2ff",
mapListGradientColourBottom: "#3cffffff",
      listPriority: 2,
      minPlayers: 2,
      maxPlayers: 2,
      maxRounds: 1,
      minMatchmakingSeconds: 10,
      entryCurrencyType: "gems",
      entryCurrencyCost: 50,
      entryCurrencyType2: "tournament_ticket_legendary",
      entryCurrencyCost2: 1,
      areEmotesRestricted: true,
      prohibitedEmotes: [1, 2, 3, 4, 6, 7, 8, 9, 10],
detailsPanelBorderColourTop: "#6EC9FF",
detailsPanelBorderColourBottom: "#3DA6FF",
colourData: {
  detailsPanelMainColour: "#55BFFF",
  detailsPanelBorderColour: "#66CCFF",
  headerGradientRight: "#3DA6FF",
  headerGradientLeft: "#8ED8FF",
  infoWidgetsGradientRight: "#4BB7FF",
  infoWidgetsGradientLeft: "#9BE1FF",
  infoWidgetsBorderColour: "#8ED8FF"
},
      rounds: [
        {
          roundOrder: 1,
          maxPlayersToProgress: 1,
          minPlayersPerMatch: 2,
          maxPlayersPerMatch: 2,
          areLevelsRestricted: true,
          permittedLevels: ["level24_streamtiles"]
        }
      ],
      awards: [
        {
          placementRangeLowest: 1,
          placementRangeHighest: 1,
          awardId: 4,
          type: "CURRENCY",
          amount: 400,
          awardJson: { name: "gems" }
        },
        {
          placementRangeLowest: 1,
          placementRangeHighest: 1,
          awardId: 2,
          type: "CURRENCY",
          amount: 50,
          awardJson: { name: "trophies" }
        },
        {
          placementRangeLowest: 1,
          placementRangeHighest: 1,
          awardId: 3,
          type: "CURRENCY",
          amount: 5,
          awardJson: { name: "crowns" }
        }
      ]
    }
  ];

  static seasons = [
    {
      awards: [
        { amount: 1, awardId: 1, awardJson: { id: "SKIN330" }, type: "SKIN", xp: 5 },
        { amount: 100, awardId: 2, awardJson: { name: "gems" }, type: "CURRENCY", xp: 10 },
        { amount: 1, awardId: 3, awardJson: { id: "SKIN438" }, type: "SKIN", xp: 15 },
        { amount: 1, awardId: 4, awardJson: { id: "Emote047_XmasSkull" }, type: "EMOTE", xp: 20 },
        { amount: 50, awardId: 5, awardJson: { name: "dust" }, type: "CURRENCY", xp: 25 },
        { amount: 1, awardId: 6, awardJson: { id: "emote_thumb" }, type: "EMOTE", xp: 30 },
        { amount: 50, awardId: 7, awardJson: { name: "dusy" }, type: "CURRENCY", xp: 35 },
        { amount: 1, awardId: 8, awardJson: { id: "SKIN210" }, type: "SKIN", xp: 40 },
        { amount: 1, awardId: 9, awardJson: { id: "Emote060_HoldingTears" }, type: "EMOTE", xp: 45 },
        { amount: 1, awardId: 10, awardJson: { id: "SKIN123" }, type: "SKIN", xp: 50 },
        { amount: 20, awardId: 11, awardJson: { name: "gems" }, type: "CURRENCY", xp: 55 },
        { amount: 1, awardId: 12, awardJson: { id: "Emote032_RedCard" }, type: "EMOTE", xp: 60 },
        { amount: 50, awardId: 13, awardJson: { name: "dust" }, type: "CURRENCY", xp: 65 },
        { amount: 1, awardId: 14, awardJson: { id: "SKIN148" }, type: "SKIN", xp: 70 },
        { amount: 1, awardId: 15, awardJson: { id: "emote_dab" }, type: "EMOTE", xp: 75 },
        { amount: 75, awardId: 16, awardJson: { name: "dust" }, type: "CURRENCY", xp: 80 },
        { amount: 20, awardId: 17, awardJson: { name: "gems" }, type: "CURRENCY", xp: 85 },
        { amount: 1, awardId: 18, awardJson: { id: "emote_go" }, type: "EMOTE", xp: 90 },
        { amount: 50, awardId: 19, awardJson: { name: "dust" }, type: "CURRENCY", xp: 95 },
        { amount: 1, awardId: 20, awardJson: { id: "SKIN365" }, type: "SKIN", xp: 100 },
        { amount: 10, awardId: 21, awardJson: { name: "gems" }, type: "CURRENCY", xp: 105 },
        { amount: 50, awardId: 22, awardJson: { name: "gems" }, type: "CURRENCY", xp: 110 },
        { amount: 1, awardId: 23, awardJson: { id: "emote_skull" }, type: "EMOTE", xp: 115 },
        { amount: 1, awardId: 24, awardJson: { id: "SKIN195" }, type: "SKIN", xp: 120 },
        { amount: 50, awardId: 25, awardJson: { name: "dust" }, type: "CURRENCY", xp: 125 },
        { amount: 20, awardId: 26, awardJson: { name: "gems" }, type: "CURRENCY", xp: 130 },
        { amount: 1, awardId: 27, awardJson: { id: "SKIN51" }, type: "SKIN", xp: 135 },
        { amount: 1, awardId: 28, awardJson: { id: "Emote057_PartyPop" }, type: "EMOTE", xp: 140 },
        { amount: 50, awardId: 29, awardJson: { name: "dust" }, type: "CURRENCY", xp: 145 },
        { amount: 1, awardId: 30, awardJson: { id: "SKIN444" }, type: "SKIN", xp: 150 },
        { amount: 1, awardId: 999, awardJson: { id: "SKIN375" }, type: "SKIN", xp: 999 }
      ],
      backgroundImageKey: "",
      descriptionKey: "",
      endTime: "2026-04-03T10:00:00",
      id: 1,
      isEnabled: true,
      nameKey: "TOURNAMENTS",
      claimSeasonReward: true,
      startTime: "2024-03-06T10:00:00"
    }
  ];

  static getSeasons(req, res) {
    try {
      res.status(200).json(TournamentXController.seasons);
    } catch (err) {
      res.status(500).json({ message: "Internal server error" });
    }
  }

  static getActive(req, res) {
    try {
      const now = new Date();
      res.status(200).json(TournamentXController.tournaments);
    } catch (err) {
      console.error("erro:", err);
      res.status(500).json({ message: "erro interno" });
    }
  }

  static async join(req, res) {
    try {
      const { user } = req;
      const tournamentId = parseInt(req.params.tournamentId);
      const tournament = TournamentXController.tournaments.find(t => t.id === tournamentId);

      if (!tournament) {
        return res.status(404).json({ message: "torneio nao encontrado" });
      }

      if (!tournament.isEnabled) {
        return res.status(400).json({ message: "torneio desativado" });
      }

      const now = new Date();
      if (now < tournament.startTime || now > tournament.endTime) {
        return res.status(400).json({ message: "torneio nao esta ativo no momento" });
      }

      if (tournament.entryCurrencyCost > 0) {
        const userBalance = UserModel.getBalanceAmount(user, tournament.entryCurrencyType);
        if (userBalance < tournament.entryCurrencyCost) {
          return res.status(400).json({
            message: `saldo insuficiente de ${tournament.entryCurrencyType}`
          });
        }

        await UserModel.removeBalance(user.deviceId, tournament.entryCurrencyType, tournament.entryCurrencyCost);
      }

      tournament.players.push({
        stumbleId: user.stumbleId,
        userId: user.id,
        username: user.username
      });

      const entryToken = `tournament-${tournament.id}-${Date.now()}`;
      const expiryDate = tournament.endTime.toISOString();

      const maps = [];
      const roundsQualified = [];

      if (Array.isArray(tournament.rounds)) {
        for (const round of tournament.rounds) {
          if (Array.isArray(round.permittedLevels)) {
            round.permittedLevels.forEach(lvl => maps.push({ id: lvl }));
          }
          if (round.maxPlayersToProgress) {
            roundsQualified.push(round.maxPlayersToProgress);
          }
        }
      }

      if (!Array.isArray(tournament.partys)) {
        tournament.partys = [];
      }

      const maxPlayers = tournament.maxPlayers || 2;
      let partyId;
      let MatchmakerTag;
      let found = false;

      for (const partyList of tournament.partys) {
        for (const party of partyList) {
          if (party.players.length < maxPlayers) {
            party.players.push(user.stumbleId);
            MatchmakerTag = party.partyId;
            partyId = party.partyId;
            found = true;
            break;
          }
        }
        if (found) break;
      }

      if (!found) {
        const newParty = {
          partyId: `tournament-${tournament.id}-${Math.floor(Math.random() * 9999)}`,
          players: [user.stumbleId]
        };
        tournament.partys.push([newParty]);
        MatchmakerTag = newParty.partyId;
        partyId = newParty.partyId;
      }

      const response = {
        entryToken,
        MatchmakerTag,
        requestId: user.stumbleId
      };

      console.log(`coloquei o ${user.username} na partida ${partyId} no torneio ${tournament.nameKey} com id ${tournament.id} e token ${entryToken}`);
      res.status(200).json(response);
    } catch (err) {
      console.error("erro ao entrar no torneio:", err);
      res.status(500).json({ message: "erro interno do servidor" });
    }
  }

  static async leave(req, res) {
    try {
      const { user } = req;
      const tournamentId = parseInt(req.params.tournamentId);
      const tournament = TournamentXController.tournaments.find(t => t.id === tournamentId);

      if (!tournament) {
        return res.status(404).json({ message: "torneio nao encontrado" });
      }

      const playerIndex = tournament.players.findIndex(p => p.stumbleId === user.stumbleId);
      if (playerIndex !== -1) {
        tournament.players.splice(playerIndex, 1);
        if (tournament.entryCurrencyCost > 0) {
          await UserModel.addBalance(user.deviceId, tournament.entryCurrencyType, tournament.entryCurrencyCost);
        }
      }

      res.status(200).json({ message: "saiu" });
    } catch (err) {
      console.error("tournamentx", "erro ao sair do torneio:", err);
      res.status(500).json({ message: "erro interno do servidor" });
    }
  }

static async finish(req, res) {
  try {
    const { Round, TournamentId, EntryToken, SignedPayload } = req.body;
    const { user } = req;

    if (typeof Round === 'undefined') {
      return res.status(400).json({ mensagem: "precisa do round" });
    }

    if (!user || !user.stumbleId || !user.userProfile) {
      return res.status(400).json({ mensagem: "user invalido" });
    }

    const roundResult = parseInt(Round);
    if (isNaN(roundResult)) {
      return res.status(400).json({ mensagem: "round invalido" });
    }

    let gemsChange = 0;
    let pointsChange = 0;
    // IMPORTANT: Nei tournamentX/tourx NON si modificano mai le corone (né quando si vince né quando si perde)
    let crownsChange = 0;

    if (roundResult === 1) {
      gemsChange = 100;
      pointsChange = 10;
      // crownsChange rimane 0 (non dare corone quando si vince)
    } else if (roundResult === 0) {
      pointsChange = -10;
      // crownsChange rimane 0 (non togliere corone quando si perde)
    }

    const currentTrophies = parseInt(user.userProfile.trophies) || 0;
    const currentSkill = parseInt(user.skillRating) || 0;

    // IMPORTANT: evita popup client "The active season is null" assicurando una season valida
    const seasons = SharedData?.RankedPlaySettings?.Seasons;
    const defaultSeasonId =
      (Array.isArray(seasons) &&
        (seasons.find(s => s && typeof s.Id === "string")?.Id || seasons[0]?.Id)) ||
      "LIVE_RANKED_SEASON_0";

    const updatedUserProfile = {
      ...user.userProfile,
      trophies: Math.max(0, currentTrophies + pointsChange),
      ranked: {
        ...(user.userProfile?.ranked || {}),
        currentSeasonId: defaultSeasonId,
        currentRankId: user.userProfile?.ranked?.currentRankId ?? 0,
        currentTierIndex: user.userProfile?.ranked?.currentTierIndex ?? 0
      }
    };

    const updatedUser = await UserModel.update(user.stumbleId, {
      skillRating: Math.max(0, currentSkill + pointsChange),
      userProfile: updatedUserProfile
    });

    if (gemsChange > 0) {
      await UserModel.addBalance(user.deviceId, "gems", gemsChange);
    }

    console.log("Finalizei o round do " + user.username);

    res.status(200).json({
      TournamentId,
      Round: roundResult,
      EntryToken,
      SignedPayload,
      CollectedCurrencies: gemsChange > 0 ? ["gems", gemsChange] : [],
      // Forza il profilo “safe” anche nella risposta (alcune updateUser possono tornare un doc parziale)
      User: { ...(updatedUser || {}), userProfile: updatedUserProfile }
    });

  } catch (err) {
    console.error("erro ao finalizar round de tourx:", err);
    res.status(500).json({ mensagem: "erro interno do servidor" });
  }
}

  static async getSeasonProgress(req, res) {
    try {
      const { seasonId } = req.params;
      const { user } = req;

      const foundUser = await UserModel.findByStumbleId(user.stumbleId);

      if (!foundUser) {
        return res.status(404).json("putz vc n existe");
      }

      let userSeasonData = foundUser.tournamentSeasons?.find(season =>
        season.seasonId === parseInt(seasonId)
      );

      if (!userSeasonData) {
        userSeasonData = {
          seasonId: parseInt(seasonId),
          xp: 0,
          claimedAwards: []
        };

        if (!foundUser.tournamentSeasons) {
          foundUser.tournamentSeasons = [userSeasonData];
        } else {
          foundUser.tournamentSeasons.push(userSeasonData);
        }

        await UserModel.update(user.stumbleId, {
          tournamentSeasons: foundUser.tournamentSeasons
        });
      }

      const seasonProgress = {
        seasonId: parseInt(seasonId),
        userId: foundUser.id,
        xp: userSeasonData.xp,
        claimedAwards: userSeasonData.claimedAwards
      };

      res.status(200).json(seasonProgress);

    } catch (err) {
      Console.error('Tournament', 'Get season progress error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }


  static async claimSeasonReward(req, res) {
    try {
      const { seasonId, awardId } = req.params;
      const { user } = req;

      const foundUser = await UserModel.findByStumbleId(user.stumbleId);
      if (!foundUser) {
        return res.status(404).json({ message: "User not found" });
      }

      const season = TournamentXController.seasons.find(s => s.id === parseInt(seasonId));
      if (!season) {
        return res.status(404).json({ message: "Season not found" });
      }

      const award = season.awards.find(a => a.awardId === parseInt(awardId));
      if (!award) {
        return res.status(404).json({ message: "Award not found" });
      }

      let userSeasonData = foundUser.tournamentSeasons?.find(s => s.seasonId === parseInt(seasonId));

      if (!userSeasonData) {
        userSeasonData = {
          seasonId: parseInt(seasonId),
          xp: 0,
          claimedAwards: []
        };

        if (!foundUser.tournamentSeasons) {
          foundUser.tournamentSeasons = [userSeasonData];
        } else {
          foundUser.tournamentSeasons.push(userSeasonData);
        }

        await UserModel.update(user.stumbleId, {
          tournamentSeasons: foundUser.tournamentSeasons
        });
      }

      if (userSeasonData.xp < award.xp) {
        return res.status(400).json({ message: "Insufficient XP to claim this award" });
      }

      if (userSeasonData.claimedAwards.includes(parseInt(awardId))) {
        return res.status(400).json({ message: "Award already claimed" });
      }

      let rewards = [];

      if (award.type === "CURRENCY") {
        const currencyName = award.awardJson.name;
        const currencyReward = {
          amount: award.amount,
          duplicateCurrencyAmount: 0,
          nestedRewards: [],
          sourceType: "TOURNAMENT_SEASON",
          type: "CURRENCY",
          typeInfo: currencyName
        };
        rewards.push(currencyReward);
        await UserModel.addBalance(user.stumbleId, currencyName, award.amount);
      } else if (award.type === "SKIN") {
        const skinId = award.awardJson.id;
        const wheelReward = {
          amount: 1,
          duplicateCurrencyAmount: 0,
          nestedRewards: [
            {
              amount: 1,
              duplicateCurrencyAmount: 0,
              nestedRewards: [],
              sourceType: "UNKNOWN",
              type: "SKIN",
              typeInfo: skinId
            }
          ],
          sourceType: "TOURNAMENT_SEASON",
          type: "WHEEL",
          typeInfo: "TOURNAMENT_SEASON_WHEEL"
        };
        rewards.push(wheelReward);
        await UserModel.addSkin(user.stumbleId, skinId);
      } else if (award.type === "EMOTE") {
        const emoteId = award.awardJson.id;
        const wheelReward = {
          amount: 1,
          duplicateCurrencyAmount: 0,
          nestedRewards: [
            {
              amount: 1,
              duplicateCurrencyAmount: 0,
              nestedRewards: [],
              sourceType: "UNKNOWN",
              type: "EMOTE",
              typeInfo: emoteId
            }
          ],
          sourceType: "TOURNAMENT_SEASON",
          type: "WHEEL",
          typeInfo: "TOURNAMENT_SEASON_WHEEL"
        };
        rewards.push(wheelReward);
        await database.addToUserArray({ stumbleId: user.stumbleId }, 'emotes', emoteId);
      } else if (award.type === "FOOTSTEPS") {
        const footstepId = award.awardJson.id;
        const wheelReward = {
          amount: 1,
          duplicateCurrencyAmount: 0,
          nestedRewards: [
            {
              amount: 1,
              duplicateCurrencyAmount: 0,
              nestedRewards: [],
              sourceType: "UNKNOWN",
              type: "FOOTSTEPS",
              typeInfo: footstepId
            }
          ],
          sourceType: "TOURNAMENT_SEASON",
          type: "WHEEL",
          typeInfo: "TOURNAMENT_SEASON_WHEEL"
        };
        rewards.push(wheelReward);
        await database.addToUserArray({ stumbleId: user.stumbleId }, 'footsteps', footstepId);
      }

      userSeasonData.claimedAwards.push(parseInt(awardId));
      await UserModel.update(user.stumbleId, {
        tournamentSeasons: foundUser.tournamentSeasons.map(s =>
          s.seasonId === parseInt(seasonId) ? userSeasonData : s
        )
      });

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.status(200).json({
        User: updatedUser,
        Rewards: rewards
      });

    } catch (err) {
      Console.error("TournamentX", "Error claiming season reward:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
  


}

class SocialController {
  static rankedSeasonId() {
    return (
      (SharedData?.RankedPlaySettings?.Seasons &&
        SharedData.RankedPlaySettings.Seasons[0] &&
        SharedData.RankedPlaySettings.Seasons[0].Id) ||
      "LIVE_RANKED_SEASON_0"
    );
  }

  static toFriendProfile(user) {
    const lastSeen = user.lastLogin
      ? (user.lastLogin instanceof Date
          ? user.lastLogin.toISOString()
          : new Date(user.lastLogin).toISOString())
      : new Date().toISOString();

    return {
      userId: user.id || 0,
      userName: user.username || "Unknown",
      title: "",
      country: user.country || "Unknown",
      trophies: user.skillRating || 0,
      crowns: user.crowns || 0,
      experience: user.experience || 0,
      hiddenRating: Math.floor((user.skillRating || 0) / 10),
      isOnline: true,
      lastSeenDate: lastSeen,
      skin: user.equippedCosmetics?.skin || "SKIN1",
      nativePlatformName: "android",
      ranked: {
        currentSeasonId: SocialController.rankedSeasonId(),
        currentRankId: 0,
        currentTierIndex: 0
      },
      flags: 0
    };
  }

  static async getInteractions(req, res) {
    try {
      const empty = {
        friends: [],
        friendRequests: [],
        partyInvites: [],
        recommendedFriends: []
      };

      // Mongo offline / memory mode: niente crash, lista vuota
      if (!database.ready || !database.collections.Users) {
        return res.json(empty);
      }

      const { user } = req;
      if (!user) return res.json(empty);

      const friendIds = Array.isArray(user.friends) ? user.friends : [];
      const receivedRequests = Array.isArray(user.receivedFriendRequests)
        ? user.receivedFriendRequests
        : [];
      const receivedPartyInvites = Array.isArray(user.receivedPartyInvites)
        ? user.receivedPartyInvites
        : [];

      const friends = await database.collections.Users.find({
        stumbleId: { $in: friendIds }
      })
        .project({
          id: 1,
          username: 1,
          stumbleId: 1,
          country: 1,
          skillRating: 1,
          crowns: 1,
          experience: 1,
          equippedCosmetics: 1,
          lastLogin: 1
        })
        .toArray();

      const friendProfiles = friends.map((friend) =>
        SocialController.toFriendProfile(friend)
      );

      const pendingUsers = await database.collections.Users.find({
        stumbleId: { $in: receivedRequests }
      })
        .project({
          id: 1,
          username: 1,
          country: 1,
          skillRating: 1,
          crowns: 1,
          experience: 1,
          equippedCosmetics: 1,
          lastLogin: 1
        })
        .toArray();

      const friendRequestProfiles = pendingUsers.map((u) =>
        SocialController.toFriendProfile(u)
      );

      const excludeIds = [...friendIds, ...receivedRequests, user.stumbleId].filter(
        (id) => id
      );

      let recommendedProfiles = [];
      try {
        const recommendedUsers = await database.collections.Users.aggregate([
          {
            $match: {
              stumbleId: {
                $exists: true,
                $nin: excludeIds.length > 0 ? excludeIds : ["non-existent-id"]
              },
              country: { $exists: true }
            }
          },
          { $sample: { size: 5 } },
          {
            $project: {
              id: 1,
              username: 1,
              country: 1,
              skillRating: 1,
              crowns: 1,
              experience: 1,
              equippedCosmetics: 1,
              lastLogin: 1
            }
          }
        ]).toArray();

        recommendedProfiles = recommendedUsers.map((u) => {
          const tags = [];
          if (u.country === user.country) tags.push("SAME_COUNTRY");
          if (Math.abs((u.skillRating || 0) - (user.skillRating || 0)) < 200) {
            tags.push("SIMILAR_SKILL");
          }

          return {
            tags: tags.length > 0 ? tags : ["SIMILAR_SKILL"],
            userProfile: SocialController.toFriendProfile(u)
          };
        });
      } catch (recErr) {
        Console.error("Social", "Recommended friends error:", recErr);
      }

      const partyInviteDetails = await Promise.all(
        receivedPartyInvites.map(async (invite) => {
          const fromUser = await database.collections.Users.findOne({
            stumbleId: invite.fromStumbleId
          });
          return {
            fromUserId: invite.fromUserId,
            fromUsername: invite.fromUsername,
            fromStumbleId: invite.fromStumbleId,
            sentAt: invite.sentAt,
            fromUserProfile: fromUser
              ? SocialController.toFriendProfile(fromUser)
              : null
          };
        })
      );

      res.status(200).json({
        friends: friendProfiles,
        friendRequests: friendRequestProfiles,
        partyInvites: partyInviteDetails,
        recommendedFriends: recommendedProfiles
      });
    } catch (err) {
      Console.error("Social", "Interactions error:", err);
      res.status(200).json({
        friends: [],
        friendRequests: [],
        partyInvites: [],
        recommendedFriends: []
      });
    }
  }
}



class MatchmakingController {
  static async getMatchmakingFilter(req, res) {
    try {
      const { deviceId } = req.query;
      
      if (!deviceId) {
        return res.status(400).json({ 
          error: "Bad Request",
          message: "deviceId query parameter is required" 
        });
      }

      const user = await UserModel.findByDeviceId(deviceId);
      
      if (!user) {
        return res.status(404).json({ 
          error: "Not Found",
          message: "User not found" 
        });
      }

      const sharedType = process.env.sharedType || 'NULL';
      const version = user.version || '0';
      const platform = user.userProfile?.nativePlatformName || 'null';
      const skillTier = Math.floor((user.skillRating || 0) / 1000);
      const regionCodes = ['na', 'eu', 'as', 'sa', 'af', 'oc', 'ae'];
      const region = regionCodes[Math.floor(Math.random() * regionCodes.length)];

      const matchmakingFilter = `${sharedType}_${version}_${platform}_${skillTier}_${region}`;

      return res.status(200).json({ matchmakingFilter });
      
    } catch (err) {
      Console.error('Matchmaking', 'Filter error:', err);
      return res.status(500).json({ 
        error: "Internal Server Error",
        message: "An error occurred while generating matchmaking filter" 
      });
    }
  }
}
class EventsController {
  static async getActive(req, res) { 
    try {
      // Per evitare problemi con stagioni/eventi non configurati (“The active season is null”),
      // non esponiamo alcun evento lato backend.
      res.json({ gameEvents: [] });
    } catch (err) {
      Console.error('GameEvents', 'Error:', err);
      res.status(500).json([]);
    }
  }
}
function errorControll(err, req, res, next) {
  Console.error('Unhandled', 'Error:', err);
  if (!res.headersSent) {
    // Risponde con successo per evitare il popup Rew001
    res.status(200).set('Content-Type', 'application/json').json({ ok: true });
  }
}

async function sendShared(req, res) {
  try {
    const { getSharedJsonBuffer } = require("./SharedUtils");
    const buf = getSharedJsonBuffer();
    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    // Il client legge header ETag in ReceiveUserConfigurationFromRequest.
    // Senza ETag può uscire senza chiamare ParseDataAsync → SharedData null → lobby infinita.
    // Mai 304: If-None-Match è già strippato in index.js.
    res.setHeader("ETag", '"sg-shared-v073-photon2"');
    // Non impostare Content-Length: compression gzip lo ricalcola
    return res.send(buf);
  } catch (err) {
    console.error("sendShared", err);
    if (!res.headersSent) res.sendStatus(500);
  }
}

async function OnlineCheck(req, res) {
  res.status(200).send("OK");
}

module.exports = {
  BackendUtils,
  Database,
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
  getPhotonAuthRecent,
  generatePhotonJwt,
  formatLoginResponse,
  rebuildStyledUsername,
  stripTrailingColorWhite,
  getBaseUsername
};
