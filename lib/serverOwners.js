/** Per-server delegated owners, stored separately for each Discord guild. */
const db = require("../firebase");
const COLLECTION = "server_owner_access";
const MAX_OWNERS = 50;
const cache = new Map();

function sanitize(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id => typeof id === "string" && /^\d{17,20}$/.test(id)))]
    .slice(0, MAX_OWNERS);
}

async function load(guildId) {
  if (!guildId) return [];
  if (cache.has(guildId)) return cache.get(guildId);
  try {
    const snap = await db.collection(COLLECTION).doc(guildId).get();
    const ids = sanitize(snap.exists ? snap.data()?.owners : []);
    cache.set(guildId, ids);
    return ids;
  } catch (error) {
    console.error("[ServerOwners] Failed to load owners for " + guildId + ":", error.message);
    throw error;
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
  cache.set(guildId, next);
  return { added: true };
}

async function remove(guildId, userId) {
  const current = await load(guildId);
  if (!current.includes(userId)) return false;
  const next = current.filter(id => id !== userId);
  await db.collection(COLLECTION).doc(guildId).set({ owners: next, updatedAt: Date.now() }, { merge: true });
  cache.set(guildId, next);
  return true;
}

function invalidate(guildId) { cache.delete(guildId); }

module.exports = { list, isOwner, add, remove, invalidate };
