/* global fflate, PDFLib */

importScripts("../lib/fflate.min.js", "../lib/pdf-lib.min.js");

const STATE = {
  running: false,
  cancelled: false
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_EXPORT") {
    runExport(message.format)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_EXPORT") {
    STATE.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function runExport(format) {
  if (STATE.running) {
    throw new Error("Экспорт уже выполняется.");
  }

  STATE.running = true;
  STATE.cancelled = false;
  await setProgress({ phase: "Подготовка", current: 0, total: 0, done: false });

  try {
    const tab = await getActiveTab();
    if (!tab?.id) {
      throw new Error("Не удалось определить активную вкладку.");
    }

    const collectResponse = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_PAGES" });
    if (!collectResponse?.ok) {
      throw new Error(collectResponse?.error || "Не удалось собрать страницы.");
    }

    const pages = collectResponse.pages || [];
    if (!pages.length) {
      throw new Error("Страницы не найдены. Откройте документ Яндекс.Архив и попробуйте снова.");
    }

    await setProgress({ phase: "Загрузка страниц", current: 0, total: pages.length, done: false });
    const items = await downloadPages(pages);

    await setProgress({ phase: "Сборка файла", current: items.length, total: items.length, done: false });
    if (format === "zip") {
      await saveZip(items, collectResponse.documentId);
    } else {
      await savePdf(items, collectResponse.documentId);
    }

    await setProgress({
      phase: "Готово",
      current: items.length,
      total: items.length,
      done: true
    });
  } finally {
    STATE.running = false;
    STATE.cancelled = false;
  }
}

async function downloadPages(pages) {
  const files = [];

  for (let i = 0; i < pages.length; i += 1) {
    if (STATE.cancelled) {
      throw new Error("Экспорт остановлен пользователем.");
    }

    const page = pages[i];
    const response = await fetch(page.url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Ошибка загрузки страницы ${page.index}: ${response.status}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const ext = contentType.includes("png") ? "png" : "jpg";
    const buffer = await response.arrayBuffer();

    files.push({
      name: `${String(page.index).padStart(4, "0")}.${ext}`,
      ext,
      buffer
    });

    await setProgress({
      phase: "Загрузка страниц",
      current: i + 1,
      total: pages.length,
      done: false
    });
  }

  return files;
}

async function saveZip(items, documentId) {
  const zipInput = {};
  for (const item of items) {
    zipInput[item.name] = new Uint8Array(item.buffer);
  }

  const zipped = fflate.zipSync(zipInput, { level: 0 });
  const blob = new Blob([zipped], { type: "application/zip" });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename: `${documentId || "archive-document"}.zip`,
    saveAs: true
  });

  URL.revokeObjectURL(url);
}

async function savePdf(items, documentId) {
  const { PDFDocument } = PDFLib;
  const pdfDoc = await PDFDocument.create();

  for (const item of items) {
    const bytes = new Uint8Array(item.buffer);
    const image = item.ext === "png" ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    const { width, height } = image.scale(1);
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename: `${documentId || "archive-document"}.pdf`,
    saveAs: true
  });

  URL.revokeObjectURL(url);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function setProgress(progress) {
  await chrome.storage.session.set({ exportProgress: progress });
}
