# Token-efficient desktop helpers. Dot-source once per PowerShell call:
#   . $env:SCRATCH\uia.ps1
# Replaces re-emitting P/Invoke blocks and full-screen screenshots.

Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes | Out-Null

Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;using System.Collections.Generic;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int t,bool r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);
  public struct RECT{public int L,T,R,B;}
  public static void Click(int x,int y){ SetCursorPos(x,y); System.Threading.Thread.Sleep(140);
    mouse_event(0x02,0,0,0,0); System.Threading.Thread.Sleep(60); mouse_event(0x04,0,0,0,0); }
}
"@ -ErrorAction SilentlyContinue | Out-Null

function Get-Win {
  param([Parameter(Mandatory)][string]$Title)
  Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
}

function Focus-Win {
  param([Parameter(Mandatory)][string]$Title)
  $p = Get-Win $Title
  if (-not $p) { throw "no window matching '$Title'" }
  [Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
  [Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 500
  $p.MainWindowHandle
}

function Get-WinRect {
  param([Parameter(Mandatory)][string]$Title)
  $p = Get-Win $Title
  if (-not $p) { throw "no window matching '$Title'" }
  $r = New-Object Win+RECT
  [Win]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  [pscustomobject]@{ X=$r.L; Y=$r.T; W=$r.R-$r.L; H=$r.B-$r.T }
}

# Crop-only screenshot. Full-screen 3840x1080 reads cost ~1500 tokens;
# a window-sized crop costs ~150-400. Always pass -Title when you can.
function Shot {
  param([string]$Title, [string]$Out = "$env:TEMP\shot.png",
        [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0, [double]$Scale = 1.0)
  if ($Title) { $r = Get-WinRect $Title; $X=$r.X; $Y=$r.Y; $W=$r.W; $H=$r.H }
  if ($W -le 0) { $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen; $X=$vs.X;$Y=$vs.Y;$W=$vs.Width;$H=$vs.Height }
  $src = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($src)
  $g.CopyFromScreen($X, $Y, 0, 0, $src.Size)
  $g.Dispose()
  if ($Scale -ne 1.0) {
    $dst = New-Object System.Drawing.Bitmap ([int]($W*$Scale)), ([int]($H*$Scale))
    $g2 = [System.Drawing.Graphics]::FromImage($dst)
    $g2.DrawImage($src, 0, 0, $dst.Width, $dst.Height); $g2.Dispose(); $src.Dispose(); $src = $dst
  }
  $src.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $src.Dispose()
  "$Out $X,$Y ${W}x${H}"
}

# UI Automation text dump. ~300 tokens instead of a ~1500-token screenshot,
# and it yields click coordinates directly, so no image is needed to act.
# Electron/Chromium apps expose only a bare Pane on the first query: Chromium
# turns its accessibility tree on when it detects an AT client. Call Dump-UI
# twice - the second call returns the real tree. Measured on Skill Recorder:
# 1 element on the first call, 20 on the second.
function Dump-UI {
  param([Parameter(Mandatory)][string]$Title, [int]$Max = 60, [switch]$All)
  $p = Get-Win $Title
  if (-not $p) { throw "no window matching '$Title'" }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
  $cond = if ($All) { [System.Windows.Automation.Condition]::TrueCondition }
          else { New-Object System.Windows.Automation.PropertyCondition(
                   [System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true) }
  $n = 0
  foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    $name = $e.Current.Name
    if (-not $name -and -not $All) { continue }
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0) { continue }
    $cx = [int]($r.X + $r.Width/2); $cy = [int]($r.Y + $r.Height/2)
    "{0}|{1}|{2},{3}" -f $e.Current.ControlType.ProgrammaticName.Replace('ControlType.',''), $name, $cx, $cy
    if (++$n -ge $Max) { "...truncated at $Max"; break }
  }
}

# Click a UIA element by its accessible name - no screenshot round trip.
function Click-UI {
  param([Parameter(Mandatory)][string]$Title, [Parameter(Mandatory)][string]$Name)
  $p = Get-Win $Title
  if (-not $p) { throw "no window matching '$Title'" }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
  $c = New-Object System.Windows.Automation.PropertyCondition(
         [System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  if (-not $e) { throw "no element named '$Name'" }
  $r = $e.Current.BoundingRectangle
  [Win]::Click([int]($r.X + $r.Width/2), [int]($r.Y + $r.Height/2))
  "clicked '$Name' at $([int]($r.X + $r.Width/2)),$([int]($r.Y + $r.Height/2))"
}

function Send-Keys {
  param([Parameter(Mandatory)][string]$Keys, [int]$DelayMs = 300)
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $DelayMs
}
