# Records every visible top-level window that appears while the sync runs by itself, so a window that
# flashes for a fraction of a second on the person's screen is still caught. Each one is written with its
# process and that process's parent, so the test can tell a window of the sync from one of Windows itself.
#   $args[0]  how many seconds to watch
#   $args[1]  the file to write to (each run uses its own, so a watcher left from an earlier run never mixes in)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class Win {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Visible() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(300); GetWindowTextW(h, t, 300);
      var c = new StringBuilder(300); GetClassNameW(h, c, 300);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(pid + "|" + c.ToString() + "|" + t.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$deadline = (Get-Date).AddSeconds([int]$args[0])
$out = if ($args.Count -gt 1) { $args[1] } else { 'C:\Users\Public\ccsync\windows.out' }
$baseline = @{}
foreach ($w in [Win]::Visible()) { $baseline[$w] = $true }
# Outside the person's desktop almost nothing is visible, so this count is the proof the watcher is
# looking at the screen they would see.
"$(Get-Date -Format 'HH:mm:ss.fff') WATCH START, visible windows: $($baseline.Count)" | Out-File -Append -Encoding utf8 $out
$seen = @{}
while ((Get-Date) -lt $deadline) {
  foreach ($w in [Win]::Visible()) {
    if (-not $baseline.ContainsKey($w) -and -not $seen.ContainsKey($w)) {
      $seen[$w] = $true
      $parts = $w.Split('|', 3)
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($parts[0])" -ErrorAction SilentlyContinue
      $parent = if ($proc) { Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue } else { $null }
      "$(Get-Date -Format 'HH:mm:ss.fff') NEW WINDOW process=$($proc.Name) parent=$($parent.Name) class=$($parts[1]) title=$($parts[2])" | Out-File -Append -Encoding utf8 $out
    }
  }
  Start-Sleep -Milliseconds 40
}
"WATCH DONE, new windows: $($seen.Count)" | Out-File -Append -Encoding utf8 $out
