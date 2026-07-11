# Workflow Orchestration v2

Workflow Orchestration v2 extends the Agent-only Workflow product with canonical reasoning controls, bounded feedback loops, append-only iteration evidence, and portable JSON definitions. It does not add Shell, HTTP, variable, Start, End, Condition, or standalone Loop node types; executable nodes remain `hermes`, `codex`, and `claude-code` Agents.

## Compatibility boundary

- Workflows without explicit feedback loops continue through the established v1 DAG scheduler.
- A graph with at least one explicit bounded feedback edge is compiled and executed by the v2 scheduler.
- Every graph is compiled before a run is created. Invalid graphs return `400` without a run row, Agent session, or backend call.
- Partial rerun is intentionally unavailable for non-legacy orchestration snapshots. Start a new run so route, join, and iteration decisions are recomputed from current evidence.

## Canonical reasoning effort

Agent nodes accept one canonical value:

```text
default (omit override), none, minimal, low, medium, high, xhigh, max
```

`default` is represented by an absent override. Whitespace is treated as absent; non-canonical values such as `MAX` are rejected rather than normalized. `max` is the highest single-model effort and is unrelated to Codex Ultra multi-agent mode.

Before side effects, an explicit effort is checked against authoritative `(profile, provider, model, apiMode)` capability metadata. Unknown capability fails with `reasoning_capability_unknown`; a known unsupported effort fails with `reasoning_effort_unsupported`. There is no model-name inference or silent downgrade. The selected value is preserved in the run snapshot and forwarded to Hermes, Codex, and Claude Code execution paths.

## Explicit bounded feedback edges

A feedback edge is an ordinary edge with an explicit `condition` and `loop` policy:

```json
{
  "id": "review-retry",
  "source": "review",
  "target": "draft",
  "data": {
    "orchestration": {
      "route": "success",
      "condition": {
        "path": "json.retry",
        "operator": "truthy"
      },
      "loop": {
        "maxIterations": 3
      }
    }
  }
}
```

Rules:

- `condition` is mandatory; unbounded feedback is rejected.
- `maxIterations` is a positive integer and includes the initial pass.
- The UI exposes `maxIterations`; the server hard maximum is `100`.
- If another retry is requested at the limit, the run fails with `loop_limit_exceeded`; it never dispatches iteration `max + 1`.
- Removing all marked feedback edges must leave a DAG. Unmarked cycles remain invalid.

The compiler derives natural loops with dominance and predecessor closure. It accepts only single-entry reducible loop regions that are strictly nested or disjoint. It rejects multi-entry/irreducible, equal ownership, shared-header ambiguity, and partially overlapping regions. An outer-loop retry resets every contained child loop to iteration 1.

## Iteration identity and joins

Every execution is identified by `(nodeId, ordered iterationPath)`. Example:

```json
[
  { "loopId": "loop:outer", "iteration": 2 },
  { "loopId": "loop:inner", "iteration": 1 }
]
```

Each repeated Agent execution receives a fresh session. `joinMode: all|any` is evaluated only against inbound edge evaluations from that exact iteration path:

- `all` waits for all relevant inbound evaluations and requires every one to be taken.
- `any` may start from the first taken inbound evaluation; if all become terminal and none is taken, the node is skipped.
- Skipped executions are still persisted, but create no session and consume no execution budget.
- Only outputs from taken edges in the current path are assembled into the node prompt. Outputs from prior iterations are never reused.

Loop exits are barriers. Exit evidence produced by a retrying epoch is suppressed. A nested cross-loop exit is delivered only after every exited loop finally settles; downstream nodes see only final-iteration provenance.

## Termination and lifecycle controls

For v2 runs, the run endpoint accepts optional safety overrides:

```json
{
  "total_timeout_ms": 3600000,
  "execution_budget": 1000
}
```

Defaults and hard limits:

| Control | Default | Hard maximum |
| --- | ---: | ---: |
| Total timeout | 1 hour | 24 hours |
| Agent execution budget | 1000 | 10000 |
| Per-feedback `maxIterations` | UI value | 100 |

Values must be positive integers. Before returning HTTP `202`, the API synchronously validates graph shape, explicit loop start semantics, run limits, and authoritative reasoning capability metadata. The detached runtime repeats the same preflight before persistence as defense in depth. Budget reservation is an atomic SQLite operation and happens before session creation.

Cancellation and deadline expiry abort the owning runtime, including workflow-scoped Codex/Claude Code sessions. Deadline executions become `failed/workflow_timeout`; operator cancellation becomes `canceled/workflow_canceled`. After a server restart, orphaned v2 `queued/running` runs fail closed as `runtime_restarted`; the in-memory scheduler is not reconstructed. Historical `retrying` loop epochs remain immutable while only active `running` epochs are terminalized. Deleting a run removes every repeated session/usage artifact before deleting v2 evidence.

## Append-only evidence

V2 adds run metadata plus three append-only evidence streams:

- `workflow_run_node_executions`
- `workflow_run_edge_evaluations`
- `workflow_run_loop_iterations`

Delivered edge evaluations also persist `consumed_by_execution_id` when a target execution actually consumes them. This keeps delivery and consumption distinct for early `join:any` auditability.

Run detail returns them as:

```text
node_executions, edge_evaluations, loop_iterations
```

The client groups node executions by canonical ordered iteration path, displays skipped evidence and terminal codes, and opens the exact repeated session selected by the operator. Earlier iterations are never overwritten.

## Portable JSON definition

Export uses a definition-only envelope:

```json
{
  "schema": "hermes-studio.workflow",
  "version": 1,
  "workflow": {},
  "dependencies": {}
}
```

The allowlist includes topology, Agent configuration, prompts, skills by name, model/reasoning selection, route/join/condition/loop policy, viewport, and dependency hints. Credentials, cookies, tokens, sessions, messages, run/evaluation history, and local attachment paths are excluded or rejected.

Import is fail-closed:

1. Parse strict schema/version and size limits.
2. Compile the graph and inspect dependencies in the authorized target profile.
3. Return a preview plus a user/profile/document-bound, 10-minute, single-use token.
4. Recheck the document digest and environment at confirmation.
5. With explicit confirmation, create a new **inactive** Workflow.

Import never remaps missing dependencies, overwrites an existing Workflow, trusts `profileHint` as authorization, or starts a run automatically.

## Verification matrix

Required gates include compiler/store/controller/client contracts, single/nested/disjoint loops, `join:all` and early `join:any`, skip evidence, output provenance, nested exit barriers, loop limit, malformed conditions, atomic budget, real cancel/deadline abort, restart recovery, deletion cleanup, reasoning capability validation, portability security/token behavior, type checks, Chat harness checks, production build, baseline-aware full tests, independent review, and disposable live E2E.
