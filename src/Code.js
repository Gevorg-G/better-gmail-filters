// Card UI and Gmail API calls. Pure logic lives in filters.js; the popup pages live in manager.html.

const PAGE_SIZE = 20; // keeps each section well under the 100-widget card limit

// ScriptApp.getService().getUrl() returns an ID that 404s when called from the add-on, so the URL is set here.
// shortcut: this is the HEAD deployment's /dev URL (latest pushed code, editors only); switch to a versioned /exec URL when publishing.
const FULL_VIEW_URL = 'https://script.google.com/macros/s/AKfycbxi1gHaR5HU1UcOxmZWDXMKOePCxFp0MR1WYV0Aaek/dev';

// Text criteria besides From that the forms can edit.
const OTHER_FIELDS = {
  subject: 'And the subject contains',
  to: 'To',
  query: 'Has the words',
  negatedQuery: "Doesn't have",
};


// ---------- The filter form (create, new, edit) ----------
// Cards keep no state between clicks, so every action carries `ctx`: the senders so far and how to redraw the form.
// Typed values (subject, label, checkboxes) come back in formInputs and are redrawn as they were.

// Free mail providers: "anyone at gmail.com" is almost never what you want, so these default to the address.
const FREE_MAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'mail.ru', 'inbox.ru', 'bk.ru', 'list.ru', 'yandex.ru', 'ya.ru'];

/** With an email open: add its sender to an existing filter in one tap. New filters are created in the popup. */
function onGmailMessage(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  const msg = GmailApp.getMessageById(e.gmail.messageId);
  const from = msg.getFrom();
  const address = parseAddress(from);
  const domain = senderDomain(address);
  return quickCard({
    address: address,
    domain: domain,
    name: (from.split('<')[0] || '').replace(/"/g, '').trim() || address,
    subject: msg.getSubject() || '',
    mode: domain && FREE_MAIL.indexOf(domain) === -1 ? 'domain' : 'address',
    added: null,
  });
}

const quickSender = (ctx) => (ctx.mode === 'domain' ? '@' + ctx.domain : ctx.address);
const inDomain = (address, d) => senderDomain(address) === d || senderDomain(address).endsWith('.' + d);

/** Does any sender in the list match this address? A domain covers its subdomains, as in Gmail. */
function sendersCover(senders, address) {
  return senders.some((s) => (isDomainSender(s) ? inDomain(address, s.slice(1)) : s === address));
}

/** Filters already catching this email, and filters it could be added to (ranked). */
function quickGroups(ctx) {
  const covered = [];
  const candidates = [];
  listFilters().forEach((f) => {
    const c = f.criteria || {};
    const senders = sendersFromCriteria(c.from);
    // Only filters with a sender list can take a new sender: adding one to a subject-only filter would narrow it.
    if (!senders || senders.length === 0) return;
    const terms = subjectTerms(c.subject);
    const subjectOk = !c.subject || (terms && terms.some((t) => t.split(/\s+/).every((w) => ctx.subject.toLowerCase().indexOf(w.toLowerCase()) !== -1)));
    const otherCriteria = c.to || c.query || c.negatedQuery || c.hasAttachment || c.size;
    if (sendersCover(senders, ctx.address) && subjectOk && !otherCriteria) covered.push(f);
    else if (!sendersCover(senders, ctx.address)) {
      const sameDomain = senders.some((s) => (isDomainSender(s) ? ctx.domain.endsWith(s.slice(1)) : senderDomain(s) === ctx.domain));
      candidates.push({ f: f, score: (sameDomain ? 1000 : 0) + senders.length, sameDomain: sameDomain, count: senders.length });
    }
  });
  candidates.sort((a, b) => b.score - a.score);
  return { covered: covered, candidates: candidates };
}

function quickCard(ctx, note) {
  const names = labelNames();
  const g = quickGroups(ctx);
  const title = (f) => summarizeFilter(f, names).title;
  const card = CardService.newCardBuilder().setHeader(
    CardService.newCardHeader()
      .setTitle(g.covered.length ? 'This sender is already filtered' : 'Add this sender to a filter')
      .setSubtitle(ctx.name + ' · ' + ctx.address)
  );

  if (g.covered.length) {
    const s = CardService.newCardSection().setHeader('Matched by');
    g.covered.forEach((f) =>
      s.addWidget(
        CardService.newDecoratedText().setStartIcon(icon(filterIcon(f))).setText(escapeHtml(title(f)))
          .setBottomLabel(escapeHtml(summarizeFilter(f, names).subtitle)).setWrapText(true)
          .setButton(overlayButton('Open', popupUrl({ view: 'edit', id: f.id })))
      )
    );
    card.addSection(s);
  }

  const what = CardService.newChipList().setLayout(CardService.ChipListLayout.WRAPPED);
  [['address', 'This address', 'person'], ['domain', 'Anyone at ' + ctx.domain, 'domain']].forEach(([mode, text, ic]) => {
    if (mode === 'domain' && !ctx.domain) return;
    what.addChip(
      CardService.newChip().setLabel((ctx.mode === mode ? '✓ ' : '') + text).setIcon(icon(ic))
        .setOnClickAction(quickAction('onQuickMode', ctx, { mode: mode }))
    );
  });
  card.addSection(CardService.newCardSection().setHeader('What to add').addWidget(what));

  const sugg = CardService.newCardSection().setHeader(g.covered.length ? 'Add it to another filter' : 'Suggested filters');
  g.candidates.slice(0, 3).forEach((x) => {
    const justAdded = ctx.added && ctx.added.id === x.f.id;
    sugg.addWidget(
      CardService.newDecoratedText().setStartIcon(icon(filterIcon(x.f))).setText(escapeHtml(title(x.f)))
        .setBottomLabel(x.sameDomain ? 'Already has a sender at ' + ctx.domain : 'Has ' + x.count + (x.count === 1 ? ' sender' : ' senders'))
        .setWrapText(true)
        .setButton(
          justAdded
            ? CardService.newTextButton().setText('Undo').setOnClickAction(quickAction('onQuickUndo', ctx))
            : CardService.newTextButton().setText('Add').setOnClickAction(quickAction('onQuickAdd', ctx, { id: x.f.id }))
        )
    );
  });
  if (ctx.added && !g.candidates.slice(0, 3).some((x) => x.f.id === ctx.added.id)) {
    // The filter just added to now covers this sender, so it left the suggestions: keep Undo reachable.
    sugg.addWidget(
      CardService.newDecoratedText().setStartIcon(icon('check_circle')).setText('Added to ' + escapeHtml(ctx.added.title))
        .setButton(CardService.newTextButton().setText('Undo').setOnClickAction(quickAction('onQuickUndo', ctx)))
    );
  }
  if (g.candidates.length > 3) {
    const other = CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN).setFieldName('other').setTitle('Another filter');
    g.candidates.slice(3).forEach((x, i) => other.addItem(title(x.f), x.f.id, i === 0));
    sugg.addWidget(other).addWidget(CardService.newTextButton().setText('Add').setOnClickAction(quickAction('onQuickAddOther', ctx)));
  }
  if (!g.candidates.length) sugg.addWidget(CardService.newTextParagraph().setText('<font color="#444746">No other filter takes a sender list yet. Create a new one below.</font>'));
  card.addSection(sugg);

  card.setFixedFooter(
    CardService.newFixedFooter()
      .setPrimaryButton(overlayButton('New filter', popupUrl({ view: 'new', from: quickSender(ctx), subject: ctx.subject }), true))
      .setSecondaryButton(overlayButton('All filters', popupUrl({})))
  );
  const nav = CardService.newNavigation().updateCard(card.build());
  const res = CardService.newActionResponseBuilder().setNavigation(nav);
  if (note) res.setNotification(CardService.newNotification().setText(note));
  return note === undefined ? card.build() : res.build();
}

function quickAction(fn, ctx, extra) {
  return CardService.newAction().setFunctionName(fn).setParameters(Object.assign({ ctx: JSON.stringify(ctx) }, extra || {}));
}

function onQuickMode(e) {
  const p = e.commonEventObject.parameters;
  const ctx = JSON.parse(p.ctx);
  ctx.mode = p.mode;
  return quickCard(ctx, null);
}

function quickAddTo(ctx, id) {
  const f = getFilter(id);
  if (!f) return quickCard(ctx, 'This filter no longer exists.');
  const senders = sendersFromCriteria((f.criteria || {}).from);
  if (!senders) return quickCard(ctx, "This filter's sender rule uses search syntax. Edit it in the popup.");
  const add = quickSender(ctx);
  // Adding a domain makes addresses at that domain redundant; they're dropped so the list stays clean.
  const next = senders.filter((s) => !(isDomainSender(add) && !isDomainSender(s) && inDomain(s, add.slice(1)))).concat([add]);
  try {
    const r = saveFilter(id, { senders: next });
    const t = summarizeFilter(f, labelNames()).title;
    ctx.added = { id: r.id, title: t, prevFrom: f.criteria.from };
    return quickCard(ctx, 'Added ' + senderLabel(add) + ' to ' + t + '. It applies to new email.');
  } catch (err) {
    return quickCard(ctx, err.message);
  }
}

function onQuickAdd(e) {
  const p = e.commonEventObject.parameters;
  return quickAddTo(JSON.parse(p.ctx), p.id);
}

function onQuickAddOther(e) {
  const inputs = e.commonEventObject.formInputs || {};
  const id = inputs.other ? inputs.other.stringInputs.value[0] : '';
  const ctx = JSON.parse(e.commonEventObject.parameters.ctx);
  return id ? quickAddTo(ctx, id) : quickCard(ctx, 'Pick a filter first.');
}

function onQuickUndo(e) {
  const ctx = JSON.parse(e.commonEventObject.parameters.ctx);
  try {
    saveFilter(ctx.added.id, { from: ctx.added.prevFrom });
    ctx.added = null;
    return quickCard(ctx, 'Undone. The filter is back to how it was.');
  } catch (err) {
    return quickCard(ctx, err.message);
  }
}

/**
 * Creates a filter, or replaces filter `id` (Gmail can't update filters in place).
 * spec.senders / spec.subjectTerms (arrays), when given, become the From / Subject criteria.
 * A spec without `label` keeps the filter's current label. Returns {message, id} of the saved filter.
 * The new version is created before the old one is deleted, so a failure never loses a filter.
 * Throws an Error whose message is safe to show the user.
 */
function saveFilter(id, spec) {
  const existing = listFilters();
  const base = id ? existing.find((f) => f.id === id) : {};
  if (!base) throw new Error('This filter no longer exists. Reload to refresh the list.');
  if (existing.length >= MAX_FILTERS) {
    throw new Error(
      id
        ? 'Gmail is at its 1,000-filter limit, and saving a change needs one free slot. Delete another filter first.'
        : 'Gmail allows 1,000 filters and you have reached it. Delete one first.'
    );
  }
  spec = Object.assign({}, spec);
  if (Array.isArray(spec.senders)) {
    spec.from = sendersToFrom(spec.senders, base.criteria && base.criteria.from);
    delete spec.senders;
  }
  if (Array.isArray(spec.subjectTerms)) {
    spec.subject = termsToSubject(spec.subjectTerms, base.criteria && base.criteria.subject);
    delete spec.subjectTerms;
  }
  // No label in the spec means "leave the label alone" (quick add only changes senders).
  const keptLabelId = spec.label === undefined ? ((base.action && base.action.addLabelIds) || []).find(isUserLabel) || null : undefined;

  // Check with a placeholder label first, so an invalid or duplicate filter never creates a new label.
  const label = spec.label ? findLabel(spec.label) : null;
  const draft = applyEdits(base, spec, keptLabelId !== undefined ? keptLabelId : spec.label ? (label ? label.id : 'Label_new') : null);
  const problem = filterError(draft);
  if (problem) throw new Error(problem);
  if (id && sameFilter(base, draft)) return { message: 'Nothing changed.', id: id };
  if ((!spec.label || label) && existing.some((f) => f.id !== id && sameFilter(f, draft))) {
    throw new Error('You already have this exact filter.');
  }

  let created;
  try {
    const labelId = keptLabelId !== undefined ? keptLabelId : spec.label ? (label || createLabel(spec.label)).id : null;
    created = Gmail.Users.Settings.Filters.create(applyEdits(base, spec, labelId), 'me');
  } catch (err) {
    throw new Error("Gmail didn't accept this filter: " + err.message);
  }
  if (!id) return { message: 'Filter created. It applies to new email.', id: created.id };
  try {
    Gmail.Users.Settings.Filters.remove('me', id);
  } catch (err) {
    throw new Error('The new version is saved, but the old one could not be removed. Delete the old one by hand.');
  }
  return { message: 'Filter updated.', id: created.id };
}

/** The parts of a filter the forms don't edit, in words. They're kept as they are on save. */
function keptParts(filter, names) {
  const c = filter.criteria || {};
  const a = filter.action || {};
  const otherCriteria = Object.keys(c)
    .filter((k) => EDITABLE_CRITERIA.indexOf(k) === -1)
    .reduce((o, k) => ((o[k] = c[k]), o), {});
  const managed = Object.keys(ACTIONS).map((k) => ACTIONS[k].add || ACTIONS[k].remove);
  const userLabel = (a.addLabelIds || []).find(isUserLabel);
  return {
    criteria: filterCriteria({ criteria: otherCriteria }).map((x) => x.name + (x.values.length ? ': ' + x.values.join(', ') : '')),
    actions: filterActions(
      {
        action: {
          addLabelIds: (a.addLabelIds || []).filter((x) => x !== userLabel && managed.indexOf(x) === -1),
          removeLabelIds: (a.removeLabelIds || []).filter((x) => managed.indexOf(x) === -1),
          forward: a.forward,
        },
      },
      names
    ),
  };
}

// ---------- Homepage: list, view and delete filters ----------

function onHomepage() {
  return filterListCard(0);
}

function labelNames() {
  const names = {};
  userLabels().forEach((l) => (names[l.id] = l.name));
  return names;
}

// Card text accepts a small HTML subset, so user-written filter text must be escaped.
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function filterListCard(page) {
  const names = labelNames();
  // Sorting by destination puts filters that file mail to the same place next to each other.
  const filters = listFilters()
    .map((f) => ({ id: f.id, icon: filterIcon(f), summary: summarizeFilter(f, names) }))
    .sort((a, b) => a.summary.title.localeCompare(b.summary.title));

  const pages = Math.max(1, Math.ceil(filters.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = filters.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const section = CardService.newCardSection();
  if (filters.length === 0) {
    section.addWidget(decorated('filter_alt', '', 'No filters yet. Create one, or open an email to start from it.'));
  }
  slice.forEach((f, i) => {
    if (i > 0) section.addWidget(CardService.newDivider());
    section.addWidget(
      CardService.newDecoratedText()
        .setStartIcon(icon(f.icon))
        .setEndIcon(icon('chevron_right'))
        .setText(escapeHtml(f.summary.title))
        .setBottomLabel(escapeHtml(f.summary.subtitle))
        .setWrapText(true)
        .setOnClickAction(CardService.newAction().setFunctionName('onOpenFilter').setParameters({ id: f.id }))
    );
  });

  const card = CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader()
        .setTitle('Your filters')
        .setSubtitle(filters.length + ' of ' + MAX_FILTERS + (pages > 1 ? ' · page ' + (page + 1) + ' of ' + pages : ''))
    )
    .addSection(section);

  if (pages > 1) {
    const nav = CardService.newButtonSet();
    if (page > 0) nav.addButton(pageButton('Previous', page - 1));
    if (page < pages - 1) nav.addButton(pageButton('Next', page + 1));
    card.addSection(CardService.newCardSection().addWidget(nav));
  }

  card.setFixedFooter(
    CardService.newFixedFooter()
      .setPrimaryButton(overlayButton('New filter', popupUrl({ view: 'new' }), true))
      .setSecondaryButton(overlayButton('Full view', popupUrl({})))
  );
  return card.build();
}

function pageButton(text, page) {
  return CardService.newTextButton()
    .setText(text)
    .setOnClickAction(CardService.newAction().setFunctionName('onPage').setParameters({ page: String(page) }));
}

function onPage(e) {
  const card = filterListCard(Number(e.commonEventObject.parameters.page));
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(card))
    .build();
}

function getFilter(id) {
  try {
    return Gmail.Users.Settings.Filters.get('me', id);
  } catch (err) {
    return null;
  }
}

function onOpenFilter(e) {
  const id = e.commonEventObject.parameters.id;
  const filter = getFilter(id);
  if (!filter) return notify('This filter no longer exists. Reload the add-on to refresh the list.');
  const names = labelNames();
  const summary = summarizeFilter(filter, names);
  const c = filter.criteria || {};
  const senders = sendersFromCriteria(c.from);

  const when = CardService.newCardSection().setHeader('When an email matches');
  if (senders && senders.length) {
    const chips = CardService.newChipList().setLayout(CardService.ChipListLayout.WRAPPED);
    senders.forEach((s) => chips.addChip(CardService.newChip().setLabel(isDomainSender(s) ? s.slice(1) : s).setIcon(icon(isDomainSender(s) ? 'domain' : 'person'))));
    when.addWidget(CardService.newTextParagraph().setText('<font color="#444746">From any of these · ' + senders.length + '</font>')).addWidget(chips);
  }
  const icons = { From: 'person', To: 'alternate_email', Subject: 'subject', Has: 'search', "Doesn't have": 'search_off' };
  filterCriteria(filter)
    .filter((x) => !(x.name === 'From' && senders))
    .forEach((x) => when.addWidget(decorated(icons[x.name] || 'attach_file', x.name, x.values.map(escapeHtml).join('<br>') || 'Yes')));

  const then = CardService.newCardSection().setHeader('Then');
  filterActions(filter, names).forEach((a) => then.addWidget(decorated('arrow_forward', '', escapeHtml(a))));

  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(summary.title).setSubtitle('Filter'))
    .addSection(when)
    .addSection(then)
    .setFixedFooter(
      CardService.newFixedFooter()
        .setPrimaryButton(overlayButton('Edit', popupUrl({ view: 'edit', id: id }), true))
        .setSecondaryButton(
          CardService.newTextButton()
            .setText('Delete')
            .setOnClickAction(
              CardService.newAction().setFunctionName('onDeleteFilter').setParameters({ id: id, text: summary.title + '\n' + summary.subtitle })
            )
        )
    )
    .build();
  return pushCard(card);
}

function onDeleteFilter(e) {
  const p = e.commonEventObject.parameters;
  const confirm = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Delete this filter?'))
    .addSection(
      CardService.newCardSection().addWidget(
        CardService.newTextParagraph().setText(escapeHtml(p.text).replace('\n', '<br>') + "<br><br>This can't be undone.")
      )
    )
    .setFixedFooter(
      CardService.newFixedFooter()
        .setPrimaryButton(
          filledButton('Delete', CardService.newAction().setFunctionName('onConfirmDelete').setParameters({ id: p.id })).setBackgroundColor('#b3261e')
        )
        .setSecondaryButton(CardService.newTextButton().setText('Cancel').setOnClickAction(CardService.newAction().setFunctionName('onCancel')))
    )
    .build();
  return pushCard(confirm);
}

function onConfirmDelete(e) {
  try {
    Gmail.Users.Settings.Filters.remove('me', e.commonEventObject.parameters.id);
  } catch (err) {
    return notify('Could not delete the filter: ' + err.message);
  }
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popToRoot().updateCard(filterListCard(0)))
    .setNotification(CardService.newNotification().setText('Filter deleted.'))
    .build();
}

function onCancel() {
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().popCard()).build();
}

// ---------- Popup pages (manager.html, opened as an overlay) ----------

function doGet() {
  const page = HtmlService.createTemplateFromFile('manager');
  page.shared = sharedSource();
  return page.evaluate().setTitle('Better Gmail Filters').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** The sender parsing code, sent to the popup page so the tag input there works instantly with the same rules. */
function sharedSource() {
  return [parseAddress, senderDomain, splitAlternatives, isDomainSender, senderLabel, normalizeSender, parseSenders, subjectTerms]
    .map(String)
    .join('\n');
}

/** Popup URL for a view: {} = all filters, {view:'edit', id}, {view:'new', from:'a@x.com,@y.com'}. */
function popupUrl(params) {
  const query = Object.keys(params)
    .filter((k) => params[k])
    .map((k) => k + '=' + encodeURIComponent(params[k]))
    .join('&');
  return FULL_VIEW_URL + (query ? '?' + query : '');
}

/** Everything the popup needs in one call. */
function managerData() {
  const names = labelNames();
  return {
    labels: Object.keys(names).map((id) => names[id]).sort(),
    actions: Object.keys(ACTIONS).map((k) => ({ key: k, title: ACTIONS[k].title })),
    fields: OTHER_FIELDS,
    filters: listFilters().map((f) => {
      const senders = sendersFromCriteria((f.criteria || {}).from);
      return {
        id: f.id,
        icon: filterIcon(f),
        summary: summarizeFilter(f, names),
        senders: senders,
        subjectTerms: subjectTerms((f.criteria || {}).subject),
        criteria: filterCriteria(f).filter((x) => !(x.name === 'From' && senders) && !(x.name === 'Subject' && subjectTerms((f.criteria || {}).subject))),
        values: formValues(f, names),
        kept: keptParts(f, names),
      };
    }),
  };
}

function managerSave(id, spec) {
  return saveFilter(id || null, spec).message;
}

function managerDelete(id) {
  Gmail.Users.Settings.Filters.remove('me', id);
  return 'Filter deleted.';
}

// ---------- Small card helpers ----------

function icon(name) {
  return CardService.newIconImage().setMaterialIcon(CardService.newMaterialIcon().setName(name));
}

function decorated(iconName, topLabel, html) {
  const w = CardService.newDecoratedText().setStartIcon(icon(iconName)).setText(html).setWrapText(true);
  if (topLabel) w.setTopLabel(topLabel);
  return w;
}

function filledButton(text, action) {
  return CardService.newTextButton().setText(text).setTextButtonStyle(CardService.TextButtonStyle.FILLED).setOnClickAction(action);
}

function overlayButton(text, url, filled) {
  return CardService.newTextButton()
    .setText(text)
    .setTextButtonStyle(filled ? CardService.TextButtonStyle.FILLED : CardService.TextButtonStyle.OUTLINED)
    .setOpenLink(
      CardService.newOpenLink().setUrl(url).setOpenAs(CardService.OpenAs.OVERLAY).setOnClose(CardService.OnClose.RELOAD_ADD_ON)
    );
}

function pushCard(card) {
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().pushCard(card)).build();
}

function notify(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}

// ---------- Gmail API helpers ----------

function listFilters() {
  return Gmail.Users.Settings.Filters.list('me').filter || [];
}

function userLabels() {
  return (Gmail.Users.Labels.list('me').labels || []).filter((l) => l.type === 'user');
}

function findLabel(name) {
  const lower = name.toLowerCase();
  return userLabels().find((l) => l.name.toLowerCase() === lower) || null;
}

function createLabel(name) {
  return Gmail.Users.Labels.create(
    { name: name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    'me'
  );
}
