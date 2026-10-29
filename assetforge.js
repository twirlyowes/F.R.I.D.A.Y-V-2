const axios = require("axios");
const { AttachmentBuilder, FileBuilder, MessageFlags, PermissionsBitField } = require("discord.js");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { COLORS, createCard } = require("./lib/pixelVillaUI");
const { parseCommand } = require("./lib/prefix");

const TICK = String.fromCharCode(96);
const MAX_INPUT = 10 * 1024 * 1024;
const MAX_EMOJI = 256 * 1024;
const MAX_STICKER = 512 * 1024;
const MAX_PIXELS = 12_000_000;
const MAX_SIDE = 8192;
const USER_COOLDOWN_MS = 8000;
const MAX_ACTIVE_JOBS = 1;
const userCooldowns = new Map();
let activeJobs = 0;
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const EMOJI_MENTION = /<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>/;

class AssetForgeUserError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssetForgeUserError";
  }
}

function userError(message) {
  throw new AssetForgeUserError(message);
}

function formatOf(buffer) {
  if (!Buffer.isBuffer(buffer)) return "unknown";
  if (buffer.length >= 24 &&
      buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      buffer.toString("ascii", 12, 16) === "IHDR") return "png";
  if (buffer.length >= 10 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "gif";
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "jpg";
  if (buffer.length >= 30 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP") return "webp";

  // Lottie has no binary signature; only recognize small, valid JSON documents
  // with required animation fields, then validate their schema before upload.
  if (buffer.length <= MAX_STICKER) {
    const first = buffer.toString("utf8").trimStart();
    if (first.startsWith("{")) {
      try {
        const parsed = JSON.parse(first);
        if (parsed && typeof parsed === "object" &&
            typeof parsed.v === "string" &&
            Array.isArray(parsed.layers) &&
            Number.isFinite(parsed.w) && Number.isFinite(parsed.h)) return "json";
      } catch {
        // Malformed JSON is not a supported sticker format.
      }
    }
  }
  return "unknown";
}

function readJpegDimensions(buffer) {
  let offset = 2;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sofMarkers.has(marker) && segmentLength >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function readDimensions(buffer, format = formatOf(buffer)) {
  if (format === "png") {
    if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (format === "gif") {
    if (buffer.length < 10) return null;
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (format === "jpg") return readJpegDimensions(buffer);
  if (format === "webp") {
    if (buffer.length < 30 || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === "VP8L" && buffer[20] === 0x2f) {
      const b1 = buffer[21], b2 = buffer[22], b3 = buffer[23], b4 = buffer[24];
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10)
      };
    }
    if (chunk === "VP8 " &&
        buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

function inspectImage(buffer, allowedFormats = ["png", "jpg", "webp", "gif"]) {
  const format = formatOf(buffer);
  if (!allowedFormats.includes(format)) {
    userError("Unsupported file type. Use a real PNG, JPEG, WebP, or GIF file as supported by this operation.");
  }
  const dimensions = readDimensions(buffer, format);
  if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) ||
      dimensions.width < 1 || dimensions.height < 1) {
    userError("The image header is invalid or its dimensions could not be verified.");
  }
  if (dimensions.width > MAX_SIDE || dimensions.height > MAX_SIDE ||
      dimensions.width * dimensions.height > MAX_PIXELS) {
    userError("This image is too large to process safely. The limit is " +
      MAX_PIXELS.toLocaleString("en-US") + " pixels and " + MAX_SIDE.toLocaleString("en-US") + " pixels per side.");
  }
  return { format, ...dimensions, animated: isAnimated(buffer, format) };
}

async function decodeImage(buffer) {
  try {
    return await loadImage(buffer);
  } catch {
    userError("This file could not be decoded as a supported image.");
  }
}

function validateLottie(buffer) {
  if (buffer.length > MAX_STICKER) userError("This Lottie sticker exceeds Discord's 512 KiB limit.");
  let data;
  try {
    data = JSON.parse(buffer.toString("utf8"));
  } catch {
    userError("This JSON file is not a valid Lottie sticker.");
  }
  if (!data || typeof data !== "object" ||
      typeof data.v !== "string" || data.v.length > 32 ||
      !Number.isFinite(data.fr) || data.fr < 1 || data.fr > 60 ||
      !Number.isFinite(data.ip) || !Number.isFinite(data.op) ||
      data.ip < 0 || data.op <= data.ip || data.op - data.ip > 1000 ||
      !Number.isInteger(data.w) || !Number.isInteger(data.h) ||
      data.w !== 320 || data.h !== 320 ||
      !Array.isArray(data.layers) || data.layers.length > 500 ||
      (data.assets !== undefined && !Array.isArray(data.assets))) {
    userError("This Lottie file does not meet AssetForge's supported sticker requirements (320×320 composition and valid animation metadata).");
  }
  if ((data.assets || []).some(asset => asset && typeof asset === "object" &&
      (typeof asset.p === "string" || typeof asset.u === "string"))) {
    userError("This Lottie file references external image assets. Pack the assets into a self-contained sticker first.");
  }
  return buffer;
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
  try { url = new URL(raw); } catch { throw new AssetForgeUserError("That does not look like a valid URL."); }
  if (url.protocol !== "https:" || !CDN_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AssetForgeUserError("For safety, AssetForge only downloads files hosted on Discord's CDN.");
  }
  return url.toString();
}

async function download(rawUrl) {
  const url = safeUrl(rawUrl);
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    signal: AbortSignal.timeout(20000),
    maxContentLength: MAX_INPUT,
    maxBodyLength: MAX_INPUT,
    maxRedirects: 0,
    validateStatus: status => status >= 200 && status < 300
  });
  const buffer = Buffer.from(response.data);
  if (!buffer.length) throw new AssetForgeUserError("The source file is empty.");
  if (buffer.length > MAX_INPUT) throw new AssetForgeUserError("The source exceeds the 10 MB input limit.");
  return { buffer, contentType: String(response.headers["content-type"] || "").split(";")[0].toLowerCase(), url };
}

function cleanName(value, fallback = "friday_asset", maxLength = 32) {
  const name = String(value || "").normalize("NFKD").replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, maxLength);
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
    if (attachment.size > MAX_INPUT) throw new AssetForgeUserError("The attachment exceeds the 10 MB input limit.");
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
        if (attachment.size > MAX_INPUT) throw new AssetForgeUserError("The replied-to attachment exceeds the 10 MB input limit.");
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
  throw new AssetForgeUserError("Attach an image/GIF, reply to a message containing an asset, provide a Discord CDN link, or include an emoji mention for .af emoji.");
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
  const components = [createCard({
    color,
    content,
    avatarURL: message.client.user.displayAvatarURL({ extension: "png", size: 128 }),
    avatarDescription: "F.R.I.D.A.Y"
  })];

  // Components V2 requires a File component to render an uploaded attachment inline.
  for (const file of files) {
    components.push(new FileBuilder().setURL("attachment://" + file.name));
  }

  return message.reply({
    components,
    ...(files.length ? { files } : {}),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  });
}

function assetName(args, fallback, maxLength = 32) {
  const tail = args.slice(1).filter(value => !EMOJI_MENTION.test(value) && !/^https?:\/\//i.test(value));
  return cleanName(tail.join("_") || fallback || "friday_asset", "friday_asset", maxLength);
}

async function makeSticker(source) {
  const format = formatOf(source.buffer);
  if (format === "json") {
    validateLottie(source.buffer);
    return { buffer: source.buffer, extension: "json" };
  }
  const info = inspectImage(source.buffer, ["png", "jpg", "webp", "gif"]);
  if (info.format === "gif" || (info.format === "webp" && info.animated)) {
    userError("GIF and animated WebP files are not supported as sticker input here. Use PNG/APNG or a self-contained Lottie sticker.");
  }
  if (info.animated) {
    if (info.format === "png" && info.width === 320 && info.height === 320 && source.buffer.length <= MAX_STICKER) {
      return { buffer: source.buffer, extension: "png" };
    }
    userError("To preserve animation, this APNG must already be 320×320 and under 512 KiB.");
  }
  const image = await decodeImage(source.buffer);
  const canvas = createCanvas(320, 320);
  const scale = Math.min(320 / info.width, 320 / info.height);
  const width = Math.max(1, Math.round(info.width * scale));
  const height = Math.max(1, Math.round(info.height * scale));
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 320, 320);
  context.drawImage(image, Math.round((320 - width) / 2), Math.round((320 - height) / 2), width, height);
  const buffer = await canvas.encode("png");
  if (buffer.length > MAX_STICKER) userError("The resized sticker is still larger than 512 KiB. Try a simpler image.");
  return { buffer, extension: "png" };
}

function outputNameForFormat(format) {
  const extensions = { png: "png", jpg: "jpg", webp: "webp", gif: "gif" };
  return "asset." + (extensions[format] || "bin");
}

async function compressImage(source, limit) {
  const info = inspectImage(source.buffer, ["png", "jpg", "webp", "gif"]);

  if (info.animated || info.format === "gif") {
    if (source.buffer.length <= limit) {
      return { buffer: source.buffer, name: outputNameForFormat(info.format), unchanged: true };
    }
    userError("This animation exceeds the target size. AssetForge will not flatten it or remove its animation; use a larger target or an animation-aware optimizer first.");
  }

  // Dimensions and magic bytes are validated before the decoder is called.
  const image = await decodeImage(source.buffer);
  const jpeg = info.format === "jpg";
  const webp = info.format === "webp";
  const outputFormat = jpeg ? "jpeg" : webp ? "webp" : "png";
  const extension = jpeg ? "jpg" : webp ? "webp" : "png";
  const qualities = (jpeg || webp) ? [92, 84, 76, 68, 60, 52, 44, 36] : [100];
  let scale = 1;

  for (let pass = 0; pass < 28; pass += 1) {
    const width = Math.max(1, Math.round(info.width * scale));
    const height = Math.max(1, Math.round(info.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    const quality = qualities[Math.min(pass, qualities.length - 1)];
    const output = outputFormat === "png"
      ? await canvas.encode("png")
      : await canvas.encode(outputFormat, { quality });

    if (output.length <= limit) {
      return { buffer: output, name: "compressed." + extension, unchanged: false };
    }
    if (!(jpeg || webp) || pass >= qualities.length - 1) scale *= 0.84;
    if (width <= 24 || height <= 24) break;
  }
  userError("I could not reach that target without making the image too small. Try a larger limit.");
}

module.exports = function (client) {
  client.on("messageCreate", async message => {
    if (message.author.bot || !message.guild) return;
    const parsed = await parseCommand(message);
    if (!parsed || parsed.command !== "af") return;

    const args = parsed.args || [];
    const action = String(args[0] || "").toLowerCase();
    const prefix = parsed.prefix || ".";
    let acquiredJob = false;

    try {
      if (!["emoji", "sticker", "compress"].includes(action)) {
        return await replyCard(message, COLORS.SKY_BLUE,
          "# AssetForge\n\n" +
          "**" + prefix + "af emoji [name]** — import an emoji or attached image.\n" +
          "**" + prefix + "af sticker [name]** — prepare and upload a supported sticker.\n" +
          "**" + prefix + "af compress 256kb** — sanitize and compress an image to a target size.\n\n" +
          "Attach an asset, reply to a message containing one, or use a Discord CDN link.");
      }

      const now = Date.now();
      const cooldownUntil = userCooldowns.get(message.author.id) || 0;
      if (cooldownUntil > now) {
        return await replyCard(message, COLORS.RED,
          "AssetForge is on cooldown for you. Try again <t:" + Math.ceil(cooldownUntil / 1000) + ":R>.");
      }
      if (activeJobs >= MAX_ACTIVE_JOBS) {
        return await replyCard(message, COLORS.RED,
          "AssetForge is processing another file. Please try again in a moment.");
      }
      if (userCooldowns.size > 1000) {
        for (const [userId, expires] of userCooldowns) {
          if (expires <= now) userCooldowns.delete(userId);
        }
      }
      userCooldowns.set(message.author.id, now + USER_COOLDOWN_MS);
      activeJobs += 1;
      acquiredJob = true;

      if (action === "compress") {
        const limit = parseLimit(args[1]);
        if (!limit) {
          return await replyCard(message, COLORS.RED,
            "**Usage:** " + TICK + prefix + "af compress 256kb" + TICK + "\n\n" +
            "Choose a size from 16 KB to 8 MB. Units: kb, mb or b.");
        }
        const source = await sourceFromMessage(message, { allowEmoji: true });
        const result = await compressImage(source, limit);
        return await replyCard(message, COLORS.GREEN,
          "# AssetForge • Compression\n\n" +
          "**Original:** " + Math.ceil(source.buffer.length / 1024) + " KB\n" +
          "**Result:** " + Math.ceil(result.buffer.length / 1024) + " KB\n" +
          "**Target:** " + Math.ceil(limit / 1024) + " KB\n" +
          "**Status:** " + (result.unchanged ? "Verified animation preserved; already within limit." : "Compressed and re-encoded successfully. Metadata stripped from static images.") +
          "\n\n-# Animation is never silently flattened.",
          [new AttachmentBuilder(result.buffer, { name: result.name })]);
      }

      const permissionIssue = manageExpressionsPermission(message);
      if (permissionIssue) return await replyCard(message, COLORS.RED, permissionIssue);

      if (action === "emoji") {
        const source = await sourceFromMessage(message, { allowEmoji: true });
        const info = inspectImage(source.buffer, ["png", "jpg", "webp", "gif"]);
        if (info.animated && info.format !== "gif") {
          userError("Animated PNG/WebP files cannot be imported as animated Discord emoji here. Provide a GIF to preserve animation or a static image.");
        }
        if (info.format === "webp") {
          const image = await decodeImage(source.buffer);
          const canvas = createCanvas(info.width, info.height);
          canvas.getContext("2d").drawImage(image, 0, 0);
          source.buffer = await canvas.encode("png");
        }
        if (source.buffer.length > MAX_EMOJI) {
          userError("This file is " + Math.ceil(source.buffer.length / 1024) +
            " KB; emoji uploads are limited to 256 KiB. Run " + TICK + prefix +
            "af compress 256kb" + TICK + " on a static image first. Animated files must be optimized without removing animation.");
        }
        const emoji = await message.guild.emojis.create({
          attachment: source.buffer,
          name: assetName(args, source.name, 32),
          reason: "AssetForge import by " + message.author.tag + " (" + message.author.id + ")"
        });
        return await replyCard(message, COLORS.GREEN,
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
          name: assetName(args, source.name, 30),
          tags: "😀",
          reason: "AssetForge sticker import by " + message.author.tag + " (" + message.author.id + ")"
        });
        return await replyCard(message, COLORS.GREEN,
          "# AssetForge • Sticker Added\n\n" +
          "**Sticker:** " + sticker.name + "\n" +
          "**ID:** " + TICK + sticker.id + TICK + "\n" +
          "**Format:** " + prepared.extension.toUpperCase() + "\n\n-# Imported by " + message.author.tag);
      }
    } catch (error) {
      // Avoid dumping Axios errors or signed CDN URLs into user-visible output/logs.
      console.warn("[AssetForge] Request failed:", {
        name: error && error.name ? error.name : "UnknownError",
        code: error && typeof error.code === "string" ? error.code : undefined,
        status: error && error.response && Number.isInteger(error.response.status) ? error.response.status : undefined
      });
      const userMessage = error instanceof AssetForgeUserError
        ? error.message
        : "AssetForge could not process that file. Check that it is a supported image, try a smaller file, or try again later.";
      return await replyCard(message, COLORS.RED, "# AssetForge\n\n" + userMessage).catch(() => null);
    } finally {
      if (acquiredJob) activeJobs = Math.max(0, activeJobs - 1);
    }
  });
};

module.exports.__test = Object.freeze({
  formatOf,
  readDimensions,
  inspectImage,
  parseLimit,
  validateLottie,
  AssetForgeUserError
});
