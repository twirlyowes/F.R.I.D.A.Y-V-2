const { MessageFlags } = require("discord.js");
const { parseCommand } = require("./lib/prefix");
const owners = require("./lib/owners");
const { extractSnowflake } = require("./lib/commandArgs");
const { COLORS, createCard } = require("./lib/pixelVillaUI");

function replyCard(content, color = COLORS.SKY_BLUE) {
  return {
    components: [createCard({ color, content })],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

module.exports = client => {
  owners.resolve(client).catch(error => console.error("[Owners] Initialization failed:", error));

  client.on("messageCreate", async message => {
    if (!message.guild || message.author.bot) return;
    try {
      const parsed = await parseCommand(message);
      if (!parsed || parsed.command !== "owner") return;

      if (!owners.isOwner(message.author.id)) {
        return message.reply(replyCard("⛔ Only the **FRIDAY bot owner** can manage extra owners.", COLORS.RED));
      }

      const [subcommand, rawTarget, ...rest] = parsed.args;
      const action = (subcommand || "").toLowerCase();
      if (rest.length || !["add", "remove", "list"].includes(action)) {
        return message.reply(replyCard("**Owner commands**\n\n" +
          "`" + parsed.prefix + "owner add @user` — grant AutoMod and Anti-Nuke management\n" +
          "`" + parsed.prefix + "owner remove @user` — revoke extra-owner access\n" +
          "`" + parsed.prefix + "owner list` — list extra owners"));
      }

      if (action === "list") {
        if (parsed.args.length !== 1) return message.reply(replyCard("Usage: " + parsed.prefix + "owner list", COLORS.RED));
        const ids = await owners.loadExtraOwners();
        const list = ids.length ? ids.map(id => "• <@" + id + "> (`" + id + "`)").join("\n") : "*No extra owners configured.*";
        return message.reply(replyCard("## FRIDAY Extra Owners\n" + list));
      }

      if (!rawTarget || parsed.args.length !== 2) {
        return message.reply(replyCard("Usage: " + parsed.prefix + "owner " + action + " @user", COLORS.RED));
      }
      const targetId = extractSnowflake(rawTarget);
      if (!targetId) return message.reply(replyCard("Provide one valid user mention or Discord user ID.", COLORS.RED));
      if (targetId === message.author.id) return message.reply(replyCard("You are already the bot owner.", COLORS.RED));
      if (owners.isOwner(targetId)) return message.reply(replyCard("The primary bot owner cannot be changed using this command.", COLORS.RED));

      if (action === "add") {
        const result = await owners.addExtraOwner(targetId);
        if (result.alreadyBotOwner) return message.reply(replyCard("That user is already a primary bot owner."));
        if (result.alreadyExists) return message.reply(replyCard("That user is already an extra owner.", COLORS.RED));
        return message.reply(replyCard("✅ <@" + targetId + "> is now an **extra owner**. They can manage AutoMod and Anti-Nuke across servers."));
      }

      const result = await owners.removeExtraOwner(targetId);
      if (!result.removed) return message.reply(replyCard("That user is not an extra owner.", COLORS.RED));
      return message.reply(replyCard("✅ Removed <@" + targetId + "> from extra owners. Their elevated AutoMod and Anti-Nuke access is revoked."));
    } catch (error) {
      console.error("[Owner] Command error:", error);
      return message.reply(replyCard("Could not update extra owners. Check Firestore permissions and bot logs.", COLORS.RED)).catch(() => {});
    }
  });
};
