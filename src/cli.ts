#!/usr/bin/env bun
/**
 * The `deskkit` bin — wiring only. Each module contributes its own command
 * (e.g. `sqlite`'s `gen-migrations`); this file just assembles them under the
 * `deskkit` root and runs the result.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { Command } from 'effect/unstable/cli';
import { genMigrationsCommand } from '#/sqlite/gen-migrations.ts';
import packageJson from '../package.json' with { type: 'json' };

const deskkit = Command.make('deskkit').pipe(
	Command.withSubcommands([genMigrationsCommand]),
);

const program = Command.run(deskkit, { version: packageJson.version }).pipe(
	Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program);
