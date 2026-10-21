/**
 * Bot owner(s) — the only people who can use owner-only commands
 * (addserver / removeserver / servers / noprefix).
 *
 * - If OWNER_ID (or OWNER_IDS, comma-separated) is set, ONLY those users are
 *   owners. Explicit config always wins.
 * - Otherwise the owner is looked up from the Discord application itself
 *   (the application's owner, or the team owner).
 */
const db = require("../firebase");
const owners = new Set();
const extraOwners = new Set();
let pending = null;
let extraOwnersLoaded = false;
let extraOwnersLoadPromise = null;
const EXTRA_OWNERS_REF = db.collection("bot_meta").doc("extra_owners");

function idsFromEnv() {
  const raw = [process.env.OWNER_ID, process.env.OWNER_IDS].filter(Boolean).join(",");
  const ids = [];

  for (const part of raw.split(",")) {
    const id = part.replace(/["'\s]/g, "");
    if (!id) continue;

    if (/^\d{17,20}$/.test(id)) {
      ids.push(id);
    } else {
      console.warn(`[Owners] Ignoring invalid owner ID in env: "${part.trim()}"`);
    }
  }

  return ids;
}

/** Idempotent: safe to call from several modules at startup. */
function resolve(client) {
  if (!pending) {
    pending = (async () => {
      const fromEnv = idsFromEnv();

      if (fromEnv.length) {
        fromEnv.forEach(id => owners.add(id));
        return;
      }

      try {
        const app = await client.application.fetch();
        const owner = app.owner;

        if (owner?.ownerId) owners.add(owner.ownerId); // Team
        else if (owner?.id) owners.add(owner.id); // User
      } catch (error) {
        console.error("[Owners] Could not fetch the application owner:", error);
      }

      if (!owners.size) {
        console.warn("[Owners] No owner known. Set OWNER_ID in your environment.");
      }
      await loadExtraOwners();
    })();
  }

  return pending;
}

async function loadExtraOwners() {
  if (extraOwnersLoaded) return [...extraOwners];
  if (extraOwnersLoadPromise) return extraOwnersLoadPromise;

  extraOwnersLoadPromise = (async () => {
    try {
      const snapshot = await EXTRA_OWNERS_REF.get();
      const ids = snapshot.exists && Array.isArray(snapshot.data().ids) ? snapshot.data().ids : [];
      extraOwners.clear();
      for (const id of ids) if (/^\\d{17,20}$/.test(String(id))) extraOwners.add(String(id));
    } catch (error) {
      console.error("[Owners] Could not load extra owners:", error);
    } finally {
      extraOwnersLoaded = true;
      extraOwnersLoadPromise = null;
    }
    return [...extraOwners];
  })();

  return extraOwnersLoadPromise;
}

const isOwner = userId => owners.has(userId);
const isExtraOwner = userId => extraOwners.has(userId);
const canManageSecurity = userId => isOwner(userId) || isExtraOwner(userId);
const hasOwners = () => owners.size > 0;
const all = () => [...owners];
const allExtra = () => [...extraOwners];

async function addExtraOwner(userId) {
  if (!/^\\d{17,20}$/.test(String(userId))) throw new Error("Invalid Discord user ID.");
  await loadExtraOwners();
  if (owners.has(userId)) return { added: false, alreadyBotOwner: true };
  if (extraOwners.has(userId)) return { added: false, alreadyExists: true };
  if (extraOwners.size >= 50) throw new Error("The extra-owner limit of 50 has been reached.");
  const next = [...extraOwners, userId];
  await EXTRA_OWNERS_REF.set({ ids: next, updatedAt: new Date() }, { merge: true });
  extraOwners.add(userId);
  return { added: true };
}

async function removeExtraOwner(userId) {
  await loadExtraOwners();
  if (!extraOwners.has(userId)) return { removed: false };
  const next = [...extraOwners].filter(id => id !== userId);
  await EXTRA_OWNERS_REF.set({ ids: next, updatedAt: new Date() }, { merge: true });
  extraOwners.delete(userId);
  return { removed: true };
}

module.exports = { resolve, isOwner, isExtraOwner, canManageSecurity, hasOwners, all, allExtra, loadExtraOwners, addExtraOwner, removeExtraOwner };
