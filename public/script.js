// ── DOM refs ─────────────────────────────────────────────────────────────────

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileName = document.getElementById("file-name");
const scaleControl = document.getElementById("scale-control");
const scaleRange = document.getElementById("scale-range");
const scaleValue = document.getElementById("scale-value");
const optimiseBtn = document.getElementById("optimise-btn");
const loader = document.getElementById("loader");
const resultSection = document.getElementById("result-section");
const resultStats = document.getElementById("result-stats");
const downloadBtn = document.getElementById("download-btn");
const historyList = document.getElementById("history-list");

let selectedFile = null;

// ── File selection ───────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|svg|tiff?|heic|heif|avif)$/i;

function isImageFile(file) {
  if (file.type.startsWith("image/")) return true;
  // iOS Safari often returns an empty file.type for HEIC/HEIF photos —
  // fall back to checking the file extension.
  if (!file.type && IMAGE_EXTENSIONS.test(file.name)) return true;
  return false;
}

function handleFile(file) {
  if (!file || !isImageFile(file)) return;
  selectedFile = file;
  fileName.textContent = `${file.name} (${formatBytes(file.size)})`;
  optimiseBtn.disabled = false;
  resultSection.hidden = true;
}

dropZone.addEventListener("click", (e) => {
  // Avoid double-triggering on iOS: if the click landed on the <label> or
  // its children the browser already opens the file picker natively.
  if (e.target.closest('label[for="file-input"]')) return;
  // iOS Safari may not fire `change` if the user selects the same file again.
  // Clearing the value ensures a new selection always triggers.
  fileInput.value = "";
  fileInput.click();
});

function tryHandlePickedFile(attempt = 0) {
  const file = fileInput.files && fileInput.files[0];
  if (file) {
    handleFile(file);
    return;
  }

  // iOS Safari can momentarily report an empty FileList right after returning
  // from the picker. Retry a couple of times on the next frame.
  if (attempt < 3) {
    requestAnimationFrame(() => tryHandlePickedFile(attempt + 1));
  }
}

fileInput.addEventListener("change", () => {
  tryHandlePickedFile();
});

// Some mobile browsers are more reliable with `input` than `change`.
fileInput.addEventListener("input", () => {
  tryHandlePickedFile();
});

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  handleFile(e.dataTransfer.files[0]);
});

// ── Mode selection ───────────────────────────────────────────────────────────

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const mode = getMode();
    scaleControl.classList.toggle("visible", mode !== "webp");
  });
});

scaleRange.addEventListener("input", () => {
  scaleValue.textContent = scaleRange.value;
});

// ── Optimise ─────────────────────────────────────────────────────────────────

optimiseBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  const mode = getMode();
  const scale = scaleRange.value;

  const formData = new FormData();
  formData.append("image", selectedFile);
  formData.append("mode", mode);
  formData.append("scale", scale);

  loader.hidden = false;
  resultSection.hidden = true;

  try {
    const res = await fetch("/optimise", {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Optimisation failed");
    }

    const originalSize = parseInt(res.headers.get("X-Original-Size") || "0", 10);
    const optimisedSize = parseInt(res.headers.get("X-Optimised-Size") || "0", 10);
    const saved = originalSize - optimisedSize;
    const pct = originalSize > 0 ? Math.round((saved / originalSize) * 100) : 0;

    resultStats.innerHTML = `
      <div class="stat">
        <span class="stat__label">Original</span>
        <span class="stat__value">${formatBytes(originalSize)}</span>
      </div>
      <div class="stat">
        <span class="stat__label">Optimised</span>
        <span class="stat__value">${formatBytes(optimisedSize)}</span>
      </div>
      <div class="stat">
        <span class="stat__label">Saved</span>
        <span class="stat__value stat__value--success">${pct}%</span>
      </div>
    `;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="(.+)"/);
    const downloadName = match ? match[1] : "optimised";

    downloadBtn.href = url;
    downloadBtn.download = downloadName;
    resultSection.hidden = false;

    // Refresh history
    loadHistory();
  } catch (err) {
    alert(err.message);
  } finally {
    loader.hidden = true;
  }
});

// ── History ──────────────────────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch("/history");
    const data = await res.json();

    if (!data.length) {
      historyList.innerHTML = '<p class="history-empty">No optimisations yet.</p>';
      return;
    }

    historyList.innerHTML = data
      .map(
        (entry) => `
        <div class="history-item">
          <div>
            <div class="history-item__name">${escapeHtml(entry.originalName)}</div>
            <div class="history-item__meta">
              ${formatBytes(entry.originalSize)} → ${formatBytes(entry.optimisedSize)}
              &nbsp;
              <span class="history-item__badge">${entry.mode}${entry.scale ? " " + entry.scale + "%" : ""}</span>
              &nbsp;·&nbsp;
              ${timeAgo(entry.timestamp)}
            </div>
          </div>
          <a class="history-item__download" href="/output/${encodeURIComponent(entry.outputFilename)}" download>Download</a>
        </div>`
      )
      .join("");
  } catch {
    // silent fail
  }
}

// ── Utils ────────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadHistory();
