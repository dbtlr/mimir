import { consoleSchemas, engineSchemas, MimirError, parseEngineInput } from '@mimir/contract';
import type { ConsoleInput, EngineInput } from '@mimir/contract';
import { createServerFn } from '@tanstack/react-start';

import type { WireDoctorFacet, WireDoctorGroup, WireDoctorRecord } from '../types';
import { engine, recordHealth } from './engine';

/*
 * The browsers' server functions (MMR-540): the task, seed, and artifact
 * browsers, the seed and artifact pages, the seed writes, and record health.
 * Each Engine read or write is one method on the host's shared Engine, named
 * after it and validated by its contract input schema through
 * `parseEngineInput`, as in shell.ts. Reads are GETs and writes are POSTs. The
 * browsers are project-scoped (`/p/$key`), so they use the project-scoped
 * reads. The query policy (facets, keys, windows) stays in browse-queries.ts
 * and seed-mutations.ts.
 */

/** A project's tasks, filtered and windowed. */
export const list = createServerFn({ method: 'GET' })
  .validator((input: EngineInput<'list'>) => parseEngineInput(engineSchemas.list.input, input))
  .handler(async ({ data }) => (await engine()).list(data));

/** A project's frozen artifacts, filtered and windowed, newest first. */
export const artifacts = createServerFn({ method: 'GET' })
  .validator((input: EngineInput<'artifacts'>) =>
    parseEngineInput(engineSchemas.artifacts.input, input),
  )
  .handler(async ({ data }) => (await engine()).artifacts(data));

/** One artifact, with its frozen body when `content` is asked for. */
export const getArtifact = createServerFn({ method: 'GET' })
  .validator((input: EngineInput<'getArtifact'>) =>
    parseEngineInput(engineSchemas.getArtifact.input, input),
  )
  .handler(async ({ data }) => (await engine()).getArtifact(data));

/** A project's seeds in the lifecycle the caller selects. */
export const seeds = createServerFn({ method: 'GET' })
  .validator((input: EngineInput<'seeds'>) => parseEngineInput(engineSchemas.seeds.input, input))
  .handler(async ({ data }) => (await engine()).seeds(data));

/** One seed, with its body prose when `content` is asked for. */
export const getSeed = createServerFn({ method: 'GET' })
  .validator((input: EngineInput<'getSeed'>) =>
    parseEngineInput(engineSchemas.getSeed.input, input),
  )
  .handler(async ({ data }) => (await engine()).getSeed(data));

/** The open tasks on any board whose id or title holds the text. */
export const consoleOpenTasks = createServerFn({ method: 'GET' })
  .validator((input: ConsoleInput<'openTasks'>) =>
    parseEngineInput(consoleSchemas.openTasks.input, input),
  )
  .handler(async ({ data }) => (await engine()).console.openTasks(data));

/** The tasks on any board that name a seed as their upstream. */
export const consoleUpstreamTasks = createServerFn({ method: 'GET' })
  .validator((input: ConsoleInput<'upstreamTasks'>) =>
    parseEngineInput(consoleSchemas.upstreamTasks.input, input),
  )
  .handler(async ({ data }) => (await engine()).console.upstreamTasks(data));

/** File a seed on a board. */
export const seedCreate = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'seedCreate'>) =>
    parseEngineInput(engineSchemas.seedCreate.input, input),
  )
  .handler(async ({ data }) => (await engine()).seedCreate(data));

/** Edit a live seed's title, kind, or body. */
export const seedUpdate = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'seedUpdate'>) =>
    parseEngineInput(engineSchemas.seedUpdate.input, input),
  )
  .handler(async ({ data }) => (await engine()).seedUpdate(data));

/** Set a seed aside, with an optional reason. */
export const seedPark = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'seedPark'>) =>
    parseEngineInput(engineSchemas.seedPark.input, input),
  )
  .handler(async ({ data }) => (await engine()).seedPark(data));

/** Return a parked seed to the untriaged queue. */
export const seedUnpark = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'seedUnpark'>) =>
    parseEngineInput(engineSchemas.seedUnpark.input, input),
  )
  .handler(async ({ data }) => (await engine()).seedUnpark(data));

/** Promote a seed into a task. */
export const seedPromote = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'seedPromote'>) =>
    parseEngineInput(engineSchemas.seedPromote.input, input),
  )
  .handler(async ({ data }) => (await engine()).seedPromote(data));

/** Reject a seed, with a required reason. */
export const seedReject = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'seedReject'>) =>
    parseEngineInput(engineSchemas.seedReject.input, input),
  )
  .handler(async ({ data }) => (await engine()).seedReject(data));

/** Resolve a seed, with a required reason. */
export const seedResolve = createServerFn({ method: 'POST' })
  .validator((input: EngineInput<'seedResolve'>) =>
    parseEngineInput(engineSchemas.seedResolve.input, input),
  )
  .handler(async ({ data }) => (await engine()).seedResolve(data));

/** What the record-health read takes: an optional project to scope the scan to. */
export type DoctorInput = { project?: string };

/** Accept `{ project? }` only, refused as the Engine refuses a malformed input. */
function parseDoctorInput(input: unknown): DoctorInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new MimirError('validation', 'doctor takes { project? }');
  }
  const parsed: DoctorInput = {};
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'project' || typeof value !== 'string') {
      throw new MimirError('validation', 'doctor takes { project? }, a project key');
    }
    parsed.project = value;
  }
  return parsed;
}

/** A JSON value: what a finding's evidence holds, typed so a server function can return it. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** An object read back from the JSON text `JSON.stringify` wrote for it. */
function jsonObjectOf(text: string): Record<string, Json> {
  // JSON.parse answers `any`; text written from an object parses back to a JSON object.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(text) as Record<string, Json>;
}

/** The record-health facet with each finding's evidence as JSON. */
export type RecordHealth = Omit<WireDoctorFacet, 'groups'> & {
  groups: (Omit<WireDoctorGroup, 'records'> & {
    records: (Omit<WireDoctorRecord, 'evidence'> & { evidence: Record<string, Json> })[];
  })[];
};

/**
 * The facet in the shape a server function can return, each finding's evidence
 * passed through JSON as `/api/doctor` writes it: a `Date` reads as its ISO
 * string and an undefined field is dropped, so the console shows what the CLI
 * and the route show.
 */
export function recordHealthOf(facet: WireDoctorFacet): RecordHealth {
  return {
    ...facet,
    groups: facet.groups.map((group) => ({
      ...group,
      records: group.records.map((record) => ({
        ...record,
        evidence: jsonObjectOf(JSON.stringify(record.evidence)),
      })),
    })),
  };
}

/**
 * The record-health facet: `mimir doctor` findings, optionally scoped to one
 * project. A host read, not an Engine method (ADR 0034), served like /health.
 */
export const doctor = createServerFn({ method: 'GET' })
  .validator((input: DoctorInput) => parseDoctorInput(input))
  .handler(async ({ data }) => recordHealthOf(await recordHealth(data.project)));
