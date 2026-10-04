/**
 * peon-ping for OpenCode — event bridge
 *
 * Routes OpenCode events through peon.sh instead of re-implementing
 * sound playback, notifications, and trainer features in TypeScript.
 *
 * This gives OpenCode users access to ALL peon-ping features:
 * - Sound packs & rotation
 * - Desktop notifications
 * - Trainer reminders (pushups, squats, etc.)
 * - Spam detection
 * - SSH/devcontainer relay
 * - All config options via `peon` CLI
 * - Tab title updates
 *
 * Requires peon-ping installed: brew install PeonPing/tap/peon-ping
 *   or: curl -fsSL peonping.com/install | bash
 */

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { spawn } from "node:child_process"

const MAX_PENDING_QUESTION_IDS = 100

const PEON_SH_PATHS = [
  path.join(os.homedir(), ".claude", "hooks", "peon-ping", "peon.sh"),
  path.join(os.homedir(), ".openclaw", "hooks", "peon-ping", "peon.sh"),
]

function findPeonSh(): string | null {
  for (const p of PEON_SH_PATHS) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

function setTabTitle(title: string): void {
  if (!process.stdout.isTTY) return
  process.stdout.write(`\x1b]0;${title}\x07`)
}

/**
 * OpenCode v2 payloads carry the event body under `data`. Only the fields this
 * adapter reads are typed; the rest of the union is intentionally open.
 */
type V2Event = {
  id?: string
  type: string
  data?: Record<string, any>
}

export default {
  id: "peon-ping",

  setup: async (ctx: any) => {
    const projectName = path.basename(ctx?.location?.directory || process.cwd()) || "opencode"
    const peonSh = findPeonSh()

    if (!peonSh) {
      console.warn("[peon-ping] peon.sh not found. Install peon-ping first:")
      console.warn("  brew install PeonPing/tap/peon-ping")
      console.warn("  # or: curl -fsSL peonping.com/install | bash")
      return
    }

    const cwd = ctx?.location?.directory || process.cwd()
    const sessionId = `oc-${Date.now()}`
    const subagentSessionIds = new Set<string>()
    const busySessions = new Set<string>()
    let lastSessionStart = 0
    const pendingQuestionIds = new Set<string>()

    function firePeon(event: string, notificationType = ""): void {
      const payload = JSON.stringify({
        hook_event_name: event,
        notification_type: notificationType,
        cwd,
        session_id: sessionId,
        permission_mode: "",
        source: "opencode",
      })

      try {
        const proc = spawn("bash", [peonSh], {
          stdio: ["pipe", "ignore", "ignore"],
        })
        proc.stdin.write(payload)
        proc.stdin.end()
        proc.unref()
      } catch {}
    }

    function isSubagent(sid: unknown): boolean {
      return typeof sid === "string" && subagentSessionIds.has(sid)
    }

    /**
     * Map an OpenCode v2 event onto a peon.sh hook_event_name.
     *
     * v2 replaced the event taxonomy this adapter was written against; see
     * `docs/opencode-v2-events.md` for the full table. The cases below are the
     * only v2 events that map onto a peon-ping category.
     */
    function handle(event: V2Event): void {
      const data = event.data ?? {}

      switch (event.type) {
        case "session.created":
        case "session.updated": {
          if (data.parentID) subagentSessionIds.add(data.id)
          break
        }

        case "session.deleted": {
          if (data.id) subagentSessionIds.delete(data.id)
          break
        }

        // A new execution is both "a turn began" and, the first time we see a
        // session, "a session began". SessionStart is emitted first so the
        // debounce below suppresses the UserPromptSubmit that immediately
        // follows it, matching the pre-v2 behaviour.
        case "session.execution.started": {
          const sid = data.sessionID
          if (isSubagent(sid)) break
          if (typeof sid === "string" && !busySessions.has(sid) && lastSessionStart === 0) {
            lastSessionStart = Date.now()
            setTabTitle(`${projectName}: ready`)
            firePeon("SessionStart")
          }
          if (sid) busySessions.add(sid)
          if (Date.now() - lastSessionStart > 3000) {
            setTabTitle(`${projectName}: working`)
            firePeon("UserPromptSubmit")
          }
          break
        }

        case "session.execution.succeeded": {
          const sid = data.sessionID
          if (isSubagent(sid)) break
          if (sid) busySessions.delete(sid)
          setTabTitle(`\u25cf ${projectName}: done`)
          firePeon("Stop")
          break
        }

        case "session.execution.failed": {
          const sid = data.sessionID
          if (isSubagent(sid)) break
          if (sid) busySessions.delete(sid)
          setTabTitle(`\u25cf ${projectName}: error`)
          firePeon("PostToolUseFailure")
          break
        }

        case "permission.asked": {
          setTabTitle(`\u25cf ${projectName}: needs approval`)
          firePeon("PermissionRequest")
          break
        }

        // v2 renamed the "agent needs input" elicitation surface from
        // question.* to form.*.
        case "form.created": {
          const sid = data.sessionID
          if (isSubagent(sid)) break
          const requestId = data.id ?? data.formID
          if (typeof requestId !== "string" || pendingQuestionIds.has(requestId)) break
          if (pendingQuestionIds.size >= MAX_PENDING_QUESTION_IDS) {
            pendingQuestionIds.delete(pendingQuestionIds.values().next().value!)
          }
          pendingQuestionIds.add(requestId)
          setTabTitle(`\u25cf ${projectName}: needs input`)
          firePeon("Notification", "elicitation_dialog")
          break
        }

        case "form.replied":
        case "form.cancelled": {
          const requestId = data.formID ?? data.id
          if (typeof requestId === "string") pendingQuestionIds.delete(requestId)
          break
        }
      }
    }

    setTabTitle(`${projectName}: ready`)

    const controller = new AbortController()

    // A rejection escaping this loop would take down the plugin generation, and
    // an aborted stream is the normal shutdown path.
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          handle(event as V2Event)
        } catch (err: any) {
          console.error("[peon-ping] failed to handle event:", err?.message ?? err)
        }
      }
    })().catch((err: any) => {
      if (!controller.signal.aborted) console.error("[peon-ping] event stream ended:", err?.message ?? err)
    })

    return () => controller.abort()
  },
}
