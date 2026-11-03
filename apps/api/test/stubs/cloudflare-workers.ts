/** Sustituto de "cloudflare:workers" para los tests en Node. */
export class DurableObject<E = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: E,
  ) {}
}
