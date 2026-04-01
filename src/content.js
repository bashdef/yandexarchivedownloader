chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "COLLECT_PAGES") {
    return false;
  }

  collectPages()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function collectPages() {
  const totalPages = detectTotalPages();
  const uniqueUrls = new Set();
  const pages = [];

  const maxCycles = totalPages || 1000;
  for (let i = 1; i <= maxCycles; i += 1) {
    await waitForRender();
    const url = extractCurrentPageImageUrl();
    if (!url) {
      throw new Error("Не удалось определить URL изображения текущей страницы.");
    }

    if (!uniqueUrls.has(url)) {
      uniqueUrls.add(url);
      pages.push({ index: pages.length + 1, url });
    }

    if (totalPages && pages.length >= totalPages) {
      break;
    }

    const moved = clickNextPage();
    if (!moved) {
      break;
    }

    await waitForChange(url);
  }

  return {
    pages,
    documentId: extractDocumentId()
  };
}

function detectTotalPages() {
  const text = document.body?.innerText || "";
  const match = text.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) {
    return null;
  }

  const value = Number(match[2]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractCurrentPageImageUrl() {
  const imgs = [...document.querySelectorAll("img[src]")];
  const bestImg = imgs
    .map((img) => ({
      src: img.currentSrc || img.src,
      score: (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0)
    }))
    .filter((item) => item.src && /^https?:\/\//.test(item.src))
    .sort((a, b) => b.score - a.score)[0];

  if (bestImg?.src) {
    return bestImg.src;
  }

  const entries = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /https?:\/\//.test(name) && /(image|jpg|jpeg|png|webp)/i.test(name));

  return entries[entries.length - 1] || null;
}

function clickNextPage() {
  const selectors = [
    "button[aria-label*='Следующая']",
    "button[aria-label*='Next']",
    "button[title*='Следующая']",
    "button[title*='Next']",
    "[data-testid='next-page']",
    ".Pager-Item_type_next button"
  ];

  for (const selector of selectors) {
    const button = document.querySelector(selector);
    if (!button) {
      continue;
    }

    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return false;
    }

    button.click();
    return true;
  }

  return false;
}

function extractDocumentId() {
  const match = location.pathname.match(/catalog\/([^/]+)/);
  return match?.[1] || "archive-document";
}

async function waitForRender() {
  await sleep(600);
}

async function waitForChange(previousUrl) {
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    const current = extractCurrentPageImageUrl();
    if (current && current !== previousUrl) {
      return;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
