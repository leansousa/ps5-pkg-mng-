// Real-browser smoke test without third-party browser test dependencies.
// Requires Chrome (or CHROME_BIN) and a built frontend. The server/profile are
// private to this test and are shut down even when an assertion fails.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const profile = await mkdtemp(path.join(tmpdir(), 'pkg-queue-browser-'));
const mock = spawn(process.execPath, ['frontend/mock-server.js'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PKG_MOCK_CANCEL_DELAY_MS: '1000' } });
let mockLog = '';
mock.stdout.on('data', (chunk) => { mockLog += chunk; }); mock.stderr.on('data', (chunk) => { mockLog += chunk; });
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
], { stdio: 'ignore' });
const pending = new Map();
const exceptions = [];
let socket, serial = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await pause(100); }
  throw new Error(`Timed out: ${label}\n${mockLog}`);
}
function command(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const button = (text) => evaluate(`(() => { const scope = document.querySelector('[data-modal-dialog="true"]') || document; const button = [...scope.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}) && !b.matches(':disabled')); if (!button) return false; button.click(); return true; })()`);
const text = () => evaluate('document.body.innerText');
const jobs = async () => (await (await fetch('http://localhost:8844/api/queue')).json()).jobs;
const backgroundEnabled = () => evaluate(`!document.querySelector('#install-queue-panel') && document.getElementById('app-main-content')?.disabled === false`);
async function closeQueue() {
  await evaluate(`document.querySelector('[aria-label="Close install queue"]').click()`);
  await wait(backgroundEnabled, 'queue closed and background restored');
}
async function pressKey(key, modifiers = 0) {
  const windowsVirtualKeyCode = key === 'Tab' ? 9 : 27;
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, modifiers });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, modifiers });
}

try {
  await wait(async () => { try { return (await fetch('http://localhost:8844/api/version')).ok; } catch { return false; } }, 'mock ready');
  let debugPort;
  await wait(async () => { try { debugPort = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return !!debugPort; } catch { return false; } }, 'Chrome ready');
  const target = await (await fetch(`http://localhost:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const handler = pending.get(data.id); pending.delete(data.id);
      if (data.error) handler.reject(new Error(JSON.stringify(data.error))); else handler.resolve(data.result);
    }
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails);
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  await command('Page.enable'); await command('Runtime.enable');
  await command('Page.bringToFront');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: 'http://localhost:8844/#/drive/usb0' });
  await wait(async () => (await text()).includes('Astraea:'), 'catalog');
  await evaluate(`(() => { const heading = [...document.querySelectorAll('h3')].find((h) => h.textContent.includes('Astraea:')); heading.closest('.ps5-focus-item').click(); })()`);
  await wait(async () => (await text()).includes('Base + Update'), 'title detail');
  assert.equal(await button('Base + Update'), true);
  await wait(async () => (await jobs()).length === 2, 'base/update queue');
  assert.equal(await button('Installs'), true);
  await wait(async () => (await text()).includes('Remove from queue'), 'queue panel');
  assert.equal(await evaluate(`(() => { const row = [...document.querySelectorAll('#install-queue-panel article')].find((a) => a.textContent.includes('update')); const b = [...(row?.querySelectorAll('button') || [])].find((b) => b.textContent.includes('Remove')); b?.click(); return !!b; })()`), true);
  await wait(async () => (await jobs()).some((job) => job.kind === 'update' && job.state === 'canceled'), 'remove update only');
  await wait(async () => (await jobs()).find((job) => job.kind === 'base')?.state === 'installing', 'base still runs after update removal');
  await closeQueue();
  assert.equal(await button('all DLCs'), true);
  await wait(async () => (await jobs()).filter((job) => job.kind === 'dlc').length >= 2, 'bulk DLC enqueue');
  await command('Page.reload');
  await wait(async () => (await text()).includes('Installs'), 'reload reconnect');
  assert.equal(await evaluate(`document.querySelector('header button:last-child')?.getAttribute('aria-controls') === 'install-queue-panel'`), true, 'Installs is the rightmost navbar button');
  await evaluate(`(() => {
    document.querySelector('[aria-controls="install-queue-panel"]').focus();
    const background = document.getElementById('app-main-content');
    for (const id of ['smoke-changing-control', 'smoke-disabled-control']) {
      const control = document.createElement('button'); control.id = id; control.disabled = true; control.tabIndex = 7; background.append(control);
    }
    window.smokeBackgroundClicks = 0;
    background.addEventListener('click', () => { window.smokeBackgroundClicks++; });
  })()`);
  assert.equal(await button('Installs'), true);
  await wait(async () => (await text()).includes('Install queue'), 'persistent queue panel');
  await wait(async () => evaluate(`document.activeElement?.getAttribute('aria-label') === 'Close install queue'`), 'controller focus enters queue');
  assert.equal(await evaluate(`(() => { const background = document.getElementById('app-main-content'); return background.disabled && background.hasAttribute('inert') && background.getAttribute('aria-hidden') === 'true' && [...background.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].every((control) => control.getAttribute('tabindex') === '-1'); })()`), true, 'background controls are excluded from spatial navigation');
  await evaluate(`(() => {
    const control = document.getElementById('smoke-changing-control'); control.disabled = false; control.tabIndex = 0;
    const added = document.createElement('button'); added.id = 'smoke-added-control'; document.getElementById('app-main-content').append(added);
  })()`);
  await wait(async () => evaluate(`['smoke-changing-control', 'smoke-added-control'].every((id) => { const control = document.getElementById(id); return control.disabled && control.tabIndex === -1; })`), 'background re-renders stay disabled');
  await evaluate(`(() => { const outside = document.createElement('button'); outside.id = 'smoke-outside-focus'; document.body.append(outside); outside.focus(); })()`);
  await wait(async () => evaluate(`document.querySelector('#install-queue-panel').contains(document.activeElement)`), 'focus guard redirects navigation back into queue', 2000);
  await evaluate(`document.getElementById('smoke-outside-focus').remove(); document.querySelector('[aria-label="Close install queue"]').focus()`);
  await pressKey('Tab', 8);
  assert.equal(await evaluate(`document.activeElement.textContent === 'Clear finished entries'`), true, 'reverse Tab wraps inside queue');
  for (let i = 0; i < 12; i++) {
    await pressKey('Tab');
    assert.equal(await evaluate(`document.querySelector('#install-queue-panel').contains(document.activeElement)`), true, 'Tab stays inside queue');
  }
  await wait(async () => evaluate(`[...document.querySelectorAll('#install-queue-panel img')].some((image) => image.src.includes('/api/icon?') && image.naturalWidth > 0)`), 'console package thumbnails in queue');
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(tmpdir(), 'pkg-queue-ui.png'), Buffer.from(screenshot.data, 'base64'));
  const routeBeforeOutsideClick = await evaluate('window.location.hash');
  const clicksBeforeOutside = await evaluate('window.smokeBackgroundClicks');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 160, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 160, button: 'left', clickCount: 1 });
  await wait(backgroundEnabled, 'outside click closes queue');
  assert.equal(await evaluate('window.smokeBackgroundClicks'), clicksBeforeOutside, 'outside click never reaches background');
  assert.equal(await evaluate('window.location.hash'), routeBeforeOutsideClick);
  assert.equal(await evaluate(`document.activeElement?.getAttribute('aria-controls') === 'install-queue-panel' && !document.getElementById('smoke-changing-control').disabled && document.getElementById('smoke-changing-control').tabIndex === 0 && document.getElementById('smoke-disabled-control').disabled && document.getElementById('smoke-disabled-control').tabIndex === 7 && !document.getElementById('smoke-added-control').disabled && document.body.style.overflow !== 'hidden'`), true, 'closing restores intended control states, focus and scrolling');
  await evaluate(`['smoke-changing-control', 'smoke-disabled-control', 'smoke-added-control'].forEach((id) => document.getElementById(id).remove())`);
  assert.equal(await button('Installs'), true);
  await wait(async () => evaluate(`!!document.querySelector('#install-queue-panel')`), 'reopen for controller Back');
  await evaluate('window.history.back()');
  await wait(backgroundEnabled, 'controller Back closes queue');
  assert.equal(await evaluate('window.location.hash'), routeBeforeOutsideClick, 'controller Back keeps the current view');
  assert.equal(await button('Installs'), true);
  await wait(async () => evaluate(`!!document.querySelector('#install-queue-panel')`), 'reopen for Escape');
  await pressKey('Escape');
  await wait(backgroundEnabled, 'Escape closes queue');
  await command('Page.navigate', { url: 'http://localhost:8844/#/direct-install' });
  await wait(async () => (await text()).includes('Choose packages'), 'direct install view');
  await evaluate(`(() => {
    window.smokeCreated = []; window.smokeRevoked = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); window.smokeCreated.push(url); return url; };
    URL.revokeObjectURL = (url) => { window.smokeRevoked.push(url); revoke(url); };
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      if (url === '/api/upload/check' && window.smokeAllowedOnce === JSON.parse(options.body).title_id) {
        window.smokeAllowedOnce = '';
        return new Response(JSON.stringify({ can_install: true }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/upload/check' && window.smokeNewerOnCheck === JSON.parse(options.body).title_id) {
        window.smokeNewerOnCheck = '';
        return new Response(JSON.stringify({ can_install: false, install_disabled_reason: 'Installed version is same or newer' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/queue' && options?.method !== 'POST' && window.smokeFailPolls) throw new Error('Simulated lost queue status response');
      if ((url === '/api/upload/check' && window.smokeDelayCheck) || (url === '/api/queue' && options?.method === 'POST' && window.smokeDelayAdmission)) {
        if (url === '/api/upload/check') window.smokeDelayCheck = false;
        else { window.smokeDelayAdmission = false; window.smokeFailPolls = true; }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      const response = await fetchOriginal(url, options);
      if (url === '/api/queue' && options?.method === 'POST') {
        window.smokeAdmitted = true;
        window.smokeOwner = JSON.parse(options.body).jobs[0].owner;
      }
      return response;
    };
    window.smokeSelect = (packages) => {
      const transfer = new DataTransfer();
      for (const [id, title, category, version = '1.00'] of packages) {
        const bytes = new Uint8Array(0x140000), view = new DataView(bytes.buffer), encode = new TextEncoder();
        bytes.set([0x7f, 0x43, 0x4e, 0x54], 0); view.setUint32(0x10, 2, false); view.setUint32(0x18, 0x100, false);
        bytes.set(encode.encode('UP0000-' + id + '_00-1234567890123456'), 0x40);
        const json = encode.encode(JSON.stringify({ titleId: id, titleName: title, category, appVersion: version }));
        view.setUint32(0x100, 0x2000, false); view.setUint32(0x110, 0x120000, false); view.setUint32(0x114, json.length, false); bytes.set(json, 0x120000);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d');
        context.fillStyle = category === 'gd' ? '#264b86' : category === 'gp' ? '#563482' : '#17594c'; context.fillRect(0, 0, 256, 256);
        context.fillStyle = '#ffffff'; context.font = 'bold 28px sans-serif'; context.fillText('LOCAL PKG', 36, 120);
        context.font = '18px sans-serif'; context.fillText(id, 64, 155);
        const icon = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (character) => character.charCodeAt(0));
        view.setUint32(0x120, 0x1200, false); view.setUint32(0x130, 0x130000, false); view.setUint32(0x134, icon.length, false); bytes.set(icon, 0x130000);
        transfer.items.add(new File([bytes], id + '-' + category + '-' + version + '.pkg', { lastModified: 1 }));
      }
      window.smokeSelectedKeys = [...transfer.files].map((file) => [file.name, file.size, file.lastModified].join('|'));
      const input = document.querySelector('input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.smokeSelect([['PPSA99101', 'Browser Smoke', 'gd'], ['CUSA99102', 'Local PS4 Update', 'gp'], ['PPSA99103', 'Local PS5 DLC', 'ac']]);
  })()`);
  await wait(async () => evaluate(`document.querySelectorAll('[aria-label="Selected packages"] img').length === 3 && [...document.querySelectorAll('[aria-label="Selected packages"] img')].every((image) => image.naturalWidth === 256)`), 'local package thumbnails');
  assert.equal(await evaluate(`(() => { const grid = document.querySelector('[aria-label="Selected packages"]'); return getComputedStyle(grid).display === 'grid' && grid.querySelectorAll('article').length === 3 && grid.textContent.includes('PS4') && grid.textContent.includes('PS5') && grid.textContent.includes('update') && grid.textContent.includes('dlc'); })()`), true);
  const directScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(tmpdir(), 'pkg-direct-grid.png'), Buffer.from(directScreenshot.data, 'base64'));
  const removedIcon = await evaluate(`(() => { const card = [...document.querySelectorAll('[aria-label="Selected packages"] article')].find((card) => card.textContent.includes('Local PS4 Update')); const url = card.querySelector('img').src; [...card.querySelectorAll('button')].find((button) => button.textContent === 'Remove file').click(); return url; })()`);
  await wait(async () => evaluate(`window.smokeRevoked.includes(${JSON.stringify(removedIcon)})`), 'removed thumbnail released');
  assert.equal(await button('Clear files'), true);
  await wait(async () => evaluate(`document.querySelectorAll('[aria-label="Selected packages"] article').length === 0 && window.smokeRevoked.length === 3`), 'clear releases remaining thumbnails');
  const jobsBeforeRejection = (await jobs()).length;
  await evaluate(`window.smokeSelect([['PPSA01003', 'Same installed base', 'gd', '1.00'], ['PPSA01003', 'Older installed update', 'gp', '0.50']]);`);
  await wait(async () => evaluate(`(() => { const cards = [...document.querySelectorAll('[aria-label="Selected packages"] article')]; return cards.length === 2 && cards.every((card) => card.innerText.includes('Installed version is same or newer') && [...card.querySelectorAll('button')].find((button) => button.textContent === 'Queue')?.disabled); })()`), 'same/newer installed versions cannot be queued');
  assert.equal(await button('Queue all'), false, 'bulk action excludes installed versions');
  assert.equal((await jobs()).length, jobsBeforeRejection);
  assert.equal(await button('Clear files'), true);
  await wait(async () => evaluate(`document.querySelectorAll('[aria-label="Selected packages"] article').length === 0`), 'clear rejected packages');
  await evaluate(`window.smokeSelect([['PPSA99200', 'Became installed after selection', 'gd']]);`);
  await wait(async () => (await text()).includes('Queue all (1)'), 'initially eligible package');
  await evaluate(`window.smokeNewerOnCheck = 'PPSA99200'`);
  assert.equal(await button('Queue all'), true);
  await wait(async () => (await text()).includes('Installed version is same or newer') && (await text()).includes('Queue all (0)'), 'fresh eligibility check prevents stale admission');
  assert.equal((await jobs()).length, jobsBeforeRejection, 'changed eligibility does not create a blocked queue job');
  assert.equal(await button('Clear files'), true);
  await wait(async () => evaluate(`document.querySelectorAll('[aria-label="Selected packages"] article').length === 0`), 'clear stale eligibility fixture');
  await evaluate('window.smokeIconBaseline = window.smokeCreated.length');
  // Clear and immediately reselect the same file while its old metadata check is pending.
  await evaluate(`window.smokeDelayCheck = true; window.smokeSelect([['PPSA99101', 'Browser Smoke', 'gd']]);`);
  await wait(async () => evaluate('window.smokeCreated.length === window.smokeIconBaseline + 1'), 'thumbnail created during inspection');
  assert.equal(await button('Clear files'), true);
  await evaluate(`window.smokeSelect([['PPSA99101', 'Browser Smoke', 'gd']]);`);
  await wait(async () => (await text()).includes('Queue all (1)'), 'reselected file ready');
  await pause(800);
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Selected packages"] article').length === 1 && window.smokeCreated.length === window.smokeIconBaseline + 2 && window.smokeRevoked.length === window.smokeIconBaseline + 1 && document.querySelector('[aria-label="Selected packages"] img').naturalWidth === 256`), true, 'late inspection does not restore cleared files or revoke the new thumbnail');
  await evaluate('window.smokeDelayAdmission = true');
  assert.equal(await button('Queue all'), true);
  assert.equal(await button('Clear files'), true);
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Selected packages"] article').length`), 1, 'admission in flight retains its source file');
  await wait(async () => evaluate('window.smokeAdmitted === true'), 'queue admission response');
  await pause(200);
  assert.equal(await button('Clear files'), true);
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Selected packages"] article').length`), 1, 'accepted source survives lost status responses');
  await evaluate('window.smokeFailPolls = false');
  await wait(async () => (await jobs()).some((job) => job.title_name === 'Browser Smoke' && job.state === 'installing'), 'backend-selected browser upload', 25000);
  assert.equal(await button('Open install queue'), true);
  await wait(async () => evaluate(`(() => { const row = [...document.querySelectorAll('#install-queue-panel article')].find((row) => row.querySelector('h3')?.textContent === 'Browser Smoke'); const image = row?.querySelector('img'); return image?.src.startsWith('blob:') && image.naturalWidth === 256 && row.innerText.includes('Installing') && row.innerText.split('Browser Smoke').length === 2 && !row.innerText.includes('Installing package'); })()`), 'queue uses local thumbnail and concise install status');
  const browserQueueScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(tmpdir(), 'pkg-queue-with-browser.png'), Buffer.from(browserQueueScreenshot.data, 'base64'));
  await closeQueue();
  assert.equal(await button('Back'), true);
  await wait(async () => !(await text()).includes('Choose packages'), 'navigate while uploading');
  await wait(async () => (await jobs()).some((job) => job.title_name === 'Browser Smoke' && job.state === 'completed'), 'browser upload completes in background');
  await command('Page.navigate', { url: 'http://localhost:8844/#/direct-install' });
  await wait(async () => (await text()).includes('Choose packages'), 'second direct run');
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const number of [2, 3]) {
      const bytes = new Uint8Array(0x140000), view = new DataView(bytes.buffer), encode = new TextEncoder();
      const id = 'PPSA9910' + number;
      bytes.set([0x7f, 0x43, 0x4e, 0x54], 0); view.setUint32(0x10, 1, false); view.setUint32(0x18, 0x100, false);
      bytes.set(encode.encode('UP0000-' + id + '_00-1234567890123456'), 0x40);
      const json = encode.encode(JSON.stringify({ titleId: id, titleName: 'Browser Retry ' + number, category: 'gd', appVersion: '1.00' }));
      view.setUint32(0x100, 0x2000, false); view.setUint32(0x110, 0x120000, false); view.setUint32(0x114, json.length, false); bytes.set(json, 0x120000);
      transfer.items.add(new File([bytes], 'browser-retry-' + number + '.pkg'));
    }
    const input = document.querySelector('input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await wait(async () => (await text()).includes('Browser Retry 3'), 'two browser files');
  assert.equal(await button('Queue all'), true);
  await wait(async () => (await jobs()).some((job) => job.title_name === 'Browser Retry 2' && job.state === 'installing'), 'first retry upload');
  assert.equal(await button('Clear files'), true);
  await wait(async () => evaluate(`document.querySelectorAll('[aria-label="Selected packages"] article').length === 2`), 'clear keeps active and queued sources');
  assert.equal((await jobs()).find((job) => job.title_name === 'Browser Retry 3').state, 'queued');
  assert.equal(await button('Open install queue'), true);
  await wait(async () => evaluate(`!![...(document.querySelectorAll('#install-queue-panel button'))].find((button) => button.textContent.includes('Cancel install') && !button.disabled)`), 'cancel browser control');
  assert.equal(await button('Cancel install'), true);
  await wait(async () => (await jobs()).some((job) => job.title_name === 'Browser Retry 2' && job.state === 'canceled'), 'browser canceled');
  await wait(async () => (await jobs()).some((job) => job.title_name === 'Browser Retry 3' && job.state === 'completed'), 'next upload survives delayed cancellation', 20000);
  await closeQueue();
  await wait(async () => evaluate(`(() => { const card = [...document.querySelectorAll('[aria-label="Selected packages"] article')].find((card) => card.querySelector('h3')?.textContent === 'Browser Retry 3'); return card?.innerText.includes('Installed'); })()`), 'completed browser status reaches local cards');
  assert.equal(await button('Clear files'), true);
  await wait(async () => evaluate(`document.querySelectorAll('[aria-label="Selected packages"] article').length === 0`), 'clear completed/canceled browser fixtures');
  // Simulate admission before installed state was known, with its file still in this tab.
  await evaluate(`window.smokeAllowedOnce = 'PPSA01003'; window.smokeSelect([['PPSA01003', 'Redundant queued package', 'gd']]);`);
  await wait(async () => (await text()).includes('Queue all (1)'), 'initially eligible redundant fixture');
  const owner = await evaluate('window.smokeOwner');
  const fileKey = await evaluate('window.smokeSelectedKeys[0]');
  assert.equal(typeof owner, 'string', 'source owner captured from admission');
  assert.equal(typeof fileKey, 'string', 'file key captured before the input is cleared');
  const redundant = await (await fetch('http://localhost:8844/api/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobs: [{ owner, file_key: fileKey, title_id: 'PPSA01003', title_name: 'Redundant queued package', kind: 'base', version: '1.00', total_bytes: 0x140000 }] }) })).json();
  await wait(async () => (await jobs()).find((job) => job.id === redundant.ids[0])?.state === 'aborted', 'redundant queued package aborts rather than blocks');
  await wait(async () => evaluate(`(() => { const card = [...document.querySelectorAll('[aria-label="Selected packages"] article')].find((card) => card.querySelector('h3')?.textContent === 'Redundant queued package'); return card?.innerText.includes('Aborted') && [...card.querySelectorAll('button')].find((button) => button.textContent === 'Queue')?.disabled; })()`), 'aborted outcome updates local eligibility');
  assert.equal(await button('Open install queue'), true);
  await wait(async () => evaluate(`(() => { const row = [...document.querySelectorAll('#install-queue-panel article')].find((row) => row.querySelector('h3')?.textContent === 'Redundant queued package'); return row?.innerText.includes('Aborted') && row.innerText.includes('Installed version is same or newer') && !row.innerText.includes('Retry'); })()`), 'aborted is displayed as a finished outcome');
  await closeQueue();
  assert.deepEqual(exceptions, [], 'No browser runtime errors');
  console.log('Browser smoke passed: modal focus containment and restoration, outside click/Back/Escape dismissal, rightmost navbar button, installed-version rejection and fresh eligibility checks, redundant-job abortion, thumbnails and badges, source retention, cancellation, bulk DLC, reload and background uploads.');
  console.log(`Screenshot: ${path.join(tmpdir(), 'pkg-queue-ui.png')}`);
  console.log(`Direct Install screenshot: ${path.join(tmpdir(), 'pkg-direct-grid.png')}`);
  console.log(`Queue with browser package screenshot: ${path.join(tmpdir(), 'pkg-queue-with-browser.png')}`);
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    console.error('Browser body:', await text().catch(() => '<unavailable>'));
    console.error('Runtime exceptions:', JSON.stringify(exceptions));
    console.error('Focus:', await evaluate(`({ hasFocus: document.hasFocus(), activeTag: document.activeElement?.tagName, activeId: document.activeElement?.id, activeLabel: document.activeElement?.getAttribute('aria-controls'), modal: document.querySelector('[data-modal-dialog="true"]')?.id, closeDisabled: document.querySelector('[aria-label="Close install queue"]')?.disabled, backgroundDisabled: document.getElementById('app-main-content')?.disabled, changing: document.getElementById('smoke-changing-control')?.outerHTML, disabled: document.getElementById('smoke-disabled-control')?.outerHTML, added: document.getElementById('smoke-added-control')?.outerHTML, overflow: document.body.style.overflow })`).catch(() => '<unavailable>'));
  }
  throw error;
} finally {
  socket?.close(); chrome.kill('SIGTERM'); mock.kill('SIGTERM');
  const exited = (child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
  await Promise.all([exited(chrome), exited(mock)]);
  await rm(profile, { recursive: true, force: true });
}
