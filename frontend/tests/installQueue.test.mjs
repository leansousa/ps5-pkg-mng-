import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canQueuePackage, canQueueBrowserFile, queueOverview, orderBrowserFiles } from '../src/utils/installQueue.js';

const require = createRequire(import.meta.url);
async function component(path) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true,
    write: false, format: 'esm', platform: 'node', plugins: [{ name: 'shared-react', setup(builder) {
      builder.onResolve({ filter: /^react$/ }, () => ({ path: pathToFileURL(require.resolve('react')).href, external: true }));
    } }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default;
}
const [Header, Panel, Detail, Direct, QueueView] = await Promise.all([
  component('../src/components/layout/Header.jsx'), component('../src/components/layout/InstallQueuePanel.jsx'),
  component('../src/components/views/TitleDetailView.jsx'),
  component('../src/components/views/DirectInstallView.jsx'),
  component('../src/components/views/InstallQueueView.jsx'),
]);
const job = (id, state, extras = {}) => ({ id, state, order: id, path: `/game/${id}.pkg`, kind: 'base',
  title_name: `Package ${id}`, title_id: 'PPSA00001', total_bytes: 100, downloaded_bytes: 0, progress: 0, ...extras });
const queue = (jobs) => ({ jobs, overview: queueOverview(jobs), connected: true });
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('bulk browser ordering moves only required bases, preserving other package FIFO', () => {
  const base = { details: { title_id: 'A', pkg_type: 'base' } };
  const update = { details: { title_id: 'A', pkg_type: 'update' } };
  const other = { details: { title_id: 'B', pkg_type: 'base' } };
  assert.deepEqual(orderBrowserFiles([base, update, other]), [base, update, other]);
  assert.deepEqual(orderBrowserFiles([update, other, base]), [base, update, other]);
});

test('a new run does not inherit the previous run percentage', () => {
  const overview = queueOverview([job(1, 'completed', { total_bytes: 10000, run_id: 1 }), job(2, 'installing', { downloaded_bytes: 10, run_id: 2 })]);
  assert.equal(overview.percent, 10);
});

test('queue indicator counts active and pending jobs and links to the panel', () => {
  const html = render(Header, { queueOverview: queueOverview([job(1, 'installing', { downloaded_bytes: 50 }), job(2, 'queued')]), queueOpen: true });
  assert.match(html, /aria-controls="install-queue-panel"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, />2<\/span>/);
  assert.match(html, /25%/);
  assert.ok(html.indexOf('Rescan') < html.indexOf('Installs'), 'Installs follows the other navbar controls');
});

test('queue panel is a modal dialog and aborted jobs are finished without Retry', () => {
  const jobs = [job(1, 'aborted', { error: 'Installed version is same or newer' })];
  const overview = queueOverview(jobs);
  assert.equal(overview.pending.length, 0);
  assert.equal(overview.resolved, 1);
  const html = render(Panel, { queue: queue(jobs), onClose() {} });
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /data-modal-dialog="true"/);
  assert.match(html, />Aborted<\/p>/);
  assert.match(html, /Installed version is same or newer/);
  assert.doesNotMatch(html, /Retry|Remove from queue/);
});

test('PS5-managed installs show submission status without invented progress or cancellation', () => {
  const html = render(Panel, { queue: queue([job(1, 'submitted', { is_direct_storage: true, progress: -1 })]), onClose() {} });
  assert.match(html, /Submitted to PS5/);
  assert.match(html, /PS5 Notifications/);
  assert.doesNotMatch(html, /Cancel install|Remove from queue|role="progressbar"/);
});

test('each pending job can be removed while source failures retain Retry', () => {
  const html = render(Panel, { queue: queue([job(1, 'installing'), job(2, 'queued'), job(3, 'failed', { error: 'USB drive unavailable' })]), onClose() {} });
  assert.match(html, /Cancel install/);
  assert.match(html, /Remove from queue/);
  assert.match(html, /USB drive unavailable/);
  assert.match(html, /Retry/);
});

test('queue rows use local and console thumbnails without repeating the title in installation prompts', () => {
  const html = render(Panel, { queue: { ...queue([
    job(1, 'installing', { source_id: 'browser', file_key: 'local', path: 'live:upload', prompt: 'Installing Package 1...' }),
    job(2, 'queued'),
  ]), sourceId: 'browser', files: [{ id: 'local', iconUrl: 'blob:local-queue-cover' }] }, onClose() {} });
  assert.match(html, /src="blob:local-queue-cover"/);
  assert.match(html, /src="\/api\/icon\?path=%2Fgame%2F2.pkg"/);
  assert.doesNotMatch(html, /Installing Package 1|Preparing package|Waiting for the source browser/);
  assert.match(html, />Installing<\/p>/);
  const finishing = render(Panel, { queue: queue([job(1, 'installing', { prompt: 'Finishing installation of Package 1...' })]), onClose() {} });
  assert.match(finishing, />Finishing installation<\/p>/);
  assert.doesNotMatch(finishing, /Finishing installation of Package 1/);
});

test('waiting for multipart media is visible without claiming measurable progress', () => {
  const overview = queueOverview([job(1, 'installing', { waiting_for_disc: true })]);
  assert.equal(overview.percent, null);
  const html = render(Panel, { queue: queue([job(1, 'installing', { waiting_for_disc: true, prompt: 'Insert Disc 2' })]), onClose() {} });
  assert.match(html, /Waiting for next disc \/ USB part/);
  assert.match(html, /Insert Disc 2/);
});

test('pending base enables dependent enqueue but cannot override unrelated restrictions', () => {
  const pkg = { path: '/update.pkg', title_id: 'PPSA00001', can_install: false, install_disabled_reason: 'Base package is not installed' };
  assert.equal(canQueuePackage(pkg, []), false);
  assert.equal(canQueuePackage(pkg, [job(1, 'queued')]), true);
  assert.equal(canQueuePackage(pkg, [job(1, 'canceled')]), false);
  assert.equal(canQueuePackage({ ...pkg, install_disabled_reason: 'DLC is already installed' }, [job(1, 'queued')]), false);
  assert.equal(canQueuePackage({ ...pkg, can_install: true }, [job(1, 'queued', { path: '/update.pkg' })]), false);
});

const dlc = (id) => ({ path: `/dlc${id}.pkg`, title_name: `DLC ${id}`, title_id: 'PPSA00001',
  pkg_type: 'dlc', file_size: 100, can_install: false, install_disabled_reason: 'Base package is not installed' });
const detailProps = { title: { title_id: 'PPSA00001', title_name: 'Game', updates: [], dlcs: [dlc(1), dlc(2), dlc(3)], others: [] },
  settings: {}, selectedDrive: { id: '__all__' }, installerStatus: { is_installing: true } };

test('bulk DLC action requires multiple addable packages, including dependents of a queued base', () => {
  const jobs = [job(1, 'installing'), job(2, 'queued', { path: '/dlc1.pkg', kind: 'dlc' })];
  const html = render(Detail, { ...detailProps, installQueue: queue(jobs) });
  assert.match(html, /Queue all DLCs \(2\)/);
  assert.doesNotMatch(render(Detail, { ...detailProps, installQueue: queue([]) }), /all DLCs/);
  assert.doesNotMatch(render(Detail, { ...detailProps, title: { ...detailProps.title, dlcs: [dlc(1)] }, installQueue: queue([job(1, 'queued')]) }), /all DLCs/);
});

test('TitleDetailView renders file name and path for updates (#24)', () => {
  const upd1 = { path: '/usb0/updates/patch_v105_mod.pkg', filename: 'patch_v105_mod.pkg', app_version: '01.05', file_size: 1000, can_install: true };
  const upd2 = { path: '/usb0/updates/patch_v105_orig.pkg', filename: 'patch_v105_orig.pkg', app_version: '01.05', file_size: 1000, can_install: true };
  const html = render(Detail, { ...detailProps, title: { ...detailProps.title, updates: [upd1, upd2], dlcs: [] }, installQueue: queue([]) });
  assert.match(html, /patch_v105_mod\.pkg/);
  assert.match(html, /\/usb0\/updates\/patch_v105_mod\.pkg/);
  assert.match(html, /patch_v105_orig\.pkg/);
  assert.match(html, /\/usb0\/updates\/patch_v105_orig\.pkg/);
  assert.match(html, /<p class="truncate"><span class="text-zinc-300">patch_v105_mod\.pkg<\/span><\/p><p class="text-zinc-500 font-normal truncate mt-0.5">\(\/usb0\/updates\/patch_v105_mod\.pkg\)<\/p>/);
});

test('TitleDetailView renders file name, path, and other base packages (#27)', () => {
  const base1 = { path: 'smb://192.168.1.100/games/game_base_eu.pkg', filename: 'game_base_eu.pkg', app_version: '01.00', file_size: 2000, can_install: true };
  const base2 = { path: '/usb0/games/game_base_us.pkg', filename: 'game_base_us.pkg', app_version: '01.00', file_size: 2000, can_install: true };
  const html = render(Detail, { ...detailProps, title: { ...detailProps.title, base: base1, bases: [base1, base2], updates: [], dlcs: [] }, installQueue: queue([]) });
  assert.match(html, /game_base_eu\.pkg/);
  assert.match(html, /smb:\/\/192\.168\.1\.100\/games\/game_base_eu\.pkg/);
  assert.match(html, /<p class="truncate"><span class="text-zinc-500 font-sans mr-1">Base:<\/span><span class="text-zinc-300">game_base_eu\.pkg<\/span><\/p><p class="text-zinc-500 font-normal truncate mt-0.5">\(smb:\/\/192\.168\.1\.100\/games\/game_base_eu\.pkg\)<\/p>/);
  assert.match(html, /<\/div><div class="w-full min-w-0 text-xs font-mono text-zinc-400 mt-2"/);
  assert.match(html, /Other Base Packages/);
  assert.match(html, /game_base_us\.pkg/);
  assert.match(html, /\/usb0\/games\/game_base_us\.pkg/);
  assert.match(html, /<p class="truncate"><span class="text-zinc-300">game_base_us\.pkg<\/span><\/p><p class="text-zinc-500 font-normal truncate mt-0.5">\(\/usb0\/games\/game_base_us\.pkg\)<\/p>/);
});

test('TitleDetailView does not duplicate path on new line when filename and path are identical or filename missing', () => {
  const baseSame = { path: 'game_same.pkg', filename: 'game_same.pkg', app_version: '01.00', file_size: 2000, can_install: true };
  const updNoFilename = { path: '/usb0/updates/patch_v101.pkg', app_version: '01.01', file_size: 1000, can_install: true };
  const html = render(Detail, { ...detailProps, title: { ...detailProps.title, base: baseSame, bases: [baseSame], updates: [updNoFilename], dlcs: [] }, installQueue: queue([]) });
  assert.match(html, /game_same\.pkg/);
  assert.doesNotMatch(html, /\(game_same\.pkg\)/);
  assert.match(html, /\/usb0\/updates\/patch_v101\.pkg/);
  assert.doesNotMatch(html, /\(\/usb0\/updates\/patch_v101\.pkg\)/);
});

const local = (id, titleId, kind, iconUrl) => ({ id, status: 'ready', file: { name: `${id}.pkg`, size: 100 }, iconUrl,
  details: { title_name: 'Same game', title_id: titleId, pkg_type: kind, app_version: '1.00' } });

test('direct packages remain separate cards with local thumbnails and platform/type badges', () => {
  const html = render(Direct, { queue: { ...queue([]), sourceId: 'browser', skipped: [],
    files: [local('base', 'CUSA00001', 'base', 'blob:local-cover'), local('update', 'CUSA00001', 'update'), local('dlc', 'PPSA00002', 'dlc')] } });
  assert.equal((html.match(/<article/g) || []).length, 3);
  assert.match(html, /src="blob:local-cover"/);
  assert.match(html, />PS4<\/span>/);
  assert.match(html, />PS5<\/span>/);
  assert.match(html, />update<\/span>/);
  assert.match(html, />dlc<\/span>/);
});

test('Clear files is disabled when every local source is still needed by the queue', () => {
  const props = { queue: { ...queue([job(1, 'installing', { file_key: 'base', source_id: 'browser' }), job(2, 'blocked', { file_key: 'dlc', source_id: 'browser' })]),
    sourceId: 'browser', skipped: [], files: [local('base', 'PPSA00001', 'base'), local('dlc', 'PPSA00001', 'dlc')] } };
  assert.match(render(Direct, props), /<button[^>]*disabled=""[^>]*>Clear files<\/button>/);
  assert.doesNotMatch(render(Direct, { queue: { ...props.queue, files: [...props.queue.files, local('spare', 'CUSA00002', 'base')] } }), /<button[^>]*disabled=""[^>]*>Clear files<\/button>/);
});

test('Direct Install excludes redundant versions and installed DLC from individual and bulk queue actions', () => {
  const files = [local('base', 'CUSA00001', 'base'), local('update', 'CUSA00001', 'update'), local('dlc', 'PPSA00002', 'dlc')];
  files.forEach((file) => { file.eligibility = { can_install: false, install_disabled_reason: file.id === 'dlc' ? 'DLC is already installed' : 'Installed version is same or newer' }; });
  for (const file of files) assert.equal(canQueueBrowserFile(file, [job(1, 'queued', { title_id: file.details.title_id })], 'browser', files), false);
  const html = render(Direct, { queue: { ...queue([]), sourceId: 'browser', skipped: [], files } });
  assert.match(html, /<button[^>]*disabled=""[^>]*>Queue all \(0\)<\/button>/);
  assert.equal((html.match(/<button[^>]*disabled=""[^>]*>Queue<\/button>/g) || []).length, 3);
  assert.match(html, /Not installable/);
});

test('a browser update or DLC requires an installed/queued base or an eligible base selected in the same bulk action', () => {
  const base = local('base', 'PPSA00001', 'base');
  base.eligibility = { can_install: true };
  const update = local('update', 'PPSA00001', 'update');
  update.eligibility = { can_install: false, install_disabled_reason: 'Base package is not installed' };
  assert.equal(canQueueBrowserFile(update, [], 'browser'), false);
  assert.equal(canQueueBrowserFile(update, [], 'browser', [update, base]), true);
  assert.equal(canQueueBrowserFile(update, [job(1, 'queued')], 'browser'), true);
  base.eligibility = { can_install: false, install_disabled_reason: 'Leftovers detected on console' };
  assert.equal(canQueueBrowserFile(update, [], 'browser', [update, base]), false);
});

test('InstallQueueView implements Option A layout with active install hero and total queue progress underneath', () => {
  const jobs = [
    job(1, 'installing', { downloaded_bytes: 40, total_bytes: 100, progress: 40, run_id: 1 }),
    job(2, 'queued', { total_bytes: 100, run_id: 1 }),
  ];
  const q = { ...queue(jobs), installSpeed: 10 * 1024 * 1024 };
  const html = render(QueueView, { queue: q, onBack() {} });
  // Option A structure:
  // Back button and breadcrumbs
  assert.match(html, /Back<\/span>/);
  assert.match(html, /PKG Manager/);
  assert.match(html, /Install Queue/);
  // Active Hero section (left column)
  assert.match(html, /Package 1/);
  assert.match(html, /Current item progress/);
  assert.match(html, /40\.0% · 40 B \/ 100 B/);
  // Total queue progress bar directly underneath current item progress bar (when >1 jobs)
  assert.match(html, /Total queue progress/);
  assert.match(html, /Overall queue progress/);
  // Queue list items (right column)
  assert.match(html, /Queue Items/);
  assert.match(html, /Package 2/);
  // Cancel and remove actions
  assert.match(html, /Cancel install/);
  assert.match(html, /Remove from queue/);
});

test('InstallQueueView renders empty standby state when queue has no jobs', () => {
  const html = render(QueueView, { queue: queue([]), onBack() {} });
  assert.match(html, /Install Queue is Empty/);
  assert.match(html, /Browse Packages/);
});

test('InstallQueueView with a single job only renders current item progress without duplicate total queue bar', () => {
  const jobs = [job(1, 'installing', { downloaded_bytes: 50, total_bytes: 100, progress: 50, run_id: 1 })];
  const html = render(QueueView, { queue: queue(jobs), onBack() {} });
  assert.match(html, /Current item progress/);
  assert.doesNotMatch(html, /Total queue progress/);
});

test('InstallQueueView shows Clear finished entries button when completed/aborted jobs exist', () => {
  const jobs = [job(1, 'completed'), job(2, 'aborted', { error: 'Installed version is same or newer' })];
  const html = render(QueueView, { queue: queue(jobs), onBack() {} });
  assert.match(html, /Clear finished entries/);
});
