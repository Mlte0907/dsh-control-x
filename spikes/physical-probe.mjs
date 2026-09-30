import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apply } from '../lib/index.js';
import { userIdleMs } from '../lib/desktop/physical.js';
const execFileAsync = promisify(execFile);
const registered = new Map();
apply({ tools:{register:t=>registered.set(t.name,t)}, get:()=>undefined, logger:{} }, { headless:true, physicalIdleMs:0 });
registered.get('x_activate').execute({},{signal:AbortSignal.timeout(10000)});
const call = async (n,a)=>registered.get(n).execute(a??{},{signal:AbortSignal.timeout(60000)});

const launched = await call('x_desktop_launch', { target: 'charmap.exe' });
console.log('launched pid:', launched.pid);
await new Promise(r=>setTimeout(r,2000));
const apps = await call('x_desktop_apps');
const mine = apps.windows.filter(w=>w.pid===launched.pid);
console.log('windows for launched pid:', JSON.stringify(mine));
const allCharmaps = apps.windows.filter(w=>/charmap/i.test(w.processName));
console.log('all charmap windows:', JSON.stringify(allCharmaps.map(w=>({pid:w.pid,hwnd:w.hwnd}))));
if (mine.length === 0) { console.log('FAIL: launched pid has no window'); process.exit(1); }
const hwnd = mine[0].hwnd;
const obs = await call('x_desktop_tree', { hwnd, max_elements: 300 });
const cb = obs.elements.find(e=>e.role==='CheckBox'&&e.patterns.includes('Toggle'));
console.log('checkbox:', cb.index, JSON.stringify(cb.name), 'state:', cb.toggleState);
const clicked = await call('x_desktop_mouse_click', { observation: obs.observation, element: cb.index, confirm_disturbance: true });
console.log('click result:', JSON.stringify(clicked));
const obs2 = await call('x_desktop_tree', { hwnd, max_elements: 300 });
const cb2 = obs2.elements.find(e=>e.index===cb.index);
console.log('after physical click: state =', cb2?.toggleState);
// 对照组：语义 Toggle
await call('x_desktop_press', { observation: obs2.observation, element: cb.index });
const obs3 = await call('x_desktop_tree', { hwnd, max_elements: 300 });
const cb3 = obs3.elements.find(e=>e.index===cb.index);
console.log('after semantic press: state =', cb3?.toggleState);
await execFileAsync('taskkill', ['/PID', String(launched.pid), '/F'], { windowsHide: true }).catch(()=>{});
console.log('done');
