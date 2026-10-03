import { Counter } from "./counter";
export { Counter };

interface CounterStub {
  increment(n: number): Promise<number>;
}

interface CounterNamespace {
  idFromName(name: string): CounterStub;
}

interface Env {
  COUNTER: CounterNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname === "/record-call" && req.method === "POST") {
      let body: { caller_id?: string };

      try {
        body = await req.json();
      } catch {
        return Response.json(
          { error: "Invalid JSON" },
          { status: 400 }
        );
      }

      if (!body.caller_id) {
        return Response.json(
          { error: "caller_id is required" },
          { status: 400 }
        );
      }

      // Each caller gets their own Stateful Actor instance.
      const counter = env.COUNTER.idFromName(body.caller_id);

      // Counter.increment() performs the single-threaded
      // read -> modify -> write operation.
      const callCount = await counter.increment(1);

      console.log(JSON.stringify({
        event: "call_count_incremented",
        success: true,
        call_count: callCount
      }));

      return Response.json({
        success: true,
        call_count: callCount
      });
    }

    return Response.json(
      { error: "Not found" },
      { status: 404 }
    );
  },
};
