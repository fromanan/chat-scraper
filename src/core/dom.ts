import { findFirstDescendant } from "./utils";

/**
 * @returns div containing the message panel
 */
function findMessageDiv(): HTMLElement | null {
  return findFirstDescendant(document.body, false, (elt) => {
    const ariaLabel = elt.getAttribute("aria-label");
    if (!ariaLabel) return false;
    return ariaLabel.startsWith("Messages in conversation ");
  });
}

/**
 * Given the message panel div, finds the scrollable message container within it
 *
 * @param domElement
 */
function findScrollableMessageContainer(
  domElement: HTMLElement
): HTMLElement | null {
  return findFirstDescendant(domElement, true, (elt) => {
    const overflowY = getComputedStyle(elt).overflowY;
    return (
      (overflowY === "auto" || overflowY === "scroll") &&
      elt.scrollHeight > elt.clientHeight
    );
  });
}

export type ChatDOMContext = {
  chatName: string;
  messageContainer: HTMLElement;
  scrollContainer: HTMLElement;
};

const ACCESSIBLE_MESSAGE_LABEL = /^At .*?, .*?: [\s\S]*$/;
const SYSTEM_EVENT_PATTERN =
  /\b(?:changed the group (?:photo|name)|created this group|named the group|set (?:his|her|their|your|its|the) .*nickname|added .+ to the group|removed .+ from the group|left the group|joined the group|started (?:a |an )?(?:voice|video)? ?call|missed (?:a |an )?(?:voice|video)? ?call|you are now connected on messenger)\b/i;

/**
 * Finds the lowest container whose direct child branches hold the accessible
 * Messenger message rows. Facebook removed the old role="grid" marker, so
 * returning the labelled conversation container itself is one level too high
 * and causes the scraper to treat the entire visible history as one message.
 */
function findAccessibleMessageList(
  domElement: HTMLElement
): HTMLElement | null {
  const messageElements = Array.from(
    domElement.querySelectorAll<HTMLElement>('[aria-label^="At "]')
  ).filter((elt) =>
    ACCESSIBLE_MESSAGE_LABEL.test(elt.getAttribute("aria-label") ?? "")
  );
  if (messageElements.length === 0) return null;

  let candidate = messageElements[0].parentElement;
  while (candidate && domElement.contains(candidate)) {
    if (messageElements.every((message) => candidate!.contains(message))) {
      const messageBranches = Array.from(candidate.children).filter((child) =>
        messageElements.some(
          (message) => child === message || child.contains(message)
        )
      );
      if (messageBranches.length > 1) return candidate;
    }
    if (candidate === domElement) break;
    candidate = candidate.parentElement;
  }

  return messageElements[0].parentElement;
}

function getAccessibleMessageElements(
  domElement: HTMLElement
): HTMLElement[] {
  const candidates = Array.from(
    domElement.querySelectorAll<HTMLElement>('[aria-label^="At "]')
  ).filter((elt) =>
    ACCESSIBLE_MESSAGE_LABEL.test(elt.getAttribute("aria-label") ?? "")
  );

  // Facebook can repeat the same label on nested wrappers. Keep the deepest
  // one so each visible message produces exactly one row candidate.
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && candidate.contains(other)
      )
  );
}

function expandToSingleMessageRow(
  messageElement: HTMLElement,
  messageContainer: HTMLElement,
  messageElements: HTMLElement[]
): HTMLElement {
  let row = messageElement;
  let parent = row.parentElement;
  while (parent && messageContainer.contains(parent)) {
    const containedMessages = messageElements.filter((message) =>
      parent!.contains(message)
    );
    if (containedMessages.length !== 1) break;
    row = parent;
    if (parent === messageContainer) break;
    parent = parent.parentElement;
  }
  return row;
}

function getSystemEventElements(domElement: HTMLElement): HTMLElement[] {
  const candidates = Array.from(domElement.querySelectorAll<HTMLElement>("*"))
    .filter((element) => {
      if (element.querySelector('[aria-label^="At "]')) return false;
      const text = (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      return text.length > 0 && text.length <= 500 && SYSTEM_EVENT_PATTERN.test(text);
    });

  // Keep the smallest wrapper containing each event. Larger ancestors repeat
  // the same text and would otherwise create duplicate records.
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && candidate.contains(other)
      )
  );
}

function getStandaloneMediaRows(
  domElement: HTMLElement,
  existingRows: HTMLElement[],
  chatName = ""
): HTMLElement[] {
  const conversationName =
    chatName.toLowerCase() ||
    (domElement
      .getAttribute("aria-label")
      ?.match(/Messages in conversation (?:with|titled) (.*)/)?.[1]
      ?.toLowerCase() ?? "");
  const mediaElements = Array.from(
    domElement.querySelectorAll<HTMLElement>("img, video, audio")
  ).filter((element) => {
    if (existingRows.some((row) => row.contains(element))) return false;
    if (element instanceof HTMLImageElement) {
      const label = `${element.alt} ${element.getAttribute("aria-label") ?? ""}`;
      if (
        conversationName &&
        label.toLowerCase().includes(conversationName)
      ) {
        return false;
      }
      const signaled = /(?:gif|sticker|photo|image|attachment)/i.test(label);
      // Conversation avatars and profile banners can be large and otherwise
      // unlabeled while Messenger is still loading. Treating size alone as a
      // media-message signal produced one-record exports containing only the
      // chat avatar. Actual standalone message media carries an accessible
      // photo/image/GIF/sticker/attachment label.
      return signaled;
    }
    return true;
  });

  return mediaElements
    .map((media) => {
      let row = media;
      let parent = row.parentElement;
      while (parent && domElement.contains(parent)) {
        if (parent.querySelector('[aria-label^="At "]')) break;
        const mediaCount = parent.querySelectorAll("img, video, audio").length;
        if (mediaCount !== 1) break;
        row = parent;
        if (parent === domElement) break;
        parent = parent.parentElement;
      }
      return row;
    })
    .filter((row, index, rows) => rows.indexOf(row) === index);
}

/**
 * Returns the currently mounted conversation rows in DOM order. Messenger
 * virtualizes long conversations, so callers must re-run this after every
 * scroll instead of retaining the returned elements or their parent.
 */
export function getCurrentMessageRows(
  messageContainer: HTMLElement,
  chatName = ""
): Element[] {
  const messageElements = getAccessibleMessageElements(messageContainer);
  if (messageElements.length > 0) {
    const messageRows = messageElements.map((message) =>
      expandToSingleMessageRow(message, messageContainer, messageElements)
    );
    const systemRows = getSystemEventElements(messageContainer);
    const knownRows = [...messageRows, ...systemRows];
    const rows = [
      ...knownRows,
      ...getStandaloneMediaRows(messageContainer, knownRows, chatName),
    ].filter((row, index, allRows) => allRows.indexOf(row) === index);
    return rows.sort((left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });
  }

  const scrollContainer = findScrollableMessageContainer(messageContainer);
  const legacyList = scrollContainer?.firstElementChild;
  return legacyList ? Array.from(legacyList.children) : [];
}

export function getChatDOMContext(): ChatDOMContext | null {
  const messageContainer = findMessageDiv();
  if (!messageContainer) return null;

  const ariaLabel = messageContainer.getAttribute("aria-label");
  const match = ariaLabel?.match(
    /Messages in conversation (?:with|titled) (.*)/
  );
  if (!match) return null;

  const scrollContainer = findScrollableMessageContainer(messageContainer);
  if (!scrollContainer) return null;

  return {
    chatName: match[1],
    messageContainer,
    scrollContainer,
  };
}

/**
 * @returns The div that contains all the messages, or null if not found
 */
export function getChatNameAndMessageDiv(): {
  chatName: string;
  messageDiv: HTMLElement;
} | null {
  const context = getChatDOMContext();
  if (!context) return null;
  const { chatName, messageContainer, scrollContainer } = context;

  const accessibleMessageList = findAccessibleMessageList(messageContainer);
  if (accessibleMessageList) {
    return { chatName, messageDiv: accessibleMessageList };
  }

  const messageDiv = scrollContainer.firstElementChild;
  if (!(messageDiv instanceof HTMLElement)) {
    return null;
  }
  return { chatName, messageDiv };
}
