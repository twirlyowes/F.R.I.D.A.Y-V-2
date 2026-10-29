"use strict";

/*
 * Local, opt-in heuristic detector for severe targeted abuse. No remote NLP
 * calls and no per-message Firestore writes. False positives are reduced by
 * requiring either a high-confidence insult or a combination of targeting,
 * sexual/nudity language, coercion, or threats.
 */
const FAMILY_TERMS = [
  "maa", "ma", "mummy", "mom", "mother", "mama", "behen", "bhen", "behn",
  "sister", "didi", "bhabhi"
];

const TARGET_TERMS = [
  "teri", "tere", "tera", "tumhari", "tumhara", "tumhare", "your", "ur",
  "you", "uski", "iski", "apni", "aapki", "apke"
];

const STRONG_INSULTS = [
  "madarchod", "maderchod", "madarchood", "maderchood",
  "behenchod", "bhenchod", "behnchod",
  "bhosdike", "bhosdika", "bhosdi", "bhosda", "bhosada",
  "chutiya", "chootiya", "chutiy", "chutado", "chutad", "chuttad", "chuttado",
  "choot", "chut", "chudai", "chudwa", "chodu",
  "gaand", "gand", "gandu", "lund", "loda", "lauda",
  "randi", "randwa", "motherfucker", "fuckface", "fucker",
  "bitch", "whore", "slut", "cunt", "asshole", "dickhead"
];

const SEXUAL_TERMS = [
  "sex", "sexual", "fuck", "fucked", "fucking", "fucker", "rape", "raping",
  "rapist", "penetrate", "penetration", "dick", "cock", "pussy", "penis",
  "vagina", "cum", "semen", "blowjob", "handjob", "chud", "chudai", "chudwa",
  "chod", "choda", "chodi", "chudunga", "chudungi", "chudwaunga", "choot",
  "chut", "chutado", "chutad", "chuttad", "chuttado", "gaand", "gand",
  "lund", "loda", "lauda", "bhosdi"
];

const NUDITY_TERMS = [
  "bina kapde", "bina kapdo", "bina kapdon", "kapde ke bina", "kapdo ke bina",
  "without clothes", "without clothing", "naked", "nude", "nanga", "nangi",
  "nange", "kapde utar", "kapray utar", "clothes off", "undress", "strip naked"
];

const PERFORMANCE_TERMS = [
  "mujra", "nanga nach", "nangi nach", "naked dance", "dance naked",
  "strip dance", "nachwa", "nachwa ke"
];

const COERCION_TERMS = [
  "zabardasti", "forcefully", "forced", "bandh ke", "baandh ke",
  "karwa", "karva", "karwa ke", "karva ke", "karwaunga", "karvaunga",
  "karwa dunga", "karva dunga", "chudwa", "chodwa", "force you", "force her",
  "ghusa dunga", "ghusaunga", "andar daal", "daal dunga", "thok dunga",
  "rape", "raping"
];

const THREAT_TERMS = [
  "kill", "killing", "murder", "rape", "raping", "rapist", "maar dunga",
  "mar dunga", "maar dungi", "mar dungi", "ghusa dunga", "ghusaunga",
  "thok dunga", "zabardasti", "force you", "force her"
];

const DIRECT_ABUSE_PHRASES = [
  "fuck you", "go fuck yourself", "suck my dick", "suck your dick",
  "you are a bitch", "you re a bitch", "eat shit", "kill yourself",
  "i will rape you", "rape you", "i will kill you", "i ll kill you"
];

function normalizeText(input) {
  return String(input || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[0]/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/[3]/g, "e")
    .replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/[7]/g, "t")
    .replace(/[8]/g, "b")
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^\u0024{}()|[\]\\]/g, "\\$&");
}

function compileTerms(terms, allowCompact) {
  return terms.map(term => {
    const normalized = normalizeText(term);
    const body = normalized
      .split(" ")
      .filter(Boolean)
      .map(word => word.split("").map(escapeRegex).join("[^a-z0-9]{0,2}"))
      .join("[^a-z0-9]{1,3}");
    const pattern = new RegExp("(^|[^a-z0-9])" + body + "(?=$|[^a-z0-9])", "i");
    const compact = normalized.replace(/[^a-z0-9]/g, "").replace(/(.)\1+/g, "$1");
    return {
      pattern,
      compact: allowCompact && compact.length >= 5 ? compact : ""
    };
  });
}

const FAMILY = compileTerms(FAMILY_TERMS, false);
const TARGET = compileTerms(TARGET_TERMS, false);
const INSULTS = compileTerms(STRONG_INSULTS, true);
const SEXUAL = compileTerms(SEXUAL_TERMS, true);
const NUDITY = compileTerms(NUDITY_TERMS, true);
const PERFORMANCE = compileTerms(PERFORMANCE_TERMS, true);
const COERCION = compileTerms(COERCION_TERMS, true);
const THREATS = compileTerms(THREAT_TERMS, true);
const DIRECT_ABUSE = compileTerms(DIRECT_ABUSE_PHRASES, true);

function matchesAny(text, squeezed, terms) {
  for (const term of terms) {
    if (term.pattern.test(text)) return true;
    if (term.compact && squeezed.includes(term.compact)) return true;
  }
  return false;
}

function detectAdvancedAbuse(input) {
  const text = normalizeText(input);
  if (text.length < 3) return null;

  // Also catches words split by spaces/symbols and elongated spellings.
  const squeezed = text.replace(/[^a-z0-9]/g, "").replace(/(.)\1+/g, "$1");

  if (matchesAny(text, squeezed, INSULTS)) {
    return { category: "Explicit insult" };
  }

  if (matchesAny(text, squeezed, DIRECT_ABUSE)) {
    return { category: "Direct abusive phrase" };
  }

  const family = matchesAny(text, squeezed, FAMILY);
  const target = matchesAny(text, squeezed, TARGET);
  const sexual = matchesAny(text, squeezed, SEXUAL);
  const nudity = matchesAny(text, squeezed, NUDITY);
  const performance = matchesAny(text, squeezed, PERFORMANCE);
  const coercion = matchesAny(text, squeezed, COERCION);
  const threat = matchesAny(text, squeezed, THREATS);

  if (family && target && (sexual || nudity || performance || coercion || threat)) {
    return {
      category: threat ? "Threatening or sexually violent family-targeted abuse" : "Family-targeted sexual abuse"
    };
  }

  if (family && nudity && performance && (coercion || sexual)) {
    return { category: "Sexual humiliation or coercion" };
  }

  if (target && sexual && (nudity || coercion || threat)) {
    return { category: threat ? "Threatening or sexually violent language" : "Targeted sexual abuse" };
  }

  if (target && threat) {
    return { category: "Threatening language" };
  }

  return null;
}

module.exports = {
  detectAdvancedAbuse,
  normalizeText
};
