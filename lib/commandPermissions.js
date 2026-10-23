const guildConfig = require("./guildConfig");

const cache = new Map();
const TTL_MS = 30 * 1000;
const parseId = value => typeof value === "string" && /^\d{17,20}$/.test(value);

async function loadRules(guildId, db = null) {
  const store = db || require("../firebase");
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached.rules;
  try {
    const snapshot = await store.collection("command_permissions").doc(guildId).get();
    const data = snapshot.exists ? snapshot.data() || {} : {};
    const rules = data.rules && typeof data.rules === "object" && !Array.isArray(data.rules) ? data.rules : {};
    cache.set(guildId, { rules, loadedAt: Date.now() });
    return rules;
  } catch (error) {
    if (cached) {
      console.warn("[Command Permissions] Firestore read failed; using cached rules:", error.message);
      return cached.rules;
    }
    console.error("[Command Permissions] Could not load command rules:", error.message);
    // With no saved policy cached, keep legacy commands working rather than
    // interpreting a transient database outage as a policy that blocks all commands.
    return {};
  }
}

function isAdministrator(member) {
  return Boolean(member?.permissions?.has("Administrator") || member?.permissions?.has("ManageGuild"));
}

async function evaluateRule(message, rule, config = guildConfig) {
  const member = message.member;
  const guild = message.guild;
  if (!member || !guild || !rule || typeof rule !== "object") return true;

  const owner = guild.ownerId === message.author.id;
  if (rule.mode === "owner") return owner;
  if (owner || isAdministrator(member)) return true;

  if (rule.mode === "everyone") return true;
  if (rule.mode === "admins") return false;
  if (rule.mode === "staff") {
    try { return await config.isStaff(member); }
    catch (error) { console.error("[Command Permissions] Staff check failed:", error.message); return false; }
  }
  if (rule.mode === "roles") {
    const roleIds = Array.isArray(rule.roleIds) ? rule.roleIds.filter(parseId) : [];
    return roleIds.some(id => member.roles.cache.has(id));
  }
  // Unknown rules must not accidentally deny access to legacy commands.
  return true;
}

async function canRunCommand(message, command, options = {}) {
  if (!message?.guild || !message?.author?.id) return true;
  const rules = await loadRules(message.guild.id, options.db || null);
  const rule = rules[String(command || "").toLowerCase()];
  if (!rule) return true;
  return evaluateRule(message, rule, options.guildConfig || guildConfig);
}

function clearCache(guildId) {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

module.exports = { canRunCommand, evaluateRule, loadRules, clearCache };
