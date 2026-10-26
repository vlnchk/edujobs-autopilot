import { randomUUID } from "node:crypto";


const SOCIAL_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "t.me",
  "telegram.me",
  "vk.com",
];

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TELEGRAM_LINK_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([A-Z0-9_]{5,32})(?=$|[\s/?#),.;])/gi;
const TELEGRAM_USERNAME_PATTERN = /(?<![\w@])@([A-Z0-9_]{5,32})\b/gi;
const PHONE_PATTERN = /(?<![\w/])\+?\d[\d\s().-]{5,}\d(?!\w)/g;
export const RESERVED_TELEGRAM_PATHS = new Set(["joinchat", "share", "s"]);
const SHARED_RECRUITING_PATH_SEGMENTS = new Set([
  "career",
  "career-opportunities",
  "careers",
  "current-openings",
  "employment-opportunities",
  "job-openings",
  "jobs",
  "join-our-team",
  "join-us",
  "open-positions",
  "vacancies",
  "work-with-us",
]);


export function asString(value) {
  return value === null || value === undefined ? "" : String(value);
}


export function normalizeStructuredText(value) {
  return asString(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


export function normalizeForExactComparison(value) {
  return normalizeStructuredText(value).replace(/\s+/g, " ");
}


// Unknown URL paths are not evidence that a page represents only one vacancy.
// Require the same project and complete submitted vacancy text; comparing the
// whole text conservatively preserves role qualifiers without extracting titles.
function hasMatchingVacancyEvidence(current, existing) {
  const description = normalizeForExactComparison(current.short_description).toLowerCase();
  return Boolean(
    current.project_link &&
    existing.project_link === current.project_link &&
    description &&
    description === normalizeForExactComparison(existing.short_description).toLowerCase()
  );
}

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}


export function isPlausibleBareDomain(value) {
  if (/[@\\\s]/.test(value)) {
    return false;
  }
  const authorityEnd = value.search(/[/?#]/);
  const hostname = authorityEnd === -1 ? value : value.slice(0, authorityEnd);
  if (!hostname || hostname.length > 253) {
    return false;
  }
  const labels = hostname.split(".");
  if (labels.length < 2 || !/^[A-Z]{2,63}$/i.test(labels.at(-1))) {
    return false;
  }
  return labels.every(
    (label) =>
      label.length <= 63 &&
      /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label),
  );
}


// Shared by Project Link and Original Link: a complete simple Markdown link or a
// whole bare domain is a URL representation, not a malformed source.
export function submittedLinkUrlCandidate(value) {
  const input = asString(value).trim();
  const markdown = /^\[[^\]\r\n]*\]\(\s*([^()\s]+)\s*\)$/.exec(input);
  const candidate = markdown ? markdown[1] : input;
  if (/^https?:\/\//i.test(candidate) || !candidate) {
    return candidate;
  }
  return isPlausibleBareDomain(candidate) ? `https://${candidate}` : candidate;
}


export function inspectUrl(value) {
  const input = asString(value).trim();
  if (!input) {
    return {
      present: false,
      valid: false,
      normalized: null,
      malformed: false,
      unsupported_social: false,
    };
  }

  try {
    const parsed = new URL(input);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new TypeError("Unsupported URL");
    }
    if (parsed.username || parsed.password) {
      throw new TypeError("Credential-bearing URL");
    }
    parsed.hash = "";
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return {
      present: true,
      valid: true,
      normalized: parsed.toString(),
      malformed: false,
      unsupported_social: SOCIAL_DOMAINS.some((domain) =>
        hostMatches(hostname, domain),
      ),
    };
  } catch {
    return {
      present: true,
      valid: false,
      normalized: null,
      malformed: true,
      unsupported_social: false,
    };
  }
}


export function inspectSubmittedLink(value) {
  return inspectUrl(submittedLinkUrlCandidate(value));
}


export function isSharedGenericRecruitingUrl(normalizedUrl) {
  const value = asString(normalizedUrl);
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) {
    return false;
  }
  const suffixStart = value.slice(schemeEnd + 3).search(/[/?#]/);
  if (suffixStart === -1) {
    return false;
  }
  const suffix = value.slice(schemeEnd + 3 + suffixStart);
  if (!suffix.startsWith("/") || suffix.includes("?") || suffix.includes("#")) {
    return false;
  }
  const pathname = suffix.replace(/\/+$/, "");
  if (!pathname) {
    return false;
  }
  const finalSegment = pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
  return SHARED_RECRUITING_PATH_SEGMENTS.has(finalSegment);
}


function addUnique(target, value) {
  if (!target.includes(value)) {
    target.push(value);
  }
}


function telegramContact(username, usable, bots) {
  const normalized = username.toLowerCase();
  if (RESERVED_TELEGRAM_PATHS.has(normalized)) {
    return;
  }
  if (normalized.endsWith("bot")) {
    addUnique(bots, `@${normalized}`);
  } else {
    addUnique(usable, `@${normalized}`);
  }
}


function normalizedPhone(candidate) {
  const trimmed = candidate.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return null;
  }
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}


export function normalizeContactInfo(value) {
  const input = asString(value);
  const usable = [];
  const bots = [];

  for (const match of input.matchAll(EMAIL_PATTERN)) {
    addUnique(usable, match[0].toLowerCase());
  }
  for (const match of input.matchAll(TELEGRAM_LINK_PATTERN)) {
    telegramContact(match[1], usable, bots);
  }

  const withoutEmailsAndLinks = input
    .replace(EMAIL_PATTERN, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(TELEGRAM_LINK_PATTERN, " ");
  for (const match of withoutEmailsAndLinks.matchAll(TELEGRAM_USERNAME_PATTERN)) {
    telegramContact(match[1], usable, bots);
  }

  const withoutUsernames = withoutEmailsAndLinks.replace(
    TELEGRAM_USERNAME_PATTERN,
    " ",
  );
  for (const match of withoutUsernames.matchAll(PHONE_PATTERN)) {
    const phone = normalizedPhone(match[0]);
    if (phone) {
      addUnique(usable, phone);
    }
  }

  return {
    normalized: usable.join("\n"),
    usable,
    bots,
    has_valid_contact: usable.length > 0,
    bot_only: usable.length === 0 && bots.length > 0,
  };
}


function normalizedExisting(existing) {
  return {
    row_number: sheetRowNumber(existing.row_number),
    application_id: asString(existing.application_id).trim(),
    short_description: normalizeForExactComparison(
      existing["Short Description"],
    ),
    project_link: inspectSubmittedLink(existing["Project Website Link"]).normalized,
    original_link: inspectSubmittedLink(existing["Original Link"]).normalized,
  };
}


function sheetRowNumber(value) {
  const rowNumber = Number(value);
  return Number.isInteger(rowNumber) && rowNumber >= 2 ? rowNumber : null;
}


export function findExactDuplicate(current, existingApplications = []) {
  const currentRowNumber = sheetRowNumber(current.row_number);
  if (currentRowNumber === null) {
    return {
      is_duplicate: false,
      match: null,
      existing_application_id: null,
    };
  }
  for (const row of existingApplications) {
    const existing = normalizedExisting(row);
    if (
      existing.row_number === null ||
      existing.row_number >= currentRowNumber
    ) {
      continue;
    }
    if (
      current.application_id &&
      existing.application_id === current.application_id
    ) {
      continue;
    }
    if (
      current.original_link &&
      existing.original_link === current.original_link &&
      !isSharedGenericRecruitingUrl(current.original_link) &&
      hasMatchingVacancyEvidence(current, existing)
    ) {
      return {
        is_duplicate: true,
        match: "ORIGINAL_LINK",
        existing_application_id: existing.application_id || null,
      };
    }
    if (
      current.project_link &&
      existing.project_link === current.project_link &&
      existing.short_description === current.short_description
    ) {
      return {
        is_duplicate: true,
        match: "PROJECT_LINK_AND_SHORT_DESCRIPTION",
        existing_application_id: existing.application_id || null,
      };
    }
  }
  return {
    is_duplicate: false,
    match: null,
    existing_application_id: null,
  };
}


function rejection(reason, source, text) {
  return {
    processing_status: "REJECTED",
    eligibility_decision: "REJECT",
    primary_reason: reason,
    reasons: [reason],
    eligibility_evidence: [{ reason, source, text }],
    review_reason: null,
    editorial_mode: null,
    editorial_reason: null,
  };
}


function pendingDecision() {
  return {
    processing_status: "PROCESSING",
    eligibility_decision: null,
    primary_reason: null,
    reasons: [],
    eligibility_evidence: [],
    review_reason: null,
    editorial_mode: null,
    editorial_reason: null,
  };
}


export function prepareApplication(
  row,
  existingApplications = [],
  createApplicationId = randomUUID,
) {
  const raw = {
    timestamp: row["Timestamp"],
    short_description: row["Short Description"],
    project_link: row["Project Website Link"],
    original_link: row["Original Link"],
    contact_info: row["Contact Info"],
  };
  const existingId = asString(row.application_id).trim();
  const applicationId = existingId || createApplicationId();
  const projectLink = inspectSubmittedLink(raw.project_link);
  const originalLink = inspectSubmittedLink(raw.original_link);
  const contact = normalizeContactInfo(raw.contact_info);
  const normalizedShortDescription = normalizeStructuredText(
    raw.short_description,
  );
  const duplicate = findExactDuplicate(
    {
      application_id: applicationId,
      row_number: row.row_number,
      short_description: normalizeForExactComparison(raw.short_description),
      project_link: projectLink.normalized,
      original_link: originalLink.normalized,
    },
    existingApplications,
  );

  let decision = pendingDecision();
  if (!projectLink.valid) {
    decision = rejection(
      "NO_PROJECT_LINK",
      "project_link",
      projectLink.present ? asString(raw.project_link) : "Project Link is missing",
    );
  } else if (originalLink.malformed) {
    // Spec Stage 1 / Section 11.3: the published details link must be usable.
    decision = rejection("LINK_BROKEN", "original_link", asString(raw.original_link));
  } else if (!contact.has_valid_contact) {
    const reason = contact.bot_only
      ? "TELEGRAM_BOT_CONTACT"
      : "NO_VALID_CONTACT";
    decision = rejection(reason, "contact_info", asString(raw.contact_info));
  } else if (duplicate.is_duplicate) {
    decision = rejection(
      "DUPLICATE_APPLICATION",
      "existing_application",
      `match=${duplicate.match}; application_id=${duplicate.existing_application_id ?? "unknown"}`,
    );
  }

  return {
    application_id: applicationId,
    raw,
    normalized: {
      timestamp: normalizeStructuredText(raw.timestamp),
      short_description: normalizedShortDescription,
      project_link: projectLink.normalized,
      original_link: originalLink.normalized,
      contact_info: contact.normalized,
    },
    normalized_contact_info: contact.normalized,
    source_annotations: {
      project_link: {
        missing: !projectLink.present,
        malformed: projectLink.malformed,
        unsupported_social: projectLink.unsupported_social,
      },
      original_link: {
        missing: !originalLink.present,
        malformed: originalLink.malformed,
        unsupported_social: originalLink.unsupported_social,
      },
    },
    duplicate,
    draft_description: null,
    final_description: null,
    ...decision,
  };
}
