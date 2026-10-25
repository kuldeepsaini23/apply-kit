import { runFill, aiFill, waitForLoad, api } from "./lib.js";

// Clicking the toolbar icon opens the side panel (the whole UI lives there).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (!tab?.id) return;
  try {
    if (command === "fill-form") await runFill(tab.id);
    if (command === "ai-fill-form") await aiFill(tab.id);
  } catch (e) { console.warn("Apply Kit:", e); }
});

// Messages from the dashboard (via bridge.js on localhost:4777).
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "ak-focus") return false; // for the side panel
  (async () => {
    if (msg.type === "ping") return { ok: true, version: chrome.runtime.getManifest().version };
    if (msg.type === "openAndFill") {
      const tab = await chrome.tabs.create({ url: msg.url, active: true });
      await waitForLoad(tab.id);
      const r = msg.ai ? await aiFill(tab.id) : await runFill(tab.id);
      return { ok: true, ...r };
    }
    if (msg.type === "log") return api("/api/applications", msg.row);
    return { error: "unknown message" };
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});
