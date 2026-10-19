require("dotenv").config();

function resolveMongoUri() {
  const candidates = [
    process.env.mongoUri,
    process.env.MONGO_URI,
    process.env.MONGODB_URI,
    process.env.MONGO_URL
  ];
  for (const uri of candidates) {
    const trimmed = (uri || "").toString().trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function maskMongoUri(uri) {
  return uri ? uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@") : "(mancante)";
}

const MONGO_URI = resolveMongoUri();
const DB_NAME = process.env.DB_NAME || "SGPriz";
const USERS_COLLECTION = process.env.USERS_COLLECTION || "Users";
const BANS_COLLECTION = process.env.BANS_COLLECTION || "Bans";

const MONGO_CLIENT_OPTIONS = {
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 8000,
  maxPoolSize: 10
};

module.exports = {
  MONGO_URI,
  DB_NAME,
  USERS_COLLECTION,
  BANS_COLLECTION,
  MONGO_CLIENT_OPTIONS,
  maskMongoUri,
  resolveMongoUri
};
