// 桌面窗口：后台启动本地服务，再用 Chrome 的应用模式开一个独立窗口（没有地址栏和标签页）。
// 没装 Chrome 就用默认浏览器打开。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { homeDir } from './config.ts';

const pidFile = () => join(homeDir(), 'server.pid');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 返回该端口上 Crew 服务的 pid（读 x-crew-pid 响应头）；连不上、状态不对、没有这个头都算没有
async function probe(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(800) });
    const pid = Number(res.headers.get('x-crew-pid'));
    return res.ok && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// pid 文件只记录已经确认在该端口提供 Crew 服务的进程
const recordServer = (pid: number, port: number) => writeFileSync(pidFile(), JSON.stringify({ pid, port }));

export async function startServer(port: number): Promise<'running' | 'started'> {
  mkdirSync(homeDir(), { recursive: true });
  const running = await probe(port);
  if (running) {
    recordServer(running, port); // 上次没确认的孤儿服务在这里补记，stop 才找得到它
    return 'running';
  }
  const log = openSync(join(homeDir(), 'server.log'), 'a');
  const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('./cli.ts', import.meta.url)), 'serve', '--port', String(port)], {
    detached: true, stdio: ['ignore', log, log], env: process.env,
  });
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.unref();
  // 每 200 毫秒试一次，10 秒还没起来就报错。这是启动超时，不是业务上的界限
  for (let i = 0; i < 50; i++) {
    const serving = await probe(port);
    if (serving === child.pid) {
      recordServer(serving, port);
      return 'started';
    }
    if (exited) {
      if (serving) return 'running'; // 子进程没抢到端口：别的 Crew 已经在服务，由它自己的记录负责
      break;
    }
    await sleep(200);
  }
  throw new Error(`本地服务没有起来，看日志：${join(homeDir(), 'server.log')}`);
}

export async function stopServer(): Promise<boolean> {
  if (!existsSync(pidFile())) return false;
  const { port } = JSON.parse(readFileSync(pidFile(), 'utf8'));
  const serving = await probe(port);
  rmSync(pidFile(), { force: true });
  if (serving === null) return false; // pid 文件过时：端口上没有 Crew 在答，不碰任何进程
  try {
    process.kill(serving); // 以端口上实际答话的 Crew 为准，不信文件里的 pid
    return true;
  } catch {
    return false; // 进程已经不在了
  }
}

const CHROME: Record<string, string[]> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  win32: [],
};

export function openWindow(url: string): string {
  const chrome = (CHROME[platform()] ?? []).find((p) => existsSync(p));
  if (chrome) {
    spawn(chrome, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
    return '独立窗口';
  }
  const opener = platform() === 'darwin' ? ['open', [url]] : platform() === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore' }).unref();
  return '默认浏览器';
}
