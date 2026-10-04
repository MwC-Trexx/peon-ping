import { afterEach, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
const ts = createRequire(path.resolve("package.json"))("typescript")

let temporaryDirectory: string | undefined

afterEach(() => {
  vi.unstubAllEnvs()
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
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
