/**
 * Counting the D1 queries of one piece of work. A Worker invocation may make 50 of them on the
 * Free plan, and every statement inside a batch() counts as one, so a long job (the cron run)
 * meters itself and stops starting new work before D1 starts refusing it.
 */

export class QueryMeter {
  used = 0;
}

type StatementSource = Pick<D1Database, 'prepare' | 'batch'>;

class MeteredStatement implements D1PreparedStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    private readonly meter: QueryMeter,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new MeteredStatement(this.inner.bind(...values), this.meter);
  }

  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  first<T>(colName?: string): Promise<T | null> {
    this.meter.used++;
    return colName === undefined ? this.inner.first<T>() : this.inner.first<T>(colName);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.meter.used++;
    return this.inner.run<T>();
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.meter.used++;
    return this.inner.all<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
    this.meter.used++;
    return options?.columnNames ? this.inner.raw<T>({ columnNames: true }) : this.inner.raw<T>({ columnNames: false });
  }
}

/** The wrapped database's own statement: batch() only accepts those. */
const unwrap = (statement: D1PreparedStatement): D1PreparedStatement => (statement instanceof MeteredStatement ? statement.inner : statement);

class MeteredSource {
  constructor(
    private readonly source: StatementSource,
    protected readonly meter: QueryMeter,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new MeteredStatement(this.source.prepare(query), this.meter);
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.meter.used += statements.length;
    return this.source.batch<T>(statements.map(unwrap));
  }
}

class MeteredSession extends MeteredSource implements D1DatabaseSession {
  constructor(
    private readonly session: D1DatabaseSession,
    meter: QueryMeter,
  ) {
    super(session, meter);
  }

  getBookmark(): D1SessionBookmark | null {
    return this.session.getBookmark();
  }
}

class MeteredDatabase extends MeteredSource implements D1Database {
  constructor(
    private readonly db: D1Database,
    meter: QueryMeter,
  ) {
    super(db, meter);
  }

  async exec(query: string): Promise<D1ExecResult> {
    // One call can run several statements; D1 reports how many.
    const result = await this.db.exec(query);
    this.meter.used += result.count;
    return result;
  }

  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    return new MeteredSession(this.db.withSession(constraintOrBookmark), this.meter);
  }

  dump(): Promise<ArrayBuffer> {
    this.meter.used++;
    return this.db.dump();
  }
}

/** `db` with every query it runs counted on `meter`. */
export function meteredDb(db: D1Database, meter: QueryMeter): D1Database {
  return new MeteredDatabase(db, meter);
}
