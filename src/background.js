/* global fflate, PDFLib */

importScripts("../lib/fflate.min.js", "../lib/pdf-lib.min.js");

const STATE = { running: false, cancelled: false };

/**
 * Запрашиваемый pixelRatio для Konva toDataURL.
 * Фактическое значение на странице ограничивается MAX_CANVAS_EXPORT_SIDE (лимит canvas в Chrome).
 */
const EXPORT_PIXEL_RATIO = 64;
const MAX_CANVAS_EXPORT_SIDE = 16384;

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
    } else if (format === "epub") {
      await saveEpub(items, fileBaseName, rawTitle);
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

async function saveEpub(items, fileBaseName, title) {
  const encoder = new TextEncoder();
  const escXml = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  const safeTitle = escXml(title || fileBaseName || "Document");
  const uid = epubRandomUuid();

  const zipFiles = {
    mimetype: encoder.encode("application/epub+zip"),
    "META-INF/container.xml": encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  };

  const manifestLines = [
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
  ];
  const spineLines = [];
  const navPoints = [];

  for (let i = 0; i < items.length; i += 1) {
    const n = i + 1;
    const id = String(n).padStart(4, "0");
    const imgRel = `images/${id}.png`;
    const chapRel = `chap${id}.xhtml`;
    zipFiles[`OEBPS/${imgRel}`] = new Uint8Array(items[i].buffer);
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ru">
<head><meta charset="UTF-8"/><title>${escXml(`Стр. ${n}`)}</title></head>
<body style="margin:0;padding:0;text-align:center;background:#000;">
<img src="${imgRel}" alt="" style="width:100%;height:auto;max-width:100%;"/>
</body>
</html>`;
    zipFiles[`OEBPS/${chapRel}`] = encoder.encode(xhtml);
    manifestLines.push(`    <item id="img${id}" href="${imgRel}" media-type="image/png"/>`);
    manifestLines.push(`    <item id="chap${id}" href="${chapRel}" media-type="application/xhtml+xml"/>`);
    spineLines.push(`    <itemref idref="chap${id}"/>`);
    navPoints.push(
      `    <navPoint id="np${id}" playOrder="${n}"><navLabel><text>Стр. ${n}</text></navLabel><content src="${chapRel}"/></navPoint>`
    );
  }

  const packageOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${safeTitle}</dc:title>
    <dc:identifier id="bookid">urn:uuid:${uid}</dc:identifier>
    <dc:language>ru</dc:language>
  </metadata>
  <manifest>
${manifestLines.join("\n")}
  </manifest>
  <spine toc="ncx">
${spineLines.join("\n")}
  </spine>
</package>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${uid}"/>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle><text>${safeTitle}</text></docTitle>
  <navMap>
${navPoints.join("\n")}
  </navMap>
</ncx>`;

  zipFiles["OEBPS/package.opf"] = encoder.encode(packageOpf);
  zipFiles["OEBPS/toc.ncx"] = encoder.encode(tocNcx);

  const zipped = fflate.zipSync(zipFiles, { level: 0 });
  const url = bytesToDataUrl(zipped, "application/epub+zip");

  await chrome.downloads.download({
    url,
    filename: `${fileBaseName || "archive-document"}.epub`,
    saveAs: true
  });
}

function epubRandomUuid() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

  const dataUrl = await exportKonvaOrCanvasSnapshot(
    tabId,
    EXPORT_PIXEL_RATIO,
    MAX_CANVAS_EXPORT_SIDE
  );

  if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
    throw new Error("Не удалось получить изображение страницы (.konvajs-content).");
  }

  return { dataUrl };
}

async function exportKonvaOrCanvasSnapshot(tabId, pixelRatio, maxCanvasSide) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [pixelRatio, maxCanvasSide],
    func: (pr, maxSide) => {
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
              let sw = Math.max(
                1,
                typeof stage.width === "function" ? stage.width() : stage.attrs?.width || 1
              );
              let sh = Math.max(
                1,
                typeof stage.height === "function" ? stage.height() : stage.attrs?.height || 1
              );
              let largestImg = null;
              let largestArea = 0;
              try {
                if (typeof stage.find === "function") {
                  const imgNodes = stage.find("Image");
                  if (imgNodes && imgNodes.length) {
                    for (const node of imgNodes) {
                      const rect =
                        node.getClientRect && node.getClientRect({ skipShadow: true });
                      if (rect && rect.width > 0 && rect.height > 0) {
                        sw = Math.max(sw, rect.width);
                        sh = Math.max(sh, rect.height);
                      }
                      const domImg = node.image && node.image();
                      if (domImg && domImg.naturalWidth > 0 && domImg.naturalHeight > 0) {
                        const area = domImg.naturalWidth * domImg.naturalHeight;
                        if (area > largestArea) {
                          largestArea = area;
                          largestImg = domImg;
                        }
                      }
                    }
                  }
                }
              } catch {
                /* ignore */
              }
              // Попытка 1: прямое рисование исходника на offscreen canvas — нативное разрешение
              if (largestImg && largestImg.naturalWidth > 0 && largestImg.naturalHeight > 0) {
                let nw = largestImg.naturalWidth;
                let nh = largestImg.naturalHeight;
                if (nw > maxSide || nh > maxSide) {
                  const scale = Math.min(maxSide / nw, maxSide / nh);
                  nw = Math.floor(nw * scale);
                  nh = Math.floor(nh * scale);
                }
                try {
                  const offscreen = document.createElement("canvas");
                  offscreen.width = nw;
                  offscreen.height = nh;
                  const ctx = offscreen.getContext("2d");
                  ctx.drawImage(largestImg, 0, 0, nw, nh);
                  const url = offscreen.toDataURL("image/png");
                  if (url && url.startsWith("data:image/png")) {
                    return url;
                  }
                } catch {
                  /* CORS tainted canvas — переходим к рендеру через Konva */
                }
              }

              // Попытка 2: Konva toDataURL с pixelRatio, привязанным к разрешению исходника
              const cap = Math.min(
                pr,
                Math.floor(maxSide / sw),
                Math.floor(maxSide / sh)
              );
              const prSafe = Math.max(1, cap);
              let url = null;
              if (typeof stage.toDataURL === "function") {
                if (largestImg && largestImg.naturalWidth > 0 && sw > 0 && sh > 0) {
                  const idealRatio = Math.min(
                    largestImg.naturalWidth / sw,
                    largestImg.naturalHeight / sh
                  );
                  const nativeCap = Math.min(
                    idealRatio,
                    Math.floor(maxSide / sw),
                    Math.floor(maxSide / sh)
                  );
                  const prNative = Math.max(1, nativeCap);
                  try {
                    url = stage.toDataURL({ mimeType: "image/png", pixelRatio: prNative });
                  } catch {
                    url = null;
                  }
                }
                // Попытка 3: fallback с prSafe (лимит холста Chrome)
                if (!url || !url.startsWith("data:image/png")) {
                  url = stage.toDataURL({ mimeType: "image/png", pixelRatio: prSafe });
                }
              }
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
