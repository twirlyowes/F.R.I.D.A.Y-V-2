const guildConfig = require("./lib/guildConfig");

const CHECK_INTERVAL = 5 * 60 * 1000;
const FEED_LIMIT = 15;
const HISTORY_PAGES = 5;

let client = null;
let checking = false;

// channel URL -> UC... channel ID
const resolvedIds = new Map();

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`);
  }

  return response.text();
}

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .trim();
}

function getTag(entry, tag) {
  const match = entry.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")
  );
  return match ? decodeXml(match[1]) : null;
}

async function resolveChannelId(channelUrl) {
  if (resolvedIds.has(channelUrl)) return resolvedIds.get(channelUrl);

  const html = await fetchText(channelUrl);

  const patterns = [
    /"channelId":"(UC[a-zA-Z0-9_-]{22})"/,
    /"externalId":"(UC[a-zA-Z0-9_-]{22})"/,
    /"browseId":"(UC[a-zA-Z0-9_-]{22})"/,
    /channel\/(UC[a-zA-Z0-9_-]{22})/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match) {
      resolvedIds.set(channelUrl, match[1]);
      console.log(`[YouTube] Resolved ${channelUrl} -> ${match[1]}`);
      return match[1];
    }
  }

  throw new Error(`Could not resolve the YouTube channel ID for ${channelUrl}.`);
}

async function getRecentVideos(channelUrl) {
  const id = await resolveChannelId(channelUrl);

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
  const xml = await fetchText(feedUrl);

  const authorMatch = xml.match(/<author>\s*<name>([^<]*)<\/name>/i);
  const author = authorMatch ? decodeXml(authorMatch[1]) : "YouTube";

  const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .slice(0, FEED_LIMIT)
    .map(match => {
      const entry = match[1];
      const videoId = getTag(entry, "yt:videoId");

      if (!videoId) return null;

      return {
        id: videoId,
        title: getTag(entry, "media:title") || "New upload",
        published: getTag(entry, "published"),
        url: `https://www.youtube.com/watch?v=${videoId}`
      };
    })
    .filter(Boolean);

  return { author, videos };
}

async function getNotificationChannel(guild, channelId) {
  const channel = await guildConfig.resolveChannel(guild, channelId);

  if (!channel || !channel.isTextBased()) {
    throw new Error(
      `Discord channel ${channelId} could not be found or is not text-based.`
    );
  }

  return channel;
}

function extractYouTubeVideoIds(text = "") {
  const ids = new Set();

  const patterns = [
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s<]*\bv=([a-zA-Z0-9_-]{11})/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:[^a-zA-Z0-9_-]|$)/gi,
    /https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[^a-zA-Z0-9_-]|$)/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) ids.add(match[1]);
    }
  }

  return ids;
}

async function getAlreadyPostedVideoIds(channel) {
  const ids = new Set();
  let before;

  for (let page = 0; page < HISTORY_PAGES; page++) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    if (!messages.size) break;

    for (const message of messages.values()) {
      for (const id of extractYouTubeVideoIds(message.content)) {
        ids.add(id);
      }
    }

    before = messages.last().id;

    if (messages.size < 100) break;
  }

  return ids;
}
async function sendNotification(channel, video, author) {
  await channel.send({
    content: `@everyone 📢 **${author} uploaded a new video**\n${video.title}\n${video.url}`,
    allowedMentions: { parse: ["everyone"] }
  });

  console.log(`[YouTube] Sent notification in ${channel.guild.name}: ${video.title}`);
}

async function checkGuild(guild, cfg, feedCache) {
  const channel = await getNotificationChannel(guild, cfg.youtubeChannel);

  if (!feedCache.has(cfg.youtubeUrl)) {
    feedCache.set(cfg.youtubeUrl, await getRecentVideos(cfg.youtubeUrl));
  }

  const { author, videos } = feedCache.get(cfg.youtubeUrl);
  if (!videos.length) return;

  const postedIds = await getAlreadyPostedVideoIds(channel);

  const missing = videos
    .filter(video => !postedIds.has(video.id))
    .sort((a, b) => {
      const aTime = Date.parse(a.published || "") || 0;
      const bTime = Date.parse(b.published || "") || 0;
      return aTime - bTime;
    });

  for (const video of missing) {
    await sendNotification(channel, video, author);
  }
}

async function checkYouTube() {
  if (checking || !client?.isReady()) return;
  checking = true;

  try {
    const feedCache = new Map();

    for (const guild of client.guilds.cache.values()) {
      const cfg = await guildConfig.get(guild.id);

      if (!cfg.youtubeChannel || !cfg.youtubeUrl) continue;

      try {
        await checkGuild(guild, cfg, feedCache);
      } catch (error) {
        console.error(`[YouTube] Check failed for ${guild.name}:`, error);
      }
    }
  } catch (error) {
    console.error("[YouTube] Check failed:", error);
  } finally {
    checking = false;
  }
}

module.exports = function startYouTube(discordClient) {
  client = discordClient;

  console.log("[YouTube] Notification system started (per-server settings).");

  const start = () => {
    checkYouTube();
    setInterval(checkYouTube, CHECK_INTERVAL);
  };

  if (client.isReady()) {
    start();
  } else {
    client.once("clientReady", start);
  }
};
