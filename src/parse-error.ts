// The error the parser throws.
//
// Its own module because `find-expr.ts` (which compiles a query) and
// `expr-parse.ts` (which parses one) both need it, and having it live in
// either made the two import each other — a cycle that ESM hoisting forgives
// right up until someone reorders a declaration.

export class ParseError extends Error {
  /**
   * True when the construct is spelled correctly but its side dataset is not
   * loaded. That is a fetch away from working, not a mistake in the query, so
   * as-you-type checking must not underline it.
   */
  readonly dataMissing: boolean;

  /**
   * `detail` explains a construct that was recognised but wrong — an unknown
   * name, a malformed comparison — where "can't parse" would leave the user
   * guessing which of two dozen constructs they mistyped.
   */
  constructor(
    readonly rest: string,
    readonly detail?: string,
    dataMissing = false,
  ) {
    super(detail ?? `can't parse "${rest}"`);
    this.dataMissing = dataMissing;
  }
}
