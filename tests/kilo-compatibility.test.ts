import { afterEach, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
const ts = createRequire(path.resolve("package.json"))("typescript")

let temporaryDirectory: string | undefined

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
})

async function captureKiloEvents() {
  temporaryDirectory = fs.mkdtempSync(path.join(process.env.PEON_TEST_TMPDIR || os.tmpdir(), "peon-kilo-identities-"))
  const homeDirectory = path.join(temporaryDirectory, "home")
  const hookDirectory = path.join(homeDirectory, ".claude/hooks/peon-ping")
  const capture = path.join(temporaryDirectory, "payloads.jsonl")
  fs.mkdirSync(hookDirectory, { recursive: true })
  fs.writeFileSync(capture, "")
  fs.writeFileSync(path.join(hookDirectory, "peon.sh"), '#!/bin/bash\npayload=$(cat)\nprintf "%s\\n" "$payload" >> "$PEON_KILO_TEST_CAPTURE"\n')
  vi.stubEnv("HOME", homeDirectory)
  vi.stubEnv("PEON_KILO_TEST_CAPTURE", capture)
  const source = fs.readFileSync(path.resolve("../../adapters/kilo/peon-ping.ts"), "utf8")
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}#${path.basename(temporaryDirectory)}`)
  const hooks = await module.default.server({ directory: "/tmp/kilo-project" })
  const payloads = () => fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  const waitForPayloads = async (count: number) => {
    await vi.waitFor(() => expect(payloads()).toHaveLength(count))
    return payloads()
  }
  return { hooks, server: module.default.server, payloads, waitForPayloads }
}

it.skipIf(process.platform === "win32")("keeps independent Kilo session identities across creation and completion", async () => {
  const { hooks, waitForPayloads } = await captureKiloEvents()
  for (const id of ["ses_primary_a", "ses_primary_b"]) {
    await hooks.event({ event: { type: "session.created", properties: { sessionID: id, info: { id } } } })
  }
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_primary_a" } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_primary_b" } } })
  const payloads = await waitForPayloads(4)
  expect(payloads).toEqual(expect.arrayContaining([
    expect.objectContaining({ hook_event_name: "SessionStart", session_id: "kilo-ses_primary_a" }),
    expect.objectContaining({ hook_event_name: "SessionStart", session_id: "kilo-ses_primary_b" }),
    expect.objectContaining({ hook_event_name: "Stop", session_id: "kilo-ses_primary_a" }),
    expect.objectContaining({ hook_event_name: "Stop", session_id: "kilo-ses_primary_b" }),
  ]))
})

it.skipIf(process.platform === "win32")("retains the native session identity when the Kilo plugin is reloaded", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10000)
  const { hooks, server, waitForPayloads } = await captureKiloEvents()
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_resumed" } } } })
  await waitForPayloads(1)
  now.mockReturnValue(20000)
  const reloaded = await server({ directory: "/tmp/kilo-project" })
  await reloaded.event({ event: { type: "session.idle", properties: { sessionID: "ses_resumed" } } })
  const payloads = await waitForPayloads(2)
  expect(payloads.map(payload => payload.session_id)).toEqual(["kilo-ses_resumed", "kilo-ses_resumed"])
})

it.skipIf(process.platform === "win32").each([
  ["session.status", { sessionID: "ses_existing", status: { type: "busy" } }, "UserPromptSubmit", ""],
  ["session.error", { sessionID: "ses_existing", error: { name: "UnknownError", data: { message: "failed" } } }, "PostToolUseFailure", ""],
  ["permission.asked", { sessionID: "ses_existing", id: "per_1", permission: "bash", patterns: ["pwd"], always: [] }, "PermissionRequest", ""],
  ["question.asked", { sessionID: "ses_existing", id: "que_1", questions: [] }, "Notification", "elicitation_dialog"],
  ["question.v2.asked", { sessionID: "ses_existing", id: "que_v2_1", questions: [] }, "Notification", "elicitation_dialog"],
])("routes %s through its native Kilo session identity", async (type, properties, hookEvent, notificationType) => {
  vi.spyOn(Date, "now").mockReturnValue(10000)
  const { hooks, waitForPayloads } = await captureKiloEvents()
  await hooks.event({ event: { type, properties } })
  expect(await waitForPayloads(1)).toEqual([{
    hook_event_name: hookEvent,
    notification_type: notificationType,
    cwd: "/tmp/kilo-project",
    session_id: "kilo-ses_existing",
    permission_mode: "",
    source: "kilo",
  }])
})

it.skipIf(process.platform === "win32")("retains a stable fallback when legacy Kilo events omit session identity", async () => {
  const { hooks, waitForPayloads } = await captureKiloEvents()
  await hooks.event({ event: { type: "session.created", properties: {} } })
  const [created] = await waitForPayloads(1)
  await hooks.event({ event: { type: "session.idle", properties: {} } })
  const payloads = await waitForPayloads(2)
  expect(created.session_id).toMatch(/^kilo-\d+$/)
  expect(payloads.find(payload => payload.hook_event_name === "Stop")?.session_id).toBe(created.session_id)
})

it.skipIf(process.platform === "win32")("preserves child-session suppression and clears it when the child is deleted", async () => {
  const { hooks, waitForPayloads } = await captureKiloEvents()
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_child", parentID: "ses_parent" } } } })
  for (const type of ["session.idle", "session.error", "session.status", "question.asked"]) {
    await hooks.event({ event: { type, properties: { sessionID: "ses_child", status: { type: "busy" }, id: "que_child" } } })
  }
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_child" } } } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
  expect(await waitForPayloads(1)).toEqual([expect.objectContaining({ hook_event_name: "Stop", session_id: "kilo-ses_child" })])
})

it.skipIf(process.platform === "win32")("preserves per-session busy deduplication across an idle transition", async () => {
  vi.spyOn(Date, "now").mockReturnValue(10000)
  const { hooks, waitForPayloads } = await captureKiloEvents()
  const busy = { event: { type: "session.status", properties: { sessionID: "ses_existing", status: { type: "busy" } } } }
  await hooks.event(busy)
  await waitForPayloads(1)
  await hooks.event(busy)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_existing" } } })
  await waitForPayloads(2)
  await hooks.event(busy)
  const payloads = await waitForPayloads(3)
  expect(payloads.filter(payload => payload.hook_event_name === "UserPromptSubmit")).toHaveLength(2)
  expect(payloads.every(payload => payload.session_id === "kilo-ses_existing")).toBe(true)
})

it.skipIf(process.platform === "win32")("installs a Kilo v1 server plugin and handles its properties event payload", async () => {
  temporaryDirectory = fs.mkdtempSync(path.join(process.env.PEON_TEST_TMPDIR || os.tmpdir(), "peon-kilo-compatibility-"))
  const repository = path.resolve("../..")
  const homeDirectory = path.join(temporaryDirectory, "home")
  const mockBin = path.join(temporaryDirectory, "bin")
  const hookDirectory = path.join(homeDirectory, ".claude/hooks/peon-ping")
  const capture = path.join(temporaryDirectory, "payload.json")
  fs.mkdirSync(mockBin, { recursive: true })
  fs.mkdirSync(hookDirectory, { recursive: true })
  fs.mkdirSync(path.join(homeDirectory, ".openpeon/packs/peon"), { recursive: true })
  fs.writeFileSync(path.join(hookDirectory, "peon.sh"), '#!/bin/bash\ncat > "$PEON_KILO_TEST_CAPTURE"\n')
  fs.writeFileSync(path.join(mockBin, "curl"), `#!/bin/bash
for arg in "$@"; do
  case "$arg" in
    https://raw.githubusercontent.com/PeonPing/peon-ping/main/*)
      source="$PEON_KILO_TEST_REPOSITORY/$(printf '%s' "$arg" | cut -d / -f 7-)"
      if [ "$2" = "$arg" ] && [ "$3" = "-o" ]; then
        cat "$source" > "$4"
      else
        cat "$source"
      fi
      exit ;;
  esac
done
exit 1
`, { mode: 0o755 })

  const environment = {
    ...process.env,
    HOME: homeDirectory,
    XDG_CONFIG_HOME: path.join(homeDirectory, ".config"),
    PATH: `${mockBin}:${process.env.PATH}`,
    PEON_KILO_TEST_REPOSITORY: repository,
    PEON_KILO_TEST_CAPTURE: capture,
  }
  execFileSync("bash", [path.join(repository, "adapters/kilo.sh")], { env: environment })
  const installed = fs.readFileSync(path.join(homeDirectory, ".config/kilo/plugins/peon-ping.ts"), "utf8")
  const javascript = ts.transpileModule(installed, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vi.stubEnv("HOME", homeDirectory)
  vi.stubEnv("PEON_KILO_TEST_CAPTURE", capture)
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`)
  const server = module.default?.server ?? module.default
  expect(typeof server).toBe("function")
  const hooks = await server({ directory: "/tmp/kilo-project" })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_primary" } } })
  await vi.waitFor(() => {
    expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toMatchObject({
      hook_event_name: "Stop",
      cwd: "/tmp/kilo-project",
      source: "kilo",
    })
  })
})
