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
  'remove:INBOX': 'Skip inbox',
  'remove:UNREAD': 'Mark read',
  'add:STARRED': 'Star',
  'remove:SPAM': 'Never spam',
  'add:IMPORTANT': 'Mark important',
  'remove:IMPORTANT': 'Never important',
  'add:TRASH': 'Delete',
  'add:CATEGORY_PERSONAL': 'Primary tab',
  'add:CATEGORY_SOCIAL': 'Social tab',
  'add:CATEGORY_PROMOTIONS': 'Promotions tab',
  'add:CATEGORY_UPDATES': 'Updates tab',
  'add:CATEGORY_FORUMS': 'Forums tab',
};

/** "(*@a.com | b@c.com OR d@e.com)" -> ["@a.com", "b@c.com", "d@e.com"] */
function splitAlternatives(value) {
  return String(value)
    .replace(/^\s*\((.*)\)\s*$/, '$1')
    .split(/\s*(?:\||\bOR\b)\s*/)
    .map((s) => s.trim().replace(/^\*@/, '@'))
    .filter(Boolean);
}

/** [{name, values}] for each criterion the filter uses. */
function filterCriteria(filter) {
  const c = filter.criteria || {};
  const out = [];
  if (c.from) out.push({ name: 'From', values: splitAlternatives(c.from) });
  if (c.to) out.push({ name: 'To', values: splitAlternatives(c.to) });
  if (c.subject) out.push({ name: 'Subject', values: [c.subject] });
  if (c.query) out.push({ name: 'Has', values: splitAlternatives(c.query) });
  if (c.negatedQuery) out.push({ name: "Doesn't have", values: splitAlternatives(c.negatedQuery) });
  if (c.hasAttachment) out.push({ name: 'Has attachment', values: [] });
  return out;
}

/** Plain-language actions, e.g. ["Work", "Skip inbox"]. User labels show by name. */
function filterActions(filter, labelNames) {
  const a = filter.action || {};
  const out = [];
  (a.addLabelIds || []).forEach((id) => out.push(SYSTEM_ACTION_TEXT['add:' + id] || labelNames[id] || id));
  (a.removeLabelIds || []).forEach((id) => out.push(SYSTEM_ACTION_TEXT['remove:' + id] || 'Remove ' + (labelNames[id] || id)));
  if (a.forward) out.push('Forward to ' + a.forward);
  return out;
}

const shorten = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** Two short lines for a list row: what happens (title) and what it matches (subtitle). */
function summarizeFilter(filter, labelNames) {
  const when = filterCriteria(filter).map((c) => {
    if (!c.values.length) return c.name;
    const shown = c.values.slice(0, 2).map((v) => shorten(v, 40)).join(', ');
    return c.name + ': ' + shown + (c.values.length > 2 ? ' +' + (c.values.length - 2) + ' more' : '');
  });
  return {
    title: filterActions(filter, labelNames).join(' · ') || 'No action',
    subtitle: when.join(' · ') || 'Any email',
  };
}
