/**
 * Safe stubs for endpoints the private backend may not implement.
 * Round finish routes return reward-shaped payloads so REWARDS_VIEW can claim.
 */

function emptyArr(req, res) {
  res.status(200).json([]);
}

function mountSafeStubs(app) {
  app.all(["/party/invite", "/party/invite/"], (req, res) =>
    res.status(200).json({ ok: true, inviteId: "", InviteId: "" })
  );
  app.all(["/party/cancel", "/party/cancel/"], (req, res) =>
    res.status(200).json({ ok: true })
  );

  app.all(["/me/rewards", "/me/rewards/"], (req, res) =>
    res.status(200).json({ Rewards: [], rewards: [] })
  );
  app.all(["/me/permissions", "/me/permissions/"], (req, res) =>
    res.status(200).json({ Permissions: [], permissions: [] })
  );
  app.all(["/rewards/claim/v2", "/rewards/claim/v2/"], (req, res) =>
    res.status(200).json({ Rewards: [], ok: true })
  );

  app.all(["/round/check", "/round/check/"], (req, res) =>
    res.status(200).json({ ok: true, valid: true })
  );

  // Round finish routes live on index.js (RoundController) — do not stub them here.

  app.all(["/social/native-user-profiles", "/social/native-user-profiles/"], emptyArr);
  app.all(["/friends/block", "/friends/block/"], (req, res) =>
    res.status(200).json({ ok: true })
  );

  app.all(["/game-events/joinv2", "/game-events/joinv2/"], (req, res) =>
    res.status(200).json({ ok: true, joined: true })
  );

  app.all(["/leaderboards", "/leaderboards/", "/leaderboards/me", "/leaderboards/me/"], (req, res) =>
    res.status(200).json({ Entries: [], entries: [], Leaderboards: [] })
  );

  app.all(["/usersettings/photonregion", "/usersettings/photonregion/"], (req, res) =>
    res.status(200).json({ region: "eu", Region: "eu", PhotonRegion: "eu" })
  );

  app.all(
    ["/economy/purchase/endofmatchreward", "/economy/purchase/endofmatchreward/"],
    (req, res) => res.status(200).json({ Rewards: [] })
  );
  app.all(["/economy/purchasev2/initialize", "/economy/purchasev2/initialize/"], (req, res) =>
    res.status(200).json({ ok: true, TransactionId: "" })
  );
  app.all(["/economy/purchasev2/finalize", "/economy/purchasev2/finalize/"], (req, res) =>
    res.status(200).json({ ok: true, Rewards: [] })
  );
  app.all(["/missions/buy", "/missions/buy/"], (req, res) =>
    res.status(200).json({ ok: true })
  );

  app.all(["/user/news", "/user/news/"], emptyArr);
  app.all(["/user/linksocial", "/user/linksocial/"], (req, res) =>
    res.status(200).json({ ok: true })
  );

  console.log("[STUBS] SafeStubs mounted (party, rewards, round finish, leaderboards, economy)");
}

module.exports = { mountSafeStubs };
