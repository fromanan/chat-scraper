import {
  Attachment,
  AttachmentKind,
  LinkInfo,
  MessageParseStatus,
  Message,
  PollInfo,
  Reaction,
  ReplyInfo,
} from "./types";
import { sanitizeText } from "./utils";

enum TextType {
  REACT_COUNT,
  MESSAGE_BODY,
  ADDRESS_INFO,
  REPLY_INFO,
  ENTER,
  TIME,
  UNSPECIFIED,
  SENT_MARKER,
}

type TextLabel = {
  type: TextType;
  text: string;
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const SYSTEM_EVENT_PATTERN =
  /\b(?:changed the group (?:photo|name)|created this group|named the group|set (?:his|her|their|your|its|the) .*nickname|added .+ to the group|removed .+ from the group|left the group|joined the group|started (?:a |an )?(?:voice|video)? ?call|missed (?:a |an )?(?:voice|video)? ?call|you are now connected on messenger)\b/i;

function parseClock(
  hoursText: string,
  minutesText: string,
  meridiem: string
): [number, number] {
  let hours = Number(hoursText) % 12;
  if (meridiem.toLowerCase() === "pm") hours += 12;
  return [hours, Number(minutesText)];
}

/** Convert Messenger's local, human-readable time to UTC ISO-8601. */
export function parseMessengerTimestamp(
  rawTime: string,
  referenceDate = new Date()
): string | null {
  const value = sanitizeText(rawTime).trim();
  const clockPattern = "(\\d{1,2}):(\\d{2})\\s*([ap]m)";
  const weekdayMatch = value.match(
    new RegExp(`^(${WEEKDAYS.join("|")})\\s+${clockPattern}$`, "i")
  );
  if (weekdayMatch) {
    const targetDay = WEEKDAYS.indexOf(weekdayMatch[1].toLowerCase());
    const [hours, minutes] = parseClock(
      weekdayMatch[2],
      weekdayMatch[3],
      weekdayMatch[4]
    );
    const result = new Date(referenceDate);
    result.setSeconds(0, 0);
    result.setHours(hours, minutes, 0, 0);
    let daysAgo = (referenceDate.getDay() - targetDay + 7) % 7;
    if (daysAgo === 0 && result.getTime() > referenceDate.getTime()) {
      daysAgo = 7;
    }
    result.setDate(result.getDate() - daysAgo);
    return result.toISOString();
  }

  const relativeMatch = value.match(
    new RegExp(`^(today|yesterday)(?:\\s+at)?\\s+${clockPattern}$`, "i")
  );
  if (relativeMatch) {
    const [hours, minutes] = parseClock(
      relativeMatch[2],
      relativeMatch[3],
      relativeMatch[4]
    );
    const result = new Date(referenceDate);
    result.setHours(hours, minutes, 0, 0);
    if (relativeMatch[1].toLowerCase() === "yesterday") {
      result.setDate(result.getDate() - 1);
    }
    return result.toISOString();
  }

  const monthDatePattern =
    /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?(?:\s+at)?\s+\d{1,2}:\d{2}\s*[ap]m$/i;
  const numericDatePattern =
    /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:,?\s+(?:at\s+)?)\d{1,2}:\d{2}\s*[ap]m$/i;
  if (monthDatePattern.test(value) || numericDatePattern.test(value)) {
    // Explicit Messenger dates are accepted by the browser once the optional
    // connective "at" is removed (for example "Sep 28, 2026 at 9:06 PM").
    let datedValue = value;
    if (!/\b\d{4}\b/.test(datedValue)) {
      if (monthDatePattern.test(datedValue)) {
        datedValue = datedValue.replace(
          /^(\S+\s+\d{1,2})(?=\s+at|\s+\d{1,2}:)/i,
          `$1, ${referenceDate.getFullYear()}`
        );
      } else {
        datedValue = datedValue.replace(
          /^(\d{1,2}\/\d{1,2})(?=,?\s+)/,
          `$1/${referenceDate.getFullYear()}`
        );
      }
    }
    const explicitDate = new Date(
      datedValue
        .replace(/\s+at\s+/i, " ")
        .replace(/(\d)([ap]m)\b/gi, "$1 $2")
    );
    if (Number.isNaN(explicitDate.getTime())) return null;
    // A date without a year may parse into the next occurrence. Messages
    // cannot be in the future, so roll that result back one calendar year.
    if (explicitDate.getTime() > referenceDate.getTime() + 86400000) {
      explicitDate.setFullYear(explicitDate.getFullYear() - 1);
    }
    return explicitDate.toISOString();
  }

  return null;
}

type AccessibleMessageParts = {
  rawTime: string;
  time: string;
  sender: string;
  body: string;
};

/**
 * Split an accessible message label by validating the timestamp portion.
 * A simple comma regex loses messages whose date itself contains a comma,
 * such as "Sep 28, 2026 at 9:06 PM".
 */
function parseAccessibleMessageLabel(
  ariaLabel: string
): AccessibleMessageParts | null {
  if (!ariaLabel.startsWith("At ")) return null;
  const label = ariaLabel.slice(3);
  for (let comma = label.indexOf(", "); comma >= 0; comma = label.indexOf(", ", comma + 2)) {
    const rawTime = sanitizeText(label.slice(0, comma)).trim();
    const time = parseMessengerTimestamp(rawTime);
    if (!time) continue;
    const remainder = label.slice(comma + 2);
    const bodySeparator = remainder.indexOf(": ");
    if (bodySeparator < 1) continue;
    return {
      rawTime,
      time,
      sender: sanitizeText(remainder.slice(0, bodySeparator)).trim(),
      body: remainder.slice(bodySeparator + 2),
    };
  }
  return null;
}

function hasTrailingEllipsis(value: string): boolean {
  const trimmed = value.trim();
  return /\u2026$/.test(trimmed) || /(^|[^.])\.{3}$/.test(trimmed);
}

function stripTrailingEllipsis(value: string): string {
  return value.replace(/\u2026$/, "").replace(/(^|[^.])\.{3}$/, "$1");
}

function comparableText(value: string): string {
  return sanitizeText(value).replace(/\s+/g, " ").trim();
}

/**
 * Accessibility labels sometimes contain a visually truncated preview. When
 * the complete text is also mounted beneath that label, prefer the smallest
 * descendant containing the same prefix without a trailing ellipsis.
 */
function recoverExpandedBody(candidate: Element, ariaBody: string): string {
  const fallback = sanitizeText(ariaBody).trim();
  if (!hasTrailingEllipsis(fallback)) return fallback;

  const prefix = comparableText(stripTrailingEllipsis(fallback));
  const elements = [candidate, ...Array.from(candidate.querySelectorAll("*"))];
  const expandedCandidates = elements
    .flatMap((element) => {
      const htmlElement = element as HTMLElement;
      return [
        ...(htmlElement.innerText || element.textContent || "").split(/\r?\n/),
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
        element.getAttribute("data-tooltip-content") || "",
      ];
    })
    .map((text) =>
      sanitizeText(text.trim()).replace(/\s+(?:View poll|Change vote)$/i, "")
    )
    .filter((text) => {
      const comparable = comparableText(text);
      return (
        comparable.length > prefix.length &&
        comparable.includes(prefix) &&
        !hasTrailingEllipsis(comparable)
      );
    })
    .sort((left, right) => left.length - right.length);

  if (expandedCandidates.length === 0) return fallback;
  const expanded = expandedCandidates[0];
  const normalizedExpanded = comparableText(expanded);
  const prefixIndex = normalizedExpanded.indexOf(prefix);
  return prefixIndex === 0 ? expanded : normalizedExpanded.slice(prefixIndex);
}

function getMessageId(root: Element): string | null {
  const selector = "[data-message-id], [data-testid], [id]";
  const candidate = root.matches(selector)
    ? (root as HTMLElement)
    : root.querySelector<HTMLElement>(selector);
  if (!candidate) return null;
  return (
    candidate.getAttribute("data-message-id") ??
    candidate.getAttribute("data-testid") ??
    candidate.id ??
    null
  );
}

function resolveURL(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value, location.href).href;
  } catch {
    return null;
  }
}

function getFilenameFromURL(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").filter(Boolean).pop();
    return filename ? decodeURIComponent(filename) : null;
  } catch {
    return null;
  }
}

function makeAttachment(
  kind: AttachmentKind,
  url: string,
  options: Partial<Attachment> = {}
): Attachment {
  return {
    kind,
    url,
    previewUrl: options.previewUrl ?? null,
    filename: options.filename ?? getFilenameFromURL(url),
    altText: options.altText ?? null,
    mimeType: options.mimeType ?? null,
    archivePath: null,
    archivePreviewPath: null,
    downloadError: null,
    previewDownloadError: null,
  };
}

function extractAttachments(root: Element): Attachment[] {
  const attachments: Attachment[] = [];
  const seen = new Set<string>();
  const add = (attachment: Attachment) => {
    const key = `${attachment.kind}:${attachment.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      attachments.push(attachment);
    }
  };

  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
    const url = resolveURL(image.currentSrc || image.src);
    if (!url || /emoji\.php/i.test(url)) continue;
    const bounds = image.getBoundingClientRect();
    const altText = image.alt.trim() || image.getAttribute("aria-label");
    const mediaSignal =
      /(?:gif|sticker|photo|image|attachment)/i.test(altText ?? "") ||
      image.closest(
        '[aria-label*="photo" i], [aria-label*="image" i], [aria-label*="GIF" i], [aria-label*="sticker" i], a[href*="photo"], a[href*="attachment"]'
      ) !== null;
    if (bounds.width <= 64 && bounds.height <= 64 && !mediaSignal) continue;

    const kind: AttachmentKind = /sticker/i.test(altText ?? "")
      ? "sticker"
      : /gif/i.test(altText ?? "") || /\.gif(?:$|\?)/i.test(url)
        ? "gif"
        : "image";
    add(makeAttachment(kind, url, { altText }));
  }

  for (const video of Array.from(root.querySelectorAll<HTMLVideoElement>("video"))) {
    const source =
      resolveURL(video.currentSrc || video.src) ??
      resolveURL(video.querySelector<HTMLSourceElement>("source")?.src ?? null);
    if (!source) continue;
    add(
      makeAttachment("video", source, {
        previewUrl: resolveURL(video.poster),
        mimeType:
          video.querySelector<HTMLSourceElement>("source")?.type || null,
      })
    );
  }

  for (const audio of Array.from(root.querySelectorAll<HTMLAudioElement>("audio"))) {
    const source =
      resolveURL(audio.currentSrc || audio.src) ??
      resolveURL(audio.querySelector<HTMLSourceElement>("source")?.src ?? null);
    if (!source) continue;
    add(
      makeAttachment("audio", source, {
        mimeType:
          audio.querySelector<HTMLSourceElement>("source")?.type || null,
      })
    );
  }

  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const url = resolveURL(anchor.href);
    if (!url) continue;
    const label = `${anchor.getAttribute("aria-label") ?? ""} ${anchor.innerText}`;
    const isFile =
      anchor.hasAttribute("download") ||
      /(?:attachment|download|file)/i.test(label) ||
      /messaging\/attachment|\.pdf(?:$|\?)|\.zip(?:$|\?)/i.test(url);
    if (isFile) {
      add(
        makeAttachment("file", url, {
          filename: anchor.download || anchor.innerText.trim() || null,
          altText: anchor.innerText.trim() || null,
        })
      );
    }
  }

  return attachments;
}

function extractReactions(root: Element): Reaction[] {
  const reactions: Reaction[] = [];
  const seen = new Set<string>();
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[aria-label]"))) {
    const label = element.getAttribute("aria-label")?.trim() ?? "";
    const match = label.match(/^(\d+)\s+reactions?\s+with\s+(.+?)(?:;|$)/i);
    if (!match || seen.has(label)) continue;
    seen.add(label);
    reactions.push({
      emoji: match[2].trim(),
      count: Number(match[1]),
      label,
      reactors: [],
    });
  }
  return reactions;
}

/** Parse the actor list Facebook mounts after a reaction summary is opened. */
export function extractReactionDetails(root: Element): Reaction[] {
  const counts = new Map<string, number>();
  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>(
      '[role="tab"], [aria-selected], button'
    )
  )) {
    const label = sanitizeText(
      element.getAttribute("aria-label") ||
        element.innerText ||
        element.textContent ||
        ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const match = label.match(/^(.+?)\s+(\d+)$/u);
    if (!match || /^all$/i.test(match[1].trim())) continue;
    const emoji = match[1].trim();
    if (emoji.length <= 16 && !/[a-z]/i.test(emoji)) {
      counts.set(emoji, Number(match[2]));
    }
  }

  const actorMap = new Map<string, Set<string>>();
  for (const link of Array.from(
    root.querySelectorAll<HTMLElement>(
      'a, [role="link"], button, [role="button"]'
    )
  )) {
    const pieces = [
      link.getAttribute("aria-label") || "",
      link.getAttribute("title") || "",
      link.innerText || link.textContent || "",
      ...Array.from(link.querySelectorAll<HTMLElement>("*")).flatMap(
        (element) => [
          element.getAttribute("aria-label") || "",
          element.getAttribute("alt") || "",
          element.getAttribute("title") || "",
        ]
      ),
    ]
      .map((value) => sanitizeText(value).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const combined = pieces.join(" ");
    if (!/click to (?:view profile|remove)/i.test(combined)) continue;

    let emoji = Array.from(counts.keys()).find((candidate) =>
      combined.includes(candidate)
    );
    const combinedMatch = combined.match(
      /^(.+?)\s+Click to (?:view profile|remove)\s+(.+?)(?:\s|$)/i
    );
    if (!emoji && counts.size === 1) {
      emoji = Array.from(counts.keys())[0];
    }
    if (!emoji && combinedMatch?.[2]) {
      emoji = combinedMatch[2].trim();
    }
    if (!emoji) continue;

    const reactorCandidates = [
      combinedMatch?.[1] ?? "",
      link.innerText || "",
      link.textContent || "",
    ]
      .map((value) =>
        sanitizeText(value)
          .replace(/click to (?:view profile|remove)/gi, "")
          .replace(emoji!, "")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(
        (value) =>
          value.length > 0 &&
          value.length <= 120 &&
          !/^message reactions$/i.test(value)
      );
    const reactor = reactorCandidates[0];
    if (!reactor) continue;
    const reactors = actorMap.get(emoji) ?? new Set<string>();
    reactors.add(reactor);
    actorMap.set(emoji, reactors);
  }

  const emojis = new Set([...counts.keys(), ...actorMap.keys()]);
  return Array.from(emojis).map((emoji) => {
    const reactors = Array.from(actorMap.get(emoji) ?? []);
    const count = counts.get(emoji) ?? reactors.length;
    return {
      emoji,
      count,
      label: `${count} reaction${count === 1 ? "" : "s"} with ${emoji}`,
      reactors,
    };
  });
}

function extractLinks(root: Element): LinkInfo[] {
  const links: LinkInfo[] = [];
  const seen = new Set<string>();
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const url = resolveURL(anchor.href);
    const label = anchor.getAttribute("aria-label") ?? "";
    if (
      !url ||
      seen.has(url) ||
      /^(?:Go to replied message|View poll|Enter, Message sent)/i.test(label) ||
      /^https:\/\/(?:www\.)?facebook\.com\/messages\//i.test(url)
    ) {
      continue;
    }
    seen.add(url);
    links.push({ url, text: anchor.innerText.trim() || null });
  }
  return links;
}

function extractReplyInfo(root: Element): ReplyInfo | null {
  const replyButton = Array.from(
    root.querySelectorAll<HTMLElement>('[aria-label^="Go to replied message"]')
  )[0];
  if (!replyButton) return null;

  const texts = [
    root as HTMLElement,
    ...Array.from(root.querySelectorAll<HTMLElement>("*")),
  ]
    .map((element) =>
      comparableText(element.innerText || element.textContent || "")
    )
    .filter(Boolean)
    .sort((left, right) => left.length - right.length);
  const replyHeading = texts.find((text) => /.+ replied to .+/i.test(text));
  const match = replyHeading?.match(/^(.*?) replied to (.+)$/i);
  const originalBody = sanitizeText(
    (replyButton.innerText || replyButton.textContent || "").trim()
  ).replace(/^Original message:\s*/i, "");
  return {
    to: match?.[2]?.trim() || "Unknown",
    body: originalBody || "Unavailable reply preview",
  };
}

export function extractPollInfo(root: Element, body: string): PollInfo | null {
  const lines = (root as HTMLElement).innerText
    .split(/\r?\n/)
    .map((line) => sanitizeText(line).trim())
    .filter(Boolean);
  const ariaLabels = Array.from(
    root.querySelectorAll<HTMLElement>("[aria-label]")
  ).map((element) => element.getAttribute("aria-label")?.trim() ?? "");
  const hasPoll =
    /created a poll:/i.test(body) ||
    lines.some((line) => /^\d+\s+votes?(?:\s|$)/i.test(line)) ||
    lines.some((line) => /^change vote$/i.test(line)) ||
    ariaLabels.some((label) => /^\d+\s+votes?(?:\s|$)/i.test(label));
  if (!hasPoll) return null;

  const bodyQuestion = body.match(/created a poll:\s*(.*)$/i)?.[1]?.trim() ?? "";
  let question = bodyQuestion;
  if (!question) {
    const lines = (root as HTMLElement).innerText
      .split(/\r?\n/)
      .map((line) => sanitizeText(line).trim())
      .filter(Boolean);
    question =
      lines.find(
        (line) =>
          !/^poll$/i.test(line) &&
          !/\b(?:voted|votes?|view poll|change vote)\b/i.test(line)
      ) ?? "";
  }
  if (question) question = recoverExpandedBody(root, question);

  const voteElements = Array.from(
    root.querySelectorAll<HTMLElement>("[aria-label]")
  )
    .map((element) => ({
      element,
      match: element
        .getAttribute("aria-label")
        ?.trim()
        .match(/^(\d+)\s+votes?(?:\s|$)/i),
    }))
    .filter(
      (
        candidate
      ): candidate is { element: HTMLElement; match: RegExpMatchArray } =>
        candidate.match !== undefined && candidate.match !== null
    );
  const voteCounts = voteElements.map(({ match }) => Number(match[1]));
  if (voteCounts.length === 0) {
    voteCounts.push(
      ...lines.flatMap((line) => {
        const match = line.match(/^(\d+)\s+votes?(?:\s|$)/i);
        return match ? [Number(match[1])] : [];
      })
    );
  }
  const optionCandidates = lines.filter(
    (line) =>
      !/^\+\d+$/.test(line) &&
      !/^\d+\s+votes?(?:\s|$)/i.test(line) &&
      !/^(?:view poll|change vote|add option\.\.\.|cancel|submit|vote)$/i.test(
        line
      ) &&
      !/\b(?:created a poll|voted for .+ in the poll)\b/i.test(line) &&
      line !== question
  );
  const optionTexts = voteElements.map(({ element }, index) => {
    let optionContainer: Element | null = element.closest('[role="listitem"]');
    let ancestor: Element | null = element.parentElement;
    for (let depth = 0; !optionContainer && ancestor && depth < 8; depth++) {
      if (
        ancestor.querySelector(
          '[role="checkbox"][aria-label], input[type="checkbox"][aria-label], [role="radio"][aria-label], input[type="radio"][aria-label]'
        )
      ) {
        optionContainer = ancestor;
        break;
      }
      if (ancestor === root) break;
      ancestor = ancestor.parentElement;
    }
    const optionControl = optionContainer?.querySelector<HTMLElement>(
      '[role="checkbox"][aria-label], input[type="checkbox"][aria-label], [role="radio"][aria-label], input[type="radio"][aria-label]'
    );
    const accessibleOption = sanitizeText(
      optionControl?.getAttribute("aria-label")?.trim() ?? ""
    );
    if (accessibleOption) return accessibleOption;

    const containerLines = optionContainer
      ? (optionContainer as HTMLElement).innerText
          .split(/\r?\n/)
          .map((line) => sanitizeText(line).trim())
          .filter(
            (line) =>
              Boolean(line) &&
              !/^\d+\s+votes?(?:\s|$)/i.test(line) &&
              !/^(?:add option\.\.\.|cancel|submit|vote)$/i.test(line)
          )
      : [];
    return containerLines[0] ?? optionCandidates[index] ?? `Option ${index + 1}`;
  });
  const options = voteCounts.map((votes, index) => ({
    text: optionTexts[index] ?? `Option ${index + 1}`,
    votes,
  }));

  return {
    question: question || "Unavailable poll question",
    options,
    isQuestionTruncated: hasTrailingEllipsis(question),
  };
}

function getWarnings(
  body: string,
  poll: PollInfo | null,
  attachments: Attachment[]
): string[] {
  const warnings: string[] = [];
  if (hasTrailingEllipsis(body)) {
    warnings.push("Facebook exposed only a truncated message preview.");
  }
  if (poll?.isQuestionTruncated) {
    warnings.push("Facebook exposed only a truncated poll question preview.");
  }
  if (poll && poll.options.length === 0) {
    warnings.push("A poll was detected but Facebook did not mount its options.");
  }
  if (/sent (?:an? )?(?:photo|image|GIF|sticker|attachment)/i.test(body) && attachments.length === 0) {
    warnings.push("A media message was detected but no retrievable media URL was mounted.");
  }
  return warnings;
}

function getSystemEventText(root: Element): string | null {
  const candidates = [root, ...Array.from(root.querySelectorAll("*"))]
    .flatMap((element) => {
      const htmlElement = element as HTMLElement;
      return (htmlElement.innerText || element.textContent || "")
        .split(/\r?\n/)
        .map((line) => sanitizeText(line).replace(/\s+/g, " ").trim());
    })
    .filter((text) => text.length > 0 && SYSTEM_EVENT_PATTERN.test(text))
    .sort((left, right) => left.length - right.length);
  return candidates[0] ?? null;
}

function inferMediaSender(root: Element): string {
  const ownLines = (root as HTMLElement).innerText
    .split(/\r?\n/)
    .map((line) => sanitizeText(line).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const precedingLines: string[] = [];
  let sibling = root.previousElementSibling;
  for (let count = 0; sibling && count < 2; count++) {
    const text = sanitizeText(
      ((sibling as HTMLElement).innerText || sibling.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (text) precedingLines.push(text);
    sibling = sibling.previousElementSibling;
  }
  const lines = [...precedingLines, ...ownLines];
  return (
    lines.find(
      (line) =>
        line.length <= 80 &&
        /^[\p{L}\p{N} _'’-]+$/u.test(line) &&
        !/^(?:enter|share|download|play|pause|open|view|see|sent)$/i.test(line)
    ) ?? "Unknown"
  );
}

function getAccessibleMessage(elt: Element): Message | null {
  const candidates = [elt, ...Array.from(elt.querySelectorAll("[aria-label]"))];
  for (const candidate of candidates) {
    const ariaLabel = candidate.getAttribute("aria-label");
    if (!ariaLabel || ariaLabel.startsWith("Enter, Message sent")) continue;

    const parsedLabel = parseAccessibleMessageLabel(ariaLabel);
    if (!parsedLabel) continue;

    const { rawTime, time, sender } = parsedLabel;
    const body = recoverExpandedBody(candidate, parsedLabel.body);
    const attachments = extractAttachments(elt);
    const poll = extractPollInfo(elt, body);
    const replyInfo = extractReplyInfo(elt);
    const reactions = extractReactions(elt);
    const links = extractLinks(elt);

    return {
      id: getMessageId(candidate),
      kind: poll
        ? "poll"
        : attachments.length > 0
          ? "media"
          : "message",
      time,
      rawTime,
      replyInfo,
      sender,
      body,
      bodyTruncated: hasTrailingEllipsis(body),
      edited: /(?:^|\s)Edited(?:\s|$)/i.test((elt as HTMLElement).innerText),
      reactions,
      attachments,
      links,
      poll,
      warnings: getWarnings(body, poll, attachments),
      isImage: attachments.some((attachment) =>
        ["image", "gif", "sticker"].includes(attachment.kind)
      ),
    };
  }
  return null;
}

/**
 * Retrieves the message content from a given element.
 *
 * @param elt the element containing the message content.
 * @return the extracted message content or null if there was an error.
 */
export function getMessageContent(
  elt: Element
): [Message | null, MessageParseStatus] {
  if (!isMessageDiv(elt)) return [null, MessageParseStatus.NOT_A_MESSAGE];

  const accessibleMessage = getAccessibleMessage(elt);
  if (accessibleMessage) {
    return [accessibleMessage, MessageParseStatus.SUCCESS];
  }

  const systemEvent = getSystemEventText(elt);
  if (systemEvent) {
    const attachments = extractAttachments(elt);
    return [
      {
        id: getMessageId(elt),
        kind: "system",
        time: null,
        rawTime: null,
        replyInfo: null,
        sender: "System",
        body: systemEvent,
        bodyTruncated: false,
        edited: false,
        reactions: [],
        attachments,
        links: extractLinks(elt),
        poll: null,
        warnings: [
          "Facebook did not expose a message-level timestamp for this system event.",
        ],
        isImage: attachments.some((attachment) =>
          ["image", "gif", "sticker"].includes(attachment.kind)
        ),
      },
      MessageParseStatus.SUCCESS,
    ];
  }


  const mediaAttachments = extractAttachments(elt);
  if (mediaAttachments.length > 0) {
    const altBody = mediaAttachments
      .map((attachment) => attachment.altText)
      .filter((value): value is string => Boolean(value))
      .join("; ");
    return [
      {
        id: getMessageId(elt),
        kind: "media",
        time: null,
        rawTime: null,
        replyInfo: null,
        sender: inferMediaSender(elt),
        body: altBody || "Sent an attachment",
        bodyTruncated: false,
        edited: false,
        reactions: extractReactions(elt),
        attachments: mediaAttachments,
        links: extractLinks(elt),
        poll: null,
        warnings: [
          "Facebook did not expose a message-level timestamp for this media item.",
        ],
        isImage: mediaAttachments.some((attachment) =>
          ["image", "gif", "sticker"].includes(attachment.kind)
        ),
      },
      MessageParseStatus.SUCCESS,
    ];
  }

  const textLabels = getMessageTextIncompleteLabels(elt);

  let time: string | null = null;
  let rawTime: string | null = null;
  while (textLabels.length > 0 && textLabels[0].type === TextType.TIME) {
    rawTime = textLabels[0].text;
    time = parseMessengerTimestamp(rawTime);
    textLabels.shift();
  }

  if (textLabels.length === 0) return [null, MessageParseStatus.EMPTY_MESSAGE];

  if (textLabels.length === 1) {
    const text = textLabels[0].text;
    if (text === "You are now connected on Messenger")
      return [null, MessageParseStatus.TERMINATE];
    return [
      {
        id: getMessageId(elt),
        kind: "system",
        time,
        rawTime,
        replyInfo: null,
        sender: "System",
        body: text === "You sent" ? "You sent an attachment" : text,
        bodyTruncated: hasTrailingEllipsis(text),
        edited: false,
        reactions: extractReactions(elt),
        attachments: extractAttachments(elt),
        links: extractLinks(elt),
        poll: null,
        warnings: [],
        isImage: false,
      },
      MessageParseStatus.SUCCESS,
    ];
  }

  let senderName: string | null = null;
  let replyInfo: ReplyInfo | null = null;
  // check if it's a reply by getting index of "Original message:"
  const repliedTo = textLabels.findIndex(
    (label) => label.type === TextType.REPLY_INFO
  );
  if (repliedTo === 0) return [null, MessageParseStatus.UNKNOWN_FORMAT]; // reply missing sender/addressee info
  if (repliedTo > 0) {
    let addresseeName: string | null = null;
    // regex to extract the sender and addressee
    const rx = RegExp("^(.*) replied to (.*)$");
    const match = textLabels[0].text.match(rx);
    if (match) {
      senderName = match[1];
      addresseeName = match[2];
    }
    if (addresseeName === null || senderName === null) {
      return [null, MessageParseStatus.UNKNOWN_FORMAT];
    }

    textLabels.shift(); // remove "X replied to Y"
    // remove extra stuff present in edited replies
    while (
      textLabels.length > 0 &&
      textLabels[0].text !== "Original message:"
    ) {
      textLabels.shift();
    }
    if (textLabels.length < 3) return [null, MessageParseStatus.UNKNOWN_FORMAT];
    textLabels.shift(); // remove "Original message:"

    let originalMessage = textLabels[0].text;
    textLabels.shift();
    if (textLabels[0].text === "…") {
      originalMessage += "...";
      textLabels.shift();
    }

    replyInfo = {
      to: addresseeName,
      body: originalMessage,
    };
  } else {
    if (textLabels.length === 0)
      return [null, MessageParseStatus.UNKNOWN_FORMAT];
    senderName = textLabels[0].text;
    senderName = senderName === "You sent" ? "You" : senderName;
    textLabels.shift();
  }

  const messageBody = textLabels.map((label) => label.text).join(" ");
  const attachments = extractAttachments(elt);
  const poll = extractPollInfo(elt, messageBody);

  return [
    {
      id: getMessageId(elt),
      kind: poll
        ? "poll"
        : attachments.length > 0
          ? "media"
          : "message",
      time,
      rawTime,
      replyInfo,
      sender: senderName,
      body: messageBody,
      bodyTruncated: hasTrailingEllipsis(messageBody),
      edited: /(?:^|\s)Edited(?:\s|$)/i.test((elt as HTMLElement).innerText),
      reactions: extractReactions(elt),
      attachments,
      links: extractLinks(elt),
      poll,
      warnings: getWarnings(messageBody, poll, attachments),
      isImage: attachments.some((attachment) =>
        ["image", "gif", "sticker"].includes(attachment.kind)
      ),
    },
    MessageParseStatus.SUCCESS,
  ];
}

function getMessageTextIncompleteLabels(node: Node): TextLabel[] {
  if (node instanceof Text) {
    const parentElt = node.parentElement;
    let textType: TextType = TextType.UNSPECIFIED;
    if (parentElt) {
      if (
        parentElt.getAttribute("role") === "none" &&
        parentElt.style.width === "1ch"
      ) {
        textType = TextType.REACT_COUNT;
      } else if (node.data === "Enter") {
        textType = TextType.ENTER;
      } else if (node.data === "Original message:") {
        textType = TextType.REPLY_INFO;
      } else if (
        node.data.startsWith("Sent") &&
        parentElt instanceof HTMLSpanElement
      ) {
        textType = TextType.SENT_MARKER;
      } else if (parentElt.closest("h3[dir='auto']")) {
        textType = TextType.TIME;
      }
    }

    if (
      textType === TextType.ENTER ||
      textType === TextType.REACT_COUNT ||
      textType === TextType.SENT_MARKER
    )
      return [];
    const text = sanitizeText(node.data);
    return [{ type: textType, text }];
  }
  if (node instanceof Element) {
    return Array.from(node.childNodes).flatMap(getMessageTextIncompleteLabels);
  }
  return [];
}

export function isMessageDiv(elt: Element): boolean {
  return (
    elt instanceof HTMLElement &&
    (getAccessibleMessage(elt) !== null ||
      getSystemEventText(elt) !== null ||
      extractAttachments(elt).length > 0)
  );
}

/**
 * Returns true if the element is a profile banner at the beginning of a chat (termination condition)
 */
export function isProfileBanner(elt: Element): boolean {
  return (
    elt instanceof HTMLDivElement &&
    elt.classList.contains("html-div") &&
    elt.getAttribute("role") === "presentation"
  );
}
