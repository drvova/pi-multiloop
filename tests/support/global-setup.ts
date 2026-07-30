import { drawSeed, SEED_ENV } from "./seed.js";

/**
 * Runs once per `vitest` invocation, before any worker forks. Draws the run
 * seed unless one was pinned, publishes it to the workers via the environment,
 * and prints it where a failing CI log will show it.
 */
export default function globalSetup() {
  const pinned = process.env[SEED_ENV];
  const seed = pinned ?? drawSeed();
  process.env[SEED_ENV] = seed;

  const origin = pinned ? "pinned" : "random";
  console.log(
    `\n  pi-multiloop test seed: ${seed} (${origin})` +
    `\n  reproduce this exact run: ${SEED_ENV}=${seed} npx vitest run\n`
  );
}
