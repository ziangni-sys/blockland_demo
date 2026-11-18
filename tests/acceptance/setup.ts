/**
 * Setup file of the acceptance projects (vitest.config.ts): the end checks of the test worlds
 * (tests/acceptance/world.ts finishWorlds: in network mode, the client's replica equals the
 * server) after each test for the worlds it made, after the file for those its beforeAll hooks made.
 */
import { afterAll, afterEach } from 'vitest';
import { finishWorlds } from './world';

afterEach((ctx) => finishWorlds('test', ctx.task.result?.state !== 'fail'));
afterAll(() => finishWorlds('file', true));
