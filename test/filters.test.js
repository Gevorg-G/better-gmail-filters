// Run: node --test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Apps Script files share one global scope; emulate that with a vm context.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/filters.js'), 'utf8'), ctx);

test('parseAddress handles display names and bare addresses', () => {
  assert.strictEqual(ctx.parseAddress('Jane Doe <Jane@Example.com>'), 'jane@example.com');
  assert.strictEqual(ctx.parseAddress('bob@x.org'), 'bob@x.org');
  assert.strictEqual(ctx.senderDomain('bob@x.org'), 'x.org');
});

test('filterError requires criteria and an action', () => {
  const err = (spec, label) => ctx.filterError(ctx.buildFilter({ actions: [], ...spec }, label || null));
  assert.match(err({ from: '', subject: '' }, 'L'), /at least one condition/);
  assert.match(err({ from: 'a@b' }), /label or/);
  assert.match(err({ from: 'x'.repeat(1501) }, 'L'), /too long/);
  assert.strictEqual(err({ from: 'a@b', actions: ['star'] }), null);
});

test('applyEdits keeps what the form does not show', () => {
  const old = {
    id: 'f1',
    criteria: { from: 'a@x.com', query: 'invoice', hasAttachment: true },
    action: { addLabelIds: ['Label_1', 'CATEGORY_UPDATES', 'Label_2', 'STARRED'], removeLabelIds: ['INBOX'], forward: 'me@y.com' },
  };
  const values = ctx.formValues(old, { Label_1: 'Work' });
  assert.strictEqual(values.label, 'Work');
  assert.deepStrictEqual([...values.actions].sort(), ['skipInbox', 'star']);

  // Change the sender and the label, untick star, tick mark read.
  const next = ctx.applyEdits(old, { ...values, from: '@x.com', actions: ['skipInbox', 'markRead'] }, 'Label_3');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(next)), {
    criteria: { from: '@x.com', query: 'invoice', hasAttachment: true },
    action: { addLabelIds: ['Label_3', 'CATEGORY_UPDATES', 'Label_2'], removeLabelIds: ['INBOX', 'UNREAD'], forward: 'me@y.com' },
  });

  // Saving the form unchanged gives back the same filter.
  assert.ok(ctx.sameFilter(old, ctx.applyEdits(old, values, 'Label_1')));
});

test('buildFilter maps actions to Gmail label changes', () => {
  const f = ctx.buildFilter({ from: '@x.org', subject: '', actions: ['skipInbox', 'star', 'neverSpam'] }, 'Label_1');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(f)), {
    criteria: { from: '@x.org' },
    action: { addLabelIds: ['Label_1', 'STARRED'], removeLabelIds: ['INBOX', 'SPAM'] },
  });
});

test('sameFilter ignores id and array order', () => {
  const a = { id: '1', criteria: { from: 'a' }, action: { removeLabelIds: ['INBOX', 'UNREAD'] } };
  const b = { criteria: { from: 'a' }, action: { removeLabelIds: ['UNREAD', 'INBOX'] } };
  assert.ok(ctx.sameFilter(a, b));
  assert.ok(!ctx.sameFilter(a, { criteria: { from: 'b' }, action: b.action }));
});

test('summarizeFilter reads like plain language', () => {
  const f = { criteria: { from: 'a@b.com' }, action: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } };
  assert.deepStrictEqual({ ...ctx.summarizeFilter(f, { Label_1: 'Work' }) }, {
    title: 'Work · Skip inbox',
    subtitle: 'From: a@b.com',
  });
});

test('summarizeFilter shortens long real-world filters', () => {
  const f = {
    criteria: { from: '*@a.com | x@b.com | *@c.com | d@e.com', query: '(@w.com | @wc.com)' },
    action: { addLabelIds: ['Label_9', 'CATEGORY_UPDATES'], removeLabelIds: ['SPAM'] },
  };
  assert.deepStrictEqual({ ...ctx.summarizeFilter(f, { Label_9: 'Reading/PM' }) }, {
    title: 'Reading/PM · Updates tab · Never spam',
    subtitle: 'From: @a.com, x@b.com +2 more · Has: @w.com, @wc.com',
  });
  assert.deepStrictEqual([...ctx.splitAlternatives('a@x.com OR b@y.com')], ['a@x.com', 'b@y.com']);
});
