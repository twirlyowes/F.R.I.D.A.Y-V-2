const axios = require("axios");
const { AttachmentBuilder, MessageFlags, PermissionsBitField } = require("discord.js");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { COLORS, createCard } = require("./lib/pixelVillaUI");
const { parseCommand } = require("./lib/prefix");

const TICK = String.fromCharCode(96);
const MAX_INPUT = 10 * 1024 * 1024;
const MAX_EMOJI = 256 * 1024;
const MAX_STICKER = 512 * 1024;
const MAX_PIXELS = 40_000_000;
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net", "images-ext-1.discordapp.net"]);
const EMOJI_MENTION = /<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>/;

function formatOf(buffer, mime = "") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "gif";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "jpg";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buffer.subarray(0, 128).toString("utf8").trimStart().startsWith("{") && /"v"\s*:/.test(buffer.subarray(0, 128).toString("utf8"))) return "json";
  if (/image\/png/i.test(mime)) return "png";
  if (/image\/gif/i.test(mime)) return "gif";
  if (/image\/jpe?g/i.test(mime)) return "jpg";
  if (/image\/webp/i.test(mime)) return "webp";
  return "unknown";
}

function animated(buffer, format) {
  return format === "gif" ||
    (format === "png" && buffer.includes(Buffer.from("acTL"))) ||
    (format === "webp" && (buffer.includes(Buffer.from("ANIM")) || buffer.includes(Buffer.from("ANMF"))));
}

function parseLimit(raw) {
  const match = String(raw || "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib)?$/);
  if (!match) return null;
  const unit = match[2] || "kb";
  const multiplier = unit === "b" ? 1 : unit === "mb" || unit === "mib" ? 1024 * 1024 : 1024;
  const bytes = Math.floor(Number(match[1]) * multiplier);
  return Number.isFinite(bytes) && bytes >= 16 * 1024 && bytes <= 8 * 1024 * 1024 ? bytes : null;
}

function safeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("That does not look like a valid URL."); }
  if (url.protocol !== "https:" || !CDN_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("For safety, AssetForge only downloads files hosted on Discord's CDN.");
  }
  return url.toString();
}

async function download(rawUrl) {
  const url = safeUrl(rawUrl);
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    maxContentLength: MAX_INPUT,
    maxBodyLength: MAX_INPUT,
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 300
  });
  const buffer = Buffer.from(response.data);
  if (!buffer.length) throw new Error("The source file is empty.");
  if (buffer.length > MAX_INPUT) throw new Error("The source exceeds the 10 MB input limit.");
  return { buffer, contentType: String(response.headers["content-type"] || "").split(";")[0].toLowerCase(), url };
}

function cleanName(value, fallback = "friday_asset") {
  const name = String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return name.length >= 2 ? name : fallback;
}

function emojiSource(message) {
  const match = message.content.match(EMOJI_MENTION);
  if (!match) return null;
  return {
    name: match[2],
    url: "https://cdn.discordapp.com/emojis/" + match[3] + "." + (match[1] ? "gif" : "png") + "?size=4096&quality=lossless"
  };
}

function linkedCdnUrl(content) {
  const match = String(content || "").match(/https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-1\.discordapp\.net)\/[^\s<>]+/i);
  return match ? match[0].replace(/[),.!]+$/g, "") : null;
}

async function sourceFromMessage(message, options = {}) {
  if (options.allowEmoji) {
    const emoji = emojiSource(message);
    if (emoji) return { ...(await download(emoji.url)), name: emoji.name };
  }
  const url = linkedCdnUrl(message.content);
  if (url) {
    const data = await download(url);
    return { ...data, name: (new URL(url).pathname.split("/").pop() || "asset").replace(/\.[^.]+$/, "") };
  }
  if (message.attachments && message.attachments.size) {
    const attachment = message.attachments.first();
    if (attachment.size > MAX_INPUT) throw new Error("The attachment exceeds the 10 MB input limit.");
    return {
      ...(await download(attachment.url)),
      name: attachment.name || "asset",
      contentType: String(attachment.contentType || "").toLowerCase()
    };
  }
  if (message.stickers && message.stickers.size) {
    const sticker = message.stickers.first();
    return { ...(await download(sticker.url)), name: sticker.name, stickerFormat: sticker.format };
  }
  if (message.reference && message.reference.messageId) {
    const referenced = await message.fetchReference().catch(() => null);
    if (referenced) {
      if (referenced.attachments && referenced.attachments.size) {
        const attachment = referenced.attachments.first();
        if (attachment.size > MAX_INPUT) throw new Error("The replied-to attachment exceeds the 10 MB input limit.");
        return {
          ...(await download(attachment.url)),
          name: attachment.name || "asset",
          contentType: String(attachment.contentType || "").toLowerCase()
        };
      }
      if (referenced.stickers && referenced.stickers.size) {
        const sticker = referenced.stickers.first();
        return { ...(await download(sticker.url)), name: sticker.name, stickerFormat: sticker.format };
      }
      if (options.allowEmoji) {
        const emoji = emojiSource(referenced);
        if (emoji) return { ...(await download(emoji.url)), name: emoji.name };
      }
    }
  }
  throw new Error("Attach an image/GIF, reply to a message containing an asset, provide a Discord CDN link, or include an emoji mention for .af emoji.");
}

function manageExpressionsPermission(message) {
  const flags = PermissionsBitField.Flags;
  const flag = flags.ManageGuildExpressions || flags.ManageEmojisAndStickers || flags.Administrator;
  if (!message.member.permissions.has(flag)) return "You need **Manage Expressions** permission to upload emojis or stickers.";
  const botMember = message.guild.members.me;
  if (!botMember || !botMember.permissions.has(flag)) return "I need **Manage Expressions** permission to upload emojis or stickers.";
  return null;
}

function replyCard(message, color, content, files = []) {
  return message.reply({
    components: [createCard({
      color,
      content,
      avatarURL: message.client.user.displayAvatarURL({ extension: "png", size: 128 }),
      avatarDescription: "F.R.I.D.A.Y"
    })],
    ...(files.length ? { files } : {}),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  });
}

function assetName(args, fallback) {
  const tail = args.slice(1).filter(value => !EMOJI_MENTION.test(value) && !/^https?:\/\//i.test(value));
  return cleanName(tail.join("_") || fallback || "friday_asset");
}

async function makeSticker(source) {
  const format = formatOf(source.buffer, source.contentType);
  if (format === "json") {
    if (source.buffer.length > MAX_STICKER) throw new Error("This Lottie sticker exceeds Discord's 512 KiB limit.");
    return { buffer: source.buffer, extension: "json" };
  }
  if (format === "gif" || (format === "webp" && animated(source.buffer, format))) {
    throw new Error("GIF and animated WebP files are not supported as sticker input here. Use PNG/APNG or Lottie.");
  }
  if (animated(source.buffer, format)) {
    const image = await loadImage(source.buffer);
    if (image.width === 320 && image.height === 320 && source.buffer.length <= MAX_STICKER) return { buffer: source.buffer, extension: "png" };
    throw new Error("To preserve animation, this APNG must already be 320x320 and under 512 KiB.");
  }
  const image = await loadImage(source.buffer);
  if (image.width * image.height > MAX_PIXELS) throw new Error("This image has too many pixels to process safely.");
  const canvas = createCanvas(320, 320);
  const scale = Math.min(320 / image.width, 320 / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 320, 320);
  context.drawImage(image, Math.round((320 - width) / 2), Math.round((320 - height) / 2), width, height);
  const buffer = canvas.toBuffer("image/png");
  if (buffer.length > MAX_STICKER) throw new Error("The resized sticker is still larger than 512 KiB. Try a simpler image.");
  return { buffer, extension: "png" };
}

function originalFileName(source, format) {
  const raw = String(source.name || "asset");
  if (/\.[A-Za-z0-9]{2,5}$/.test(raw)) return raw.slice(0, 100);
  const extension = format === "jpg" ? "jpg" : ["png", "gif", "webp"].includes(format) ? format : "bin";
  return raw.slice(0, 80) + "." + extension;
}

async function compressImage(source, limit) {
  const format = formatOf(source.buffer, source.contentType);
  if (source.buffer.length <= limit) return { buffer: source.buffer, name: originalFileName(source, format), unchanged: true };
  if (animated(source.buffer, format)) {
    if (source.buffer.length <= limit) return { buffer: source.buffer, name: source.name || "asset", unchanged: true };
    throw new Error("This animation exceeds the target size. AssetForge won't flatten it or remove its animation; use a larger target or an animation-aware optimizer first.");
  }
  if (!["png", "jpg", "webp"].includes(format)) throw new Error("Compression supports static PNG, JPEG and WebP images only.");
  const image = await loadImage(source.buffer);
  if (image.width * image.height > MAX_PIXELS) throw new Error("This image has too many pixels to process safely.");
  const jpeg = format === "jpg";
  const extension = jpeg ? "jpg" : "png";
  const qualities = jpeg ? [92, 84, 76, 68, 60, 52, 44, 36] : [100];
  let scale = 1;
  let best = null;
  for (let pass = 0; pass < 28; pass += 1) {
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    const quality = qualities[Math.min(pass, qualities.length - 1)];
    const output = jpeg ? canvas.toBuffer("image/jpeg", quality) : canvas.toBuffer("image/png");
    if (!best || output.length < best.buffer.length) best = { buffer: output, name: "compressed." + extension };
    if (output.length <= limit) return { buffer: output, name: "compressed." + extension, unchanged: false };
    if (!jpeg || pass >= qualities.length - 1) scale *= 0.84;
    if (width <= 24 || height <= 24) break;
  }
  if (best && best.buffer.length <= limit) return best;
  throw new Error("I couldn't reach that target without making the image too small. Try a larger limit.");
}

module.exports = function (client) {
  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;
    const parsed = await parseCommand(message);
    if (!parsed || parsed.command !== "af") return;
    const args = parsed.args || [];
    const action = String(args[0] || "").toLowerCase();
    const prefix = parsed.prefix || ".";
    try {
      if (!["emoji", "sticker", "compress"].includes(action)) {
        return replyCard(message, COLORS.SKY_BLUE,
          "# AssetForge\n\n" +
          "**" + prefix + "af emoji [name]** — import an emoji or attached image.\n" +
          "**" + prefix + "af sticker [name]** — resize and upload a supported sticker.\n" +
          "**" + prefix + "af compress 256kb** — compress a static image to a target size.\n\n" +
          "Attach an asset or reply to a message containing one. Discord CDN links are also supported.");
      }

      if (action === "compress") {
        const limit = parseLimit(args[1]);
        if (!limit) return replyCard(message, COLORS.RED,
          "**Usage:** " + TICK + prefix + "af compress 256kb" + TICK + "\n\n" +
          "Choose a size from 16 KB to 8 MB. Units: kb, mb or b.");
        const source = await sourceFromMessage(message, { allowEmoji: true });
        const result = await compressImage(source, limit);
        return replyCard(message, COLORS.GREEN,
          "# AssetForge • Compression\n\n" +
          "**Original:** " + Math.ceil(source.buffer.length / 1024) + " KB\n" +
          "**Result:** " + Math.ceil(result.buffer.length / 1024) + " KB\n" +
          "**Target:** " + Math.ceil(limit / 1024) + " KB\n" +
          "**Status:** " + (result.unchanged ? "Already within limit; original preserved." : "Compressed successfully.") +
          "\n\n-# Animation is never silently flattened.",
          [new AttachmentBuilder(result.buffer, { name: result.name })]);
      }

      const permissionIssue = manageExpressionsPermission(message);
      if (permissionIssue) return replyCard(message, COLORS.RED, permissionIssue);

      if (action === "emoji") {
        const source = await sourceFromMessage(message, { allowEmoji: true });
        const format = formatOf(source.buffer, source.contentType);
        if (!["png", "jpg", "gif"].includes(format)) {
          if (format === "webp" && !animated(source.buffer, format)) {
            const image = await loadImage(source.buffer);
            const canvas = createCanvas(image.width, image.height);
            canvas.getContext("2d").drawImage(image, 0, 0);
            source.buffer = canvas.toBuffer("image/png");
          } else {
            throw new Error("Unsupported emoji format. Use PNG, JPEG or GIF.");
          }
        }
        if (source.buffer.length > MAX_EMOJI) {
          throw new Error("This file is " + Math.ceil(source.buffer.length / 1024) + " KB; emoji uploads are limited to 256 KiB. Run " + TICK + prefix + "af compress 256kb" + TICK + " on a static image first. Animated files must be optimized without removing animation.");
        }
        const emoji = await message.guild.emojis.create({
          attachment: source.buffer,
          name: assetName(args, source.name),
          reason: "AssetForge import by " + message.author.tag
        });
        return replyCard(message, COLORS.GREEN,
          "# AssetForge • Emoji Added\n\n" +
          "**Emoji:** " + emoji + "\n" +
          "**Name:** " + TICK + emoji.name + TICK + "\n" +
          "**Animated:** " + (emoji.animated ? "Yes" : "No") + "\n" +
          "**ID:** " + TICK + emoji.id + TICK + "\n\n-# Imported by " + message.author.tag);
      }

      if (action === "sticker") {
        const source = await sourceFromMessage(message);
        const prepared = await makeSticker(source);
        const sticker = await message.guild.stickers.create({
          file: prepared.buffer,
          name: assetName(args, source.name),
          tags: "wave",
          reason: "AssetForge sticker import by " + message.author.tag
        });
        return replyCard(message, COLORS.GREEN,
          "# AssetForge • Sticker Added\n\n" +
          "**Sticker:** " + sticker.name + "\n" +
          "**ID:** " + TICK + sticker.id + TICK + "\n" +
          "**Format:** " + prepared.extension.toUpperCase() + "\n\n-# Imported by " + message.author.tag);
      }
    } catch (error) {
      console.error("[AssetForge] Command failed:", error);
      const detail = error && error.message ? error.message : "Something went wrong while processing that asset.";
      return replyCard(message, COLORS.RED, "# AssetForge\n\n" + detail).catch(() => null);
    }
  });
};
