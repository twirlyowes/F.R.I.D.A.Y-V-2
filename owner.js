const { MessageFlags } = require("discord.js");
const { parseCommand } = require("./lib/prefix");
const owners = require("./lib/owners");
const serverOwners = require("./lib/serverOwners");
const { COLORS, createCard } = require("./lib/pixelVillaUI");

async function reply(message, color, content) {
  return await message.reply({
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
      const isBotOwner = owners.isOwner(message.author.id);
      const isGuildOwner = message.author.id === message.guild.ownerId;
      if (!isBotOwner && !isGuildOwner) {
        return reply(message, COLORS.RED, "Only this server owner (or the main bot owner) can manage this server's owner list.");
      }

      const sub = (parsed.args[0] || "list").toLowerCase();
      if (["list", "show"].includes(sub)) {
        const ids = await serverOwners.list(message.guild.id);
        return reply(message, COLORS.SKY_BLUE,
          "# Server Owners — " + message.guild.name + " (" + ids.length + ")\n\n" +
          (ids.length ? ids.map(id => "• <@" + id + "> (`" + id + "`)").join("\n") : "*Nobody has been added yet.*") +
          "\n\n**Access:** AutoMod + Anti-Nuke in this server only.\n" +
          "**Scope:** `" + message.guild.id + "`\n-# F.R.I.D.A.Y • Owner Management");
      }

      if (!["add", "remove"].includes(sub)) {
        return reply(message, COLORS.RED,
          "**Usage**\n" +
          "`" + parsed.prefix + "owner add @user`\n" +
          "`" + parsed.prefix + "owner remove @user`\n" +
          "`" + parsed.prefix + "owner list`");
      }

      const raw = parsed.args[1] || message.mentions.users.first()?.id || "";
      const userId = String(raw).replace(/\D/g, "");
      if (!/^\d{17,20}$/.test(userId)) {
        return reply(message, COLORS.RED, "Mention a user or provide a valid ID: `" + parsed.prefix + "owner " + sub + " @user`");
      }
      if (userId === message.guild.ownerId) {
        return reply(message, COLORS.SKY_BLUE, "The server owner already has owner access and does not need to be added.");
      }
      if (isBotOwner && userId === message.author.id) {
        return reply(message, COLORS.SKY_BLUE, "You are already the main bot owner.");
      }

      if (sub === "add") {
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member || member.user.bot) {
          return reply(message, COLORS.RED, "Choose a valid, non-bot member of this server.");
        }
        const result = await serverOwners.add(message.guild.id, userId);
        if (!result.added) {
          return reply(message, COLORS.SKY_BLUE, result.reason === "limit"
            ? "This server has reached the limit of 50 delegated owners."
            : "<@" + userId + "> is already an owner in this server.");
        }
        return reply(message, COLORS.GREEN,
          "<:success_g:1561271843346714777> Added <@" + userId + "> as a delegated owner in **" + message.guild.name + "**. Access applies to this server only: AutoMod + Anti-Nuke.");
      }

      const removed = await serverOwners.remove(message.guild.id, userId);
      return reply(message, removed ? COLORS.GREEN : COLORS.SKY_BLUE,
        removed ? "Removed <@" + userId + "> from this server's owner list." : "<@" + userId + "> is not an owner in this server.");
    } catch (error) {
      console.error("[Owner] Server owner command failed:", error);
      return reply(message, COLORS.RED, "Couldn't update this server's owner list. Check the database connection and logs.");
    }
  });
};
