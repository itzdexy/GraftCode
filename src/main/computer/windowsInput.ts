import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

/**
 * Mouse and keyboard on Windows through one long-lived PowerShell process
 * that compiles a small class over user32's SendInput and SetCursorPos, then
 * reads one JSON command per line and answers "ok" or "err <message>".
 * Coordinates are physical pixels (the process is DPI aware); text is typed
 * as Unicode key events, so any character works regardless of layout.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class GraftInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  const uint KEYUP = 0x0002, UNICODE = 0x0004;
  const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, WHEEL = 0x0800;
  public static void Init() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
  }
  static void Send(INPUT input) {
    if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("input was blocked (error " + Marshal.GetLastWin32Error() + ")");
  }
  static void Mouse(uint flags, int data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); Send(i);
  }
  static void Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; Send(i);
  }
  public static void Move(int x, int y) { if (!SetCursorPos(x, y)) throw new Exception("could not move the pointer"); }
  public static void Click(int x, int y, string button, int count) {
    Move(x, y); Thread.Sleep(40);
    uint down = button == "right" ? RIGHTDOWN : button == "middle" ? MIDDLEDOWN : LEFTDOWN;
    uint up = button == "right" ? RIGHTUP : button == "middle" ? MIDDLEUP : LEFTUP;
    for (int n = 0; n < count; n++) { Mouse(down, 0); Mouse(up, 0); Thread.Sleep(70); }
  }
  public static void Drag(int x, int y, int toX, int toY) {
    Move(x, y); Thread.Sleep(40); Mouse(LEFTDOWN, 0);
    for (int s = 1; s <= 16; s++) { Move(x + (toX - x) * s / 16, y + (toY - y) * s / 16); Thread.Sleep(15); }
    Mouse(LEFTUP, 0);
  }
  public static void Scroll(int x, int y, int notches) { Move(x, y); Thread.Sleep(40); Mouse(WHEEL, -120 * notches); }
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { Key(0x0D, 0, 0); Key(0x0D, 0, KEYUP); }
      else { Key(0, c, UNICODE); Key(0, c, UNICODE | KEYUP); }
      Thread.Sleep(6);
    }
  }
  public static void Keys(int[] codes) {
    foreach (int vk in codes) Key((ushort)vk, 0, 0);
    for (int k = codes.Length - 1; k >= 0; k--) Key((ushort)codes[k], 0, KEYUP);
  }
  public static string Cursor() { POINT p; GetCursorPos(out p); return p.X + " " + p.Y; }
}
"@
[GraftInput]::Init()
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $reply = 'ok'
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.op) {
      'move' { [GraftInput]::Move([int]$c.x, [int]$c.y) }
      'click' { [GraftInput]::Click([int]$c.x, [int]$c.y, [string]$c.button, [int]$c.count) }
      'drag' { [GraftInput]::Drag([int]$c.x, [int]$c.y, [int]$c.toX, [int]$c.toY) }
      'scroll' { [GraftInput]::Scroll([int]$c.x, [int]$c.y, [int]$c.amount) }
      'type' { [GraftInput]::Type([string]$c.text) }
      'key' { [GraftInput]::Keys([int[]]$c.vks) }
      'cursor' { $reply = 'ok ' + [GraftInput]::Cursor() }
      default { $reply = 'err unknown command' }
    }
  } catch {
    $reply = 'err ' + ($_.Exception.Message -replace '\s+', ' ')
  }
  [Console]::Out.WriteLine($reply)
  [Console]::Out.Flush()
}
`;

export type InputCommand =
  | { op: 'move'; x: number; y: number }
  | { op: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: number }
  | { op: 'drag'; x: number; y: number; toX: number; toY: number }
  | { op: 'scroll'; x: number; y: number; amount: number }
  | { op: 'type'; text: string }
  | { op: 'key'; vks: number[] }
  | { op: 'cursor' };

const START_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 30_000;

export class WindowsInput {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waiting: Array<(line: string) => void> = [];
  private ready: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private start(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
      this.proc = proc;
      const timer = setTimeout(() => {
        reject(new Error('The input helper did not start in time.'));
        this.dispose();
      }, START_TIMEOUT_MS);
      let started = false;
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        if (!started) {
          if (line.trim() === 'ready') {
            started = true;
            clearTimeout(timer);
            resolve();
          }
          return;
        }
        this.waiting.shift()?.(line);
      });
      let errors = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        errors = (errors + chunk.toString('utf8')).slice(-2000);
      });
      proc.on('exit', () => {
        clearTimeout(timer);
        if (!started) reject(new Error(`The input helper stopped: ${errors.trim() || 'no output'}`));
        for (const settle of this.waiting.splice(0)) settle('err the input helper stopped');
        this.proc = null;
        this.ready = null;
      });
    });
    return this.ready;
  }

  /** Runs one command; commands run one at a time, in order. */
  run(command: InputCommand): Promise<string> {
    const next = this.chain.then(async () => {
      await this.start();
      const proc = this.proc;
      if (!proc) throw new Error('The input helper is not running.');
      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The input helper did not answer in time.')), COMMAND_TIMEOUT_MS);
        this.waiting.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
        proc.stdin.write(`${JSON.stringify(command)}\n`);
      });
      if (reply.startsWith('err')) throw new Error(reply.slice(4) || 'input failed');
      return reply.slice(3);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}
