import JSZip from "jszip";
import { getHTMLStringFromMessageJSON, getRawStringFromMessageJSON } from "./format";
import { Attachment, Message } from "./types";
import { sanitizeFilename } from "./utils";

type FetchMediaResponse = {
  ok: boolean;
  dataBase64?: string;
  mimeType?: string | null;
  error?: string;
};

type FetchedMedia =
  | { kind: "blob"; value: Blob; mimeType: string | null }
  | { kind: "base64"; value: string; mimeType: string | null };

type ArchiveFailure = {
  messageIndex: number;
  attachmentIndex: number;
  role: "media" | "preview";
  url: string;
  error: string;
};

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "application/pdf": ".pdf",
};

function cloneMessages(messages: Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages)) as Message[];
}

async function fetchDirect(url: string): Promise<FetchedMedia> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    kind: "blob",
    value: await response.blob(),
    mimeType: response.headers.get("content-type"),
  };
}

async function fetchViaBackground(url: string): Promise<FetchedMedia> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("Extension background fetch is unavailable");
  }
  const response = (await chrome.runtime.sendMessage({
    message: "chat-scraper-fetch-media",
    url,
  })) as FetchMediaResponse;
  if (!response?.ok || !response.dataBase64) {
    throw new Error(response?.error || "Background media fetch failed");
  }
  return {
    kind: "base64",
    value: response.dataBase64,
    mimeType: response.mimeType ?? null,
  };
}

async function fetchMedia(url: string): Promise<FetchedMedia> {
  try {
    return await fetchDirect(url);
  } catch (directError) {
    try {
      return await fetchViaBackground(url);
    } catch (backgroundError) {
      const directMessage =
        directError instanceof Error ? directError.message : String(directError);
      const backgroundMessage =
        backgroundError instanceof Error
          ? backgroundError.message
          : String(backgroundError);
      throw new Error(
        `Direct fetch failed (${directMessage}); background fetch failed (${backgroundMessage})`
      );
    }
  }
}

function extensionFor(url: string, mimeType: string | null): string {
  const normalizedMime = mimeType?.split(";", 1)[0].toLowerCase() ?? "";
  if (MIME_EXTENSIONS[normalizedMime]) return MIME_EXTENSIONS[normalizedMime];
  try {
    const match = new URL(url).pathname.match(/\.[a-z0-9]{1,8}$/i);
    return match?.[0] ?? "";
  } catch {
    return "";
  }
}

function archiveFilename(
  attachment: Attachment,
  messageIndex: number,
  attachmentIndex: number,
  role: "media" | "preview",
  mimeType: string | null,
  url: string
): string {
  const requestedName =
    role === "media" ? attachment.filename : `${attachment.filename ?? attachment.kind}-preview`;
  const sanitized = sanitizeFilename(requestedName ?? attachment.kind) || attachment.kind;
  const hasExtension = /\.[a-z0-9]{1,8}$/i.test(sanitized);
  const extension = hasExtension ? "" : extensionFor(url, mimeType);
  return `media/${String(messageIndex + 1).padStart(6, "0")}-${String(
    attachmentIndex + 1
  ).padStart(2, "0")}-${role}-${sanitized}${extension}`;
}

function addFetchedMedia(zip: JSZip, path: string, media: FetchedMedia) {
  if (media.kind === "blob") {
    zip.file(path, media.value);
  } else {
    zip.file(path, media.value, { base64: true });
  }
}

async function runWithConcurrency(
  jobs: Array<() => Promise<void>>,
  concurrency: number
) {
  let nextJob = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      await job();
    }
  });
  await Promise.all(workers);
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Archive encoding failed"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Archive encoding returned no data"));
    reader.readAsDataURL(blob);
  });
}

async function downloadBlob(filename: string, blob: Blob): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    message: "chat-scraper-download",
    filename,
    dataUrl: await blobToDataURL(blob),
  })) as { ok?: boolean; error?: string } | undefined;
  if (!response?.ok) {
    throw new Error(response?.error || "Browser rejected the archive download");
  }
}

export async function downloadCompleteArchive(
  chatName: string,
  messages: Message[]
): Promise<void> {
  const archivedMessages = cloneMessages(messages);
  const zip = new JSZip();
  const failures: ArchiveFailure[] = [];
  const jobs: Array<() => Promise<void>> = [];
  let requestedMedia = 0;
  let archivedMedia = 0;

  archivedMessages.forEach((message, messageIndex) => {
    message.attachments.forEach((attachment, attachmentIndex) => {
      const resources: Array<{
        role: "media" | "preview";
        url: string | null;
      }> = [
        { role: "media", url: attachment.url },
        { role: "preview", url: attachment.previewUrl },
      ];
      for (const resource of resources) {
        if (!resource.url) continue;
        requestedMedia++;
        jobs.push(async () => {
          try {
            const fetched = await fetchMedia(resource.url!);
            const path = archiveFilename(
              attachment,
              messageIndex,
              attachmentIndex,
              resource.role,
              fetched.mimeType,
              resource.url!
            );
            addFetchedMedia(zip, path, fetched);
            archivedMedia++;
            if (resource.role === "media") attachment.archivePath = path;
            else attachment.archivePreviewPath = path;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (resource.role === "media") attachment.downloadError = message;
            else attachment.previewDownloadError = message;
            failures.push({
              messageIndex,
              attachmentIndex,
              role: resource.role,
              url: resource.url!,
              error: message,
            });
          }
        });
      }
    });
  });

  await runWithConcurrency(jobs, 3);

  const report = {
    schemaVersion: 2,
    chatName,
    exportedAt: new Date().toISOString(),
    messageCount: archivedMessages.length,
    attachmentCount: archivedMessages.reduce(
      (count, message) => count + message.attachments.length,
      0
    ),
    requestedMedia,
    archivedMedia,
    failedMedia: failures.length,
    failures,
    dataQuality: {
      messagesWithoutExactTimestamp: archivedMessages.filter(
        (message) => message.time === null
      ).length,
      truncatedBodies: archivedMessages.filter(
        (message) => message.bodyTruncated
      ).length,
      pollsMissingOptions: archivedMessages.filter(
        (message) => message.poll && message.poll.options.length === 0
      ).length,
      reactionGroupsWithoutIdentities: archivedMessages.reduce(
        (count, message) =>
          count +
          message.reactions.filter((reaction) => reaction.reactors.length === 0)
            .length,
        0
      ),
      warningCount: archivedMessages.reduce(
        (count, message) => count + message.warnings.length,
        0
      ),
    },
  };

  zip.file("messages.json", JSON.stringify(archivedMessages, null, 2));
  zip.file("messages.txt", getRawStringFromMessageJSON(chatName, archivedMessages));
  zip.file("messages.html", getHTMLStringFromMessageJSON(chatName, archivedMessages));
  zip.file("export-report.json", JSON.stringify(report, null, 2));

  const archive = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await downloadBlob(`${sanitizeFilename(chatName)}-complete.zip`, archive);
}
