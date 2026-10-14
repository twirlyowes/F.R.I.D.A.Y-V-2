/**
 * One-time data migration for the multi-server update.
 *
 * Before this update, warnings / AFK / Active Time were stored per USER ONLY,
 * so servers would have shared (and mixed) data. They are now stored per
 * SERVER + user. This copies your existing records into the new format for
 * the server they belong to.
 *
 * Usage (run where FIREBASE_KEY is set, e.g. Render shell or locally):
 *   node scripts/migrate-to-multiserver.js <guildId>            # dry run (prints only)
 *   node scripts/migrate-to-multiserver.js <guildId> --apply    # copy records
 *   node scripts/migrate-to-multiserver.js <guildId> --apply --delete-old
 *
 * Run it once per server that already had data (usually just your main one).
 */
const db = require("../firebase");

const guildId = process.argv[2];
const apply = process.argv.includes("--apply");
const deleteOld = process.argv.includes("--delete-old");

if (!/^\d{17,20}$/.test(guildId || "")) {
  console.error("Usage: node scripts/migrate-to-multiserver.js <guildId> [--apply] [--delete-old]");
  process.exit(1);
}

// collection -> [separator used in the new doc id, legacy-doc test]
const TARGETS = [
  { name: "warnings", sep: "_" },
  { name: "afk", sep: "_" },
  { name: "activetime", sep: ":" }
];

(async () => {
  console.log(apply ? "APPLYING changes" : "DRY RUN (add --apply to write)");

  for (const { name, sep } of TARGETS) {
    const snap = await db.collection(name).get();
    let copied = 0;
    let skipped = 0;

    for (const doc of snap.docs) {
      // legacy records have a bare user ID (no server prefix) as their doc ID
      if (doc.id.includes(sep)) continue;

      const newId = `${guildId}${sep}${doc.id}`;
      const exists = (await db.collection(name).doc(newId).get()).exists;

      if (exists) {
        skipped++;
        continue;
      }

      if (apply) {
        await db.collection(name).doc(newId).set(doc.data());
        if (deleteOld) await db.collection(name).doc(doc.id).delete();
      }

      copied++;
    }

    console.log(`${name}: ${copied} to migrate${skipped ? `, ${skipped} already migrated` : ""}`);
  }

  console.log(apply ? "Done." : "Dry run finished — nothing was changed.");
  process.exit(0);
})().catch(error => {
  console.error("Migration failed:", error);
  process.exit(1);
});
