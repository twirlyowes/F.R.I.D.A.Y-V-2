/**
 * Bot owner(s) — the only people who can use owner-only commands
 * (addserver / removeserver / servers / noprefix).
 *
 * - If OWNER_ID (or OWNER_IDS, comma-separated) is set, ONLY those users are
 *   owners. Explicit config always wins.
 * - Otherwise the owner is looked up from the Discord application itself
 *   (the application's owner, or the team owner).
 */
const owners = new Set();
let pending = null;

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
    })();
  }

  return pending;
}

const isOwner = userId => owners.has(userId);
const hasOwners = () => owners.size > 0;
const all = () => [...owners];

module.exports = { resolve, isOwner, hasOwners, all };
