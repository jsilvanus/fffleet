# Isolated development workspaces: storage and recovery direction

- **Status:** Proposed integration architecture, aligned with SiSSi D-047
- **Date:** 2026-10-16

## Purpose

Extend fffleet's generic execution infrastructure to support isolated, interactive development environments as well as bounded jobs, without making fffleet specific to SiSSi. SiSSi owns scene/workspace authorization, authoring history, asset semantics, review, and publication. fffleet provides execution/job dispatch and runtime-provider integration; an approved isolation layer runs untrusted project code.

## Workload separation

Keep three lifecycles distinct:

- **Interactive development session:** long-running, one isolated environment per active workspace initially; human and AI clients share the project through authorized interfaces.
- **Disposable validation/build job:** short-lived isolated execution from a controlled snapshot, returning bounded logs/diagnostics and artifact references.
- **Ordinary fleet job:** existing batch/stream jobs continue to use fffleet's existing job contract and scheduling.

A regular worker must not execute untrusted project code in its own security context. It may dispatch or manage an isolated execution through a trusted wrapper/provider. Podman is the initial provider target for this integration, while the provider contract remains runtime-independent.

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

## Deliberately not specified yet

This document does not select a specific S3 vendor, bucket naming convention, incremental snapshot algorithm, checkpoint interval, or exact API. Those should be selected after storage sizing and failure/recovery requirements are measured. It also does not establish a new fffleet workspace API: the generic execution-provider and artifact contracts should be designed first.
