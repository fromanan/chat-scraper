import {
  ChatDOMContext,
  getChatDOMContext,
  getCurrentMessageRows,
} from "./dom";
import {
  downloadJSONFile,
  downloadTextAsFile,
  openHTMLInNewWindow,
  writeJSONToNewWindow,
} from "./utils";
import {
  extractPollInfo,
  extractReactionDetails,
  getMessageContent,
  isMessageDiv,
  isProfileBanner,
} from "./messageParser";
import { makeScraperPanel } from "./panel";
import {
  getHTMLStringFromMessageJSON,
  getRawStringFromMessageJSON,
} from "./format";
import { Exporter, MessageParseStatus, Message } from "./types";
import { downloadCompleteArchive } from "./archive";

const POLLING_TIME = 250;
const SCROLL_SETTLE_MS = 750;
const LATEST_READY_SETTLE_MS = 2500;
const LATEST_READY_TIMEOUT_MS = 15000;
const END_OF_HISTORY_WAIT_MS = 8000;
const HISTORY_SCROLL_RATIO = 0.2;
const POLL_DIALOG_WAIT_MS = 3000;

/**
 * Wires together all the logic for the scraper and displays the scraper UI,
 * which is the user's interface to all functionalities of the scraper.
 */
function initializeScraper() {
  const panel = makeScraperPanel();
  if (!panel) {
    return;
  }
  const { startScrape, stopScrape } = scrapeFactory({
    handleStartScrapeUI: (chatName: string) => {
      panel.setCurrentChatName(chatName);
    },
    handleHistoryBoundaryUI: () => {
      panel.setAtHistoryStart();
    },
    handleStopScrapeUI: (downloader, windowOpener) => {
      panel.setIdle();
      panel.showExportOptions();
      panel.setDownloadHandler(downloader);
      panel.setOpenInNewWindowHandler(windowOpener);
    },
  });
  panel.setStartScrapeHandler(startScrape);
  panel.setStopScrapeHandler(stopScrape);
  panel.display();
}

type ScrapeFactoryParams = {
  /**
   * Function to trigger UI changes when the system starts the scrape
   */
  handleStartScrapeUI: (chatName: string) => void;
  /** Function to show that manual mode has reached the oldest message. */
  handleHistoryBoundaryUI: () => void;
  /**
   * Function to trigger UI changes when the system finishes scraping
   */
  handleStopScrapeUI: (downloader: Exporter, windowOpener: Exporter) => void;
};

type ScrapeFactoryOutput = {
  /** Function to trigger system to scrape when the user initiates it. */
  startScrape: (autoStopAtHistoryStart?: boolean) => void;
  /** Function to trigger system to terminate scrape when the user stops it. */
  stopScrape: () => void;
};

/**
 * @param handleStartScrapeUI
 * @param handleStopScrapeUI function to trigger UI changes
 * when the system stops the scrape
 */
function scrapeFactory({
  handleStartScrapeUI,
  handleHistoryBoundaryUI,
  handleStopScrapeUI,
}: ScrapeFactoryParams): ScrapeFactoryOutput {
  let chatName: string | null = null;
  let processedMessages: (Message | null)[] = [];

  let scrapeProcess: number | null = null;
  let historyBoundaryReachedAt: number | null = null;
  let autoStopAtHistoryStart = false;
  let waitingAtHistoryStart = false;
  let phase: "latest" | "history" = "latest";
  let phaseStartedAt = 0;
  let lastScrollAt = 0;
  let finishRequested = false;
  let pollHydrationActive = false;
  let reactionHydrationActive = false;
  const queuedPollKeys = new Set<string>();
  const pollHydrationQueue: Array<{
    key: string;
    body: string;
    trigger: HTMLElement;
  }> = [];
  const queuedReactionKeys = new Set<string>();
  const reactionHydrationQueue: Array<{
    key: string;
    reactionLabel: string;
    trigger: HTMLElement;
  }> = [];

  const reachHistoryStart = () => {
    if (!waitingAtHistoryStart && !autoStopAtHistoryStart) {
      handleHistoryBoundaryUI();
    }
    waitingAtHistoryStart = true;
    return autoStopAtHistoryStart;
  };

  const messageFingerprint = (message: Message) =>
    JSON.stringify([
      message.time,
      message.rawTime,
      message.sender,
      message.body,
      message.replyInfo,
    ]);

  const messageKey = (message: Message) =>
    message.id
      ? `id:${message.id}`
      : message.attachments.length > 0
        ? `media:${message.attachments[0].url}`
        : `content:${messageFingerprint(message)}`;

  const mergeMessageDetails = (existing: Message, incoming: Message): Message => {
    const preferIncomingBody =
      existing.bodyTruncated &&
      (!incoming.bodyTruncated || incoming.body.length > existing.body.length);
    const attachments = [...existing.attachments];
    for (const attachment of incoming.attachments) {
      if (
        !attachments.some(
          (candidate) =>
            candidate.kind === attachment.kind &&
            candidate.url === attachment.url
        )
      ) {
        attachments.push(attachment);
      }
    }
    const links = [...existing.links];
    for (const link of incoming.links) {
      if (!links.some((candidate) => candidate.url === link.url)) {
        links.push(link);
      }
    }
    const poll =
      !existing.poll ||
      (existing.poll.isQuestionTruncated &&
        (!incoming.poll?.isQuestionTruncated ||
          (incoming.poll?.question.length ?? 0) > existing.poll.question.length))
        ? incoming.poll ?? existing.poll
        : existing.poll;
    const body = preferIncomingBody ? incoming.body : existing.body;
    const bodyTruncated = preferIncomingBody
      ? incoming.bodyTruncated
      : existing.bodyTruncated;
    const mergedTime = existing.time ?? incoming.time;
    const existingReactorCount = existing.reactions.reduce(
      (count, reaction) => count + reaction.reactors.length,
      0
    );
    const incomingReactorCount = incoming.reactions.reduce(
      (count, reaction) => count + reaction.reactors.length,
      0
    );
    const reactions =
      existingReactorCount > incomingReactorCount
        ? existing.reactions
        : incoming.reactions.length > 0
          ? incoming.reactions
          : existing.reactions;
    const warnings = Array.from(
      new Set([...existing.warnings, ...incoming.warnings])
    ).filter((warning) => {
      if (!bodyTruncated && /truncated message preview/i.test(warning)) {
        return false;
      }
      if (poll && !poll.isQuestionTruncated && /truncated poll question/i.test(warning)) {
        return false;
      }
      if (poll && poll.options.length > 0 && /did not mount its options/i.test(warning)) {
        return false;
      }
      if (mergedTime && /did not expose a message-level timestamp/i.test(warning)) {
        return false;
      }
      return true;
    });
    return {
      ...existing,
      id: existing.id ?? incoming.id,
      time: mergedTime,
      rawTime: existing.rawTime ?? incoming.rawTime,
      kind:
        poll !== null
          ? "poll"
          : attachments.length > 0
            ? "media"
            : existing.kind,
      body,
      bodyTruncated,
      replyInfo: incoming.replyInfo ?? existing.replyInfo,
      sender:
        existing.sender === "Unknown" && incoming.sender !== "Unknown"
          ? incoming.sender
          : existing.sender,
      edited: existing.edited || incoming.edited,
      reactions,
      attachments,
      links,
      poll,
      warnings,
      isImage: attachments.some((attachment) =>
        ["image", "gif", "sticker"].includes(attachment.kind)
      ),
    };
  };

  const mergeAlignedMessages = (
    target: Message[],
    targetStart: number,
    source: Message[]
  ) => {
    source.forEach((message, offset) => {
      target[targetStart + offset] = mergeMessageDetails(
        target[targetStart + offset],
        message
      );
    });
  };

  const findSequence = (haystack: string[], needle: string[]) => {
    if (needle.length === 0) return 0;
    for (let start = 0; start <= haystack.length - needle.length; start++) {
      let matches = true;
      for (let offset = 0; offset < needle.length; offset++) {
        if (haystack[start + offset] !== needle[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) return start;
    }
    return -1;
  };

  const addPollWarning = (key: string, warning: string) => {
    const message = (processedMessages as Message[]).find(
      (candidate) => messageKey(candidate) === key
    );
    if (message && !message.warnings.includes(warning)) {
      message.warnings.push(warning);
    }
  };

  const addReactionWarning = (key: string, warning: string) => {
    const message = (processedMessages as Message[]).find(
      (candidate) => messageKey(candidate) === key
    );
    if (message && !message.warnings.includes(warning)) {
      message.warnings.push(warning);
    }
  };

  const waitForPollDialog = () =>
    new Promise<HTMLElement>((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        const dialog = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"]')
        ).find((candidate) => candidate.getClientRects().length > 0);
        if (dialog) {
          resolve(dialog);
        } else if (Date.now() - startedAt >= POLL_DIALOG_WAIT_MS) {
          reject(new Error("Poll details did not open"));
        } else {
          window.setTimeout(check, 100);
        }
      };
      check();
    });

  const processNextPollHydration = () => {
    if (pollHydrationActive || pollHydrationQueue.length === 0) return;
    const job = pollHydrationQueue.shift()!;
    pollHydrationActive = true;
    void (async () => {
      let dialog: HTMLElement | null = null;
      try {
        job.trigger.click();
        dialog = await waitForPollDialog();
        const poll = extractPollInfo(dialog, job.body);
        const message = (processedMessages as Message[]).find(
          (candidate) => messageKey(candidate) === job.key
        );
        if (!poll || !message) {
          throw new Error("Poll details were not readable");
        }
        message.poll = poll;
        message.kind = "poll";
        if (/created a poll:/i.test(message.body) && poll.question) {
          message.body = message.body.replace(
            /created a poll:[\s\S]*$/i,
            `created a poll: ${poll.question}`
          );
          message.bodyTruncated = poll.isQuestionTruncated;
        }
        message.warnings = message.warnings.filter((warning) => {
          if (poll.options.length > 0 && /did not mount its options/i.test(warning)) {
            return false;
          }
          if (!poll.isQuestionTruncated && /truncated (?:message|poll question)/i.test(warning)) {
            return false;
          }
          return true;
        });
      } catch (error) {
        const message = (processedMessages as Message[]).find(
          (candidate) => messageKey(candidate) === job.key
        );
        if (!message?.poll || message.poll.options.length === 0) {
          addPollWarning(
            job.key,
            `Poll detail expansion failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      } finally {
        const closeButton = dialog
          ? Array.from(
              dialog.querySelectorAll<HTMLElement>(
                'button, [role="button"], [aria-label]'
              )
            ).find((candidate) =>
              /^(?:close|dismiss)$/i.test(
                candidate.getAttribute("aria-label") ||
                  candidate.innerText ||
                  candidate.textContent ||
                  ""
              )
            )
          : null;
        closeButton?.click();
        pollHydrationActive = false;
        if (pollHydrationQueue.length > 0) {
          window.setTimeout(processNextPollHydration, 100);
        } else if (reactionHydrationQueue.length > 0) {
          window.setTimeout(processNextReactionHydration, 100);
        } else if (finishRequested) {
          window.setTimeout(finishScrape, 100);
        }
      }
    })();
  };

  const queuePollHydration = (row: Element, message: Message) => {
    if (
      !message.poll ||
      (!message.bodyTruncated &&
        !message.poll.isQuestionTruncated &&
        message.poll.options.length > 0)
    ) {
      return;
    }
    const trigger = Array.from(
      row.querySelectorAll<HTMLElement>('button, a, [role="button"]')
    ).find((candidate) =>
      /view poll/i.test(
        candidate.getAttribute("aria-label") ||
          candidate.innerText ||
          candidate.textContent ||
          ""
      )
    );
    const key = messageKey(message);
    if (!trigger || queuedPollKeys.has(key)) return;
    queuedPollKeys.add(key);
    pollHydrationQueue.push({ key, body: message.body, trigger });
  };

  const waitForReactionDialog = () =>
    new Promise<HTMLElement>((resolve, reject) => {
      const startedAt = Date.now();
      const check = () => {
        const dialog = Array.from(
          document.querySelectorAll<HTMLElement>('[role="dialog"]')
        ).find(
          (candidate) =>
            candidate.getClientRects().length > 0 &&
            extractReactionDetails(candidate).length > 0
        );
        if (dialog) {
          resolve(dialog);
        } else if (Date.now() - startedAt >= POLL_DIALOG_WAIT_MS) {
          reject(new Error("Reaction details did not open"));
        } else {
          window.setTimeout(check, 100);
        }
      };
      check();
    });

  const processNextReactionHydration = () => {
    if (
      pollHydrationActive ||
      pollHydrationQueue.length > 0 ||
      reactionHydrationActive ||
      reactionHydrationQueue.length === 0
    ) {
      return;
    }
    const job = reactionHydrationQueue.shift()!;
    reactionHydrationActive = true;
    void (async () => {
      let dialog: HTMLElement | null = null;
      try {
        job.trigger.click();
        dialog = await waitForReactionDialog();
        const reactions = extractReactionDetails(dialog);
        const message = (processedMessages as Message[]).find(
          (candidate) => messageKey(candidate) === job.key
        );
        if (reactions.length === 0 || !message) {
          throw new Error("Reaction details were not readable");
        }
        message.reactions = reactions;
        message.warnings = message.warnings.filter(
          (warning) => !/reaction detail expansion failed/i.test(warning)
        );
      } catch (error) {
        addReactionWarning(
          job.key,
          `Reaction detail expansion failed for ${job.reactionLabel}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        const activeDialog =
          dialog ??
          Array.from(
            document.querySelectorAll<HTMLElement>('[role="dialog"]')
          ).find(
            (candidate) =>
              candidate.getClientRects().length > 0 &&
              /message reactions/i.test(
                candidate.getAttribute("aria-label") ||
                  candidate.innerText ||
                  candidate.textContent ||
                  ""
              )
          ) ??
          null;
        const closeButton = activeDialog
          ? Array.from(
              activeDialog.querySelectorAll<HTMLElement>(
                'button, [role="button"], [aria-label]'
              )
            ).find((candidate) =>
              /^(?:close|dismiss)$/i.test(
                candidate.getAttribute("aria-label") ||
                  candidate.innerText ||
                  candidate.textContent ||
                  ""
              )
            )
          : null;
        closeButton?.click();
        reactionHydrationActive = false;
        if (reactionHydrationQueue.length > 0) {
          window.setTimeout(processNextReactionHydration, 100);
        } else if (finishRequested) {
          window.setTimeout(finishScrape, 100);
        }
      }
    })();
  };

  const queueReactionHydration = (row: Element, message: Message) => {
    for (const reaction of message.reactions) {
      if (reaction.reactors.length > 0) continue;
      const trigger = Array.from(
        row.querySelectorAll<HTMLElement>('[aria-label]')
      ).find(
        (candidate) =>
          candidate.getAttribute("aria-label")?.trim() === reaction.label
      );
      const key = messageKey(message);
      const reactionKey = `${key}:${reaction.label}`;
      if (!trigger || queuedReactionKeys.has(reactionKey)) continue;
      queuedReactionKeys.add(reactionKey);
      reactionHydrationQueue.push({
        key,
        reactionLabel: reaction.label,
        trigger,
      });
    }
  };

  /**
   * Merge overlapping virtualized DOM windows without collapsing legitimate
   * duplicate messages. Scrolling by less than one viewport keeps an overlap
   * between consecutive batches, which gives us an ordering anchor.
   */
  const mergeMountedMessages = (mountedMessages: Message[]) => {
    if (mountedMessages.length === 0) return { added: 0, anchored: false };
    if (processedMessages.length === 0) {
      processedMessages = mountedMessages;
      return { added: mountedMessages.length, anchored: true };
    }

    const collected = processedMessages as Message[];
    const collectedKeys = collected.map(messageFingerprint);
    const mountedKeys = mountedMessages.map(messageFingerprint);

    // Messenger currently exposes stable mid.* ids. They are a stronger
    // ordering anchor than text because rich media may finish loading between
    // two scans and change a row's parsed details. Since this scraper only
    // moves toward older history, newly seen ids can be safely prepended.
    const collectedByKey = new Map(
      collected.map((message, index) => [messageKey(message), index])
    );
    const sharedMessages = mountedMessages.filter((message) =>
      collectedByKey.has(messageKey(message))
    );
    if (sharedMessages.length > 0) {
      for (const message of sharedMessages) {
        const index = collectedByKey.get(messageKey(message))!;
        collected[index] = mergeMessageDetails(collected[index], message);
      }
      const newMessages = mountedMessages.filter(
        (message) => !collectedByKey.has(messageKey(message))
      );
      if (newMessages.length > 0) {
        processedMessages = [...newMessages, ...collected];
      }
      return { added: newMessages.length, anchored: true };
    }

    const mountedInCollected = findSequence(collectedKeys, mountedKeys);
    if (mountedInCollected >= 0) {
      mergeAlignedMessages(collected, mountedInCollected, mountedMessages);
      return { added: 0, anchored: true };
    }
    const collectedInMounted = findSequence(mountedKeys, collectedKeys);
    if (collectedInMounted >= 0) {
      const added = mountedMessages.length - collected.length;
      mergeAlignedMessages(mountedMessages, collectedInMounted, collected);
      processedMessages = mountedMessages;
      return { added: Math.max(0, added), anchored: true };
    }

    const maximumOverlap = Math.min(collectedKeys.length, mountedKeys.length);
    for (let overlap = maximumOverlap; overlap > 0; overlap--) {
      const mountedSuffix = mountedKeys.slice(mountedKeys.length - overlap);
      const collectedPrefix = collectedKeys.slice(0, overlap);
      if (mountedSuffix.every((key, index) => key === collectedPrefix[index])) {
        for (let index = 0; index < overlap; index++) {
          collected[index] = mergeMessageDetails(
            collected[index],
            mountedMessages[mountedMessages.length - overlap + index]
          );
        }
        const olderMessages = mountedMessages.slice(
          0,
          mountedMessages.length - overlap
        );
        processedMessages = [...olderMessages, ...collected];
        return { added: olderMessages.length, anchored: true };
      }

      const collectedSuffix = collectedKeys.slice(collectedKeys.length - overlap);
      const mountedPrefix = mountedKeys.slice(0, overlap);
      if (collectedSuffix.every((key, index) => key === mountedPrefix[index])) {
        for (let index = 0; index < overlap; index++) {
          collected[collected.length - overlap + index] = mergeMessageDetails(
            collected[collected.length - overlap + index],
            mountedMessages[index]
          );
        }
        const newerMessages = mountedMessages.slice(overlap);
        processedMessages = [...collected, ...newerMessages];
        return { added: newerMessages.length, anchored: true };
      }
    }

    // No overlap means Messenger has not settled after the last scroll. Wait
    // for another mounted snapshot instead of guessing and creating gaps or
    // duplicates in the export.
    return { added: 0, anchored: false };
  };

  const scanMountedMessages = (
    context: ChatDOMContext,
    hydrateDetails = true
  ) => {
    const parsedRows = getCurrentMessageRows(
      context.scrollContainer,
      context.chatName
    )
      .map((row) => ({ row, parsed: getMessageContent(row) }))
      .filter(
        ({ parsed: [message, status] }) =>
          message !== null && status === MessageParseStatus.SUCCESS
      );
    const mountedMessages = parsedRows.map(
      ({ parsed: [message] }) => message as Message
    );
    mountedMessages.forEach((message, index) => {
      if (message.time !== null) return;
      const previous = mountedMessages
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.time !== null);
      const next = mountedMessages
        .slice(index + 1)
        .find((candidate) => candidate.time !== null);
      if (previous?.time && previous.time === next?.time) {
        message.time = previous.time;
        message.rawTime = previous.rawTime;
        message.warnings = message.warnings
          .filter(
            (warning) =>
              !/did not expose a message-level timestamp/i.test(warning)
          )
          .concat(
            "Timestamp inferred from surrounding messages in the same minute."
          );
      }
    });
    const result = mergeMountedMessages(mountedMessages);
    if (hydrateDetails) {
      parsedRows.forEach(({ row, parsed: [message] }) => {
        queuePollHydration(row, message as Message);
        queueReactionHydration(row, message as Message);
      });
      processNextPollHydration();
      processNextReactionHydration();
    }
    return result;
  };

  const finishScrape = () => {
    if (
      pollHydrationActive ||
      pollHydrationQueue.length > 0 ||
      reactionHydrationActive ||
      reactionHydrationQueue.length > 0
    ) {
      finishRequested = true;
      processNextPollHydration();
      processNextReactionHydration();
      return;
    }
    const currentContext = getChatDOMContext();
    if (currentContext && currentContext.chatName === chatName) {
      scanMountedMessages(currentContext, false);
    }
    if (scrapeProcess !== null) clearInterval(scrapeProcess);
    const messages = (processedMessages as Message[]).slice();
    const richestPolls = new Map<
      string,
      NonNullable<Message["poll"]>
    >();
    messages.forEach((message) => {
      if (!message.poll) return;
      const key = message.poll.question.trim().toLocaleLowerCase();
      const richest = richestPolls.get(key);
      if (!richest || message.poll.options.length > richest.options.length) {
        richestPolls.set(key, message.poll);
      }
    });
    messages.forEach((message) => {
      if (!message.poll) return;
      const key = message.poll.question.trim().toLocaleLowerCase();
      const richest = richestPolls.get(key);
      if (!richest || richest.options.length <= message.poll.options.length) return;
      message.poll = {
        ...message.poll,
        options: richest.options.map((option) => ({ ...option })),
      };
      message.warnings = message.warnings.filter(
        (warning) =>
          !/did not mount its options|poll detail expansion failed/i.test(warning)
      );
    });
    const chatNameString = chatName ?? "";
    scrapeProcess = null;
    historyBoundaryReachedAt = null;
    waitingAtHistoryStart = false;
    finishRequested = false;
    pollHydrationActive = false;
    reactionHydrationActive = false;
    pollHydrationQueue.length = 0;
    reactionHydrationQueue.length = 0;
    queuedPollKeys.clear();
    queuedReactionKeys.clear();
    processedMessages = [];
    chatName = null;
    handleStopScrapeUI(...exporterFactory(chatNameString, messages));
  };

  const startScrape = (shouldAutoStop = false) => {
    if (scrapeProcess !== null) return;

    const initialContext = getChatDOMContext();
    if (!initialContext) {
      handleStopScrapeUI(
        () => {},
        () => {}
      );
      return;
    }
    chatName = initialContext.chatName;
    processedMessages = [];
    autoStopAtHistoryStart = shouldAutoStop;
    historyBoundaryReachedAt = null;
    waitingAtHistoryStart = false;
    finishRequested = false;
    pollHydrationActive = false;
    reactionHydrationActive = false;
    pollHydrationQueue.length = 0;
    reactionHydrationQueue.length = 0;
    queuedPollKeys.clear();
    queuedReactionKeys.clear();
    phase = "latest";
    phaseStartedAt = Date.now();
    lastScrollAt = 0;
    handleStartScrapeUI(chatName);

    // Start from the newest mounted history so opening the scraper while the
    // user is mid-conversation cannot silently omit later messages.
    initialContext.scrollContainer.scrollTop =
      initialContext.scrollContainer.scrollHeight;

    const iterate = () => {
      const context = getChatDOMContext();
      if (!context || context.chatName !== chatName) return;
      if (pollHydrationActive || reactionHydrationActive) return;

      const now = Date.now();

      if (phase === "latest") {
        context.scrollContainer.scrollTop = context.scrollContainer.scrollHeight;
        const latestElapsed = now - phaseStartedAt;
        const hasAccessibleMessage = Array.from(
          context.messageContainer.querySelectorAll<HTMLElement>(
            '[aria-label^="At "]'
          )
        ).some((element) =>
          /^At .*?, .*?: [\s\S]*$/.test(
            element.getAttribute("aria-label") ?? ""
          )
        );
        // Immediately after a page reload Messenger may mount the conversation
        // avatar before it mounts any virtualized message rows. Do not lock in
        // that transient snapshot as the newest history window. The timeout
        // still permits genuinely empty or media-only conversations.
        const readyForInitialScan =
          latestElapsed >= LATEST_READY_SETTLE_MS &&
          (hasAccessibleMessage || latestElapsed >= LATEST_READY_TIMEOUT_MS);
        if (readyForInitialScan) {
          // Discard any snapshot captured before the jump settled. Otherwise a
          // scrape started mid-conversation can remain anchored to that older
          // window and never collect the actual newest messages.
          processedMessages = [];
          scanMountedMessages(context);
          phase = "history";
          historyBoundaryReachedAt = null;
          lastScrollAt = 0;
        }
        return;
      }

      const { added, anchored } = scanMountedMessages(context);

      if (added > 0) {
        historyBoundaryReachedAt = null;
        waitingAtHistoryStart = false;
      }
      if (waitingAtHistoryStart) return;
      if (now - lastScrollAt < SCROLL_SETTLE_MS) return;
      if (!anchored) return;

      const { scrollContainer } = context;
      if (scrollContainer.scrollTop > 1) {
        const distance = Math.max(
          250,
          scrollContainer.clientHeight * HISTORY_SCROLL_RATIO
        );
        scrollContainer.scrollTop = Math.max(
          0,
          scrollContainer.scrollTop - distance
        );
        historyBoundaryReachedAt = null;
        lastScrollAt = now;
        return;
      }

      // Holding the real scroll viewport at zero is what asks Messenger's
      // virtualized list to prepend another batch. Never delete its DOM nodes;
      // doing so corrupts React's list and was the source of missing history.
      scrollContainer.scrollTop = 0;
      lastScrollAt = now;
      if (historyBoundaryReachedAt === null || added > 0) {
        historyBoundaryReachedAt = now;
        return;
      }
      if (now - historyBoundaryReachedAt >= END_OF_HISTORY_WAIT_MS) {
        if (reachHistoryStart()) finishScrape();
      }
    };

    iterate();
    scrapeProcess = window.setInterval(iterate, POLLING_TIME);
  };

  const stopScrape = () => {
    if (scrapeProcess !== null) finishScrape();
  };

  return { startScrape, stopScrape };
}

function exporterFactory(
  chatName: string,
  messages: (Message | null)[]
): [Exporter, Exporter] {
  const nonNullMessages = messages.filter(
    (message) => message !== null
  ) as Message[];
  const downloader: Exporter = (format) => {
    if (format === "archive") {
      return downloadCompleteArchive(chatName, nonNullMessages);
    } else if (format === "json") {
      downloadJSONFile(chatName, nonNullMessages);
    } else if (format === "text") {
      downloadTextAsFile(
        chatName,
        getRawStringFromMessageJSON(chatName, nonNullMessages)
      );
    }
  };
  const windowOpener: Exporter = (format) => {
    if (format === "archive") {
      throw new Error("Complete ZIP exports must be downloaded.");
    } else if (format === "json") {
      writeJSONToNewWindow(nonNullMessages);
    } else if (format === "text") {
      openHTMLInNewWindow(
        getHTMLStringFromMessageJSON(chatName, nonNullMessages)
      );
    }
  };
  return [downloader, windowOpener];
}

export default initializeScraper;
