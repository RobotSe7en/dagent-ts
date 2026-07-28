export class ThinkingStreamParser {
  readonly #enabled: boolean;
  #inReasoning = false;
  #buffer = '';

  public constructor(enabled = true) {
    this.#enabled = enabled;
  }

  public feed(chunk: string): readonly ThinkingPart[] {
    if (!this.#enabled) return [{ channel: 'content', content: chunk }];
    this.#buffer += chunk;
    const output: ThinkingPart[] = [];
    while (this.#buffer.length > 0) {
      const delimiter = this.#inReasoning ? '</think>' : '<think>';
      const index = this.#buffer.indexOf(delimiter);
      const channel = this.#inReasoning ? 'reasoning' : 'content';
      if (index >= 0) {
        if (index > 0) output.push({ channel, content: this.#buffer.slice(0, index) });
        this.#buffer = this.#buffer.slice(index + delimiter.length);
        this.#inReasoning = !this.#inReasoning;
        continue;
      }
      const keep = Math.min(this.#buffer.length, delimiter.length - 1);
      const emitLength = this.#buffer.length - keep;
      if (emitLength > 0) {
        output.push({ channel, content: this.#buffer.slice(0, emitLength) });
        this.#buffer = this.#buffer.slice(emitLength);
      }
      break;
    }
    return output;
  }

  public finish(): readonly ThinkingPart[] {
    if (this.#buffer.length === 0) return [];
    const part: ThinkingPart = {
      channel: this.#inReasoning ? 'reasoning' : 'content',
      content: this.#buffer,
    };
    this.#buffer = '';
    return [part];
  }
}

export type ThinkingPart = {
  readonly channel: 'reasoning' | 'content';
  readonly content: string;
};
