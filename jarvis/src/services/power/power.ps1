param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('state', 'sleep', 'enable-hibernate')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

if ($Action -eq 'state') {
  $powerOutput = (& powercfg.exe /a 2>&1 | Out-String)
  $hibernateEnabled = $false
  try {
    $powerKey = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Power'
    $hibernateEnabled = [int]$powerKey.HibernateEnabled -eq 1
  } catch {}
  $availableSection = ($powerOutput -split '(?:\r?\n){2,}')[0]
  $hibernateDisabled = $powerOutput -match '(?im)^\s*Hibernation has not been enabled\.\s*$'
  $hibernateSupported = ($availableSection -match '(?im)^\s*Hibernate\s*$') -or $hibernateDisabled
  $reason = if ($hibernateEnabled) {
    ''
  } elseif ($hibernateSupported) {
    'Hibernate is supported but is currently disabled. Enabling it requires administrator permission.'
  } else {
    'Hibernate is unavailable or disabled on this device.'
  }
  [pscustomobject]@{
    hibernationEnabled = $hibernateEnabled
    hibernationSupported = ($hibernateSupported -or $hibernateEnabled)
    reason = $reason
  } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq 'sleep') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JarvisSleep
{
    [DllImport("powrprof.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetSuspendState(
        [MarshalAs(UnmanagedType.Bool)] bool hibernate,
        [MarshalAs(UnmanagedType.Bool)] bool forceCritical,
        [MarshalAs(UnmanagedType.Bool)] bool disableWakeEvent);
}
'@
  if (-not [JarvisSleep]::SetSuspendState($false, $false, $false)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Windows could not enter sleep (error $code)."
  }
  exit 0
}

if ($Action -eq 'enable-hibernate') {
  $process = Start-Process -FilePath 'powercfg.exe' -ArgumentList @('/hibernate', 'on') -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Windows could not enable hibernation (error $($process.ExitCode))."
  }
}
