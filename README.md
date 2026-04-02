# Huly Sync for Obsidian

Obsidian plugin that synchronizes selected Huly projects into the current vault and writes dashboard-friendly notes for projects, issues, components, and employees.

## Features

- Select specific Huly projects for synchronization.
- Store synced content under a configurable root folder. Default: `huly`.
- Sync project notes, component notes, issue notes, and employee profile notes.
- Write employee cards into `huly/employees` with departments, statuses, vacations/absences, contacts, assigned tasks, and time-tracked tasks.
- Sync all project issues, including closed statuses such as `Done` and `Canceled`.
- Support both `rich` and `classic` note styles.
- Use `Meta Bind` widgets in rich notes when `Use Meta Bind` is enabled.
- Support configurable project note and issue note filename modes.
- Add Obsidian-friendly tags for project, status, component, employee department, and Huly labels.
- Expose frontmatter/properties for Dataview, calendar-style workflows, and external dashboards.
- Sync due dates, exact time tracking, per-employee time totals, overdue/due-soon flags, and direct Huly links.
- Support both `email + password` and `token` authentication.
- Support custom Huly base URLs and workspace selection.
- Download attachments locally into the vault (`huly/_attachments/`) so files open directly from Obsidian without browser authentication.
- Pull comments for issues and components.
- Track issue history: status, assignee, and priority changes fetched from Huly activity log and rendered as a table in each issue note.
- Sync **milestones** per project (`milestones/`): descriptions, comments, attachments, target date, Dataview lists of tasks in the milestone (`huly_milestone_id` on issue notes).
- Sync **issue templates** per project (`issue-templates/`): descriptions, default labels (from Huly tag elements), subtask templates, comments, attachments, Dataview lists of issues created from a template (`huly_issue_template_id`).
- Link issue notes to milestone and issue-template notes via wikilinks and frontmatter (`huly_milestone_*`, `huly_issue_template_*`).
- Rich notes with Meta Bind: issue sidebar embed shows milestone and issue-template rows.
- Render wikilinks between projects, components, milestones, issue templates, parent issues, and linked employee notes where possible.
- Show synchronization progress and scheduler state in plugin settings.
- Prefer user nicknames for assignees and comment authors, with readable full names as fallback.
- Run manual syncs and predictable scheduled syncs.
- Designed to run on both desktop and mobile Obsidian.

## Setup

1. Open plugin settings.
2. Set `Huly URL`. For Huly Cloud use `https://huly.app`.
3. Enter `Workspace` using the workspace slug expected by the Huly API.
4. Choose `Auth method`: `Email + password` or `Token`.
5. Enter the matching credentials.
6. Optionally change `Target folder`. Default: `huly`.
7. Optionally tune `Workday hours`.
   Default: `8`. This affects day-based formatting such as `1d 2h`, while raw hour/minute fields stay based on actual tracked hours.
8. Choose `Note style`.
   `Rich (recommended)` adds cards, callouts, Dataview blocks, and optional Meta Bind widgets. `Classic` keeps notes plain and lightweight.
9. If you use `Rich`, decide whether `Use Meta Bind` stays enabled.
   Default: `on`. If enabled, rich notes use `Meta Bind` embeds/buttons. If disabled, rich notes still render but fall back to static markdown blocks.
10. Optionally choose filename modes.
   Project note: `Identifier + project name` or `Project name only`. Issue note: `Issue identifier only` or `Identifier + issue title`.
11. Click `Reload projects`, select the projects you want, then run `Sync now`.
12. Optionally set `Sync interval in minutes`.
   `0` disables scheduled sync. Any positive number enables in-app periodic sync while Obsidian stays open.

## Current behavior

- Manual sync writes notes for all selected projects plus related components, issues, milestones, issue templates, and employee cards.
- Scheduled sync refreshes selected projects on a fixed interval while Obsidian is open.
- If a scheduled tick happens while another sync is running, that tick is skipped and recorded in plugin settings instead of starting a parallel sync.
- Plugin settings show sync progress, `Next scheduled sync`, and the timestamp/status of the last scheduled attempt.
- Synced content is written under `huly/` by default.
- Project folders stay short and stable by project identifier.
- By default, project notes use `PROJECT Project Name.md`.
- By default, issue notes use `PROJECT-123.md`.
- Plugin settings can switch project notes to `Project Name.md` and issue notes to `PROJECT-123 Task title.md`.
- Rich mode with `Use Meta Bind = on` also creates reusable templates in `huly/_templates/`.
- Issue notes include due dates, time tracking, labels, attachments, comments, wikilinks, and a direct Huly URL.
- Project notes include task lists, deadline overviews, and time tracking summaries by employee.
- Employee notes include profile metadata, department/org-unit data, HR absences, task snapshots, and Dataview-friendly aggregate fields.
- Assignees and comment authors are rendered as nicknames when available, with readable full names as fallback.
- Mobile compatibility is kept by using Obsidian Vault APIs and the browser WebSocket transport from the official Huly SDK.

## Calendar and time tracking

- Issue notes expose `due` in `YYYY-MM-DD` format and keep `huly_due_date` as the original ISO-like date value.
- This makes synced tasks easier to consume from Dataview tables, calendar-style plugins, and other frontmatter/property-based workflows.
- Time tracking fields include estimate, reported time, remaining time, and detailed time report entries when Huly provides them.
- Huly tracked time values are converted into milliseconds internally and exposed again as hours/minutes/day-based display fields.
- The `Workday hours` setting does not change raw tracked time. It only affects derived day-based formatting and fields such as `..._days`.
- Example with `Workday hours = 8`:
  - `1.0` tracked hours -> `1h`
  - `0.5` tracked hours -> `30m`
  - `1.9` tracked hours -> `1h 54m`
  - `10.5` tracked hours -> `1d 2h 30m`
- Issue notes expose:
  - `huly_is_overdue`
  - `huly_is_due_soon`
  - `huly_due_in_days`
  - `huly_issue_url`
- Issue and project notes expose `huly_time_by_employee` as a YAML list of objects with exact totals per reporter:
  - `employee_name`
  - `employee_slug`
  - `reported_time_ms`
  - `reported_time_hours`
  - `reported_time_minutes`
  - `reported_time_display`
- Employee notes expose dashboard-friendly fields such as:
  - `huly_department_names`
  - `huly_org_unit_names`
  - `huly_employee_statuses`
  - `huly_employee_vacations`
  - `huly_total_reported_time_ms`
  - `huly_assigned_open_task_count`

## Compatible plugins

The current calendar integration is frontmatter-based. `Huly Sync` does not create separate calendar event files, but it writes task dates into note properties that other Obsidian plugins can read.

Must-have for the richest note experience:

- `Dataview`
  Best overall fit. Works directly with generated properties such as `due`, `huly_status`, `huly_project_name`, and `huly_time_by_employee`.
  Enable JavaScript queries if you plan to use `dataviewjs` blocks in your own dashboards.
- `Meta Bind`
  Recommended when `Huly Sync -> Note style = Rich` and `Use Meta Bind = on`.
  If you do not want this dependency, turn `Use Meta Bind` off and rich notes will fall back to static markdown sections.

Optional plugins:

- `Calendar`
  Useful for browsing notes by the generated `due` field, but it is not the primary integration target.
- `Tasks Calendar`
  Can be useful if your workflow is centered around task calendars and frontmatter/date properties.
- `Full Calendar`
  Possible, but this is a more advanced option. It is better suited to dedicated event notes, so it is not the primary target for `Huly Sync`.
- `Bases`
  Useful if you want additional table/card views over generated properties without writing Dataview queries by hand.

Notes:

- `Dataview` is the most natural companion plugin for the current implementation.
- `Meta Bind` is only needed for the default interactive rich-note widgets.
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

### Employee cards by department

```dataview
TABLE WITHOUT ID
  file.link AS Employee,
  huly_employee_role AS Role,
  huly_assigned_open_task_count AS OpenTasks,
  huly_total_reported_time_hours AS Hours
FROM "huly/employees"
WHERE contains(huly_department_names, "Engineering")
SORT huly_total_reported_time_ms DESC
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
  _attachments/
    a1b2c3d4-document.pdf
  _templates/
    issue_sidebar.md
    project_header.md
  PROJECT/
    PROJECT Project Name.md
    components/
      Component Name.md
    milestones/
      Milestone label abcdef12.md
    issue-templates/
      Template title fedcba98.md
    tasks/
      PROJECT-123.md
  employees/
    Jane Doe.md
```

Notes:

- `huly/_attachments/` stores downloaded attachment files. Files are named with a short ID prefix for uniqueness.
- `huly/_templates/` is created for rich notes when `Use Meta Bind` is enabled. These files are **Obsidian/Meta Bind** snippets, not Huly issue templates.
- Huly **issue templates** are stored under each project’s `issue-templates/` folder.
- `employees/` contains synced employee notes used by Dataview-friendly team views.

## Changelog

### 0.2.3

- Attachments are now downloaded locally into `huly/_attachments/` during sync. Links in notes point to local vault files instead of remote URLs, removing the need for browser authentication to open them.
- Issue notes include a **History** section showing how status, assignee, and priority changed over time, with dates, old/new values, and who made the change.
- Fixed attachment URLs for self-hosted Huly instances where `:workspace` appeared twice in the file URL template.
- Fixed history table wikilinks breaking inside markdown tables due to pipe character conflict.
- Improved status name resolution for history entries, including well-known platform IDs.

### 0.2.1

- Milestones and issue templates are fetched from Huly and written under each project folder.
- Issue notes include milestone and template linkage (frontmatter + wikilinks); project notes list milestones and templates.
- Milestone and template notes include comments and attachments when present in Huly; templates resolve default label titles via `TagElement`.
- Assignees on templates (and template comment authors) are included in employee profile sync where applicable.
- Renaming: milestone and template note files are migrated when the naming pattern changes (same idea as issue notes).
- Meta Bind issue sidebar template includes milestone and issue-template fields.
- TypeScript: `moduleResolution` set to `bundler` for correct `filenamify/browser` resolution; linter fixes for strict indexed access and account profile typing.

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
