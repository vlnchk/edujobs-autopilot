// Synthetic paired candidates for contract/routing and request-delivery checks.
// Their semantic findings are explicitly mocked; no live model is evaluated.
const role = "Teach Academy hires a methodologist for adult courses.";
const duties = "Design lessons and assess learner assignments.";
const qualification = "Teaching experience and an adult-learning certificate are required.";
const pay = "Pay is 84000 roubles per month.";
const format = "Work remotely, with an onsite meeting every Tuesday.";
const collaboration = "Review materials with the editor before release; the academic lead approves the final plan.";
const sourceBody = [role, duties, qualification, pay, format, collaboration].join(" ");
const praise = "We are a wonderful, inspiring team making a brilliant product.";
const summary = "Teach Academy needs a methodologist for adult courses: design lessons and assess assignments. Teaching experience plus adult-learning certification required. Monthly pay: 84000 roubles. Remote work, onsite every Tuesday. Before release, review materials with the editor and obtain the academic lead's final plan approval.";
const common = { short: sourceBody + " " + praise + " " + duties, faithful: summary };

export const concisionPairs = [
  {
    ...common, name: "repetition and praise versus a lost responsibility",
    lossy: summary.replace(" and assess assignments", ""), missing: "assess learner assignments",
    reason: "Assignment assessment is a separate duty; lesson design alone does not preserve it.",
  },
  {
    ...common, name: "concise qualification versus omitted certification",
    lossy: summary.replace(" plus adult-learning certification", ""), missing: "an adult-learning certificate is required",
    reason: "The certificate is a qualification requirement independent of teaching experience.",
  },
  {
    ...common, name: "concise salary versus omitted pay",
    lossy: summary.replace(" Monthly pay: 84000 roubles.", ""), missing: pay,
    reason: "The candidate loses the compensation amount and pay period despite retaining the work format.",
  },
  {
    ...common, name: "concise format versus omitted attendance constraint",
    lossy: summary.replace("Remote work, onsite every Tuesday.", "Remote work."), missing: "an onsite meeting every Tuesday",
    reason: "The onsite obligation materially qualifies remote work; remote alone does not preserve it.",
  },
  {
    ...common, name: "concrete collaboration versus praise replacing approval",
    lossy: summary.replace(" and obtain the academic lead's final plan approval", "") + " Join our wonderful team.",
    missing: "the academic lead approves the final plan",
    reason: "Peer editing does not preserve the separate approval relationship, and team praise cannot replace it.",
  },
  {
    name: "qualitative direct coordination versus unspecified teamwork",
    short: sourceBody + " You coordinate directly with school partners without an intermediary. " + praise,
    faithful: summary + " Coordinate with school partners directly, without an intermediary.",
    lossy: summary + " Coordinate with school partners.", missing: "directly with school partners without an intermediary",
    reason: "The specific direct coordination relationship is lost; it is material even without a numeric schedule.",
  },
  {
    name: "growth-related duty versus a generic growth claim",
    short: sourceBody + " As the programme expands, you recruit and onboard tutors. " + praise,
    faithful: summary + " Recruit and onboard tutors for programme expansion.",
    lossy: summary + " The programme is expanding.", missing: "you recruit and onboard tutors",
    reason: "Expansion entails explicit recruiting and onboarding duties here; the growth label alone loses them.",
  },
  {
    name: "team scope versus unspecified leadership",
    short: sourceBody + " You lead six tutors. " + praise,
    faithful: summary + " Lead a team of six tutors.",
    lossy: summary + " Lead tutors.", missing: "six tutors",
    reason: "The source states the size of the team this role leads; vague leadership loses that role scope.",
  },
];

export const concisionContext = "Prepare monthly course reports.";
export const concisionFact = { fact: concisionContext, source: "original_link", evidence: concisionContext };
