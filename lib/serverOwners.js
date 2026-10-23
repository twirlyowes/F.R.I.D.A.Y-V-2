/** Per-server delegated owners, stored separately for each Discord guild. */
const db = require("../firebase");
const COLLECTION = "server_owner_access";
const MAX_OWNERS = 50;

// Dashboard writes share this Firestore collection but run in another process.
// Expire local cache entries so add/remove changes become effective in FRIDAY
// without restarting Render, while keeping repeated event checks cheap.
const CACHE_TTL_MS = 30 * 1000;
const ERROR_RETRY_MS = 5 * 1000;
const cache = new Map(); // guildId -> { ids, fetchedAt }
const pendingLoads = new Map();
const nextRetryAt = new Map();

function sanitize(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id => typeof id === "string" && /^\d{17,20}$/.test(id)))]
    .slice(0, MAX_OWNERS);
}

async function load(guildId) {
  if (!guildId) return [];
  const now = Date.now();
  const cached = cache.get(guildId);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.ids;
  if ((nextRetryAt.get(guildId) || 0) > now) {
    if (cached) return cached.ids;
    throw new Error("Server owner access is temporarily unavailable.");
  }
  if (pendingLoads.has(guildId)) return pendingLoads.get(guildId);

  const task = (async () => {
    try {
      const snap = await db.collection(COLLECTION).doc(guildId).get();
      const ids = sanitize(snap.exists ? snap.data()?.owners : []);
      cache.set(guildId, { ids, fetchedAt: Date.now() });
      nextRetryAt.delete(guildId);
      return ids;
    } catch (error) {
      nextRetryAt.set(guildId, Date.now() + ERROR_RETRY_MS);
      console.error("[ServerOwners] Failed to load owners for " + guildId + ":", error.message);
      // Preserve last-known-good access data if Firestore is briefly unavailable.
      if (cached) return cached.ids;
      throw error;
    }
  })();

  pendingLoads.set(guildId, task);
  try {
    return await task;
  } finally {
    if (pendingLoads.get(guildId) === task) pendingLoads.delete(guildId);
  }
}

async function list(guildId) {
  return [...await load(guildId)];
}

async function isOwner(guildId, userId) {
  if (!guildId || !userId) return false;
  return (await load(guildId)).includes(userId);
}

async function add(guildId, userId) {
  if (!/^\d{17,20}$/.test(userId || "")) throw new Error("Invalid Discord user ID.");
  const current = await load(guildId);
  if (current.includes(userId)) return { added: false, reason: "exists" };
  if (current.length >= MAX_OWNERS) return { added: false, reason: "limit" };
  const next = [...current, userId];
  await db.collection(COLLECTION).doc(guildId).set({ owners: next, updatedAt: Date.now() }, { merge: true });
  cache.set(guildId, { ids: next, fetchedAt: Date.now() });
  nextRetryAt.delete(guildId);
  return { added: true };
}

async function remove(guildId, userId) {
  const current = await load(guildId);
  if (!current.includes(userId)) return false;
  const next = current.filter(id => id !== userId);
  await db.collection(COLLECTION).doc(guildId).set({ owners: next, updatedAt: Date.now() }, { merge: true });
  cache.set(guildId, { ids: next, fetchedAt: Date.now() });
  nextRetryAt.delete(guildId);
  return true;
}

function invalidate(guildId) {
  cache.delete(guildId);
  nextRetryAt.delete(guildId);
}

module.exports = { list, isOwner, add, remove, invalidate };
