# dsh-retro

**English** | [简体中文](README.zh-CN.md)

A retrospective plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Turn session goals, feedback and tool failures into drafts, review them, and save the lessons to an Obsidian vault. Includes weekly summaries, rule proposals and blog integration.

```text
Session events → material / suggestions → retrospective drafts → manual review → notes / experience entries
                              Weekly summaries → rule proposals → manual adoption → skills / AGENTS.md
```

## Installation

Requires Node.js 22 or later, pnpm to manage profile plugins, and DSH with a configured model. See the [official repository](https://github.com/deepseek-ai/deepseek-harness) for DSH installation and the [quickstart](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) for the Web UI and initial setup.

The current version has been checked against DSH `0.1.2-rc.1` for tool contracts, host and client loading, CLI installation and configuration composition.

Install into the Web profile:

```sh
dsh plugin --profile web add github:StellatoL/retro
dsh --profile web --dump-config
dsh web
```

`--dump-config` prints the composed configuration without starting the app. Look for `id: retro` and `name: dsh-retro`. If you use DSH through npx, replace `dsh` with `npx @deepseek-ai/dsh`. Installing from GitHub requires access to this repository.

For local development, run these commands from the repository root:

```sh
npm ci --ignore-scripts
dsh plugin --profile web add .
```

The package declares `dsh.bundle`, so the DSH CLI adds it to the profile's bundle list and inserts the `id: retro`, `name: dsh-retro` plugin row. The repository includes runnable JavaScript; no installation-time `prepare` or build script is needed. Restart DSH and refresh the browser after installation. The host loads the client module at runtime, so rebuilding the DSH frontend is unnecessary. See the [official plugin publishing guide](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) for the distribution conventions.

For another profile that provides the base services, replace `web` in the commands. The Web panel also needs the host's `webServer` and client module services.

### Upgrading from an older version

- The repository root is now the distribution package. Existing local links to `dsh-retro/` remain supported; use the root for new installations.
- If your personal `cordis.patch.yml` already inserts a `retro` row, save any custom configuration and remove that duplicate insertion when switching to bundle installation. Restore personal paths with `/retro config`.
- When loading the plugin manually, use the bare package name `dsh-retro` in the row's `name` field. Client discovery uses the package metadata.
- The bundled `retro-writing` skill is copied on first installation. Upgrades preserve an existing skill. If an older skill lacks YAML frontmatter, add `name: retro-writing` and a nonempty `description` so DSH can discover it.

## Initial configuration

Run these commands in a DSH session. Quote paths that contain spaces:

```text
/retro config vaultPath "D:/Notes/My Vault"
/retro config
/retro queue
```

Configure the optional blog integration:

```text
/retro config blogPath "D:/Projects/my-blog"
/retro config blogBaseUrl https://example.com
```

Saved configuration changes take effect in the current plugin instance. Keep personal configuration out of the repository's bundle patch.

| Option | Default / purpose |
| --- | --- |
| `vaultPath` | Empty; root of the Obsidian vault |
| `blogPath` | Empty; root of the blog Git repository |
| `blogBaseUrl` | Empty; base URL for public article links |
| `stagingDir` | `Index/06_Retro/_retro`; staged retrospective cards |
| `experienceRoot` | `Index/06_Retro/经验库`; permanent experience notes and index |
| `proposalsDir` | `Index/06_Retro/_proposals`; rule proposals |
| `entriesDir` | `Index/06_Retro/_entries`; entry drafts |
| `settleDirs` | `Index/03_Full_Notes/04_Retro`, `Index/04_Projects`, `Index/06_Retro/经验库` |
| `readWhitelist` | `Index`; vault-relative directories available for reading |
| `templates` | Paths for the `experience`, `permanent` and `weekly` templates, under `Index/99_system/_templates/` by default |
| `autoProposeOnGoalComplete` | `true`; suggest a retrospective when a goal completes |
| `weeklyReminderDays` | `7`; reminder interval, not a scheduled task |
| `llmProvider` / `llmModel` | `deepseek-official` / `deepseek-v4-flash`; must be available in DSH |
| `distillMaxChars` / `chunkChars` | `30000` / `12000`; positive integers for processing long sessions |
| `blogAutoPush` | `false`; push the blog repository only when enabled or when `--push` is supplied |

Use `/retro config <key>` to read an option and `/retro config <key> <value>` to update it. Separate directory lists with commas and use `true` or `false` for booleans. To change template mappings, edit the runtime JSON configuration file and reload the plugin.

Configuration precedence is **defaults < Cordis row configuration < runtime configuration file**. The environment variables `DSH_RETRO_VAULT`, `DSH_RETRO_BLOG` and `DSH_RETRO_BLOG_URL` fill the corresponding values only when they are still empty after merging.

## Workflow

1. After a DSH session, run `/retro queue` to view captured material and suggestions, or run `/retro draft today` directly.
2. Open the staged card in Obsidian and review its content and questions awaiting confirmation.
3. Run `/retro review <id> keep` to save the reviewed note and create an experience entry draft.
4. Edit the entry, then run `/retro entry keep <id>` to save a permanent note and update the experience index.
5. Run `/weekly` to summarize the last seven days of sessions, material and feedback. Review any rule proposals, then adopt them with `/retro adopt <id>`.

Automatic collection does not call a model. Draft and weekly-summary generation sends the material to the configured DSH model service. Goal completion creates a suggestion; saving permanent notes, adopting rules and publishing blog posts are triggered by their respective commands.

| Command | Purpose |
| --- | --- |
| `/retro` or `/retro queue` | View retrospective suggestions, cards, entries, proposals and the publishing queue |
| `/retro draft today\|week\|all\|workspace\|session:<id>` | Generate cards for a scope; skip sessions that already have a card |
| `/retro review <id> keep [--dir <directory>]` | Read the reviewed staging file and save it; the directory must be in `settleDirs` |
| `/retro review <id> discard` | Mark a card as discarded; retain its staging file until cleanup |
| `/retro review <id> edit <feedback>` | Record revision feedback; edit the staging file before running `keep` again |
| `/retro entry keep <id>` | Save an experience entry and refresh the index |
| `/retro adopt <id\|all>` | Append proposed rules to a skill or global rules file; back up existing content as `.bak` |
| `/retro cleanup` | Delete staging files for discarded cards while retaining their state records |
| `/retro report` | Generate a standalone HTML report and try to open it with the system's default opener |
| `/weekly [--force]` | Generate a seven-day summary; skip generation if a summary from today is awaiting review |
| `/blog list` | List blog posts |
| `/blog draft <vault-relative-path\|card-id>` | Generate a blog draft from a vault note or card |
| `/blog publish <slug> [--push]` | Clear the draft flag, commit the article and optionally push |
| `/blog capture [published\|recent\|all]` | Import article metadata as entry drafts; `recent` currently behaves like `published`, while `all` includes drafts |

To limit model usage per invocation, `today` processes at most 5 sessions, `week` and `workspace` at most 8, and `all` at most 10. The `workspace` scope matches sessions against the DSH host's startup directory. Batch adoption groups proposals by text similarity, adopts one per group and marks duplicates as `skipped`.

Two tools are available to the model: `retro_capture` records material, and `retro_draft` creates a staged draft for a session. Neither tool saves permanent notes or publishes content.

## Web panel and reports

A “复盘” (Retrospective) button appears at the bottom of the Web sidebar, with a floating button as a fallback when the slot is unavailable. While open, the panel refreshes statistics, cards awaiting review, entry drafts, pending proposals, recently saved notes and audit records every 30 seconds.

Click an item to copy its command, or use its file button to open the note through `obsidian://`. Run confirmation commands in the session. The browser's device must have Obsidian installed and access to a vault with the matching name.

The panel uses the same-origin, read-only `GET /retro/api` endpoint. It supports `HEAD`, rejects other methods and disables response caching. Standalone reports are saved as `retro-report.html` in the state directory. Windows uses the system file opener; macOS uses `open`, and Linux uses `xdg-open`. In a headless environment, open the generated HTML file manually.

## Blog compatibility

The current adapter targets `src/content/posts/*.md` with simple YAML frontmatter containing fields such as `title`, `published`, `draft`, `description`, `tags` and `category`. It supports this directory and field convention rather than arbitrary Astro content collections.

New posts use `draft: true`. **Excluding drafts from production builds depends on the site's code**; implement filtering in its content queries. Publishing updates the article and runs Git. Deployment after a push depends on the blog repository's CI. If Git fails, the article may already have been updated; the command reports the failure.

## Data locations

```text
$DSH_HOME/                              (defaults to ~/.dsh)
├── retro/
│   ├── config.json                    (personal runtime configuration)
│   ├── store.json                     (state and the latest 2,000 audit records)
│   ├── retro-report.html              (generated on request)
│   └── apply-error.log                (created if initialization fails)
├── skills/retro-writing/SKILL.md       (installed once; adopted rules are appended)
└── AGENTS.md                          (written when adopting agents proposals)
```

`DSH_RETRO_DIR` overrides the `retro/` state directory only; it does not change the skill or global rules locations. State storage is designed for a single DSH process. Assign separate state directories when running multiple profiles concurrently to avoid overwriting the same JSON file.

Default vault layout:

```text
Index/
├── 03_Full_Notes/04_Retro/             (reviewed retrospective notes)
└── 06_Retro/
    ├── _retro/                       (staged cards)
    ├── _entries/                     (experience entry drafts)
    ├── _proposals/                   (skill and rule proposals)
    └── 经验库/00_索引.md
```

Cards, regular entries and proposals use date-time-topic filenames, with a numeric suffix for collisions. Blog imports use internal IDs. File operations check configured roots, relative paths, read whitelists and existing directory links, rejecting traversal and protected directories such as `.git`, `.obsidian` and `.trash`. The vault does not need to be a Git repository; use your preferred backup method.

## Development

Run from the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
```

Static checks validate manifests, exports, skill metadata and JavaScript syntax. Tests cover official DSH tool contracts, filesystem boundaries, workflows and client smoke checks. The package check creates and extracts a tarball and verifies loading by package name. Tests use temporary state, vault and blog directories with substitutes for model calls, Git and browser launchers.

- [Architecture (简体中文)](docs/architecture.md)
- [Changelog (简体中文)](CHANGELOG.md)
- [Contributing (简体中文)](CONTRIBUTING.md)

## License

[MIT](LICENSE)
