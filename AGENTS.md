# AGENTS.md

Notes for coding agents working in this repo.

## What this is

Remind (`remind`) is a Claude Code plugin ("mod"). The user says "remind me to..." and Claude adds a reminder. A line above the prompt shows what is due. `/remind` opens a pane with the reminders, the current folder's git status and, if configured, the latest deploys.

## Layout

- `.claude-plugin/plugin.json`: manifest and `userConfig` (`source`, `appleList`, `repos`).
- `.claude-plugin/marketplace.json`: marketplace entry, so `hg913488/claude-code-reminders` installs `remind`.
- `.claude-plugin/types/`: the Claude Code type declarations used by `tsc`. Claude Code writes this folder when it loads the mod, and it is not committed, so a fresh clone does not have it.
- `hooks/register.tsx`: the whole mod. `hooks/hooks.json` points to it.
- `types/index.d.ts`: types for the mod's state (`Todo`, `GitState`, `Deploy`).
- `tests/remind.test.tsx`: tests, run with `claude plugin test .`.
- `assets/`: images for the README and GitHub.

## How it works

- Three tools are registered at `session.start`: `add_reminder` (`text`, optional `due` as YYYY-MM-DD), `complete_reminder` (matches the first open reminder whose text contains `text`, ignoring case) and `list_reminders`.
- `source: local` (default) keeps a JSON list at `~/.claude/remind/reminders.json`. `complete_reminder` removes the entry from it.
- `source: apple` runs AppleScript through `/usr/bin/osascript` against the Reminders list named by `appleList` (default `Claude`, created on the first reminder). macOS only.
- The band above the prompt (`AbovePrompt`) shows the first due item, with All and Hide buttons.
- The pane (`Pane`, id `remind`) shows To do, Git and, when `repos` is set, Deploys. Deploys come from `gh api repos/<repo>/deployments` (Production environment), so they need the GitHub CLI signed in.
- Deploys refresh on pane open, on Refresh and 30 s and 2 min after a Bash `git push`. Reminders and git refresh every 2 min and after each turn.
- The `/mods` switchboard can turn the mod off through `~/.claude/mods/switches.json` (key `remind`).

## Checks

Run all three from the repo root:

```
claude plugin test .
npx -y -p typescript@5.6.3 tsc --noEmit -p .
claude plugin validate .
```

Expected: 4 tests pass, `tsc` prints nothing, validate passes. In a fresh clone, `tsc` fails (missing `Map`, `Promise`, `Shaped`) until `.claude-plugin/types/` exists. Claude Code creates it the first time it loads the mod, installed or with `claude --plugin-dir .`.

## Gotchas

- Helpers that take `$` must be top-level functions, not closures inside `register`. That is why settings live in the module-level `cfg` (plus `localPath`, `gh`, `off`), set in `register` from the manifest's `userConfig`. Keep new helpers top-level and read settings from `cfg`.
- Plugin tools are typed only after a session registers them, so handlers match them by regex (`/^mcp__remind__add_reminder$/`) and read arguments off the event with a cast. In tests, use the `call()` helper, which casts for the same reason.
- Tests must never touch the real `~/.claude/remind` list or real Apple Reminders lists. The `engine()` helper in the test file mocks `HOME`, `fs.*` and `process.run`, and fakes `osascript`. Keep any new test on it. Do not run the tools against a live session with real data.
- `$.process.run` for AppleScript passes the script on stdin (`osascript -`) and values as argv. Do not build the script by string-joining user text.
- Dates are `YYYY-MM-DD` only. `-` means no due date.
- Keep the README and the `userConfig` descriptions in step with the code.
