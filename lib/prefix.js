/**
 * One shared command parser so EVERY command uses the same prefix.
 *
 * - Each server can set its own prefix (`.config set prefix !` or `.prefix !`).
 * - Users on the owner-managed no-prefix list can skip the prefix entirely
 *   (see noprefix.js).
 * - Mentioning the bot always works as a prefix too ("@F.R.I.D.A.Y help"),
 *   so a server can never lock itself out by picking a bad prefix.
 */
const guildConfig = require("./guildConfig");
const noPrefix = require("./noprefix");

const DEFAULT_PREFIX = process.env.DEFAULT_PREFIX || ".";
const MAX_PREFIX_LENGTH = 5;

async function getPrefix(guildId) {
  if (!guildId) return DEFAULT_PREFIX;
  const cfg = await guildConfig.get(guildId);
  return cfg.prefix || DEFAULT_PREFIX;
}

function mentionPrefixLength(content, botId) {
  const match = content.match(new RegExp(`^<@!?${botId}>`));
  return match ? match[0].length : 0;
}

async function resolve(message) {
  if (!message.guild || !message.content) return null;

  const content = message.content.trim();
  if (!content) return null;

  const prefix = await getPrefix(message.guild.id);

  let rest = null;
  let viaNoPrefix = false;
  const mentionLen = mentionPrefixLength(content, message.client.user.id);

  if (mentionLen) {
    rest = content.slice(mentionLen).trim();
  } else if (content.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
    rest = content.slice(prefix.length).trim();
  } else if (noPrefix.has(message.author.id)) {
    // Owner-approved "no prefix" user: the whole message is the command.
    rest = content;
    viaNoPrefix = true;
  }

  if (!rest) return null;

  const args = rest.split(/\s+/);
  const command = args.shift().toLowerCase();

  return { prefix, command, args, rest, viaNoPrefix };
}

/**
 * Parse a message into { prefix, command, args } or null if it isn't a command.
 * The result is memoised on the message, so many modules can call it cheaply.
 */
function parseCommand(message) {
  if (!message.__fridayParsed) {
    message.__fridayParsed = resolve(message);
  }
  return message.__fridayParsed;
}

module.exports = {
  DEFAULT_PREFIX,
  MAX_PREFIX_LENGTH,
  getPrefix,
  parseCommand
};
