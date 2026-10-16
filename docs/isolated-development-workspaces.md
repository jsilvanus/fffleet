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
- The live development environment uses a writable filesystem appropriate for Node/Vite and dependency caches.
- Host-directory mounts are a separate explicitly authorized mode. Their host directory remains authoritative; S3 checkpoints are recovery copies.
- Disposable jobs consume controlled snapshots and return outputs as verified object references.
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

## Deliberately not specified yet

This document does not select a specific S3 vendor, bucket naming convention, incremental snapshot algorithm, checkpoint interval, or exact API. Those should be selected after storage sizing and failure/recovery requirements are measured. It also does not establish a new fffleet workspace API: the generic execution-provider and artifact contracts should be designed first.
