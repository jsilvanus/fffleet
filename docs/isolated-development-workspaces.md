# Generic isolated execution: integration boundary

- **Status:** Proposed integration boundary, aligned with SiSSi D-047
- **Date:** 2026-10-16

## Purpose

This document defines how an integrating application can use fffleet's generic job/execution capabilities for isolated media or project-code work. It does **not** propose moving application-specific workspace logic into fffleet. fffleet will not own interactive workspace/session lifecycle, workspace checkpoints, recovery policy, scene/asset semantics, or the SiSSi extended worker. That extended worker lives outside the fffleet repository.

fffleet remains generic: job contract, scheduling, worker capacity, execution-provider integration, and generic job status/logs/output references. The integrating application owns workspace authorization and lifecycle, authoring history, input/output meaning, recovery decisions, review, and publication.

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
