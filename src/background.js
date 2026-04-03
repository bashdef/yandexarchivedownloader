/* global PDFLib */

importScripts("../lib/pdf-lib.min.js");

const STATE = { running: false, cancelled: false };

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
      throw new Error("Откройте страницу документа Яндекс.Архив (URL должен содержать номер страницы).");
    }

    const meta = await readMeta(tab.id);
    await setProgress({ phase: "Загрузка страниц", current: 0, total: meta.totalPages, done: false });

    const images = [];
    for (let page = 1; page <= meta.totalPages; page += 1) {
      if (STATE.cancelled) {
        break;
      }

      const img = await fetchPageImage(tab.id, meta.buildId, meta.parentNodeId, page);
      if (!img) {
        break;
      }

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
 * Читает метаданные из __NEXT_DATA__ на текущей странице документа.
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
 * Для страницы page:
 *  1. Получает node_id через Next.js data API.
 *  2. Скачивает оригинальное изображение (/api/image?type=original).
 *  3. Возвращает { dataUrl, ext, width, height } или null при ошибке.
 *
 * Всё выполняется в контексте вкладки (с cookies пользователя).
 */
async function fetchPageImage(tabId, buildId, parentNodeId, page) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [buildId, parentNodeId, page],
    func: async (buildId, parentNodeId, page) => {
      try {
        // Шаг 1: получаем node_id страницы через Next.js data endpoint
        const metaUrl =
          `/archive/_next/data/${buildId}/catalog/${parentNodeId}/${page}.json` +
          `?parentNodeId=${parentNodeId}&docNumber=${page}`;
        const metaResp = await fetch(metaUrl, { credentials: "include" });
        if (!metaResp.ok) return null;

        const metaJson = await metaResp.json();
        const node = metaJson?.pageProps?.currentNode;
        if (!node?.id) return null;

        // Шаг 2: скачиваем оригинальное изображение
        const imgUrl = `/archive/api/image?id=${node.id}&type=original`;
        const imgResp = await fetch(imgUrl, { credentials: "include" });
        if (!imgResp.ok) return null;

        const blob = await imgResp.blob();
        const ext =
          blob.type.includes("jpeg") || blob.type.includes("jpg") ? "jpg" : "png";

        // Шаг 3: конвертируем в base64 data URL
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        return {
          ext,
          dataUrl,
          width: node.originalImageSize?.width || 0,
          height: node.originalImageSize?.height || 0,
        };
      } catch {
        return null;
      }
    },
  });

  return results?.[0]?.result || null;
}

/**
 * Собирает PDF из массива изображений и скачивает.
 * Страница PDF = размер оригинального изображения (максимальное качество при зуме).
 */
async function savePdf(images, fileBaseName) {
  const { PDFDocument } = PDFLib;
  const pdfDoc = await PDFDocument.create();

  for (const img of images) {
    const bytes = dataUrlToBytes(img.dataUrl);
    const embedded =
      img.ext === "jpg"
        ? await pdfDoc.embedJpg(bytes)
        : await pdfDoc.embedPng(bytes);

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

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
