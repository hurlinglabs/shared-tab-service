export type Message = { type: string; payload?: unknown };

export class SharedTabService {
  private id = crypto.randomUUID();
  send(msg: Message) {
    return { from: this.id, ...msg };
  }
}
