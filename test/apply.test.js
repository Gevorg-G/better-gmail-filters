// Run: node --test
// applyToExisting against a fake Gmail: paging, batching, the cap and the messages it shows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(filter, total) {
  const calls = { list: [], modify: [] };
  const Gmail = {
    Users: {
      Settings: { Filters: { get: (_, id) => (filter && id === filter.id ? filter : (() => { throw new Error('404'); })()) } },
      Messages: {
        list: (_, o) => {
          calls.list.push(o);
          const start = o.pageToken ? Number(o.pageToken) : 0;
          const n = Math.min(o.maxResults, total - start);
          const next = start + n;
          return { messages: Array.from({ length: Math.max(0, n) }, (_, i) => ({ id: 'm' + (start + i) })), nextPageToken: next < total ? String(next) : undefined };
        },
        batchModify: (body) => calls.modify.push(body),
      },
    },
  };
  const ctx = vm.createContext({ Gmail });
  for (const f of ['filters.js', 'Code.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8'), ctx);
  return { ctx, calls };
}

const finances = { id: 'f1', criteria: { from: 'mail.anthropic.com' }, action: { addLabelIds: ['Label_7'], removeLabelIds: ['INBOX'] } };

test('applyToExisting relabels every match in batches of 1000', () => {
  const { ctx, calls } = setup(finances, 1200);
  assert.strictEqual(ctx.applyToExisting('f1'), 'Applied to 1,200 existing emails.');
  assert.strictEqual(calls.list[0].q, 'from:(mail.anthropic.com)');
  assert.deepStrictEqual(calls.modify.map((b) => b.ids.length), [1000, 200]);
  assert.deepStrictEqual(Array.from(calls.modify[0].addLabelIds), ['Label_7']);
  assert.deepStrictEqual(Array.from(calls.modify[0].removeLabelIds), ['INBOX']);
});

test('applyToExisting stops at the cap and says older ones were left', () => {
  const { ctx, calls } = setup(finances, 12000);
  assert.match(ctx.applyToExisting('f1'), /newest 5,000 .*Older ones were left/);
  assert.strictEqual(calls.modify.reduce((s, b) => s + b.ids.length, 0), 5000);
});

test('applyToExisting explains no matches, forward-only filters and missing filters', () => {
  assert.strictEqual(setup(finances, 0).ctx.applyToExisting('f1'), 'No existing email matches this filter.');
  const fwd = { id: 'f2', criteria: { from: 'a@x.com' }, action: { forward: 'b@y.com' } };
  assert.match(setup(fwd, 5).ctx.applyToExisting('f2'), /only forwards/);
  assert.throws(() => setup(finances, 5).ctx.applyToExisting('nope'), /no longer exists/);
});
