import { expect, test } from 'claude-code/testing'

import { addressed, clip, curlQuote, describeTool, parseUpdate, route, speakable, uniqueName, verdict, type SessionRec } from '../hooks/lib.ts'

const now = 1_000_000
const s = (id: string, lastSent: number, beat = now): SessionRec => ({ id, name: id, cwd: `/x/${id}`, beat, lastSent })

test('a reply goes to the session that sent the message it answers', async () => {
  const sessions = [s('api', 10), s('web', 99)]
  expect(route(7, id => (id === 7 ? 'api' : undefined), sessions, now)).toBe('api')
})

test('otherwise it goes to the live session that spoke last', async () => {
  expect(route(undefined, () => undefined, [s('api', 10), s('web', 99)], now)).toBe('web')
  expect(route(7, () => 'gone', [s('api', 10)], now)).toBe('api')
})

test('dead sessions get nothing', async () => {
  expect(route(undefined, () => undefined, [s('api', 10, 0)], now)).toBe(undefined)
  expect(route(7, () => 'api', [s('api', 10, 0), s('web', 1)], now)).toBe('web')
})

test('@name picks a session', async () => {
  expect(addressed('@web run the tests', [s('api', 0), s('web', 0)])).toEqual({ id: 'web', text: 'run the tests' })
  expect(addressed('@nope hi', [s('api', 0)])).toBe(undefined)
  expect(addressed('hello', [s('api', 0)])).toBe(undefined)
})

test('spoken yes and no', async () => {
  expect(verdict('Yeah, go ahead.')).toBe('allow')
  expect(verdict('OK')).toBe('allow')
  expect(verdict("No, don't do that, use pnpm")).toBe('deny')
  expect(verdict('Hold on, wait')).toBe('deny')
  expect(verdict('use pnpm instead')).toBe(undefined)
  expect(verdict('nothing')).toBe(undefined)
})

test('updates parse into items', async () => {
  const voice = parseUpdate({ update_id: 1, message: { message_id: 5, chat: { id: 9 }, voice: { file_id: 'F' }, reply_to_message: { message_id: 4 } } })
  expect(voice).toEqual({ chat: 9, item: { kind: 'voice', text: 'F', msgId: 5 }, replyTo: 4 })
  const btn = parseUpdate({ update_id: 2, callback_query: { id: 'q', data: 'ab:allow', message: { message_id: 8, chat: { id: 9 } } } })
  expect(btn).toEqual({ chat: 9, item: { kind: 'button', text: 'ab:allow', msgId: 8 }, replyTo: 8 })
  expect(parseUpdate({ update_id: 3 })).toEqual({})
})

test('tools describe themselves', async () => {
  expect(describeTool('Bash', { command: 'rm -rf dist', description: 'Delete the build folder' })).toEqual({ say: 'run a command: Delete the build folder', detail: 'rm -rf dist' })
  expect(describeTool('Edit', { file_path: '/a/b/app.ts' }).say).toBe('edit app.ts')
  expect(describeTool('mcp__github__create_pr', {}).say).toBe('use the github create_pr tool')
})

test('text becomes speakable', async () => {
  expect(speakable('## Done\nFixed `foo()` in [app](http://x). See https://x.y\n```js\nx\n```')).toBe('Done Fixed foo() in app. See a link (code)')
  expect(clip('one two three four', 10)).toBe('one two…')
  expect(curlQuote('a "b"\nc\\')).toBe('"a \\"b\\"\\nc\\\\"')
  expect(uniqueName('My App', ['my-app'])).toBe('my-app-2')
})
