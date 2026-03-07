# Huly Sync for Obsidian

Obsidian plugin that synchronizes selected Huly projects into the current vault.

## Features

- Select specific Huly projects for synchronization.
- Store each project in its own vault folder under a configurable root folder.
- Sync project notes, components, and all project issues, including `Done` and `Canceled`.
- Add Obsidian-friendly tags for project, status, component, and Huly labels.
- Support both `email + password` and `token` authentication.
- Support custom Huly base URLs and workspace selection.
- Pull attachments as links from issues, components, and comments.
- Pull comments for issues and components.
- Render wikilinks between projects, components, and parent issues.
- Show synchronization progress in plugin settings.
- Prefer user nicknames for assignees and comment authors, with readable full names as fallback.
- Run manual full syncs and scheduled syncs.
- Designed to run on both desktop and mobile Obsidian.

## Setup

1. Open plugin settings.
2. Set the Huly base URL. For Huly Cloud use `https://huly.app`.
3. Choose an authentication method:
   - `email + password`
   - `token`
4. Enter the workspace name.
5. Optionally change the target folder. Default: `huly`.
6. Load and select the projects you want to sync.
7. Run a manual sync.

## Current behavior

- Manual sync writes project notes, component notes, and issue notes for all selected projects.
- Scheduled sync refreshes all synced issues for all selected projects.
- Synced content is written under `huly/` by default.
- Project notes use descriptive filenames like `PN Project Name.md`.
- Issue and component notes include Huly metadata, labels, attachments, comments, and wikilinks.
- Assignees and comment authors are rendered as nicknames when available.
- Mobile compatibility is kept by using Obsidian Vault APIs and the browser WebSocket transport from the official Huly SDK.

## Vault layout

With the default target folder, synced content looks like this:

```text
huly/
  PROJECT/
    PROJECT Project Name.md
    components/
      Component Name.md
    tasks/
      PROJECT-123 Task title.md
```

## Mobile notes

- `manifest.json` keeps `isDesktopOnly: false`, so the plugin can load on phones.
- No Node.js file APIs, shell commands, or desktop-only Electron APIs are used at runtime.
- Scheduled sync works while Obsidian is open on the phone. Mobile OS background restrictions can still pause the app when it is not active.

## Installation

### From GitHub Releases

1. Open the repository `Releases` page.
2. Download `manifest.json`, `main.js`, and `styles.css` from the latest release.
3. Create the folder `<your-vault>/.obsidian/plugins/huly-sync/`.
4. Put the three files into that folder.
5. Enable `Huly Sync` in `Settings -> Community plugins`.

### From source

```bash
npm install
npm run build
```

Then copy `manifest.json`, `main.js`, and `styles.css` into:

```text
<your-vault>/.obsidian/plugins/huly-sync/
```

## Release flow

- `CI` runs on every push to `main` and on every pull request.
- `Release` runs when a git tag is pushed.
- The release workflow builds the plugin and uploads `manifest.json`, `main.js`, `styles.css`, and a zip archive to GitHub Releases.
- The pushed tag must match the versions in both `package.json` and `manifest.json`.

## Development

```bash
npm install
npm run build
```
