

const BackendUtilsModule = require("./services");
const UserModelRef = BackendUtilsModule.UserModel;
const genJwt = BackendUtilsModule.generatePhotonJwt;

function logClassic(action, ok, detail) {
  console.log(`[TOUR] ${action} ${ok ? "OK" : "FAIL"} ${detail || ""}`);
}

async function resolveUser(req) {
  if (req.user) return req.user;
  const deviceId = req.headers?.deviceid || req.body?.DeviceId || req.body?.deviceId || "";
  const stumbleId = req.headers?.stumbleid || req.body?.StumbleId || req.body?.stumbleId || "";
  if (stumbleId) return UserModelRef.findByStumbleId(String(stumbleId));
  if (deviceId) return UserModelRef.findByDeviceId(String(deviceId));
  return null;
}

const partyCodes = new Map();

const ClassicTournamentController = {
  async getList(req, res) {
    logClassic("getList", true, "empty");
    return res.status(200).json({ tournaments: [], Tournaments: [], list: [] });
  },

  async getData(req, res) {
    const id = req.body?.tournamentId || req.body?.TournamentId || req.query?.id || "";
    logClassic("getData", true, `id=${id}`);
    return res.status(200).json({
      tournament: null,
      Tournament: null,
      id,
      matches: [],
      scores: []
    });
  },

  async getMatches(req, res) {
    logClassic("getMatches", true, "");
    return res.status(200).json({ matches: [], Matches: [] });
  },

  async getMatchesByIds(req, res) {
    logClassic("getMatchesByIds", true, "");
    return res.status(200).json({ matches: [], Matches: [] });
  },

  async getScores(req, res) {
    logClassic("getScores", true, "");
    return res.status(200).json({ scores: [], Scores: [] });
  },

  async matchGetGameSessions(req, res) {
    logClassic("matchSessions", true, "");
    return res.status(200).json({ sessions: [], GameSessions: [] });
  },

  async signup(req, res) {
    const user = await resolveUser(req);
    logClassic("signup", true, user?.username || "");
    return res.status(200).json({
      ok: true,
      success: true,
      registered: true,
      UserId: user?.id ?? user?.Id ?? 0
    });
  },

  async partyCreateCode(req, res) {
    const user = await resolveUser(req);
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    partyCodes.set(code, {
      owner: user?.stumbleId || "",
      members: user ? [user.stumbleId] : [],
      createdAt: Date.now()
    });
    logClassic("partyCreateCode", true, code);
    return res.status(200).json({ code, Code: code, partyCode: code });
  },

  async partyJoinByCode(req, res) {
    const code = String(req.body?.code || req.body?.Code || "").toUpperCase();
    const user = await resolveUser(req);
    const party = partyCodes.get(code);
    if (party && user?.stumbleId && !party.members.includes(user.stumbleId)) {
      party.members.push(user.stumbleId);
    }
    logClassic("partyJoinByCode", !!party, code);
    return res.status(200).json({
      ok: !!party,
      code,
      members: party?.members || []
    });
  },

  async partyAcceptInvite(req, res) {
    logClassic("partyAcceptInvite", true, "");
    return res.status(200).json({ ok: true });
  },

  async partyRemoveUser(req, res) {
    logClassic("partyRemoveUser", true, "");
    return res.status(200).json({ ok: true });
  },

  async partyCreateInvite(req, res) {
    const code = Math.random().toString(36).slice(2, 10).toUpperCase();
    logClassic("partyCreateInvite", true, code);
    return res.status(200).json({ inviteCode: code, InviteCode: code, code });
  },

  async processInvite(req, res) {
    logClassic("processInvite", true, "");
    return res.status(200).json({ ok: true, accepted: true });
  },

  async activeTournaments(req, res) {

    logClassic("activeTournaments", true, "");
    return res.status(200).json([]);
  },

  async loginExternal(req, res, next) {
    try {
      const deviceId =
        req.body?.DeviceId || req.body?.deviceId || req.headers?.deviceid || "";
      let user = null;
      if (deviceId) user = await UserModelRef.findByDeviceId(String(deviceId));
      if (!user && req.user) user = req.user;
      if (!user) {
        return res.status(401).json({ message: "unauthorized" });
      }
      const jwt = await genJwt(user);
      const { formatLoginResponse } = BackendUtilsModule;
      logClassic("loginExternal", true, user.username);
      return res.status(200).json(formatLoginResponse(user, jwt));
    } catch (err) {
      logClassic("loginExternal", false, err.message);
      if (typeof next === "function") return next(err);
      return res.status(500).json({ message: "internal_error" });
    }
  }
};

function mountClassicTournamentRoutes(app) {
  const c = ClassicTournamentController;
  const v1 = [
    ["tournamentGetMatches", c.getMatches],
    ["tournamentGetMatchesByIds", c.getMatchesByIds],
    ["tournamentGetScores", c.getScores],
    ["tournamentMatchGetGameSessions", c.matchGetGameSessions],
    ["tournamentPartyAcceptInvite", c.partyAcceptInvite],
    ["tournamentPartyCreateCode", c.partyCreateCode],
    ["tournamentPartyJoinByCode", c.partyJoinByCode],
    ["tournamentPartyRemoveUser", c.partyRemoveUser],
    ["tournamentProcessInvite", c.processInvite],
    ["tournamentSignup", c.signup]
  ];
  for (const [name, handler] of v1) {
    app.all(`/api/v1/${name}`, handler);
    app.all(`/api/v1/${name}/`, handler);
  }
  app.all("/api/v2/tournamentGetData", c.getData);
  app.all("/api/v2/tournamentGetData/", c.getData);
  app.all("/api/v2/tournamentGetList", c.getList);
  app.all("/api/v2/tournamentGetList/", c.getList);
  app.all("/api/v2/tournamentPartyCreateInvite", c.partyCreateInvite);
  app.all("/api/v2/tournamentPartyCreateInvite/", c.partyCreateInvite);

  console.log("[TOUR] classic Photon tournament stubs montati (api/v1 + api/v2)");
}

module.exports = { mountClassicTournamentRoutes, ClassicTournamentController };
