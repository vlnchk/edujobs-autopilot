// Synthetic vacancy material only; no saved application text. The submission
// covers the employer, duties, requirements and conditions broadly, while the
// approved vacancy page adds specific details inside those same broad topics.
export const gapSubmission = "Студия «Тетрадь» ищет в команду преподавателя математики для детей. Нужно проводить занятия в игровом формате. Нужен опыт преподавания. Занятия по выходным в Москве, оплата за каждое занятие.";
export const gapMention = "«Тетрадь»";
export const gapProjectUrl = "https://tetrad.example/math";

const gapSentences = {
  about: "Студия «Тетрадь» учит детей математике через игру.",
  duties: "Вести групповые занятия по математике для детей 5–9 лет.",
  method: "Строить урок как структурированную импровизацию: следовать заданному сценарию и свободно реагировать на идеи детей.",
  collaboration: "Вместе с основателями студии развивать программу курса.",
  qualification: "Нужен опыт преподавания математики детям или педагогическое образование.",
  conditions: "Занятия по выходным в Москве, оплата за каждое занятие.",
};

// Equivalent approved Original Link content in unstructured and headed layouts.
export const gapSourceLayouts = {
  prose: [
    `${gapSentences.about} ${gapSentences.duties}`,
    `${gapSentences.method} ${gapSentences.collaboration}`,
    `${gapSentences.qualification} ${gapSentences.conditions}`,
  ].join("\n\n"),
  headings: [
    "О студии", gapSentences.about,
    "Задачи", `${gapSentences.duties} ${gapSentences.method} ${gapSentences.collaboration}`,
    "Требования", gapSentences.qualification,
    "Условия", gapSentences.conditions,
  ].join("\n"),
};

// Section 10.2 (2026-10-06): an established gap names the missing sufficiency
// element only; the facts that fill it are proven by ENRICH's own evidence.
export const gapElements = ["WORK"];

// A faithful MINIMAL body keeps every broad topic of the submission but cannot
// contain the page-only details.
export const gapMinimalCandidate = "Студия «Тетрадь» ищет в команду преподавателя математики для детей: нужно проводить занятия в игровом формате. Требуется опыт преподавания; занятия по выходным в Москве с оплатой за каждое занятие.";

export const gapEnrichCandidate = [
  "Студия «Тетрадь» ищет в команду преподавателя математики для детей 5–9 лет.",
  "Нужно проводить групповые занятия в игровом формате и строить урок как структурированную импровизацию: следовать заданному сценарию и свободно реагировать на идеи детей.",
  "Преподаватель вместе с основателями студии развивает программу курса.",
  "Нужен опыт преподавания математики детям или педагогическое образование. Занятия по выходным в Москве, оплата за каждое занятие.",
].join(" ");
export const gapEnrichFacts = [
  { fact: "Ученики — дети 5–9 лет.", source: "original_link", evidence: "групповые занятия по математике для детей 5–9 лет" },
  { fact: "Урок строится как структурированная импровизация.", source: "original_link", evidence: gapSentences.method },
  { fact: "Преподаватель вместе с основателями развивает программу.", source: "original_link", evidence: gapSentences.collaboration },
  { fact: "Нужен опыт преподавания математики детям или педагогическое образование.", source: "original_link", evidence: gapSentences.qualification },
];

// A materially complete submission: ENRICH may still add employer context, but
// the approved page names no material vacancy detail missing from it.
export const sufficientSubmission = "Студия «Тетрадь» ищет преподавателя математики для детей 5–9 лет. Нужно вести групповые занятия как структурированную импровизацию по заданному сценарию и вместе с основателями развивать программу. Нужен опыт преподавания математики детям или педагогическое образование. Занятия по выходным в Москве, оплата за каждое занятие.";
export const sufficientConcise = "«Тетрадь» ищет преподавателя математики для детей 5–9 лет: групповые занятия-импровизации по сценарию и развитие программы вместе с основателями. Опыт преподавания математики детям или педагогическое образование; выходные в Москве, оплата за занятие.";
