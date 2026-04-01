const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const formatSelect = document.getElementById("format");
const progressEl = document.getElementById("progress");

startButton.addEventListener("click", async () => {
  setMessage("Запуск...");
  const format = formatSelect.value;

  const response = await chrome.runtime.sendMessage({
    type: "START_EXPORT",
    format
  });

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

  const { phase, current, total, done } = progress;
  if (done) {
    setMessage("Готово. Файл сохранен через диалог загрузки.");
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
