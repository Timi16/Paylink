import type { Request, Response } from "express";

const PING_MS = 25_000;

export interface SseStream {
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
}

/** Tracks every open stream so shutdown can close them and limits can be enforced. */
export class SseRegistry {
  private readonly streams = new Set<SseStream>();
  private readonly perKey = new Map<string, number>();

  get total(): number {
    return this.streams.size;
  }

  count(key: string): number {
    return this.perKey.get(key) ?? 0;
  }

  /** Opens a stream counted against `key` (an IP or a merchant id). */
  open(req: Request, res: Response, key: string): SseStream {
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 3000\n\n");

    let closed = false;
    const ping = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, PING_MS);
    ping.unref();

    const stream: SseStream = {
      get closed() {
        return closed;
      },
      send: (event, data) => {
        if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close: () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        this.streams.delete(stream);
        const left = this.count(key) - 1;
        if (left > 0) this.perKey.set(key, left);
        else this.perKey.delete(key);
        res.end();
      },
    };
    this.streams.add(stream);
    this.perKey.set(key, this.count(key) + 1);
    req.on("close", stream.close);
    res.on("error", stream.close);
    return stream;
  }

  closeAll(): void {
    for (const stream of [...this.streams]) stream.close();
  }
}
