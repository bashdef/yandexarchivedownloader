/* global PDFLib */

importScripts("../lib/pdf-lib.min.js");

const STATE = { running: false, cancelled: false };

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_EXPORT") {
    runExport()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "STOP_EXPORT") {
    STATE.cancelled = true;
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function runExport() {
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
    if (!/^https:\/\/yandex\.ru\/archive\/catalog\/[^/]+\/\d+/.test(tab.url)) {
      throw new Error(
        "Откройте страницу документа Яндекс.Архив (URL должен содержать номер страницы)."
      );
    }

    // Единственный вызов executeScript — читаем мета из __NEXT_DATA__.
    // После этого вкладку можно закрыть или перейти на другую страницу.
    const meta = await readMeta(tab.id);

    await setProgress({
      phase: "Загрузка страниц",
      current: 0,
      total: meta.totalPages,
      done: false,
    });

    const images = [];
    let consecutiveFails = 0;

    for (let page = 1; page <= meta.totalPages; page += 1) {
      if (STATE.cancelled) {
        break;
      }

      // Retry-логика: до RETRY_ATTEMPTS попыток на страницу
      const img = await fetchWithRetry(
        () => fetchPageImage(meta.buildId, meta.parentNodeId, page),
        RETRY_ATTEMPTS,
        RETRY_DELAY_MS
      );

      if (!img) {
        consecutiveFails += 1;
        // После 3 подряд ошибок прекращаем — скорее всего страниц больше нет
        if (consecutiveFails >= 3) {
          break;
        }
        // Одиночный сбой — пропускаем страницу, продолжаем
        continue;
      }

      consecutiveFails = 0;
      images.push(img);

      await setProgress({
        phase: "Загрузка страниц",
        current: page,
        total: meta.totalPages,
        done: false,
      });
    }

    if (images.length === 0) {
      await setProgress({
        phase: STATE.cancelled ? "Остановлено" : "Ошибка",
        current: 0,
        total: meta.totalPages,
        done: true,
        noData: true,
      });
      return;
    }

    const partial = images.length < meta.totalPages;
    const fileBaseName =
      sanitizeFileName(meta.title || meta.parentNodeId) + (partial ? "_partial" : "");

    await setProgress({
      phase: "Сборка PDF",
      current: images.length,
      total: images.length,
      done: false,
    });
    await savePdf(images, fileBaseName);

    await setProgress({
      phase: partial ? "Готово (частично)" : "Готово",
      current: images.length,
      total: meta.totalPages,
      done: true,
      partial,
    });
  } finally {
    STATE.running = false;
    STATE.cancelled = false;
  }
}

/**
 * Читает buildId, parentNodeId, totalPages из __NEXT_DATA__ на странице.
 * Единственное место где нужна вкладка — только в начале.
 */
async function readMeta(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        const el = document.getElementById("__NEXT_DATA__");
        if (!el) return null;
        const nd = JSON.parse(el.textContent);
        const pp = nd?.props?.pageProps;
        return {
          buildId: nd?.buildId,
          parentNodeId: pp?.parentNodeId,
          totalPages: pp?.totalPages,
          title: (document.querySelector("h1")?.textContent || "").trim(),
        };
      } catch {
        return null;
      }
    },
  });

  const meta = results?.[0]?.result;
  if (!meta?.buildId || !meta?.parentNodeId || !meta?.totalPages) {
    throw new Error(
      "Не удалось прочитать метаданные документа. Убедитесь, что открыта страница Яндекс.Архив."
    );
  }
  return meta;
}

/**
 * Загружает одну страницу:
 *  1. Получает node_id через Next.js data API (запрос из background, с cookies).
 *  2. Скачивает оригинальное изображение через /archive/api/image?type=original.
 *
 * Всё выполняется из background service worker — вкладка не нужна.
 * MV3 service worker автоматически включает cookies для доменов из host_permissions.
 */
async function fetchPageImage(buildId, parentNodeId, page) {
  // Шаг 1: получаем node_id страницы
  const metaUrl =
    `https://yandex.ru/archive/_next/data/${buildId}/catalog/${parentNodeId}/${page}.json` +
    `?parentNodeId=${parentNodeId}&docNumber=${page}`;

  const metaResp = await fetch(metaUrl, { credentials: "include" });
  if (!metaResp.ok) return null;

  const metaJson = await metaResp.json();
  const node = metaJson?.pageProps?.currentNode;
  if (!node?.id) return null;

  // Шаг 2: скачиваем оригинальное изображение
  const imgUrl = `https://yandex.ru/archive/api/image?id=${node.id}&type=original`;
  const imgResp = await fetch(imgUrl, { credentials: "include" });
  if (!imgResp.ok) return null;

  const contentType = imgResp.headers.get("content-type") || "";
  const ext = contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "png";
  const bytes = new Uint8Array(await imgResp.arrayBuffer());

  return {
    bytes,
    ext,
    width: node.originalImageSize?.width || 0,
    height: node.originalImageSize?.height || 0,
  };
}

/**
 * Повторяет fn до maxAttempts раз с задержкой delayMs между попытками.
 * Возвращает результат первой успешной попытки или null.
 */
async function fetchWithRetry(fn, maxAttempts, delayMs) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (STATE.cancelled) return null;
    try {
      const result = await fn();
      if (result !== null && result !== undefined) return result;
    } catch {
      /* пробуем ещё */
    }
    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }
  return null;
}

/**
 * Собирает PDF из массива изображений.
 * Страница PDF = размер оригинала (пиксели как точки) → полное качество при зуме.
 */
async function savePdf(images, fileBaseName) {
  const { PDFDocument } = PDFLib;
  const pdfDoc = await PDFDocument.create();

  for (const img of images) {
    const embedded =
      img.ext === "jpg"
        ? await pdfDoc.embedJpg(img.bytes)
        : await pdfDoc.embedPng(img.bytes);

    const { width, height } = embedded.scale(1);
    const page = pdfDoc.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  }

  const pdfBytes = await pdfDoc.save();
  const url = bytesToDataUrl(pdfBytes, "application/pdf");

  await chrome.downloads.download({
    url,
    filename: `${fileBaseName || "archive-document"}.pdf`,
    saveAs: true,
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function setProgress(progress) {
  await chrome.storage.session.set({ exportProgress: progress });
}

function bytesToDataUrl(bytes, mimeType) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function sanitizeFileName(value) {
  return (
    String(value || "")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "archive-document"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
