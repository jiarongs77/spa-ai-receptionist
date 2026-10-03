# call-session

A Telnyx Edge **StatefulActor** project, scaffolded with `telnyx-edge new-func --actor`.

> **Preview.** StatefulActor support is in preview — this project is ready to
> build against and ship with `telnyx-edge`; the surface may still change
> before general availability.

## Layout

| File | Purpose |
| --- | --- |
| `telnyx.toml` | Project manifest. Declares the `COUNTER` actor binding (mapped to the `Counter` class) and the function identity. |
| `src/index.ts` | The function entry point (`main`). Handles HTTP requests, calls the actor through `env.COUNTER`, and re-exports the `Counter` class so it ships with the function. |
| `src/counter.ts` | The `Counter` actor class. |
| `package.json` / `tsconfig.json` | TypeScript project configuration. |

## Deploy

Install dependencies and ship:

```sh
npm install
telnyx-edge ship
```

## Using the actor

`src/index.ts` resolves an actor instance by name and calls a method on it:

```ts
const counter = env.COUNTER.idFromName("demo");
const value = await counter.increment(1);
```

`COUNTER` is the binding declared under `[[actors]]` in `telnyx.toml`; it maps to
the `Counter` class in `src/counter.ts`. Add methods to that class and call them
through the binding. Generate the `env.COUNTER` types (`Env`) with
`telnyx-edge types`.
