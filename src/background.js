/* global fflate, PDFLib */

importScripts("../lib/fflate.min.js", "../lib/pdf-lib.min.js");

const STATE = { running: false, cancelled: false };

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
    if (!tab?.id || !tab.url) {
      throw new Error("Не удалось определить активную вкладку.");
    }
    if (!/^https:\/\/yandex\.ru\/archive\/catalog\//.test(tab.url)) {
      throw new Error("Откройте страницу документа Яндекс.Архив.");
    }

    const meta = await readDocumentMeta(tab.id, tab.url);
    await setProgress({ phase: "Загрузка страниц", current: 0, total: meta.totalPages, done: false });

    const items = [];
    for (let page = 1; page <= meta.totalPages; page += 1) {
      if (STATE.cancelled) {
        throw new Error("Экспорт остановлен пользователем.");
      }

      const pageUrl = `${meta.baseUrl}/${page}`;
      await chrome.tabs.update(tab.id, { url: pageUrl });
      await waitForTabLoad(tab.id);

      const shot = await captureCanvas(tab.id);
      items.push({
        name: `${String(page).padStart(4, "0")}.png`,
        ext: "png",
        buffer: dataUrlToArrayBuffer(shot.dataUrl)
      });

      await setProgress({
        phase: "Загрузка страниц",
        current: page,
        total: meta.totalPages,
        done: false
      });
    }

    await setProgress({ phase: "Сборка файла", current: items.length, total: items.length, done: false });
    const fileBaseName = sanitizeFileName(meta.title || meta.documentId || "archive-document");
    if (format === "zip") {
      await saveZip(items, fileBaseName);
    } else {
      await savePdf(items, fileBaseName);
    }

    await setProgress({ phase: "Готово", current: items.length, total: items.length, done: true });
  } finally {
    STATE.running = false;
    STATE.cancelled = false;
  }
}

async function saveZip(items, fileBaseName) {
  const zipInput = {};
  for (const item of items) {
    zipInput[item.name] = new Uint8Array(item.buffer);
  }

  const zipped = fflate.zipSync(zipInput, { level: 0 });
  const url = bytesToDataUrl(zipped, "application/zip");

  await chrome.downloads.download({
    url,
    filename: `${fileBaseName || "archive-document"}.zip`,
    saveAs: true
  });

}

async function savePdf(items, fileBaseName) {
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
  const url = bytesToDataUrl(pdfBytes, "application/pdf");

  await chrome.downloads.download({
    url,
    filename: `${fileBaseName || "archive-document"}.pdf`,
    saveAs: true
  });

}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function setProgress(progress) {
  await chrome.storage.session.set({ exportProgress: progress });
}

async function readDocumentMeta(tabId, tabUrl) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const pageBlock = document.querySelector(".Pagination-Pages");
      const text = pageBlock?.textContent || "";
      const numbers = text.match(/\d+/g) || [];
      const total = Number(numbers[numbers.length - 1] || 0);

      const pathMatch = location.pathname.match(/\/archive\/catalog\/([^/]+)\/(\d+)/);
      const documentId = pathMatch?.[1] || "archive-document";
      const baseUrl = `${location.origin}/archive/catalog/${documentId}`;
      const title = (document.querySelector("h1")?.textContent || "").trim();
      return { totalPages: total, documentId, baseUrl, title };
    }
  });

  const meta = result?.[0]?.result;
  if (!meta?.totalPages || meta.totalPages < 1) {
    throw new Error("Не удалось определить количество страниц в .Pagination-Pages.");
  }
  if (!meta?.baseUrl) {
    const fallbackBase = tabUrl.replace(/\/\d+([?#].*)?$/, "");
    return { ...meta, baseUrl: fallbackBase };
  }
  return meta;
}

async function captureCanvas(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      for (let i = 0; i < 30; i += 1) {
        const canvas = document.querySelector(".konvajs-content canvas");
        if (canvas && canvas.width > 0 && canvas.height > 0) {
          const dataUrl = canvas.toDataURL("image/png");
          if (dataUrl && dataUrl.startsWith("data:image/png;base64,")) {
            return { dataUrl };
          }
        }
        await wait(250);
      }
      throw new Error("Не найден canvas в .konvajs-content.");
    }
  });

  const shot = result?.[0]?.result;
  if (!shot?.dataUrl) {
    throw new Error("Не удалось получить изображение страницы.");
  }
  return shot;
}

function dataUrlToArrayBuffer(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bytesToDataUrl(bytes, mimeType) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function sanitizeFileName(value) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "archive-document";
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Таймаут загрузки страницы."));
    }, 30000);

    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId || info.status !== "complete") {
        return;
      }
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}
