// Runs only on the dashboard (localhost:4777). Lets the page talk to the extension.
window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "applykit-dashboard") return;
  const { id, ...msg } = e.data;
  chrome.runtime.sendMessage(msg, (res) => {
    window.postMessage({ source: "applykit-ext", id, res: res || { error: chrome.runtime.lastError?.message } }, "*");
  });
});
window.postMessage({ source: "applykit-ext", type: "ready", version: chrome.runtime.getManifest().version }, "*");
