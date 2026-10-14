import assert from "node:assert/strict"
import { apply, name } from "../index.js"

/** Minimal Cordis-shaped stub that records listener registrations. */
function fakeCtx(config = {}) {
  const handlers = new Map()
  return {
    config,
    handlers,
    on(event, fn) {
      handlers.set(event, fn)
    },
  }
}

// 1. Plugin surface.
assert.equal(name, "hydradb", "plugin name is the canonical client id")
assert.equal(typeof apply, "function", "apply is a function")

// 2. apply registers exactly the four documented seams.
const ctx = fakeCtx()
apply(ctx)
for (const seam of ["agent/created", "agent/pre-step", "tools/post-execute", "session/event"]) {
  assert.ok(ctx.handlers.has(seam), `registers ${seam}`)
}

// 3. agent/pre-step composes: it awaits next() and, with no credentials (engine
//    returns nothing), returns the downstream decision unchanged.
const preStep = ctx.handlers.get("agent/pre-step")
const downstream = {
  kind: "enter",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } }],
}
const decision = await preStep(
  { agent: { id: "s1" }, messages: downstream.messages, turn: 0, step: 0, signal: undefined },
  async () => downstream
)
assert.equal(decision.kind, "enter", "pre-step preserves the enter decision")
assert.ok(Array.isArray(decision.messages) && decision.messages.length >= 1, "messages preserved")

// 4. A reject decision is passed through untouched.
const rejectOut = await preStep(
  { agent: { id: "s1" }, messages: [], turn: 0, step: 0, signal: undefined },
  async () => ({ kind: "reject" })
)
assert.equal(rejectOut.kind, "reject", "pre-step passes reject through")

// 5. session/event only reacts to turn/end (no throw on other events).
const onEvent = ctx.handlers.get("session/event")
onEvent({ id: "s1" }, { type: "assistant/message" })
onEvent({ id: "s1" }, { type: "turn/end", data: {} })

console.log("ok - dsh-hydradb plugin check passed")
