// Card UI and Gmail API calls. Pure logic lives in filters.js; the full view lives in manager.html.

const PAGE_SIZE = 20; // keeps each section well under the 100-widget card limit

const CRITERIA_FIELDS = {
  from: { title: 'From', icon: 'person' },
  to: { title: 'To', icon: 'alternate_email' },
  subject: { title: 'Subject contains', icon: 'subject' },
  query: { title: 'Has the words', icon: 'search' },
  negatedQuery: { title: "Doesn't have", icon: 'search_off' },
};

// ---------- Contextual card: create a filter from the open email ----------

function onGmailMessage(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  const msg = GmailApp.getMessageById(e.gmail.messageId);
  const address = parseAddress(msg.getFrom());
  const domain = senderDomain(address);
  const subject = msg.getSubject() || '';

  return filterFormCard({
    title: 'Create a filter',
    subtitle: 'From this email',
    values: { from: address, subject: '', label: '', actions: [] },
    fields: ['from', 'subject'],
    suggestions: { from: domain ? [address, '@' + domain] : [address], subject: subject ? [subject] : [] },
    hints: { from: domain ? 'Use @' + domain + ' to match the whole domain' : '', subject: 'Leave empty to match any subject' },
    button: 'Create filter',
    action: CardService.newAction().setFunctionName('onSaveFilter'),
  });
}

/** One form for creating and editing. opts.fields lists the criteria inputs to show. */
function filterFormCard(opts) {
  const v = opts.values;
  const match = CardService.newCardSection().setHeader('Match emails');
  opts.fields.forEach((k) => {
    const input = CardService.newTextInput().setFieldName(k).setTitle(CRITERIA_FIELDS[k].title).setValue(v[k] || '');
    const hint = (opts.hints || {})[k];
    if (hint) input.setHint(hint);
    const sugg = ((opts.suggestions || {})[k] || []).filter(Boolean);
    if (sugg.length) {
      const s = CardService.newSuggestions();
      sugg.forEach((x) => s.addSuggestion(x));
      input.setSuggestions(s);
    }
    match.addWidget(input);
  });
  if (opts.kept && opts.kept.length) {
    match.addWidget(decorated('lock', 'Also matches (kept as is)', opts.kept.map(escapeHtml).join('<br>')));
  }

  const labels = CardService.newSuggestions();
  userLabels().forEach((l) => labels.addSuggestion(l.name));
  const checks = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.CHECK_BOX)
    .setFieldName('actions');
  Object.keys(ACTIONS).forEach((key) => checks.addItem(ACTIONS[key].title, key, v.actions.includes(key)));

  const then = CardService.newCardSection()
    .setHeader('Then')
    .addWidget(
      CardService.newTextInput()
        .setFieldName('label')
        .setTitle('Apply label')
        .setValue(v.label || '')
        .setHint('Pick one or type a new name')
        .setSuggestions(labels)
    )
    .addWidget(checks);
  if (opts.keptActions && opts.keptActions.length) {
    then.addWidget(decorated('lock', 'Also does (kept as is)', opts.keptActions.map(escapeHtml).join('<br>')));
  }

  opts.action.setParameters({ id: opts.id || '', fields: opts.fields.join(',') });
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(opts.title).setSubtitle(opts.subtitle || ''))
    .addSection(match)
    .addSection(then)
    .setFixedFooter(CardService.newFixedFooter().setPrimaryButton(filledButton(opts.button, opts.action)))
    .build();
}

function onSaveFilter(e) {
  const p = e.commonEventObject.parameters;
  const inputs = e.commonEventObject.formInputs || {};
  const value = (name) => ((inputs[name] ? inputs[name].stringInputs.value : [])[0] || '').trim();
  // Empty inputs are left out of formInputs, so every field the form showed is read explicitly.
  const spec = { label: value('label'), actions: inputs.actions ? inputs.actions.stringInputs.value : [] };
  p.fields.split(',').forEach((k) => (spec[k] = value(k)));

  let message;
  try {
    message = saveFilter(p.id || null, spec);
  } catch (err) {
    return notify(err.message);
  }
  if (!p.id) return notify(message);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popToRoot().updateCard(filterListCard(0)))
    .setNotification(CardService.newNotification().setText(message))
    .build();
}

/**
 * Creates a filter, or replaces filter `id` (Gmail can't update filters in place).
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

  // Check with a placeholder label first, so an invalid or duplicate filter never creates a new label.
  const label = spec.label ? findLabel(spec.label) : null;
  const draft = applyEdits(base, spec, spec.label ? (label ? label.id : 'Label_new') : null);
  const problem = filterError(draft);
  if (problem) throw new Error(problem);
  if (id && sameFilter(base, draft)) return 'Nothing changed.';
  if ((!spec.label || label) && existing.some((f) => f.id !== id && sameFilter(f, draft))) {
    throw new Error('You already have this exact filter.');
  }

  try {
    const labelId = spec.label ? (label || createLabel(spec.label)).id : null;
    Gmail.Users.Settings.Filters.create(applyEdits(base, spec, labelId), 'me');
  } catch (err) {
    throw new Error("Gmail didn't accept this filter: " + err.message);
  }
  if (!id) return 'Filter created. It applies to new email.';
  try {
    Gmail.Users.Settings.Filters.remove('me', id);
  } catch (err) {
    throw new Error('The new version is saved, but the old one could not be removed. Delete the old one by hand.');
  }
  return 'Filter updated.';
}

// ---------- Homepage: list, view, edit and delete filters ----------

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
    section.addWidget(decorated('filter_alt', '', 'No filters yet. Open an email to create one.'));
  }
  slice.forEach((f) => {
    section.addWidget(
      CardService.newDecoratedText()
        .setStartIcon(icon(f.icon))
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

  const url = fullViewUrl();
  if (url) {
    card.setFixedFooter(
      CardService.newFixedFooter().setPrimaryButton(
        CardService.newTextButton()
          .setText('Open full view')
          .setOpenLink(
            CardService.newOpenLink()
              .setUrl(url)
              .setOpenAs(CardService.OpenAs.OVERLAY)
              .setOnClose(CardService.OnClose.RELOAD_ADD_ON)
          )
      )
    );
  }
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

  const when = CardService.newCardSection().setHeader('When an email matches');
  const icons = { From: 'person', To: 'alternate_email', Subject: 'subject', Has: 'search', "Doesn't have": 'search_off' };
  filterCriteria(filter).forEach((c) => {
    when.addWidget(decorated(icons[c.name] || 'attach_file', c.name, c.values.map(escapeHtml).join('<br>') || 'Yes'));
  });

  const then = CardService.newCardSection().setHeader('Then');
  filterActions(filter, names).forEach((a) => then.addWidget(decorated('arrow_forward', '', escapeHtml(a))));

  const card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(summary.title).setSubtitle('Filter'))
    .addSection(when)
    .addSection(then)
    .setFixedFooter(
      CardService.newFixedFooter()
        .setPrimaryButton(filledButton('Edit', CardService.newAction().setFunctionName('onEditFilter').setParameters({ id: id })))
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

function onEditFilter(e) {
  const id = e.commonEventObject.parameters.id;
  const filter = getFilter(id);
  if (!filter) return notify('This filter no longer exists. Reload the add-on to refresh the list.');
  const names = labelNames();
  const values = formValues(filter, names);
  const c = filter.criteria || {};
  const a = filter.action || {};

  // Always offer From and Subject; show the other text criteria only when the filter uses them.
  const fields = Object.keys(CRITERIA_FIELDS).filter((k) => k === 'from' || k === 'subject' || c[k]);
  const kept = filterCriteria({ criteria: Object.keys(c).filter((k) => !EDITABLE_CRITERIA.includes(k)).reduce((o, k) => ((o[k] = c[k]), o), {}) })
    .map((x) => x.name + (x.values.length ? ': ' + x.values.join(', ') : ''));
  const managed = Object.keys(ACTIONS).map((k) => ACTIONS[k].add || ACTIONS[k].remove);
  const userLabel = (a.addLabelIds || []).find(isUserLabel);
  const keptActions = filterActions(
    {
      action: {
        addLabelIds: (a.addLabelIds || []).filter((x) => x !== userLabel && !managed.includes(x)),
        removeLabelIds: (a.removeLabelIds || []).filter((x) => !managed.includes(x)),
        forward: a.forward,
      },
    },
    names
  );

  return pushCard(
    filterFormCard({
      id: id,
      title: 'Edit filter',
      subtitle: 'Saving replaces the filter with the new version',
      values: values,
      fields: fields,
      kept: kept,
      keptActions: keptActions,
      button: 'Save changes',
      action: CardService.newAction().setFunctionName('onSaveFilter'),
    })
  );
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

// ---------- Full view (manager.html, opened as an overlay) ----------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('manager')
    .setTitle('Better Gmail Filters')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ScriptApp.getService().getUrl() returns an ID that 404s when called from the add-on, so the URL is set here.
// shortcut: this is the HEAD deployment's /dev URL (latest pushed code, editors only); switch to a versioned /exec URL when publishing.
const FULL_VIEW_URL = 'https://script.google.com/macros/s/AKfycbxi1gHaR5HU1UcOxmZWDXMKOePCxFp0MR1WYV0Aaek/dev';

function fullViewUrl() {
  return FULL_VIEW_URL;
}

/** Everything the full view needs in one call. */
function managerData() {
  const names = labelNames();
  return {
    labels: Object.keys(names).map((id) => names[id]).sort(),
    actions: Object.keys(ACTIONS).map((k) => ({ key: k, title: ACTIONS[k].title })),
    filters: listFilters().map((f) => ({
      id: f.id,
      icon: filterIcon(f),
      summary: summarizeFilter(f, names),
      criteria: filterCriteria(f),
      actions: filterActions(f, names),
      values: formValues(f, names),
    })),
  };
}

function managerSave(id, spec) {
  return saveFilter(id || null, spec);
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
