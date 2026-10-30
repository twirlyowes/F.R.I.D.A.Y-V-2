/**
 * Lightweight normalization for configured bad-word matching.
 * No network calls, model inference, or external services.
 */
const LEET = Object.freeze({
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t",
  "@": "a", "$": "s"
});

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/(?<=[\p{L}\p{N}])[013457@$](?=[\p{L}\p{N}])/gu, char => LEET[char] || char);
}

function normalizeWord(value) {
  return Array.from(normalizeText(value))
    .filter(char => /[\p{L}\p{N}]/u.test(char))
    .join("");
}

function buildWordPattern(word) {
  const normalized = normalizeWord(word);
  if (normalized.length < 3) return null;
  const letters = Array.from(normalized);
  const gap = "[^\\p{L}\\p{N}]{0,2}";
  return new RegExp("(?:^|[^\\p{L}\\p{N}])" + letters.join(gap) + "(?:$|[^\\p{L}\\p{N}])", "u");
}

function findNormalizedBadword(content, words) {
  const normalizedContent = normalizeText(content);
  for (const original of words || []) {
    const pattern = buildWordPattern(original);
    if (pattern && pattern.test(normalizedContent)) return original;
  }
  return null;
}

module.exports = { normalizeText, normalizeWord, findNormalizedBadword };
