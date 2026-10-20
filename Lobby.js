

const BackendUtilsModule = require("./services");
const UserModelRef = BackendUtilsModule.UserModel;
const formatLogin = BackendUtilsModule.formatLoginResponse;
const genJwt = BackendUtilsModule.generatePhotonJwt;

function logLobby(action, ok, detail, ms) {
  const status = ok ? "OK" : "FAIL";
  console.log(`[LOBBY] ${action} ${status} ${detail || ""} ${ms}ms`);
}

function pickBody(body, ...keys) {
  if (!body || typeof body !== "object") return undefined;
  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== "") return body[k];
  }
  return undefined;
}

function pickRequestedUsername(body, depth = 0) {
  if (body == null || depth > 4) return undefined;

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
    try { return pickRequestedUsername(JSON.parse(trimmed), depth + 1); }
    catch { return undefined; }
  }

  if (Array.isArray(body)) {
    for (const value of body) {
      const found = pickRequestedUsername(value, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (typeof body !== "object") return undefined;
  const accepted = new Set(["username", "newusername", "requestedusername", "name", "newname", "displayname", "newdisplayname"]);
  const nested = new Set(["data", "payload", "user", "profile", "update", "updates", "request", "body", "input", "args", "parameters"]);
  for (const [key, value] of Object.entries(body)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (accepted.has(normalized) && (typeof value === "string" || typeof value === "number")) {
      return String(value);
    }
  }
  for (const [key, value] of Object.entries(body)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (nested.has(normalized) && value && typeof value === "object") {
      const found = pickRequestedUsername(value, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
function normalizeActionEmote(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return null;
  const s = String(v).trim();
  if (!s || /^\d+$/.test(s)) return null;
  return s;
}

function pickActionEmote(body, prev, ...keys) {
  if (body && typeof body === "object") {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        return normalizeActionEmote(body[k]);
      }
    }
  }
  return normalizeActionEmote(prev);
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
    AEC: "aec",
    skin_purchase: "skin_purchase"
  };
  return map[key] || key.toLowerCase();
}

function getBalanceAmount(user, currency) {
  if (!user || !Array.isArray(user.balances)) return 0;
  const want = resolveBalanceName(currency);
  const bal = user.balances.find((b) => resolveBalanceName(b.name || b.Name) === want);
  return bal ? Number(bal.amount ?? bal.Amount ?? 0) : 0;
}

async function ensureBalance(user, currency, minAmount) {
  const have = getBalanceAmount(user, currency);
  if (have >= minAmount) return have;
  const need = minAmount - have;
  await UserModelRef.addBalance(user, currency, need);
  const fresh = await UserModelRef.findByStumbleId(user.stumbleId);
  if (fresh) Object.assign(user, fresh);
  return getBalanceAmount(user, currency);
}

async function resolveUser(req) {
  let user = req.user || null;
  if (user) return user;
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== "string") return null;
  if (authHeader.startsWith("Bearer ")) return null;
  try {
    const authData = JSON.parse(authHeader);
    if (authData.StumbleId) user = await UserModelRef.findByStumbleId(authData.StumbleId);
    if (!user && authData.DeviceId) user = await UserModelRef.findByDeviceId(authData.DeviceId);
    if (!user && authData.Token && UserModelRef.findByToken) {
      user = await UserModelRef.findByToken(authData.Token);
    }
  } catch {}
  return user;
}

async function requireUser(req, res) {
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ message: "unauthorized", error: "UNAUTHORIZED" });
    return null;
  }
  req.user = user;
  return user;
}

async function replyWithUser(res, user, extra = {}) {
  const fresh = (await UserModelRef.findByStumbleId(user.stumbleId)) || user;
  const jwt = await genJwt(fresh);
  const payload = formatLogin(fresh, jwt);
  if (Array.isArray(extra.Rewards)) {
    payload.Rewards = extra.Rewards;
    if (payload.User) payload.User.Rewards = extra.Rewards;
  }
  return res.status(200).json(Object.assign(payload, extra.top || {}));
}

function getShared() {
  try {
    const { generateAuthPayload } = require("./shared");
    return generateAuthPayload() || {};
  } catch {
    try {
      return require("./shared.json");
    } catch {
      return {};
    }
  }
}

function makeReward(type, typeInfo, amount) {

  return {
    Type: String(type || "CURRENCY").toUpperCase(),
    TypeInfo: String(typeInfo || "gems"),
    Amount: Number(amount || 1) || 1,
    duplicateCurrencyAmount: 0,
    duplicateCurrency: "",
    isDuplicatedOrigin: false,
    NestedRewards: [],
    SourceType: "UNKNOWN"
  };
}

function resolveBattlePassSlotRewards(shared, { passId, page, section, slot, tierIndex, isPremium }) {
  const v3list = shared?.BattlePassesV3 || [];
  const v3 =
    v3list.find((p) => Number(p.PassID || p.passID) === Number(passId)) ||
    v3list[v3list.length - 1];
  const pages = v3?.Content?.Pages || v3?.content?.Pages;
  if (Array.isArray(pages) && pages[page]) {
    const sections = pages[page].Sections || pages[page].sections || [];
    const sec = sections[section] || sections[0];
    const slots = sec?.Slots || sec?.slots || [];

    let chosen = slots[slot];
    if (chosen && typeof chosen.IsPremium === "boolean" && chosen.IsPremium !== isPremium) {
      const alt = slots.find((s) => !!s.IsPremium === !!isPremium);
      if (alt) chosen = alt;
    }
    if (!chosen) {
      chosen = slots.find((s) => !!s.IsPremium === !!isPremium) || slots[0];
    }
    if (chosen && Array.isArray(chosen.Rewards || chosen.rewards)) {
      return chosen.Rewards || chosen.rewards;
    }
  }

  const legacy = shared?.BattlePasses || [];
  const pass =
    legacy.find((p) => Number(p.PassID || p.passID) === Number(passId)) ||
    legacy[legacy.length - 1] ||
    shared?.BattlePass;
  const tiers = pass?.Tiers || [];
  const tier = tiers[tierIndex] || tiers[0];
  if (!tier) return null;
  const list = isPremium
    ? tier.PremiumReward || tier.premiumReward || []
    : tier.FreeReward || tier.freeReward || [];
  return Array.isArray(list) ? list : null;
}

function getActiveBattlePassId(shared, userBp) {
  const v3 = shared?.BattlePassesV3 || [];
  const v3Ids = new Set(v3.map((p) => Number(p.PassID || p.passID)));
  const fromUser = Number(userBp?.passID || userBp?.PassID || 0);
  if (fromUser && v3Ids.has(fromUser)) return fromUser;
  if (v3.length) return Number(v3[v3.length - 1].PassID || 33);
  const legacy = shared?.BattlePasses || [];
  if (legacy.length) return Number(legacy[legacy.length - 1].PassID || 32);
  return 33;
}

function rewardTypeToEnumName(type) {
  const t = String(type || "CURRENCY").toUpperCase();
  if (t === "0" || t === "CURRENCY") return "CURRENCY";
  if (t === "1" || t === "SKIN") return "SKIN";
  if (t === "2" || t === "ANIMATION") return "ANIMATION";
  if (t === "3" || t === "EMOTE") return "EMOTE";
  if (t === "4" || t === "FOOTSTEPS") return "FOOTSTEPS";
  return t;
}

async function grantBackendReward(user, reward) {
  const type = rewardTypeToEnumName(reward.type || reward.Type);
  let typeInfo = reward.typeInfo || reward.TypeInfo || "gems";
  const amount = Number(reward.amount ?? reward.Amount ?? reward.min ?? reward.Min ?? 1) || 1;
  const shared = getShared();

  if (type === "CURRENCY") {
    await UserModelRef.addBalance(user, typeInfo, amount);
    return makeReward("CURRENCY", typeInfo, amount);
  }

  if (type === "SKIN") {
    const rarities = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "SPECIAL"];
    if (rarities.includes(String(typeInfo).toUpperCase())) {
      const skins = shared.Skins_v4 || shared.Skins || [];
      const pool = skins.filter(
        (s) => String(s.Rarity || s.rarity || "").toUpperCase() === String(typeInfo).toUpperCase()
      );
      const pick = pool[Math.floor(Math.random() * Math.max(pool.length, 1))];
      typeInfo = (pick && (pick.SkinID || pick.Id || pick.id || pick.ID)) || "SKIN2";
    }
    await UserModelRef.addSkin(user.stumbleId, typeInfo);
    return makeReward("SKIN", typeInfo, 1);
  }

  if (type === "EMOTE" || type === "ANIMATION" || type === "FOOTSTEPS") {

    try {
      if (type === "EMOTE" && UserModelRef.addActionEmote) {
        await UserModelRef.addActionEmote(user.stumbleId, typeInfo);
      }
      const field = type === "EMOTE" ? "emotes" : type === "ANIMATION" ? "animations" : "footsteps";
      const arr = Array.isArray(user[field]) ? [...user[field]] : [];
      if (typeInfo && !arr.includes(typeInfo)) {
        arr.push(typeInfo);
        await UserModelRef.update(user.stumbleId, { [field]: arr });
      }
    } catch (e) {
      console.warn("[LOBBY] grant cosmetic:", e && e.message);
    }
    return makeReward(type, typeInfo, 1);
  }

  try {
    await UserModelRef.addBalance(user, typeInfo || "gems", amount > 0 ? amount : 1);
    return makeReward("CURRENCY", typeInfo || "gems", amount > 0 ? amount : 1);
  } catch {
    await UserModelRef.addBalance(user, "gems", amount > 0 ? amount : 5);
    return makeReward("CURRENCY", "gems", amount > 0 ? amount : 5);
  }
}

function pickWeighted(pool) {
  if (!Array.isArray(pool) || pool.length === 0) return null;
  const total = pool.reduce((s, r) => s + Number(r.chance || r.Chance || 1), 0);
  let roll = Math.random() * (total || 1);
  for (const r of pool) {
    roll -= Number(r.chance || r.Chance || 1);
    if (roll <= 0) return r;
  }
  return pool[0];
}

function resolveDropDef(dropId, shared) {
  const defs =
    shared?.GeneralSettings?.DropSettings?.DropDefs_v2 ||
    shared?.DropSettings?.DropDefs_v2 ||
    shared?.DropSettings?.DropDefs ||
    [];
  const want = String(dropId || "").toLowerCase();
  return (
    defs.find((d) => String(d.ID || d.Id || d.id || "").toLowerCase() === want) ||
    null
  );
}

function resolveDropPurchase(purchaseId, shared) {
  const lists = [
    shared?.GeneralSettings?.DropSettings?.Purchases,
    shared?.DropSettings?.Purchases,
    shared?.GeneralSettings?.SkinDrops_v2?.Purchases,
    shared?.SkinDrops_v2?.Purchases
  ];
  const want = String(purchaseId || "").toUpperCase();
  for (const purchases of lists) {
    if (!Array.isArray(purchases)) continue;
    const found = purchases.find(
      (p) => String(p.ID || p.Id || p.id || p.Name || "").toUpperCase() === want
    );
    if (found) return found;
  }
  return null;
}

function defaultDropPurchase(itemId) {
  const id = String(itemId || "RARE").toUpperCase();
  const prices = {
    FREE: [{ Amount: 0, Currency: "gems" }],
    FREE_SPIN: [{ Amount: 0, Currency: "gems" }],
    COMMON: [{ Amount: 55, Currency: "gems" }],
    RARE: [{ Amount: 90, Currency: "gems" }],
    EPIC: [{ Amount: 90, Currency: "gems" }]
  };
  const drops = {
    FREE: ["common", "gems1", "uncommon"],
    FREE_SPIN: ["common", "gems1", "uncommon"],
    COMMON: ["common", "gems1", "uncommon", "gems2"],
    RARE: ["rare", "gems2", "epic", "gems3"],
    EPIC: ["epic", "gems3", "legendary", "gems4"]
  };
  return {
    ID: id,
    Prices: prices[id] || [{ Amount: 90, Currency: "gems" }],
    Drops: drops[id] || ["rare", "gems2", "common"]
  };
}

function getLuckySpinRewards(shared) {
  const items =
    shared?.ShopDef?.LuckySpinWheelPurchasableItems ||
    shared?.Shop?.LuckySpinWheelPurchasableItems ||
    shared?.LuckySpinWheelPurchasableItems ||
    [];
  const wheel =
    items.find((i) => (i.name || i.Name) === "lucky_spin_wheel") || items[0];
  return (
    (wheel && (wheel.rewards || wheel.Rewards)) || [
      { chance: 40, type: "CURRENCY", typeInfo: "gems", min: 5 },
      { chance: 30, type: "CURRENCY", typeInfo: "gems", min: 10 },
      { chance: 20, type: "CURRENCY", typeInfo: "aec", min: 50 },
      { chance: 10, type: "SKIN", typeInfo: "RARE", min: 1 }
    ]
  );
}

const LobbyController = {
  async updateUsername(req, res) {
    const t0 = Date.now();
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const rawInput = pickRequestedUsername(req.body) ?? pickRequestedUsername(req.query);
      if (!rawInput || !String(rawInput).trim()) {
        const bodyKeys = req.body && typeof req.body === "object" ? Object.keys(req.body).join(",") : typeof req.body;
        console.warn("[LOBBY] username missing; content-type=", req.get("content-type"), "body-keys=", bodyKeys);
        logLobby("updateusername", false, "empty", Date.now() - t0);
        return res.status(409).json({ message: "nome non disponibile" });
      }

      let newNameRaw = String(rawInput).trim().replace(/\s{2,}/g, " ");
      if (newNameRaw.length < 3 || newNameRaw.length > 12) {
        logLobby("updateusername", false, `len=${newNameRaw.length}`, Date.now() - t0);
        return res.status(400).json({ message: "username must be 3-12 characters" });
      }
      if (/[<>{}\[\]()"'\`~#$%^&*=+\\\/|:;,?!]/.test(newNameRaw)) {
        return res.status(403).json({ message: "invalid characters" });
      }

      const gems = getBalanceAmount(user, "gems");
      const freeUsed = !!(user.userFlags && user.userFlags.hasUsedFreeNameChange);
      if (freeUsed && gems < 100) {
        logLobby("updateusername", false, `gems=${gems}`, Date.now() - t0);
        return res.status(402).json({ message: "insufficient gems", error: "INSUFFICIENT_GEMS" });
      }

      const { rebuildStyledUsername, getBaseUsername, UserModel: UM } = require("./services");
      const baseLower = getBaseUsername(newNameRaw).toLowerCase() || newNameRaw.toLowerCase();
      if (await UM.isBaseUsernameTaken(baseLower, user.id)) {
        logLobby("updateusername", false, `taken=${baseLower}`, Date.now() - t0);
        return res.status(409).json({ message: "username already taken", error: "USERNAME_TAKEN" });
      }

      const finalUsername = rebuildStyledUsername(user.username || "", newNameRaw);
      await UserModelRef.update(user.stumbleId, {
        username: finalUsername,
        usernameLower: baseLower,
        userProfile: {
          ...(user.userProfile || {}),
          userName: finalUsername
        },
        userFlags: {
          ...(user.userFlags || {}),
          hasUsedFreeNameChange: true
        }
      });
      if (freeUsed) await UserModelRef.removeBalance(user, "gems", 100);

      logLobby("updateusername", true, `${user.username} -> ${finalUsername}`, Date.now() - t0);
      return replyWithUser(res, user);
    } catch (err) {
      logLobby("updateusername", false, err.message, Date.now() - t0);
      console.error("[LOBBY] updateusername EXC", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  async updateCosmetics(req, res) {
    const t0 = Date.now();
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const body = req.body || {};
      const prev = user.equippedCosmetics || {};
      const equipped = {
        skin: String(pickBody(body, "Skin", "skin") || prev.skin || "SKIN1"),
        color: String(pickBody(body, "Color", "color") || prev.color || "COLOR1"),
        animation: String(pickBody(body, "Animation", "animation") || prev.animation || "animation1"),
        footsteps: String(
          pickBody(body, "Footsteps", "footsteps") || prev.footsteps || "footsteps_smoke"
        ),
        emote1: String(pickBody(body, "Emote1", "emote1") || prev.emote1 || "emote_cry"),
        emote2: String(pickBody(body, "Emote2", "emote2") || prev.emote2 || "emote_hi"),
        emote3: String(pickBody(body, "Emote3", "emote3") || prev.emote3 || "emote_gg"),
        emote4: String(pickBody(body, "Emote4", "emote4") || prev.emote4 || "emote_haha"),
        actionEmote1: pickActionEmote(body, prev.actionEmote1 ?? prev.ActionEmote1, "ActionEmote1", "actionEmote1"),
        actionEmote2: pickActionEmote(body, prev.actionEmote2 ?? prev.ActionEmote2, "ActionEmote2", "actionEmote2"),
        actionEmote3: pickActionEmote(body, prev.actionEmote3 ?? prev.ActionEmote3, "ActionEmote3", "actionEmote3"),
        actionEmote4: pickActionEmote(body, prev.actionEmote4 ?? prev.ActionEmote4, "ActionEmote4", "actionEmote4")
      };

      const ownedSkins = Array.isArray(user.skins) ? user.skins : [];
      if (equipped.skin && !ownedSkins.includes(equipped.skin)) {
        await UserModelRef.addSkin(user.stumbleId, equipped.skin);
      }

      const ownedEmotes = Array.isArray(user.emotes) ? user.emotes : [];
      for (const e of [equipped.emote1, equipped.emote2, equipped.emote3, equipped.emote4]) {
        if (e && !ownedEmotes.includes(e) && typeof UserModelRef.addEmote === "function") {
          await UserModelRef.addEmote(user.stumbleId, e);
          ownedEmotes.push(e);
        }
      }

      const ownedAction = Array.isArray(user.actionEmotes) ? user.actionEmotes : [];
      for (const ae of [
        equipped.actionEmote1,
        equipped.actionEmote2,
        equipped.actionEmote3,
        equipped.actionEmote4
      ]) {
        if (ae && !ownedAction.includes(ae)) {
          await UserModelRef.addActionEmote(user.stumbleId, ae);
          ownedAction.push(ae);
        }
      }

      const fresh = await UserModelRef.update(user.stumbleId, {
        equippedCosmetics: equipped,
        userProfile: {
          ...(user.userProfile || {}),
          skin: equipped.skin,
          color: equipped.color
        }
      });

      let jwt = "";
      try {
        jwt = await genJwt(fresh || { ...user, equippedCosmetics: equipped });
      } catch (jwtErr) {
        console.warn("[LOBBY] cosmetics jwt:", jwtErr && jwtErr.message);
      }

      const dto = formatEquippedCosmetics((fresh && fresh.equippedCosmetics) || equipped);
      logLobby(
        "cosmetics",
        true,
        `skin=${dto.Skin} e1=${dto.Emote1} e2=${dto.Emote2} ae1=${dto.ActionEmote1}`,
        Date.now() - t0
      );
      return res.status(200).json({
        EquippedCosmetics: dto,
        PhotonJwt: jwt
      });
    } catch (err) {
      logLobby("cosmetics", false, err.message, Date.now() - t0);
      console.error("[LOBBY] cosmetics EXC", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  async inventorySelection(req, res) {
    const t0 = Date.now();
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const category = String(pickBody(req.body, "Category", "category") || "Skin");
      const itemId = String(pickBody(req.body, "ItemId", "itemId", "ItemID", "id") || "");
      const cat = category.toLowerCase();
      const prev = user.equippedCosmetics || {};
      const eq = {
        skin: prev.skin || "SKIN1",
        color: prev.color || "COLOR1",
        animation: prev.animation || "animation1",
        footsteps: prev.footsteps || "footsteps_smoke",
        emote1: prev.emote1 || "emote_cry",
        emote2: prev.emote2 || "emote_hi",
        emote3: prev.emote3 || "emote_gg",
        emote4: prev.emote4 || "emote_haha",
        actionEmote1: normalizeActionEmote(prev.actionEmote1),
        actionEmote2: normalizeActionEmote(prev.actionEmote2),
        actionEmote3: normalizeActionEmote(prev.actionEmote3),
        actionEmote4: normalizeActionEmote(prev.actionEmote4)
      };
      const updates = {};

      if (itemId) {
        if (cat === "skin") {
          eq.skin = itemId;
          const skins = Array.isArray(user.skins) ? [...user.skins] : ["SKIN1"];
          if (!skins.includes(itemId)) {
            skins.push(itemId);
            await UserModelRef.addSkin(user.stumbleId, itemId);
          }
          updates.skins = skins;
          updates.userProfile = { ...(user.userProfile || {}), skin: itemId, color: eq.color };
        } else if (cat === "color") {
          eq.color = itemId;
          updates.userProfile = { ...(user.userProfile || {}), skin: eq.skin, color: itemId };
        } else if (cat === "animation") {
          eq.animation = itemId;
        } else if (cat === "footsteps" || cat === "footstep") {
          eq.footsteps = itemId;
        } else if (cat === "emote" || cat === "emotes") {
          const slot = Number(pickBody(req.body, "Slot", "slot") || 1);
          const key = `emote${Math.min(4, Math.max(1, slot || 1))}`;
          eq[key] = itemId;
          const emotes = Array.isArray(user.emotes) ? [...user.emotes] : [];
          if (!emotes.includes(itemId)) emotes.push(itemId);
          updates.emotes = emotes;
        } else if (cat === "actionemote" || cat === "action_emote" || cat === "actionemotes") {
          const slot = Number(pickBody(req.body, "Slot", "slot") || 1);
          const key = `actionEmote${Math.min(4, Math.max(1, slot || 1))}`;
          eq[key] = normalizeActionEmote(itemId);
          if (eq[key]) {
            const actionEmotes = Array.isArray(user.actionEmotes) ? [...user.actionEmotes] : [];
            if (!actionEmotes.includes(eq[key])) actionEmotes.push(eq[key]);
            updates.actionEmotes = actionEmotes;
          }
        }
        updates.equippedCosmetics = eq;
        await UserModelRef.update(user.stumbleId, updates);
      }

      logLobby("inventory/selection", true, `${category}=${itemId}`, Date.now() - t0);
      return replyWithUser(res, user);
    } catch (err) {
      logLobby("inventory/selection", false, err.message, Date.now() - t0);
      return res.status(200).json({ ok: true });
    }
  },

  async purchaseBattlePassTier(req, res) {
    const t0 = Date.now();
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const levels =
        Number(req.query.levelsToUpgrade ?? req.body?.levelsToUpgrade ?? req.body?.LevelsToUpgrade ?? 1) || 1;
      const xpPerLevel = 1000;
      const gemCostPerLevel = 50;
      const cost = Math.max(1, levels) * gemCostPerLevel;
      const gems = getBalanceAmount(user, "gems");
      if (gems < cost) {
        logLobby("bp/purchasetier", false, `gems=${gems} need=${cost}`, Date.now() - t0);
        return res.status(402).json({ message: "insufficient gems", error: "INSUFFICIENT_GEMS" });
      }

      const bp = { ...(user.battlePass || {}) };
      const oldXp = Number(bp.experience || 0);
      bp.oldExperience = oldXp;
      bp.experience = oldXp + levels * xpPerLevel;
      bp.passTokens = Number(bp.passTokens || 0) + levels * xpPerLevel;

      await UserModelRef.removeBalance(user, "gems", cost);
      await UserModelRef.update(user.stumbleId, {
        battlePass: bp,
        passTokens: bp.passTokens,
        hasBattlePass: !!(bp.hasPurchased || user.hasBattlePass)
      });

      logLobby("bp/purchasetier", true, `levels=${levels} cost=${cost} xp=${bp.experience}`, Date.now() - t0);
      return replyWithUser(res, user);
    } catch (err) {
      logLobby("bp/purchasetier", false, err.message, Date.now() - t0);
      console.error("[LOBBY] bp/purchasetier EXC", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  async purchaseBattlePass(req, res) {
    const t0 = Date.now();
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      const cost = 900;
      await ensureBalance(user, "gems", cost);
      const gems = getBalanceAmount(user, "gems");
      if (gems < cost) {
        logLobby("bp/purchase", false, `gems=${gems}`, Date.now() - t0);
        return res.status(402).json({ message: "insufficient gems", error: "INSUFFICIENT_GEMS" });
      }
      const bp = {
        ...(user.battlePass || {}),
        hasPurchased: true,
        experience: Math.max(Number(user.battlePass?.experience || 0), 100000),
        passTokens: Math.max(Number(user.battlePass?.passTokens || 0), 100000),
        oldExperience: Number(user.battlePass?.experience || 0)
      };
      await UserModelRef.removeBalance(user, "gems", cost);
      await UserModelRef.update(user.stumbleId, {
        battlePass: bp,
        hasBattlePass: true,
        passTokens: bp.passTokens
      });
      logLobby("bp/purchase", true, `cost=${cost} xp=${bp.experience}`, Date.now() - t0);
      return replyWithUser(res, user);
    } catch (err) {
      logLobby("bp/purchase", false, err.message, Date.now() - t0);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  async claimBattlePass(req, res) {
    const t0 = Date.now();
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const body = req.body || {};
      const q = req.query || {};
      const isPremiumRaw = pickBody(body, "IsPremium", "isPremium") ?? q.IsPremium ?? q.isPremium;
      const isPremium = isPremiumRaw === true || isPremiumRaw === "true" || isPremiumRaw === 1 || isPremiumRaw === "1";
      const tierIndex = Number(
        pickBody(body, "TierIndex", "tierIndex", "Index", "index") ?? q.TierIndex ?? q.tierIndex ?? 0
      );
      const page = Number(pickBody(body, "Page", "page") ?? q.Page ?? 0);
      const section = Number(pickBody(body, "Section", "section") ?? q.Section ?? 0);
      const slot = Number(pickBody(body, "Slot", "slot") ?? q.Slot ?? tierIndex);

      const bp = { ...(user.battlePass || {}) };
      bp.freePassRewards = Array.isArray(bp.freePassRewards) ? [...bp.freePassRewards] : [];
      bp.premiumPassRewards = Array.isArray(bp.premiumPassRewards)
        ? [...bp.premiumPassRewards]
        : [];
      bp.slotsClaimed = Array.isArray(bp.slotsClaimed) ? [...bp.slotsClaimed] : [];

      if (isPremium && !bp.hasPurchased && !user.hasBattlePass) {
        bp.hasPurchased = true;
      }

      const slotKey = `${page}:${section}:${slot}:${isPremium ? "P" : "F"}`;
      if (!bp.slotsClaimed.includes(slotKey)) bp.slotsClaimed.push(slotKey);

      const claimIdx = Number.isFinite(tierIndex) ? tierIndex : slot;
      if (isPremium) {
        if (!bp.premiumPassRewards.includes(claimIdx)) bp.premiumPassRewards.push(claimIdx);
        if (!bp.premiumPassRewards.includes(slot) && slot !== claimIdx) {
          bp.premiumPassRewards.push(slot);
        }
      } else {
        if (!bp.freePassRewards.includes(claimIdx)) bp.freePassRewards.push(claimIdx);
        if (!bp.freePassRewards.includes(slot) && slot !== claimIdx) {
          bp.freePassRewards.push(slot);
        }
      }

      const minXp = Math.max((claimIdx + 1) * 1000, (slot + 1) * 1000, 1000);
      if (Number(bp.experience || 0) < minXp) {
        bp.oldExperience = Number(bp.experience || 0);
        bp.experience = minXp;
        bp.passTokens = Math.max(Number(bp.passTokens || 0), minXp);
      }

      const shared = getShared();
      const passId = getActiveBattlePassId(shared, bp);
      bp.passID = passId;

      const rawRewards =
        resolveBattlePassSlotRewards(shared, {
          passId,
          page,
          section,
          slot,
          tierIndex: claimIdx,
          isPremium
        }) || [];

      await UserModelRef.update(user.stumbleId, {
        battlePass: bp,
        freePassRewards: bp.freePassRewards,
        premiumPassRewards: bp.premiumPassRewards,
        passTokens: bp.passTokens,
        hasBattlePass: !!(bp.hasPurchased || user.hasBattlePass)
      });

      const granted = [];
      if (rawRewards.length > 0) {
        for (const rr of rawRewards) {
          granted.push(await grantBackendReward(user, rr));
        }
      } else {
        granted.push(
          await grantBackendReward(user, { type: "CURRENCY", typeInfo: "gems", amount: 25 })
        );
      }

      logLobby(
        "bp/claim",
        true,
        `premium=${isPremium} tier=${claimIdx} page=${page}/${section}/${slot} pass=${passId} rewards=${granted.map((g) => g.Type + ":" + g.TypeInfo).join(",")}`,
        Date.now() - t0
      );
      return replyWithUser(res, user, { Rewards: granted });
    } catch (err) {
      logLobby("bp/claim", false, err.message, Date.now() - t0);
      console.error("[LOBBY] bp/claim EXC", err);
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  async purchaseLuckySpin(req, res) {
    const t0 = Date.now();
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const isFreeQuery =
        String(req.query.free || "").toLowerCase() === "true" ||
        String(req.query.Free || "").toLowerCase() === "true";

      let freeSpins = getBalanceAmount(user, "default_free_spins");
      let adSpins = getBalanceAmount(user, "default_free_ad_spins");
      if (freeSpins <= 0 && (isFreeQuery || true)) {
        await ensureBalance(user, "default_free_spins", 1);
        freeSpins = getBalanceAmount(user, "default_free_spins");
      }

      let spinCurrency = null;
      let paidWithGems = false;
      if (freeSpins > 0) spinCurrency = "default_free_spins";
      else if (adSpins > 0) spinCurrency = "default_free_ad_spins";

      if (!spinCurrency) {
        const gems = getBalanceAmount(user, "gems");
        if (gems >= 50) {
          await UserModelRef.removeBalance(user, "gems", 50);
          paidWithGems = true;
          spinCurrency = "gems";
        } else {
          await ensureBalance(user, "default_free_spins", 1);
          await UserModelRef.removeBalance(user, "default_free_spins", 1);
          spinCurrency = "default_free_spins";
        }
      } else if (spinCurrency !== "gems") {
        await UserModelRef.removeBalance(user, spinCurrency, 1);
      }

      const shared = getShared();
      const rewardsPool = getLuckySpinRewards(shared);
      const selected = pickWeighted(rewardsPool) || rewardsPool[0];
      const granted = [
        await grantBackendReward(user, {
          type: selected.type || selected.Type,
          typeInfo: selected.typeInfo || selected.TypeInfo,
          amount: selected.min || selected.Min || selected.amount || selected.Amount || 1
        })
      ];

      logLobby(
        "luckyspin",
        true,
        `pay=${spinCurrency}${paidWithGems ? "(gems)" : ""} freeQ=${isFreeQuery} reward=${granted[0].Type}:${granted[0].TypeInfo}`,
        Date.now() - t0
      );
      return replyWithUser(res, user, { Rewards: granted });
    } catch (err) {
      logLobby("luckyspin", false, err.message, Date.now() - t0);
      console.error("[LOBBY] luckyspin EXC", err);
      try {
        const user = req.user;
        if (user) {
          const granted = [await grantBackendReward(user, { type: "CURRENCY", typeInfo: "gems", amount: 5 })];
          return replyWithUser(res, user, { Rewards: granted });
        }
      } catch {}
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  async purchaseDrop(req, res) {
    const t0 = Date.now();
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const itemId = req.params.itemId || req.params[0] || "RARE";
      const count = Math.max(1, Math.min(10, Number(req.params.count || 1) || 1));
      const free = String(req.query.free || "").toLowerCase() === "true";

      const shared = getShared();
      let purchase = resolveDropPurchase(itemId, shared);
      if (!purchase) {
        purchase = defaultDropPurchase(itemId);
        logLobby("purchasedrop", true, `fallback id=${itemId}`, 0);
      }

      const price = (purchase.Prices || purchase.prices || [])[0];
      const priceAmount = Number(price?.Amount ?? price?.amount ?? 90) * count;
      const priceCurrency = resolveBalanceName(price?.Currency || price?.currency || "gems");

      if (!free && priceAmount > 0 && priceCurrency !== "skin_purchase") {
        await ensureBalance(user, priceCurrency, priceAmount);
        const bal = getBalanceAmount(user, priceCurrency);
        if (bal < priceAmount) {
          logLobby("purchasedrop", false, `${priceCurrency}=${bal} need=${priceAmount}`, Date.now() - t0);
          return res.status(402).json({
            ErrorCode: 4,
            StatusCode: 402,
            Message: "INSUFFICIENT_FUNDS",
            error: "INSUFFICIENT_FUNDS"
          });
        }
        await UserModelRef.removeBalance(user, priceCurrency, priceAmount);
      }

      const dropPool =
        purchase.Drops_v2 ||
        purchase.drops_v2 ||
        purchase.Drops ||
        purchase.drops ||
        ["common", "rare", "uncommon"];
      const granted = [];
      for (let i = 0; i < count; i++) {
        const rawDrop = dropPool[Math.floor(Math.random() * dropPool.length)];
        let dropId = rawDrop;
        if (typeof rawDrop === "number") {
          const map = { 1: "common", 2: "uncommon", 3: "rare", 4: "epic", 5: "legendary" };
          dropId = map[rawDrop] || "rare";
        } else if (/^(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|SPECIAL)$/i.test(String(rawDrop))) {
          granted.push(
            await grantBackendReward(user, {
              type: "SKIN",
              typeInfo: String(rawDrop).toUpperCase(),
              amount: 1
            })
          );
          continue;
        }

        const def = resolveDropDef(dropId, shared);
        const rawRewards = def?.rewards || def?.Rewards || [
          { type: "CURRENCY", typeInfo: "gems", amount: 10 }
        ];
        for (const rr of rawRewards) {
          granted.push(await grantBackendReward(user, rr));
        }
      }

      if (granted.length === 0) {
        granted.push(await grantBackendReward(user, { type: "CURRENCY", typeInfo: "gems", amount: 10 }));
      }

      logLobby(
        "purchasedrop",
        true,
        `id=${itemId} count=${count} free=${free} rewards=${granted.length}`,
        Date.now() - t0
      );
      return replyWithUser(res, user, { Rewards: granted });
    } catch (err) {
      logLobby("purchasedrop", false, err.message, Date.now() - t0);
      console.error("[LOBBY] purchasedrop EXC", err);
      try {
        const user = req.user;
        if (user) {
          const granted = [await grantBackendReward(user, { type: "CURRENCY", typeInfo: "gems", amount: 10 })];
          return replyWithUser(res, user, { Rewards: granted });
        }
      } catch {}
      return res.status(500).json({ message: "Internal server error" });
    }
  },

  async customMapsBundlesClient(req, res) {
    const t0 = Date.now();
    logLobby("ugc/bundles/client", true, "empty", Date.now() - t0);
    return res.status(200).json({ Bundles: [], BundleHash: "" });
  },

  async customMapsList(req, res) {
    logLobby("ugc/list", true, req.path, 0);
    return res.status(200).json({ Maps: [], AuthorProfiles: {}, LevelArt: {}, Sections: [] });
  },

  async customMapsCode(req, res) {
    const t0 = Date.now();
    const code = req.params.code || req.params[0];
    logLobby("ugc/code", false, `code=${code} not hosted`, Date.now() - t0);
    return res.status(404).json({
      message: "MAP_NOT_FOUND",
      Author: { Username: "Priz", UserId: 0, ProfileFlags: 0 },
      MapData: null
    });
  },

  async customMapsBundleById(req, res) {
    const id = req.params.bundleId || req.params[0];
    logLobby("ugc/bundle", false, `id=${id}`, 0);
    return res.status(404).json({ message: "BUNDLE_NOT_FOUND", BundleId: id });
  },

  async offersPurchased(req, res) {
    logLobby("offers/purchasedV2", true, "empty-dict", 0);
    return res.status(200).json({});
  }
};

function mountLobbyRoutes(app) {
  app.post("/user/update", LobbyController.updateUsername);
  app.post("/user/update/", LobbyController.updateUsername);
  app.post("/user/updateusername", LobbyController.updateUsername);
  app.post("/user/updateusername/", LobbyController.updateUsername);

  app.all("/user-equipped-cosmetics/update", LobbyController.updateCosmetics);
  app.all("/user-equipped-cosmetics/update/", LobbyController.updateCosmetics);
  app.all("/user/cosmetics/setequipped", LobbyController.updateCosmetics);
  app.all("/user/cosmetics/setequipped/", LobbyController.updateCosmetics);
  app.all("/user/inventory/selection", LobbyController.inventorySelection);
  app.all("/user/inventory/selection/", LobbyController.inventorySelection);

  app.all("/battlepass/purchase", LobbyController.purchaseBattlePass);
  app.all("/battlepass/purchasev2", LobbyController.purchaseBattlePass);
  app.all("/battlepass/purchasetier", LobbyController.purchaseBattlePassTier);
  app.all("/battlepass/purchasetierv2", LobbyController.purchaseBattlePassTier);
  app.all("/battlepass/purchasetierv3", LobbyController.purchaseBattlePassTier);
  app.all("/battlepass/claimv3", LobbyController.claimBattlePass);
  app.all("/battlepass/claimv2", LobbyController.claimBattlePass);
  app.all("/battlepass/claim", LobbyController.claimBattlePass);

  app.all("/economy/purchaseluckyspinwheel", LobbyController.purchaseLuckySpin);
  app.all("/economy/purchaseluckyspinwheel/", LobbyController.purchaseLuckySpin);
  app.all("/economy/purchaseluckyspin", LobbyController.purchaseLuckySpin);
  app.all("/economy/purchaseluckyspin/", LobbyController.purchaseLuckySpin);

  app.all("/economy/purchasedrop/:itemId/:count", LobbyController.purchaseDrop);
  app.all("/economy/purchasedrop/:itemId/:count/", LobbyController.purchaseDrop);
  app.all("/economy/purchasedrop/:itemId", LobbyController.purchaseDrop);

  app.all("/economy/offers/purchasedV2", LobbyController.offersPurchased);
  app.all("/economy/offers/purchasedV2/", LobbyController.offersPurchased);

  app.all("/user/refresheconomy", async (req, res) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;
      return replyWithUser(res, user);
    } catch (err) {
      return res.status(200).json({ ok: true });
    }
  });

  app.all("/news/getall", (req, res) => res.status(200).json([]));

  app.all("/custom-maps/bundles/client", LobbyController.customMapsBundlesClient);
  app.all("/custom-maps/bundles/client/", LobbyController.customMapsBundlesClient);
  app.get("/custom-maps/featured", LobbyController.customMapsList);
  app.get("/custom-maps/favorites", LobbyController.customMapsList);
  app.get("/custom-maps/recently-played", LobbyController.customMapsList);
  app.get("/custom-maps/my", LobbyController.customMapsList);
  app.get("/custom-maps/my/", LobbyController.customMapsList);
  app.get("/custom-maps/code/:code", LobbyController.customMapsCode);
  app.get("/custom-maps/bundles/:bundleId", LobbyController.customMapsBundleById);

  console.log("[LOBBY] routes montate (username, cosmetics, bp claim/tier, luckyspin, purchasedrop, ugc)");
}

module.exports = { mountLobbyRoutes, LobbyController, formatEquippedCosmetics, resolveBalanceName };
