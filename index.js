import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(ROOT, "scripts", "run-plugin.sh")

/** Cordis plugin name registered with the DeepSeek Harness loader. */
export const name = "hydradb"

/**
 * Map plugin config onto the HYDRADB_* environment the shared engine reads.
 * @param {Record<string, unknown>} config - resolved dsh plugin config.
 * @returns {NodeJS.ProcessEnv} env for the spawned engine, config filling gaps only.
 */
function engineEnv(config = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT }
  const set = (key, value) => {
    if (value != null && value !== "" && (env[key] == null || env[key] === "")) env[key] = String(value)
  }
  set("HYDRADB_API_KEY", config.api_key)
  set("HYDRADB_DATABASE", config.database)
  set("HYDRADB_COLLECTION", config.collection)
  set("HYDRADB_BASE_URL", config.base_url)
  return env
}

/**
 * Run one shared-engine subcommand over stdin and return its raw stdout.
 * @param {string} subcommand - engine verb (user-prompt-submit, post-tool-use, stop, session-sync-hook).
 * @param {string} stdin - JSON payload piped to the engine.
 * @param {Record<string, unknown>} config - plugin config forwarded as env.
 * @returns {string} the engine's stdout, or empty string on failure.
 */
function runEngine(subcommand, stdin, config) {
  const res = spawnSync("bash", [RUNNER, subcommand], {
    input: stdin ?? "",
    encoding: "utf8",
    timeout: 30000,
    env: engineEnv(config),
  })
  return res.stdout ?? ""
}

/**
 * Extract the recalled context string from the engine's hook stdout.
 * @param {string} out - engine stdout, one JSON object per line.
 * @returns {string} the additionalContext payload, or empty string when absent.
 */
function parseContext(out) {
  for (const line of String(out).trim().split("\n")) {
    try {
      const parsed = JSON.parse(line)
      const ctx = parsed?.hookSpecificOutput?.additionalContext ?? parsed?.additional_context
      if (ctx) return ctx
    } catch {
      continue
    }
  }
  return ""
}

/** Collect the plain text of the last user-authored message in a step batch. */
function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.source?.kind && m.source.kind !== "user") continue
    const text = (m?.content ?? [])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

let llmModule
/**
 * Build a user-role context message, preferring the harness factory for a
 * stable identity and falling back to a plain literal when the LLM package is
 * unavailable (e.g. isolated unit tests).
 * @param {string} text - recalled context to inject.
 * @returns {Promise<object>} a UserMessage-shaped object.
 */
async function makeContextMessage(text) {
  if (llmModule === undefined) {
    try {
      llmModule = await import("@deepseek-ai/dsh-llm")
    } catch {
      llmModule = null
    }
  }
  const content = [{ type: "text", text }]
  const source = { kind: "user" }
  if (llmModule?.createUserMessage) return llmModule.createUserMessage({ content, source })
  return { role: "user", content, source }
}

/** File-writing tool names whose completion should trigger a workspace sync. */
const WRITE_TOOL = /write|edit|create|save|apply/i

/**
 * DeepSeek Harness (dsh) plugin entry: wires the shared HydraDB engine onto the
 * harness Cordis interception seams.
 *
 * - agent/created: sync workspace docs into HydraDB when a session opens.
 * - agent/pre-step: on a turn's first step, recall relevant memory and prepend
 *   it to the step's messages (the dsh analogue of prompt-time auto-recall).
 * - tools/post-execute: incremental workspace sync after file-writing tools.
 * - session/event (turn/end): capture the completed turn as durable memory.
 *
 * Credentials resolve from plugin config or the HYDRADB_* / HYDRA_DEEPSEEK_* env.
 * @param {import('@deepseek-ai/cordis').Context} ctx - harness plugin context.
 * @param {Record<string, unknown>} [config] - resolved plugin config (Cordis passes it as the second argument).
 */
export function apply(ctx, config = {}) {
  ctx.on("agent/created", () => {
    runEngine("session-sync-hook", "{}", config)
  })

  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next()
    if (decision.kind !== "enter") return decision
    // Recall once per user turn: only a turn's first step carries fresh
    // user-authored text; continuation steps (tool results) carry none.
    const prompt = lastUserText(payload.messages)
    if (!prompt) return decision
    const sessionId = payload.agent?.sessionId ?? payload.agent?.id ?? "dsh"
    const recalled = parseContext(
      runEngine("user-prompt-submit", JSON.stringify({ session_id: String(sessionId), prompt }), config)
    )
    if (!recalled) return decision
    const contextMessage = await makeContextMessage(recalled)
    return { ...decision, messages: [contextMessage, ...decision.messages] }
  })

  ctx.on("tools/post-execute", async (exec, _result, next) => {
    const toolName = String(exec?.tool?.name ?? exec?.name ?? "")
    if (WRITE_TOOL.test(toolName)) {
      const args = exec?.arguments ?? exec?.args ?? {}
      const file = args.file_path ?? args.path ?? args.file
      runEngine("post-tool-use", JSON.stringify({ tool_input: { file_path: file } }), config)
    }
    return next()
  })

  ctx.on("session/event", (session, event) => {
    if (event?.type !== "turn/end") return
    runEngine("stop", JSON.stringify({ session_id: String(session?.id ?? "") }), config)
  })
}
