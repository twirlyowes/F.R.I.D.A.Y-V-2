/**
 * Owner-only access control.
 *
 * Only servers the bot OWNER has approved may keep the bot. If anyone else
 * invites it to an unapproved server, the bot leaves immediately and DMs the
 * owner so they can approve it.
 *
 * Owner = whoever OWNER_ID (env) names. If OWNER_ID isn't set, it falls back
 * to the Discord application's owner (see lib/owners.js).
 *
 * Owner commands (use the server prefix):
 *   <prefix>addserver <serverId>     approve a server (do this BEFORE inviting)
 *   <prefix>removeserver <serverId>  revoke approval (and leave that server)
 *   <prefix>servers                  list approved + current servers
 *
 * Firestore:
 *   allowed_guilds/{guildId}   { addedBy, addedAt }
 *   bot_meta/access            { seededAt }  (one-time bootstrap marker)
 */
const { MessageFlags } = require("discord.js");
const db = require("./firebase");
const { COLORS, createCard } = require("./lib/pixelVillaUI");
const { parseCommand } = require("./lib/prefix");

const ALLOWED = "allowed_guilds";
const META_DOC = db.collection("bot_meta").doc("access");

const allowed = new Set();
const owners = require("./lib/owners");
let resolveReady;
const accessReady = new Promise(resolve => (resolveReady = resolve));

function reply(message, color, content) {
  return message.reply({
    components: [
      createCard({
        color,
        content,
        avatarURL: message.client.user.displayAvatarURL({
          extension: "png",
          size: 128
        }),
        avatarDescription: "F.R.I.D.A.Y"
      })
    ],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  });
}

async function loadAllowed() {
  const snap = await db.collection(ALLOWED).get();
  allowed.clear();
  snap.forEach(doc => allowed.add(doc.id));
}

async function approve(guildId, addedBy) {
  await db.collection(ALLOWED).doc(guildId).set({
    addedBy,
    addedAt: Date.now()
  });
  allowed.add(guildId);
}

async function revoke(guildId) {
  await db.collection(ALLOWED).doc(guildId).delete();
  allowed.delete(guildId);
}

/**
 * First run only: approve every server the bot is already in, so deploying
 * this update never kicks the bot out of your existing servers.
 */
async function seedExistingGuilds(client) {
  const meta = await META_DOC.get();
  if (meta.exists) return;

  for (const guild of client.guilds.cache.values()) {
    await approve(guild.id, "bootstrap");
  }

  await META_DOC.set({ seededAt: Date.now() });
  console.log(`[Access] Approved ${client.guilds.cache.size} existing server(s).`);
}

async function notifyOwners(client, text) {
  for (const ownerId of owners.all()) {
    try {
      const user = await client.users.fetch(ownerId);
      await user.send(text);
    } catch {
      // DMs closed — nothing else we can do
    }
  }
}

async function enforce(client, guild) {
  if (!owners.hasOwners()) {
    console.warn("[Access] Owner unknown — set OWNER_ID to enforce owner-only access.");
    return;
  }

  if (allowed.has(guild.id)) return;

  console.log(`[Access] Leaving unapproved server: ${guild.name} (${guild.id})`);

  await notifyOwners(
    client,
    `<:error_g:1562810019454386196> I was added to **${guild.name}** (\`${guild.id}\`) and left because it isn't approved.\n` +
      `To allow it, run \`addserver ${guild.id}\` in one of your approved servers (with the server prefix), then invite me again.`
  );

  await guild.leave().catch(err =>
    console.error(`[Access] Failed to leave ${guild.id}:`, err)
  );
}

module.exports = client => {
  let started = false;

  const start = async () => {
    if (started) return;
    started = true;

    try {
      await owners.resolve(client);
      await seedExistingGuilds(client);
      await loadAllowed();

      for (const guild of client.guilds.cache.values()) {
        await enforce(client, guild);
      }
    } catch (error) {
      console.error("[Access] Startup failed:", error);
    } finally {
      resolveReady();
    }
  };

  client.once("clientReady", start);
  client.once("ready", start);

  client.on("guildCreate", async guild => {
    await accessReady;
    await enforce(client, guild);
  });

  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;

    const parsed = await parseCommand(message);
    if (!parsed) return;

    const { command, args } = parsed;
    if (!["addserver", "removeserver", "servers"].includes(command)) return;

    try {
      if (!owners.isOwner(message.author.id)) {
        return reply(message, COLORS.RED, "Only the bot owner can use this command.");
      }

      if (command === "servers") {
        const joined = [...client.guilds.cache.values()].map(
          g => `• **${g.name}** — \`${g.id}\` (${g.memberCount} members)`
        );

        const waiting = [...allowed].filter(id => !client.guilds.cache.has(id));

        return reply(
          message,
          COLORS.SKY_BLUE,
          `# Servers (${joined.length})\n\n${joined.slice(0, 25).join("\n") || "*none*"}` +
            (waiting.length
              ? `\n\n**Approved, bot not in yet:**\n${waiting.slice(0, 15).map(id => `• \`${id}\``).join("\n")}`
              : "") +
            `\n\n-# F.R.I.D.A.Y • Access`
        );
      }

      const guildId = (args[0] || "").replace(/\D/g, "");

      if (!/^\d{17,20}$/.test(guildId)) {
        return reply(
          message,
          COLORS.RED,
          `**Usage:** \`${parsed.prefix}${command} <serverId>\``
        );
      }

      if (command === "addserver") {
        await approve(guildId, message.author.id);
        return reply(
          message,
          COLORS.GREEN,
          `Server \`${guildId}\` is approved. You can invite me to it now.`
        );
      }

      // removeserver
      await revoke(guildId);

      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        await reply(
          message,
          COLORS.GREEN,
          `Server \`${guildId}\` is no longer approved. Leaving **${guild.name}**.`
        ).catch(() => {});

        return guild.leave().catch(() => {});
      }

      return reply(message, COLORS.GREEN, `Server \`${guildId}\` is no longer approved.`);
    } catch (error) {
      console.error("[Access] Command error:", error);
      reply(message, COLORS.RED, "Something went wrong.").catch(() => {});
    }
  });
};
