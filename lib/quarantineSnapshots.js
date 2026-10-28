const db = require("../firebase");

const COLLECTION = "quarantine_role_snapshots";

function docId(guildId, memberId) {
  return `${guildId}_${memberId}`;
}

function sanitize(ids) {
  if (!Array.isArray(ids)) return null;
  return [...new Set(ids.filter(id => typeof id === "string" && /^\d{17,20}$/.test(id)))];
}

async function save(guildId, memberId, roleIds) {
  const roles = sanitize(roleIds);
  if (!roles) throw new TypeError("Invalid quarantine role snapshot.");
  await db.collection(COLLECTION).doc(docId(guildId, memberId)).set({
    guildId, memberId, roles, updatedAt: Date.now()
  });
}

async function load(guildId, memberId) {
  const snap = await db.collection(COLLECTION).doc(docId(guildId, memberId)).get();
  if (!snap.exists) return null;
  const roles = sanitize(snap.data()?.roles);
  if (!roles) throw new Error("Saved quarantine role snapshot is invalid.");
  return roles;
}

async function remove(guildId, memberId) {
  await db.collection(COLLECTION).doc(docId(guildId, memberId)).delete();
}

module.exports = { save, load, remove };
