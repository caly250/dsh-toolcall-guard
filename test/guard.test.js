import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, detect } from '../index.js'

const ZW = String.fromCharCode(0x200b)

// ---------------------------------------------------------------------------
// detect(): what counts as "a tool call emitted as assistant text"
// ---------------------------------------------------------------------------

test('detects plain <tool_call> tag with JSON payload', () => {
  assert.ok(detect('<tool_call>{"name":"x"}</tool_call>'))
})

test('detects tag whose name is separated by zero-width characters', () => {
  const text = '<' + ZW + 'tool_call>' + ZW + '{"name":"ops_bash"}'
  assert.ok(detect(text))
})

test('detects <|tool_call|> form', () => {
  assert.ok(detect('<|tool_call|>{"name":"x"}'))
})

test('detects tag with a space before the payload', () => {
  assert.ok(detect('<tool_call> {"name":"x"}'))
})

test('detects plural <tool_calls> tag with array payload', () => {
  assert.ok(detect('<tool_calls>[{"name":"a"}]</tool_calls>'))
})

test('detects bare {"tool_call": ...} JSON that names a tool', () => {
  assert.ok(detect('{"tool_call": {"name": "ops_bash"}}'))
})

test('detects [TOOL_CALL] bracket marker', () => {
  assert.ok(detect('[TOOL_CALL]'))
})

// --- false-positive guards -------------------------------------------------

test('ignores ordinary prose', () => {
  assert.equal(detect('I will run pwd and ls now.'), null)
})

test('ignores prose that mentions tool_call but has no payload', () => {
  assert.equal(detect('The model emitted a tool_call tag instead of a structured block.'), null)
})

test('ignores a tag that is not followed by a JSON payload', () => {
  assert.equal(detect('the <' + ZW + 'tool_call> element in XML'), null)
})

test('ignores a JSON key that does not name a tool', () => {
  assert.equal(detect('{"tool_call": {"id": 5}}'), null)
})

test('ignores an empty tool_call object', () => {
  assert.equal(detect('{"tool_call": {}}'), null)
})

test('ignores a code snippet that merely describes arguments', () => {
  assert.equal(detect('use the ops_bash tool with {"command":"ls"} as arguments'), null)
})

test('ignores a lowercase mention of the toolcalls endpoint', () => {
  assert.equal(detect('the toolcalls endpoint is documented elsewhere'), null)
})

// ---------------------------------------------------------------------------
// apply(): rewrite behaviour against a fake context and fake streams
// ---------------------------------------------------------------------------

function makeCtx() {
  const listeners = {}
  const logs = []
  const ctx = {
    logger: {
      warn: m => logs.push(['warn', m]),
      info: m => logs.push(['info', m]),
      error: m => logs.push(['error', m]),
    },
    on: (event, fn) => {
      listeners[event] = fn
      return () => { delete listeners[event] }
    },
    effect: fn => { const dispose = fn(); return { dispose } },
  }
  return { ctx, listeners, logs }
}

async function collect(listeners, stream) {
  const out = []
  for await (const chunk of listeners['llm/stream']({ provider: 'relay', model: 'm' }, () => stream)) {
    out.push(chunk)
  }
  return out
}

async function* badStream() {
  yield { type: 'text-delta', index: 0, text: 'Sure, let me check. ' }
  yield { type: 'text-delta', index: 0, text: '<tool_call>{"name":"ops_bash","arguments":{}}</tool_call>' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* cleanStream() {
  yield { type: 'text-delta', index: 0, text: 'normal reply with no tags at all' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* discussThenRealCallStream() {
  yield { type: 'text-delta', index: 0, text: 'here is an example tag <tool_call>{"name":"x"}</tool_call> in prose' }
  yield { type: 'tool-call-delta', index: 1, id: 'c9', name: 'ops_bash', argumentsDelta: '{}' }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

test('rewrites a malformed turn into EMPTY_RESPONSE', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const out = await collect(listeners, badStream())
  const finish = out.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('passes a clean turn through untouched', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const out = await collect(listeners, cleanStream())
  const finish = out.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'stop')
})

test('does not rewrite a turn that also carries a real tool call', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  const out = await collect(listeners, discussThenRealCallStream())
  const finish = out.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
})

test('logOnly leaves the malformed turn untouched', async () => {
  const { ctx, listeners, logs } = makeCtx()
  apply(ctx, { logOnly: true })
  const out = await collect(listeners, badStream())
  const finish = out.at(-1)
  assert.equal(finish.reason.kind, 'stop')
  assert.ok(logs.some(([, m]) => m.includes('dsh-toolcall-guard')))
})

test('honours providerPattern', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { providerPattern: 'other' })
  const out = []
  for await (const chunk of listeners['llm/stream']({ provider: 'relay', model: 'm' }, () => badStream())) {
    out.push(chunk)
  }
  assert.equal(out.at(-1).reason.kind, 'stop')
})

test('passes an upstream error finish through unchanged', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  async function* errorStream() {
    yield { type: 'text-delta', index: 0, text: 'partial' }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: 'upstream timed out' } } }
  }
  const out = await collect(listeners, errorStream())
  assert.equal(out.at(-1).reason.failure.code, 'TIMEOUT')
})
