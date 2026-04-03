/* global fflate, PDFLib */

importScripts("../lib/fflate.min.js", "../lib/pdf-lib.min.js");

const STATE = { running: false, cancelled: false };

/** Больше pixelRatio = больше пикселей в PNG/PDF и чётче при зуме в просмотрщике (файлы тяжелее). */
const EXPORT_PIXEL_RATIO = 2;
/** Если Konva недоступен — временно увеличить масштаб вкладки, чтобы канвас отрисовался крупнее. */
const TAB_ZOOM_BOOST = 1.75;

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
        break;
      }

      const pageUrl = `${meta.baseUrl}/${page}`;
      await chrome.tabs.update(tab.id, { url: pageUrl });
      await waitForTabLoad(tab.id, pageUrl);

      const expectedPath = pathnameOnly(pageUrl);
      if (!(await isArchivePageOk(tab.id, expectedPath))) {
        break;
      }

      const shot = await captureArchivePageImage(tab.id);
      if (shot.cancelled) {
        break;
      }

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

    if (items.length === 0) {
      await setProgress({
        phase: STATE.cancelled ? "Остановлено" : "Ошибка",
        current: 0,
        total: meta.totalPages,
        done: true,
        partial: false,
        noData: true
      });
      return;
    }

    const partial = items.length < meta.totalPages;
    const rawTitle = meta.title || meta.documentId || "archive-document";
    const fileBaseName = `${sanitizeFileName(rawTitle)}${partial ? "_partial" : ""}`;

    await setProgress({ phase: "Сборка файла", current: items.length, total: items.length, done: false });
    if (format === "zip") {
      await saveZip(items, fileBaseName);
    } else {
      await savePdf(items, fileBaseName);
    }

    await setProgress({
      phase: partial ? "Готово (частично)" : "Готово",
      current: items.length,
      total: meta.totalPages,
      done: true,
      partial
    });
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
      const blockText = pageBlock?.textContent || "";

      let total = 0;
      const slashMatch = blockText.match(/(\d+)\s*\/\s*(\d+)/);

      let maxFromLinks = 0;
      if (pageBlock) {
        const anchors = pageBlock.querySelectorAll("a[href]");
        for (const a of anchors) {
          const href = a.getAttribute("href") || "";
          const m = href.match(/\/archive\/catalog\/[^/]+\/(\d+)/);
          if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n)) {
              maxFromLinks = Math.max(maxFromLinks, n);
            }
          }
        }
        for (const node of pageBlock.querySelectorAll("button, [role='button'], span, div")) {
          const onlyDigits = (node.textContent || "").trim();
          if (/^\d+$/.test(onlyDigits)) {
            const n = Number(onlyDigits);
            if (Number.isFinite(n)) {
              maxFromLinks = Math.max(maxFromLinks, n);
            }
          }
        }
      }

      if (slashMatch) {
        total = Number(slashMatch[2]);
      } else {
        const numbers = blockText.match(/\d+/g) || [];
        const lastNum = Number(numbers[numbers.length - 1] || 0);
        if (maxFromLinks > 0 && lastNum > maxFromLinks) {
          total = maxFromLinks;
        } else {
          total = lastNum;
        }
      }

      if (!Number.isFinite(total) || total < 1) {
        total = maxFromLinks;
      }

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

async function captureArchivePageImage(tabId) {
  const stable = await waitForStableCanvas(tabId);
  if (stable.cancelled) {
    return { cancelled: true };
  }

  let dataUrl = await exportKonvaOrCanvasSnapshot(tabId, EXPORT_PIXEL_RATIO);
  if (!dataUrl) {
    const boosted = await exportWithBrowserZoomBoost(tabId);
    if (boosted?.cancelled) {
      return { cancelled: true };
    }
    dataUrl = boosted;
  }

  if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("Не удалось получить изображение страницы (.konvajs-content).");
  }

  return { dataUrl };
}

async function exportWithBrowserZoomBoost(tabId) {
  let prevZoom = 1;
  try {
    prevZoom = await chrome.tabs.getZoom(tabId);
  } catch {
    return null;
  }

  try {
    await chrome.tabs.setZoom(tabId, TAB_ZOOM_BOOST);
    await sleep(800);
    const stableAgain = await waitForStableCanvas(tabId);
    if (stableAgain.cancelled) {
      await chrome.tabs.setZoom(tabId, prevZoom);
      return { cancelled: true };
    }
  } catch {
    try {
      await chrome.tabs.setZoom(tabId, prevZoom);
    } catch {
      /* ignore */
    }
    return null;
  }

  let dataUrl = await exportKonvaOrCanvasSnapshot(tabId, 1);
  try {
    await chrome.tabs.setZoom(tabId, prevZoom);
  } catch {
    /* ignore */
  }

  return dataUrl;
}

async function exportKonvaOrCanvasSnapshot(tabId, pixelRatio) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [pixelRatio],
    func: (pr) => {
      const root = document.querySelector(".konvajs-content");
      if (!root) {
        return null;
      }

      const KonvaGlobal = typeof Konva !== "undefined" ? Konva : window.Konva;
      const stages =
        KonvaGlobal &&
        (KonvaGlobal.stages ||
          (Array.isArray(KonvaGlobal.Stages) ? KonvaGlobal.Stages : null));

      if (stages && stages.length) {
        for (const stage of stages) {
          try {
            const container = stage.container && stage.container();
            if (container && root.contains(container)) {
              const url =
                typeof stage.toDataURL === "function"
                  ? stage.toDataURL({ mimeType: "image/png", pixelRatio: pr })
                  : null;
              if (url && url.startsWith("data:image/png")) {
                return url;
              }
            }
          } catch {
            /* next stage */
          }
        }
      }

      try {
        const canvas = root.querySelector("canvas");
        if (!canvas || canvas.width < 64 || canvas.height < 64) {
          return null;
        }
        return canvas.toDataURL("image/png");
      } catch {
        return null;
      }
    }
  });

  const url = results?.[0]?.result;
  return typeof url === "string" ? url : null;
}

async function waitForStableCanvas(tabId) {
  const maxMs = 120000;
  const stableNeeded = 3;
  const intervalMs = 450;
  const start = Date.now();
  let lastSig = null;
  let stableCount = 0;

  while (Date.now() - start < maxMs) {
    if (STATE.cancelled) {
      return { cancelled: true };
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (document.readyState !== "complete") {
          return { ready: false };
        }
        const root = document.querySelector(".konvajs-content");
        if (!root) {
          return { ready: false };
        }
        const canvas = root.querySelector("canvas");
        if (!canvas || canvas.width < 64 || canvas.height < 64) {
          return { ready: false };
        }
        const sig = `${canvas.width}x${canvas.height}`;
        return { ready: true, sig };
      }
    });

    const snapshot = results?.[0]?.result;
    if (snapshot?.ready && snapshot.sig) {
      if (snapshot.sig === lastSig) {
        stableCount += 1;
      } else {
        lastSig = snapshot.sig;
        stableCount = 1;
      }
      if (stableCount >= stableNeeded) {
        return {};
      }
    } else {
      lastSig = null;
      stableCount = 0;
    }

    await sleep(intervalMs);
  }

  throw new Error("Таймаут ожидания загрузки изображения (.konvajs-content).");
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

function waitForTabLoad(tabId, expectedPageUrl) {
  let expectedPath = null;
  try {
    expectedPath = expectedPageUrl ? new URL(expectedPageUrl).pathname : null;
  } catch {
    expectedPath = null;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const maxMs = 90000;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (ok) {
        resolve();
      } else {
        reject(new Error("Таймаут загрузки страницы."));
      }
    };

    const timeout = setTimeout(() => finish(false), maxMs);

    function listener(updatedTabId, info, tab) {
      if (updatedTabId !== tabId || info.status !== "complete") {
        return;
      }
      if (expectedPath && tab?.url) {
        try {
          if (new URL(tab.url).pathname !== expectedPath) {
            return;
          }
        } catch {
          return;
        }
      }
      finish(true);
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t?.status !== "complete" || !t.url) {
        return;
      }
      if (expectedPath) {
        try {
          if (new URL(t.url).pathname !== expectedPath) {
            return;
          }
        } catch {
          return;
        }
      }
      finish(true);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathnameOnly(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

async function isArchivePageOk(tabId, expectedPath) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [expectedPath],
    func: (expected) => {
      let pathMatch = !expected;
      try {
        pathMatch = location.pathname === expected;
      } catch {
        pathMatch = false;
      }
      const path = (location.pathname || "").toLowerCase();
      if (path.includes("/error") || path.includes("/errors/")) {
        return false;
      }

      const title = (document.title || "").toLowerCase();
      const h1 = (document.querySelector("h1")?.textContent || "").toLowerCase();
      const sample = ((document.body?.innerText || "") + title + h1).slice(0, 1200).toLowerCase();
      const looks404 =
        /\b404\b/.test(title) ||
        sample.includes("страница не найдена") ||
        sample.includes("страница не существует") ||
        sample.includes("ничего не нашлось") ||
        (sample.includes("не найден") && sample.includes("страниц"));

      if (looks404 || !pathMatch) {
        return false;
      }
      return true;
    }
  });

  return results?.[0]?.result === true;
}
