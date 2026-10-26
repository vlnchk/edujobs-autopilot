// Self-contained so the builder can embed this exact helper in the n8n Code VM.
export function sanitizePublicationText(text) {
  if (text === null || text === undefined) return null;
  return String(text)
    // Match complete emoji sequences first; keep ordinary digits, # and *.
    .replace(/(?:[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}+|\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*)*|\p{Emoji_Modifier})/gu, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
