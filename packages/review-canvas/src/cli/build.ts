/**
 * Hold the command lock across shutdown and both builds; no CLI can start a daemon in the middle. The stamp goes last:
 * a build that failed halfway leaves no stamp, so the next command builds again.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopServer, withServerOperation } from "./socket.ts";
import { writeStamp } from "./stamp.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const build = (args: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "vite", "build", ...args], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Vite build exited ${code}.`)),
    );
  });

try {
  await withServerOperation(async () => {
    await stopServer();
    await build([]);
    await build(["-c", "vite.node.config.ts"]);
    writeStamp();
  });
} catch (error) {
  process.stderr.write(
    `review-canvas: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
