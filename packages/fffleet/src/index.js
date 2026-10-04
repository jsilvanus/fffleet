export { createFleet, JobHandle } from './client.js';
export {
  CONTRACT_VERSION, KINDS, STATES, isFinal, validateSpec, parseSpec, ContractError,
  resolvePlaceholders, canonicalJson, implicitRequirements, FILE_SCHEMES, HTTP_SCHEMES, PASSTHROUGH_SCHEMES, OBJECT_SCHEMES,
} from './contract.js';
export { JobManager, normalizeSlots } from './job-manager.js';
export { JobRecord, FleetError, byPriority, pruneFinished } from './job-record.js';
export { runFfmpegJob } from './executor.js';
export { createProgressParser } from './progress.js';
export { detectCapabilities, satisfies } from './capabilities.js';
export { readSse, followJobEvents } from './sse.js';
export { createS3Client, s3ConfigFromEnv, parseS3Uri, contentTypeFor, signV4 } from './s3.js';
export { SCOPES, hashSecret, verifySecret, generateSecret, createTokenProvider } from './auth.js';
