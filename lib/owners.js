/** Resolves the main bot owner from environment or the Discord application. */
const owners = new Set();
let pending = null;

function idsFromEnv() {
  const raw = [process.env.OWNER_ID, process.env.OWNER_IDS].filter(Boolean).join(",");
  const ids = [];
  for (const part of raw.split(",")) {
    const id = part.replace(/["'\s]/g, "");
    if (!id) continue;
    if (/^\d{17,20}$/.test(id)) ids.push(id);
    else console.warn("[Owners] Ignoring invalid owner ID in env: \"" + part.trim() + "\"");
  }
  return ids;
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
    })();
  }
  return pending;
}

const isOwner = userId => owners.has(userId);
const hasOwners = () => owners.size > 0;
const all = () => [...owners];

module.exports = { resolve, isOwner, hasOwners, all };
