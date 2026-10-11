# Offline occupancy reconciliation runbook

Applies to product source `1dcb8467c54f3adb3656982bab260fa24b2a7a88`.
This is an operator procedure for the existing data-layer primitive, not a new route,
automated repair job, or authorization to operate a live deployment.
See [execution contract](execution.md#controlled-reconciliation-offline-only).

## Entry evidence and write-stop gate

The maintenance owner must identify the exact deployment, trusted namespace/tenant,
Mongo topology, owner/conversation key, reviewed build, maintenance window and rollback
owner. Keep real identifiers and credentials in private maintenance evidence, not UI or
public logs. Do not infer a namespace from a browser request or copy another namespace.

Before any reconciliation write:

1. Block new admission, imports and all other writes into the affected deployment.
2. Inventory and stop **all** replicas, provider/generation workers, background callbacks,
   persistence workers/retries, scheduled jobs and consumers that can complete a write.
   Drain or stop outstanding work; verify delayed database commands have settled too.
3. Disable automatic restart/redeployment, supervisors, queue redelivery and scheduled
   launches for the whole window. Record which controls enforce this and who verified them.
4. Independently confirm no writer or delayed persistence can still execute. A local PID,
   process restart, old operation timestamp or empty generation-job list is insufficient.
   If this cannot be demonstrated, keep the write block and occupancy; escalate to the
   maintenance owner. Do not use the reconciliation primitive to test whether writers live.

The synthetic fixture below has no external provider or application workers. It does not
supply production evidence for steps 1–4. Stopping a database client alone is not write-stop.

## Exact-key operation sequence

Use the reviewed `createMongoBindingStore` data-layer API with explicitly verified connection,
namespace and topology settings. No general-purpose production command/URI is provided here.
The following is an API sequence, not an executable script or automatic loop:

```ts
// PRECONDITION: independently verified, enforced write-stop remains in effect.
await store.tombstone(key); // Permanent retirement; never restore a bound/unbound state.
const expectedOperations = await store.occupancy(key);
// Record exact array, key/namespace, tombstone state, source and write-stop evidence.
// A separate operator review must accept this snapshot and quiescence evidence.
const matched = await store.reconcileRetired(key, expectedOperations);
// matched must be true; then re-read read(key), occupancy(key), and idle(key).
```

Preserve the complete operation array exactly as read (including order); do not sort,
remove IDs, merge snapshots or substitute an empty array. The implementation compares
namespace/key, `state: 'tombstone'` and the exact array in one conditional Mongo update,
with no upsert. It clears only occupancy; it does not delete messages, conversations or
binding rows. The tombstone must remain permanently.

| Outcome | Required operator action |
| --- | --- |
| `matched === false` | No clear is established. Keep write-stop; investigate changed state/snapshot. Do not immediately reread and auto-retry against a new array. |
| Read error, malformed evidence or topology error | Keep write-stop and occupancy. Correct the evidence/configuration without falling back to another topology or namespace. |
| Timeout, lost acknowledgement, uncertain reconcile/release/import/persistence write | Retain the operational block. An unknown result is not proof of failure or completion; late writes may still settle. Never blindly retry, force-clear or resurrect the key. |
| `matched === true` | While still stopped, independently verify `read(key).kind === 'tombstone'`, exact empty occupancy, and `idle(key) === true`; preserve receipts. |

After an unknown outcome, rereads are evidence only. Even an empty array does not establish
provider/persistence quiescence or authorize restart. Resolve pending database writes and
re-establish the independent write-stop evidence before a separately reviewed recovery step.
If uncertainty remains, leave the deployment blocked and the key retired.

Once postconditions and writer controls are accepted, the maintenance owner may restore
guarded services deliberately. If physical deletion is required, retry the existing explicit
delete route and verify its actual result. Reconciliation itself is not successful deletion.
Do not roll back to unguarded writers, drop a binding, rebind a retired ID or copy its scope.
No TTL, lease stealing, startup sweep or age-based auto-clear is permitted.

## Synthetic rehearsal receipt — 2026-10-11

The final product commit above was rerun unchanged, after the insert-only timestamp option
fix. Command, from the Chat worktree:

```powershell
& .local/verification/circle-metadata/run-1dcb8467.ps1 -Suite mongo7
```

Result: **1 suite, 16 passed, 0 skipped, exit 0**. Mongo **7.0.43**, standalone;
image `mongo@sha256:1f995ad6fdb93244a1addab1b58f934a0bc2f5643c38e02f5e9d7f0c7d227a7b`.
The suite loads source via Babel with existing local dependencies, not built application dist.
It uses a loopback-only, tmpfs, self-labelled disposable container; no provided database URI,
host data mount, image pull, historical database deletion or shared container cleanup.

Owned container: `ca2700797c4f316c268da692a93fc245fa6d26f783447b04de07a9773a1976ed`.
Name/ownership label: `openschool-binding-mongo7-98b42264-ae55-485b-a763-857fe6926292`.
Docker lifecycle receipt records create/start/stop/die(exit 0)/destroy. The before inventory
contained one runtime Mongo; this suite created only one additional Mongo. The later inventory
was empty; this worker only stopped its own label-verified fixture and made no stop calls
against the runtime container. The window is released.

### Existing coverage reused in this run

All names below refer to `packages/data-schemas/src/openschool/mongo7.spec.ts`.
No additional product code or test cases were needed for this rerun.

| Runbook boundary | Existing test and observed assertions |
| --- | --- |
| No clearing a live binding | `offline reconciliation requires tombstone and exact operations after reconnect`: reconcile before tombstone returns false. |
| Crash/reconnect does not expire occupancy | Same test closes and reconnects the client, observes `idle === false` and exactly the original operation. This simulates reconnect, not a full application crash/boot. |
| Snapshot CAS | Same test submits a different operation, gets false and remains non-idle; exact snapshot returns true, then idle is true. |
| Permanent retirement | Same test verifies new acquire is false and read remains tombstone after successful reconcile. |
| Uncertain/failed release retains block | `scope/owner occupancy mismatch and failed release cannot permit deletion`: actual Mongo update failpoint makes release throw, idle stays false. This is a definite server failure, not an injected lost acknowledgement. |
| Infrastructure failure is not absence/success | `actual Mongo command failures cannot be confused with absent/success`: failed read returns error; failed update throws. |
| Late writer/admission race | `durable occupancy survives tombstone and reconnect, blocks reuse until explicit release` and `concurrent retirement retains every successful occupancy and admits none afterwards`. |
| Import collision and partial cleanup | `insert-only bulk collisions and receipt cleanup preserve existing conversation/messages`: real insert-only methods preserve collided rows and remove only receipt-matched inserts. It executes the timestamp-fixed methods; minimal schemas do not independently assert imported timestamp values. |

Existing controller tests in `execution.spec.ts` cover uncertain trailing persistence,
release uncertainty and failed import retention; the previous 757-test API receipt remains
applicable because product source has not changed. They were not rerun for this Mongo-only
request. No test proves an operator stopped every production writer, and this run is not
full boot, provider E2E, final UI acceptance or replica-set failover validation.

Raw evidence in the Chat worktree's `.local/verification/circle-metadata/`:

- `1dcb8467-mongo7-final.raw.txt`: all 16 results and counts.
- `1dcb8467-mongo7-exit.txt`: source, command, exit and start/end epoch.
- `1dcb8467-fixture-events.jsonl`: exact owned-container lifecycle.
- `1dcb8467-docker-before.txt`, `1dcb8467-docker-after.txt`: read-only inventories.
- `1dcb8467-mongo-final.receipt.json`: machine-readable source and evidence hashes.

Operation IDs in the rehearsal are random synthetic IDs, asserted in test but not printed;
this receipt does not invent their values. Actual maintenance must record its exact snapshot.
