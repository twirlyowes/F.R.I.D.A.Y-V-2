const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField
} = require("discord.js");
const {
  configureUnverifiedRole,
  saveVerificationSetting,
  applyToChannel
} = require("../lib/verificationRoles");

function fixture(options = {}) {
  const cfg = {
    verifyChannel: "verify",
    verifiedRole: "verified",
    unverifiedRole: "unverified",
    quarantineRole: "quarantine"
  };

  function makeRole(id, permissions = []) {
    const role = {
      id,
      name: id,
      guild: null,
      managed: false,
      editable: true,
      permissions: new PermissionsBitField(permissions),
      setCalls: [],
      async setPermissions(value) {
        this.setCalls.push(String(value));
        this.permissions = new PermissionsBitField(value);
      }
    };
    return role;
  }

  const everyone = makeRole("guild", [PermissionFlagsBits.ViewChannel]);
  const verified = makeRole("verified", [PermissionFlagsBits.ManageMessages]);
  const unverified = makeRole("unverified", [PermissionFlagsBits.ManageMessages]);
  const quarantine = makeRole("quarantine", []);
  const roles = new Map([[everyone.id, everyone], [verified.id, verified], [unverified.id, unverified], [quarantine.id, quarantine]]);

  function makeChannel(id, type = ChannelType.GuildText) {
    const overwrites = new Map();
    const channel = {
      id,
      name: id,
      type,
      guild: null,
      isThread: () => false,
      isTextBased: () => type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement,
      isVoiceBased: () => type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice,
      failEdit: options.failEditChannel === id,
      permissionOverwrites: {
        cache: overwrites,
        async edit(target, changes) {
          if (channel.failEdit) throw new Error("synthetic permission overwrite failure");
          const roleId = typeof target === "string" ? target : target.id;
          const existing = overwrites.get(roleId);
          let allow = existing ? existing.allow.bitfield : 0n;
          let deny = existing ? existing.deny.bitfield : 0n;
          for (const [key, enabled] of Object.entries(changes)) {
            const bit = BigInt(PermissionFlagsBits[key]);
            if (enabled) {
              allow |= bit;
              deny &= ~bit;
            } else {
              deny |= bit;
              allow &= ~bit;
            }
          }
          overwrites.set(roleId, {
            allow: new PermissionsBitField(allow),
            deny: new PermissionsBitField(deny),
            async delete() { overwrites.delete(roleId); }
          });
        },
        async delete(target) {
          overwrites.delete(typeof target === "string" ? target : target.id);
        },
        async create(target, changes) {
          const roleId = typeof target === "string" ? target : target.id;
          let allow = 0n, deny = 0n;
          for (const perm of changes.allow || []) allow |= BigInt(PermissionFlagsBits[perm]);
          for (const perm of changes.deny || []) deny |= BigInt(PermissionFlagsBits[perm]);
          overwrites.set(roleId, {
            allow: new PermissionsBitField(allow),
            deny: new PermissionsBitField(deny),
            async delete() { overwrites.delete(roleId); }
          });
        }
      }
    };
    return channel;
  }

  const verify = makeChannel("verify");
  const general = makeChannel("general");
  const voice = makeChannel("voice", ChannelType.GuildVoice);
  const channels = new Map([[verify.id, verify], [general.id, general], [voice.id, voice]]);
  for (const role of roles.values()) role.guild = { id: "guild" };

  // Begin with a custom overwrite on #general to verify that Clear can restore it.
  general.permissionOverwrites.cache.set(unverified.id, {
    allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
    deny: new PermissionsBitField([PermissionFlagsBits.AddReactions]),
    async delete() { general.permissionOverwrites.cache.delete(unverified.id); }
  });

  const guildConfig = {
    async get() { return { ...cfg }; },
    async set(guildId, key, value) { cfg[key] = typeof value === "string" ? value : value.id; },
    async setInternal(guildId, key, value) { cfg[key] = value; }
  };

  const guild = {
    id: "guild",
    name: "Test Server",
    roles: {
      cache: roles,
      async fetch(id) { return roles.get(id) || null; }
    },
    channels: {
      cache: channels,
      async fetch(id) {
        if (id) return channels.get(id) || null;
        return channels;
      }
    },
    members: {
      me: {
        permissions: new PermissionsBitField([
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.ManageChannels
        ])
      },
      async fetchMe() { return this.me; }
    }
  };
  for (const channel of channels.values()) channel.guild = guild;

  return { cfg, guildConfig, guild, roles, everyone, verified, unverified, general, verify, voice, makeChannel };
}

test("Unverified is locked across channels while the verification panel stays visible", async () => {
  const f = fixture();
  const verifiedBefore = f.verified.permissions.bitfield;
  const everyoneBefore = f.everyone.permissions.bitfield;
  const originalGeneral = {
    allow: f.general.permissionOverwrites.cache.get("unverified").allow.bitfield,
    deny: f.general.permissionOverwrites.cache.get("unverified").deny.bitfield
  };

  const result = await configureUnverifiedRole(f.guild, f.unverified, f.verify.id, { guildConfig: f.guildConfig });

  assert.equal(f.unverified.permissions.bitfield, 0n);
  assert.equal(f.verified.permissions.bitfield, verifiedBefore);
  assert.equal(f.everyone.permissions.bitfield, everyoneBefore);
  assert.equal(result.verificationChannel.id, "verify");
  assert.ok(result.configuredChannels >= 3);

  const verifyOverwrite = f.verify.permissionOverwrites.cache.get("unverified");
  assert.ok(verifyOverwrite.allow.has(PermissionFlagsBits.ViewChannel));
  assert.ok(verifyOverwrite.allow.has(PermissionFlagsBits.ReadMessageHistory));
  assert.ok(verifyOverwrite.deny.has(PermissionFlagsBits.SendMessages));

  for (const channel of [f.general, f.voice]) {
    const overwrite = channel.permissionOverwrites.cache.get("unverified");
    assert.ok(overwrite.deny.has(PermissionFlagsBits.ViewChannel));
  }
  assert.notEqual(f.general.permissionOverwrites.cache.get("unverified").allow.bitfield, originalGeneral.allow);
  assert.ok(f.cfg.__unverifiedRoleSnapshot);
});

test("Verified and Unverified cannot be configured as the same role", async () => {
  const f = fixture();
  await assert.rejects(
    () => saveVerificationSetting(f.guild, "unverifiedRole", f.verified.id, { guildConfig: f.guildConfig }),
    /different roles/
  );
  assert.equal(f.cfg.unverifiedRole, "unverified");
  assert.equal(f.verified.permissions.has(PermissionFlagsBits.ManageMessages), true);
});

test("a new channel gets the Unverified lock and retains a restorable baseline", async () => {
  const f = fixture();
  await configureUnverifiedRole(f.guild, f.unverified, f.verify.id, { guildConfig: f.guildConfig });
  const next = f.makeChannel("new-channel");
  next.guild = f.guild;
  f.guild.channels.cache.set(next.id, next);

  const applied = await applyToChannel(f.guild, next, null, { guildConfig: f.guildConfig });
  assert.equal(applied, true);
  assert.ok(next.permissionOverwrites.cache.get("unverified").deny.has(PermissionFlagsBits.ViewChannel));
  assert.ok(Object.prototype.hasOwnProperty.call(f.cfg.__unverifiedRoleSnapshot.channelOverwrites, "new-channel"));
});

test("partial setup failure rolls back role permissions and already changed overwrites", async () => {
  const f = fixture({ failEditChannel: "general" });
  const originalPermissions = f.unverified.permissions.bitfield;
  await assert.rejects(
    () => configureUnverifiedRole(f.guild, f.unverified, f.verify.id, { guildConfig: f.guildConfig }),
    /Previous permissions were restored/
  );
  assert.equal(f.unverified.permissions.bitfield, originalPermissions);
  assert.equal(f.verify.permissionOverwrites.cache.has("unverified"), false);
  assert.equal(f.cfg.__unverifiedRoleSnapshot, null);
  assert.ok(f.general.permissionOverwrites.cache.get("unverified").allow.has(PermissionFlagsBits.ViewChannel));
});