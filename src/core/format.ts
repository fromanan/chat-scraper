import { Message } from "./types";

export function getHTMLStringFromMessageJSON(
  chatName: string,
  messages: Message[]
): string {
  const messageStrings = messages.map(getElementStringFromMessage);
  return `<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data: blob: 'self'; media-src https: data: blob: 'self'">
    <title>${escapeHTML(chatName)}</title>
    <style>${CSS}</style>
  </head>
  <body>
  <header>
    <h1>${escapeHTML(chatName)}</h1>
  </header>
    <main class="message-container">${messageStrings.join("")}</main>
  </body>
  </html>`;
}

function getElementStringFromMessage(message: Message): string {
  const timestamp = message.time
    ? `<time datetime="${escapeHTML(message.time)}">${escapeHTML(
        message.time
      )}</time> `
    : "";
  const name = `<strong>${escapeHTML(message.sender)}</strong>`;
  const attachments = message.attachments
    .map((attachment) => {
      const source = escapeHTML(attachment.archivePath ?? attachment.url);
      const alt = escapeHTML(attachment.altText ?? attachment.kind);
      if (["image", "gif", "sticker"].includes(attachment.kind)) {
        return `<figure><img loading="lazy" src="${source}" alt="${alt}"><figcaption>${escapeHTML(
          attachment.kind
        )}</figcaption></figure>`;
      }
      if (attachment.kind === "video") {
        const poster = attachment.archivePreviewPath ?? attachment.previewUrl;
        return `<video controls src="${source}"${
          poster ? ` poster="${escapeHTML(poster)}"` : ""
        }>${alt}</video>`;
      }
      if (attachment.kind === "audio") {
        return `<audio controls src="${source}">${alt}</audio>`;
      }
      return `<a href="${source}">${escapeHTML(
        attachment.filename ?? attachment.altText ?? "Attachment"
      )}</a>`;
    })
    .join("");
  const reactions = message.reactions.length
    ? `<div class="reactions">${message.reactions
        .map(
          (reaction) =>
            `${escapeHTML(reaction.emoji)} ${reaction.count}`
        )
        .join(" · ")}</div>`
    : "";
  const poll = message.poll
    ? `<section class="poll"><strong>${escapeHTML(
        message.poll.question
      )}</strong><ul>${message.poll.options
        .map(
          (option) =>
            `<li>${escapeHTML(option.text)}${
              option.votes === null ? "" : ` — ${option.votes} vote(s)`
            }</li>`
        )
        .join("")}</ul></section>`
    : "";
  const warnings = message.warnings.length
    ? `<ul class="warnings">${message.warnings
        .map((warning) => `<li>${escapeHTML(warning)}</li>`)
        .join("")}</ul>`
    : "";
  return `<article><p>${timestamp}${name}${formatReplyInfoHTML(
    message.replyInfo
  )}: ${escapeHTML(message.body)}${message.edited ? " <em>(edited)</em>" : ""}</p>${
    attachments
  }${poll}${reactions}${warnings}</article>`;
}

function formatReplyInfoHTML(replyInfo: Message["replyInfo"]): string {
  if (!replyInfo) return "";
  return ` (replying to ${escapeHTML(
    replyInfo.to
  )}, who wrote: &quot;${escapeHTML(replyInfo.body)}&quot;)`;
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character];
  });
}

function formatReplyInfo(replyInfo: Message["replyInfo"]): string {
  if (!replyInfo) return "";
  return ` (replying to ${replyInfo.to}, who wrote: "${replyInfo.body}")`;
}

const CSS = `
body {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 0;
    padding: 0;
}
body * {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
}
.message-container {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 700px;
}
.message-container * {
  font-size: 16px;
}
.message-container p {
  text-align: justify;
  hyphens: auto;
  overflow-wrap: anywhere;
}
.message-container article {
  width: 100%;
  border-bottom: 1px solid #ddd;
  padding: 8px 0;
}
.message-container img,
.message-container video {
  max-width: min(100%, 700px);
  max-height: 70vh;
}
.message-container figure {
  margin: 8px 0;
}
.message-container .reactions {
  color: #555;
}
.message-container .warnings {
  color: #9b3d00;
}`;

export function getRawStringFromMessageJSON(
  chatName: string,
  messages: Message[]
): string {
  const lines: string[] = [];
  lines.push("Chat: " + chatName);
  lines.push("------------");
  for (const message of messages) {
    const timestamp = message.time ? `[${message.time}] ` : "";
    const line = `${timestamp}${message.sender}${formatReplyInfo(
      message.replyInfo
    )}: ${message.body}`;
    lines.push(line);
    if (message.poll) {
      lines.push(`  Poll: ${message.poll.question}`);
      for (const option of message.poll.options) {
        lines.push(
          `    - ${option.text}${
            option.votes === null ? "" : ` (${option.votes} vote(s))`
          }`
        );
      }
    }
    for (const attachment of message.attachments) {
      lines.push(
        `  Attachment [${attachment.kind}]: ${
          attachment.archivePath ?? attachment.url
        }`
      );
    }
    if (message.reactions.length > 0) {
      lines.push(
        `  Reactions: ${message.reactions
          .map((reaction) => `${reaction.emoji} ${reaction.count}`)
          .join(", ")}`
      );
    }
    for (const warning of message.warnings) {
      lines.push(`  Warning: ${warning}`);
    }
  }
  return lines.join("\r\n");
}
