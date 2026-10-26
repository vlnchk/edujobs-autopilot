import assert from "node:assert/strict";
import test from "node:test";
import { insertProjectLink } from "./project-link.mjs";
import { sanitizePublicationText } from "./publication-text.mjs";

const url = "https://museum.example/";
test("first visible mention, aliases, grammatical forms, punctuation and word boundaries", () => {
  for (const [body, selected, expected] of [
    ["Музей «Коллекция» ищет медиатора. «Коллекция» обучает взрослых.", "«Коллекция»", "Музей [«Коллекция»](URL) ищет медиатора. «Коллекция» обучает взрослых."],
    ["МГУ ищет преподавателя. Московский университет обучает взрослых.", "МГУ", "[МГУ](URL) ищет преподавателя. Московский университет обучает взрослых."],
    ["В Коллекции нужен медиатор.", "Коллекции", "В [Коллекции](URL) нужен медиатор."],
    ["Superclass class classwork class.", "class", "Superclass [class](URL) classwork class."],
    ["[details](https://x.example/Muse) Muse teaches adults.", "Muse", "[details](https://x.example/Muse) [Muse](URL) teaches adults."],
    ["`Muse` and <https://x.example/Muse> Muse teaches adults.", "Muse", "[`Muse`](URL) and <https://x.example/Muse> Muse teaches adults."],
  ]) {
    const result = insertProjectLink(body, selected, url);
    assert.equal(result.ok, true, result.issue);
    assert.equal(result.text, expected.replace("URL", url));
    assert.deepEqual(insertProjectLink(result.text, selected, url), result);
  }
});

test("inline Markdown preserves supported formatting and visible escaped labels", () => {
  for (const [body, selection, expected] of [
    ["**Muse** helps *teachers*.", "Muse", "[**Muse**](URL) helps *teachers*."],
    ["**The Muse project** teaches adults.", "Muse", "**The [Muse](URL) project** teaches adults."],
    ["Muse **Academy** teaches adults.", "Muse Academy", "[Muse **Academy**](URL) teaches adults."],
    ["A [B] teaches adults.", "A [B]", "[A \\[B\\]](URL) teaches adults."],
    ["A\\*B teaches adults.", "A*B", "[A\\*B](URL) teaches adults."],
    ["R&amp;D teaches adults.", "R&D", "[R&amp;D](URL) teaches adults."],
    ["# Muse\n\n- Learn here.", "Muse", "# [Muse](URL)\n\n- Learn here."],
    ["* Muse teaches adults.", "Muse", "* [Muse](URL) teaches adults."],
    ["!Muse teaches adults.", "Muse", "\\![Muse](URL) teaches adults."],
    ["\\Muse teaches adults.", "Muse", "\\\\[Muse](URL) teaches adults."],
    ["A\\B teaches adults.", "A\\B", "[A\\\\B](URL) teaches adults."],
    ["` Muse ` teaches adults.", "Muse", "[` Muse `](URL) teaches adults."],
    ["`A[B]` teaches adults.", "A[B]", "[`A[B]`](URL) teaches adults."],
    ["`A[B` teaches adults.", "A[B", "[`A[B`](URL) teaches adults."],
    ["The `A[B]` school teaches adults.", "The A[B] school", "[The `A[B]` school](URL) teaches adults."],
  ]) {
    const result = insertProjectLink(body, selection, url);
    assert.equal(result.ok, true, result.issue);
    assert.equal(result.text, expected.replace("URL", url));
    assert.deepEqual(insertProjectLink(result.text, selection, url), result);
  }
});

test("correct links survive, wrong selected destination changes once without nesting", () => {
  const correct = "[**Muse**](https://museum.example/) teaches adults; [apply](https://jobs.example/).";
  assert.equal(insertProjectLink(correct, "Muse", url).text, correct);
  assert.equal(insertProjectLink(correct.replace(url, "https://wrong.example/"), "Muse", url).text, correct);
  assert.equal(insertProjectLink("[Muse](https://wrong.example/) Muse", "Muse", url).text, "[Muse](https://museum.example/) Muse");
  const equivalent = "[Muse](HTTPS://MUSEUM.EXAMPLE:443) teaches adults.";
  assert.equal(insertProjectLink(equivalent, "Muse", url).text, equivalent);
  const balanced = "[Muse](https://museum.example/a(b)) teaches adults.";
  assert.equal(insertProjectLink(balanced, "Muse", url + "a(b)").text, balanced);
});

test("ambiguous/malformed formatting and missing selections leave text intact", () => {
  for (const body of ["[Muse](broken", "**Muse teaches adults.", "[Muse Academy](https://x.example/)", "[Muse][id]", "![Muse](https://x.example/)", "<b>Muse</b>", "[Muse [nested](https://x.example/)](https://y.example/)", "Muse **Academy teaches** adults.", "`The Muse project` hires. Muse teaches adults."]) {
    const result = insertProjectLink(body, body.startsWith("Muse **") ? "Muse Academy" : "Muse", url);
    assert.equal(result.ok, false, body);
    assert.equal(result.text, body);
    assert.equal(result.project_link_text, null);
  }
  for (const selection of [null, "Missing", "Mu"]) {
    assert.equal(insertProjectLink("Muse teaches adults.", selection, url).ok, false);
  }
  for (const invalid of [null, "", "malformed", "https://user@host/"]) {
    assert.equal(insertProjectLink("Muse teaches adults.", "Muse", invalid).ok, false);
  }
});

test("generated destinations escape Markdown and Unicode and survive later sanitation", () => {
  const inputUrl = "https://museum.example/a(b)*_~!'[x]/🔥?q=тест&v=%2F";
  const result = insertProjectLink(sanitizePublicationText("🔥 Muse teaches adults. ✅"), "Muse", inputUrl);
  assert.equal(result.ok, true);
  assert.equal(result.text, "[Muse](https://museum.example/a%28b%29%2A%5F%7E%21%27%5Bx%5D/%F0%9F%94%A5?q=%D1%82%D0%B5%D1%81%D1%82&v=%2F) teaches adults.");
  assert.equal(sanitizePublicationText(result.text), result.text);
  assert.deepEqual(insertProjectLink(result.text, "Muse", inputUrl), result);
});

test("candidate-local forms stay exact without canonical-name or alias inference", () => {
  const body = "В **Северной академии** нужен методист. Команда Северной академии готовит уроки.";
  for (const wrong of ["Северная академия", "Северной академией", "северной академии", null]) {
    const result = insertProjectLink(body, wrong, url);
    assert.equal(result.ok, false);
    assert.equal(result.text, body);
    assert.equal(result.project_link_text, null);
  }
  const valid = insertProjectLink(body, "Северной академии", url);
  assert.equal(valid.text, "В [**Северной академии**](" + url + ") нужен методист. Команда Северной академии готовит уроки.");
  assert.deepEqual(insertProjectLink(valid.text, "Северной академии", url), valid);
});

test("insertion finds the first exact span while employer and earlier-alias judgments remain semantic", () => {
  const body = "СА (Северная академия) ищет методиста. Команда Северной академии проводит занятия.";
  for (const selection of ["СА", "Северная академия", "Северной академии"]) {
    const result = insertProjectLink(body, selection, url);
    assert.equal(result.ok, true);
    assert.equal(result.text, body.replace(selection, `[${selection}](${url})`));
    assert.deepEqual(insertProjectLink(result.text, selection, url), result);
  }
  // A department or clipped descriptor may be a valid string without being the
  // correct employer. The insertion helper must not pretend to classify them.
  for (const [candidate, selection] of [
    ["Отдел программ Северной академии ищет методиста.", "Отдел программ"],
    ["Отдел программ Северной академии ищет методиста.", "Северной академии"],
    ["Блог автора и его учебная студия ищут редактора.", "Блог автора"],
    ["Блог автора и его учебная студия ищут редактора.", "Блог автора и его учебная студия"],
  ]) {
    const result = insertProjectLink(candidate, selection, url);
    assert.equal(result.text, candidate.replace(selection, `[${selection}](${url})`));
    assert.deepEqual(insertProjectLink(result.text, selection, url), result);
  }
});
