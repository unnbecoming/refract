export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  readonly #onEvent: (event: SseEvent) => void;
  #buffer = '';
  #eventName = '';
  #data: string[] = [];
  #id: string | undefined;
  #hasData = false;
  #finished = false;

  constructor(onEvent: (event: SseEvent) => void) {
    this.#onEvent = onEvent;
  }

  push(bytes: Uint8Array): void {
    if (this.#finished) throw new Error('cannot push after SSE decoder finish');
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
    this.#drainLines(false);
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#buffer += this.#decoder.decode();
    this.#drainLines(true);
    if (this.#buffer.length > 0) {
      this.#consumeLine(this.#buffer);
      this.#buffer = '';
    }
    this.#dispatch();
  }

  #drainLines(final: boolean): void {
    let start = 0;
    for (let index = 0; index < this.#buffer.length; index += 1) {
      const char = this.#buffer[index];
      if (char !== '\n' && char !== '\r') continue;
      if (char === '\r' && index + 1 >= this.#buffer.length && !final) break;
      this.#consumeLine(this.#buffer.slice(start, index));
      if (char === '\r' && this.#buffer[index + 1] === '\n') index += 1;
      start = index + 1;
    }
    this.#buffer = this.#buffer.slice(start);
  }

  #consumeLine(line: string): void {
    if (line === '') {
      this.#dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#eventName = value;
    else if (field === 'data') { this.#data.push(value); this.#hasData = true; }
    else if (field === 'id' && !value.includes('\0')) this.#id = value;
  }

  #dispatch(): void {
    if (!this.#hasData) {
      this.#eventName = '';
      return;
    }
    const event: SseEvent = { event: this.#eventName || 'message', data: this.#data.join('\n') };
    if (this.#id !== undefined) event.id = this.#id;
    this.#onEvent(event);
    this.#eventName = '';
    this.#data = [];
    this.#hasData = false;
  }
}
