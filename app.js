(function () {
  const runtimeStatus = document.getElementById("runtime-status");
  const runtimePill = document.getElementById("runtime-pill");
  const footerRuntimeCopy = document.getElementById("footer-runtime-copy");
  const fileInput = document.getElementById("file-input");
  const fileList = document.getElementById("file-list");
  const logEl = document.getElementById("log");
  const runBtn = document.getElementById("run-btn");
  const downloadBtn = document.getElementById("download-btn");
  const clearBtn = document.getElementById("clear-btn");
  const heroSelectBtn = document.getElementById("hero-select-btn");
  const heroRunBtn = document.getElementById("hero-run-btn");
  const heroDownloadBtn = document.getElementById("hero-download-btn");
  const progressBar = document.getElementById("progress-bar");
  const progressText = document.getElementById("progress-text");
  const statFiles = document.getElementById("stat-files");
  const statSize = document.getElementById("stat-size");
  const statOutput = document.getElementById("stat-output");
  const statusCopy = document.getElementById("status-copy");
  const resultCopy = document.getElementById("result-copy");
  const dropzone = document.getElementById("dropzone");

  let selectedFiles = [];
  let outputZipBlob = null;
  let wasmModule = null;

  function formatSize(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function logLine(text) {
    logEl.textContent += (logEl.textContent ? "\n" : "") + text;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function resetLog(initial) {
    logEl.textContent = initial || "";
  }

  function setProgress(percent, label) {
    const clamped = Math.max(0, Math.min(100, percent));
    progressBar.style.width = `${clamped}%`;
    progressText.textContent = label || (clamped === 0 ? "等待开始" : `${Math.round(clamped)}%`);
  }

  function setRuntimeState(state, text) {
    runtimeStatus.textContent = text;
    footerRuntimeCopy.textContent = text;
    runtimePill.classList.remove("ready", "error");
    if (state === "ready") {
      runtimePill.classList.add("ready");
    } else if (state === "error") {
      runtimePill.classList.add("error");
    }
  }

  function syncActionButtons() {
    const canRun = Boolean(wasmModule) && selectedFiles.length > 0;
    runBtn.disabled = !canRun;
    heroRunBtn.disabled = !canRun;

    const canDownload = Boolean(outputZipBlob);
    downloadBtn.disabled = !canDownload;
    heroDownloadBtn.disabled = !canDownload;
  }

  function refreshSelectedFiles() {
    fileList.innerHTML = "";
    const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);

    statFiles.textContent = String(selectedFiles.length);
    statSize.textContent = formatSize(totalSize);

    if (selectedFiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `
        <div>
          <strong>还没有加入任何文件</strong>
          <p>把 \`.ysm\` 文件拖进来，或者使用上方按钮开始准备。</p>
        </div>
      `;
      fileList.appendChild(empty);
      statusCopy.textContent = wasmModule ? "待命" : "准备中";
      resultCopy.textContent = "尚未生成";
    } else {
      selectedFiles.forEach((file, index) => {
        const item = document.createElement("div");
        item.className = "file-item";
        item.innerHTML = `
          <div class="file-item-index">${String(index + 1).padStart(2, "0")}</div>
          <div class="file-item-main">
            <strong>${file.name}</strong>
            <span>已加入本次处理队列</span>
          </div>
          <small>${formatSize(file.size)}</small>
        `;
        fileList.appendChild(item);
      });
      statusCopy.textContent = "待处理";
      resultCopy.textContent = outputZipBlob ? "已准备下载" : "处理中前";
    }

    syncActionButtons();
  }

  function normalizeFiles(fileListLike) {
    const files = Array.from(fileListLike).filter((file) => file.name.toLowerCase().endsWith(".ysm"));
    files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return files;
  }

  function wipeDir(FS, dir) {
    try {
      const entries = FS.readdir(dir).filter((name) => name !== "." && name !== "..");
      for (const entry of entries) {
        const fullPath = `${dir}/${entry}`;
        const stat = FS.stat(fullPath);
        if (FS.isDir(stat.mode)) {
          wipeDir(FS, fullPath);
          FS.rmdir(fullPath);
        } else {
          FS.unlink(fullPath);
        }
      }
    } catch (_) {
      return;
    }
  }

  function ensureDir(FS, dir) {
    const parts = dir.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      try {
        FS.mkdir(current);
      } catch (_) {
      }
    }
  }

  async function writeInputs(FS) {
    wipeDir(FS, "/input");
    wipeDir(FS, "/output");
    ensureDir(FS, "/input");
    ensureDir(FS, "/output");

    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index];
      const bytes = new Uint8Array(await file.arrayBuffer());
      FS.writeFile(`/input/${file.name}`, bytes);
      setProgress((index / Math.max(1, selectedFiles.length)) * 20, `正在准备 ${index + 1} / ${selectedFiles.length}`);
    }
  }

  function collectOutputFiles(FS, root) {
    const result = [];
    const walk = (dir, relativeBase) => {
      const entries = FS.readdir(dir).filter((name) => name !== "." && name !== "..");
      for (const entry of entries) {
        const fullPath = `${dir}/${entry}`;
        const relPath = relativeBase ? `${relativeBase}/${entry}` : entry;
        const stat = FS.stat(fullPath);
        if (FS.isDir(stat.mode)) {
          walk(fullPath, relPath);
        } else {
          result.push({
            path: relPath,
            data: FS.readFile(fullPath)
          });
        }
      }
    };
    walk(root, "");
    return result;
  }

  async function buildZip(outputFiles) {
    const zip = new JSZip();
    for (const file of outputFiles) {
      zip.file(file.path, file.data);
    }
    return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  }

  async function runParser() {
    if (!wasmModule || selectedFiles.length === 0) {
      return;
    }

    outputZipBlob = null;
    statOutput.textContent = "0";
    resultCopy.textContent = "处理中";
    statusCopy.textContent = "处理中";
    resetLog("开始整理本次任务…");
    setProgress(2, "准备文件");
    syncActionButtons();
    runBtn.disabled = true;
    heroRunBtn.disabled = true;

    try {
      await writeInputs(wasmModule.FS);
      logLine("文件已经加入处理流程。");
      setProgress(24, "开始处理");

      try {
        const exitCode = wasmModule.callMain(["-i", "/input", "-o", "/output"]);
        if (typeof exitCode === "number" && exitCode !== 0) {
          throw new Error(`处理未完成，返回代码 ${exitCode}`);
        }
      } catch (err) {
        if (!(err && typeof err === "object" && String(err.name || "").includes("ExitStatus"))) {
          throw err;
        }
        if (typeof err.status === "number" && err.status !== 0) {
          throw new Error(`处理未完成，返回代码 ${err.status}`);
        }
      }

      setProgress(76, "整理结果");
      logLine("处理已经完成，正在整理结果。");
      const outputFiles = collectOutputFiles(wasmModule.FS, "/output");
      statOutput.textContent = String(outputFiles.length);
      outputZipBlob = await buildZip(outputFiles);
      setProgress(100, "可下载");
      statusCopy.textContent = "已完成";
      resultCopy.textContent = outputFiles.length > 0 ? `共 ${outputFiles.length} 个文件` : "没有输出文件";
      logLine(`全部完成，已生成 ${outputFiles.length} 个结果文件。`);
    } catch (err) {
      statusCopy.textContent = "处理失败";
      resultCopy.textContent = "未生成结果";
      setProgress(0, "处理失败");
      logLine(`处理失败：${err && err.message ? err.message : String(err)}`);
      outputZipBlob = null;
    } finally {
      syncActionButtons();
    }
  }

  function downloadZip() {
    if (!outputZipBlob) {
      return;
    }

    const url = URL.createObjectURL(outputZipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "YSMParser-output.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function clearAll() {
    selectedFiles = [];
    outputZipBlob = null;
    statOutput.textContent = "0";
    resultCopy.textContent = "尚未生成";
    statusCopy.textContent = wasmModule ? "待命" : "准备中";
    setProgress(0, "等待开始");
    fileInput.value = "";
    resetLog(wasmModule ? "页面已就绪，等待新的文件。" : "正在准备页面...");
    refreshSelectedFiles();
  }

  function attachDragDrop() {
    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("active");
      });
    });

    ["dragleave", "drop"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("active");
      });
    });

    dropzone.addEventListener("drop", (event) => {
      selectedFiles = normalizeFiles(event.dataTransfer.files);
      outputZipBlob = null;
      resultCopy.textContent = "尚未生成";
      refreshSelectedFiles();
    });
  }

  async function diagnoseFactoryError() {
    if (window.Module && typeof window.Module === "object" && typeof window.YSMParserModule !== "function") {
      return "页面文件不完整，请替换为可直接打开的完整页面后再试。";
    }

    try {
      const response = await fetch("./YSMParser.js", { cache: "no-store" });
      if (response.ok) {
        const source = await response.text();
        if (
          source.includes("require(\"node:fs\")") ||
          source.includes("require('node:fs')") ||
          source.includes("NODERAWFS") ||
          source.includes("ENVIRONMENT_IS_NODE=true")
        ) {
          return "当前页面文件与所需资源不匹配，请重新放入正确版本后再试。";
        }
      }
    } catch (_) {
    }

    return "页面暂时无法启动，请确认文件已经完整放好后再试。";
  }

  async function init() {
    refreshSelectedFiles();
    attachDragDrop();

    fileInput.addEventListener("change", () => {
      selectedFiles = normalizeFiles(fileInput.files);
      outputZipBlob = null;
      resultCopy.textContent = "尚未生成";
      refreshSelectedFiles();
    });

    heroSelectBtn.addEventListener("click", () => fileInput.click());
    heroRunBtn.addEventListener("click", runParser);
    heroDownloadBtn.addEventListener("click", downloadZip);

    runBtn.addEventListener("click", runParser);
    downloadBtn.addEventListener("click", downloadZip);
    clearBtn.addEventListener("click", clearAll);

    try {
      const factory = window.YSMParserModule || window.Module || globalThis.YSMParserModule || globalThis.Module;
      if (typeof factory !== "function") {
        throw new Error(await diagnoseFactoryError());
      }

      wasmModule = await factory({
        noInitialRun: true,
        print: (text) => logLine(text),
        printErr: (text) => logLine(text),
        locateFile: (path) => `./${path}`
      });

      setRuntimeState("ready", "一切就绪，可以开始");
      resetLog("页面已经准备完成，可以开始处理文件。");
      statusCopy.textContent = "待命";
      refreshSelectedFiles();
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      setRuntimeState("error", message);
      statusCopy.textContent = "暂时不可用";
      resetLog(`启动失败：${message}`);
    }
  }

  init();
})();
