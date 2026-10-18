/**
 * The preload `wiki/app/bunfig.toml` declares: one scratch home and temporary
 * folder per `bun test` run of this app (madarch-1xq). The mechanism is the
 * engine's file, shared rather than copied — the app is a separate package
 * with its own lockfile, but it runs inside the checkout that holds that file,
 * and one implementation cannot drift from itself the way two can.
 */
export * from '../../../test/run-scratch.js';
