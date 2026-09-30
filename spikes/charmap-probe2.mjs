import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apply } from '../lib/index.js';
const execFileAsync = promisify(execFile);
const registered = new Map();
apply({ tools:{register:(t)=>registered.set(t.name,t)}, get:()=>undefined, logger:{} }, { headless:true });
const call = async (n,a)=>registered.get(n).execute(a??{},{signal:AbortSignal.timeout(60000)});
const launched = await call('x_desktop_launch', { target: 'charmap.exe' });
await new Promise(r=>setTimeout(r,2000));
const apps = await call('x_desktop_apps');
const mine = apps.windows.filter(w => w.pid === launched.pid);
console.log('windows for pid:', JSON.stringify(mine));
const hwnd = mine[0].hwnd;
const obs = await call('x_desktop_tree', { hwnd });
console.log('elements:', obs.elements.length);
for (const e of obs.elements.slice(0, 8)) {
  console.log(`#${e.index} ${e.role} "${(e.name??'').slice(0,20)}" patterns=${JSON.stringify(e.patterns)} enabled=${e.enabled} pw=${e.isPassword}`);
}
await execFileAsync('taskkill', ['/PID', String(launched.pid), '/F'], { windowsHide: true });
console.log('cleaned');
