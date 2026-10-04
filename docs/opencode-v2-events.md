# OpenCode v2 event mapping

`adapters/opencode/peon-ping.ts` targets the OpenCode **v2** plugin API
(`opencode >= 2.0`). Two things changed together in v2, and both are required
for the adapter to load and fire.

## 1. Plugin module format

v2 removed the v1 server plugin API entirely. Local plugins under
`~/.config/opencode/plugin{,s}/` are loaded by
`packages/core/src/plugin/module.ts`, which decodes the module's default export
against:

```ts
Schema.Struct({
  default: Schema.Union([
    Schema.Struct({ id: Schema.String, effect: /* (ctx) => Effect */ }),
    Schema.Struct({ id: Schema.String, setup: /* (ctx) => Promise<Cleanup|void> */ }),
  ]),
})
```

A v1 adapter — whose default export is a bare async function — fails with:

```
PluginModule.LoadError: Plugin must export a default definition with an id and
an effect or setup function.
cause: SchemaError(Expected object at ["default"])
```

`Expected object` rather than `Missing key` is the tell: the key is present, it
just is not an object.

The v2 promise context (`packages/plugin/src/promise/plugin.ts`) is typed
`any`-free in practice but `@opencode-ai/plugin` is not resolvable from the
plugins directory, so the adapter is intentionally untyped.

## 2. Event taxonomy

v2 also replaced the event names the adapter used to switch on. The v1 targets
no longer exist; `session.idle` survives only as a `// deprecated` definition
and `session.status` is defined but never published.

| peon-ping hook event   | v1 event (removed)         | v2 event used instead                     |
| ---------------------- | -------------------------- | ----------------------------------------- |
| `SessionStart`         | `session.created`          | first `session.execution.started`          |
| `UserPromptSubmit`     | `session.status` (busy)    | `session.execution.started`                |
| `Stop`                 | `session.idle`             | `session.execution.succeeded`              |
| `PostToolUseFailure`   | `session.error`            | `session.execution.failed`                 |
| `PermissionRequest`    | `permission.asked`         | `permission.asked` (unchanged)             |
| `Notification`         | `question.asked`           | `form.created`                             |

v2 payloads also carry the event body under `data` rather than `properties`:

```ts
for await (const event of ctx.event.subscribe()) {
  // event: { id, type, data: { sessionID, ... } }
}
```

## Notes

- `session.execution.started` doubles as both `SessionStart` and
  `UserPromptSubmit`. `SessionStart` is emitted first so the adapter's
  existing 3s debounce suppresses the `UserPromptSubmit` that immediately
  follows, preserving pre-v2 behaviour.
- A tool failure surfaces as `session.execution.failed`. There is no longer a
  per-tool error event, so `PostToolUseFailure` now covers any failed
  execution, not just tool errors.
- The elicitation ("agent needs input") surface was renamed from `question.*`
  to `form.*`, and the payload no longer nests questions under `questions`.
  Only the request id is read, and it is still never forwarded to `peon.sh`.
