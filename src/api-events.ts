import type * as http from 'node:http';

export interface LiveEvent {
  sequence: number;
  atMs: number;
  type: string;
  data: Record<string, unknown>;
}

export class LiveEventHub {
  readonly #limit: number;
  readonly #events: LiveEvent[] = [];
  readonly #clients = new Set<http.ServerResponse>();
  #sequence = 0;
  #dropped = 0;

  constructor(limit = 512) { this.#limit = limit; }

  publish(type: string, data: Record<string, unknown>): LiveEvent {
    const event = { sequence: ++this.#sequence, atMs: Date.now(), type, data };
    this.#events.push(event);
    if (this.#events.length > this.#limit) this.#events.shift();
    const encoded = this.#encode(event);
    for (const client of this.#clients) {
      if (!client.write(encoded)) {
        this.#dropped += 1;
        client.end();
        this.#clients.delete(client);
      }
    }
    return event;
  }

  stream(request: http.IncomingMessage, response: http.ServerResponse, after: number): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const oldest = this.#events[0]?.sequence ?? this.#sequence + 1;
    if (after > this.#sequence) {
      response.write(this.#encode({ sequence: this.#sequence, atMs: Date.now(), type: 'reset', data: { reason: 'cursor_ahead' } }));
    } else if (after < oldest - 1) {
      response.write(this.#encode({ sequence: this.#sequence, atMs: Date.now(), type: 'reset', data: { reason: 'cursor_gap' } }));
    } else {
      for (const event of this.#events) if (event.sequence > after) response.write(this.#encode(event));
    }
    this.#clients.add(response);
    const heartbeat = setInterval(() => {
      if (!response.write(': heartbeat\n\n')) {
        this.#dropped += 1;
        response.end();
        this.#clients.delete(response);
      }
    }, 15_000);
    heartbeat.unref();
    const remove = () => { clearInterval(heartbeat); this.#clients.delete(response); };
    request.once('close', remove);
    response.once('close', remove);
  }

  stats(): { clients: number; dropped: number; sequence: number } {
    return { clients: this.#clients.size, dropped: this.#dropped, sequence: this.#sequence };
  }

  disconnectClients(): void {
    for (const client of this.#clients) client.end();
    this.#clients.clear();
  }

  close(): void { this.disconnectClients(); }

  #encode(event: LiveEvent): string {
    return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}
