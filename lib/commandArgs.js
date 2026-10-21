const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
function extractSnowflake(value) {
  const text = String(value == null ? "" : value).trim();
  const mention = text.match(/^<@!?(\d{15,25})>$/);
  if (mention) return mention[1];
  return /^\d{15,25}$/.test(text) ? text : null;
}
function parseDuration(value) {
  const input = String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, "");
  if (!input) return null;
  const tokenPattern = /(\d+(?:\.\d+)?)(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/gy;
  let cursor = 0, totalMs = 0, parts = 0;
  while (cursor < input.length) {
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(input);
    if (!match || match.index !== cursor) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unit = match[2];
    let multiplier;
    if (["ms", "msec", "msecs", "millisecond", "milliseconds"].includes(unit)) multiplier = 1;
    else if (["s", "sec", "secs", "second", "seconds"].includes(unit)) multiplier = 1000;
    else if (["m", "min", "mins", "minute", "minutes"].includes(unit)) multiplier = 60000;
    else if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) multiplier = 3600000;
    else if (["d", "day", "days"].includes(unit)) multiplier = 86400000;
    else return null;
    totalMs += amount * multiplier;
    if (!Number.isFinite(totalMs) || totalMs > MAX_TIMEOUT_MS) return null;
    cursor = tokenPattern.lastIndex;
    parts += 1;
  }
  if (!parts) return null;
  const result = Math.round(totalMs);
  if (result < 1000 || result > MAX_TIMEOUT_MS) return null;
  return result;
}
function parseDurationAt(args, startIndex, excludedIndex) {
  if (!Array.isArray(args) || startIndex < 0 || startIndex >= args.length || startIndex === excludedIndex) return null;
  const first = String(args[startIndex] == null ? "" : args[startIndex]);
  if (startIndex + 1 < args.length && startIndex + 1 !== excludedIndex) {
    const combined = parseDuration(first + String(args[startIndex + 1]));
    if (combined !== null) return { durationMs: combined, count: 2 };
  }
  const single = parseDuration(first);
  return single === null ? null : { durationMs: single, count: 1 };
}
function parseMuteArguments(inputArgs) {
  if (!Array.isArray(inputArgs)) return null;
  const args = inputArgs.map(value => String(value == null ? "" : value));
  let targetIndex = -1, userId = null;
  for (let index = 0; index < Math.min(args.length, 3); index += 1) {
    const id = extractSnowflake(args[index]);
    if (id) { targetIndex = index; userId = id; break; }
  }
  if (targetIndex < 0) return null;
  let durationStart = targetIndex === 0 ? 1 : targetIndex === 1 ? 0 : (args[0] && ["for", "duration"].includes(args[0].toLowerCase()) ? 1 : 0);
  let keywordIndex = targetIndex === 2 && args[0] && ["for", "duration"].includes(args[0].toLowerCase()) ? 0 : -1;
  if (args[durationStart] && ["for", "duration"].includes(args[durationStart].toLowerCase())) { keywordIndex = durationStart; durationStart += 1; }
  if (durationStart === targetIndex) return null;
  const parsedDuration = parseDurationAt(args, durationStart, targetIndex);
  if (!parsedDuration) return null;
  const durationEnd = durationStart + parsedDuration.count;
  if (targetIndex >= durationStart && targetIndex < durationEnd) return null;
  const excluded = new Set([targetIndex, keywordIndex]);
  for (let index = durationStart; index < durationEnd; index += 1) excluded.add(index);
  const reason = args.filter((value, index) => !excluded.has(index)).join(" ").trim() || "No reason provided";
  return { userId, durationMs: parsedDuration.durationMs, durationLabel: args.slice(durationStart, durationEnd).join(" "), reason };
}
function parseStrictInteger(value, min, max) {
  const text = String(value == null ? "" : value).trim();
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
module.exports = { extractSnowflake, parseDuration, parseMuteArguments, parseStrictInteger };