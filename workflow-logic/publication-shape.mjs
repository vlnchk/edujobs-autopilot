// Spec Section 13.0.1: what a Telegram reader sees. Every visible character,
// including spaces, line breaks and list markers, counts; a link's URL and
// Markdown syntax do not. Self-contained for the n8n Code VM.
export function visibleLength(text) {
  if (text === null || text === undefined) return 0;
  const visible = String(text)
    .replace(/\[((?:\\.|[^\\\]])*)\]\((?:\\.|[^\\()\s]|\((?:\\.|[^\\()\s])*\))*\)/g, "$1")
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/^#{1,6}[ \t]+/gm, "");
  return Array.from(visible).length;
}

// Spec Sections 13.1 and 14.4: a conservative detector of contact channels
// that never belong inside a description. Salaries, years and counts must not
// match, so a phone needs a leading "+" or the Russian 8-XXX-XXX-XX-XX shape.
// Self-contained for the n8n Code VM.
export function findContactChannels(text) {
  const value = String(text ?? "");
  const patterns = [
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    /(?<![\w@./])@[A-Z0-9_]{5,32}\b/gi,
    /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|wa\.me|vk\.me|api\.whatsapp\.com)\/\S+/gi,
    /\b(?:mailto|tg):\S+/gi,
    /(?<![\w+])\+\d[\d\s().\-\u2010-\u2014]{7,}\d(?!\d)/g,
    /(?<![\w+])8[\s(\-\u2010-\u2014]*\d{3}[\s)\-\u2010-\u2014]*\d{3}[\s\-\u2010-\u2014]*\d{2}[\s\-\u2010-\u2014]*\d{2}(?!\d)/g,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) found.push(match[0].trim());
  }
  return [...new Set(found)];
}
