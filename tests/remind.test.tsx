import type { On, ToolCallResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const LIST = '/home/t/.claude/remind/reminders.json'

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// The engine beneath the plugin: files in memory, today is 2026-10-25, no git folder.
function engine(on: On, files: Map<string, string>, osascript: (argv: readonly string[]) => string = () => '') {
  const ran: (readonly string[])[] = []
  mock.clock(on)
  mock.env(on, { HOME: '/home/t' })
  on('command.register', () => ({ value: { command: 'remind' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__remind__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on('process.run', (_, e) => {
    ran.push(e.argv)
    if (e.argv[0] === 'date') return ok('2026-10-25\n')
    if (e.argv[0] === '/usr/bin/osascript') return ok(osascript(e.argv))
    return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return ran
}

// The mod's tools are typed only once a session registers them.
const call = ($: { tool: { call: (input: never) => Promise<unknown> } }, tool: string, args: Record<string, string> = {}) =>
  $.tool.call({ tool, ...args } as never) as Promise<ToolCallResult>

const band = (surface: (typeof SURFACES)[number]) =>
  ({ plugin: 'remind', surface, component: 'AbovePrompt', requestId: 'b1', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 80, scroll: { offset: 0, bodyRows: 3 }, view: {} } }) as const

const pane = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'remind',
    surface,
    component: 'Pane',
    requestId: 'remind',
    props: { title: 'Reminders', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  }) as const

test('Claude adds, lists and completes reminders in the local list', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const added = await call($, 'mcp__remind__add_reminder', { text: 'Renew the domain', due: '2026-10-24' })
  expect(added.result).toBe('Added to your local list: 2026-10-24  Renew the domain')
  await call($, 'mcp__remind__add_reminder', { text: 'Call the dentist' })
  expect(JSON.parse(files.get(LIST) ?? '[]')).toEqual([
    { text: 'Renew the domain', due: '2026-10-24' },
    { text: 'Call the dentist', due: '-' },
  ])

  const listed = await call($, 'mcp__remind__list_reminders')
  expect(listed.result).toBe('2026-10-24  Renew the domain\nCall the dentist')

  // An overdue reminder shows in the band, on every surface.
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /1 due · 1d overdue: Renew the domain/ })).toBeDefined()
    await ui.unmount()
  }

  const done = await call($, 'mcp__remind__complete_reminder', { text: 'DOMAIN' })
  expect(done.result).toBe('Done: 2026-10-24  Renew the domain')
  expect(JSON.parse(files.get(LIST) ?? '[]')).toEqual([{ text: 'Call the dentist', due: '-' }])

  const missing = await call($, 'mcp__remind__complete_reminder', { text: 'dentistry' })
  expect('deny' in missing && missing.deny).toBe('No open reminder in your local list contains "dentistry".')
})

test('a due date that is not YYYY-MM-DD is refused', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const added = await call($, 'mcp__remind__add_reminder', { text: 'Pay rent', due: 'Friday' })
  expect('deny' in added && added.deny).toBe('Give the due date as YYYY-MM-DD.')
  expect(files.has(LIST)).toBe(false)
})

test('with no repos set, the pane shows reminders and git but no deploys', async ($, on) => {
  const files = new Map([[LIST, '[{ "text": "Ship the README", "due": "2026-10-30" }]']])
  engine(on, files)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await call($, 'mcp__remind__list_reminders')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: /Ship the README/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Not a git folder/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Deploys$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with source apple, reminders go to the named Reminders list', { options: { source: 'apple', appleList: 'Work' } }, async ($, on) => {
  const files = new Map<string, string>()
  const ran = engine(on, files, argv => (argv.length === 3 ? '2026-10-26\tSend the invoice\n' : ''))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const added = await call($, 'mcp__remind__add_reminder', { text: 'Send the invoice', due: '2026-10-26' })
  expect(added.result).toBe('Added to your Reminders list "Work": 2026-10-26  Send the invoice')
  expect(ran).toContainEqual(['/usr/bin/osascript', '-', 'Work', 'Send the invoice', '2026-10-26'])
  expect(files.has(LIST)).toBe(false)

  const listed = await call($, 'mcp__remind__list_reminders')
  expect(listed.result).toBe('2026-10-26  Send the invoice')

  await call($, 'mcp__remind__complete_reminder', { text: 'invoice' })
  expect(ran).toContainEqual(['/usr/bin/osascript', '-', 'Work', 'Send the invoice'])
})
