/**
 * Limitador de vazão por janela deslizante: garante que NUNCA há mais que
 * `capacity` aquisições em qualquer janela de `windowMs` — exatamente a
 * garantia exigida pelo rate limit da Clicksign (critério 3 da spec).
 *
 * (Um token bucket clássico com balde cheio permitiria capacidade + reposições
 * na primeira janela, estourando o limite real em rajadas.)
 */

export interface TokenBucketConfig {
  capacity: number;
  windowMs: number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];
  private readonly waiters: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: TokenBucketConfig) {
    if (config.capacity < 1) throw new Error('capacity deve ser >= 1');
    if (config.windowMs < 1) throw new Error('windowMs deve ser >= 1');
    this.capacity = config.capacity;
    this.windowMs = config.windowMs;
  }

  /** Resolve na hora se há vaga; senão entra na fila de espera até uma abrir. */
  async acquire(): Promise<void> {
    if (this.waiters.length === 0 && this.tryAcquire()) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.scheduleRelease();
    });
  }

  /** Tenta reservar uma vaga agora; true e registra o timestamp se couber na janela. */
  private tryAcquire(): boolean {
    this.prune();
    if (this.timestamps.length >= this.capacity) return false;
    this.timestamps.push(Date.now());
    return true;
  }

  /** Descarta timestamps mais velhos que a janela atual. */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }

  /** Agenda a próxima tentativa de liberar quem está esperando, no momento em que a vaga mais antiga expira. */
  private scheduleRelease(): void {
    if (this.timer !== null) return;
    this.prune();
    const oldest = this.timestamps[0];
    const delay = oldest === undefined ? 1 : Math.max(1, oldest + this.windowMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      while (this.waiters.length > 0 && this.tryAcquire()) {
        this.waiters.shift()?.();
      }
      if (this.waiters.length > 0) this.scheduleRelease();
    }, delay);
    // Não segura o processo vivo só por causa do timer.
    this.timer.unref?.();
  }
}
