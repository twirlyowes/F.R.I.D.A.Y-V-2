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
const { extractSnowflake, parseStrictInteger } = require("./lib/commandArgs");

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
  "vcowner"
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
  await db.collection("voiceChannels")
    .doc(id)
    .set(data);
}

async function deleteVoiceChannel(id) {
  await db.collection("voiceChannels")
    .doc(id)
    .delete();
}
      

module.exports = (client) => {

  // 3. Safer startup cleanup: Only delete channels tracked in JSONBin storage
  client.once("ready", async () => {
    try {
      console.log(`[VoiceSystem] Bot logged in as ${client.user.tag}. Running startup sweep and restoration...`);
      const binData = await loadVoiceChannels();
      if (!binData.channels) binData.channels = {};

      let dataChanged = false;  

      for (const guild of client.guilds.cache.values()) {  
        const channels = await guild.channels.fetch().catch(() => new Map());  

        // Restore active temporary channels from JSONBin into Map with thorough checks  
        for (const [channelId, channelData] of Object.entries(binData.channels)) {  
          const targetChannel = channels.get(channelId);  

          if (!targetChannel || targetChannel.type !== ChannelType.GuildVoice) {  
            delete binData.channels[channelId];  
            dataChanged = true;  
            console.log(`[VoiceSystem] Removed non-existent channel from JSONBin record: ${channelId}`);
          } else if (targetChannel.members.size === 0) {  
            await targetChannel.delete().catch(() => {});  
            delete binData.channels[channelId];  
            dataChanged = true;  
            console.log(`[VoiceSystem] Cleaned up tracked empty temp channel on startup: ${targetChannel.name}`);  
          } else {  
            activeTempChannels.set(channelId, channelData.owner);  
            console.log(`[VoiceSystem] Restored ownership for channel ID ${channelId} -> Owner ID: ${channelData.owner}`);
          }  
        }  
      }  

      if (dataChanged) {  
        for (const [id, data] of Object.entries(binData.channels)) {
  await saveVoiceChannel(id, data);
        }
      }  
    } catch (err) {  
      console.error("Error during startup voice channel cleanup sweep & JSONBin sync:", err);  
    }
  });

  // 4. Optimized findTargetMember function with tiered search strategy
  async function findTargetMember(message, args) {
    if (!Array.isArray(args) || args.length === 0) return null;
    const firstId = extractSnowflake(args[0]);
    if (firstId) return args.length === 1 ? (message.guild.members.cache.get(firstId) || await message.guild.members.fetch(firstId).catch(() => null)) : null;
    const query = args.join(" ").trim().toLowerCase();
    if (!query) return null;
    const members = [...message.guild.members.cache.values()];
    const names = member => [member.user.username, member.user.globalName, member.displayName, member.nickname].filter(Boolean).map(value => value.toLowerCase());
    const uniqueById = list => [...new Map(list.map(member => [member.id, member])).values()];
    const exact = uniqueById(members.filter(member => names(member).some(name => name === query)));
    const candidates = exact.length ? exact : uniqueById(members.filter(member => names(member).some(name => name.includes(query))));
    return candidates.length === 1 ? candidates[0] : null;
  }

  // Track deletion actions to prevent duplicate deletion attempts
  const deletionTracker = new Set();

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

    // Check if someone left a channel (instant auto-delete, no artificial delay).
    // FIX: this block now runs for EVERY member, bots included — a music bot
    // leaving a temp channel now correctly triggers cleanup instead of being
    // skipped by the old function-wide "if (member.user.bot) return".
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const channelId = oldState.channelId;

      if (
        channelId !== CREATE_CHANNEL_ID &&
        !deletionTracker.has(channelId)
      ) {
        deletionTracker.add(channelId);

        (async () => {
          try {
            // SPEED: read straight from cache instead of polling with delays.
            // Discord.js updates the guild's voice state cache synchronously
            // before this event fires, so the member count here is current
            // in the overwhelming majority of cases.
            const leftChannel = oldState.guild.channels.cache.get(channelId);

            if (
              !leftChannel ||
              leftChannel.type !== ChannelType.GuildVoice ||
              !activeTempChannels.has(channelId)
            ) {
              return;
            }

            if (leftChannel.members.size > 0) {
              return;
            }

            await leftChannel.delete().catch(() => {});

            activeTempChannels.delete(channelId);

            await deleteVoiceChannel(channelId);

            console.log(`[VoiceSystem] Deleted empty temporary channel: ${channelId}`);

          } catch (err) {
            console.error("[VoiceSystem] Auto delete error:", err);
          } finally {
            deletionTracker.delete(channelId);
          }
        })();
      }
    } // closes oldState.channelId if
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
      if (args.length) return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "Usage: vclock (no extra arguments)." })], flags: MessageFlags.IsComponentsV2 });
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      await memberChannel.permissionOverwrites.edit(message.guild.id, { Connect: false });  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: "<:lock:1532337641494937651> Voice channel has been **locked**." })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // UNLOCK COMMAND  
    if (command === "vcunlock") {  
      if (args.length) return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "Usage: vcunlock (no extra arguments)." })], flags: MessageFlags.IsComponentsV2 });
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      await memberChannel.permissionOverwrites.edit(message.guild.id, { Connect: true });  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: "<:unlock:1532337553217294528> Voice channel has been **unlocked**." })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // HIDE COMMAND  
    if (command === "vchide") {  
      if (args.length) return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "Usage: vchide (no extra arguments)." })], flags: MessageFlags.IsComponentsV2 });
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      await memberChannel.permissionOverwrites.edit(message.guild.id, { ViewChannel: false });  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: "<:hide:1532336151854190743> Voice channel is now **hidden**." })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // UNHIDE COMMAND  
    if (command === "vcunhide") {  
      if (args.length) return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "Usage: vcunhide (no extra arguments)." })], flags: MessageFlags.IsComponentsV2 });
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      await memberChannel.permissionOverwrites.edit(message.guild.id, { ViewChannel: true });  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: "<:unhide:1532336276164841482> Voice channel is now **visible**." })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // RENAME COMMAND  
    if (command === "vcname") {  
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const newName = args.join(" ");  
      if (!newName) return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please provide a new name. (e.g., `vcname Chill Lounge`)" })], flags: MessageFlags.IsComponentsV2 });  
        
      await memberChannel.setName(newName);  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:name:1532337141214871622> Channel renamed to **${newName}**.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // USER LIMIT COMMAND  
    if (command === "vclimit") {  
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const limit = args.length === 1 ? parseStrictInteger(args[0], 0, 99) : null;  
      if (limit === null) {  
        return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid limit between 0 and 99." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      await memberChannel.setUserLimit(limit);  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:limit:1532340516249931826> User limit set to **${limit === 0 ? "Unlimited" : limit}**.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // ADD / PERMIT COMMAND  
    if (command === "vcadd") {  
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const targetMember = await findTargetMember(message, args);  
        
      if (!targetMember) {  
        return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid user name or mention to add to your channel." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      await memberChannel.permissionOverwrites.edit(targetMember.id, {   
        Connect: true,   
        ViewChannel: true   
      });  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:add:1532337807765278801> Added **${targetMember.user.tag}** to your channel permissions.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // REMOVE / REVOKE COMMAND  
    if (command === "vcremove") {  
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const targetMember = await findTargetMember(message, args);  

      if (!targetMember) {  
        return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid user name or mention to remove from your channel permissions." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      if (targetMember.id === ownerId) {  
        return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:error_g:1561271715164721245> You cannot remove permissions for yourself." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      await memberChannel.permissionOverwrites.delete(targetMember.id).catch(() => {});  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:remove:1532337229907759124> Revoked channel permissions for **${targetMember.user.tag}**.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // KICK COMMAND  
    if (command === "vckick") {  
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const targetMember = await findTargetMember(message, args);  

      if (!targetMember || targetMember.voice.channelId !== memberChannel.id) {  
        return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid user who is currently inside your voice channel." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      await targetMember.voice.disconnect();  
      return message.reply({ components: [buildCard({ color: CARD_COLORS.GREEN, description: `<:kick:1532337429426471044> Kicked **${targetMember.user.tag}** from your channel.` })], flags: MessageFlags.IsComponentsV2 });  
    }  

    // 1. TRANSFER OWNERSHIP COMMAND (`vcowner`)
    if (command === "vcowner") {  
      if (!isOwner) return message.reply({ components: [notOwnerCard], flags: MessageFlags.IsComponentsV2 });  
      const targetMember = await findTargetMember(message, args);  

      if (!targetMember || targetMember.voice.channelId !== memberChannel.id) {  
        return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> Please specify a valid user who is currently inside your voice channel." })], flags: MessageFlags.IsComponentsV2 });  
      }  

      if (targetMember.id === ownerId) {  
        return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:warning_g:1561271566233501797> You are already the owner of this channel." })], flags: MessageFlags.IsComponentsV2 });  
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
          description: `${targetMember} <:owner:1532337324762075146> Channel ownership has been successfully transferred to ${targetMember}!`
        });

        return message.reply({ components: [successCard], flags: MessageFlags.IsComponentsV2 });  
      } catch (error) {  
        console.error("Error transferring ownership:", error);  
        return message.reply({ components: [buildCard({ color: CARD_COLORS.RED, description: "<:error_g:1561271715164721245> An error occurred while transferring ownership." })], flags: MessageFlags.IsComponentsV2 });  
      }  
    }
  });
};
