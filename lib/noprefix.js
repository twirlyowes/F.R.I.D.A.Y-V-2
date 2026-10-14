/**
 * No-prefix users: people the bot owner has allowed to run commands without
 * typing the prefix. Stored in Firestore: noprefix_users/{userId}
 * (global — it follows the user into every server).
 */
const db = require("../firebase");

const COLLECTION = "noprefix_users";
const users = new Set();

async function load() {
  try {
    const snap = await db.collection(COLLECTION).get();
    users.clear();
    snap.forEach(doc => users.add(doc.id));
  } catch (error) {
    console.error("[NoPrefix] Failed to load users:", error);
  }
}

const has = userId => users.has(userId);
const list = () => [...users];

async function add(userId, addedBy) {
  await db.collection(COLLECTION).doc(userId).set({ addedBy, addedAt: Date.now() });
  users.add(userId);
}

async function remove(userId) {
  await db.collection(COLLECTION).doc(userId).delete();
  users.delete(userId);
}

module.exports = { load, has, list, add, remove };
