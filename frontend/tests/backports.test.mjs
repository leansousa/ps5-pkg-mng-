import assert from 'node:assert/strict';
import {
  getBackportTitleId,
  getLinkedBackports,
  isBackportInstalled,
  markBackportInstalled
} from '../src/utils/backports.js';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) || null,
  setItem: (key, value) => storage.set(key, value)
};

const base = {
  filename: 'PPSA05144.pkg',
  path: '/mnt/usb0/PPSA05144.pkg',
  title_id: 'PPSA05144',
  pkg_type: 'base'
};
const backport = {
  filename: 'PPSA05144-backport.pkg',
  path: '/mnt/usb0/PPSA05144-backport.pkg',
  title_id: 'PPSA05144',
  pkg_type: 'backport'
};

assert.equal(getBackportTitleId(backport), 'PPSA05144');
assert.equal(getBackportTitleId({ filename: 'PPSA05144.pkg' }), null);
assert.equal(getBackportTitleId({ filename: 'CUSA05144-backport.pkg' }), null);

const packages = [base, backport];
assert.deepEqual(getLinkedBackports(packages, packages, []), [{ pkg: backport, base }]);
assert.deepEqual(getLinkedBackports(packages, [backport], []), [{ pkg: backport, base }]);
assert.deepEqual(getLinkedBackports([backport], [backport], []), []);
assert.deepEqual(getLinkedBackports(
  [base, { ...backport, path: '/mnt/usb1/PPSA05144-backport.pkg' }],
  [base, backport],
  []
), []);

assert.equal(isBackportInstalled(backport), false);
assert.equal(markBackportInstalled(backport), true);
assert.equal(isBackportInstalled(backport), true);
assert.equal(isBackportInstalled({ ...backport, file_size: 1 }), false);

console.log('backports: filename detection, association, installation state, and source isolation passed');
