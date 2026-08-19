// Deploy in one command, with the mistakes made unmakeable.
//
//   NUTRISTATIC9000_DEPLOY=user@host:/srv/nutristatic9000 npm run deploy
//
// The sequence is build → copy the head sidecars into dist → rsync →
// check-deployed. The copy step is the one that matters: the heads live in
// web/heads/ (not in the repo, not in dist — a rebuild empties dist), and a
// deploy that forgets them silently makes every streamed search twenty times
// slower. Here they are copied for you, their presence is asserted before
// anything is uploaded, and the deployment is checked afterwards.
//
// The target host is configuration, not code: set NUTRISTATIC9000_DEPLOY in
// the environment (an rsync destination, `user@host:/path/`).

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const target = process.env.NUTRISTATIC9000_DEPLOY;
if (!target || !target.includes(":")) {
  console.error(
    "error: set NUTRISTATIC9000_DEPLOY to an rsync destination, e.g.\n" +
      "  NUTRISTATIC9000_DEPLOY=user@host:/srv/nutristatic9000 npm run deploy",
  );
  process.exit(2);
}

const run = (cmd, args) => {
  console.error(`# ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
};

run("npm", ["run", "build"]);

const heads = fs.existsSync("web/heads")
  ? fs.readdirSync("web/heads").filter((f) => f.endsWith(".head"))
  : [];
if (heads.length === 0) {
  console.error(
    "error: web/heads/ holds no .head sidecars — build them first:\n" +
      "  npm run build-head -- /path/to/en-wiki.index --out web/heads/en-wiki.head\n" +
      "Deploying without them makes every streamed search ~20x slower.",
  );
  process.exit(2);
}
for (const f of heads) {
  fs.copyFileSync(`web/heads/${f}`, `web/dist/${f}`);
}
console.error(`# copied ${heads.length} head sidecars into web/dist/`);

// An optional executable named by NUTRISTATIC9000_DEPLOY_HOOK runs here,
// with the dist directory as its argument — the place for additions
// specific to one hosting (a host's legal pages, extra files) that do not
// belong in this repo.
const hook = process.env.NUTRISTATIC9000_DEPLOY_HOOK;
if (hook) run(hook, ["web/dist"]);

run("rsync", ["-az", "--delete", "web/dist/", target.endsWith("/") ? target : `${target}/`]);

run("npx", ["tsx", "scripts/check-deployed.mjs"]);
console.error("# deploy complete and verified");
