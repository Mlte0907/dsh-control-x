import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { apply } from '../lib/index.js';
const execFileAsync = promisify(execFile);
const registered = new Map();
apply({ tools:{register:(t)=>registered.set(t.name,t)}, get:()=>undefined, logger:{} }, { headless:true });
const call = async (n,a)=>registered.get(n).execute(a??{},{signal:AbortSignal.timeout(60000)});
const launched = await call('x_desktop_launch', { target: 'charmap.exe' });
await new Promise(r=>setTimeout(r,2000));
const obs = await call('x_desktop_tree', { pid: launched.pid });
console.log('window:', JSON.stringify(obs.window));
const interesting = obs.elements.filter(e => e.patterns.length > 0 || e.isPassword);
console.log(`elements with patterns: ${interesting.length}/${obs.elements.length}`);
for (const e of interesting.slice(0, 25)) {
  console.log(`#${e.index} ${e.role} "${(e.name??'').slice(0,20)}" patterns=[${e.patterns}] value=${JSON.stringify((e.value??'').slice(0,15))}`);
}
console.log('--- roles census ---');
const roles = {};
for (const e of obs.elements) roles[e.role] = (roles[e.role]??0)+1;
console.log(JSON.stringify(roles));
await execFileAsync('taskkill', ['/PID', String(launched.pid), '/F'], { windowsHide: true });
console.log('cleaned');
