export type ExportFormat = "archive" | "json" | "text";
export type Exporter = (format: ExportFormat) => void | Promise<void>;

export enum MessageParseStatus {
  SUCCESS,
  NOT_A_MESSAGE,
  UNKNOWN_FORMAT,
  EMPTY_MESSAGE,
  TERMINATE,
}

export type ReplyInfo = {
  /** Name of person replied to */
  to: string;
  /** Text of message replied to (or preview thereof) */
  body: string;
};

export type Reaction = {
  emoji: string;
  count: number;
  label: string;
  reactors: string[];
};

export type AttachmentKind =
  | "image"
  | "gif"
  | "video"
  | "audio"
  | "file"
  | "sticker"
  | "unknown";

export type Attachment = {
  kind: AttachmentKind;
  url: string;
  previewUrl: string | null;
  filename: string | null;
  altText: string | null;
  mimeType: string | null;
  archivePath: string | null;
  archivePreviewPath: string | null;
  downloadError: string | null;
  previewDownloadError: string | null;
};

export type LinkInfo = {
  url: string;
  text: string | null;
};

export type PollOption = {
  text: string;
  votes: number | null;
};

export type PollInfo = {
  question: string;
  options: PollOption[];
  isQuestionTruncated: boolean;
};

export type MessageKind = "message" | "system" | "media" | "poll";

export type Message = {
  /** Stable when Facebook exposes an id; otherwise null. */
  id: string | null;
  kind: MessageKind;
  /** UTC ISO-8601 timestamp, for example 2026-10-01T19:03:00.000Z. */
  time: string | null;
  /** Messenger's original human-readable timestamp, retained for auditability. */
  rawTime: string | null;
  /** Info if this message was a reply, null if not */
  replyInfo: ReplyInfo | null;
  sender: string;
  body: string;
  /** True when Facebook only exposed a shortened preview. */
  bodyTruncated: boolean;
  edited: boolean;
  reactions: Reaction[];
  attachments: Attachment[];
  links: LinkInfo[];
  poll: PollInfo | null;
  warnings: string[];
  /** Kept for backward compatibility with older exports. */
  isImage: boolean;
};
