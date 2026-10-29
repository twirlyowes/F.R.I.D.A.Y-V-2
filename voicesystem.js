// Location: voicesystem.js
const {
  ChannelType,
  PermissionsBitField,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags
} = require("discord.js");
const db = require("./firebase");

const guildConfig = require("./lib/guildConfig");
const { parseCommand, getPrefix } = require("./lib/prefix");

// Active temporary channels tracker: Map<ChannelID, OwnerID>
const activeTempChannels = new Map();

// 2. Optimized VC Command Whitelist stored as a Set for O(1) lookups
const VALID_VC_COMMANDS = new Set([
  "vclock",
  "vcunlock",
  "vchide",
  "vcunhide",
  "vcname",
  "vclimit",
  "vcadd",
  "vcremove",
  "vckick",
  "vcp",
  "vcowner",
  "vcsync"
]);

// ---- Components V2 card helpers (embed -> card conversion only) ----
const CARD_COLORS = {
  BLURPLE: 0x5865F2,
  GREEN: 0x57f287,
  RED: 0xed4245
};

// Simple single-block card: title/description/fields all rendered as text content
function buildCard({ color, title, description, fields, footer }) {
  const container = new ContainerBuilder().setAccentColor(color);

  let content = "";
  if (title) content += `### ${title}\n`;
  if (description) content += `${description}`;
  if (content) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
  }

  if (fields && fields.length) {
    for (const field of fields) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**${field.name}**\n${field.value}`)
      );
    }
  }

  if (footer) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
  }

  return container;
}

// Helper functions for JSONBin API communication with robust error handling and retries
async function loadVoiceChannels() {
  const snapshot = await db.collection("voiceChannels").get();

  const channels = {};

  snapshot.forEach(doc => {
    channels[doc.id] = doc.data();
  });

  return { channels };
}

async function saveVoiceChannel(id, data) {
  // Keep guildId/createdAt when ownership is transferred. Replacing the whole
  // document here used to orphan the channel from startup restoration.
  await db.collection("voiceChannels")
    .doc(id)
    .set(data, { merge: true });
}

async function deleteVoiceChannel(id) {
  await db.collection("voiceChannels")
    .doc(id)
    .delete();
}

// Return null only when Discord confirms the channel no longer exists.
// Return undefined for transient/API/permission failures so its record is preserved.
async function fetchTrackedChannel(guild, channelId) {
  try {
    return await guild.channels.fetch(channelId);
  } catch (error) {
    if (Number(error?.code) === 10003) return null; // Unknown Channel
    console.error(`[VoiceSystem] Could not fetch tracked channel ${channelId}; preserving it for retry:`, error);
    return undefined;
  }
}
      

module.exports = (client) => {

  // 3. Restore and clean up tracked temporary channels using their recorded guildId.
  // A guild being unavailable must not cause another guild's channel record to be deleted.
  client.once("ready", async () => {
    try {
      console.log(`[VoiceSystem] Bot logged in as ${client.user.tag}. Restoring temporary voice channels...`);
      const { channels: savedChannels = {} } = await loadVoiceChannels();

      for (const [channelId, channelData] of Object.entries(savedChannels)) {
        const guildId = channelData.guildId;
        if (!guildId) {
          console.warn(`[VoiceSystem] Skipping legacy voice record without guildId: ${channelId}`);
          continue;
        }

        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        const channel = await fetchTrackedChannel(guild, channelId);
        if (channel === undefined) continue;
        if (channel === null) {
          await deleteVoiceChannel(channelId).catch(err =>
            console.error(`[VoiceSystem] Failed removing stale channel record ${channelId}:`, err)
          );
          activeTempChannels.delete(channelId);
          console.log(`[VoiceSystem] Removed stale temporary-channel record: ${channelId}`);
          continue;
        }

        if (channel.type !== ChannelType.GuildVoice) {
          console.warn(`[VoiceSystem] Saved temp channel ${channelId} is not a voice channel; removing its record.`);
          await deleteVoiceChannel(channelId).catch(err =>
            console.error(`[VoiceSystem] Failed removing invalid channel record ${channelId}:`, err)
          );
          continue;
        }

        // Apply the same Create-VC safeguard during startup restoration too,
        // before the older Firestore-tracked cleanup path can remove anything.
        const savedGuildConfig = await guildConfig.get(guildId);
        const looksLikeCreateChannel =
          /join[\s_-]*to[\s_-]*create|create[\s_-]*vc|create[\s_-]*voice(?:[\s_-]*channel)?/i.test(channel.name || "");
        if (channelId === savedGuildConfig.voiceCreate || looksLikeCreateChannel) {
          activeTempChannels.delete(channelId);
          console.log(`[VoiceSystem] Preserving Join-to-Create channel during startup: ${channel.name} (${channelId}) in guild ${guildId}`);
          continue;
        }

        if (!hasVoiceMembers(channel, guild)) {
          try {
            await channel.delete("FRIDAY startup cleanup: empty temporary voice channel");
            await deleteVoiceChannel(channelId);
            activeTempChannels.delete(channelId);
            console.log(`[VoiceSystem] Deleted empty temporary channel on startup: ${channel.name} (${channelId})`);
          } catch (err) {
            activeTempChannels.set(channelId, channelData.owner);
            console.error(`[VoiceSystem] Could not delete empty startup channel ${channelId}; will retry:`, err);
          }
          continue;
        }

        activeTempChannels.set(channelId, channelData.owner);
        console.log(`[VoiceSystem] Restored temp channel ${channelId} -> owner ${channelData.owner}`);
      }

      // Retry missed events and transient Discord API failures once per minute.
      if (!client.voiceTempCleanupInterval) {
        client.voiceTempCleanupInterval = setInterval(() => {
          cleanupEmptyVoiceChannels(client).catch(err =>
            console.error("[VoiceSystem] Periodic cleanup sweep failed:", err)
          );
        }, 60_000);
        client.voiceTempCleanupInterval.unref?.();
      }
      await cleanupEmptyVoiceChannels(client);
    } catch (err) {
      console.error("[VoiceSystem] Startup voice channel restoration failed:", err);
    }
  });

  // 4. Optimized findTargetMember function with tiered search strategy
  async function findTargetMember(message, args) {
    // 1. Check Mention
    let targetMember = message.mentions.members.first();
    if (targetMember) return targetMember;

    if (args.length === 0) return null;  

    const query = args.join(" ").toLowerCase();  
      
    // 2. Check User ID
    const rawId = query.replace(/[<@!>]/g, "");  
    if (/^\d+$/.test(rawId)) {  
      const fetched = await message.guild.members.fetch(rawId).catch(() => null);  
      if (fetched) return fetched;  
    }  

    // 3. Search in cached members first
    let cachedMatch = message.guild.members.cache.find(m =>   
      m.user.username.toLowerCase().includes(query) ||  
      (m.user.globalName && m.user.globalName.toLowerCase().includes(query)) ||  
      (m.nickname && m.nickname.toLowerCase().includes(query))  
    );
    if (cachedMatch) return cachedMatch;

    // 4. Fallback: Full guild members fetch only as a last resort
    await message.guild.members.fetch().catch(() => {});  
    return message.guild.members.cache.find(m =>   
      m.user.username.toLowerCase().includes(query) ||  
      (m.user.globalName && m.user.globalName.toLowerCase().includes(query)) ||  
      (m.nickname && m.nickname.toLowerCase().includes(query))  
    );
  }

  // Track deletion actions to prevent duplicate deletion attempts.
  const deletionTracker = new Set();

  function hasVoiceMembers(channel, guild) {
    // channel.members is derived from cached GuildMembers. VoiceState cache also
    // protects against deleting an occupied room when a member isn't in cache.
    const hasVoiceState = guild.voiceStates?.cache?.some(state => state.channelId === channel.id) === true;
    return channel.members.size > 0 || hasVoiceState;
  }

  async function cleanupEmptyVoiceChannelsForGuild(guild) {
    const cfg = await guildConfig.get(guild.id);
    const createChannelId = cfg.voiceCreate || null;

    // Fetch the current channel list so orphaned rooms created by an earlier
    // bot process are cleaned even when they have no Firestore record.
    let channels;
    let channelFetchSucceeded = false;
    try {
      channels = await guild.channels.fetch();
      channelFetchSucceeded = true;
    } catch (error) {
      console.error(`[VoiceSystem] Could not refresh channels in guild ${guild.id}; using cache for cleanup:`, error);
      channels = guild.channels.cache;
    }

    // Prefer the explicitly configured category. If that setting is stale or
    // missing, derive it from the configured Join-to-Create channel's parent.
    let categoryId = cfg.voiceCategory || null;
    let category = categoryId
      ? (channels.get(categoryId) || guild.channels.cache.get(categoryId))
      : null;
    if (!category || category.type !== ChannelType.GuildCategory) {
      const createChannel = createChannelId
        ? (channels.get(createChannelId) || guild.channels.cache.get(createChannelId))
        : null;
      const fallbackCategoryId = createChannel?.parentId;
      const fallbackCategory = fallbackCategoryId
        ? (channels.get(fallbackCategoryId) || guild.channels.cache.get(fallbackCategoryId))
        : null;
      if (fallbackCategory?.type === ChannelType.GuildCategory) {
        categoryId = fallbackCategoryId;
        category = fallbackCategory;
        console.warn(`[VoiceSystem] Using Join-to-Create parent category ${categoryId} as the voice cleanup category for guild ${guild.id}.`);
      }
    }

    if (!category || category.type !== ChannelType.GuildCategory || !categoryId) {
      console.warn(`[VoiceSystem] No valid configured/Join-to-Create parent category in guild ${guild.id}; skipping empty-channel cleanup safely.`);
      return;
    }

    const createChannel = createChannelId
      ? (channels.get(createChannelId) || guild.channels.cache.get(createChannelId))
      : null;
    // Use the name fallback only when the configured ID is absent/unresolvable.
    // If the ID resolves, it is the sole protected Join-to-Create channel; this
    // avoids preserving unrelated empty rooms just because their name matches.
    const useNameFallback = !createChannelId || !createChannel;

    for (const channel of channels.values()) {
      if (!channel || channel.type !== ChannelType.GuildVoice) continue;
      if (channel.parentId !== categoryId) continue;

      const looksLikeCreateChannel =
        /join[\s_-]*to[\s_-]*create|create[\s_-]*vc|create[\s_-]*voice(?:[\s_-]*channel)?/i.test(channel.name || "");
      if (channel.id === createChannelId || (useNameFallback && looksLikeCreateChannel)) {
        console.log(`[VoiceSystem] Preserving Join-to-Create channel: ${channel.name} (${channel.id}) in guild ${guild.id}`);
        continue;
      }
      if (hasVoiceMembers(channel, guild) || deletionTracker.has(channel.id)) continue;

      deletionTracker.add(channel.id);
      try {
        await channel.delete("FRIDAY cleanup: empty voice channel inside the configured voice category");
        activeTempChannels.delete(channel.id);
        await deleteVoiceChannel(channel.id).catch(err =>
          console.error(`[VoiceSystem] Channel ${channel.id} was deleted but its Firestore record could not be removed:`, err)
        );
        console.log(`[VoiceSystem] Deleted empty voice channel from category: ${channel.name} (${channel.id}) in guild ${guild.id}`);
      } catch (err) {
        console.error(`[VoiceSystem] Could not delete empty voice channel ${channel.id} in guild ${guild.id}; will retry:`, err);
      } finally {
        deletionTracker.delete(channel.id);
      }
    }
  }

  async function cleanupEmptyVoiceChannels(clientInstance) {
    for (const guild of clientInstance.guilds.cache.values()) {
      try {
        await cleanupEmptyVoiceChannelsForGuild(guild);
      } catch (error) {
        console.error(`[VoiceSystem] Voice-category cleanup failed in guild ${guild.id}:`, error);
      }
    }
  }

  // 1. Monitor Voice State Updates (Join to Create & Auto Delete)
  client.on("voiceStateUpdate", async (oldState, newState) => {
    const member = newState.member || oldState.member;
    if (!member) return;

    // Per-server settings (.config set voiceCreate / voiceCategory)
    const cfg = await guildConfig.get(newState.guild.id);
    const CREATE_CHANNEL_ID = cfg.voiceCreate || null;
    const TARGET_CATEGORY_ID = cfg.voiceCategory || null;

    // User (not a bot) joined the "Join to Create" channel.
    // FIX: bots must NOT be excluded from this whole handler (see below) —
    // only room *creation* should be a humans-only action. The bot-blanket
    // check used to sit above both branches, which also skipped auto-delete
    // for bots (see the leave-detection block below).
    if (CREATE_CHANNEL_ID && newState.channelId === CREATE_CHANNEL_ID && !member.user.bot) {  
      try {  
        const guild = newState.guild;  
        const displayName = member.displayName || member.user.username;  
        const channelName = `${displayName}'s Room`;  

        let categoryOverwrites = [];  
        if (TARGET_CATEGORY_ID) {  
          // SPEED: check cache first, only hit the API if it's somehow not cached.
          const categoryChannel = guild.channels.cache.get(TARGET_CATEGORY_ID)
            || await guild.channels.fetch(TARGET_CATEGORY_ID).catch(() => null);  
          if (categoryChannel && categoryChannel.type === ChannelType.GuildCategory) {  
            categoryOverwrites = categoryChannel.permissionOverwrites.cache.map(overwrite => ({  
              id: overwrite.id,  
              type: overwrite.type,  
              allow: overwrite.allow,  
              deny: overwrite.deny,  
            }));  
          }  
        }  

        const ownerOverwrite = {  
          id: member.id,  
          allow: [  
            PermissionsBitField.Flags.Connect,  
            PermissionsBitField.Flags.ManageChannels,  
            PermissionsBitField.Flags.MuteMembers,  
            PermissionsBitField.Flags.DeafenMembers,  
            PermissionsBitField.Flags.MoveMembers,  
            PermissionsBitField.Flags.ViewChannel  
          ],  
        };  

        const existingOwnerIndex = categoryOverwrites.findIndex(o => o.id === member.id);  
        if (existingOwnerIndex !== -1) {  
          const existing = categoryOverwrites[existingOwnerIndex];  
          const combinedAllow = new PermissionsBitField(existing.allow).add(ownerOverwrite.allow);  
          categoryOverwrites[existingOwnerIndex].allow = combinedAllow;  
        } else {  
          categoryOverwrites.push(ownerOverwrite);  
        }  

        const tempChannel = await guild.channels.create({  
          name: channelName,  
          type: ChannelType.GuildVoice,  
          parent: TARGET_CATEGORY_ID || newState.channel?.parentId || null,  
          permissionOverwrites: categoryOverwrites,  
        });  

        // Move the user in immediately — this is the step they're waiting on.
        await member.voice.setChannel(tempChannel);  
          
        activeTempChannels.set(tempChannel.id, member.id);  
        console.log(`[VoiceSystem] Created new temp channel: ${tempChannel.name} (${tempChannel.id}) for owner: ${member.user.tag}`);

        // SPEED: Firebase persistence and the control-panel card don't need
        // to finish before the user is in their channel — fire them off
        // without awaiting instead of blocking on them sequentially.
        saveVoiceChannel(tempChannel.id, {
          owner: member.id,
          createdAt: Date.now(),
          guildId: guild.id
        }).catch(err => console.error("[VoiceSystem] Failed to persist new temp channel:", err));

        const prefix = await getPrefix(guild.id);

        const controlCard = buildCard({
          color: CARD_COLORS.BLURPLE,
          title: "🎙️ Temporary Voice Control Panel",
          description:
`${member}, welcome to your private voice channel!

<:Shield_2:1532989398642327594> **Channel Owner**
> ${member}

<a:settings:1532990547394957393> **Manage your room using these commands:**`,
          fields: [
            {
              name: "<a:sparkles:1532986077651140620> Voice Commands",
              value:
"`" + prefix + "vclock` • Lock your room\n" +
"`" + prefix + "vcunlock` • Unlock your room\n" +
"`" + prefix + "vchide` • Hide your room\n" +
"`" + prefix + "vcunhide` • Show your room\n" +
"`" + prefix + "vcname [name]` • Rename channel\n" +
"`" + prefix + "vclimit [number]` • Set user limit\n" +
"`" + prefix + "vcadd @user` • Allow user\n" +
"`" + prefix + "vcremove @user` • Remove user\n" +
"`" + prefix + "vckick @user` • Kick user\n" +
"`" + prefix + "vcowner @user` • Transfer ownership"
            }
          ],
          footer: `F.R.I.D.A.Y • Voice Management • ${new Date().toLocaleString()}`
        });

        tempChannel.send({ components: [controlCard], flags: MessageFlags.IsComponentsV2 })
          .catch(err => console.error("[VoiceSystem] Failed to send control panel:", err));

      } catch (error) {  
        console.error("Error creating temporary voice channel:", error);  
      }  
    }  

    // When anyone leaves a voice channel, scan the configured voice category
    // rather than relying on activeTempChannels. This also cleans up empty rooms
    // that predate this process or were never recorded in Firestore.
    if (
      oldState.channelId &&
      oldState.channelId !== newState.channelId &&
      oldState.channelId !== CREATE_CHANNEL_ID
    ) {
      const leftGuild = oldState.guild;
      (async () => {
        try {
          // Allow Discord.js voice-state caches to settle before checking emptiness.
          await new Promise(resolve => setTimeout(resolve, 1200));
          await cleanupEmptyVoiceChannelsForGuild(leftGuild);
        } catch (err) {
          console.error(`[VoiceSystem] Auto-cleanup after voice leave failed in guild ${leftGuild.id}:`, err);
        }
      })();
    }
  }); // closes voiceStateUpdate
  // 2. Handle Owner Customizations & Commands with Set Lookup & Early Ignoring
  client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    const parsed = await parseCommand(message);
    if (!parsed) return;

    const { command, args } = parsed;  

    // Check whitelist using Set.has() and ignore non-VC messages before logging or processing
    if (!VALID_VC_COMMANDS.has(command)) return;

    const memberChannel = message.member?.voice?.channel;  
    if (!memberChannel || !activeTempChannels.has(memberChannel.id)) return;  

    const ownerId = activeTempChannels.get(memberChannel.id);  
    const isOwner = ownerId === message.author.id;  

    console.log(`[VoiceSystem Command] Command detected: ${command} by user ${message.author.tag} in channel ${memberChannel.name} (Is Owner: ${isOwner})`);

    const notOwnerCard = buildCard({
      color: CARD_COLORS.RED,
      description: "<:error_g:1561271715164721245> Only the **owner** of this temporary voice channel can use these controls."
    });

    // LOCK COMMAND  
    if (command === "vclock") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      await memberChannel.permissionOverwrites.edit(message.guild.id, { Connect: false });  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: "<:lock:1532337641494937651> Voice channel has been **locked**." })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // UNLOCK COMMAND  
    if (command === "vcunlock") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      await memberChannel.permissionOverwrites.edit(message.guild.id, { Connect: true });  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: "<:unlock:1532337553217294528> Voice channel has been **unlocked**." })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // HIDE COMMAND  
    if (command === "vchide") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      await memberChannel.permissionOverwrites.edit(message.guild.id, { ViewChannel: false });  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: "<:hide:1532336151854190743> Voice channel is now **hidden**." })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // UNHIDE COMMAND  
    if (command === "vcunhide") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      await memberChannel.permissionOverwrites.edit(message.guild.id, { ViewChannel: true });  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: "<:unhide:1532336276164841482> Voice channel is now **visible**." })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // RENAME COMMAND  
    if (command === "vcname") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const newName = args.join(" ");  
      if (!newName) return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please provide a new name. (e.g., `vcname Chill Lounge`)" })], flags: MessageFlags.IsComponentsV2 });  
        
      await memberChannel.setName(newName);  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:name:1532337141214871622> Channel renamed to **${newName}**.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // USER LIMIT COMMAND  
    if (command === "vclimit") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const limit = parseInt(args[0], 10);  
      if (isNaN(limit) || limit < 0 || limit > 99) {  
        return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid limit between 0 and 99." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      await memberChannel.setUserLimit(limit);  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:limit:1532340516249931826> User limit set to **${limit === 0 ? "Unlimited" : limit}**.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // ADD / PERMIT COMMAND  
    if (command === "vcadd") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const targetMember = await findTargetMember(message, args);  
        
      if (!targetMember) {  
        return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid user name or mention to add to your channel." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      await memberChannel.permissionOverwrites.edit(targetMember.id, {   
        Connect: true,   
        ViewChannel: true   
      });  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:add:1532337807765278801> Added **${targetMember.user.tag}** to your channel permissions.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // REMOVE / REVOKE COMMAND  
    if (command === "vcremove") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const targetMember = await findTargetMember(message, args);  

      if (!targetMember) {  
        return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid user name or mention to remove from your channel permissions." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      if (targetMember.id === ownerId) {  
        return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:error_g:1561271715164721245> You cannot remove permissions for yourself." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      await memberChannel.permissionOverwrites.delete(targetMember.id).catch(() => {});  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:remove:1532337229907759124> Revoked channel permissions for **${targetMember.user.tag}**.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // KICK COMMAND  
    if (command === "vckick") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const targetMember = await findTargetMember(message, args);  

      if (!targetMember || targetMember.voice.channelId !== memberChannel.id) {  
        return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid user who is currently inside your voice channel." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      await targetMember.voice.disconnect();  
      return await message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:kick:1532337429426471044> Kicked **${targetMember.user.tag}** from your channel.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // 1. TRANSFER OWNERSHIP COMMAND (`vcowner`)
    if (command === "vcowner") {  
      if (!isOwner) return await message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const targetMember = await findTargetMember(message, args);  

      if (!targetMember || targetMember.voice.channelId !== memberChannel.id) {  
        return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid user who is currently inside your voice channel." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      if (targetMember.id === ownerId) {  
        return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> You are already the owner of this channel." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      try {  
        await memberChannel.permissionOverwrites.edit(ownerId, {  
          ManageChannels: false,  
          MoveMembers: false,  
          MuteMembers: false,  
          DeafenMembers: false  
        }).catch(() => {});  

        await memberChannel.permissionOverwrites.edit(targetMember.id, {  
          Connect: true,  
          ViewChannel: true,  
          ManageChannels: true,  
          MoveMembers: true,  
          MuteMembers: true,  
          DeafenMembers: true  
        });  

        activeTempChannels.set(memberChannel.id, targetMember.id);  
        console.log(`[VoiceSystem Ownership] Transferred ownership of channel ${memberChannel.id} to new owner ID: ${targetMember.id}`);

        await saveVoiceChannel(memberChannel.id, {
  owner: targetMember.id,
  updatedAt: Date.now()
});

        const successCard = buildCard({
          color: CARD_COLORS.GREEN,
          description: `<:owner:1532337324762075146> Ownership transferred to ${targetMember}.`
        });

        return await message.reply({ components: [successCard], flags: MessageFlags.IsComponentsV2 });  
      } catch (error) {  
        console.error("Error transferring ownership:", error);  
        return await message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:error_g:1561271715164721245> An error occurred while transferring ownership." })], flags: MessageFlags.IsComponentsV2 });  
      }  
    }
  });
};
