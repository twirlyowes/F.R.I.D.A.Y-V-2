/**
 * Main bot owners and delegated extra owners.
 * Extra owners are stored persistently in Firestore and may manage AutoMod
 * and Anti-Nuke only. They do not become full bot owners.
 */
const db = require("../firebase");
const owners = new Set();
const extraOwners = new Set();
let pending = null;
const EXTRA_OWNERS_REF = () => db.collection("bot_access").doc("extra_owners");

function idsFromEnv() {
  const raw = [process.env.OWNER_ID, process.env.OWNER_IDS].filter(Boolean).join(",");
  const ids = [];
  for (const part of raw.split(",")) {
    const id = part.replace(/["'\s]/g, "");
    if (!id) continue;
    if (/^\d{17,20}$/.test(id)) ids.push(id);
    else console.warn(`[Owners] Ignoring invalid owner ID in env: "${part.trim()}"`);
  }
  return ids;
}

async function loadExtraOwners() {
  try {
    const doc = await EXTRA_OWNERS_REF().get();
    const list = doc.exists && Array.isArray(doc.data()?.ids) ? doc.data().ids : [];
    extraOwners.clear();
    for (const id of list) if (typeof id === "string" && /^\d{17,20}$/.test(id)) extraOwners.add(id);
  } catch (error) {
    console.error("[Owners] Could not load extra owners:", error.message);
  }
}

/** Idempotent startup resolution. */
function resolve(client) {
  if (!pending) {
    pending = (async () => {
      const fromEnv = idsFromEnv();
      if (fromEnv.length) fromEnv.forEach(id => owners.add(id));
      else {
        try {
          const app = await client.application.fetch();
          const owner = app.owner;
          if (owner?.ownerId) owners.add(owner.ownerId);
          else if (owner?.id) owners.add(owner.id);
        } catch (error) {
          console.error("[Owners] Could not fetch the application owner:", error);
        }
      }
      if (!owners.size) console.warn("[Owners] No owner known. Set OWNER_ID in your environment.");
      await loadExtraOwners();
    })();
  }
  return pending;
}

const isOwner = userId => owners.has(userId);
const isExtraOwner = userId => extraOwners.has(userId) && !owners.has(userId);
const hasOwners = () => owners.size > 0;
const all = () => [...owners];
const allExtra = () => [...extraOwners];

async function addExtraOwner(userId) {
  if (!/^\d{17,20}$/.test(userId)) throw new Error("Invalid Discord user ID.");
  if (owners.has(userId)) return { added: false, reason: "main-owner" };
  if (extraOwners.has(userId)) return { added: false, reason: "exists" };
  const next = [...extraOwners, userId].slice(0, 50);
  await EXTRA_OWNERS_REF().set({ ids: next }, { merge: true });
  extraOwners.clear();
  next.forEach(id => extraOwners.add(id));
  return { added: true };
}

async function removeExtraOwner(userId) {
  if (!extraOwners.has(userId)) return false;
  const next = [...extraOwners].filter(id => id !== userId);
  await EXTRA_OWNERS_REF().set({ ids: next }, { merge: true });
  extraOwners.delete(userId);
  return true;
}

module.exports = {
  resolve, isOwner, isExtraOwner, hasOwners, all, allExtra,
  addExtraOwner, removeExtraOwner, loadExtraOwners
};
