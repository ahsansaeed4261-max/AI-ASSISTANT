param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'apply')]
  [string]$Action,

  [string]$Path,
  [string]$MonitorId
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct JarvisDesktopRect
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

[ComImport]
[Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IJarvisDesktopWallpaper
{
    void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
    [return: MarshalAs(UnmanagedType.LPWStr)]
    string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
    void GetMonitorDevicePathAt(uint monitorIndex, [MarshalAs(UnmanagedType.LPWStr)] out string monitorID);
    uint GetMonitorDevicePathCount();
    void GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID, out JarvisDesktopRect displayRect);
    void SetBackgroundColor(uint color);
    uint GetBackgroundColor();
    void SetPosition(uint position);
    uint GetPosition();
    void SetSlideshow([MarshalAs(UnmanagedType.Interface)] object items);
    [return: MarshalAs(UnmanagedType.Interface)]
    object GetSlideshow();
    void SetSlideshowOptions(uint options, uint slideshowTick);
    void GetSlideshowOptions(out uint options, out uint slideshowTick);
    void AdvanceSlideshow([MarshalAs(UnmanagedType.LPWStr)] string monitorID, uint direction);
    uint GetStatus();
    void Enable(bool enable);
}

public static class JarvisDesktopWallpaperFactory
{
    private static IJarvisDesktopWallpaper Create()
    {
        var classId = new Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD");
        var desktopWallpaperType = Type.GetTypeFromCLSID(classId);
        return (IJarvisDesktopWallpaper)Activator.CreateInstance(desktopWallpaperType);
    }

    public static JarvisDesktopMonitor[] GetMonitors()
    {
        var desktopWallpaper = Create();
        var count = desktopWallpaper.GetMonitorDevicePathCount();
        var monitors = new JarvisDesktopMonitor[count];
        for (uint index = 0; index < count; index++)
        {
            string monitorId;
            desktopWallpaper.GetMonitorDevicePathAt(index, out monitorId);
            JarvisDesktopRect rect;
            desktopWallpaper.GetMonitorRECT(monitorId, out rect);
            monitors[index] = new JarvisDesktopMonitor
            {
                Id = monitorId,
                X = rect.Left,
                Y = rect.Top,
                Width = rect.Right - rect.Left,
                Height = rect.Bottom - rect.Top
            };
        }
        return monitors;
    }

    public static void SetWallpaper(string monitorId, string path)
    {
        Create().SetWallpaper(String.IsNullOrWhiteSpace(monitorId) ? null : monitorId, path);
    }
}

public class JarvisDesktopMonitor
{
    public string Id { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
}
'@

if ($Action -eq 'list') {
  $monitors = [JarvisDesktopWallpaperFactory]::GetMonitors() | ForEach-Object {
    [pscustomobject]@{
      id = $_.Id
      bounds = [pscustomobject]@{
        x = $_.X
        y = $_.Y
        width = $_.Width
        height = $_.Height
      }
    }
  }
  ConvertTo-Json -InputObject @($monitors) -Compress -Depth 4
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
  throw 'The selected wallpaper file is unavailable.'
}

$targetMonitor = if ([string]::IsNullOrWhiteSpace($MonitorId)) { $null } else { $MonitorId }
[JarvisDesktopWallpaperFactory]::SetWallpaper($targetMonitor, $Path)
