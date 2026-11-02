import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectGroup } from './testflight.mjs';

const internal = { id: 'team', attributes: { name: 'Team', isInternalGroup: true } };
const external = { id: 'public', attributes: { name: 'Public', isInternalGroup: false } };

test('ordinary uploads do not distribute to a group', () => {
  assert.equal(selectGroup([internal, external], 'none'), undefined);
});
test('internal distribution cannot select an external group', () => {
  assert.equal(selectGroup([internal, external], 'internal'), internal);
  assert.throws(() => selectGroup([internal, external], 'internal', 'Public'));
});
test('external distribution selects only the existing external group', () => {
  assert.equal(selectGroup([internal, external], 'external'), external);
});
test('missing or ambiguous groups require an exact name', () => {
  assert.throws(() => selectGroup([], 'internal'));
  const other = { id: 'second', attributes: { name: 'Second', isInternalGroup: true } };
  assert.throws(() => selectGroup([internal, other], 'internal'));
  assert.equal(selectGroup([internal, other], 'internal', 'Second'), other);
});
test('unknown audiences cannot distribute', () => {
  assert.throws(() => selectGroup([internal, external], 'public'));
});
