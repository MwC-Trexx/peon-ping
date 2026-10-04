import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const stdin = {
  write: vi.fn(),
  end: vi.fn(),
}
const spawnedProcess = {
  stdin,
  unref: vi.fn(),
}

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}))

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => spawnedProcess),
}))

import { spawn } from "node:child_process"
import plugin from "../adapters/opencode/peon-ping.js"

/**
 * Drives the plugin through a fake v2 host context and yields the events fed
 * to it, so a test can step the stream one event at a time.
 */
async function createHost(events: Array<Record<string, any>> = []) {
  const queue = [...events]
  let push: ((event: Record<string, any>) => void) | undefined

  const ctx: any = {
    location: { directory: "/tmp/example-project" },
    event: {
      subscribe: async function* (_opts: any) {
        for (const event of queue) yield event
        // Park forever so the loop stays alive between test steps.
        await new Promise<void>((resolve) => {
          push = resolve as any
        })
      },
    },
  }

  const cleanup = await plugin.setup(ctx)
  // Let the loop subscribe before the test pushes anything.
  await new Promise((resolve) => setTimeout(resolve, 0))

  return {
    async emit(event: Record<string, any>) {
      queue.push(event)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    cleanup,
  }
}

function payloads(): Array<Record<string, unknown>> {
  return stdin.write.mock.calls.map(([payload]) => JSON.parse(payload))
}

function hookEvents(): string[] {
  return payloads().map((p) => p.hook_event_name as string)
}

describe("peon-ping OpenCode v2 plugin definition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("exports a v2 definition object with an id and a setup function", () => {
    expect(typeof plugin).toBe("object")
    expect(plugin.id).toBe("peon-ping")
    expect(typeof plugin.setup).toBe("function")
  })
})

describe("peon-ping event mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.restoreAllMocks()
  })

  it("maps session execution lifecycle onto peon hook events", async () => {
    const host = await createHost([
      { id: "evt_1", type: "session.execution.started", data: { sessionID: "ses_a" } },
      { id: "evt_2", type: "session.execution.succeeded", data: { sessionID: "ses_a" } },
    ])

    await new Promise((resolve) => setTimeout(resolve, 20))
    host.cleanup?.()

    expect(hookEvents()).toEqual(["SessionStart", "Stop"])
  })

  it("reports a failed execution as PostToolUseFailure", async () => {
    const host = await createHost([
      { id: "evt_1", type: "session.execution.failed", data: { sessionID: "ses_a" } },
    ])

    await new Promise((resolve) => setTimeout(resolve, 20))
    host.cleanup?.()

    expect(hookEvents()).toContain("PostToolUseFailure")
  })

  it("dispatches a private elicitation notification for form.created", async () => {
    const sensitiveText = "SENTINEL_SECRET_FORM_V1"
    const host = await createHost([
      {
        id: "evt_1",
        type: "form.created",
        data: {
          id: "form-request-v1",
          sessionID: "primary-session",
          questions: [{ question: sensitiveText, options: [{ label: "Secret option" }] }],
        },
      },
    ])

    await new Promise((resolve) => setTimeout(resolve, 20))
    host.cleanup?.()

    expect(payloads()).toEqual([
      {
        hook_event_name: "Notification",
        notification_type: "elicitation_dialog",
        cwd: "/tmp/example-project",
        session_id: expect.stringMatching(/^oc-\d+$/),
        permission_mode: "",
        source: "opencode",
      },
    ])
    // The question text and id must never reach the peon.sh payload.
    expect(stdin.write.mock.calls[0][0]).not.toContain(sensitiveText)
    expect(stdin.write.mock.calls[0][0]).not.toContain("form-request-v1")
  })

  it("suppresses duplicate form notifications with the same id", async () => {
    const host = await createHost([
      { id: "evt_1", type: "form.created", data: { id: "same-form", sessionID: "primary-session" } },
      { id: "evt_2", type: "form.created", data: { id: "same-form", sessionID: "primary-session" } },
    ])

    await new Promise((resolve) => setTimeout(resolve, 20))
    host.cleanup?.()

    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("bounds pending form ids and evicts the oldest request", async () => {
    const events = []
    for (let id = 0; id <= 100; id += 1) {
      events.push({ id: `evt_${id}`, type: "form.created", data: { id: `form-${id}`, sessionID: "ses_a" } })
    }
    // Re-use the oldest id, which must have been evicted to make room.
    events.push({ id: "evt_x", type: "form.created", data: { id: "form-0", sessionID: "ses_a" } })

    const host = await createHost(events)
    await new Promise((resolve) => setTimeout(resolve, 50))
    host.cleanup?.()

    expect(spawn).toHaveBeenCalledTimes(102)
  })

  it("suppresses notifications from tracked subagent sessions", async () => {
    const host = await createHost([
      { id: "evt_1", type: "session.created", data: { id: "subagent-session", parentID: "ses_a" } },
      { id: "evt_2", type: "form.created", data: { id: "f1", sessionID: "subagent-session" } },
    ])

    await new Promise((resolve) => setTimeout(resolve, 20))
    host.cleanup?.()

    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(["form.replied", "form.cancelled"])("cleans deduplication state on %s", async (settledType) => {
    const host = await createHost([
      { id: "evt_1", type: "form.created", data: { id: "reusable-form", sessionID: "ses_a" } },
      { id: "evt_2", type: settledType, data: { formID: "reusable-form", sessionID: "ses_a" } },
      { id: "evt_3", type: "form.created", data: { id: "reusable-form", sessionID: "ses_a" } },
    ])

    await new Promise((resolve) => setTimeout(resolve, 20))
    host.cleanup?.()

    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("passes the project directory from ctx.location to peon.sh", async () => {
    const host = await createHost([
      { id: "evt_1", type: "permission.asked", data: { sessionID: "ses_a", id: "p1" } },
    ])

    await new Promise((resolve) => setTimeout(resolve, 20))
    host.cleanup?.()

    expect(payloads()[0]).toMatchObject({
      hook_event_name: "PermissionRequest",
      cwd: "/tmp/example-project",
      source: "opencode",
    })
  })
})
