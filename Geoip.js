"use strict";

const geoip = require("geoip-lite");
const net = require("net");

const REGION_BY_CONTINENT = {
  EU: "eu",
  NA: "na",
  SA: "sa",
  AS: "as",
  AF: "af",
  OC: "oc",
  AN: "oc"
};

function countryFromLocale(locale) {
  if (!locale) return null;

  const first = String(locale).split(",")[0].trim().replace("_", "-");
  const parts = first.split("-");
  if (parts.length >= 2) {
    const cc = parts[1].trim();
    if (/^[A-Za-z]{2}$/.test(cc)) return cc.toUpperCase();
  }
  return null;
}

function stripIpv6Prefix(ip) {
  if (!ip) return "";
  let out = String(ip).trim();
  if (out.startsWith("::ffff:")) out = out.slice(7);
  return out;
}

function stripPortIfPresent(ip) {
  if (!ip) return "";
  let out = String(ip).trim();

  if (out.startsWith("[") && out.includes("]")) {
    return out.slice(1, out.indexOf("]"));
  }

  if (out.includes(":") && net.isIP(out) === 0) {
    const maybe = out.split(":")[0];
    if (net.isIP(maybe) === 4) return maybe;
  }

  return out;
}

function isPrivateIp(ip) {
  if (!ip) return true;

  const v = net.isIP(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }

  if (v !== 4) return true;

  const parts = ip.split(".").map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true;

  const [a, b] = parts;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;

  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

function getClientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  const real = req.headers["x-real-ip"];
  const xff = req.headers["x-forwarded-for"];

  let ip =
    (cf && String(cf).trim()) ||
    (real && String(real).trim()) ||
    (xff && String(xff).split(",")[0].trim()) ||
    (req.ip && String(req.ip).trim()) ||
    (req.socket && req.socket.remoteAddress) ||
    "";

  ip = stripIpv6Prefix(ip);
  ip = stripPortIfPresent(ip);

  return ip;
}

function lookup(req) {
  const ip = getClientIp(req);

  if (ip && !isPrivateIp(ip)) {
    const g = geoip.lookup(ip);
    if (g && g.country) {
      const country = String(g.country).toUpperCase();
      const region = REGION_BY_CONTINENT[g.continent] || country.toLowerCase();
      return { ip, country, region, source: "geoip-lite" };
    }
  }

  const loc =
    req.headers["accept-language"] ||
    req.headers["x-locale"] ||
    (req.body && (req.body.Locale || req.body.locale)) ||
    "";

  const fromLocale = countryFromLocale(loc);
  if (fromLocale) {
    return { ip, country: fromLocale, region: fromLocale.toLowerCase(), source: "locale" };
  }

  const fallbackCountry = String(process.env.GEO_FALLBACK_COUNTRY || "UN").toUpperCase();
  const fallbackRegion = String(process.env.GEO_FALLBACK_REGION || fallbackCountry).toLowerCase();

  return { ip, country: fallbackCountry, region: fallbackRegion, source: "fallback" };
}

module.exports = {
  lookup
};
