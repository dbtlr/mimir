/**
 * The seed lane classifier (MMR-245) lives in the contract, so the console
 * reads the same lane from an Engine seed as the CLI and the `/api` wire do.
 */
export { seedLane } from '@mimir/contract';
