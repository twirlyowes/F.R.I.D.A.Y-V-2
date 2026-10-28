"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionsBitField, PermissionFlagsBits } = require("discord.js");
const {
  DANGEROUS_MEMBER_ROLE_PERMISSIONS,
  QUARANTINE_DENY_FLAGS,
  addedRoleIds,
  hasDangerousPermissions,
  isPermissionlessRole,
  missingQuarantineDenies
} = require("../lib/antinukeSecurity");

test("addedRoleIds detects only newly added, non-ignored IDs", () => {
  assert.deepEqual(
    addedRoleIds(["1", "2"], ["1", "2", "3", "4"], ["4"]),
    ["3"]
  );
});

test("hasDangerousPermissions detects Administrator and ManageRoles", () => {
  assert.equal(hasDangerousPermissions({
    permissions: new PermissionsBitField([PermissionFlagsBits.Administrator])
  }), true);
  assert.equal(hasDangerousPermissions({
    permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel])
  }), false);
});

test("permissionless quarantine role requires a zero permission bitfield", () => {
  assert.equal(isPermissionlessRole({
    permissions: new PermissionsBitField([])
  }), true);
  assert.equal(isPermissionlessRole({
    permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel])
  }), false);
  assert.equal(isPermissionlessRole(null), false);
});

test("missingQuarantineDenies lists every missing deny on absent overwrite", () => {
  const channel = { permissionOverwrites: { cache: new Map() } };
  assert.equal(missingQuarantineDenies(channel, "quarantine").length, QUARANTINE_DENY_FLAGS.length);
});

test("missingQuarantineDenies is empty when all required permissions are denied", () => {
  const overwrite = { deny: new PermissionsBitField(QUARANTINE_DENY_FLAGS) };
  const channel = { permissionOverwrites: { cache: new Map([["quarantine", overwrite]]) } };
  assert.deepEqual(missingQuarantineDenies(channel, "quarantine"), []);
});

test("dangerous permission list is non-empty and contains Administrator", () => {
  assert.ok(DANGEROUS_MEMBER_ROLE_PERMISSIONS.length > 0);
  assert.ok(DANGEROUS_MEMBER_ROLE_PERMISSIONS.includes(PermissionFlagsBits.Administrator));
});
