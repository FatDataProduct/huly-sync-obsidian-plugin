# Huly Sync for Obsidian

Obsidian plugin that synchronizes selected Huly projects into the current vault.

## Features

- Select specific Huly projects for synchronization.
- Store each project in its own vault folder under a configurable root folder.
- Sync project notes, components, and all project issues, including `Done` and `Canceled`.
- Add Obsidian-friendly tags for project, status, component, and Huly labels.
- Sync task due dates and expose them as frontmatter fields for Calendar/Dataview-friendly workflows.
- Sync task estimation, reported time, remaining time, and detailed time reports.
- Show project-level summaries for time spent, remaining work, and employee effort.
- Expose exact per-employee time totals in machine-readable frontmatter for Dataview.
- Convert Huly time fractions using a configurable workday length, with `8` hours per workday by default.
- Support both `email + password` and `token` authentication.
- Support custom Huly base URLs and workspace selection.
- Pull attachments as links from issues, components, and comments.
- Pull comments for issues and components.
- Render wikilinks between projects, components, and parent issues.
- Add a direct Huly link to each synced issue note.
- Show synchronization progress in plugin settings.
- Make scheduled sync timing more predictable and show scheduler state in settings.
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
8. Optionally set `Sync interval in minutes`:
   - `0` disables scheduled sync completely.
   - any positive number enables predictable periodic sync while Obsidian stays open.
9. Optionally set `Workday hours`:
   - default: `8`
   - Huly raw time values are treated as decimal hours
   - this setting controls when human-readable output should roll over into workdays
   - example: with `8`, `8h` is displayed as `1d`

## Current behavior

- Manual sync writes project notes, component notes, and issue notes for all selected projects.
- Scheduled sync refreshes all synced issues for all selected projects on a fixed interval while Obsidian is open.
- Successful scheduled syncs no longer reset the timer after each run.
- If a scheduled tick happens while another sync is already running, that tick is skipped and recorded in plugin settings instead of starting a parallel sync.
- Plugin settings show `Next scheduled sync` plus the timestamp and status of the last scheduled attempt.
- Synced content is written under `huly/` by default.
- Project folders stay short and stable by project identifier.
- By default, project notes keep the current filename format: `PROJECT Project Name.md`.
- By default, issue notes keep the current filename format: `PROJECT-123.md`.
- Plugin settings can switch project notes to `Project Name.md` and issue notes to `PROJECT-123 Task title.md`.
- Issue notes include due dates, time tracking, labels, attachments, comments, wikilinks, and a direct Huly URL.
- Project notes include task lists, deadline overviews, and time tracking summaries by employee.
- Assignees and comment authors are rendered as nicknames when available.
- Mobile compatibility is kept by using Obsidian Vault APIs and the browser WebSocket transport from the official Huly SDK.

## Calendar and time tracking

- Issue notes expose `due` in `YYYY-MM-DD` format and keep `huly_due_date` as the original ISO value.
- This makes synced tasks easier to consume from Calendar-style plugins, Dataview tables, and other frontmatter-based workflows.
- Time tracking fields include estimate, reported time, remaining time, and detailed time report entries when Huly provides them.
- Huly time values are interpreted as decimal hours and converted into real durations.
- The `Workday hours` setting does not change the raw stored amount of time. It only affects how durations are formatted into `d/h/m` display strings and derived workday-based fields.
- Example with `Workday hours = 8`:
  - `1.0` -> `1h`
  - `0.5` -> `30m`
  - `1.9` -> `1h 54m`
  - `10.5` -> `1d 2h 30m`
- Project notes aggregate time reports by employee and show upcoming deadlines across project tasks.
- Issue and project notes also expose `huly_time_by_employee` as a YAML list of objects with exact totals per reporter:
  - `employee_name`
  - `employee_slug`
  - `reported_time_ms`
  - `reported_time_hours`
  - `reported_time_minutes`
  - `reported_time_display`
- Issue notes expose `huly_issue_url`, so Dataview or other plugins can open the original Huly card directly.

## Compatible plugins

The current calendar integration is frontmatter-based. `Huly Sync` does not create separate calendar event files, but it writes task dates into note properties that other Obsidian plugins can read.

Recommended plugins:

- `Dataview`:
  Best overall fit. Works directly with the generated `due` field and project/task metadata.
- `Tasks Calendar`:
  Can be useful if your workflow is centered around task calendars and frontmatter/date properties.
- `Full Calendar`:
  Possible, but this is a more advanced option. It is better suited to dedicated event notes, so it is not the primary target for `Huly Sync`.

Notes:

- `Dataview` is the most natural companion plugin for the current implementation.
- The official Obsidian `Calendar` plugin is not a direct task calendar integration here. It can still be useful alongside generated dashboard notes and Dataview queries.
- The `Tasks` plugin is not the main integration target, because `Huly Sync` generates notes with frontmatter, not markdown checklist tasks.

## Dataview examples

### Calendar view of Huly tasks

```dataview
CALENDAR due
FROM "huly"
WHERE due
```

### Upcoming deadlines table

```dataview
TABLE WITHOUT ID
  file.link AS Task,
  huly_project_name AS Project,
  huly_status AS Status,
  due AS Due,
  huly_assignee AS Assignee
FROM "huly"
WHERE due
SORT due ASC
```

### Tasks with time tracking

```dataview
TABLE WITHOUT ID
  file.link AS Task,
  huly_estimation_display AS Estimate,
  huly_reported_display AS Spent,
  huly_remaining_display AS Remaining,
  due AS Due
FROM "huly"
WHERE huly_type = "issue"
SORT due ASC
```

### Overdue open tasks

```dataview
TABLE WITHOUT ID
  file.link AS Task,
  huly_project_name AS Project,
  huly_status AS Status,
  due AS Due
FROM "huly"
WHERE huly_type = "issue" AND due AND due < date(today) AND huly_is_closed = false
SORT due ASC
```

### Time tracking by project folder

```dataview
TABLE WITHOUT ID
  file.link AS Task,
  huly_project_name AS Project,
  huly_assignee AS Assignee,
  huly_reported_display AS Spent,
  huly_remaining_display AS Remaining
FROM "huly/FDASR/tasks"
WHERE huly_type = "issue"
SORT huly_reported_time_ms DESC
```

### Exact time by employee

```dataview
TABLE WITHOUT ID
  file.link AS Note,
  reporter.employee_name AS Reporter,
  reporter.reported_time_hours AS Hours,
  reporter.reported_time_display AS Spent
FROM "huly"
FLATTEN huly_time_by_employee AS reporter
WHERE huly_type = "issue"
SORT reporter.reported_time_ms DESC
```

### Huly links table

```dataview
TABLE WITHOUT ID
  file.link AS Note,
  huly_issue_identifier AS Issue,
  huly_issue_url AS Huly
FROM "huly"
WHERE huly_type = "issue" AND huly_issue_url
SORT huly_issue_identifier ASC
```

## Vault layout

With the default target folder, synced content looks like this:

```text
huly/
  PROJECT/
    PROJECT Project Name.md
    components/
      Component Name.md
    tasks/
      PROJECT-123.md
```

## Mobile notes

- `manifest.json` keeps `isDesktopOnly: false`, so the plugin can load on phones.
- No Node.js file APIs, shell commands, or desktop-only Electron APIs are used at runtime.
- Scheduled sync works while Obsidian is open on the phone. Mobile OS background restrictions can still pause the app when it is not active.
- The scheduler is in-app only. If the mobile app is suspended or closed, the next sync runs after Obsidian becomes active again and the interval timer resumes.

## Installation

### Via BRAT

1. Install the `BRAT` plugin in Obsidian.
2. Open `BRAT` settings.
3. Choose `Add beta plugin`.
4. Enter the repository:

   ```text
   FatDataProduct/huly-sync
   ```

5. Confirm installation and enable `Huly Sync`.

BRAT installs the plugin from GitHub release assets, so use a tagged release rather than raw source code.

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
- The uploaded release assets are compatible with BRAT installation.
- The pushed tag must match the versions in both `package.json` and `manifest.json`.

## Development

```bash
npm install
npm run build
```

## License

This project is licensed under the GNU General Public License v3.0 only (`GPL-3.0-only`).

See the [`LICENSE`](LICENSE) file for the full text.
