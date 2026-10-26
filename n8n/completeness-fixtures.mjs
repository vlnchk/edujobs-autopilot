// Synthetic vacancy and employer-site material only; no saved application text.
export const candidateParts = [
  "Example Academy is hiring a teacher to teach adult learners algebra",
  "through collaborative practical exercises focused discussion interactive demonstrations and individual feedback",
];
export const mergedCandidate = candidateParts.join(" ");
export const splitCandidate = candidateParts.join("\n\n");
export const vacancyContext = [
  "Responsibilities: develop detailed lessons about calculus geometry probability statistics and mathematical reasoning using practical demonstrations individual feedback and interactive classroom activities",
  "Plan differentiated exercises covering assessment preparation learning progress independent assignments revision sessions accessible explanations collaborative projects and curriculum evaluation across several teaching modules",
  "Requirements: experience teaching mathematics alongside knowledge of assessment design inclusive pedagogy digital learning tools classroom facilitation instructional planning and accessible educational materials",
  "Candidates must have strong communication skills demonstrated analytical ability relevant qualifications familiarity with educational software and previous experience supporting learners with different educational backgrounds",
  "Conditions: remote employment with a flexible schedule scheduled evening classes weekly planning meetings regular preparation hours technical support and a written teaching contract",
  "Compensation: salary includes paid preparation time paid holidays training allowances mentoring sessions professional development opportunities and reimbursement for approved educational resources",
].join("\n\n");
export const completeReference = mergedCandidate + "\n" + vacancyContext;
export const conciseSource = [
  "Example Academy is hiring a mathematics teacher to teach adults algebra.",
  "Responsibilities: teach algebra to adults using practical exercises and individual feedback.",
  "Requirements: teaching experience and knowledge of algebra are required.",
  "Conditions: remote employment with evening classes and a flexible schedule.",
  "Compensation: salary includes paid preparation time.",
].join("\n");
export const conciseCandidate = "Example Academy is hiring an experienced algebra teacher for adults. Teach practical lessons and give individual feedback. Remote evening classes with flexible scheduling; salary covers preparation.";
export const noisyContexts = [
  "Home\nMenu\nPrivacy policy\nSubscribe\n".repeat(50),
  [
    "Example University campus news and institutional statistics from the annual university report",
    "The library catalogue contains historical manuscripts scientific journals archival collections rare publications digital repositories and recently donated books",
    "The university museum exhibition presents ancient artefacts archaeological discoveries photographs sculptures paintings and historical maps from several continents",
    "The annual report lists departments campuses buildings laboratories lecture theatres libraries collections publications patents collaborations and international partnerships",
    "The public festival programme includes astronomy demonstrations chemistry experiments musical performances poetry readings public lectures and exhibitions",
  ].join("\n"),
  // Incidental category words on a university page are not missing job details.
  [
    "Home | News | Contact",
    "Library opening hours and the visitor schedule for the historical manuscripts exhibition are available at the reception desk",
    "Student research experience includes exploring ancient civilisations through archaeological discoveries historical archives museum collections and digital repositories",
    "The annual report lists departments campuses buildings laboratories lecture theatres libraries collections publications patents collaborations and international partnerships",
    "The public festival programme includes astronomy demonstrations chemistry experiments musical performances poetry readings public lectures and exhibitions",
  ].join("\n"),
];

// Independent facets: removing just one must not be hidden by the other two,
// employer prose, hiring verbs, headings or a long candidate.
export const fallbackFacets = {
  RESPONSIBILITIES: "Responsibilities:\nDevelop accessible algebra lessons for adult learners.\nReview assignments and provide individual feedback.",
  REQUIREMENTS: "Requirements:\nExperience in tutoring and knowledge of inclusive pedagogy.\nCandidates need a relevant degree and proficiency in assessment design.",
  CONDITIONS: "Conditions:\nRemote employment with evening classes and flexible scheduling.\nA written contract covers paid preparation hours.",
};
export const fallbackAnnouncement = "The educational studio Teach has a catalogue of practical courses and a learning platform for adults. The project connects independent educators with learners across several disciplines. We are hiring an algebra teacher.";
export const fallbackReference = Object.values(fallbackFacets).join("\n\n");
export const fallbackSummary = "Teach is hiring an experienced algebra tutor with a relevant degree, inclusive pedagogy and assessment skills. Develop accessible lessons for adults and review their work with individual feedback. Work remotely in the evenings on a flexible schedule; the contract pays for preparation.";
