import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendAll, keepChildren, replaceAll} from '../dom.js';

/** A stand-in node that records what it was given. */
function fakeNode() {
  return {
    got: null,
    append(...xs) {
      this.got = [...(this.got ?? []), ...xs];
    },
    replaceChildren(...xs) {
      this.got = xs;
    },
  };
}

const NODE = {kind: 'node'};

test('keepChildren drops null, undefined and false, flattening arrays', () => {
  assert.deepEqual(
    keepChildren([null, 'a', undefined, [false, NODE, ['b', null]], 0, '']),
    ['a', NODE, 'b', 0, ''],
  );
  assert.deepEqual(keepChildren([]), []);
});

test('appendAll skips null, undefined and false and keeps strings and nodes', () => {
  const n = fakeNode();
  appendAll(n, 'x', null, [NODE, undefined], false);
  assert.deepEqual(n.got, ['x', NODE]);
});

test('replaceAll skips null, undefined and false and keeps strings and nodes', () => {
  const n = fakeNode();
  // The "Next live message uses:" line: label, text, then an optional note.
  replaceAll(n, NODE, 'the deployed policy, unchanged', null);
  assert.deepEqual(n.got, [NODE, 'the deployed policy, unchanged']);
  replaceAll(n);
  assert.deepEqual(n.got, []);
});
