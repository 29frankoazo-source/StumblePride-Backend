const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

class CryptoUtils {
  static LeagueSalt = process.env.LeagueXSalt;
  static LoginSalt = process.env.LoginSalt;
  static Salt = process.env.Salt;
  static async WriteJson(Patch, Json) {
    return await fs.writeFileSync(
      `${Patch}.json`,
      JSON.stringify(Json, null, 2)
    );
  }
  static LeagueEncrypt(text) {
  if (typeof text !== "string") {
    text = JSON.stringify({ error: "mensagem invÃ¡lida para encriptaÃ§Ã£o" });
  }

  const key = crypto
    .createHash("sha256")
    .update(this.LeagueSalt || "")
    .digest()
    .slice(0, 16);
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return cipher.update(text, "utf-8", "base64") + cipher.final("base64");
}
  static LeagueDecrypt(encryptedString) {
  if (typeof encryptedString !== "string") {
    throw new Error("Dados invÃ¡lidos para descriptografar");
  }

  const key = crypto
    .createHash("sha256")
    .update(this.LeagueSalt || "")
    .digest()
    .slice(0, 16);
  const iv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  return (
    decipher.update(encryptedString, "base64", "utf-8") +
    decipher.final("utf-8")
  );
}

  static Encrypt(text) {
    const key = crypto
      .createHash("sha256")
      .update(this.Salt || "")
      .digest()
      .slice(0, 16);
    const iv = Buffer.alloc(16, 0);
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    let encrypted = cipher.update(String(text), "utf8", "base64");
    encrypted += cipher.final("base64");
    return encrypted;
  }

  static Decrypt(encryptedString) {
    const key = crypto
      .createHash("sha256")
      .update(this.Salt || "")
      .digest()
      .slice(0, 16);
    const iv = Buffer.alloc(16, 0);
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    let decrypted = decipher.update(encryptedString, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  static Hash(type, input) {
  if (!input || typeof input !== "string") {
    throw new Error("Input invÃ¡lido para gerar hash");
  }
  return crypto.createHash(type).update(input).digest("hex");
}
  static CreateJWT(Payload, Secret) {
    const options = {
      algorithm: "HS256",
    };
    return jwt.sign(Payload, Secret, options);
  }
  static gerarAverageMmr() {
    const min = 0xd00000;
    const max = 0xdfffff;
    const mmr = Math.floor(Math.random() * (max - min + 1)) + min;
    return mmr.toString(16).toUpperCase();
  }
  static createJWTV2(payload, signature) {
    const header = {
      alg: "HS256",
      typ: "JWT",
    };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
      "base64url"
    );
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      "base64url"
    );

    const signatureKey = signature.split(":")[1];
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const crypto = require("crypto");
    const signatureHash = crypto
      .createHmac("sha1", signatureKey)
      .update(signingInput)
      .digest("base64url");

    return `${encodedHeader}.${encodedPayload}.${signatureHash}`;
  }
  static DecodeJWT(Encoded) {
    const decoded = jwt.decode(Encoded, {
      complete: true,
    });
    return JSON.parse(JSON.stringify(decoded.payload));
  }
  static CreateLoginHash(DeviceId, Version, Timestamp, StumbleId, SteamTicket, ScopelyId) {
  if (!DeviceId || !Version || !Timestamp || !StumbleId || !SteamTicket || !ScopelyId) {
    throw new Error("ParÃ¢metros invÃ¡lidos para CreateLoginHash");
  }

  const text =
    this.LoginSalt + DeviceId + Version + SteamTicket + Timestamp + StumbleId + ScopelyId;

  return this.Hash("sha1", text);
}
  static CreateRegularHash(deviceId, googleid, token, timestamp, stumbleid, url, body = "") {
  if (!deviceId || !googleid || !token || !timestamp || !stumbleid || !url) {
    throw new Error("ParÃ¢metros ausentes em CreateRegularHash");
  }

  const text =
    this.Salt +
    deviceId +
    googleid +
    token +
    timestamp +
    url +
    body +
    stumbleid;

  return this.Hash("sha1", text);
}
  static VerifyHash(Auth, url, body = "") {
  try {
    Auth = JSON.parse(Auth);
    const { DeviceId, GoogleId, Token, Timestamp, StumbleId, Hash: hash } = Auth;

    if (!DeviceId || !GoogleId || !Token || !Timestamp || !StumbleId || !hash) {
      return false;
    }

    const text =
      this.Salt + DeviceId + GoogleId + Token + Timestamp + url + body + StumbleId;

    return hash === this.Hash("sha1", text);
  } catch {
    return false;
  }
}
  static CreateParms(type) {
    const generateRandomId = () => {
      return uuidv4();
    };
    const MainParms = generateRandomId();
    if (type === "event") {
      const EventParms = generateRandomId();
      return EventParms;
    }
    return MainParms;
  }
  static CreateParmsV2(type) {
    const genText = () =>
      Buffer.from(
        Array.from({ length: 34 }, () => Math.random().toString(34)[2]).join("")
      ).toString("base64");

    return type === "event" ? genText() : genText();
  }
  static CreateGameId(type) {
    const generateRandomId = () => {
      return uuidv4();
    };
    const mainId = generateRandomId();
    if (type === "event") {
      const eventId = generateRandomId();
      return eventId;
    }
    return mainId;
  }
  static SessionToken() {
    const buffer = crypto.randomBytes(16);
    return buffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  static GenCaracters(amount) {
    const caracteresPossiveis =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const caracteresSet = new Set();
    while (caracteresSet.size < amount) {
      const indice = crypto.randomInt(caracteresPossiveis.length);
      caracteresSet.add(caracteresPossiveis[indice]);
    }
    return Array.from(caracteresSet).join("");
  }
  static GenAndroidId() {
    return uuidv4().replace(/-/g, "");
  }
  static GenWebGlId() {
    return "webgl_" + this.GenAndroidId();
  }
  static GenIosId() {
    return uuidv4().toUpperCase();
  }
  static formatNumber(number) {
    if (typeof number !== "number") return "undefined";
    return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
}

module.exports = CryptoUtils;
