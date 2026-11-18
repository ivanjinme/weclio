import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildSkillUpdateArgs,
  checkSkillUpdate,
  checkSkillUpdates,
} = await jiti.import("./skill-updates.ts");

function install(overrides = {}) {
  return {
    package: "owner/repo@example-skill",
    scope: "global",
    source: "owner/repo",
    sourceType: "github",
    skillsShUrl: "https://skills.sh/owner/repo/example-skill",
    skillPath: "skills/example-skill/SKILL.md",
    versionHash: "current-hash",
    canCheckForUpdates: true,
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("compares a global lock version with the remote Git tree", async () => {
  const seen = [];
  const upToDate = await checkSkillUpdate(install(), {
    fetcher: async (url) => {
      seen.push(url);
      return jsonResponse({
        sha: "root-hash",
        tree: [{ type: "tree", path: "skills/example-skill", sha: "current-hash" }],
      });
    },
  });

  assert.equal(upToDate.state, "up-to-date");
  assert.equal(upToDate.latestVersion, "current-hash");
  assert.match(seen[0], /repos\/owner\/repo\/git\/trees\/HEAD/);

  const available = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({
      sha: "root-hash",
      tree: [{ type: "tree", path: "skills/example-skill", sha: "next-hash" }],
    }),
  });
  assert.equal(available.state, "update-available");
  assert.equal(available.currentVersion, "current-hash");
  assert.equal(available.latestVersion, "next-hash");
});

test("uses the repository hash for a root global skill", async () => {
  const result = await checkSkillUpdate(install({ skillPath: "SKILL.md" }), {
    fetcher: async () => jsonResponse({ sha: "next-root", tree: [] }),
  });

  assert.equal(result.state, "update-available");
  assert.equal(result.latestVersion, "next-root");
});

test("compares a project lock version with the skills.sh snapshot", async () => {
  let requestedUrl = "";
  const result = await checkSkillUpdate(install({ scope: "project" }), {
    skillsApiBase: "https://skills.test",
    fetcher: async (url) => {
      requestedUrl = url;
      return jsonResponse({ hash: "current-hash" });
    },
  });

  assert.equal(result.state, "up-to-date");
  assert.equal(
    requestedUrl,
    "https://skills.test/api/download/owner/repo/example-skill",
  );
});

test("returns unsupported without making a remote request", async () => {
  let called = false;
  const result = await checkSkillUpdate(
    install({ canCheckForUpdates: false, versionHash: undefined }),
    { fetcher: async () => { called = true; return jsonResponse({}); } },
  );

  assert.equal(result.state, "unsupported");
  assert.equal(called, false);
});

test("returns a scoped error when the remote check fails", async () => {
  const result = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({}, 503),
  });

  assert.equal(result.state, "error");
  assert.equal(result.message, "HTTP 503");
  assert.equal(result.scope, "global");
  assert.equal(result.package, "owner/repo@example-skill");
});

test("falls back to Git when the GitHub API is rate limited", async () => {
  let resolved = false;
  const result = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({}, 403),
    resolveGitTreeHash: async () => {
      resolved = true;
      return "next-hash";
    },
  });

  assert.equal(resolved, true);
  assert.equal(result.state, "update-available");
  assert.equal(result.latestVersion, "next-hash");
});

test("builds Pi-only update commands for each scope", () => {
  assert.deepEqual(buildSkillUpdateArgs(install()), [
    "skills",
    "add",
    "owner/repo/skills/example-skill",
    "--skill",
    "example-skill",
    "-y",
    "--agent",
    "pi",
    "-g",
  ]);
  assert.deepEqual(buildSkillUpdateArgs(install({ scope: "project" })), [
    "skills",
    "add",
    "owner/repo/skills/example-skill",
    "--skill",
    "example-skill",
    "-y",
    "--agent",
    "pi",
  ]);
  assert.deepEqual(buildSkillUpdateArgs(install({ ref: "release/v2" })), [
    "skills",
    "add",
    "owner/repo/skills/example-skill#release%2Fv2",
    "--skill",
    "example-skill",
    "-y",
    "--agent",
    "pi",
    "-g",
  ]);
});

test("reuses one remote request for skills from the same GitHub source", async () => {
  let requests = 0;
  const results = await checkSkillUpdates([
    install(),
    install({
      package: "owner/repo@another-skill",
      skillPath: "skills/another-skill/SKILL.md",
      versionHash: "another-hash",
    }),
  ], {
    fetcher: async () => {
      requests++;
      return jsonResponse({
        sha: "root-hash",
        tree: [
          { type: "tree", path: "skills/example-skill", sha: "current-hash" },
          { type: "tree", path: "skills/another-skill", sha: "another-hash" },
        ],
      });
    },
  });

  assert.equal(requests, 1);
  assert.deepEqual(results.map((item) => item.state), ["up-to-date", "up-to-date"]);
});

test("shares local Git fallbacks by source and ref, keeps lookup errors scoped, and cleans up", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "weclio-git-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scratch = join(root, "scratch");
  const trace = join(root, "git-trace.jsonl");
  const config = join(root, "gitconfig");
  mkdirSync(scratch);
  const env = {
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0",
    GIT_ALLOW_PROTOCOL: "file", GIT_TRACE2_EVENT: trace,
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const git = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repo = (name) => {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, ["init", "--initial-branch=main", "--object-format=sha1"]);
    git(dir, ["config", "uploadpack.allowFilter", "true"]);
    return dir;
  };
  const revision = (dir, contents) => {
    for (const [skill, text] of Object.entries(contents)) {
      mkdirSync(join(dir, "skills", skill), { recursive: true });
      writeFileSync(join(dir, "skills", skill, "SKILL.md"), text);
    }
    git(dir, ["add", "skills"]);
    const tree = git(dir, ["write-tree"]);
    return git(dir, ["commit-tree", tree, "-m", "Fixture revision"]);
  };
  const first = repo("first");
  const second = repo("second");
  const main = revision(first, { "example-skill": "first", "another-skill": "second" });
  git(first, ["update-ref", "refs/heads/main", main]);
  const release = revision(first, { "example-skill": "release" });
  git(first, ["update-ref", "refs/heads/release", release]);
  const other = revision(second, { "example-skill": "other repo" });
  git(second, ["update-ref", "refs/heads/main", other]);
  for (const [source, dir] of [["repo", first], ["other", second]]) {
    git(root, ["config", "--file", config, `url.${pathToFileURL(dir).href}.insteadOf`, `https://github.com/owner/${source}.git`]);
  }
  const hash = (dir, ref, skill) => git(dir, ["rev-parse", `${ref}:skills/${skill}`]);
  const example = hash(first, main, "example-skill");
  const another = hash(first, main, "another-skill");
  const requests = [];
  const fetcher = async (url) => {
    requests.push(url);
    return jsonResponse({}, 429);
  };
  const gitEvents = () => readFileSync(trace, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const gitStarts = (command) => gitEvents().filter((event) => event.event === "start" && event.argv.some((arg, i) => i > 0 && arg === command));
  const treeInstall = (skill, overrides = {}) => install({ package: `owner/repo@${skill}`, skillPath: `skills/${skill}/SKILL.md`, ...overrides });

  const results = await checkSkillUpdates([
    treeInstall("example-skill", { versionHash: example }),
    treeInstall("missing-skill"),
    treeInstall("another-skill", { ref: "HEAD" }),
    install({ package: "owner/repo@root-skill", skillPath: "SKILL.md" }),
    treeInstall("example-skill", { ref: "release" }),
    treeInstall("example-skill", { source: "owner/other", package: "owner/other@example-skill" }),
    treeInstall("example-skill", { ref: "missing-ref" }),
    treeInstall("another-skill", { ref: "missing-ref" }),
  ], { fetcher });

  assert.deepEqual(results.map(({ state, latestVersion }) => [state, latestVersion]), [
    ["up-to-date", example],
    ["error", undefined],
    ["update-available", another],
    ["update-available", git(first, ["rev-parse", `${main}^{tree}`])],
    ["update-available", hash(first, release, "example-skill")],
    ["update-available", hash(second, other, "example-skill")],
    ["error", undefined],
    ["error", undefined],
  ]);
  assert.equal(results[1].package, "owner/repo@missing-skill");
  assert.match(results[1].message, /FETCH_HEAD:skills\/missing-skill/);
  assert.match(results[6].message, /missing-ref/);
  assert.match(results[7].message, /missing-ref/);
  assert.equal(requests.length, 4);
  assert.equal(gitStarts("fetch").length, 4);
  assert.equal(gitStarts("init").filter((event) => event.argv.includes("--bare")).length, 4);
  assert.deepEqual(readdirSync(scratch), []);

  const later = await checkSkillUpdate(treeInstall("example-skill"), { fetcher });
  assert.equal(later.latestVersion, example);
  assert.equal(gitStarts("fetch").length, 5);
  assert.deepEqual(readdirSync(scratch), []);

  // 模拟一个仓库无法删除，另一个仓库仍须清理且两项校验结果都保留。
  const rm = fsPromises.rm;
  let failedDir;
  t.mock.method(fsPromises, "rm", async (dir, options) => {
    if (readFileSync(join(dir, "FETCH_HEAD"), "utf8").startsWith(main)) {
      failedDir = dir;
      throw new Error("fixture cleanup failure");
    }
    return rm(dir, options);
  });
  syncBuiltinESMExports();
  const diagnostic = t.mock.method(console, "error", () => {});
  try {
    const { checkSkillUpdates: checkWithCleanupMock } = await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import("./skill-updates.ts");
    const checked = await checkWithCleanupMock([
      treeInstall("example-skill", { versionHash: example }),
      treeInstall("example-skill", { source: "owner/other", package: "owner/other@example-skill" }),
    ], { fetcher });
    assert.deepEqual(checked.map(({ state, latestVersion }) => [state, latestVersion]), [
      ["up-to-date", example],
      ["update-available", hash(second, other, "example-skill")],
    ]);
    assert.ok(failedDir);
    assert.deepEqual(readdirSync(scratch).map((name) => join(scratch, name)), [failedDir]);
    assert.equal(diagnostic.mock.callCount(), 1);
    assert.match(diagnostic.mock.calls[0].arguments.join(" "), /fixture cleanup failure/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
