// ApplyKit.exe only: the icon by the clock. Bun has no tray API, so a hidden PowerShell draws it
// (Windows Forms) and prints the menu item you click; we read those lines and act on them.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const hidden = { stdout: "ignore", stderr: "ignore", windowsHide: true } as const;

export const openUrl = (url: string) => Bun.spawn(["explorer.exe", url], hidden);

const autostartOn = () => Bun.spawnSync(["reg", "query", RUN_KEY, "/v", "ApplyKit"], hidden).exitCode === 0;
function setAutostart(on: boolean) {
  if (on) Bun.spawnSync(["reg", "add", RUN_KEY, "/v", "ApplyKit", "/t", "REG_SZ", "/d", `"${process.execPath}"`, "/f"], hidden);
  else Bun.spawnSync(["reg", "delete", RUN_KEY, "/v", "ApplyKit", "/f"], hidden);
}

// No console window, so logs go to data/applykit.log.
export function logToFile(dataDir: string) {
  const file = join(dataDir, "applykit.log");
  const write = (level: string) => (...a: any[]) => {
    try { appendFileSync(file, `${new Date().toISOString()} ${level}${a.map(String).join(" ")}\n`); } catch {}
  };
  console.log = write("");
  console.error = write("error ");
}

// Another copy (or an old `bun server.ts`) still holding the port: stop it so this one can start.
export async function replaceOldCopy(port: number) {
  const ours = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (!ours) return;
  const out = Bun.spawnSync(["netstat", "-ano", "-p", "TCP"], { ...hidden, stdout: "pipe" }).stdout.toString();
  const line = out.split("\n").find((l) => l.includes(`127.0.0.1:${port} `) && l.includes("LISTENING"));
  const pid = Number(line?.trim().split(/\s+/).pop());
  if (!pid || pid === process.pid) return;
  Bun.spawnSync(["taskkill", "/PID", String(pid), "/F"], hidden);
  await Bun.sleep(400);
}

const script = (exe: string, auto: boolean) => `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$parent = Get-Process -Id ${process.pid}
function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${exe.replace(/'/g, "''")}')
$icon.Text = 'Apply Kit'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add('Open dashboard').add_Click({ Say 'open' })
$menu.Items.Add('Open hosted site').add_Click({ Say 'site' })
$menu.Items.Add('Open log').add_Click({ Say 'log' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$auto = New-Object System.Windows.Forms.ToolStripMenuItem 'Start with Windows'
$auto.Checked = $${auto}
$auto.add_Click({ $auto.Checked = -not $auto.Checked; Say ('autostart ' + $auto.Checked) })
[void]$menu.Items.Add($auto)
$menu.Items.Add('Restart').add_Click({ $icon.Visible = $false; Say 'restart' })
$menu.Items.Add('Quit').add_Click({ $icon.Visible = $false; Say 'quit'; [System.Windows.Forms.Application]::Exit() })
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({ if ($_.Button -eq 'Left') { Say 'open' } })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if ($parent.HasExited) { $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
$icon.Visible = $true
$icon.ShowBalloonTip(3000, 'Apply Kit is running', 'Click the icon for the dashboard, right-click for options.', 'Info')
[System.Windows.Forms.Application]::Run()
`;

export function startTray({ port, dataDir, site }: { port: number; dataDir: string; site: string }) {
  const encoded = Buffer.from(script(process.execPath, autostartOn()), "utf16le").toString("base64");
  const ps = Bun.spawn(["powershell.exe", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of ps.stdout) {
      buf += decoder.decode(chunk);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const cmd = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (cmd === "open") openUrl(`http://localhost:${port}`);
        else if (cmd === "site") openUrl(site);
        else if (cmd === "log") openUrl(join(dataDir, "applykit.log"));
        else if (cmd.startsWith("autostart ")) setAutostart(cmd.endsWith("True"));
        else if (cmd === "restart") {
          // The new copy stops this one once it starts (replaceOldCopy).
          Bun.spawn([process.execPath], { ...hidden, cwd: process.cwd() });
        } else if (cmd === "quit") process.exit(0);
      }
    }
    // The icon process ended on its own (it crashed or was killed): keep serving, log it.
    console.error("tray icon exited", await new Response(ps.stderr).text());
  })();
}
