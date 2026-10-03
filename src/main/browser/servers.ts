import net from 'node:net';

/** Ports dev servers usually take (Next, Vite, Astro, Angular, Django, Rails, Jupyter…). */
export const DEV_PORTS = [3000, 3001, 4173, 4200, 4321, 5000, 5173, 5174, 8000, 8080, 8888];

/** Whether something accepts connections on a port of this computer. */
export function portOpen(port: number, host: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Dev servers running on this computer. Both loopbacks are tried: Node resolves
 * "localhost" to ::1 first on many systems, so Vite and friends often listen
 * there only.
 */
export async function localServers(ports: number[] = DEV_PORTS): Promise<Array<{ url: string; port: number }>> {
  const open = await Promise.all(ports.map(async (port) => ((await portOpen(port, '127.0.0.1')) || (await portOpen(port, '::1')) ? port : null)));
  return open.filter((p): p is number => p !== null).map((port) => ({ url: `http://localhost:${port}`, port }));
}
