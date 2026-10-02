// Pure logic: no `$`, so tests can run it directly.

export type Item = {
  kind: 'text' | 'voice' | 'button'
  text: string // the text, the voice's file_id, or the button's callback data
  msgId: number
}

export type SessionRec = {
  id: string
  name: string
  cwd: string
  beat: number // last heartbeat, ms
  lastSent: number // last time this session messaged the phone, ms
}

export type TgUpdate = {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number }
    text?: string
    voice?: { file_id: string }
    audio?: { file_id: string }
    reply_to_message?: { message_id: number }
  }
  callback_query?: {
    id: string
    data?: string
    message?: { message_id: number; chat: { id: number } }
  }
}

export const STALE_MS = 30_000

/** The chat an update came from, the item it carries, and the bot message it answers. */
export function parseUpdate(u: TgUpdate): { chat?: number; item?: Item; replyTo?: number } {
  if (u.callback_query) {
    const m = u.callback_query.message
    return {
      chat: m?.chat.id,
      item: { kind: 'button', text: u.callback_query.data ?? '', msgId: m?.message_id ?? 0 },
      replyTo: m?.message_id,
    }
  }
  const m = u.message
  if (!m) return {}
  const voice = m.voice ?? m.audio
  const item: Item | undefined = voice
    ? { kind: 'voice', text: voice.file_id, msgId: m.message_id }
    : m.text
      ? { kind: 'text', text: m.text, msgId: m.message_id }
      : undefined
  return { chat: m.chat.id, item, replyTo: m.reply_to_message?.message_id }
}

/**
 * Which session an incoming message is for: the one that sent the message it
 * replies to (or whose button was pressed), else the live session that spoke last.
 */
export function route(
  replyTo: number | undefined,
  sentBy: (msgId: number) => string | undefined,
  sessions: readonly SessionRec[],
  now: number,
): string | undefined {
  const live = sessions.filter(s => now - s.beat < STALE_MS)
  const owner = replyTo === undefined ? undefined : sentBy(replyTo)
  if (owner && live.some(s => s.id === owner)) return owner
  return [...live].sort((a, b) => b.lastSent - a.lastSent || b.beat - a.beat)[0]?.id
}

/** `@name rest` addresses a session by name; returns the session and the rest. */
export function addressed(text: string, sessions: readonly SessionRec[]): { id: string; text: string } | undefined {
  const m = /^@(\S+)\s*([\s\S]*)$/.exec(text.trim())
  if (!m) return undefined
  const s = sessions.find(s => s.name.toLowerCase() === m[1]!.toLowerCase())
  return s && { id: s.id, text: m[2]! }
}

/** A spoken or typed yes/no, or undefined when it is neither on its face. */
export function verdict(text: string): 'allow' | 'deny' | undefined {
  const t = text.toLowerCase().replace(/[^a-z' ]+/g, ' ').trim()
  if (/^(no|nope|nah|deny|denied|don't|do not|dont|stop|cancel|reject|never|wait|hold on)\b/.test(t)) return 'deny'
  if (/^(yes|yeah|yep|yup|ya|sure|ok|okay|allow|approve|approved|go|do it|go ahead|fine|alright|all right|sounds good|please do|absolutely|of course|confirm)\b/.test(t)) return 'allow'
  return undefined
}

/** True when a reply says more than its yes/no, so the rest is worth passing on. */
export function hasMore(text: string): boolean {
  return text.trim().split(/\s+/).length > 3
}

const base = (p: unknown) => String(p ?? '').split('/').pop() || String(p ?? '')

/** What a tool call does, as a phrase to speak and a detail to read. */
export function describeTool(tool: string, input: unknown): { say: string; detail: string } {
  const i = (input ?? {}) as Record<string, unknown>
  switch (tool) {
    case 'Bash':
      return { say: `run a command: ${i.description ?? 'see the message'}`, detail: String(i.command ?? '') }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { say: `${tool === 'Write' ? 'write' : 'edit'} ${base(i.file_path ?? i.notebook_path)}`, detail: String(i.file_path ?? i.notebook_path ?? '') }
    case 'WebFetch':
      return { say: `fetch a web page from ${hostOf(i.url)}`, detail: String(i.url ?? '') }
    case 'WebSearch':
      return { say: `search the web for ${i.query}`, detail: String(i.query ?? '') }
    case 'ExitPlanMode':
      return { say: 'start building its plan', detail: String(i.plan ?? '') }
    default:
      return { say: `use the ${tool.replace(/^mcp__/, '').replace(/__/g, ' ')} tool`, detail: JSON.stringify(i, null, 1) }
  }
}

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host
  } catch {
    return 'the web'
  }
}

/** Markdown and code out, so a speech synthesizer reads it sensibly. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cut to `n` characters at a word boundary. */
export function clip(text: string, n: number): string {
  if (text.length <= n) return text
  const cut = text.slice(0, n - 1)
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n / 2)) + '…'
}

/** A value for a double-quoted string in a curl config file. */
export function curlQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
}

/** A unique, readable name for a session, given the names already live. */
export function uniqueName(want: string, taken: readonly string[]): string {
  const clean = want.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'claude'
  if (!taken.includes(clean)) return clean
  for (let n = 2; ; n++) if (!taken.includes(`${clean}-${n}`)) return `${clean}-${n}`
}
