// Pure filter logic: no Google services here, so it runs under `node --test`.

// shortcut: Gmail doesn't document an exact criteria limit; 1,500 is a conservative guess. Gmail's own error still gets shown if it's lower.
const MAX_CRITERIA_CHARS = 1500;
const MAX_FILTERS = 1000;

const ACTIONS = {
  skipInbox: { title: 'Skip the inbox', remove: 'INBOX' },
  markRead: { title: 'Mark as read', remove: 'UNREAD' },
  star: { title: 'Star it', add: 'STARRED' },
  neverSpam: { title: 'Never send to spam', remove: 'SPAM' },
};

/** "Jane <jane@x.com>" -> "jane@x.com" */
function parseAddress(from) {
  const m = /<([^>]+)>/.exec(from || '');
  return (m ? m[1] : from || '').trim().toLowerCase();
}

function senderDomain(address) {
  return address.split('@')[1] || '';
}

/** Returns a user-facing message, or null when the spec can become a filter. */
function filterError(spec) {
  if (!spec.from && !spec.subject) return 'Fill in From or Subject so the filter matches something.';
  if (!spec.label && spec.actions.length === 0) return 'Pick a label or at least one action.';
  if (spec.from.length + spec.subject.length > MAX_CRITERIA_CHARS) {
    return 'The criteria are too long for a Gmail filter. Shorten From or Subject.';
  }
  return null;
}

/** spec: {from, subject, actions: string[]}, labelId: string|null -> Gmail Filter resource */
function buildFilter(spec, labelId) {
  const criteria = {};
  if (spec.from) criteria.from = spec.from;
  if (spec.subject) criteria.subject = spec.subject;
  const add = labelId ? [labelId] : [];
  const remove = [];
  spec.actions.forEach((key) => {
    const a = ACTIONS[key];
    if (a.add) add.push(a.add);
    if (a.remove) remove.push(a.remove);
  });
  const action = {};
  if (add.length) action.addLabelIds = add;
  if (remove.length) action.removeLabelIds = remove;
  return { criteria, action };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort();
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((o, k) => ((o[k] = canonical(value[k])), o), {});
  }
  return value;
}

function sameFilter(a, b) {
  const pick = (f) => JSON.stringify(canonical({ c: f.criteria || {}, a: f.action || {} }));
  return pick(a) === pick(b);
}

const SYSTEM_ACTION_TEXT = {
  'remove:INBOX': 'skip inbox',
  'remove:UNREAD': 'mark read',
  'add:STARRED': 'star',
  'remove:SPAM': 'never spam',
  'add:IMPORTANT': 'mark important',
  'remove:IMPORTANT': 'never important',
  'add:TRASH': 'delete',
};

/** Plain-language one-liner, e.g. "From: a@b.com → label Work, skip inbox" */
function describeFilter(filter, labelNames) {
  const c = filter.criteria || {};
  const when = [];
  if (c.from) when.push('From: ' + c.from);
  if (c.to) when.push('To: ' + c.to);
  if (c.subject) when.push('Subject: ' + c.subject);
  if (c.query) when.push('Has: ' + c.query);
  if (c.negatedQuery) when.push("Doesn't have: " + c.negatedQuery);
  if (c.hasAttachment) when.push('Has attachment');

  const a = filter.action || {};
  const then = [];
  (a.addLabelIds || []).forEach((id) => {
    then.push(SYSTEM_ACTION_TEXT['add:' + id] || 'label ' + (labelNames[id] || id));
  });
  (a.removeLabelIds || []).forEach((id) => {
    then.push(SYSTEM_ACTION_TEXT['remove:' + id] || 'remove label ' + (labelNames[id] || id));
  });
  if (a.forward) then.push('forward to ' + a.forward);

  return (when.join(', ') || 'Any email') + ' → ' + (then.join(', ') || 'no action');
}
