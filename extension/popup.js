const indicator = document.querySelector("#indicator");
const status = document.querySelector("#status");
const extensionVersion = document.querySelector("#extension-version");
const profile = document.querySelector("#profile");
const generation = document.querySelector("#generation");
const setup = document.querySelector("#setup");
const error = document.querySelector("#error");
const retry = document.querySelector("#retry");
const physicalInput = document.querySelector("#physical-input");
const physicalInputStatus = document.querySelector("#physical-input-status");
const peripheralAccess = document.querySelector("#peripheral-access");
const peripheralAccessStatus = document.querySelector("#peripheral-access-status");
const recording = document.querySelector("#recording");
const recordingStatus = document.querySelector("#recording-status");
let physicalInputEnabled = false;
document.querySelector("#open-controls").addEventListener("click", async () => {
  try {
    const current = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: current.id });
    window.close();
  } catch (openError) { error.textContent = openError.message; }
});

function short(value) {
  if (!value) return "—";
  return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ kind: "status.get" });
  const manifest = chrome.runtime.getManifest();
  extensionVersion.textContent = `${manifest.version} · ${short(chrome.runtime.id)}`;
  indicator.dataset.connected = String(state.connected);
  status.textContent = state.connected
    ? "Connected"
    : state.connecting
      ? "Connecting…"
      : "Disconnected";
  profile.textContent = short(state.profileInstanceId);
  generation.textContent = short(state.generation);
  const companionReady = state.setup?.companionReady === true;
  const integrationReady = state.setup?.integrationReady === true || state.setup?.setupComplete === true;
  setup.dataset.ready = String(companionReady);
  setup.textContent = integrationReady
    ? "Ready — no manual routing setup"
    : companionReady
      ? "Ready — Companion works independently; integration is pending"
    : Array.isArray(state.setup?.exactBlockers) && state.setup.exactBlockers.length > 0
      ? `Waiting: ${state.setup.exactBlockers[0]}`
      : "Waiting for both Extensions";
  error.textContent = state.lastError ?? "None";
  physicalInputEnabled = state.physicalInputEnabled === true;
  physicalInput.disabled = state.debuggerPermissionGranted !== true;
  physicalInput.textContent = state.debuggerPermissionGranted !== true
    ? "Reload to approve Chrome access"
    : physicalInputEnabled
      ? "Disable physical input"
      : "Enable physical input";
  physicalInputStatus.textContent = state.debuggerPermissionGranted !== true
    ? "Chrome debugger access is unavailable — reload this Extension"
    : physicalInputEnabled
      ? "Enabled for bounded, screenshot-confirmed input"
      : "Disabled until you explicitly enable it";
  peripheralAccess.disabled = state.peripheralPermissionsGranted === true;
  peripheralAccess.textContent = state.peripheralPermissionsGranted === true
    ? "Downloads and clipboard enabled"
    : "Allow downloads and clipboard";
  peripheralAccessStatus.textContent = state.peripheralPermissionsGranted === true
    ? "Enabled for bounded task-owned operations"
    : "Optional — content query/export and WebMCP discovery do not need this";
  const recordingState = await chrome.runtime.sendMessage({ kind: "recording.status" }).catch(() => ({ active: false }));
  recording.dataset.active = String(recordingState?.active === true);
  recording.textContent = recordingState?.active === true ? "Stop recording and save WebM" : "Start tab recording with audio";
  if (recordingState?.active !== true && !recordingStatus.textContent.startsWith("Saved ")) {
    recordingStatus.textContent = "Records the current tab's video and audio into Downloads.";
  }
}

retry.addEventListener("click", async () => {
  retry.disabled = true;
  await chrome.runtime.sendMessage({ kind: "connection.retry" });
  setTimeout(async () => {
    await refresh();
    retry.disabled = false;
  }, 700);
});

physicalInput.addEventListener("click", async () => {
  physicalInput.disabled = true;
  physicalInputStatus.textContent = physicalInputEnabled ? "Disabling physical input…" : "Enabling physical input…";
  try {
    const response = await chrome.runtime.sendMessage({ kind: "physicalInput.set", enabled: !physicalInputEnabled });
    if (response?.error) throw new Error(response.error);
    physicalInputStatus.textContent = response?.enabled
      ? "Enabled for bounded, screenshot-confirmed input"
      : "Physical input disabled";
  } catch (enableError) {
    physicalInputStatus.textContent = `Physical input setting failed: ${enableError instanceof Error ? enableError.message : String(enableError)}`;
  } finally {
    await refresh();
  }
});

peripheralAccess.addEventListener("click", async () => {
  peripheralAccess.disabled = true;
  peripheralAccessStatus.textContent = "Waiting for Chrome permissions…";
  try {
    const granted = await chrome.permissions.request({ permissions: ["downloads", "clipboardRead", "clipboardWrite"] });
    peripheralAccessStatus.textContent = granted
      ? "Enabled for bounded task-owned operations"
      : "Permissions were not granted";
  } catch (permissionError) {
    peripheralAccessStatus.textContent = `Permission request failed: ${permissionError instanceof Error ? permissionError.message : String(permissionError)}`;
  } finally {
    await refresh();
  }
});

recording.addEventListener("click", async () => {
  recording.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab was found");
    if (recording.dataset.active === "true") {
      const result = await chrome.runtime.sendMessage({ kind: "recording.stop", filename: `companion-${Date.now()}.webm` });
      if (!result?.ok) throw new Error(result?.error ?? "Recording could not stop");
      recording.dataset.active = "false";
      recording.textContent = "Start tab recording with audio";
      recordingStatus.textContent = `Saved ${result.filename} (${result.bytes} bytes, audio verified)`;
    } else {
      const granted = await chrome.permissions.request({ permissions: ["downloads"] });
      if (!granted) throw new Error("Downloads permission was not granted");
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const result = await chrome.runtime.sendMessage({ kind: "recording.start", tabId: tab.id, streamId, taskId: "companion-popup-recording" });
      if (!result?.ok) throw new Error(result?.error ?? "Recording could not start");
      recording.dataset.active = "true";
      recording.textContent = "Stop recording and save WebM";
      recordingStatus.textContent = `Recording tab ${tab.id} with tab audio…`;
    }
  } catch (recordingError) {
    recordingStatus.textContent = `Recording: ${recordingError instanceof Error ? recordingError.message : String(recordingError)}`;
  } finally {
    recording.disabled = false;
  }
});

refresh();
