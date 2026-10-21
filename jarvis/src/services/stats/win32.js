'use strict';

const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const NVIDIA_QUERY = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu';
const DXGI_HELPER = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct AdapterLuid { public uint LowPart; public int HighPart; }
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct AdapterDesc {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;
  public uint VendorId; public uint DeviceId; public uint SubSysId; public uint Revision;
  public UIntPtr DedicatedVideoMemory; public UIntPtr DedicatedSystemMemory; public UIntPtr SharedSystemMemory;
  public AdapterLuid AdapterLuid;
}
[ComImport, Guid("7B7166EC-21C7-44AE-B21A-C9AE321AE369"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIFactory {
  [PreserveSig] int SetPrivateData(ref Guid name, uint size, IntPtr data);
  [PreserveSig] int SetPrivateDataInterface(ref Guid name, IntPtr unknown);
  [PreserveSig] int GetPrivateData(ref Guid name, ref uint size, IntPtr data);
  [PreserveSig] int GetParent(ref Guid iid, out IntPtr parent);
  [PreserveSig] int EnumAdapters(uint index, out IDXGIAdapter adapter);
  [PreserveSig] int MakeWindowAssociation(IntPtr window, uint flags);
  [PreserveSig] int GetWindowAssociation(out IntPtr window);
  [PreserveSig] int CreateSwapChain(IntPtr device, IntPtr desc, out IntPtr swapChain);
  [PreserveSig] int CreateSoftwareAdapter(IntPtr module, out IntPtr adapter);
}
[ComImport, Guid("2411E7E1-12AC-4CCF-BD14-9798E8534DC0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIAdapter {
  [PreserveSig] int SetPrivateData(ref Guid name, uint size, IntPtr data);
  [PreserveSig] int SetPrivateDataInterface(ref Guid name, IntPtr unknown);
  [PreserveSig] int GetPrivateData(ref Guid name, ref uint size, IntPtr data);
  [PreserveSig] int GetParent(ref Guid iid, out IntPtr parent);
  [PreserveSig] int EnumOutputs(uint index, out IntPtr output);
  [PreserveSig] int GetDesc(out AdapterDesc desc);
  [PreserveSig] int CheckInterfaceSupport(ref Guid iid, out long version);
}
public static class JarvisDxgiAdapters {
  [DllImport("dxgi.dll", ExactSpelling=true)] static extern int CreateDXGIFactory(ref Guid iid, out IDXGIFactory factory);
  public static string GetAdapters() {
    var result = new List<string>(); var iid = new Guid("7B7166EC-21C7-44AE-B21A-C9AE321AE369"); IDXGIFactory factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory(ref iid, out factory));
    for (uint i=0;i<16;i++) { IDXGIAdapter adapter; int hr=factory.EnumAdapters(i,out adapter); if(hr<0) break; AdapterDesc d; if(adapter.GetDesc(out d)>=0) result.Add(String.Join("\t", d.Description.Replace("\t", " "), d.VendorId.ToString(), d.DeviceId.ToString(), String.Format("{0:X8}_{1:X8}", unchecked((uint)d.AdapterLuid.HighPart), d.AdapterLuid.LowPart), d.DedicatedVideoMemory.ToUInt64().ToString())); Marshal.ReleaseComObject(adapter); }
    Marshal.ReleaseComObject(factory); return String.Join("\n", result.ToArray());
  }
}
`;

let previousCpu = null;
let previousNetwork = null;
let networkTime = 0;
let totals = { rx: 0, tx: 0 };
let history = { cpu: [], memory: [], networkRx: [], networkTx: [], time: [] };
let cachedGpu = null;
let cachedGpuAt = 0;
let cachedBattery = null;
let cachedBatteryAt = 0;

function getCpu() {
  const cpus = os.cpus();
  const current = cpus.map((cpu) => {
    const times = cpu.times;
    const idle = times.idle;
    const total = times.user + times.nice + times.sys + times.irq + times.idle;
    return { idle, total };
  });
  const old = previousCpu;
  previousCpu = current;
  const usage = current.map((item, index) => {
    const before = old?.[index];
    if (!before) return 0;
    const total = item.total - before.total;
    const idle = item.idle - before.idle;
    return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  });
  return {
    usage: usage.length ? Math.round(usage.reduce((sum, value) => sum + value, 0) / usage.length) : 0,
    cores: usage,
    count: cpus.length,
    model: cpus[0]?.model || 'Windows CPU',
    speedMhz: cpus[0]?.speed || null,
    temperatureC: null,
  };
}

function getMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  return { available: total > 0, total, used: Math.max(0, total - free), free };
}

async function getStorage() {
  const drive = process.env.SystemDrive || 'C:';
  const root = drive.endsWith('\\') ? drive : `${drive}\\`;
  try {
    const output = await runPowerShell(`$ErrorActionPreference='Stop'; $d=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='${drive}'\" | Select-Object -First 1 Size,FreeSpace; if($d){[pscustomobject]@{total=[double]$d.Size;free=[double]$d.FreeSpace}|ConvertTo-Json -Compress}`);
    const result = JSON.parse(output);
    const total = Number(result.total);
    const free = Number(result.free);
    return { available: total > 0, drive: root, total, used: total - free, free };
  } catch (_) { return { available: false, drive: root, total: 0, used: 0, free: 0 }; }
}

async function runPowerShell(script, timeout = 9000) {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch (_) {
    return fallback;
  }
}

async function getNetwork() {
  const script = String.raw`$ErrorActionPreference='SilentlyContinue'; Get-NetAdapterStatistics -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo' } | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress`;
  try {
    const adapters = parseJson(await runPowerShell(script), []);
    const rx = adapters.reduce((sum, adapter) => sum + (Number(adapter.ReceivedBytes) || 0), 0);
    const tx = adapters.reduce((sum, adapter) => sum + (Number(adapter.SentBytes) || 0), 0);
    const now = Date.now();
    const seconds = networkTime ? Math.max((now - networkTime) / 1000, 0.01) : 0;
    const rxRate = previousNetwork && seconds ? Math.max(0, rx - previousNetwork.rx) / seconds : 0;
    const txRate = previousNetwork && seconds ? Math.max(0, tx - previousNetwork.tx) / seconds : 0;
    if (previousNetwork) {
      totals.rx += Math.max(0, rx - previousNetwork.rx);
      totals.tx += Math.max(0, tx - previousNetwork.tx);
    }
    previousNetwork = { rx, tx };
    networkTime = now;
    return {
      available: adapters.length > 0,
      adapter: adapters.map((adapter) => adapter.Name).join(', '),
      rxRate,
      txRate,
      totalRx: totals.rx,
      totalTx: totals.tx,
    };
  } catch (_) {
    return { available: false, adapter: '', rxRate: 0, txRate: 0, totalRx: 0, totalTx: 0 };
  }
}

async function getGpus() {
  let devices = [];
  try {
    const script = String.raw`$ErrorActionPreference='SilentlyContinue'
  Add-Type -TypeDefinition @'
  ${DXGI_HELPER}
  '@
  $adapterLines=[JarvisDxgiAdapters]::GetAdapters() -split '\r?\n'
  $engineTotals=@{}
  try { $counter=Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -MaxSamples 1 -ErrorAction Stop; foreach($sample in $counter.CounterSamples){ if($sample.InstanceName -match 'luid_0x([a-fA-F0-9]+)_0x([a-fA-F0-9]+)_phys_\d+_eng_\d+_engtype_(.+)$'){ $luid=($Matches[1]+'_'+$Matches[2]).ToUpperInvariant(); $engine=$Matches[3]; $key=$luid+'|'+$engine; if(!$engineTotals.ContainsKey($key)){$engineTotals[$key]=0}; $engineTotals[$key]+=[double]$sample.CookedValue } } } catch {}
  $rows=@()
  foreach($line in $adapterLines){ if(!$line){continue}; $p=$line -split '\t'; if($p.Count -lt 5){continue}; $luid=$p[3].ToUpperInvariant(); $usage=0.0; $hasUsage=$false; foreach($key in $engineTotals.Keys){ if($key.StartsWith($luid+'|')){$hasUsage=$true; $usage=[math]::Max($usage,[double]$engineTotals[$key])} }; if($hasUsage){$usage=[math]::Min(100,[math]::Max(0,$usage))}else{$usage=$null}; $rows+= [pscustomobject]@{model=$p[0];vendorId=[uint32]$p[1];deviceId=[uint32]$p[2];luid=$luid;usage=$usage;memoryTotal=[double]$p[4];source='Windows GPU Engine'} }
  $rows | ConvertTo-Json -Compress -Depth 4`.replace(/^[ \t]+/gm, '');
    devices = parseJson(await runPowerShell(script, 12_000), []).map((gpu) => ({
      model: gpu.model || 'Graphics adapter',
      vendorId: Number(gpu.vendorId),
      deviceId: Number(gpu.deviceId),
      adapterLuid: gpu.luid,
      usage: gpu.usage !== null && gpu.usage !== undefined && Number.isFinite(Number(gpu.usage)) ? Number(gpu.usage) : null,
      memoryUsed: null,
      memoryTotal: Number(gpu.memoryTotal) || null,
      temperatureC: null,
      source: gpu.source || 'Windows GPU Engine',
    })).filter((gpu) => !/microsoft basic render driver|basic render driver|remote display/i.test(gpu.model));
  } catch (_) {
    devices = [];
  }

  let nvidiaDevices = [];
  try {
    const { stdout } = await execFileAsync('nvidia-smi.exe', [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 2500, maxBuffer: 256 * 1024 });
    nvidiaDevices = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [model, usage, used, total, temperature] = line.split(',').map((value) => value.trim());
      return { model, usage: Number(usage), memoryUsed: Number(used) * 1024 * 1024, memoryTotal: Number(total) * 1024 * 1024, temperatureC: Number(temperature), source: 'NVIDIA' };
    });
  } catch (_) {}

  for (const nvidia of nvidiaDevices) {
    const device = devices.find((gpu) => /nvidia/i.test(gpu.model) && (!nvidia.model || nvidia.model.toLowerCase().includes(gpu.model.toLowerCase()) || gpu.model.toLowerCase().includes(nvidia.model.toLowerCase())));
    if (device) Object.assign(device, nvidia);
    else devices.push(nvidia);
  }
  return { available: devices.length > 0, devices, reason: 'AMD/Intel utilization uses Windows GPU Engine counters; NVIDIA telemetry uses nvidia-smi. Some adapters may not expose temperature.' };
}

async function getCachedGpus() {
  if (!cachedGpu || Date.now() - cachedGpuAt >= 15_000) {
    cachedGpu = await getGpus();
    cachedGpuAt = Date.now();
  }
  return cachedGpu;
}

async function getBattery() {
  const script = String.raw`$ErrorActionPreference='SilentlyContinue'; $b=Get-CimInstance Win32_Battery | Select-Object -First 1; if($b){$remaining=$null;if($b.EstimatedRunTime -lt 71582788){$remaining=[int]$b.EstimatedRunTime};[pscustomobject]@{available=$true;percent=[int]$b.EstimatedChargeRemaining;status=[int]$b.BatteryStatus;minutes=$remaining}|ConvertTo-Json -Compress}else{[pscustomobject]@{available=$false;percent=$null;status=$null;minutes=$null}|ConvertTo-Json -Compress}`;
  try {
    const result = parseJson(await runPowerShell(script), [{}])[0];
    if (result.minutes >= 71582788) result.minutes = null;
    return result;
  } catch (_) {
    return { available: false, percent: null, status: null, minutes: null };
  }
}

async function getCachedBattery() {
  if (!cachedBattery || Date.now() - cachedBatteryAt >= 30_000) {
    cachedBattery = await getBattery();
    cachedBatteryAt = Date.now();
  }
  return cachedBattery;
}

function recordHistory(cpu, memory, network) {
  const now = Date.now();
  history.cpu.push(cpu.usage);
  history.memory.push(memory.total ? memory.used / memory.total * 100 : 0);
  history.networkRx.push(network.rxRate);
  history.networkTx.push(network.txRate);
  history.time.push(now);
  for (const key of Object.keys(history)) {
    if (history[key].length > 60) history[key].shift();
  }
  return history;
}

async function getStats() {
  const cpu = getCpu();
  const memory = getMemory();
  const [storage, network, gpus, battery] = await Promise.all([getStorage(), getNetwork(), getCachedGpus(), getCachedBattery()]);
  const samples = recordHistory(cpu, memory, network);
  return {
    available: true,
    cpu,
    memory,
    pagefile: { available: false, used: null, total: null },
    storage,
    network: { ...network, samples: { rx: samples.networkRx, tx: samples.networkTx } },
    gpus,
    battery,
    history: { ...samples, pagefile: { used: null, total: null } },
  };
}

module.exports = { getStats };
