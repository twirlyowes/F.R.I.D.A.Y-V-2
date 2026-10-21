const { MessageFlags } = require("discord.js");
const { parseCommand } = require("./lib/prefix");
const owners = require("./lib/owners");
const { COLORS, createCard } = require("./lib/pixelVillaUI");

function reply(message, color, content) {
  return message.reply({
    components: [createCard({
      color,
      content,
      avatarURL: message.client.user.displayAvatarURL({ extension: "png", size: 128 }),
      avatarDescription: "F.R.I.D.A.Y"
    })],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  });
}

module.exports = client => {
  client.once("clientReady", () => owners.resolve(client));
  client.once("ready", () => owners.resolve(client));

  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;
    const parsed = await parseCommand(message);
    if (!parsed || parsed.command !== "owner") return;

    try {
      await owners.resolve(client);
      if (!owners.isOwner(message.author.id)) {
        return reply(message, COLORS.RED, "Only the main bot owner can manage extra owners.");
      }

      const sub = (parsed.args[0] || "list").toLowerCase();
      if (["list", "show"].includes(sub)) {
        const ids = owners.allExtra();
        return reply(message, COLORS.SKY_BLUE,
          `# Extra Owners (${ids.length})\n\n` +
          (ids.length ? ids.map(id => `• <@${id}> (` + "`" + `${id}` + "`" + `)`).join("\n") : "*Nobody has been added yet.*") +
          `\n\n**Access:** AutoMod + Anti-Nuke only.\n-# F.R.I.D.A.Y • Owner Management`);
      }

      if (!["add", "remove"].includes(sub)) {
        return reply(message, COLORS.RED,
          `**Usage**\n` +
          `\`${parsed.prefix}owner add @user\`\n` +
          `\`${parsed.prefix}owner remove @user\`\n` +
          `\`${parsed.prefix}owner list\``);
      }

      const raw = parsed.args[1] || message.mentions.users.first()?.id || "";
      const userId = raw.replace(/\D/g, "");
      if (!/^\d{17,20}$/.test(userId)) {
        return reply(message, COLORS.RED, `Mention a user or provide a valid ID: \`${parsed.prefix}owner ${sub} @user\``);
      }
      if (userId === message.author.id) {
        return reply(message, COLORS.RED, "You are already the main bot owner.");
      }

      if (sub === "add") {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user || user.bot) return reply(message, COLORS.RED, "I couldn't find a valid non-bot user.");
        const result = await owners.addExtraOwner(userId);
        if (!result.added) {
          const text = result.reason === "main-owner"
            ? "That user is already a main bot owner."
            : result.reason === "limit"
              ? "The extra-owner limit is 50. Remove an extra owner before adding another."
              : "That user is already an extra owner.";
          return reply(message, COLORS.SKY_BLUE, text);
        }
        return reply(message, COLORS.GREEN,
          `<:success_g:1561271843346714777> Added <@${userId}> as an extra owner. Access: AutoMod + Anti-Nuke only.`);
      }

      const removed = await owners.removeExtraOwner(userId);
      return reply(message, removed ? COLORS.GREEN : COLORS.SKY_BLUE,
        removed ? `Removed <@${userId}> from extra owners.` : `<@${userId}> is not an extra owner.`);
    } catch (error) {
      console.error("[Owner] Command failed:", error);
      return reply(message, COLORS.RED, "Couldn't update extra owners. Check the database connection and logs.");
    }
  });
};
