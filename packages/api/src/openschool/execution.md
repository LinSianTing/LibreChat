# SPEC34 conversation admission integration

Source baseline: `6dcb7fac63a9445b75ae7ee19f29857f0127a06e`. This is a bounded
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
or rejected trailing persistence may leave an operation ID indefinitely. This package supplies
**no automatic recovery or manual reconciliation tool**. Operators must establish that no provider
or persistence work can still run before any separately reviewed reconciliation. Do not delete
tombstones or clear occupancy merely because time passed. Direct DB changes, TTL jobs, backup
restoration and other unintegrated writers are outside this explicit-route guarantee.

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

## Explicit remaining bulk-import boundary

Read-only review confirms normal clone/import destinations are newly generated server UUIDv4;
there is no demonstrated caller-selected destination in those routes. Existing bulk persistence
still uses owner/ID upsert, and cleanup is scoped by generated conversation IDs rather than a
receipt of only inserted rows. A forced/colliding destination could therefore overwrite/delete
another row, including an attribution race before an interactive conversation is first saved.
Random generation is not a concurrency proof. This package does not claim that theoretical path
is closed and does not prohibit normal manual fork/import to conceal it.

The stronger follow-up is insert-only bulk writes, receipts identifying only this batch's inserts
for partial-failure cleanup, and a shared creation reservation against interactive binding. It needs
focused review of bulk message IDs, project/tag accounting and rollback. Per the bounded task, that
data-layer expansion is deferred; no production rollout is authorized by this candidate.

## Verification receipts

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
