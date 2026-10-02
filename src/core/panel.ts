import { addRadioInput } from "./utils";
import { Exporter, ExportFormat } from "./types";

const CSP = "chat-scraper-panel";

export interface ScraperPanel {
  setIdle: () => void;
  setScraping: () => void;
  setAtHistoryStart: () => void;
  setStartScrapeHandler: (handler: (autoStop: boolean) => void) => void;
  setStopScrapeHandler: (handler: () => void) => void;
  setDownloadHandler: (handler: Exporter) => void;
  setOpenInNewWindowHandler: (handler: Exporter) => void;
  showExportOptions: () => void;
  setCurrentChatName: (chatName: string) => void;
  display: () => void;
  remove: () => void;
}

/**
 * Creates a ScraperPanel if one does not already exist.
 *
 * @return The created ScraperPanel or null if it already exists.
 */
export function makeScraperPanel(): ScraperPanel | null {
  const maybePanel = document.querySelector(`#${CSP}`);
  if (maybePanel) {
    return null;
  }
  return new ScraperPanelUI();
}

class ScraperPanelUI implements ScraperPanel {
  private onStartScrape = (_autoStop: boolean) => {};
  private onStopScrape = () => {};
  private onDownload: Exporter = (_format) => {};
  private onOpenInNewWindow: Exporter = (_format) => {};
  private readonly panel: HTMLDivElement;
  private readonly scrapeButton: HTMLButtonElement;
  private readonly autoStopCheckbox: HTMLInputElement;
  private readonly downloadButton: HTMLButtonElement;
  private readonly openInNewWindowButton: HTMLButtonElement;
  private readonly exportOptionsHolder: HTMLDivElement;
  private readonly radioHolder: HTMLDivElement;
  private readonly exportErrorBanner: HTMLDivElement;
  private readonly closeButton: HTMLSpanElement;
  private state: "idle" | "scraping" = "idle";
  private currentChatName: string | null = null;
  private currentExportFormat: ExportFormat = "archive";

  public constructor() {
    this.panel = document.createElement("div");
    this.scrapeButton = document.createElement("button");
    this.scrapeButton.innerText = "Start Scrape";
    this.scrapeButton.classList.add("scrape-button");
    this.panel.innerHTML = `<h1>Chat Scraper</h1>`;
    this.closeButton = document.createElement("span");
    this.closeButton.classList.add("close-button");
    this.closeButton.innerText = "\u2715";
    this.closeButton.onclick = () => {
      this.remove();
    };
    this.panel.querySelector("h1")!.append(this.closeButton);
    this.panel.appendChild(this.scrapeButton);

    const autoStopHolder = document.createElement("div");
    autoStopHolder.classList.add("scrape-options-holder");
    const autoStopLabel = document.createElement("label");
    this.autoStopCheckbox = document.createElement("input");
    this.autoStopCheckbox.type = "checkbox";
    this.autoStopCheckbox.checked = false;
    autoStopLabel.append(
      this.autoStopCheckbox,
      " Auto-stop at oldest message"
    );
    autoStopHolder.appendChild(autoStopLabel);
    this.panel.appendChild(autoStopHolder);

    this.panel.id = CSP;
    this.scrapeButton.onclick = () => {
      if (this.state === "idle") {
        const autoStop = this.autoStopCheckbox.checked;
        this.setScraping();
        this.onStartScrape(autoStop);
      } else if (this.state === "scraping") {
        this.setIdle();
        this.showExportOptions();
        this.onStopScrape();
      }
    };

    const statusBanner = document.createElement("div");
    statusBanner.innerHTML =
      '<div class="loader"></div><div class="history-status">Oldest message reached &mdash; press Stop Scrape</div>';
    statusBanner.classList.add("status-banner");
    this.panel.appendChild(statusBanner);

    this.exportOptionsHolder = document.createElement("div");
    this.exportOptionsHolder.classList.add("options-holder");
    this.exportOptionsHolder.innerHTML =
      '<div class="last-scraped-banner"></div>';
    this.panel.appendChild(this.exportOptionsHolder);

    this.downloadButton = document.createElement("button");
    this.downloadButton.innerText = "Download";
    this.downloadButton.classList.add("regular-button");
    this.exportOptionsHolder.appendChild(this.downloadButton);

    this.openInNewWindowButton = document.createElement("button");
    this.openInNewWindowButton.innerText = "Open in new window";
    this.openInNewWindowButton.classList.add("regular-button");
    this.exportOptionsHolder.appendChild(this.openInNewWindowButton);

    this.exportErrorBanner = document.createElement("div");
    this.exportErrorBanner.classList.add("export-error");
    this.exportOptionsHolder.appendChild(this.exportErrorBanner);

    this.radioHolder = document.createElement("div");
    this.radioHolder.classList.add("radio-holder");
    this.exportOptionsHolder.appendChild(this.radioHolder);
    addRadioInput(
      this.radioHolder,
      "Complete ZIP",
      "export-format",
      "archive",
      true,
      () => this.selectExportFormat("archive")
    );
    addRadioInput(
      this.radioHolder,
      "As text",
      "export-format",
      "text",
      false,
      () => this.selectExportFormat("text")
    );
    addRadioInput(
      this.radioHolder,
      "As JSON",
      "export-format",
      "json",
      false,
      () => this.selectExportFormat("json")
    );

    this.selectExportFormat("archive");
    this.downloadButton.onclick = async () => {
      const originalLabel = this.downloadButton.innerText;
      this.exportErrorBanner.innerText = "";
      this.downloadButton.disabled = true;
      this.openInNewWindowButton.disabled = true;
      this.downloadButton.innerText =
        this.currentExportFormat === "archive"
          ? "Creating archive..."
          : "Preparing download...";
      try {
        await this.onDownload(this.currentExportFormat);
      } catch (error) {
        this.exportErrorBanner.innerText = `Export failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      } finally {
        this.downloadButton.innerText = originalLabel;
        this.downloadButton.disabled = false;
        this.openInNewWindowButton.disabled =
          this.currentExportFormat === "archive";
      }
    };
    this.openInNewWindowButton.onclick = async () => {
      this.exportErrorBanner.innerText = "";
      try {
        await this.onOpenInNewWindow(this.currentExportFormat);
      } catch (error) {
        this.exportErrorBanner.innerText = `Preview failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    };
  }

  private selectExportFormat(format: ExportFormat) {
    this.currentExportFormat = format;
    this.openInNewWindowButton.disabled = format === "archive";
    this.openInNewWindowButton.title =
      format === "archive"
        ? "Download the complete ZIP to view its files"
        : "";
  }

  public setIdle() {
    this.state = "idle";
    this.scrapeButton.innerText = "Start Scrape";
    this.panel.classList.remove("scraping");
    this.panel.classList.remove("at-history-start");
    this.autoStopCheckbox.disabled = false;
  }

  public setScraping() {
    this.state = "scraping";
    this.scrapeButton.innerText = "Stop Scrape";
    this.panel.classList.add("scraping");
    this.panel.classList.remove("at-history-start");
    this.exportOptionsHolder.classList.remove("visible");
    this.autoStopCheckbox.disabled = true;
  }

  public setAtHistoryStart() {
    this.panel.classList.add("at-history-start");
  }

  public display() {
    const style = document.createElement("style");
    style.classList.add("chat-scraper-style");
    style.innerText = panelCSS;

    // Keep the overlay at the same physical size as the reference UI when
    // Windows display scaling raises devicePixelRatio (for example, 150%).
    const displayScale = 1 / (window.devicePixelRatio || 1);
    this.panel.style.setProperty(
      "--chat-scraper-display-scale",
      displayScale.toString()
    );

    document.body.prepend(style);
    document.body.prepend(this.panel);
  }

  public remove() {
    this.onStopScrape();
    this.panel.remove();
    document.querySelector(".chat-scraper-style")?.remove();
  }

  public setStartScrapeHandler(handler: (autoStop: boolean) => void) {
    this.onStartScrape = handler;
  }

  public setStopScrapeHandler(handler: () => void) {
    this.onStopScrape = handler;
  }

  public setDownloadHandler(handler: Exporter) {
    this.onDownload = handler;
  }

  public setOpenInNewWindowHandler(handler: Exporter) {
    this.onOpenInNewWindow = handler;
  }

  public showExportOptions() {
    const lastScrapedBanner = this.exportOptionsHolder.querySelector(
      ".last-scraped-banner"
    )!;
    const label = document.createElement("strong");
    label.style.fontWeight = "bold";
    label.textContent = "Last scraped:";
    lastScrapedBanner.replaceChildren(
      label,
      ` ${this.currentChatName ?? ""}`
    );
    this.exportOptionsHolder.classList.add("visible");
  }

  public setCurrentChatName(chatName: string) {
    this.currentChatName = chatName;
  }
}

const borderWhite = "#848484";
const darkGray = "#292929";
const medGray = "#3c3c3c";
const lightGray = "#595959";
const offWhite = "#dfdfdf";
const primary = "#4d9648";
const secondary = "#b54545";
const panelCSS = `
#${CSP} {
    all: initial;
    position: fixed;
    z-index: 10000;
    top: 10px;
    right: 10px;
    box-sizing: content-box;
    border-radius: 4px;
    border: 1px solid ${borderWhite};
    background-color: ${darkGray};
    padding: 10px 20px 16px;
    color: ${offWhite};
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
    font-size: 18px;
    font-weight: normal;
    line-height: normal;
    width: 300px;
    transform: scale(var(--chat-scraper-display-scale, 1));
    transform-origin: top right;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.4);
}
#${CSP} * {
    box-sizing: border-box;
    color: ${offWhite};
    font-family: inherit;
}
#${CSP} h1 {
    all: unset;
    box-sizing: border-box;
    font-size: 1.5em;
    font-weight: bold;
    line-height: normal;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1.5rem;
}
#${CSP} .close-button {
    all: unset;
    box-sizing: border-box;
    color: ${borderWhite};
    font-family: inherit;
    font-size: 1.5em;
    font-weight: normal;
    line-height: 1;
}
#${CSP} .close-button:hover {
    transition: filter 0.15s ease-in-out;
    cursor: pointer;
    filter: brightness(1.1);
}
#${CSP} .status-banner {
    display: none;
}
#${CSP}.scraping .status-banner {
    display: flex;
    justify-content: center;
    align-items: center;
    margin-top: 10px;
}
#${CSP} .history-status {
    display: none;
    color: ${offWhite};
    font-size: 0.9em;
    line-height: normal;
    text-align: center;
}
#${CSP}.at-history-start .loader {
    display: none;
}
#${CSP}.at-history-start .history-status {
    display: block;
}
#${CSP} .scrape-button {
    all: unset;
    box-sizing: border-box;
    display: block;
    margin: 10px 0 0;
    background-color: ${primary};
    font-weight: bold;
    line-height: normal;
    text-align: center;
    border-radius: 2px;
    border: 1px solid ${borderWhite};
    padding: 10px 20px;
    color: white;
    width: 100%;
    font-size: 1em;
}
#${CSP} .scrape-button:hover {
    transition: filter 0.15s ease-in-out;
    cursor: pointer;
    filter: brightness(1.1);
}
#${CSP} .scrape-options-holder {
    margin-top: 8px;
}
#${CSP} .scrape-options-holder label {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 4px;
    color: ${offWhite};
    font-family: inherit;
    font-size: 0.9em;
    line-height: normal;
}
#${CSP} .scrape-options-holder input[type="checkbox"] {
    all: revert;
    box-sizing: border-box;
    width: 15px;
    height: 15px;
    margin: 0;
    accent-color: ${primary};
}
#${CSP}.scraping .scrape-options-holder {
    opacity: 0.65;
}
#${CSP} .options-holder {
    display: none;
}
#${CSP} .options-holder.visible {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 8px;
    width: 100%;
}
#${CSP} .last-scraped-banner {
    margin-top: 8px;
    line-height: normal;
}
#${CSP} .regular-button {
    all: unset;
    box-sizing: border-box;
    display: block;
    margin: 10px 0 0;
    background-color: ${lightGray};
    font-weight: bold;
    line-height: normal;
    text-align: center;
    border-radius: 2px;
    border: 1px solid ${borderWhite};
    padding: 10px 20px;
    color: white;
    width: 100%;
    font-size: 1em;
}
#${CSP} .regular-button:hover {
    transition: filter 0.15s ease-in-out;
    cursor: pointer;
    filter: brightness(1.1);
}
#${CSP} .regular-button:disabled {
    cursor: not-allowed;
    filter: none;
    opacity: 0.55;
}
#${CSP} .export-error {
    color: #ff9a9a;
    font-size: 0.8em;
    line-height: 1.25;
    margin-top: 8px;
    overflow-wrap: anywhere;
}
#${CSP}.scraping .scrape-button {
    background-color: ${secondary};
}
#${CSP} .radio-holder {
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
}
#${CSP} .radio-holder label {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 2px;
    color: ${offWhite};
    font-family: inherit;
    font-size: 1rem;
    line-height: normal;
}
#${CSP} .radio-holder input[type="radio"] {
    all: revert;
    box-sizing: border-box;
    width: 13px;
    height: 13px;
    margin: 0;
    accent-color: ${primary};
}
#${CSP} .loader {
    display: block;
    border: 4px solid ${lightGray};
    border-top: 4px solid ${medGray};
    border-radius: 50%;
    width: 20px;
    height: 20px;
    animation: ${CSP}-spin 2s linear infinite;
}
@keyframes ${CSP}-spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}
`;
