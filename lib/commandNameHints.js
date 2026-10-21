const COMMANDS = new Set([
  "ping", "testembed", "mute", "unmute", "purge", "c", "vcp",
  "kick", "ban", "nick", "uptime", "lock", "unlock", "unban",
  "warn", "wlist", "wremove", "wreset", "strike", "strikes", "unstrike", "removestrike",
  "addbadword", "removebadword", "badwordslist", "snipe", "setupverify", "role",
  "ip", "av", "avatar", "ui", "userinfo", "si", "serverinfo", "sticky", "dm", "botinfo", "wiki", "hide", "unhide", "say", "calculate",
  "quote", "vclock", "vcunlock", "vchide", "vcunhide", "vcname", "vclimit", "vcadd", "vcremove", "vckick", "vcowner",
  "prefix", "config", "settings", "setup", "automod", "antinuke", "np", "noprefix",
  "servers", "addserver", "removeserver", "atlogs", "resetactivetime", "removeuser", "activetime", "afk", "help"
]);

function editDistance(left, right) {
  const a = Array.from(left);
  const b = Array.from(right);
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

function suggestCommand(input) {
  const command = String(input == null ? "" : input).trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(command) || command.length < 3 || COMMANDS.has(command)) return null;
  const candidates = [...COMMANDS].filter(candidate => candidate.length >= 3).map(name => ({ name, distance: editDistance(command, name) }));
  const bestDistance = Math.min(...candidates.map(candidate => candidate.distance));
  const maxDistance = command.length <= 8 ? 2 : 3;
  if (bestDistance < 1 || bestDistance > maxDistance) return null;
  const best = candidates.filter(candidate => candidate.distance === bestDistance);
  return best.length === 1 ? best[0].name : null;
}

module.exports = { suggestCommand };
