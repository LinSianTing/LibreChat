# SPEC34 conversation admission integration

Oct11 hardening baseline: `7852bde9ba751a02b8f1f6e3f94c9ab8e99a3486`. This is a bounded
controller/fence candidate, not a deployment or a claim that every LibreChat write path is fenced.

## Runtime wiring

- `buildEndpointOption` calls admission after server model-spec resolution and before circle
  project creation / agent construction. Agent text moderation follows this guard.
- `agents/request` uses the prepared server final ID before preliminary history reads and job
  creation; `BaseClient.setMessageOptions` rejects final-ID drift before `loadHistory`.
  The existing owner + clientRequestId UUIDv5 namespace is retained for retries. A browser `new`
  flag, project, circle ID, or supplied override cannot attest fresh creation.
- `agents/resume` uses the same admission wrapper and fresh catalog. Its existing job-owner,
  tenant, original endpoint and checkpoint checks remain in place.
- Existing binding compares owner/member, endpoint and stable circle GUID. Model selection is
  freshly authorized; a same-circle model change does not rewrite or change the stored binding.
  Personal has no circle. Missing/invalid catalog attribution fails closed for a bound/new turn.
- Existing unbound records remain unbound. Normal import/fork/duplicate/shared-fork still use
  `importBatchBuilder`'s server UUIDv4 destination and owner/ID override. Their routes are not
  prohibited and do not copy binding rows. A chat-request override is a different path and cannot
  redirect an already bound source into another destination or claim fresh provenance.
- `/convos/update` rejects disagreeing top-level/arg IDs and saves with `noUpsert`; a missing
  conversation returns 404. `/messages/:conversationId` independently reauthorizes bound scope,
  holds occupancy, fences message identity to that conversation, and never upserts the conversation.

## Deletion and failure semantics

Mongo binding rows now retain durable operation IDs. Acquiring occupancy is a single-document
conditional write against the exact bound owner/member/circle/endpoint. Tombstone is permanent
and preserves occupancy; a subsequent acquire cannot win. The actual provider/background write
lifetime owns release, not the early HTTP response. Unrelated child-lease cleanup failure still
attempts circle release through `finally`.

Explicit single and bulk conversation deletion tombstones discovered IDs before physical deletion;
bulk discovery includes binding rows whose conversation is not yet saved. Existing generation
cancel/drain remains, followed by occupancy verification. An active/unknown occupancy causes a
failed, retryable deletion instead of successful deletion followed by a late save. It can require
a subsequent delete request after the execution drains. Historical unbound execution retains its
legacy behavior; this is not a retrofit of every legacy write into a global transaction.

No expiry/TTL/lease stealing is used for occupancy. Process crashes, ambiguous write/release results,
or rejected trailing persistence retain their operation IDs. Age, a missing local PID, a restarted
web process, and an empty generation-job list do not prove provider/background persistence quiescent.

### Controlled reconciliation (offline only)

No HTTP route, startup hook, timer or deletion retry invokes reconciliation. `occupancy(key)` is a
read-only exact-ID snapshot; `reconcileRetired(key, expectedOperations)` is an explicit data-layer
primitive for a separately authorized maintenance session, **not a liveness detector**.

1. Establish an authorized write-stop window for this exact deployment/tenant namespace. Stop
   admissions, imports, all provider workers, background callbacks and persistence retries on all
   replicas; prevent supervisors/queues from restarting them. A live service must not call this API.
2. Record namespace, owner, conversation, source/build, writer inventory and operation snapshot in
   private maintenance evidence. If any writer or delayed write can still run, stop; retain occupancy.
3. Retire that exact key first. Tombstone is permanent and prevents future guarded admissions.
   Re-read exact occupancy after retirement. Do not infer a new circle, restore a binding, or drop rows.
4. Only after independently establishing quiescence, call `reconcileRetired` with the observed
   operation array. Its single-document compare-and-set requires the same namespace/key,
   tombstone state and exact operations. Any concurrent change/mismatch returns false without clear;
   failures/unknown outcome require reread while the write-stop remains in force, never blind retry.
5. Confirm the tombstone remains and `idle(key)` is true. Resume guarded services, then retry the
   existing explicit delete route if physical removal is needed. Reconciliation itself deletes no
   conversation/message/binding and never resurrects an ID. Preserve all receipts.

This package tests the primitive on synthetic rows only; no live reconciliation was performed.
Direct DB changes, TTL jobs, restoration and unintegrated writers are outside the explicit-route
fence. Stopping only the local process is insufficient for a distributed deployment.

## Server configuration and rollback

No host configuration is changed by this commit. Identity/topology settings deliberately remain
server-only environment settings alongside the existing metadata trust configuration.

| Setting | Meaning |
| --- | --- |
| `OPENSCHOOL_CIRCLE_ADMISSION_ENABLED=true` | Enables fresh interactive circle binding. Defaults off. |
| `OPENSCHOOL_METADATA_NAMESPACE` | Trusted deployment/tenant namespace shared by admission and metadata. When present, existing binding enforcement remains active even if fresh admission is OFF. |
| `OPENSCHOOL_METADATA_TENANT_ID` | Optional exact trusted tenant; absent means untenant deployment. |
| `OPENSCHOOL_BINDING_TOPOLOGY=standalone` | Explicit Mongo standalone primary/local + journaled w:1 mode. |
| `OPENSCHOOL_BINDING_TOPOLOGY=replica-set` | Explicit primary/linearizable + journaled majority mode; also requires exact `OPENSCHOOL_BINDING_REPLICA_SET`. |
| `OPENSCHOOL_METADATA_ENABLED=true` | Still requires its dedicated key; now also requires admission explicitly ON, otherwise 503 and no grant resolution/title query. |

No topology auto-fallback. Missing/invalid store configuration or a mismatched `hello` fails closed.
Standalone ordering does not claim multinode failover guarantees. Turning admission OFF does not
disable existing binding checks while the namespace remains configured.

**Rollback to a Chat version without these guards requires metadata OFF.** Removing the namespace
also removes the ability to find/enforce its binding rows. After either unguarded interval, do not
simply turn metadata back on for that old namespace: content may have crossed scopes meanwhile.
Use an explicitly selected new namespace on the guarded version; retain old binding rows, leave
old conversations unbound/unmapped, and do not move, copy or backfill them. Reusing an old namespace
requires separately established continuity/reconciliation; the controller never infers it is safe.

Build API/data-schemas from the fixed reviewed source together before runtime use. New exports must
not be consumed through stale `dist`. The local focused tests load new code through Babel source;
they do not certify a complete application build. Two-service HTTP E2E and TC review are separate.

## Import collision boundary and mutation guards (Oct11)

Normal import/fork/duplicate/shared-fork still use the builder's new server UUID destination.
Before persistence, the guarded runtime claims a permanent `unbound` row in the same unique
namespace/owner/conversation identity as interactive binding and tombstones. Exactly one first
writer wins. A bound, retired or previously reserved destination cannot be overwritten. Pending
imports hold occupancy; delete tombstones them and waits rather than permitting late recreation.
Import completion removes only its operation ID; the row remains unbound permanently. Interactive
admission refuses pending imports, and existing completed imports retain legacy unbound behavior.
No browser circle, project, copied model or source binding creates attribution.

Only import bulk calls select insert-only mode; generic bulk methods retain their prior contract.
Conversations and messages receive fresh server `_id` receipts before IO. The owner/tenant/logical
IDs plus exact receipt IDs constrain partial-failure cleanup, so it cannot erase a colliding existing
row. Message ID collisions fail inserts rather than update another conversation. Imported timestamps,
project ownership validation and post-success tag accounting remain. An uncertain failure retains
reservation/occupancy even after attempted cleanup: late DB completion must not permit ID reuse.
A reservation acquired before a later batch collision is retained conservatively; no automatic sweep.

`PUT /messages/:conversationId/:messageId` (plain text and content part) and `/convos/update` rename
now use the shared mutation guard. They reauthorize the stored circle/model through the fresh catalog,
hold occupancy across writes, reject tombstones, and preserve legacy unbound edits. PUT additionally
matches conversationId at the database update, including the provenance merge branch. The UI's token
counting model cannot redirect the guard's scope. The existing separately guarded POST message save
still validates its requested endpoint/model. Generic project filing and feedback are not repurposed
as authoritative circle attribution.

Deletion pending is classified as HTTP409 `OPENSCHOOL_DELETION_PENDING`; scope mismatch, retired
conversation and unavailable admission have human-readable messages without identifiers. The existing
OpenSchool gateway renderer already decodes the serialized body. TC withdrew the earlier raw-JSON
inference; no renderer rewrite is included. Four focused rendering cases assert readable text and
absence of raw code/payload. Actual browser/dual-service acceptance remains the parent's work.

## Oct11 local verification boundary

Typed-only checkpoint `b1978cc50ffd040c2322590cf3e4882fd1b3c854` adds explicit execution factory
return contracts after runtime DTS caught TS9016; the earlier `b663ee373` array annotation alone was
insufficient. Both checkpoint and candidate pass `transpileDeclaration` isolated-declaration probes.
This is not a claim that the whole application builds. Runtime worker owns full current-package
build/boot; parent owns final same-source E2E and TC owns independent fixed-source review.

Local scripts/raw captures are under `.local/verification/circle-metadata/`, prefixed `oct11` or
`run-*-oct11`. They use inherited local test dependencies with source mapping, not new dist output.
Full workspace noEmit in this sparse tree cannot resolve all dependencies; expanded changed-module
checking retains inherited Winston/Meili/lodash diagnostics separately from the focused passing check.
Final receipt JSON records source commit, source-tree identity, commands, counts and exit codes.
No push, merge, tag, deployment, old database deletion or other-container cleanup was performed.

## Historical 7852 verification receipts

Windows Node v24.18.0; inherited local unit tools, no installation. Final API run: 9 suites,
542 passed / 0 skipped. Mongo 7 fixture: 13 passed / 0 skipped. Focused new-module strict noEmit:
0 diagnostics. Selected changed-file ESLint: clean. No Docker run was started after the parent's
Web full-suite resource reservation. No push, deployment, or generated dist is included.

Local captures live under `.local/verification/circle-metadata/` in this worktree:
`run-controller.ps1`, `controller-api.raw.txt`, `controller-mongo7.raw.txt`,
`controller-typecheck-focused.txt`, and `controller-eslint.txt`. The raw captures are actual
PowerShell-forwarded stdout/stderr, including PowerShell's native-stderr wrapper and expected
invalid-JSON test logging. They are not the earlier 572/6dcb transcriptions.

Mongo opt-in: `OPENSCHOOL_MONGO7_DOCKER=1`; image
`mongo@sha256:1f995ad6fdb93244a1addab1b58f934a0bc2f5643c38e02f5e9d7f0c7d227a7b`,
asserted Mongo 7.0.43. Without opt-in all 13 Mongo fixture cases skip; default-skip is not Mongo
validation. Only a uniquely owned disposable loopback container and synthetic database are used.
Expanded typechecking through the message method encounters inherited winston/Meili declaration
diagnostics; the focused new-module noEmit check is reported separately, not as a full workspace build.
