import type { EngineInterface, Register } from 'claude-code'

import {
  addressed,
  clip,
  curlQuote,
  describeTool,
  hasMore,
  parseUpdate,
  route,
  speakable,
  STALE_MS,
  uniqueName,
  verdict,
  type Item,
  type SessionRec,
  type TgUpdate,
} from './lib.ts'

type $ = EngineInterface
type Config = {
  token?: string
  bot?: string
  chatId?: number
  pairCode?: string
  connectAll?: boolean
  voice?: string
}
type Answer = { button: boolean; text: string }

const TICK_MS = 2_000
const WAIT_MS = 60 * 60_000 // a phone answer can take a while; after this the local dialog takes over
const NUDGE_GAP_MS = 90_000
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'

const SUMMARY_SYSTEM = `You turn a coding assistant's final message into a short voice note for its user, who is away from the computer and listening on a phone.
At most three short sentences of plain spoken English. No markdown, no code, no file paths unless essential, no lists.
Speak as the assistant, in the first person. If the message ends by asking the user something, end with that question.`

const SETUP_HELP = `call-it isn't set up yet. Two minutes:

  1. In Telegram, open @BotFather and send /newbot. Pick any name.
  2. Copy the token it gives you (looks like 123456:ABC-xyz…).
  3. Run:  /callit setup <token>`

// Paths and identity, filled at session.start. A reload refills them.
let API = 'https://api.telegram.org'
let DIR = ''
let sid = ''
let cwd = ''
let name = ''
let connected = false
let busy = false
let lastSentAt = 0
let pending: { nonce: string; answer?: Answer } | null = null

const p = {
  cfg: () => `${DIR}/config.json`,
  sessions: () => `${DIR}/sessions`,
  rec: (id = sid) => `${DIR}/sessions/${id}.json`,
  inbox: (id = sid) => `${DIR}/inbox/${id}`,
  sent: (msg: number) => `${DIR}/sent/${msg}`,
  tmp: () => `${DIR}/tmp`,
  model: () => `${DIR}/models/ggml-base.bin`,
  lock: () => `${DIR}/lock`,
  offset: () => `${DIR}/offset`,
}

// ---------- small host helpers ----------

const run = ($: $, argv: string[], init?: { stdin?: string; timeoutMs?: number }) => $.process.run(argv, init)
const rm = ($: $, ...paths: string[]) => run($, ['rm', '-rf', ...paths])
const nap = ($: $) => run($, ['sleep', '1'])

async function readText($: $, path: string): Promise<string | undefined> {
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined
}

async function readCfg($: $): Promise<Config> {
  const t = await readText($, p.cfg())
  return t ? (JSON.parse(t) as Config) : {}
}

async function saveCfg($: $, cfg: Config) {
  await $.fs.write(p.cfg(), JSON.stringify(cfg, null, 2))
  await run($, ['chmod', '600', p.cfg()]) // it holds the bot token
}

async function liveSessions($: $): Promise<SessionRec[]> {
  const now = Date.now()
  const out: SessionRec[] = []
  for (const f of await $.fs.list(p.sessions()).catch(() => [])) {
    if (!f.name.endsWith('.json')) continue
    try {
      const rec = JSON.parse(String(await $.fs.read(`${p.sessions()}/${f.name}`))) as SessionRec
      if (now - rec.beat < STALE_MS) out.push(rec)
    } catch {} // a half-written record: next tick
  }
  return out
}

async function writeRec($: $) {
  const rec: SessionRec = { id: sid, name, cwd, beat: Date.now(), lastSent: lastSentAt }
  await $.fs.write(p.rec(), JSON.stringify(rec))
}

// ---------- Telegram ----------

async function tg<T = any>($: $, cfg: Config, method: string, params: object = {}): Promise<T> {
  const r = await $.http.fetch(`${API}/bot${cfg.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  let j: { ok?: boolean; result?: T; description?: string } = {}
  try {
    j = JSON.parse(r.text)
  } catch {}
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? `HTTP ${r.status}`}`)
  return j.result as T
}

/** curl with its config on stdin, so the bot token never shows in `ps`. */
async function curl($: $, lines: string[]) {
  return run($, ['curl', '-sS', '--max-time', '120', '-K', '-'], { stdin: lines.join('\n') + '\n', timeoutMs: 125_000 })
}

async function remember($: $, msgId: number) {
  await $.fs.write(p.sent(msgId), sid)
  lastSentAt = Date.now()
  if (connected) await writeRec($)
}

async function sendText($: $, cfg: Config, text: string, extra: object = {}): Promise<number> {
  const m = await tg<{ message_id: number }>($, cfg, 'sendMessage', { chat_id: cfg.chatId, text: clip(text, 4000), ...extra })
  await remember($, m.message_id)
  return m.message_id
}

/** Speak `spoken` into a voice note and send it with `caption`; text alone if the voice fails. */
async function sendVoice($: $, cfg: Config, spoken: string, caption: string, markup?: object): Promise<number> {
  const id = crypto.randomUUID()
  const aiff = `${p.tmp()}/${id}.aiff`
  const ogg = `${p.tmp()}/${id}.ogg`
  try {
    const said = await run($, ['say', '-o', aiff, ...(cfg.voice ? ['-v', cfg.voice] : []), '-f', '-'], { stdin: spoken, timeoutMs: 60_000 })
    if (said.exitCode) throw new Error(`say: ${said.stderr}`)
    const enc = await run($, ['ffmpeg', '-y', '-loglevel', 'error', '-i', aiff, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', ogg])
    if (enc.exitCode) throw new Error(`ffmpeg: ${enc.stderr}`)
    const lines = [
      `url = ${curlQuote(`${API}/bot${cfg.token}/sendVoice`)}`,
      `form = ${curlQuote(`chat_id=${cfg.chatId}`)}`,
      `form = ${curlQuote(`voice=@${ogg}`)}`,
      `form-string = ${curlQuote(`caption=${clip(caption, 1000)}`)}`,
    ]
    if (markup) lines.push(`form-string = ${curlQuote(`reply_markup=${JSON.stringify(markup)}`)}`)
    const sent = await curl($, lines)
    const j = JSON.parse(sent.stdout || '{}')
    if (!j.ok) throw new Error(`sendVoice: ${j.description ?? sent.stderr}`)
    await remember($, j.result.message_id)
    return j.result.message_id
  } catch (err) {
    $.ui.log(`call-it: voice failed, sent text instead (${String(err).slice(0, 200)})`, { to: 'debug' })
    return sendText($, cfg, caption, markup ? { reply_markup: markup } : {})
  } finally {
    await rm($, aiff, ogg)
  }
}

async function transcribe($: $, cfg: Config, fileId: string): Promise<string> {
  if (!(await $.fs.exists(p.model()))) throw new Error('model')
  const f = await tg<{ file_path: string }>($, cfg, 'getFile', { file_id: fileId })
  const id = crypto.randomUUID()
  const oga = `${p.tmp()}/${id}.oga`
  const wav = `${p.tmp()}/${id}.wav`
  try {
    await curl($, [`url = ${curlQuote(`${API}/file/bot${cfg.token}/${f.file_path}`)}`, `output = ${curlQuote(oga)}`])
    await run($, ['ffmpeg', '-y', '-loglevel', 'error', '-i', oga, '-ar', '16000', '-ac', '1', wav])
    const w = await run($, ['whisper-cli', '-m', p.model(), '-f', wav, '-nt', '-np', '-l', 'auto'], { timeoutMs: 120_000 })
    return w.stdout.replace(/\[[A-Z_ ]+\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  } finally {
    await rm($, oga, wav)
  }
}

// ---------- the shared poller ----------

/** Whoever holds the lock polls Telegram and files each update in its session's inbox. */
async function pump($: $, cfg: Config) {
  if ((await run($, ['mkdir', p.lock()])).exitCode !== 0) {
    const st = await $.fs.stat(p.lock()).catch(() => undefined)
    if (st && Date.now() - st.mtimeMs > 30_000) await rm($, p.lock()) // its holder died
    return
  }
  try {
    const offset = Number((await readText($, p.offset())) ?? 0)
    const ups = await tg<TgUpdate[]>($, cfg, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message', 'callback_query'] })
    for (const u of ups) {
      await $.fs.write(p.offset(), String(u.update_id + 1)) // first, so a bad update is never retried forever
      await file($, cfg, u)
    }
  } finally {
    await rm($, p.lock())
  }
}

async function file($: $, cfg: Config, u: TgUpdate) {
  const { chat, item, replyTo } = parseUpdate(u)
  if (u.callback_query) void tg($, cfg, 'answerCallbackQuery', { callback_query_id: u.callback_query.id }).catch(() => {})
  if (!item || chat === undefined) return

  if (cfg.chatId === undefined) {
    if (cfg.pairCode && item.kind === 'text' && item.text.trim() === `/start ${cfg.pairCode}`) {
      cfg.chatId = chat
      delete cfg.pairCode
      await saveCfg($, cfg)
      await sendVoice(
        $,
        cfg,
        `Hi! This is call-it. I'm connected to ${name || 'Claude Code'}. When a session finishes, needs a permission, or has a question, I'll send you a voice note. Just reply with your voice.`,
        `📞 call-it is paired.\n\nYou'll get a voice note when a connected Claude session finishes, needs permission, or asks you something. Reply with a voice note or text.\n\n• Swipe-reply to a message to answer that session\n• Start with @name to pick a session\n• /sessions lists connected sessions`,
      )
    }
    return
  }
  if (chat !== cfg.chatId) return // only the paired chat may talk to Claude

  const sessions = await liveSessions($)
  if (item.kind === 'text' && /^\/(start|sessions|help)\b/.test(item.text)) {
    const list = sessions.map(s => `• @${s.name}  —  ${s.cwd}`).join('\n')
    await sendText($, cfg, list ? `Connected sessions:\n${list}\n\nSwipe-reply to a session's message, or start with @name.` : 'No Claude session is connected. Run /callit in one.')
    return
  }
  const at = item.kind === 'text' ? addressed(item.text, sessions) : undefined
  const owner = replyTo === undefined ? undefined : await readText($, p.sent(replyTo))
  const target = at?.id ?? route(replyTo, () => owner, sessions, Date.now())
  if (!target) {
    await sendText($, cfg, 'No Claude session is connected right now. Run /callit in one.')
    return
  }
  await run($, ['mkdir', '-p', p.inbox(target)])
  await $.fs.write(`${p.inbox(target)}/${String(u.update_id).padStart(12, '0')}.json`, JSON.stringify(at ? { ...item, text: at.text } : item))
}

/** This session's inbox: answers to a waiting question, or new prompts. */
async function drain($: $, cfg: Config) {
  const files = (await $.fs.list(p.inbox()).catch(() => []))
    .map(f => f.name)
    .filter(n => n.endsWith('.json'))
    .sort()
  for (const f of files) {
    const path = `${p.inbox()}/${f}`
    const item = JSON.parse(String(await $.fs.read(path))) as Item
    await rm($, path)
    await receive($, cfg, item)
  }
}

async function receive($: $, cfg: Config, item: Item) {
  let text = item.text
  if (item.kind === 'voice') {
    try {
      text = await transcribe($, cfg, item.text)
    } catch (err) {
      const why = String(err).includes('model')
        ? 'The speech model is still downloading. Send text for now, or try again in a minute.'
        : `I couldn't transcribe that (${String(err).slice(0, 120)}).`
      await sendText($, cfg, why, { reply_to_message_id: item.msgId })
      return
    }
    if (!text) {
      await sendText($, cfg, "I couldn't make that out. Try again?", { reply_to_message_id: item.msgId })
      return
    }
    void tg($, cfg, 'sendMessage', { chat_id: cfg.chatId, text: `🎙 “${text}”`, reply_to_message_id: item.msgId }).catch(() => {})
  } else {
    void tg($, cfg, 'setMessageReaction', { chat_id: cfg.chatId, message_id: item.msgId, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => {})
  }

  if (item.kind === 'button') {
    const [nonce, value = ''] = text.split(':')
    if (pending && !pending.answer && nonce === pending.nonce) pending.answer = { button: true, text: value }
    else await sendText($, cfg, 'That button is from a question that was already answered.')
    return
  }
  if (pending && !pending.answer) {
    pending.answer = { button: false, text }
    return
  }
  void $.prompt.submit({ text, asUser: true }) // not awaited: it resolves only when the turn starts
}

async function tick($: $) {
  if (busy) return
  busy = true
  try {
    const cfg = await readCfg($)
    if (!cfg.token || (!connected && !cfg.pairCode)) return
    if (connected) await writeRec($)
    await pump($, cfg)
    if (connected) await drain($, cfg)
  } catch (err) {
    $.ui.log(`call-it: ${String(err).slice(0, 300)}`, { to: 'debug' })
  } finally {
    busy = false
  }
}

/** Send a question to the phone and wait for the answer; undefined if none came. */
async function ask($: $, signal: AbortSignal, spoken: string, caption: string, buttons: [string, string][]): Promise<Answer | undefined> {
  while (pending && !signal.aborted) await nap($) // one question at a time
  const cfg = await readCfg($)
  if (cfg.chatId === undefined) return undefined
  const nonce = Math.random().toString(36).slice(2, 8)
  pending = { nonce }
  try {
    const keyboard = buttons.map(([label, value]) => [{ text: label, callback_data: `${nonce}:${value}` }])
    await sendVoice($, cfg, spoken, caption, { inline_keyboard: keyboard })
    const until = Date.now() + WAIT_MS
    while (!pending.answer && !signal.aborted && Date.now() < until) {
      await tick($)
      if (!pending.answer) await nap($)
    }
    return pending.answer
  } finally {
    pending = null
  }
}

async function summarize($: $, answer: string): Promise<string> {
  if (answer.length < 280) return speakable(answer) // already short enough to say
  const prompt = `The assistant's final message:\n<message>\n${clip(answer, 8000)}\n</message>\nWrite the voice note.`
  const r = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 300, system: SUMMARY_SYSTEM, prompt })
  return r.isAnswered && r.text.trim() ? speakable(r.text) : clip(speakable(answer), 400)
}

async function approves($: $, request: string, reply: string): Promise<boolean> {
  const quick = verdict(reply)
  if (quick) return quick === 'allow'
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 5,
    system: 'Decide whether the reply approves the request. Answer with exactly one word: ALLOW or DENY.',
    prompt: `Request: ${request}\nReply: ${reply}`,
  })
  return r.isAnswered && /allow/i.test(r.text) // anything unclear is a no
}

// ---------- connecting ----------

async function connect($: $, want?: string) {
  const others = (await liveSessions($)).filter(s => s.id !== sid).map(s => s.name)
  name = uniqueName(want ?? (cwd.split('/').pop() || 'claude'), others)
  connected = true
  await run($, ['mkdir', '-p', p.inbox()])
  await writeRec($)
  $.ui.status(`📞 call-it · @${name}`)
}

async function disconnect($: $) {
  connected = false
  await rm($, p.rec(), p.inbox())
  $.ui.status(undefined)
}

async function missingDeps($: $): Promise<string[]> {
  const missing: string[] = []
  for (const [bin, pkg] of [['ffmpeg', 'ffmpeg'], ['whisper-cli', 'whisper-cpp'], ['say', 'macOS say']] as const) {
    if ((await run($, ['sh', '-c', `command -v ${bin}`])).exitCode !== 0) missing.push(pkg)
  }
  return missing
}

function fetchModel($: $) {
  void run($, ['sh', '-c', 'curl -fsSL -o "$1.part" "$2" && mv "$1.part" "$1"', 'sh', p.model(), MODEL_URL], { timeoutMs: 600_000 })
}

async function setup($: $, token: string): Promise<string> {
  if (!/^\d+:[\w-]{20,}$/.test(token)) return `That doesn't look like a bot token (it should look like 123456:ABC-xyz…).\n\n${SETUP_HELP}`
  let bot: { username: string }
  try {
    bot = await tg($, { token }, 'getMe')
    await tg($, { token }, 'deleteWebhook') // getUpdates refuses to run while a webhook is set
  } catch (err) {
    return `Telegram rejected that token: ${String(err)}`
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, '0')
  const cfg = await readCfg($)
  await saveCfg($, { ...cfg, token, bot: bot.username, pairCode: code, chatId: undefined })
  await rm($, p.offset())
  await connect($, connected ? name : undefined)

  const lines = [`✅ Bot @${bot.username} is ready.`, '', 'On your phone, open this link and tap Start:', `   https://t.me/${bot.username}?start=${code}`, '']
  if (!(await $.fs.exists(p.model()))) {
    fetchModel($)
    lines.push('⏬ Downloading the speech model (~140 MB) in the background.')
  }
  const missing = await missingDeps($)
  if (missing.includes('macOS say')) lines.push('⚠️  call-it speaks with macOS `say`; on other systems it sends text only.')
  const brew = missing.filter(m => m !== 'macOS say')
  if (brew.length) {
    lines.push(`🔧 Missing: ${brew.join(', ')}. Asking Claude to install them…`)
    void $.prompt.submit({ text: `call-it needs ${brew.join(' and ')} for voice notes. Please install them (on macOS: brew install ${brew.join(' ')}), then confirm with \`command -v ffmpeg whisper-cli\`.` })
  }
  lines.push('', 'This session is connected. Run /callit in any other session to connect it too, or /callit all for every session.')
  return lines.join('\n')
}

async function status($: $): Promise<string> {
  const cfg = await readCfg($)
  const live = await liveSessions($)
  const missing = await missingDeps($)
  return [
    `call-it`,
    `  bot:      ${cfg.bot ? '@' + cfg.bot : 'not set up (/callit setup <token>)'}`,
    `  phone:    ${cfg.chatId !== undefined ? 'paired' : cfg.pairCode && cfg.bot ? `not paired: https://t.me/${cfg.bot}?start=${cfg.pairCode}` : 'not paired'}`,
    `  this:     ${connected ? `connected as @${name}` : 'not connected (/callit)'}`,
    `  all:      ${cfg.connectAll ? 'every new session connects' : 'only sessions you connect'}`,
    `  sessions: ${live.map(s => '@' + s.name).join(', ') || 'none'}`,
    `  voice:    ${(await $.fs.exists(p.model())) ? 'speech model ready' : 'speech model missing (re-run /callit setup)'}${missing.length ? `; missing ${missing.join(', ')}` : ''}`,
  ].join('\n')
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    API = (await $.env.get('CALLIT_API')) ?? API
    DIR = (await $.env.get('CALLIT_DIR')) ?? `${await $.env.get('HOME')}/.claude/call-it`
    sid = await $.session.id()
    cwd = await $.session.cwd()
    await run($, ['mkdir', '-p', p.sessions(), `${DIR}/sent`, p.tmp(), `${DIR}/models`, `${DIR}/inbox`])
    await $.command.register({
      name: 'callit',
      description: 'Talk to this session from your phone (voice notes over Telegram)',
      argumentHint: '[setup <token> | all | off | status | test | name <label>]',
    })
    const cfg = await readCfg($)
    const prev = await readText($, p.rec())
    if (prev) await connect($, (JSON.parse(prev) as SessionRec).name) // a reload: stay as we were
    else if (cfg.connectAll && cfg.token) await connect($)
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (connected) await rm($, p.rec(), p.inbox())
    return next(e)
  })

  on('command.run', { command: 'callit' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const cfg = await readCfg($)
    const text = await (async (): Promise<string> => {
      if (sub === 'setup') return arg ? setup($, arg) : SETUP_HELP
      if (sub === 'status') return status($)
      if (!cfg.token) return SETUP_HELP
      if (cfg.chatId === undefined) return `Almost there: open https://t.me/${cfg.bot}?start=${cfg.pairCode} on your phone and tap Start.`
      switch (sub) {
        case '':
          if (connected) {
            await disconnect($)
            return '📴 This session is disconnected from your phone.'
          }
          await connect($)
          return `📞 Connected as @${name}. Finished tasks, permission prompts and questions now go to your phone.`
        case 'off':
          await disconnect($)
          return '📴 This session is disconnected from your phone.'
        case 'all':
          await saveCfg($, { ...cfg, connectAll: !cfg.connectAll })
          if (!cfg.connectAll && !connected) await connect($)
          return cfg.connectAll ? 'New sessions no longer connect on their own.' : `Every new session now connects to your phone.${connected ? ` This one is @${name}.` : ''}`
        case 'name':
          if (!arg) return 'Usage: /callit name <label>'
          await connect($, arg)
          return `📞 This session is now @${name}.`
        case 'test':
          if (!connected) await connect($)
          await sendVoice($, cfg, `This is ${name}. call-it is working. Reply to this message to talk to me.`, `🧪 @${name}: test voice note. Reply with your voice to send me a prompt.`)
          return '📨 Sent a test voice note to your phone.'
        default:
          return 'Usage: /callit [setup <token> | all | off | status | test | name <label>]'
      }
    })()
    return { text }
  })

  // Task finished: a short spoken summary, plus the full answer as text.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!connected || e.agentId || e.isAborted) return r
    try {
      const cfg = await readCfg($)
      if (cfg.chatId === undefined) return r
      if (e.reason === 'answer' && e.answer.trim()) {
        const spoken = await summarize($, e.answer)
        const voice = await sendVoice($, cfg, spoken, `✅ @${name} is done\n\n${spoken}`)
        if (e.answer.length > spoken.length + 200) await sendText($, cfg, e.answer, { reply_to_message_id: voice })
      } else if (e.reason !== 'answer') {
        await sendVoice($, cfg, `${name} stopped because of an error.`, `⚠️ @${name} stopped: ${e.reason}`)
      }
    } catch (err) {
      $.ui.log(`call-it: ${String(err).slice(0, 300)}`, { to: 'debug' })
    }
    return r
  })

  // Permission prompts go to the phone while connected.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision !== 'ask' || !connected || !e.tool_use_id || e.tool === 'AskUserQuestion') return r
    const { say, detail } = describeTool(e.tool, e.input)
    const request = `${name} wants to ${say}`
    const ans = await ask(
      $,
      next.signal,
      `${request}. Allow it?`,
      `🔐 @${request}\n\n${clip(detail, 700)}\n\nTap a button, or reply by voice: "yes", or "no, do X instead".`,
      [['✅ Allow', 'allow'], ['❌ Deny', 'deny']],
    )
    if (!ans) return r // no answer: the local dialog takes over
    const ok = ans.button ? ans.text === 'allow' : await approves($, request, ans.text)
    if (!ok) {
      return { decision: 'deny', reason: ans.button ? 'The user denied this from their phone.' : `The user denied this from their phone and said: "${ans.text}"` }
    }
    if (!ans.button && hasMore(ans.text)) {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `(From my phone, while approving ${e.tool}:) ${ans.text}` }] } }).catch(() => {})
    }
    return { decision: 'allow', reason: 'The user approved this from their phone.' }
  })

  // Questions: options as buttons, or any spoken answer.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (!connected) return next(e)
    const answers: Record<string, string> = {}
    for (const q of e.questions) {
      const opts = q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
      const ans = await ask(
        $,
        next.signal,
        `${name} has a question. ${q.question} The options are: ${q.options.map(o => o.label).join(', or ')}.`,
        `❓ @${name} asks — ${q.header}\n\n${q.question}\n\n${opts}\n\n${q.multiSelect ? 'Tap one, or reply with several.' : 'Tap one, or reply with anything else.'}`,
        q.options.map((o, i) => [o.label, String(i)]),
      )
      if (!ans) return next(e) // no answer: ask locally
      answers[q.question] = ans.button ? (q.options[Number(ans.text)]?.label ?? ans.text) : ans.text
    }
    return { result: { questions: e.questions, answers } }
  })

  // Waiting-for-you nudges, unless something was just sent.
  on('classic.Notification', async ($, e, next) => {
    const r = await next(e)
    if (!connected || pending || e.notification_type === 'permission_prompt' || Date.now() - lastSentAt < NUDGE_GAP_MS) return r
    const cfg = await readCfg($)
    if (cfg.chatId !== undefined) await sendVoice($, cfg, `${name}: ${e.message}`, `🔔 @${name}: ${e.message}`).catch(() => {})
    return r
  })
}
