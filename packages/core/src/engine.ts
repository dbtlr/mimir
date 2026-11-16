import {
  consoleIntentViews,
  consoleSchemas,
  decodeDelivery,
  decodeDeliverySince,
  decodeDecision,
  engineSchemas,
  intentViews,
  parseEngineInput,
} from '@mimir/contract';
import type { ConsoleEngine, Engine, EngineInput, Scratchpad } from '@mimir/contract';

import { addItem, checkItem, dropItem } from './checklist/intent';
import { decide, decisions, getDecision, updateDecision, answerDecision } from './decisions/intent';
import { refuseDecisionInput } from './decisions/refusal';
import {
  addLimitation,
  createDelivery,
  declineFinding,
  getDelivery,
  sinceDelivery,
  listDeliveries,
  updateDelivery,
  transitionDelivery,
} from './deliveries';
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
  updateArtifactEngine,
  updateEngine,
  updateProjectEngine,
} from './engine-node-writes';
import { notFound, projectNotFound } from './errors';
import { compareScratchpadRows } from './format';
import {
  buildArtifactDetail,
  getArtifact,
  getNode,
  listArtifacts,
  listNodes,
  nextTasks,
  overviewOf,
  overviewScratchpadOf,
  statusOfNode,
} from './intent';
import type { FindingsProvider } from './intent/console';
import {
  nodeWorkOf,
  openTasksOf,
  projectOverviewOf,
  projectWorkOf,
  reviewPageOf,
  upstreamTasksOf,
} from './intent/console';
import { listProjects, listProjectsByRemote, nodeTree } from './resource';
import { createScratchpadService } from './scratchpads';
import type { ScratchpadService } from './scratchpads';
import { searchRecords } from './search/intent';
import {
  fileSeed,
  getSeed,
  listSeeds,
  parkSeed,
  promoteSeed,
  transitionSeed,
  triage,
  unparkSeed,
  updateSeed,
} from './seeds';
import type { Store } from './store';

/** What the host supplies to the Engine. Core never runs doctor itself. */
export type LocalEngineOptions = {
  /** Per-project `doctor` finding counts for `console.review`; absent counts no findings. */
  findings?: FindingsProvider;
};

/** The store-owning Engine; transports use the same methods locally or remotely. */
export class LocalEngine extends UniformEngineBase implements Engine {
  protected readonly store: Store;
  readonly console: ConsoleEngine;

  constructor(store: Store, options: LocalEngineOptions = {}) {
    super();
    this.store = store;
    this.console = consoleMethods(store, options);
  }

  private get scratchpads() {
    return createScratchpadService(this.store.scratchpads, this.store.artifacts, this.store);
  }

  /** An archived or unknown project reads as absent (ADR 0015), as overview refuses it. */
  private async isActiveProject(key: string) {
    const found = (await this.store.loadProjects()).find((candidate) => candidate.key === key);
    return found !== undefined && found.archived_at === null;
  }

  async decisions(input: EngineInput<'decisions'>) {
    return (
      await decisions(this.store, parseEngineInput(engineSchemas.decisions.input, input))
    ).map(decodeDecision);
  }
  async decide(input: EngineInput<'decide'>) {
    return decodeDecision(
      await decide(this.store, parseEngineInput(engineSchemas.decide.input, input)),
    );
  }
  async getDecision(input: EngineInput<'getDecision'>) {
    return decodeDecision(
      await getDecision(this.store, parseEngineInput(engineSchemas.getDecision.input, input).id),
    );
  }
  async decisionUpdate(input: EngineInput<'decisionUpdate'>) {
    return decodeDecision(
      await updateDecision(this.store, parseEngineInput(engineSchemas.decisionUpdate.input, input)),
    );
  }
  async confirm(input: EngineInput<'confirm'>) {
    return decodeDecision(
      await answerDecision(
        this.store,
        'confirm',
        parseEngineInput(engineSchemas.confirm.input, input),
      ),
    );
  }
  async overturn(input: EngineInput<'overturn'>) {
    return decodeDecision(
      await answerDecision(
        this.store,
        'overturn',
        parseEngineInput(engineSchemas.overturn.input, input),
      ),
    );
  }

  async itemAdd(input: EngineInput<'itemAdd'>) {
    const { task, content } = parseEngineInput(engineSchemas.itemAdd.input, input);
    return addItem(this.store, task, content);
  }
  async itemCheck(input: EngineInput<'itemCheck'>) {
    const { task, number } = parseEngineInput(engineSchemas.itemCheck.input, input);
    return checkItem(this.store, task, number);
  }
  async itemDrop(input: EngineInput<'itemDrop'>) {
    const { task, number, reason } = parseEngineInput(engineSchemas.itemDrop.input, input);
    return dropItem(this.store, task, number, reason);
  }

  async deliveryStart(input: EngineInput<'deliveryStart'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryStart.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'start', args));
  }

  async deliveryBlock(input: EngineInput<'deliveryBlock'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryBlock.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'block', args));
  }

  async deliveryUnblock(input: EngineInput<'deliveryUnblock'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryUnblock.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'unblock', args));
  }

  async deliveryPark(input: EngineInput<'deliveryPark'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryPark.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'park', args));
  }

  async deliveryUnpark(input: EngineInput<'deliveryUnpark'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryUnpark.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'unpark', args));
  }

  async deliverySubmit(input: EngineInput<'deliverySubmit'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliverySubmit.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'submit', args));
  }

  async deliveryReturn(input: EngineInput<'deliveryReturn'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryReturn.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'return', args));
  }

  async deliveryLand(input: EngineInput<'deliveryLand'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryLand.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'land', args));
  }

  async deliveryAbandon(input: EngineInput<'deliveryAbandon'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryAbandon.input, input);
    return decodeDelivery(await transitionDelivery(this.store, 'abandon', args));
  }

  async deliveryLimitation(input: EngineInput<'deliveryLimitation'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryLimitation.input, input);
    return decodeDelivery(await addLimitation(this.store, args));
  }

  async deliveryDecline(input: EngineInput<'deliveryDecline'>) {
    refuseDecisionInput(input);
    const args = parseEngineInput(engineSchemas.deliveryDecline.input, input);
    return decodeDelivery(await declineFinding(this.store, args));
  }

  async deliveryCreate(input: EngineInput<'deliveryCreate'>) {
    refuseDecisionInput(input);
    return decodeDelivery(
      await createDelivery(this.store, parseEngineInput(engineSchemas.deliveryCreate.input, input)),
    );
  }

  async deliveryUpdate(input: EngineInput<'deliveryUpdate'>) {
    refuseDecisionInput(input);
    return decodeDelivery(
      await updateDelivery(this.store, parseEngineInput(engineSchemas.deliveryUpdate.input, input)),
    );
  }

  async getDelivery(input: EngineInput<'getDelivery'>) {
    refuseDecisionInput(input);
    const { id } = parseEngineInput(engineSchemas.getDelivery.input, input);
    return decodeDelivery(await getDelivery(this.store, id));
  }

  async deliverySince(input: EngineInput<'deliverySince'>) {
    refuseDecisionInput(input);
    return decodeDeliverySince(
      await sinceDelivery(this.store, parseEngineInput(engineSchemas.deliverySince.input, input)),
    );
  }

  async deliveries(input: EngineInput<'deliveries'>) {
    refuseDecisionInput(input);
    const { project } = parseEngineInput(engineSchemas.deliveries.input, input);
    return (await listDeliveries(this.store, project)).map(decodeDelivery);
  }

  async artifacts(input: EngineInput<'artifacts'>) {
    refuseDecisionInput(input);
    const { project, ...opts } = parseEngineInput(engineSchemas.artifacts.input, input);
    return intentViews.artifactSet.parse(
      await listArtifacts(this.store, { ...opts, scope: project }),
    );
  }

  async getArtifact(input: EngineInput<'getArtifact'>) {
    refuseDecisionInput(input);
    const { id, content } = parseEngineInput(engineSchemas.getArtifact.input, input);
    return intentViews.artifactDetail.parse(await getArtifact(this.store, id, { content }));
  }

  async getNode(input: EngineInput<'getNode'>) {
    refuseDecisionInput(input);
    const { id, facets } = parseEngineInput(engineSchemas.getNode.input, input);
    const node = await getNode(this.store, id, { facets });
    if (node.type === 'task') {
      node.decisions = await this.store.decisions.forTask(node.id);
      node.items = await this.store.checklist.forTask(node.id);
    }
    return intentViews.node.parse(node);
  }

  async getSeed(input: EngineInput<'getSeed'>) {
    refuseDecisionInput(input);
    const { id, content } = parseEngineInput(engineSchemas.getSeed.input, input);
    return intentViews.seed.parse(await getSeed(this.store, id, { content }));
  }

  async list(input: EngineInput<'list'>) {
    refuseDecisionInput(input);
    const { project, ...opts } = parseEngineInput(engineSchemas.list.input, input);
    return intentViews.nodeSet.parse(await listNodes(this.store, { ...opts, scope: project }));
  }

  async next(input: EngineInput<'next'>) {
    refuseDecisionInput(input);
    const { project, ...opts } = parseEngineInput(engineSchemas.next.input, input);
    return intentViews.nodeSet.parse(await nextTasks(this.store, { ...opts, scope: project }));
  }

  async overview(input: EngineInput<'overview'>) {
    refuseDecisionInput(input);
    const { project, asOf } = parseEngineInput(engineSchemas.overview.input, input);
    return intentViews.overview.parse(
      await overviewOf(this.store, project, { asOf: asOf?.toISOString() }),
    );
  }

  async projects(input: EngineInput<'projects'>) {
    refuseDecisionInput(input);
    const { facets, status } = parseEngineInput(engineSchemas.projects.input, input);
    return intentViews.nodes.parse(await listProjects(this.store, facets, status));
  }

  /** Every active project whose Git remote is the same repository as `remote`, key-ordered. */
  async projectsByRemote(input: EngineInput<'projectsByRemote'>) {
    refuseDecisionInput(input);
    const { facets, remote } = parseEngineInput(engineSchemas.projectsByRemote.input, input);
    return intentViews.nodes.parse(await listProjectsByRemote(this.store, remote, facets));
  }

  async scratchGet(input: EngineInput<'scratchGet'>) {
    refuseDecisionInput(input);
    const { id } = parseEngineInput(engineSchemas.scratchGet.input, input);
    const scratchpad = await this.scratchpads.get(id);
    if (!(await this.isActiveProject(scratchpad.project))) {
      throw notFound(`${id} doesn't exist`);
    }
    return intentViews.scratchpad.parse(scratchpad);
  }

  async scratchList(input: EngineInput<'scratchList'>) {
    refuseDecisionInput(input);
    const { project } = parseEngineInput(engineSchemas.scratchList.input, input);
    if (!(await this.isActiveProject(project))) {
      throw projectNotFound(project);
    }
    const rows = (await this.scratchpads.list(project)).toSorted(compareScratchpadRows);
    return intentViews.scratchpadRows.parse(rows.map(overviewScratchpadOf));
  }

  async search(input: EngineInput<'search'>) {
    refuseDecisionInput(input);
    const opts = parseEngineInput(engineSchemas.search.input, input);
    return intentViews.searchSet.parse(
      await searchRecords(this.store, { ...opts, projectOnly: true }),
    );
  }

  async seeds(input: EngineInput<'seeds'>) {
    refuseDecisionInput(input);
    const opts = parseEngineInput(engineSchemas.seeds.input, input);
    return intentViews.seeds.parse(await listSeeds(this.store, opts));
  }

  async status(input: EngineInput<'status'>) {
    refuseDecisionInput(input);
    const { id } = parseEngineInput(engineSchemas.status.input, input);
    return intentViews.status.parse(await statusOfNode(this.store, id));
  }

  async tree(input: EngineInput<'tree'>) {
    refuseDecisionInput(input);
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

  updateArtifact(input: EngineInput<'updateArtifact'>) {
    return updateArtifactEngine(this.store, input);
  }

  updateProject(input: EngineInput<'updateProject'>) {
    return updateProjectEngine(this.store, input);
  }

  // Seed and Scratchpad writes (MMR-518). Seed verbs guard their own board. A Scratchpad
  // in an archived project reads as absent to every id-keyed write, as it does to
  // `scratchGet`.

  /** Refuse a Scratchpad write whose project is archived, as an absent record would be. */
  private async assertScratchpadWritable(id: string) {
    const scratchpad = await this.store.scratchpads.load(id);
    if (scratchpad !== undefined && !(await this.isActiveProject(scratchpad.project))) {
      throw notFound(`${id} doesn't exist`);
    }
  }

  /** Run one id-keyed Scratchpad write and decode the Scratchpad it returns. */
  private async scratchWrite(
    id: string,
    write: (service: ScratchpadService) => Promise<Scratchpad>,
  ) {
    await this.assertScratchpadWritable(id);
    return intentViews.scratchpad.parse(await write(this.scratchpads));
  }

  async scratchAgendaAdd(input: EngineInput<'scratchAgendaAdd'>) {
    refuseDecisionInput(input);
    const { id, expectedUpdatedAt, content } = parseEngineInput(
      engineSchemas.scratchAgendaAdd.input,
      input,
    );
    return this.scratchWrite(id, (service) =>
      service.agendaAdd(id, { content, expectedUpdatedAt: expectedUpdatedAt.toISOString() }),
    );
  }

  async scratchAgendaComplete(input: EngineInput<'scratchAgendaComplete'>) {
    refuseDecisionInput(input);
    const { id, expectedUpdatedAt, number } = parseEngineInput(
      engineSchemas.scratchAgendaComplete.input,
      input,
    );
    return this.scratchWrite(id, (service) =>
      service.agendaComplete(id, { expectedUpdatedAt: expectedUpdatedAt.toISOString(), number }),
    );
  }

  async scratchAgendaSupersede(input: EngineInput<'scratchAgendaSupersede'>) {
    refuseDecisionInput(input);
    const { id, expectedUpdatedAt, number, reason } = parseEngineInput(
      engineSchemas.scratchAgendaSupersede.input,
      input,
    );
    return this.scratchWrite(id, (service) =>
      service.agendaSupersede(id, {
        expectedUpdatedAt: expectedUpdatedAt.toISOString(),
        number,
        reason,
      }),
    );
  }

  async scratchCheckpoint(input: EngineInput<'scratchCheckpoint'>) {
    refuseDecisionInput(input);
    const { id, expectedUpdatedAt, content } = parseEngineInput(
      engineSchemas.scratchCheckpoint.input,
      input,
    );
    return this.scratchWrite(id, (service) =>
      service.checkpoint(id, { content, expectedUpdatedAt: expectedUpdatedAt.toISOString() }),
    );
  }

  async scratchCreate(input: EngineInput<'scratchCreate'>) {
    refuseDecisionInput(input);
    const opts = parseEngineInput(engineSchemas.scratchCreate.input, input);
    return intentViews.scratchpad.parse(await this.scratchpads.create(opts));
  }

  async scratchDiscard(input: EngineInput<'scratchDiscard'>) {
    refuseDecisionInput(input);
    const { id, expectedUpdatedAt, force, reason } = parseEngineInput(
      engineSchemas.scratchDiscard.input,
      input,
    );
    await this.assertScratchpadWritable(id);
    await this.scratchpads.discard(id, {
      expectedUpdatedAt: expectedUpdatedAt.toISOString(),
      force,
      reason,
    });
    return intentViews.scratchpadDiscard.parse({ id, result: 'discarded' });
  }

  async scratchFreeze(input: EngineInput<'scratchFreeze'>) {
    refuseDecisionInput(input);
    const { id, expectedUpdatedAt, summary, tags } = parseEngineInput(
      engineSchemas.scratchFreeze.input,
      input,
    );
    await this.assertScratchpadWritable(id);
    const artifact = await this.scratchpads.freeze(id, {
      expectedUpdatedAt: expectedUpdatedAt.toISOString(),
      summary,
      tags,
    });
    // A recovered freeze (the pad is already gone) returns the existing artifact, so its
    // project is checked here: an archived project's artifacts read as absent.
    if (!(await this.isActiveProject(artifact.key))) {
      throw notFound(`${id} doesn't exist`);
    }
    return intentViews.artifactDetail.parse(buildArtifactDetail(artifact));
  }

  async scratchUpdate(input: EngineInput<'scratchUpdate'>) {
    refuseDecisionInput(input);
    const { id, expectedUpdatedAt, anchors, title } = parseEngineInput(
      engineSchemas.scratchUpdate.input,
      input,
    );
    return this.scratchWrite(id, (service) =>
      service.updateMetadata(id, {
        anchors,
        expectedUpdatedAt: expectedUpdatedAt.toISOString(),
        title,
      }),
    );
  }

  async seedCreate(input: EngineInput<'seedCreate'>) {
    refuseDecisionInput(input);
    const opts = parseEngineInput(engineSchemas.seedCreate.input, input);
    return intentViews.seed.parse(await fileSeed(this.store, opts));
  }

  async seedPark(input: EngineInput<'seedPark'>) {
    refuseDecisionInput(input);
    const { id, reason } = parseEngineInput(engineSchemas.seedPark.input, input);
    return intentViews.seed.parse(await parkSeed(this.store, id, reason));
  }

  async seedPromote(input: EngineInput<'seedPromote'>) {
    refuseDecisionInput(input);
    const { id, ...opts } = parseEngineInput(engineSchemas.seedPromote.input, input);
    return intentViews.seedPromotion.parse(await promoteSeed(this.store, id, opts));
  }

  async seedReject(input: EngineInput<'seedReject'>) {
    refuseDecisionInput(input);
    const { id, reason } = parseEngineInput(engineSchemas.seedReject.input, input);
    return intentViews.seed.parse(await transitionSeed(this.store, id, 'rejected', reason));
  }

  async seedResolve(input: EngineInput<'seedResolve'>) {
    refuseDecisionInput(input);
    const { id, reason } = parseEngineInput(engineSchemas.seedResolve.input, input);
    return intentViews.seed.parse(await transitionSeed(this.store, id, 'resolved', reason));
  }

  async seedUnpark(input: EngineInput<'seedUnpark'>) {
    refuseDecisionInput(input);
    const { id } = parseEngineInput(engineSchemas.seedUnpark.input, input);
    return intentViews.seed.parse(await unparkSeed(this.store, id));
  }

  async seedUpdate(input: EngineInput<'seedUpdate'>) {
    refuseDecisionInput(input);
    const { id, ...fields } = parseEngineInput(engineSchemas.seedUpdate.input, input);
    return intentViews.seed.parse(await updateSeed(this.store, id, fields));
  }

  async triage(input: EngineInput<'triage'>) {
    refuseDecisionInput(input);
    const opts = parseEngineInput(engineSchemas.triage.input, input);
    return intentViews.triageReport.parse(await triage(this.store, opts));
  }
}

/** Instants cross core as ISO strings; the page options take them that way. */
const isoOf = (instant: Date | undefined) => instant?.toISOString();

/** The console's views: core assembles them, the schemas decode their instants into `Date`s. */
function consoleMethods(store: Store, options: LocalEngineOptions): ConsoleEngine {
  return {
    async nodeWork(input) {
      const { asOf, id, timeZone } = parseEngineInput(consoleSchemas.nodeWork.input, input);
      return consoleIntentViews.work.parse(
        await nodeWorkOf(store, id, { asOf: isoOf(asOf), timeZone }),
      );
    },
    async openTasks(input) {
      const { q } = parseEngineInput(consoleSchemas.openTasks.input, input);
      return intentViews.nodeSet.parse(await openTasksOf(store, q));
    },
    async overview(input) {
      const { asOf, project } = parseEngineInput(consoleSchemas.overview.input, input);
      return intentViews.overview.parse(
        await projectOverviewOf(store, project, { asOf: isoOf(asOf) }),
      );
    },
    async projectWork(input) {
      const { asOf, project, timeZone } = parseEngineInput(consoleSchemas.projectWork.input, input);
      return consoleIntentViews.work.parse(
        await projectWorkOf(store, project, { asOf: isoOf(asOf), timeZone }),
      );
    },
    async review(input) {
      const { asOf, timeZone } = parseEngineInput(consoleSchemas.review.input, input);
      return consoleIntentViews.review.parse(
        await reviewPageOf(store, options.findings, { asOf: isoOf(asOf), timeZone }),
      );
    },
    async search(input) {
      const opts = parseEngineInput(consoleSchemas.search.input, input);
      return intentViews.searchSet.parse(await searchRecords(store, opts));
    },
    async upstreamTasks(input) {
      const { seed } = parseEngineInput(consoleSchemas.upstreamTasks.input, input);
      return intentViews.nodeSet.parse(await upstreamTasksOf(store, seed));
    },
  };
}
