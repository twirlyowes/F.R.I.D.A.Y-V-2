const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateRule, loadRules, clearCache } = require("../lib/commandPermissions");

function member({ roles = [], permissions = [] } = {}) {
  return {
    roles: { cache: new Map(roles.map(id => [id, { id }])) },
    permissions: { has: name => permissions.includes(name) }
  };
}
function message({ userId = "100000000000000001", ownerId = "100000000000000002", roles = [], permissions = [] } = {}) {
  return {
    author: { id: userId },
    member: member({ roles, permissions }),
    guild: { id: "200000000000000001", ownerId }
  };
}

test("no custom command rule preserves existing built-in command behavior", async () => {
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ rules: {} }) }) }) }) };
  clearCache();
  assert.deepEqual(await loadRules("200000000000000101", db), {});
});

test("owner-only rules reject moderators but allow the actual guild owner", async () => {
  const rule = { mode: "owner" };
  assert.equal(await evaluateRule(message({permissions:["Administrator"]}), rule, {isStaff: async()=>true}), false);
  assert.equal(await evaluateRule(message({userId:"100000000000000002"}), rule, {isStaff: async()=>false}), true);
});

test("staff rules use the configured staff-role verifier", async () => {
  const staffConfig = { isStaff: async m => m.roles.cache.has("300000000000000001") };
  assert.equal(await evaluateRule(message({roles:["300000000000000001"]}), {mode:"staff"}, staffConfig), true);
  assert.equal(await evaluateRule(message({roles:[]}), {mode:"staff"}, staffConfig), false);
});

test("selected-role rules require at least one configured role unless an administrator bypasses", async () => {
  assert.equal(await evaluateRule(message({roles:["300000000000000001"]}), {mode:"roles", roleIds:["300000000000000001"]}), true);
  assert.equal(await evaluateRule(message({roles:[]}), {mode:"roles", roleIds:["300000000000000001"]}), false);
  assert.equal(await evaluateRule(message({permissions:["Administrator"]}), {mode:"roles", roleIds:["300000000000000001"]}), true);
});

test("administrator mode rejects ordinary members", async () => {
  assert.equal(await evaluateRule(message(), {mode:"admins"}), false);
  assert.equal(await evaluateRule(message({permissions:["ManageGuild"]}), {mode:"admins"}), true);
});

test("everyone mode does not bypass owner-only rules, but allows ordinary members", async () => {
  assert.equal(await evaluateRule(message(), {mode:"everyone"}), true);
  assert.equal(await evaluateRule(message({userId:"100000000000000002"}), {mode:"owner"}), true);
});