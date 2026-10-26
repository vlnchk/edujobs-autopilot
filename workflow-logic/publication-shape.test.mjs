import assert from "node:assert/strict";
import test from "node:test";

import { findContactChannels, visibleLength } from "./publication-shape.mjs";
import { insertProjectLink } from "./project-link.mjs";

test("visible length counts what a reader sees, not link destinations or Markdown syntax", () => {
  assert.equal(visibleLength("Онлайн-школа Skillbox ищет методиста"), 36);
  const linked = insertProjectLink(
    "Онлайн-школа Skillbox ищет методиста",
    "Skillbox",
    "https://skillbox.ru/company/career/vacancies/metodist-python/",
  ).text;
  assert.notEqual(linked.length, 36);
  assert.equal(visibleLength(linked), 36);
  assert.equal(visibleLength("**Задачи:**\n- уроки;\n- проверка."), "Задачи:\n- уроки;\n- проверка.".length);
  assert.equal(visibleLength("Школа \\[X\\] ищет"), "Школа [X] ищет".length);
  assert.equal(visibleLength("a\n\nb"), 4);
  assert.equal(visibleLength(null), 0);
});

test("visible length counts code points, so Cyrillic and typography count once", () => {
  assert.equal(visibleLength("ёлка — «Ёж»"), 11);
});

test("contact detector finds emails, handles, messenger links and phones", () => {
  assert.deepEqual(findContactChannels("Резюме — в Telegram: @exampleteacher1"), ["@exampleteacher1"]);
  assert.deepEqual(findContactChannels("Пишите на hr@school.ru"), ["hr@school.ru"]);
  assert.deepEqual(findContactChannels("Наш телеграм: https://t.me/nannyjobsex"), ["https://t.me/nannyjobsex"]);
  assert.deepEqual(findContactChannels("Контакт: +374 98 980 755"), ["+374 98 980 755"]);
  assert.deepEqual(findContactChannels("WhatsApp 8-900-123-45-67"), ["8-900-123-45-67"]);
  assert.deepEqual(findContactChannels("звоните 8 (999) 123-45-67"), ["8 (999) 123-45-67"]);
  assert.deepEqual(findContactChannels("по телефону: +7 915 932\u201166\u201198 (Анна)"), ["+7 915 932\u201166\u201198"]);
});

test("contact detector ignores salaries, years, counts and ordinary prose", () => {
  for (const text of [
    "Зарплата 150 000 - 200 000 рублей",
    "Оклад 80 000-100 000 ₽, опыт от 2 лет",
    "Оклад 80 000 – 100 000 ₽",
    "Набор на 2025-2026 учебный год",
    "8 000 000 рублей бюджета",
    "Работа с 10:00 до 19:00, 5/2",
    "Проект Анны Борисовой, автора ТГ-канала «Есть контакт»",
    "Методист работает с авторами курсов",
  ]) {
    assert.deepEqual(findContactChannels(text), [], text);
  }
});
