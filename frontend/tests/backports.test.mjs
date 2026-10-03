import assert from 'node:assert/strict';
import { getBackportTitleId, getLinkedBackports } from '../src/utils/backports.js';

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

console.log('backports: filename detection, matching base, and source isolation passed');
