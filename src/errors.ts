export class SlotenvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotenvError";
  }
}
