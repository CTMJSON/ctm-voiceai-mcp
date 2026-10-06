/** Only deliberately safe messages cross the MCP boundary. Never expose upstream bodies. */
export class AppError extends Error {
  constructor(message: string, public readonly code: string, public readonly status?: number) {
    super(message);
    this.name = "AppError";
  }
}
