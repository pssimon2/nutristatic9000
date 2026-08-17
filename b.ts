import { compileQuery } from "./src/find-expr.js";
import { SessionContext } from "./src/session-context.js";
import { languageEmptiness } from "./src/emptiness.js";
const ctx = new SessionContext();
const acc = (q: string, t: string) => {
  const f = compileQuery(q, ctx);
  let s = f.startState;
  for (const c of `${t} `) { s = f.transition(s, c.charCodeAt(0)); if (s < 0) return false; }
  return f.isAccepting(s);
};
for (const q of ["{bank:washington}", "{bank:washington}&A{5}", "A{5}"]) {
  console.log(`${q.padEnd(26)} emptiness=${languageEmptiness(compileQuery(q, ctx))}` +
    `  night=${acc(q, "night")}  ohio=${acc(q, "ohio")}  wash=${acc(q, "wash")}`);
}
