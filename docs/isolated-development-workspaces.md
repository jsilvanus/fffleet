# Generic isolated execution: integration boundary

- **Status:** Proposed integration boundary, aligned with SiSSi D-047
- **Date:** 2026-10-16

## Purpose

This document defines how an integrating application can use fffleet's generic job/execution capabilities for isolated media or project-code work. It does **not** propose moving application-specific workspace logic into fffleet. fffleet will not own interactive workspace/session lifecycle, workspace checkpoints, recovery policy, scene/asset semantics, or the SiSSi extended worker. That extended worker lives outside the fffleet repository.

fffleet remains generic: job contract, scheduling, worker capacity, execution-provider integration, and generic job status/logs/output references. The integrating application owns workspace authorization and lifecycle, authoring history, input/output meaning, recovery decisions, review, and publication.

**Implementation status:** this document describes a proposed integration boundary, not a currently available sandbox guarantee. The existing `process`, `docker`, and `hetzner` providers do not by themselves establish the disposable isolated-execution contract below. Until a provider/runtime is implemented and tested against it, ordinary fffleet jobs must be treated according to [the existing security model](security.md): submitted ffmpeg arguments and custom executors run with the worker's privileges.

## Workload separation

Keep application lifecycle separate from generic execution:

- **Application-owned interactive workspace:** the integrating application manages its workspace and any long-running development session. fffleet does not become the workspace/session authority.
- **Disposable isolated execution:** the application submits a bounded job from controlled inputs; the isolated runtime returns bounded logs/diagnostics and explicit output/artifact references.
- **Ordinary fleet job:** existing batch/stream jobs continue to use fffleet's existing generic job contract and scheduling.

A regular worker must not execute untrusted project code in its own security context. It may dispatch or manage a generic isolated execution through a trusted wrapper/provider. Podman is the initial provider target, while the provider contract remains runtime-independent. Any extended worker or application-specific adapter is outside this repository.

## Workspace and object-storage model

S3-compatible object storage is the durable object/artifact layer, not the live working filesystem:

- Managed project import creates a durable initial snapshot.
- Managed workspaces are checkpointed periodically and during planned shutdown.
- The live development environment uses a writable filesystem appropriate for Node/Vite and dependency caches, but that filesystem is ephemeral from the execution provider's perspective.
- **Ephemeral fffleet execution containers must not receive durable host bind mounts or persistent host volumes.** They must not use fffleet host directories as workspace storage or retain workspace/job data on the host after teardown. Provider-managed writable layers or scratch storage must be disposable and cleaned up with the execution environment; if the deployment's threat model forbids plaintext data touching host disks at all, enforce tmpfs or equivalent encrypted ephemeral scratch.
- Host-directory mounts are not part of this ephemeral execution model. If an integrating application supports a persistent host-mounted workspace mode, that is an application-owned, separately authorized feature and must not be silently introduced into fffleet's ephemeral job containers.
- Disposable jobs consume controlled snapshots through explicit input transfers and return required outputs through explicit, verified output transfers or artifact references. No durable binding is used as a shortcut for input/output exchange.
- Container stop, replacement, or loss does not imply workspace deletion.

Use trusted services or short-lived, narrowly scoped transfer grants to move objects. Never inject permanent, broadly privileged object-store credentials into untrusted containers. A transfer grant should be limited to the required operation and object/prefix, expire quickly, and be checked by trusted code. Verify content checksums and use idempotent transfer operations.

## Metadata and reconciliation

The application/controller remains authoritative for workspace ownership, session lifecycle, and user-facing status. Store metadata and lifecycle records in PostgreSQL where used by the integrating application; store snapshots and artifacts in S3-compatible object storage. Runtime labels/IDs are reconciliation hints, not the source of truth for authorization or workspace content.

After a controller restart, reconcile sessions against the provider, inspect health, and associate a recovered session only with its expected workspace identity. If the live workspace is lost or unusable, restore from the latest verified checkpoint. Never infer that a snapshot is valid merely because its object exists.

## Recovery requirements

Before implementation, specify and test:

- Checkpoint interval, retention, failure semantics, and maximum duration.
- Snapshot consistency for a changing multi-file tree; manifest format and atomic commit/promotion of completed snapshots.
- S3 layout, checksums, encryption, tenant isolation, quotas, versioning/retention, and garbage collection.
- Resumable/multipart transfers, retries, idempotency, and cleanup of incomplete or orphaned uploads.
- Restore-point selection, PostgreSQL PITR coordination, object availability, and restore drills.
- Behavior during object-store outage, invalid/corrupt checkpoints, quota exhaustion, and host-mount disappearance.
- Separate policies for workspace snapshots, transient logs, build artifacts, and immutable published outputs.
- Verify provider configuration and teardown so ephemeral containers have no durable bind mounts/volumes and no job data remains on the fffleet host after cleanup; define whether scratch must be memory-backed or encrypted at rest.

## Transfer boundary: primitives, not a sync service

fffleet provides generic job input staging, output collection/upload, and object-store transfer primitives where supported by the job contract. It does not run a separate always-on S3 synchronization service and does not define application workspace synchronization semantics.

The consumer owns the synchronization policy: which objects or snapshots to transfer, when to transfer them, what constitutes a checkpoint, which outputs are durable, how conflicts are handled, and how to recover after interruption. fffleet owns only the generic mechanics needed to stage declared job inputs and collect declared outputs.

For isolated execution, keep transfer credentials and policy in trusted consumer/provider-side code. Do not give untrusted job code broad object-store credentials. Prefer explicit, bounded input and output transfers, with checksums, retries and idempotency where the consumer requires them. Do not add continuous bidirectional sync unless a concrete consumer requirement justifies a separately designed interface.

## Deliberately not specified yet

This document does not select a specific S3 vendor, bucket naming convention, incremental snapshot algorithm, checkpoint interval, or exact API. Those are owned by the integrating application and should be selected after storage sizing and failure/recovery requirements are measured. It does not establish a fffleet workspace/session API or place the extended worker in this repository; only the generic isolated-execution and input/output contracts belong here.

## D-047 compatibility audit (2026-10-16)

This is a code-level compatibility check against [SiSSi D-047](https://github.com/jsilvanus/simple-smart-signage/blob/main/docs/decisions/D-047-durable-workspaces-and-s3-artifacts.md), not an implementation claim. The current branch was inspected across the job contract, executor, S3 client, input cache, autoscaler, and `process`, `docker`, and `hetzner` providers.

| D-047 requirement | Current fffleet evidence | Result |
|---|---|---|
| Complete, verified snapshots; atomic promotion; restore one internally consistent snapshot | The job contract and S3 client stage individual objects and upload output files/directories. There is no workspace snapshot, manifest, checkpoint promotion, or restore protocol. | **Not implemented; consumer-owned.** |
| Distinguish checkpointed edits from pending/failed edits | fffleet reports job states and transfer/job results, not workspace checkpoint durability. | **Not implemented; consumer-owned.** |
| Disposable execution has no durable host mounts/volumes and no host-backed workspace storage | The Docker provider creates containers without explicit bind mounts or volumes, but does not enforce tmpfs or non-persistent writable layers. Docker writable layers and the Hetzner worker's Docker container can use host-backed storage. The process provider starts a worker process on the host, and the normal job work directory/cache are filesystem paths. Container deletion is not proof that job data never persisted to host disk. | **Not satisfied or enforced.** Existing providers are not an isolated-execution boundary. |
| Persistent authoring workspace is a separately managed resource | fffleet has worker/job lifecycles and scratch/cache directories, not an authoring-workspace resource or lifecycle. | **Not implemented; consumer-owned.** |
| Explicit, authenticated, bounded, tenant/workspace-scoped transfers; no broad permanent S3 credentials in untrusted code | The job contract accepts `file:`, HTTP(S), and `s3:` URIs. S3 access uses credentials configured on the runner/worker; there is no per-job transfer grant, tenant/workspace authorization layer, or generic allowlisted transfer boundary. The current security model explicitly permits jobs to access files and networks available to the worker user. | **Not satisfied for untrusted execution.** Do not give this workload broad credentials or trust job URIs as authorization. |
| Archive paths and symlinks cannot escape the authorized workspace | The S3 directory uploader walks regular files and directories and does not follow directory symlinks, but fffleet has no workspace-scoped archive extraction/validation subsystem. Ordinary `file:` inputs and arbitrary FFmpeg arguments are not confined to a workspace root. | **No workspace containment guarantee.** Archive validation must be implemented by the consumer/transfer layer if archives are introduced. |
| Coordinated PostgreSQL/S3 recovery with tested consistency | fffleet does not own SiSSi's PostgreSQL workspace metadata, snapshots, publication, or recovery procedure. | **Consumer-owned; not implemented by fffleet.** |

### Required boundary before SiSSi uses fffleet for untrusted project code

1. Implement a separate isolated-execution provider/runtime contract. It must fail closed unless the runtime configuration satisfies the deployment's scratch-storage policy; merely omitting bind mounts is insufficient to prove that data cannot persist on host disks.
2. Keep existing `process`, `docker`, and `hetzner` providers classified as ordinary worker providers until each has a separately tested isolation implementation. Do not route untrusted project code to them on the strength of this proposal.
3. Keep tenant/workspace authorization, checkpoint validity and promotion, visible durability state, persistent authoring workspaces, and coordinated PostgreSQL/S3 recovery in SiSSi.
4. If fffleet provides generic transfer primitives for isolated jobs, make the allowed inputs/outputs explicit and bounded, verify integrity, and keep credentials and authorization in trusted code. Do not treat ordinary job URIs or worker-wide S3 credentials as a scoped transfer grant.
5. Add integration tests for the actual runtime configuration and teardown, including evidence for the required scratch persistence properties. Unit tests of provider request payloads alone cannot prove host-disk non-persistence.

This audit records the current gap; it does not claim that the isolation or workspace-transfer features above have been implemented.

