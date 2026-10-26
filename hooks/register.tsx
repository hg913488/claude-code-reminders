import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deploy, GitState, Todo } from '../types'

const PANE = 'remind'
const TITLE = 'Reminders'
// Where gh usually lives, for a Claude started outside a login shell; plain `gh` last.
const GH_PATHS = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
const DATE = /^\d{4}-\d{2}-\d{2}$/

// Open items of the list named by argv, one `YYYY-MM-DD<TAB>name` line each, `-` with no due date.
const APPLE_READ = `
on pad(n)
	return text -2 thru -1 of ("0" & n)
end pad
on run argv
	tell application "Reminders"
		if not (exists list (item 1 of argv)) then return ""
		set out to ""
		repeat with r in (reminders of list (item 1 of argv) whose completed is false)
			set d to due date of r
			if d is missing value then
				set ds to "-"
			else
				set ds to ((year of d) as text) & "-" & my pad((month of d) as integer) & "-" & my pad(day of d)
			end if
			set out to out & ds & tab & (name of r) & linefeed
		end repeat
		return out
	end tell
end run
`

// argv: list, text, due (YYYY-MM-DD or -). Makes the list on first use.
const APPLE_ADD = `
on run argv
	set listName to item 1 of argv
	set dueText to item 3 of argv
	tell application "Reminders"
		if not (exists list listName) then make new list with properties {name:listName}
		set r to make new reminder at end of list listName with properties {name:(item 2 of argv)}
		if dueText is not "-" then
			set d to current date
			set day of d to 1
			set year of d to (text 1 thru 4 of dueText) as integer
			set month of d to (text 6 thru 7 of dueText) as integer
			set day of d to (text 9 thru 10 of dueText) as integer
			set time of d to 9 * hours
			set due date of r to d
		end if
	end tell
end run
`

// argv: list, the exact name of an open reminder.
const APPLE_DONE = `
on run argv
	tell application "Reminders"
		set completed of (first reminder of list (item 1 of argv) whose name is (item 2 of argv) and completed is false) to true
	end tell
end run
`

const todos = atom({ plugin: 'remind', key: 'todos' } as const, [], { shape: 'todos-1' })
const today = atom({ plugin: 'remind', key: 'today' } as const, '')
const isHidden = atom({ plugin: 'remind', key: 'isHidden' } as const, false)
const problem = atom({ plugin: 'remind', key: 'problem' } as const, '')
const git = atom({ plugin: 'remind', key: 'git' } as const, null)
const deploys = atom({ plugin: 'remind', key: 'deploys' } as const, [], { shape: 'deploys-1' })

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)

function when(due: string, now: string) {
  if (due === '-') return 'no date'
  const days = daysBetween(now, due)
  if (days < 0) return `${-days}d overdue`
  if (days === 0) return 'today'
  return `in ${days}d`
}

function ago(at: string, nowMs: number) {
  const minutes = Math.round((nowMs - Date.parse(at)) / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 60 / 24)}d ago`
}

const isDue = (todo: Todo, now: string) => todo.due !== '-' && todo.due <= now

const byDue = (a: Todo, b: Todo) => (a.due === '-' ? 1 : b.due === '-' ? -1 : a.due.localeCompare(b.due))

const line = (todo: Todo) => (todo.due === '-' ? todo.text : `${todo.due}  ${todo.text}`)

// Settings, read from the manifest's userConfig each time the module loads.
let cfg = { source: 'local' as 'local' | 'apple', appleList: 'Claude', repos: [] as string[], where: 'your local list' }
let localPath = ''
let gh: string | undefined
let off = false


async function readLocal($: EngineInterface): Promise<Todo[] | string> {
  if (!(await $.fs.exists(localPath))) return []
  try {
    const rows = JSON.parse(String(await $.fs.read(localPath))) as unknown
    if (!Array.isArray(rows)) return `${localPath} isn't a list.`
    return rows
      .filter((row): row is Todo => typeof row?.text === 'string')
      .map(row => ({ text: row.text, due: typeof row.due === 'string' && DATE.test(row.due) ? row.due : '-' }))
  } catch {
    return `${localPath} isn't valid JSON.`
  }
}

async function readApple($: EngineInterface): Promise<Todo[] | string> {
  const listed = await $.process.run(['/usr/bin/osascript', '-', cfg.appleList], { stdin: APPLE_READ }).catch(() => undefined)
  if (listed?.exitCode !== 0) return 'Reminders didn\'t answer. Allow your terminal to control Reminders in System Settings → Privacy & Security → Automation.'
  return listed.stdout
    .split('\n')
    .filter(row => row.includes('\t'))
    .map(row => {
      const [due = '-', ...rest] = row.split('\t')
      return { due, text: rest.join(' ').trim() }
    })
}

async function refreshTodos($: EngineInterface) {
  const rows = cfg.source === 'apple' ? await readApple($) : await readLocal($)
  if (typeof rows === 'string') {
    await update($, problem, () => rows)
  } else {
    await update($, problem, () => '')
    await update($, todos, () => [...rows].sort(byDue))
  }
  const date = await $.process.run(['date', '+%F']).catch(() => undefined)
  if (date?.exitCode === 0) await update($, today, () => date.stdout.trim())
}

async function add($: EngineInterface, text: string, due: string) {
  if (cfg.source === 'apple') {
    const made = await $.process.run(['/usr/bin/osascript', '-', cfg.appleList, text, due], { stdin: APPLE_ADD }).catch(() => undefined)
    if (made?.exitCode !== 0) return false
  } else {
    const rows = await readLocal($)
    if (typeof rows === 'string') return false
    await $.fs.write(localPath, `${JSON.stringify([...rows, { text, due }], null, 2)}\n`)
  }
  await refreshTodos($)

  return true
}

// The first open reminder whose text contains `text`, ignoring case.
async function complete($: EngineInterface, text: string) {
  const rows = await read($, todos)
  const match = rows.find(todo => todo.text.toLowerCase().includes(text.toLowerCase()))
  if (!match) return undefined
  if (cfg.source === 'apple') {
    const done = await $.process.run(['/usr/bin/osascript', '-', cfg.appleList, match.text], { stdin: APPLE_DONE }).catch(() => undefined)
    if (done?.exitCode !== 0) return undefined
  } else {
    const local = await readLocal($)
    if (typeof local === 'string') return undefined
    const at = local.findIndex(todo => todo.text === match.text && todo.due === match.due)
    await $.fs.write(localPath, `${JSON.stringify(local.filter((_, i) => i !== at), null, 2)}\n`)
  }
  await refreshTodos($)

  return match
}

async function refreshGit($: EngineInterface) {
  const status = await $.process.run(['git', 'status', '--porcelain=v2', '--branch']).catch(() => undefined)
  if (status?.exitCode !== 0) {
    await update($, git, () => null)
    return
  }
  const lines = status.stdout.split('\n')
  const head = lines.find(row => row.startsWith('# branch.head '))?.slice(14) ?? '?'
  const ab = lines.find(row => row.startsWith('# branch.ab '))?.match(/\+(\d+) -(\d+)/)
  const state: GitState = {
    branch: head,
    changed: lines.filter(row => row !== '' && !row.startsWith('#')).length,
    ahead: Number(ab?.[1] ?? 0),
    behind: Number(ab?.[2] ?? 0),
  }
  await update($, git, () => state)
}

async function findGh($: EngineInterface) {
  for (const path of GH_PATHS) if (await $.fs.exists(path)) return path
  const plain = await $.process.run(['gh', '--version']).catch(() => undefined)
  return plain?.exitCode === 0 ? 'gh' : undefined
}

async function refreshDeploys($: EngineInterface) {
  if (cfg.repos.length === 0) return
  gh ??= await findGh($)
  const cli = gh
  if (!cli) {
    await update($, deploys, () => cfg.repos.map(repo => ({ site: repo.split('/')[1] ?? repo, state: 'no gh', at: '' })))
    return
  }
  const rows = await Promise.all(
    cfg.repos.map(async (repo): Promise<Deploy> => {
      const site = repo.split('/')[1] ?? repo
      const latest = await $.process
        .run([cli, 'api', `repos/${repo}/deployments?environment=Production&per_page=1`, '--jq', '.[0].id'])
        .catch(() => undefined)
      const id = latest?.stdout.trim()
      if (!id) return { site, state: 'unknown', at: '' }
      const status = await $.process
        .run([cli, 'api', `repos/${repo}/deployments/${id}/statuses?per_page=1`, '--jq', '.[0] | "\\(.state)\\t\\(.created_at)"'])
        .catch(() => undefined)
      const [state = 'unknown', at = ''] = (status?.stdout.trim() ?? '').split('\t')
      return { site, state, at }
    }),
  )
  await update($, deploys, () => rows)
}

async function refreshLocal($: EngineInterface) {
  await Promise.all([refreshTodos($), refreshGit($)])
}

async function refreshAll($: EngineInterface) {
  await Promise.all([refreshLocal($), refreshDeploys($)])
}

// The /mods switchboard turns this mod off in every chat with switches.json.
async function readSwitch($: EngineInterface) {
  let nowOff = off
  try {
    const path = `${$.plugin.root.split('/.claude/')[0] ?? ''}/.claude/mods/switches.json`
    nowOff = (await $.fs.exists(path)) && (JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>)['remind'] === false
  } catch {
    // A broken file changes nothing.
  }
  if (nowOff === off) return
  off = nowOff
  $.ui.invalidate('ui.render')
}

export const register: Register = (on, options) => {
  const source = options['source'] === 'apple' ? 'apple' : 'local'
  const appleList = String(options['appleList'] ?? '').trim() || 'Claude'
  const repos = String(options['repos'] ?? '')
    .split(/[\s,]+/)
    .filter(repo => /^[\w.-]+\/[\w.-]+$/.test(repo))
  const where = source === 'apple' ? `your Reminders list "${appleList}"` : 'your local list'
  cfg = { source, appleList, repos, where }

  // The tools are typed only once they are registered, so they are matched by pattern.
  const TOOL = {
    add: /^mcp__remind__add_reminder$/,
    complete: /^mcp__remind__complete_reminder$/,
    list: /^mcp__remind__list_reminders$/,
  }

  on('session.start', async ($, e, next) => {
    localPath = `${(await $.env.get('HOME')) ?? ''}/.claude/remind/reminders.json`
    await $.command.register({ name: 'remind', description: 'Open the Reminders pane: to-do, git, deploys' })
    await $.tool.register({
      name: 'add_reminder',
      description: `Adds a reminder to ${where}; it shows above the prompt once it's due. Use it whenever the person says "remind me", "don't let me forget" or asks for a to-do with or without a date. Turn a relative date ("Friday", "tomorrow", "in 2 weeks") into YYYY-MM-DD from today's date.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to be reminded of, as a short line.' },
          due: { type: 'string', description: 'The due date as YYYY-MM-DD. Leave out for no date.' },
        },
        required: ['text'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'complete_reminder',
      description: `Marks a reminder in ${where} done when the person says it's done or asks to remove it. Matches the first open reminder whose text contains \`text\`, ignoring case.`,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Part of the reminder text.' } },
        required: ['text'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list_reminders',
      description: `Lists the open reminders in ${where}, soonest first.`,
      isDeferred: false,
    })
    await readSwitch($)
    $.clock.every(3000, () => void readSwitch($))
    if (!off) void refreshLocal($)
    // Deploys are checked only on open, on Refresh and after a push.
    $.clock.every(120_000, () => (off ? undefined : refreshLocal($)))

    return next(e)
  })

  on('tool.call', { tool: TOOL.add }, async ($, e) => {
    if (off) return { deny: 'Reminders are turned off in /mods.' }
    // A plugin tool's arguments arrive beside `tool` on the event.
    const input = e as unknown as { text?: unknown; due?: unknown }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text === '') return { deny: 'Give the reminder some text.' }
    const due = typeof input.due === 'string' && input.due.trim() !== '' ? input.due.trim() : '-'
    if (due !== '-' && !DATE.test(due)) return { deny: 'Give the due date as YYYY-MM-DD.' }
    if (!(await add($, text, due))) return { deny: (await read($, problem)) || `Couldn't add to ${where}.` }

    return { result: `Added to ${where}: ${line({ text, due })}` }
  })

  on('tool.call', { tool: TOOL.complete }, async ($, e) => {
    if (off) return { deny: 'Reminders are turned off in /mods.' }
    const input = e as unknown as { text?: unknown }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text === '') return { deny: 'Say which reminder, by part of its text.' }
    await refreshTodos($)
    const done = await complete($, text)
    if (!done) return { deny: `No open reminder in ${where} contains "${text}".` }

    return { result: `Done: ${line(done)}` }
  })

  on('tool.call', { tool: TOOL.list }, async $ => {
    if (off) return { deny: 'Reminders are turned off in /mods.' }
    await refreshTodos($)
    const wrong = await read($, problem)
    if (wrong) return { deny: wrong }
    const rows = await read($, todos)

    return { result: rows.length === 0 ? `Nothing open in ${where}.` : rows.map(line).join('\n') }
  })

  on('turn.complete', async ($, e, next) => {
    if (off) return next(e)
    void refreshTodos($)
    void refreshGit($)

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (off) return next(e)
    const ran = await next(e)
    if (repos.length > 0 && /\bgit\s+push\b/.test(e.command)) {
      $.clock.after(30_000, () => refreshDeploys($))
      $.clock.after(120_000, () => refreshDeploys($))
    }

    return ran
  })

  on('command.run', { command: 'remind' }, async $ => {
    if (off) return { text: `${TITLE} is off. Turn it on with /mods.` }
    await update($, isHidden, () => false)
    void refreshAll($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? `${TITLE} pane opened.` : `${TITLE} pane waits for a wider terminal.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off) return next(e)
    const rows = await read($, todos)
    const now = await read($, today)
    if (e.props.hasSurvey || rows.length === 0 || now === '' || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const due = rows.filter(todo => isDue(todo, now))
    const first = due[0] ?? rows[0]
    if (!first) return next(e)

    return (
      <Box>
        <Text color={due.length > 0 ? 'warning' : 'subtle'} wrap="truncate-end">
          {due.length > 0 ? `${due.length} due · ` : 'Next · '}
          {when(first.due, now)}: {first.text}{' '}
        </Text>
        <Button key="open" label="All" onPress={() => $.ui.open({ id: PANE, title: TITLE })} />
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    if (off)
      return (
        <Box>
          <Text dimColor>Turned off. Open /mods to turn it on.</Text>
        </Box>
      )
    const rows = await read($, todos)
    const now = await read($, today)
    const wrong = await read($, problem)
    const repo = await read($, git)
    const sites = await read($, deploys)
    const nowMs = await $.clock.now()

    return (
      <Box flexDirection="column">
        <Text bold>To do</Text>
        {wrong !== '' && <Text color="error">{wrong}</Text>}
        {wrong === '' && rows.length === 0 && <Text dimColor>Nothing open. Ask Claude: "remind me to … on Friday".</Text>}
        {rows.map(todo => (
          <Text wrap="truncate-end">
            <Text color={isDue(todo, now) ? 'warning' : 'subtle'}>{when(todo.due, now).padEnd(11)}</Text>
            {todo.text}
          </Text>
        ))}

        <Box marginTop={1}>
          <Text bold>Git</Text>
        </Box>
        {repo === null ? (
          <Text dimColor>Not a git folder.</Text>
        ) : (
          <Text>
            {repo.branch}
            <Text color={repo.changed > 0 ? 'warning' : 'success'}>
              {repo.changed > 0 ? ` · ${repo.changed} changed` : ' · clean'}
            </Text>
            {repo.ahead > 0 && <Text color="warning"> · {repo.ahead} to push</Text>}
            {repo.behind > 0 && <Text color="warning"> · {repo.behind} to pull</Text>}
          </Text>
        )}

        {repos.length > 0 && (
          <Box marginTop={1}>
            <Text bold>Deploys</Text>
          </Box>
        )}
        {repos.length > 0 && sites.length === 0 && <Text dimColor>Not checked yet.</Text>}
        {repos.length > 0 && sites[0]?.state === 'no gh' && <Text dimColor>Install the gh CLI and run gh auth login to see deploys.</Text>}
        {repos.length > 0 &&
          sites[0]?.state !== 'no gh' &&
          sites.map(deploy => (
            <Text wrap="truncate-end">
              <Text color={deploy.state === 'success' ? 'success' : deploy.state === 'failure' || deploy.state === 'error' ? 'error' : 'warning'}>
                {deploy.state === 'success' ? '● ' : deploy.state === 'failure' || deploy.state === 'error' ? '✕ ' : '◌ '}
              </Text>
              {deploy.site.padEnd(10)}
              <Text dimColor>
                {deploy.state === 'success' ? 'live' : deploy.state} {deploy.at && `· ${ago(deploy.at, nowMs)}`}
              </Text>
            </Text>
          ))}

        <Box marginTop={1}>
          <Button key="refresh" label="Refresh" onPress={() => refreshAll($)} />
        </Box>
      </Box>
    )
  })
}
