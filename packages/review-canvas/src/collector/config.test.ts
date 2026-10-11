// Not in the Python suite. The config parser decides which files and working trees the git check covers, so it must
// read every form Git reads; each case here is checked against Git itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configEntries } from "./config.ts";
import { configuredWorktrees } from "./git.ts";
import { records } from "./paths.ts";
import { Fixture, script, withEnv } from "./testing.ts";

const BOM = String.fromCharCode(0xfeff);

/** What git config --list prints for text, up to the line where Git stops if it rejects the file. */
const gitList = (f: Fixture, text: string) => {
  const path = join(f.base, "check.config");
  writeFileSync(path, text);
  const { stdout } = spawnSync(
    "git",
    ["config", "-f", path, "--no-includes", "-z", "--list"],
    { cwd: f.base },
  );
  return records(stdout).map((record) => {
    const newline = record.indexOf(0x0a);
    return newline < 0
      ? [record.toString(), null]
      : [
          record.subarray(0, newline).toString(),
          record.subarray(newline + 1).toString(),
        ];
  });
};

const ourList = (text: string) =>
  configEntries(text).map((entry) => [
    entry.section === "" ? entry.key : `${entry.section}.${entry.key}`,
    entry.value,
  ]);

test("config text reads as git config --list reads it, up to the first line Git rejects", (t) => {
  const f = new Fixture(t);
  const texts = [
    "[core]\n\tworktree = /a\n",
    "[CORE]\n\tWorkTree = /b\n",
    "[core]worktree=/c\n",
    '[core] worktree = "/d e" # comment\n',
    "[core]\n\tworktree = /e\\\n/f\n",
    "[core]\n\tworktree = /g\t/h \t \n",
    '[core]\n\tworktree = "/i\\"j\\\\k\\tl"\n',
    "[core]\n\tworktree = /m ; comment\n",
    `${BOM}[core]\n\tworktree = /n\n`,
    "[core]\r\n\tworktree = /o\r\n",
    "[core]\n\tworktree = /p\rq  \n",
    '[includeIf\t"gitdir:/"]\n\tpath = /r\n',
    '[includeIf \t "gitdir:/"]\n\tpath = /s\n',
    '[includeIf "gitdir:\\/x\\"y z"]\n\tpath = /t\n',
    "[include]\n\tpath = /u\n[Include]path=/v\n",
    "[include.sub]\n\tpath = /w\n[core.Sub]\n\tworktree = /x\n",
    '[core "x"]\n\tworktree = /y\n[ "z"]\n\tworktree = /z\n',
    "# comment\n; comment\n[core]\n\t# indented\n\tworktree = /aa\n",
    "[core]\n\tbare\n\tworktree =\n\tother\n",
    "worktree = /before-any-section\n[core]\n\tworktree = /bb\n",
    "[core]\n\tworktree = a\\",
    "[core]\n\tworktree = /cc\n\tbare # comment\n\tworktree = /after\n",
    '[core "x" ]\n\tworktree = /dd\n',
    "[ core ]\n\tworktree = /ee\n",
    '[core]\n\tworktree = "unterminated\n\tworktree = /after\n',
    "[core]\n\tworktree = \\q\n",
    "[core]\n\tworktree = /ff\n\t1key = x\n\tworktree = /after\n",
    "[co_re]\n\tworktree = /gg\n",
    "[core]\n\tworktree\r= /hh\n",
    '[includeIf "gitdir:/\n"]\n\tpath = /ii\n',
    "[]\n\tworktree = /jj\n",
  ];
  for (const text of texts)
    assert.deepEqual(ourList(text), gitList(f, text), JSON.stringify(text));
});

test("every include and core.worktree form Git reads names a worktree the git check covers", (t) => {
  const f = new Fixture(t);
  f.commit({ "a.txt": "a\n" });
  const outside = join(f.base, "checkout");
  mkdirSync(outside);
  const extra = join(f.base, "extra.config");
  const config = join(f.root, ".git", "config");
  const original = readFileSync(config, "utf8");
  const includes = [
    "[include]\n\tpath = ../../extra.config\n",
    "[Include]path=../../extra.config\n",
    '[includeIf "gitdir:/"]\n\tpath = "../../extra.config"\n',
    '[includeIf\t"gitdir:/"]\n\tpath = ../../extra.config\n',
    '[includeIf \t "gitdir:/"]\n\tpath = ../../extra.config ; comment\n',
    '[includeif "gitdir:\\/"]\n\tpath = ../../extra\\\n.config\n',
    '[includeIf "gitdir:/"]\r\n\tpath = ../../extra.config\r\n',
  ];
  const worktrees = [
    `[core]\n\tworktree = "${outside}"\n`,
    `[CORE]WorkTree=${outside}\n`,
    `[core]\n\tworktree = ${outside} # comment\n`,
    `[core]\n\tworktree = ${outside.slice(0, 5)}\\\n${outside.slice(5)}\n`,
    `${BOM}[core]\n\tworktree = ${outside}\n`,
  ];
  for (const include of includes) {
    for (const worktree of worktrees) {
      writeFileSync(config, original + include);
      writeFileSync(extra, worktree);
      const form = JSON.stringify(include + worktree);
      assert.equal(
        f.git(f.root, "config", "--get", "core.worktree").trim(),
        outside,
        `Git reads ${form}`,
      );
      assert.ok(configuredWorktrees(f.root).includes(outside), form);
    }
  }
  // End to end, with the tab that a parser splitting on a space alone would miss.
  const marker = join(f.base, "tab-git-ran");
  script(join(outside, "bin", "git"), `touch '${marker}'\nexit 1\n`);
  writeFileSync(
    config,
    `${original}[includeIf\t"gitdir:/"]\n\tpath = ../../extra.config\n`,
  );
  writeFileSync(extra, `[core]\n\tworktree = ${outside}\n`);
  withEnv({ PATH: `${join(outside, "bin")}:${process.env.PATH}` }, () =>
    assert.throws(() => f.collect(), {
      _tag: "GitError",
      message: /inside the repository under review/,
    }),
  );
  assert.ok(!existsSync(marker));
});
