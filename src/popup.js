const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const progressEl = document.getElementById("progress");

startButton.addEventListener("click", async () => {
  setMessage("Запуск...");

  const response = await chrome.runtime.sendMessage({ type: "START_EXPORT" });
  if (!response?.ok) {
    setMessage(`Ошибка: ${response?.error || "неизвестная ошибка"}`);
  }
});

stopButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_EXPORT" });
  setMessage("Остановка...");
});

chrome.storage.session.get("exportProgress").then(({ exportProgress }) => {
  if (exportProgress) {
    renderProgress(exportProgress);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.exportProgress) {
    return;
  }
  renderProgress(changes.exportProgress.newValue);
});

function renderProgress(progress) {
  if (!progress) {
    return;
  }

  const { phase, current, total, done, partial, noData } = progress;

  if (done) {
    if (noData) {
      setMessage("Нет страниц для сохранения.");
    } else if (partial) {
      setMessage("Частичная выгрузка сохранена (_partial).");
    } else {
      setMessage("Готово. Файл сохранён через диалог загрузки.");
    }
    return;
  }

  if (total > 0) {
    setMessage(`${phase}: ${current}/${total}`);
  } else {
    setMessage(phase || "Выполняется...");
  }
}

function setMessage(text) {
  progressEl.textContent = text;
}
