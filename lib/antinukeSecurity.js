"use strict";

const { PermissionFlagsBits } = require("discord.js");

const DANGEROUS_MEMBER_ROLE_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks
]);

const QUARANTINE_DENY_FLAGS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads
]);

function addedRoleIds(oldRoleIds, newRoleIds, ignoredRoleIds = []) {
  const oldIds = new Set(oldRoleIds);
  const ignored = new Set(ignoredRoleIds);
  return [...new Set(newRoleIds)].filter(id => !oldIds.has(id) && !ignored.has(id));
}

function hasDangerousPermissions(roleOrPermissions) {
  const permissions = roleOrPermissions?.permissions || roleOrPermissions;
  return Boolean(permissions && DANGEROUS_MEMBER_ROLE_PERMISSIONS.some(flag => permissions.has(flag)));
}

function isPermissionlessRole(role) {
  return Boolean(role && role.permissions && role.permissions.bitfield === 0n);
}

function missingQuarantineDenies(channel, roleId) {
  const overwrite = channel?.permissionOverwrites?.cache?.get(roleId);
  return QUARANTINE_DENY_FLAGS.filter(flag => !overwrite?.deny?.has?.(flag));
}

module.exports = {
  DANGEROUS_MEMBER_ROLE_PERMISSIONS,
  QUARANTINE_DENY_FLAGS,
  addedRoleIds,
  hasDangerousPermissions,
  isPermissionlessRole,
  missingQuarantineDenies
};
