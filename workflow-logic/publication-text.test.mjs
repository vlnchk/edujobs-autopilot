import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { sanitizePublicationText } from "./publication-text.mjs";

test("publication sanitation removes emoji sequences without concatenating words", () => {
  const sanitizeInVm = vm.runInNewContext(`(${sanitizePublicationText.toString()})`);
  for (const emoji of ["🔥", "📌", "✅", "✨", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇮🇱", "1️⃣", "#️⃣", "*️⃣", "♥️", "🏳️‍🌈", "🏴\u{E0067}\u{E0062}\u{E007F}"]) {
    for (const sanitize of [sanitizePublicationText, sanitizeInVm]) {
      assert.equal(sanitize(`слово${emoji}word`), "слово word");
      assert.equal(sanitize(`${emoji} \n ${emoji}`), "");
      assert.equal(sanitize(sanitize(`слово${emoji}word`)), "слово word");
    }
  }
  assert.equal(sanitizePublicationText(null), null);
  assert.equal(sanitizePublicationText(""), "");
});

test("publication sanitation preserves Unicode typography, Markdown, URLs and ordinary symbols", () => {
  const text = "«Вакансия» — EdTech – 350–450 ₽ • € ± →\n**роль** _работа_ #1 *задача*\n- [подробнее](https://example.com/путь?x=1&y=2#часть)\n• café, Ελληνικά, עברית, 中文; (текст)!";
  assert.equal(sanitizePublicationText(text), text);
  assert.equal(sanitizePublicationText(`🔥 ${text}\n✅`), text);
});
