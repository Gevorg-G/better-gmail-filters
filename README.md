# Better Gmail Filters

A Google Workspace add-on for Gmail, built in Apps Script. It creates a Gmail filter from the email you have open, and lists and deletes your existing filters from the add-on homepage. It works on desktop and in the Gmail mobile app.

Stage 1 runs through **test deployments** only. Nothing is published and nothing goes through Google review.

## Layout

- `src/appsscript.json`: the manifest, with scopes, triggers and the Gmail advanced service
- `src/Code.js`: cards and Gmail API calls
- `src/filters.js`: pure logic (parsing, validation, building and describing filters)
- `test/`: run with `node --test`

## Scopes

All scopes are listed explicitly in the manifest, so Apps Script can't add broad ones automatically.

| Scope | Why |
|---|---|
| `gmail.addons.execute` | Required to run any Gmail add-on. |
| `gmail.addons.current.message.metadata` | Reads the sender and subject of the **open email only**, through its per-message access token. This is the narrowest scope that does that. |
| `gmail.settings.basic` | Lists, creates and deletes filters (Restricted scope). |
| `gmail.labels` | Lists labels to suggest them and to name them on the homepage, and creates a label when you type a new one. |

The add-on does **not** request these:
- `https://mail.google.com/`: full mailbox access isn't needed.
- `script.external_request`: the add-on never uses `UrlFetchApp`. Developers report that this scope, combined with a Gmail scope, triggers the yearly security assessment.

## One-time setup

1. Install clasp and log in:
   ```bash
   npm install -g @google/clasp
   ```
   ```bash
   clasp login
   ```
   Then turn on the Apps Script API at https://script.google.com/home/usersettings.
2. Create the script. Clasp writes its own manifest, so restore ours afterwards:
   ```bash
   clasp create --type standalone --title "Better Gmail Filters" --rootDir src
   ```
   ```bash
   git checkout src/appsscript.json && clasp push -f
   ```
   Commit the `.clasp.json` file that clasp creates.
3. **Link a standard Google Cloud project.** Apps Script's default project can't be used for publishing later. In the Cloud console, create a project, set up the OAuth consent screen (External, Testing), and enable the **Gmail API**. Copy the project **number**. In the Apps Script editor, go to Project Settings → Google Cloud Platform (GCP) Project → Change project, and paste it.
4. Install for yourself: in the Apps Script editor, go to Deploy → Test deployments → Install. Open Gmail and the add-on appears in the side panel.

## Day-to-day

```bash
clasp push
```
Test deployments always run the latest pushed code, so reload Gmail after pushing.

```bash
node --test
```

## Full view

The homepage card's **Open full view** button opens `src/manager.html` in a popup (an Apps Script web app served by `doGet`). It shows the same filters with search, grouping by destination, and inline edit and delete. It uses the same scopes as the add-on.

The web app needs a deployment once: `clasp create-deployment --description "Full view web app"`. While testing, the button opens the `/dev` URL, which always runs the latest pushed code but only opens for the script's editors. The manifest sets web app access to `MYSELF`. Widen it before inviting testers.

## Editing filters

Gmail has no "update" for filters, so saving an edit creates the new version first and deletes the old one only after that succeeds. Parts of a filter the form doesn't show (inbox tabs, extra labels, size or attachment conditions, forwarding) are kept as they are.

## Testers

Share the Apps Script project with each tester with **Editor** access. Testers then install it from Deploy → Test deployments. In the Cloud project, also add each tester under OAuth consent screen → Test users.
