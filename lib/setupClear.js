const { ChannelType } = require("discord.js");
const guildConfig = require("./guildConfig");
const verificationRoles = require("./verificationRoles");

const CREATED_KEY = "__setupCreated";
const SETUP_ALL_KEY = "__setupAllCreated";
const SETUP_ALL_ASSIGNED_KEY = "__setupAllAssigned";

// Old role setting names remain hidden from admins but may still appear in
// old setup metadata or on historic tickets.
const LEGACY_SETTING_TYPES = {
  supportMinecraft: "role",
  supportDiscord: "role",
  supportOthers: "role"
};

async function trackSetupAllAssignment(guild, key, id, options = {}) {
  if (!guild || !key || !id || options.scope !== "setupAll") return false;

  const cfg = await guildConfig.get(guild.id);
  const assigned = { ...(cfg[SETUP_ALL_ASSIGNED_KEY] || {}) };
  assigned[key] = { id: String(id), assignedAt: Date.now() };
  await guildConfig.setInternal(guild.id, SETUP_ALL_ASSIGNED_KEY, assigned);
  return true;
}

async function trackCreatedResource(guild, key, resource, options = {}) {
  const type = guildConfig.SETTINGS[key]?.type || LEGACY_SETTING_TYPES[key];
  if (!guild || !key || !resource?.id || !type) return false;

  const createdAt = Date.now();
  const cfg = await guildConfig.get(guild.id);
  const created = { ...(cfg[CREATED_KEY] || {}) };
  created[key] = {
    id: String(resource.id),
    type,
    createdAt,
    ...(options.scope === "setupAll" ? { scope: "setupAll" } : {})
  };
  await guildConfig.setInternal(guild.id, CREATED_KEY, created);

  if (options.scope === "setupAll") {
    const latest = await guildConfig.get(guild.id);
    const allCreated = { ...(latest[SETUP_ALL_KEY] || {}) };
    allCreated[key + ":" + String(resource.id)] = {
      key,
      id: String(resource.id),
      type,
      createdAt
    };
    await guildConfig.setInternal(guild.id, SETUP_ALL_KEY, allCreated);
    await trackSetupAllAssignment(guild, key, resource.id, options);
  }

  return true;
}

async function untrackCreatedResource(guild, key, resourceId = null) {
  let cfg = await guildConfig.get(guild.id);
  const created = { ...(cfg[CREATED_KEY] || {}) };
  let changed = false;

  if (created[key] && (!resourceId || String(created[key].id) === String(resourceId))) {
    delete created[key];
    changed = true;
  }
  if (changed) await guildConfig.setInternal(guild.id, CREATED_KEY, created);

  if (resourceId) {
    cfg = await guildConfig.get(guild.id);
    const allCreated = { ...(cfg[SETUP_ALL_KEY] || {}) };
    let allChanged = false;
    for (const [token, record] of Object.entries(allCreated)) {
      if (record.key === key && String(record.id) === String(resourceId)) {
        delete allCreated[token];
        allChanged = true;
      }
    }
    if (allChanged) await guildConfig.setInternal(guild.id, SETUP_ALL_KEY, allCreated);

    cfg = await guildConfig.get(guild.id);
    const assigned = { ...(cfg[SETUP_ALL_ASSIGNED_KEY] || {}) };
    if (assigned[key] && String(assigned[key].id || assigned[key]) === String(resourceId)) {
      delete assigned[key];
      await guildConfig.setInternal(guild.id, SETUP_ALL_ASSIGNED_KEY, assigned);
    }
  }

  return changed;
}

async function resolveResource(guild, key, id, recordedType = null) {
  const type = recordedType || guildConfig.SETTINGS[key]?.type || LEGACY_SETTING_TYPES[key];
  if (!id || !type) return null;

  if (type === "role") {
    return guild.roles.cache.get(String(id)) ||
      await guild.roles.fetch(String(id)).catch(() => null);
  }

  return guild.channels.cache.get(String(id)) ||
    await guild.channels.fetch(String(id)).catch(() => null);
}

async function deleteTrackedResource(guild, key, tracked) {
  if (!tracked?.id) return { deleted: false, reason: "No setup-created resource was recorded." };

  const resource = await resolveResource(guild, key, tracked.id, tracked.type);
  if (!resource) {
    return {
      deleted: true,
      name: tracked.type === "role" ? "role" : tracked.type === "category" ? "category" : "channel",
      alreadyMissing: true
    };
  }

  try {
    if (tracked.type === "role") {
      await resource.delete("F.R.I.D.A.Y setup configuration cleared");
      return { deleted: true, name: "role" };
    }

    if (resource.type === ChannelType.GuildCategory) {
      await guild.channels.fetch().catch(() => null);
      const children = guild.channels.cache.filter(channel => channel.parentId === resource.id);
      if (children.size) {
        const examples = [...children.values()].slice(0, 3).map(channel => "`" + channel.name + "`");
        return {
          deleted: false,
          reason: "the category still contains " + children.size + " channel(s)" +
            (examples.length ? " (" + examples.join(", ") + ")" : "") + ". Existing channels were left untouched."
        };
      }
    }

    if (resource.type === ChannelType.GuildVoice && resource.members?.size > 0) {
      return {
        deleted: false,
        reason: "people are still connected to the voice channel. They were not disconnected; clear it again once it is empty."
      };
    }

    await resource.delete("F.R.I.D.A.Y setup configuration cleared");
    return { deleted: true, name: "channel" };
  } catch (error) {
    return {
      deleted: false,
      reason: "Discord would not let me delete the setup-created resource: " +
        String(error.message || "unknown error").slice(0, 250)
    };
  }
}

/**
 * Clear one setting. A Discord resource is deleted only when setup metadata
 * proves that the wizard created that exact resource.
 */
async function clearSetting(guild, key, options = {}) {
  const def = guildConfig.SETTINGS[key];
  if (!guild || !def) throw new Error("Unknown configuration setting: " + key);

  let cfg = await guildConfig.get(guild.id);
  let value = cfg[key];
  let tracked = cfg[CREATED_KEY]?.[key];
  const notes = [];

  if (key === "verifyChannel" && cfg.unverifiedRole) {
    throw new Error("Set a replacement verification channel or clear the Unverified role first. Clearing this channel alone would remove the only verification path for unverified members.");
  }
  if (key === "verifiedRole" && cfg.unverifiedRole) {
    throw new Error("Clear the Unverified role first, or configure a replacement Verified role. Both roles are needed for a complete verification flow.");
  }
  if (key === "unverifiedRole" && value) {
    await verificationRoles.restoreUnverifiedRole(guild, String(value));
    cfg = await guildConfig.get(guild.id);
    value = cfg[key];
    tracked = cfg[CREATED_KEY]?.[key];
  }

  // A configured voice category and its Join-to-Create channel are a pair.
  // Clean the trigger first, never delete arbitrary category children.
  if (!options.skipVoiceCategoryCascade && key === "voiceCategory" && value && cfg.voiceCreate) {
    const trigger = await resolveResource(guild, "voiceCreate", cfg.voiceCreate);
    if (trigger?.parentId === String(value)) {
      const dependency = await clearSetting(guild, "voiceCreate", { skipVoiceCategoryCascade: true });
      notes.push(dependency.message);
      cfg = await guildConfig.get(guild.id);
      value = cfg[key];
      tracked = cfg[CREATED_KEY]?.[key];
    }
  }

  let cleanup = null;
  const valueMatchesTracked = tracked && (!value || String(value) === String(tracked.id));
  if (valueMatchesTracked) {
    cleanup = await deleteTrackedResource(guild, key, tracked);
    if (cleanup.deleted) {
      await untrackCreatedResource(guild, key, tracked.id);
    }
  } else if (tracked && value && String(value) !== String(tracked.id)) {
    // The configured resource was replaced manually; don't delete the selected resource.
    // Keep the Setup All registry so Clear All can safely find the original resource.
    await untrackCreatedResource(guild, key);
  }

  if (value) await guildConfig.unset(guild.id, key);

  const lines = [];
  if (value) {
    lines.push("Cleared the saved configuration for **" + def.label + "**.");
  } else if (tracked) {
    lines.push("**" + def.label + "** was already unconfigured; checking its previously setup-created resource.");
  } else {
    lines.push("**" + def.label + "** is already clear.");
  }

  if (cleanup?.deleted) {
    lines.push(cleanup.alreadyMissing
      ? "The setup-created resource was already missing."
      : "Deleted the setup-created " + cleanup.name + ".");
  } else if (cleanup?.reason) {
    lines.push("The setup-created resource was kept because " + cleanup.reason);
  } else if (value && !tracked) {
    if (def.type === "role" || ["text", "voice", "category"].includes(def.type)) {
      lines.push("The selected resource was left in place because FRIDAY cannot verify that the setup wizard created it.");
    }
  }

  if (notes.length) lines.push(...notes);
  return {
    cleared: true,
    deleted: Boolean(cleanup?.deleted),
    retained: Boolean(cleanup?.reason),
    message: lines.join("\n")
  };
}

/**
 * Undo the resources and configuration assignments made by the Setup All
 * action only. Manually selected resources are never deleted.
 */
async function clearAllSetupResources(guild) {
  if (!guild) throw new Error("A server is required.");

  let cfg = await guildConfig.get(guild.id);
  const records = Object.entries(cfg[SETUP_ALL_KEY] || {})
    .map(([token, record]) => ({
      token,
      ...record,
      key: record.key || token.split(":")[0]
    }))
    .filter(record => record.id && record.key);

  const initialAssignments = { ...(cfg[SETUP_ALL_ASSIGNED_KEY] || {}) };
  if (!records.length && !Object.keys(initialAssignments).length) {
    return {
      deleted: 0,
      retained: false,
      message: "No Setup All-created resources or Setup All configuration assignments are tracked. Nothing was deleted. Resources created or selected by other setup actions were left untouched."
    };
  }

  await guild.channels.fetch().catch(() => null);
  const setupCreatedIds = new Set(records.map(record => String(record.id)));
  const blockedKeys = new Set();
  const categoryBlockReasons = new Map();

  // Preserve categories which contain channels created after Setup All, such
  // as open ModMail tickets and temporary rooms.
  for (const record of records.filter(item => item.type === "category")) {
    const category = await resolveResource(guild, record.key, record.id, record.type);
    if (!category || category.type !== ChannelType.GuildCategory) continue;

    const foreignChildren = guild.channels.cache.filter(channel =>
      channel.parentId === String(record.id) && !setupCreatedIds.has(String(channel.id))
    );

    if (foreignChildren.size) {
      const examples = [...foreignChildren.values()].slice(0, 3).map(channel => "`" + channel.name + "`");
      const reason = "the category contains existing channel(s)" +
        (examples.length ? " (" + examples.join(", ") + ")" : "");
      blockedKeys.add(record.key);
      categoryBlockReasons.set(record.key, reason);

      if (record.key === "ticketCategory") {
        blockedKeys.add("ticketLogs");
        blockedKeys.add("supportRole");
        categoryBlockReasons.set("ticketLogs", "the ModMail category is being preserved for existing tickets");
        categoryBlockReasons.set("supportRole", "the ModMail category is being preserved for existing tickets");
      }
    }
  }

  // Delete the ModMail category first so a race with a new ticket protects its
  // logs and Support Role too. Other channels precede their categories.
  const priority = record => {
    if (record.key === "ticketCategory") return 0;
    if (record.type === "category") return 2;
    if (record.type === "role") return 3;
    return 1;
  };
  records.sort((a, b) => priority(a) - priority(b));

  const deletedItems = [];
  const retainedItems = [];
  const clearedSettings = [];
  const preservedSettings = [];

  for (const record of records) {
    if (record.key === "unverifiedRole") {
      try {
        await verificationRoles.restoreUnverifiedRole(guild, String(record.id));
      } catch (error) {
        retainedItems.push("**unverifiedRole** — previous channel permissions could not be restored: " + String(error.message || "restore failed").slice(0, 240));
        continue;
      }
    }
    if (blockedKeys.has(record.key)) {
      retainedItems.push("**" + record.key + "** — kept because " +
        (categoryBlockReasons.get(record.key) || "it is needed by a preserved category") + ".");
      continue;
    }

    const cleanup = await deleteTrackedResource(guild, record.key, record);
    if (!cleanup.deleted) {
      retainedItems.push("**" + record.key + "** — " +
        String(cleanup.reason || "could not safely delete this resource").slice(0, 260));

      if (record.key === "ticketCategory") {
        blockedKeys.add("ticketLogs");
        blockedKeys.add("supportRole");
        categoryBlockReasons.set("ticketLogs", "the ModMail category could not be removed");
        categoryBlockReasons.set("supportRole", "the ModMail category could not be removed");
      }
      continue;
    }

    cfg = await guildConfig.get(guild.id);
    if (cfg[record.key] && String(cfg[record.key]) === String(record.id) &&
        (guildConfig.SETTINGS[record.key] || LEGACY_SETTING_TYPES[record.key])) {
      await guildConfig.unset(guild.id, record.key);
      clearedSettings.push(record.key);
    }

    await untrackCreatedResource(guild, record.key, record.id);
    deletedItems.push(cleanup.alreadyMissing
      ? "**" + record.key + "** — resource was already missing; removed its tracking."
      : "**" + record.key + "** — deleted setup-created " + cleanup.name + ".");
  }

  // Undo configuration assignments that pointed at pre-existing resources,
  // without deleting those resources. Keep assignments blocked or needing retry.
  cfg = await guildConfig.get(guild.id);
  const assigned = { ...(cfg[SETUP_ALL_ASSIGNED_KEY] || {}) };
  const stillAssigned = { ...assigned };

  for (const [key, assignment] of Object.entries(assigned)) {
    if (blockedKeys.has(key)) continue;

    const id = String(assignment.id || assignment);
    const hasPendingCreatedResource = Object.values(cfg[SETUP_ALL_KEY] || {}).some(record =>
      record.key === key && String(record.id) === id
    );
    if (hasPendingCreatedResource) continue;

    if (cfg[key] && String(cfg[key]) === id) {
      if (key === "unverifiedRole") {
        try {
          await verificationRoles.restoreUnverifiedRole(guild, id);
        } catch (error) {
          preservedSettings.push("**unverifiedRole** — kept because prior permissions could not be restored: " + String(error.message || "restore failed").slice(0, 220));
          continue;
        }
      }
      if (guildConfig.SETTINGS[key] || LEGACY_SETTING_TYPES[key]) {
        await guildConfig.unset(guild.id, key);
        clearedSettings.push(key);
      }
    } else if (cfg[key] && String(cfg[key]) !== id) {
      preservedSettings.push("**" + key + "** — a different resource was selected later, so it was preserved.");
    }
    delete stillAssigned[key];
  }

  const latestCfg = await guildConfig.get(guild.id);
  if (JSON.stringify(latestCfg[SETUP_ALL_ASSIGNED_KEY] || {}) !== JSON.stringify(stillAssigned)) {
    await guildConfig.setInternal(guild.id, SETUP_ALL_ASSIGNED_KEY, stillAssigned);
  }

  const sections = [];
  if (deletedItems.length) sections.push("## <:success_g:1562810067642884177> Removed\n" + deletedItems.join("\n"));
  if (clearedSettings.length) {
    const unique = [...new Set(clearedSettings)];
    sections.push("## Configuration Cleared\n" + unique.map(key => "- `" + key + "`").join("\n"));
  }
  if (preservedSettings.length) sections.push("## Preserved Manual Changes\n" + preservedSettings.join("\n"));
  if (retainedItems.length) sections.push("## <:warning_g:1562810073733136506> Kept Safely\n" + retainedItems.join("\n"));

  if (!sections.length) {
    sections.push("Nothing needed to be removed. The configuration is already clear.");
  }

  sections.push("Manually selected channels and roles were never deleted. Any retained resources are still tracked so Clear All can be retried after their dependencies are cleared.");

  return {
    deleted: deletedItems.length,
    retained: retainedItems.length > 0,
    message: sections.join("\n\n")
  };
}

module.exports = {
  trackCreatedResource,
  trackSetupAllAssignment,
  untrackCreatedResource,
  clearSetting,
  clearAllSetupResources
};
