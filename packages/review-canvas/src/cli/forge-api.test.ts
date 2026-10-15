import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Fixture, withEnv } from "../collector/testing.ts";
import { addressOf } from "./hosted.ts";
import { credentialPassword, readForgeApi } from "./forge-api.ts";

const pull = addressOf(
  "https://git.something.company.com/team/project/-/merge_requests/42",
);

test("API credentials must match the selected HTTPS host, port, and repository", () => {
  assert.equal(
    credentialPassword(
      "protocol=https\nhost=git.something.company.com\npassword=fixture-token\n\n",
      pull,
    ),
    "fixture-token",
  );
  for (const reply of [
    "protocol=https\nhost=github.com\npassword=fixture-token\n",
    "protocol=http\nhost=git.something.company.com\npassword=fixture-token\n",
    "protocol=https\nhost=git.something.company.com:8443\npassword=fixture-token\n",
    "protocol=https\nhost=git.something.company.com\npath=another/project.git\npassword=fixture-token\n",
    "protocol=https\nhost=git.something.company.com\npassword=bad\rheader\n",
  ])
    assert.throws(() => credentialPassword(reply, pull));
});

test("HTTPS requests keep tokens off argv, disable redirects, and run helpers outside the reviewed clone", (t) => {
  const f = new Fixture(t);
  const bin = join(f.base, "bin");
  mkdirSync(bin);
  const gitLog = join(f.base, "git.json");
  const curlLog = join(f.base, "curl.json");
  const executable = (name: string, code: string) => {
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!${process.execPath}\nimport { readFileSync, writeFileSync } from 'node:fs';\n${code}`,
    );
    chmodSync(path, 0o755);
  };
  executable(
    "git",
    `writeFileSync(${JSON.stringify(gitLog)}, JSON.stringify({ args: process.argv.slice(2), input: readFileSync(0, 'utf8'), cwd: process.cwd(), prompt: process.env.GIT_TERMINAL_PROMPT, askpass: process.env.GIT_ASKPASS, routing: process.env.GIT_DIR }));\nprocess.stdout.write('protocol=https\\nhost=git.something.company.com\\npassword=fixture-token\\n\\n');`,
  );
  executable(
    "curl",
    `writeFileSync(${JSON.stringify(curlLog)}, JSON.stringify({ args: process.argv.slice(2), input: readFileSync(0, 'utf8'), cwd: process.cwd() }));\nprocess.stdout.write('{"ok":true}\\n' + (process.env.PA_TEST_HTTP_STATUS ?? '200'));`,
  );
  withEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_DIR: f.root }, () => {
    assert.deepEqual(
      readForgeApi(pull, "/api/v4/projects/team%2Fproject/merge_requests/42"),
      { ok: true },
    );
    const git = JSON.parse(readFileSync(gitLog, "utf8"));
    const curl = JSON.parse(readFileSync(curlLog, "utf8"));
    assert.equal(git.cwd, tmpdir());
    assert.equal(curl.cwd, tmpdir());
    assert.equal(git.routing, undefined);
    assert.equal(git.prompt, "0");
    assert.equal(git.askpass, "false");
    assert.match(
      git.input,
      /host=git\.something\.company\.com\npath=team\/project\.git/,
    );
    assert.equal(curl.input, "PRIVATE-TOKEN: fixture-token\n");
    assert.equal(
      curl.args.some((arg: string) => arg.includes("fixture-token")),
      false,
    );
    assert.equal(curl.args.includes("--location"), false);
    assert.equal(curl.args.includes("--insecure"), false);
    assert.equal(curl.args[curl.args.indexOf("--proto") + 1], "=https");
    assert.throws(
      () => readForgeApi(pull, "//other.company.com/api/v4/projects"),
      /leave/,
    );
    withEnv({ PA_TEST_HTTP_STATUS: "302" }, () =>
      assert.throws(() => readForgeApi(pull, "/api/v4/projects"), /redirected/),
    );
    const gitea = addressOf(
      "https://git.something.company.com/team/project/pulls/42",
    );
    readForgeApi(gitea, "/api/v1/repos/team/project/pulls/42");
    assert.equal(
      JSON.parse(readFileSync(curlLog, "utf8")).input,
      "Authorization: token fixture-token\n",
    );
  });
});

test("real Git credentials and curl work with a company's trusted HTTPS CA and refuse redirects", async (t) => {
  if (
    spawnSync("openssl", ["version"]).error !== undefined ||
    spawnSync("curl", ["--version"]).error !== undefined
  ) {
    t.skip("requires openssl and curl");
    return;
  }
  const f = new Fixture(t);
  const cert = join(f.base, "certificate.pem");
  const key = join(f.base, "key.pem");
  const config = join(f.base, "certificate.cnf");
  writeFileSync(
    config,
    "[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=extensions\n[subject]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n",
  );
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-config",
      config,
    ],
    { stdio: "ignore" },
  );
  assert.equal(generated.status, 0, "could not generate the isolated test CA");
  const entry = join(f.base, "https.mjs");
  writeFileSync(
    entry,
    `import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
const server = createServer({ key: readFileSync(process.argv[2]), cert: readFileSync(process.argv[3]) }, (req, res) => {
  if (req.headers['private-token'] !== 'fixture-api-token') { res.writeHead(401).end(); return; }
  if (req.url === '/api/v4/redirect') { res.writeHead(302, { location: 'https://another.company.invalid/api/v4/projects' }).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ authenticated: true, path: req.url }));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`,
  );
  const server = spawn(process.execPath, [entry, key, cert], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    server.kill("SIGTERM");
    if (server.exitCode === null) await once(server, "exit");
  });
  assert.ok(server.stdout);
  const [chunk] = await once(server.stdout, "data");
  const port = Number(String(chunk).trim());
  assert.ok(Number.isSafeInteger(port) && port > 0);
  const selected = addressOf(
    `https://localhost:${port}/team/project/-/merge_requests/42`,
  );
  const helper = join(f.base, "credential.mjs");
  writeFileSync(
    helper,
    `import { readFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8');
if (input.includes('protocol=https\\n') && input.includes('host=localhost:${port}\\n')) process.stdout.write('username=fixture\\npassword=fixture-api-token\\n');
else process.stdout.write('quit=true\\n');
`,
  );
  const quote = (word: string) => `'${word.replaceAll("'", `'"'"'`)}'`;
  writeFileSync(
    join(f.base, ".gitconfig"),
    `[credential]\nuseHttpPath = true\nhelper = ${JSON.stringify(`!${quote(process.execPath)} ${quote(helper)}`)}\n`,
  );
  withEnv(
    {
      HOME: f.base,
      XDG_CONFIG_HOME: join(f.base, "config"),
      GIT_CONFIG_GLOBAL: join(f.base, ".gitconfig"),
      CURL_CA_BUNDLE: cert,
    },
    () => {
      assert.deepEqual(readForgeApi(selected, "/api/v4/projects"), {
        authenticated: true,
        path: "/api/v4/projects",
      });
      assert.throws(
        () => readForgeApi(selected, "/api/v4/redirect"),
        /redirected/,
      );
      withEnv({ CURL_CA_BUNDLE: join(f.base, "missing-ca.pem") }, () =>
        assert.throws(
          () => readForgeApi(selected, "/api/v4/projects"),
          /HTTPS trust/,
        ),
      );
    },
  );
});
