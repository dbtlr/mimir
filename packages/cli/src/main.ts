#!/usr/bin/env bun
/** The Loom CLI's entry: run argv, and leave the exit code to Loom. */
import { runMimir } from './app';

await runMimir();
