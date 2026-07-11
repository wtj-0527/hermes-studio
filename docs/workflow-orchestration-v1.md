# Workflow Orchestration v1

Workflow Orchestration v1 adds deterministic, declarative routing to the server-side workflow DAG executor. Policies are data only; the executor never evaluates JavaScript or other executable expressions.

## Edge policy

Put an optional policy at `edge.data.orchestration`:

```json
{
  "id": "publish-when-approved",
  "source": "plan",
  "target": "publish",
  "data": {
    "orchestration": {
      "route": "success",
      "condition": {
        "path": "json.release.approved",
        "operator": "equals",
        "value": true
      }
    }
  }
}
```

- `route`: `success`, `failure`, or `always`.
- `condition` is optional. Without it, a matching route is taken.
- `condition.path` is a dot-separated path. Unprefixed paths resolve against parsed JSON; use `json.*` to address it explicitly. The evaluated context also contains `nodeId`, `status`, `output`, `error`, and `json` (the parsed node output). `__proto__`, `prototype`, and `constructor` path segments are rejected.
- `condition.operator`: `equals`, `not_equals`, `exists`, `truthy`, or `contains`.
- `condition.value` is used by `equals`, `not_equals`, and `contains`.
- Invalid policies, invalid paths, and condition evaluation errors fail closed: the edge result is `error` and the edge is not taken.

Legacy edges without `data.orchestration` are unconditional `success` routes. Before a run is persisted or the chat backend is called, the graph is compiled and malformed policies, duplicate IDs, dangling edges, self-loops, and cycles are rejected with status `400`. Edges without IDs receive stable index-based IDs.

## Structured output

Conditions can inspect JSON returned either as the entire assistant output or in a fenced block:

````markdown
```json
{"release":{"approved":true}}
```
````

Only `JSON.parse` is used. JavaScript fences, expressions, and arbitrary prose are never executed. Conditions that reference `json` or an unprefixed JSON path fail closed with an edge `error` when the output is not valid JSON; valid JSON `null` remains distinct from a parse failure.

## Join policy

Put an optional join policy at `node.data.orchestration.joinMode`:

```json
{
  "id": "aggregate",
  "data": {
    "orchestration": { "joinMode": "any" }
  }
}
```

- `all` (default and legacy behavior): every inbound edge must be taken.
- `any`: the node becomes runnable when one inbound edge is taken.
- If a join cannot be satisfied after its inbound edges are evaluated, the node is persisted as `skipped` in `workflow_runs.node_states_json`, including its reason and timestamps. No `workflow_run_node_sessions` row is created and the chat backend is not called.
- The scheduler is completion-driven: it starts all ready nodes concurrently, waits for the next in-flight completion, evaluates its edges, and immediately schedules newly ready nodes. This lets `joinMode: any` start before slower sibling branches finish while `all` still waits for every inbound result.
- `stopRun` cancellation aborts running sessions. Cancellation and terminal-error paths drain all in-flight executions with `Promise.allSettled` before the run is finalized; late successful responses cannot overwrite canceled node sessions. Internal terminal errors do not necessarily abort running sessions.

Only outputs from taken inbound edges are included in a node's upstream-results prompt.

## Failure routing

A failed node evaluates its `failure` and `always` edges. A failure is handled only when the handler consumes that specific taken edge when it starts; a skipped handler, or an `any` join that already started from another edge, does not count as handled. The graph may continue and the run may finish `completed`. A failure with no taken `failure` or `always` route makes the run `failed` after reachable routing and skip decisions settle.

`always` routes run for successful and failed outcomes. A condition on an `always` route still has to match.

## Persistence and API shape

Each evaluated edge is stored in `workflow_run_edge_results` with:

- edge/run/workflow/source/target identifiers;
- `taken`, `not_taken`, or `error` status;
- a human-readable reason;
- the evaluated context JSON;
- sequence and timestamps.

Fresh runs store the canonical compiled node and edge snapshots, so synthesized edge IDs match `edge_results.edge_id` in run detail and history. `getWorkflowRun()` and `listWorkflowRuns()` include `edge_results` and durable `node_states`; controllers also attach real `node_sessions`. Deleting a run transactionally deletes its edge results and node-session records.

## Rerun limitation

Legacy workflow snapshots retain the existing rerun-from-node behavior. Explicit default policies (`success` edges without conditions and `all` joins) remain legacy-compatible. Rerun from a node is deliberately rejected with HTTP-style status `409` only for snapshots with non-legacy conditional, failure/always routing, or `any` join semantics. Re-evaluating only part of a conditional graph needs an explicit policy for preserved edge outcomes and skipped nodes; v1 fails safely instead of reusing stale routing decisions. Start a new run to re-evaluate an Orchestration v1 graph.
