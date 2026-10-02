const INIT_MESSAGE = { message: "chat-scraper-init" };
const MESSENGER_HOSTS = new Set(["messenger.com", "www.messenger.com"]);
const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "web.facebook.com",
]);
const MAX_PROXIED_MEDIA_BYTES = 24 * 1024 * 1024;

function isAllowedMediaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    return [
      "facebook.com",
      "messenger.com",
      "fbcdn.net",
      "fbsbx.com",
    ].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

function bytesToBase64(bytes) {
  // Keep chunks divisible by three so concatenating their base64 encodings is
  // equivalent to encoding the complete byte array.
  const chunkSize = 24 * 1024;
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    let binary = "";
    for (let index = 0; index < chunk.length; index++) {
      binary += String.fromCharCode(chunk[index]);
    }
    result += btoa(binary);
  }
  return result;
}

async function fetchMedia(rawUrl) {
  if (!isAllowedMediaUrl(rawUrl)) {
    return { ok: false, error: "Media URL host is not allowlisted" };
  }

  try {
    const response = await fetch(rawUrl, { credentials: "include" });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_PROXIED_MEDIA_BYTES) {
      return {
        ok: false,
        error: `Media exceeds the ${MAX_PROXIED_MEDIA_BYTES}-byte background transfer limit`,
      };
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_PROXIED_MEDIA_BYTES) {
      return {
        ok: false,
        error: `Media exceeds the ${MAX_PROXIED_MEDIA_BYTES}-byte background transfer limit`,
      };
    }
    return {
      ok: true,
      dataBase64: bytesToBase64(new Uint8Array(buffer)),
      mimeType: response.headers.get("content-type"),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function downloadGeneratedFile(filename, dataUrl) {
  if (
    typeof filename !== "string" ||
    !filename ||
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith("data:application/zip;")
  ) {
    return { ok: false, error: "Invalid generated download request" };
  }
  const determineFilename = (item, suggest) => {
    if (item.url !== dataUrl) return;
    suggest({ filename, conflictAction: "uniquify" });
  };
  chrome.downloads.onDeterminingFilename.addListener(determineFilename);
  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    return await waitForDownload(downloadId);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    chrome.downloads.onDeterminingFilename.removeListener(determineFilename);
  }
}

function waitForDownload(downloadId, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    const inspectDownload = async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (!item) return;
        if (item.state === "complete") {
          finish({ ok: true, downloadId, filename: item.filename });
        } else if (item.state === "interrupted") {
          finish({
            ok: false,
            downloadId,
            error: `Archive download interrupted${
              item.error ? `: ${item.error}` : ""
            }`,
          });
        }
      } catch (error) {
        finish({
          ok: false,
          downloadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (
        delta.state.current === "complete" ||
        delta.state.current === "interrupted"
      ) {
        void inspectDownload();
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => {
      finish({
        ok: false,
        downloadId,
        error: "Archive download did not finish within two minutes",
      });
    }, timeoutMs);
    void inspectDownload();
  });
}

function isSupportedChatUrl(rawUrl) {
  if (!rawUrl) return false;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    if (MESSENGER_HOSTS.has(url.hostname)) return true;

    return (
      FACEBOOK_HOSTS.has(url.hostname) &&
      (url.pathname === "/messages" || url.pathname.startsWith("/messages/"))
    );
  } catch {
    return false;
  }
}

function isMissingReceiverError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes("receiving end does not exist") ||
    normalizedMessage.includes("could not establish connection")
  );
}

async function initializeScraper(tab) {
  if (tab.id == null || !isSupportedChatUrl(tab.url)) return;

  try {
    await chrome.tabs.sendMessage(tab.id, INIT_MESSAGE);
    return;
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      console.error("Failed to initialize Chat Scraper:", error);
      return;
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["main.js"],
    });
    await chrome.tabs.sendMessage(tab.id, INIT_MESSAGE);
  } catch (error) {
    console.error("Failed to inject Chat Scraper:", error);
  }
}

chrome.action.onClicked.addListener((tab) => {
  void initializeScraper(tab);
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.message === "chat-scraper-fetch-media") {
    void fetchMedia(request.url).then(sendResponse);
    return true;
  }
  if (request?.message === "chat-scraper-download") {
    void downloadGeneratedFile(request.filename, request.dataUrl).then(
      sendResponse
    );
    return true;
  }
  return false;
});
