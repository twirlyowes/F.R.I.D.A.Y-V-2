/**
 * No-prefix access, controlled ONLY by the bot owner (OWNER_ID).
 *
 * A user on the list can run commands without typing the prefix
 * (e.g. "help" instead of ".help"). Everyone else still needs the prefix.
 *
 *   <prefix>noprefix add <@user | id>      turn it on for a user
 *   <prefix>noprefix remove <@user | id>   turn it off
 *   <prefix>noprefix list                  show who has it
 *
 * Stored in Firestore (noprefix_users/{userId}) and works in every server.
 */
const { MessageFlags } = require("discord.js");
const { COLORS, createCard } = require("./lib/pixelVillaUI");
const { parseCommand } = require("./lib/prefix");
const owners = require("./lib/owners");
const noPrefix = require("./lib/noprefix");

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

module.exports = client => {
  let started = false;

  const start = async () => {
    if (started) return;
    started = true;

    await owners.resolve(client);
    await noPrefix.load();
    console.log(`[NoPrefix] Loaded ${noPrefix.list().length} no-prefix user(s).`);
  };

  client.once("clientReady", start);
  client.once("ready", start);

  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;

    const parsed = await parseCommand(message);
    if (!parsed || parsed.command !== "noprefix") return;

    const p = parsed.prefix;

    try {
      if (!owners.isOwner(message.author.id)) {
        return reply(message, COLORS.RED, "Only the bot owner can use this command.");
      }

      const sub = (parsed.args[0] || "list").toLowerCase();

      if (["list", "show"].includes(sub)) {
        const ids = noPrefix.list();

        return reply(
          message,
          COLORS.SKY_BLUE,
          `# No-Prefix Users (${ids.length})\n\n` +
            (ids.length
              ? ids.slice(0, 30).map(id => `• <@${id}> (\`${id}\`)`).join("\n")
              : "*Nobody yet.*") +
            `\n\nAdd someone with \`${p}noprefix add <@user | id>\`.\n\n-# F.R.I.D.A.Y • No-Prefix`
        );
      }

      const isAdd = ["add", "on", "enable"].includes(sub);
      const isRemove = ["remove", "off", "disable", "delete"].includes(sub);

      if (!isAdd && !isRemove) {
        return reply(
          message,
          COLORS.RED,
          `**Usage:**\n\`${p}noprefix add <@user | id>\`\n\`${p}noprefix remove <@user | id>\`\n\`${p}noprefix list\``
        );
      }

      const raw = parsed.args[1] || message.mentions.users.first()?.id || "";
      const userId = raw.replace(/\D/g, "");

      if (!/^\d{17,20}$/.test(userId)) {
        return reply(
          message,
          COLORS.RED,
          `Tell me which user: \`${p}noprefix ${sub} <@user | id>\``
        );
      }

      if (isAdd) {
        const user = await client.users.fetch(userId).catch(() => null);

        if (!user) {
          return reply(message, COLORS.RED, "I couldn't find that user.");
        }

        if (user.bot) {
          return reply(message, COLORS.RED, "Bots can't be given no-prefix access.");
        }

        if (noPrefix.has(userId)) {
          return reply(message, COLORS.SKY_BLUE, `<@${userId}> already has no-prefix access.`);
        }

        await noPrefix.add(userId, message.author.id);

        return reply(
          message,
          COLORS.GREEN,
          `No-prefix is now **on** for <@${userId}>. They can run commands without \`${p}\`.`
        );
      }

      if (!noPrefix.has(userId)) {
        return reply(message, COLORS.SKY_BLUE, `<@${userId}> doesn't have no-prefix access.`);
      }

      await noPrefix.remove(userId);

      return reply(message, COLORS.GREEN, `No-prefix is now **off** for <@${userId}>.`);
    } catch (error) {
      console.error("[NoPrefix] Command error:", error);
      reply(message, COLORS.RED, "Something went wrong.").catch(() => {});
    }
  });
};
