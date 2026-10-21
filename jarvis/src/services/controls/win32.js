'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const AUDIO_HELPER = String.raw`
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IDevice device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDevice {
  [PreserveSig] int Activate(ref Guid iid, int context, IntPtr activation, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
  [PreserveSig] int GetId(out IntPtr id);
  [PreserveSig] int GetState(out int state);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify); [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count); [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context); [PreserveSig] int GetMasterVolumeLevel(out float level);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level); [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid context);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context); [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level); [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute); [PreserveSig] int GetVolumeStepInfo(out uint step, out uint count);
  [PreserveSig] int VolumeStepUp(ref Guid context); [PreserveSig] int VolumeStepDown(ref Guid context); [PreserveSig] int QueryHardwareSupport(out uint mask);
  [PreserveSig] int GetVolumeRange(out float min, out float max, out float increment);
}
public static class JarvisAudio {
  static IEndpointVolume GetEndpoint() {
    var type = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"));
    var enumerator = (IDeviceEnumerator)Activator.CreateInstance(type); IDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    var iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object instance;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out instance));
    return (IEndpointVolume)instance;
  }
  public static string State() {
    var endpoint = GetEndpoint(); float volume; bool muted;
    Marshal.ThrowExceptionForHR(endpoint.GetMasterVolumeLevelScalar(out volume));
    Marshal.ThrowExceptionForHR(endpoint.GetMute(out muted));
    return String.Format("{{\"available\":true,\"value\":{0},\"muted\":{1}}}", volume.ToString(System.Globalization.CultureInfo.InvariantCulture), muted ? "true" : "false");
  }
  public static void Set(float value) { var endpoint = GetEndpoint(); var context = Guid.Empty; Marshal.ThrowExceptionForHR(endpoint.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(1, value)), ref context)); }
  public static void Mute(bool value) { var endpoint = GetEndpoint(); var context = Guid.Empty; Marshal.ThrowExceptionForHR(endpoint.SetMute(value, ref context)); }
}
`;

const MEDIA_HELPER = String.raw`
using System;
using System.Runtime.InteropServices;
public static class JarvisMediaKeys {
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Press(ushort key) {
    var inputs = new INPUT[2]; inputs[0].type=1; inputs[0].ki.wVk=key;
    inputs[1].type=1; inputs[1].ki.wVk=key; inputs[1].ki.dwFlags=2;
    if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new Exception("Windows rejected the media key input.");
  }
}
`;

function runPowerShell(script, timeout = 8000) {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  return execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024,
  }).then(({ stdout }) => stdout.trim());
}

function parseJson(text, fallback = null) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

async function getAudio() {
  const text = await runPowerShell(`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${AUDIO_HELPER}\n'@\n[JarvisAudio]::State()`);
  return parseJson(text, { available: false, value: 0, muted: false });
}

async function setVolume(percent) {
  if (!Number.isFinite(Number(percent))) throw new Error('Volume must be a number.');
  const value = Math.max(0, Math.min(100, Math.round(Number(percent))));
  await runPowerShell(`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${AUDIO_HELPER}\n'@\n[JarvisAudio]::Set(${value / 100})`);
  return { ok: true, available: true };
}

async function toggleMute() {
  const state = await getAudio();
  if (!state.available) return { ok: false, available: false };
  await runPowerShell(`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${AUDIO_HELPER}\n'@\n[JarvisAudio]::Mute(${state.muted ? '$false' : '$true'})`);
  return { ok: true, available: true };
}

async function getWifi() {
  const script = String.raw`$ErrorActionPreference='SilentlyContinue'; $a=Get-NetAdapter -Physical | Where-Object { $_.Name -match 'Wi-?Fi|WLAN|Wireless' -or $_.InterfaceDescription -match 'Wi-?Fi|WLAN|Wireless|802\.11' } | Select-Object -First 1 Name,Status,InterfaceDescription; $ssid=''; $state=''; $n=netsh wlan show interfaces 2>$null; foreach($line in $n){if($line -match '^\s*State\s*:\s*(.+)$'){$state=$Matches[1].Trim()};if($line -match '^\s*SSID\s*:\s*(.+)$' -and $line -notmatch 'BSSID'){$ssid=$Matches[1].Trim()}}; [pscustomobject]@{available=($null -ne $a);name=$a.Name;adapterStatus=[string]$a.Status;enabled=($null -ne $a -and [string]$a.Status -ne 'Disabled');connected=($state -match 'connected|Verbunden|connecté');ssid=$ssid} | ConvertTo-Json -Compress`;
  return parseJson(await runPowerShell(script), { available: false, enabled: false, connected: false, ssid: '' });
}

async function getBluetooth() {
  const script = String.raw`$ErrorActionPreference='SilentlyContinue'; $d=Get-PnpDevice -Class Bluetooth -Status OK | Select-Object -First 1; [pscustomobject]@{available=($null -ne $d);state=if($d){'Device ready'}else{'No Bluetooth device detected'}} | ConvertTo-Json -Compress`;
  return parseJson(await runPowerShell(script), { available: false, state: 'Unavailable' });
}

async function getBattery() {
  const script = String.raw`$ErrorActionPreference='SilentlyContinue'; $b=Get-CimInstance Win32_Battery | Select-Object -First 1; if($b){[pscustomobject]@{available=$true;percent=$b.EstimatedChargeRemaining;status=$b.BatteryStatus;minutes=$b.EstimatedRunTime}|ConvertTo-Json -Compress}else{[pscustomobject]@{available=$false;percent=$null;status='No battery detected';minutes=$null}|ConvertTo-Json -Compress}`;
  return parseJson(await runPowerShell(script), { available: false, percent: null, status: 'Unavailable', minutes: null });
}

async function getBrightness() {
  const script = String.raw`$ErrorActionPreference='SilentlyContinue'; $b=Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1; if($b){[pscustomobject]@{available=$true;value=[int]$b.CurrentBrightness}|ConvertTo-Json -Compress}else{[pscustomobject]@{available=$false;value=$null}|ConvertTo-Json -Compress}`;
  return parseJson(await runPowerShell(script), { available: false, value: null });
}

async function setBrightness(percent) {
  if (!Number.isFinite(Number(percent))) throw new Error('Brightness must be a number.');
  const value = Math.max(0, Math.min(100, Math.round(Number(percent))));
  const script = String.raw`$ErrorActionPreference='Stop'; $m=Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1; if(!$m){throw 'Brightness is not supported on this display.'}; Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{Timeout=1;Brightness=${value}} | Out-Null`;
  await runPowerShell(script);
  return { ok: true, available: true };
}

async function getPowerSchemes() {
  const text = await runPowerShell('powercfg.exe /list');
  const activeMatch = text.match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\s+\(([^)]+)\)\s+\*/i);
  const schemes = [...text.matchAll(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\s+\(([^)]+)\)/gi)].map((match) => ({ id: match[1], name: match[2] }));
  return { available: schemes.length > 0, active: activeMatch?.[1] || '', schemes };
}

async function setPowerScheme(id) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(id))) throw new Error('Invalid power profile.');
  const state = await getPowerSchemes();
  if (!state.schemes.some((scheme) => scheme.id.toLowerCase() === id.toLowerCase())) throw new Error('That power profile is not available.');
  await execFileAsync('powercfg.exe', ['/setactive', id], { windowsHide: true, timeout: 5000 });
  return { ok: true };
}

async function media(action) {
  const keys = { 'play-pause': 0xB3, next: 0xB0, previous: 0xB1 };
  if (!Object.prototype.hasOwnProperty.call(keys, action)) throw new Error('Unsupported media action.');
  await runPowerShell(`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${MEDIA_HELPER}\n'@\n[JarvisMediaKeys]::Press(${keys[action]})`);
  return { ok: true, available: true };
}

async function getControls() {
  const values = await Promise.allSettled([getWifi(), getBluetooth(), getAudio(), getBattery(), getBrightness(), getPowerSchemes()]);
  const read = (index, fallback) => {
    if (values[index].status === 'fulfilled') return values[index].value;
    return { ...fallback, reason: values[index].reason?.message || 'Windows could not read this control.' };
  };
  return {
    wifi: read(0, { available: false, enabled: false, connected: false, ssid: '' }),
    bluetooth: read(1, { available: false, state: 'Unavailable' }),
    audio: read(2, { available: false, value: 0, muted: false }),
    battery: read(3, { available: false, percent: null, status: 'Unavailable' }),
    brightness: read(4, { available: false, value: null }),
    power: read(5, { available: false, active: '', schemes: [] }),
    media: { available: true, detail: 'Windows media keys control the active media session.' },
  };
}

module.exports = { getControls, setBrightness, setVolume, toggleMute, media, getPowerSchemes, setPowerScheme, getWifi, getBluetooth, getBattery, getAudio, openSetting: (uri) => uri };
