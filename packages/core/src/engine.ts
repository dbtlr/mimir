import { engineSchemas, intentViews, parseEngineInput } from '@mimir/contract';
import type { Engine, EngineInput } from '@mimir/contract';

import {
  annotateEngine,
  attachEngine,
  createEngine,
  dependEngine,
  groomEngine,
  moveEngine,
  reorderEngine,
  tagEngine,
  undependEngine,
  UniformEngineBase,
  untagEngine,
  updateEngine,
  updateProjectEngine,
} from './engine-node-writes';
import { notFound, projectNotFound } from './errors';
import { compareScratchpadRows } from './format';
import {
  getArtifact,
  getNode,
  listArtifacts,
  listNodes,
  nextTasks,
  overviewOf,
  overviewScratchpadOf,
  statusOfNode,
} from './intent';
import { listProjects, nodeTree } from './resource';
import { createScratchpadService } from './scratchpads';
import { searchRecords } from './search/intent';
import { getSeed, listSeeds } from './seeds';
import type { Store } from './store';

/** The store-owning Engine; transports use the same methods locally or remotely. */
export class LocalEngine extends UniformEngineBase implements Engine {
  protected readonly store: Store;

  constructor(store: Store) {
    super();
    this.store = store;
  }

  private get scratchpads() {
    return createScratchpadService(this.store.scratchpads, this.store.artifacts, this.store);
  }

  /** An archived or unknown project reads as absent (ADR 0015), as overview refuses it. */
  private async isActiveProject(key: string) {
    const found = (await this.store.loadProjects()).find((candidate) => candidate.key === key);
    return found !== undefined && found.archived_at === null;
  }

  async artifacts(input: EngineInput<'artifacts'>) {
    const { project, ...opts } = parseEngineInput(engineSchemas.artifacts.input, input);
    return intentViews.artifactSet.parse(
      await listArtifacts(this.store, { ...opts, scope: project }),
    );
  }

  async getArtifact(input: EngineInput<'getArtifact'>) {
    const { id, content } = parseEngineInput(engineSchemas.getArtifact.input, input);
    return intentViews.artifactDetail.parse(await getArtifact(this.store, id, { content }));
  }

  async getNode(input: EngineInput<'getNode'>) {
    const { id, facets } = parseEngineInput(engineSchemas.getNode.input, input);
    return intentViews.node.parse(await getNode(this.store, id, { facets }));
  }

  async getSeed(input: EngineInput<'getSeed'>) {
    const { id, content } = parseEngineInput(engineSchemas.getSeed.input, input);
    return intentViews.seed.parse(await getSeed(this.store, id, { content }));
  }

  async list(input: EngineInput<'list'>) {
    const { project, ...opts } = parseEngineInput(engineSchemas.list.input, input);
    return intentViews.nodeSet.parse(await listNodes(this.store, { ...opts, scope: project }));
  }

  async next(input: EngineInput<'next'>) {
    const { project, ...opts } = parseEngineInput(engineSchemas.next.input, input);
    return intentViews.nodeSet.parse(await nextTasks(this.store, { ...opts, scope: project }));
  }

  async overview(input: EngineInput<'overview'>) {
    const { project, asOf } = parseEngineInput(engineSchemas.overview.input, input);
    return intentViews.overview.parse(
      await overviewOf(this.store, project, { asOf: asOf?.toISOString() }),
    );
  }

  async projects(input: EngineInput<'projects'>) {
    const { facets, status } = parseEngineInput(engineSchemas.projects.input, input);
    return intentViews.nodes.parse(await listProjects(this.store, facets, status));
  }

  async scratchGet(input: EngineInput<'scratchGet'>) {
    const { id } = parseEngineInput(engineSchemas.scratchGet.input, input);
    const scratchpad = await this.scratchpads.get(id);
    if (!(await this.isActiveProject(scratchpad.project))) {
      throw notFound(`${id} doesn't exist`);
    }
    return intentViews.scratchpad.parse(scratchpad);
  }

  async scratchList(input: EngineInput<'scratchList'>) {
    const { project } = parseEngineInput(engineSchemas.scratchList.input, input);
    if (!(await this.isActiveProject(project))) {
      throw projectNotFound(project);
    }
    const rows = (await this.scratchpads.list(project)).toSorted(compareScratchpadRows);
    return intentViews.scratchpadRows.parse(rows.map(overviewScratchpadOf));
  }

  async search(input: EngineInput<'search'>) {
    const opts = parseEngineInput(engineSchemas.search.input, input);
    return intentViews.searchSet.parse(
      await searchRecords(this.store, { ...opts, projectOnly: true }),
    );
  }

  async seeds(input: EngineInput<'seeds'>) {
    const opts = parseEngineInput(engineSchemas.seeds.input, input);
    return intentViews.seeds.parse(await listSeeds(this.store, opts));
  }

  async status(input: EngineInput<'status'>) {
    const { id } = parseEngineInput(engineSchemas.status.input, input);
    return intentViews.status.parse(await statusOfNode(this.store, id));
  }

  async tree(input: EngineInput<'tree'>) {
    const { id, facets } = parseEngineInput(engineSchemas.tree.input, input);
    return intentViews.tree.parse(await nodeTree(this.store, id, facets));
  }

  // Node writes (MMR-517): one method per verb, in their own block.
  annotate(input: EngineInput<'annotate'>) {
    return annotateEngine(this.store, input);
  }

  attach(input: EngineInput<'attach'>) {
    return attachEngine(this.store, input);
  }

  create(input: EngineInput<'create'>) {
    return createEngine(this.store, input);
  }

  depend(input: EngineInput<'depend'>) {
    return dependEngine(this.store, input);
  }

  groom(input: EngineInput<'groom'>) {
    return groomEngine(this.store, input);
  }

  move(input: EngineInput<'move'>) {
    return moveEngine(this.store, input);
  }

  reorder(input: EngineInput<'reorder'>) {
    return reorderEngine(this.store, input);
  }

  tag(input: EngineInput<'tag'>) {
    return tagEngine(this.store, input);
  }

  undepend(input: EngineInput<'undepend'>) {
    return undependEngine(this.store, input);
  }

  untag(input: EngineInput<'untag'>) {
    return untagEngine(this.store, input);
  }

  update(input: EngineInput<'update'>) {
    return updateEngine(this.store, input);
  }

  updateProject(input: EngineInput<'updateProject'>) {
    return updateProjectEngine(this.store, input);
  }
}
